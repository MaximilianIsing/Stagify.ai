// Revenue and account rules for the Signals tab: which money is at risk, which
// accounts are about to change state without anyone being told, and what the
// product is costing to store.
//
// WHERE THESE NUMBERS COME FROM, WHICH IS THE WHOLE DIFFICULTY
//
// `plan` is only ever 'free' or 'pro'. Stripe's `trialing`, `active` and
// `past_due` all collapse into 'pro', and a cancellation rewrites it back to
// 'free' AND nulls the subscription id. So the account table cannot tell you how
// a subscription ended, and any rule that tries will be wrong.
//
// What it CAN tell you, reliably:
//
//   stripeSubscriptionId present  → paying (a comp grant never writes one, and
//                                   lib/data/pro-grants.js refuses to overwrite one)
//   proGrantExpiresAt present     → comped, and about to lapse silently
//   lastStagedAt / lifetimeStaged → stamped server-side from the VALIDATED session
//                                   by recordStagingActivity, for pro accounts only
//
// That last one matters more than it looks. Everything on the Insights tab reads
// activity out of the render log, whose email comes from the request body and is
// `unknown` most of the time — which is why the funnel there is documented as a
// floor. For a PAYING account, `lastStagedAt` has no such gap, so the at-risk
// rule below is the one place on this dashboard that can say "this person is
// paying and has not used it" as a fact rather than a suspicion.
//
// NAMES STAY IN THE BROWSER. Findings carry an `accounts` array so the card can
// list who to email; lib/services/admin-brief.js drops that field on the way to
// the model, and scrubs anything address-shaped out of the text as well. Do not
// put an email into a `title`, `detail` or `evidence` value.

import {
  atRiskPayingAccounts, expiringCompGrants, payingAccounts, enterpriseUsageSpread,
} from './analytics-users.js';
import { trialOutcomes, trialEmailsSent } from './analytics-users.js';
import { ratio } from './stats.js';
import { finding, suppressed, fmtCount, fmtPct, fmtBytes } from './findings.js';
import { capHitDaysByPerson, capHitCoverage } from './analytics-rejections.js';

const AREA = 'Revenue';

/** Days of silence after which a paying account is worth chasing. */
const QUIET_DAYS = 14;

/**
 * C1 · Paying accounts that have gone quiet.
 *
 * The highest-value card on the page, because it is the only one whose next step
 * is a specific person rather than a code change. Ranked with never-used accounts
 * first: someone who subscribed and never rendered anything is a refund request
 * waiting to happen, not a lull.
 */
const atRiskPaying = {
  id: 'revenue.at-risk-paying',
  area: AREA,
  run(input) {
    const users = input.users || [];
    const index = input.index || { byEmail: {}, byUserId: {}, rendersByEmail: {} };
    const result = atRiskPayingAccounts(users, index, { now: input.now, quietDays: QUIET_DAYS });

    if (!result.paying) return null; // Nothing is being paid for; not a finding.
    if (!result.atRisk.length) {
      return finding({
        id: 'revenue.at-risk-paying',
        severity: 'healthy',
        area: AREA,
        title: result.paying === 1
          ? 'The one paying account has used the product recently'
          : `All ${fmtCount(result.paying)} paying accounts have used the product recently`,
        detail: `Every account with a live Stripe subscription has staged, chatted or masked something in the `
          + `last ${QUIET_DAYS} days.`,
        evidence: [{ label: 'Paying accounts', value: fmtCount(result.paying) }],
        action: 'Nothing to do.',
        sample: result.paying,
      });
    }

    const never = result.atRisk.filter((a) => a.neverUsed).length;
    const share = ratio(result.atRisk.length, result.paying);
    return finding({
      id: 'revenue.at-risk-paying',
      severity: never > 0 || (share !== null && share >= 0.25) ? 'critical' : 'warning',
      area: AREA,
      title: never > 0
        ? `${fmtCount(never)} paying account${never === 1 ? '' : 's'} ${never === 1 ? 'has' : 'have'} never used the product`
        : `${fmtCount(result.atRisk.length)} paying accounts have gone quiet`,
      detail: never > 0
        ? 'Someone is being billed for something they have never used. That is the strongest churn signal '
          + 'available here and usually the shortest conversation — measured from the server-side activity '
          + 'stamp, not the render log, so it is not an attribution artefact.'
        : `These accounts have a live subscription and no activity for at least ${QUIET_DAYS} days. `
          + 'Measured from the server-side activity stamp rather than the render log, so a quiet account '
          + 'here is genuinely quiet rather than merely unattributed.',
      evidence: [
        { label: 'At risk', value: `${fmtCount(result.atRisk.length)} of ${fmtCount(result.paying)} paying` },
        { label: 'Never used it', value: fmtCount(never) },
        { label: 'Quiet threshold', value: `${QUIET_DAYS} days` },
      ],
      // Names ride here, NOT in the text — the brief endpoint drops this field.
      accounts: result.atRisk.slice(0, 10).map((a) => ({
        email: a.email,
        id: a.id,
        note: a.neverUsed ? 'never used it' : `quiet ${a.daysQuiet} days`,
      })),
      action: never > 0
        ? 'Email the never-used accounts first and ask what they expected. A refund offered before it is '
          + 'requested costs the same and keeps the conversation.'
        : 'Reach out before the renewal date. The Users tab has each account’s detail drawer.',
      sample: result.paying,
      confidence: 'high',
    });
  },
};

/**
 * C2 · Comped Stagify+ grants about to lapse.
 *
 * Worth a card because NOTHING fires when one runs out. Expiry is applied on read
 * (lib/data/pro-grants.js#applyGrantExpiry, inside rowToUser), so the account
 * simply reads as `free` on its next request and the person discovers it by
 * hitting the daily cap. Already-expired grants are included, because the silent
 * downgrade is the event either way.
 */
const compGrantsLapsing = {
  id: 'revenue.comp-grants',
  area: AREA,
  run(input) {
    const expiring = expiringCompGrants(input.users || [], { now: input.now, withinDays: 7 });
    if (!expiring.length) return null;

    const lapsed = expiring.filter((g) => g.daysLeft < 0);
    return finding({
      id: 'revenue.comp-grants',
      severity: 'opportunity',
      area: AREA,
      title: lapsed.length
        ? `${fmtCount(lapsed.length)} comped account${lapsed.length === 1 ? '' : 's'} already dropped back to free`
        : `${fmtCount(expiring.length)} comped account${expiring.length === 1 ? '' : 's'} lapse${expiring.length === 1 ? 's' : ''} within a week`,
      detail: 'A comp grant expires on READ — the account quietly becomes free on its next request and nobody '
        + 'is told. Whoever it was given to finds out by hitting the daily cap mid-task, which is the worst '
        + 'possible moment to discover it.',
      evidence: [
        { label: 'Lapsing within 7 days', value: fmtCount(expiring.length - lapsed.length) },
        { label: 'Already lapsed', value: fmtCount(lapsed.length) },
      ],
      accounts: expiring.slice(0, 10).map((g) => ({
        email: g.email,
        id: g.id,
        note: g.daysLeft < 0 ? `lapsed ${Math.abs(g.daysLeft)}d ago` : `${g.daysLeft}d left`,
      })),
      action: 'Decide before it happens: extend the grant from the Users tab, or tell them it is ending. '
        + 'Either beats them finding out at the cap.',
      sample: expiring.length,
      confidence: 'high',
    });
  },
};

/**
 * C3 · Trial-ending reminders that have never been sent.
 *
 * Promoted here from a note chip on the Insights tab, because it is a finding
 * rather than a caption: `ending` is the ONLY lifecycle email with no sweep
 * behind it. It fires solely from the `customer.subscription.trial_will_end`
 * webhook, which has to be switched on by hand on the Stripe endpoint. A non-zero
 * `welcome` beside a zero `ending` means the highest-intent touch in the whole
 * funnel has never once been sent, and nothing else in the product reports that.
 */
const trialEndingUnsent = {
  id: 'revenue.trial-ending-unsent',
  area: AREA,
  run(input) {
    const users = input.users || [];
    const mails = trialEmailsSent(users);
    const welcome = mails.find((m) => m.label === 'welcome');
    const ending = mails.find((m) => m.label === 'ending');
    if (!welcome || !ending || welcome.value === 0) return null;
    if (ending.value > 0) return null;

    const trials = trialOutcomes(users, input.now);
    return finding({
      id: 'revenue.trial-ending-unsent',
      severity: 'critical',
      area: AREA,
      title: 'No trial-ending reminder has ever been sent',
      detail: `${fmtCount(welcome.value)} trial welcome email${welcome.value === 1 ? ' has' : 's have'} gone out `
        + 'and zero trial-ending reminders. '
        + 'That email is the only one of the five with no sweep behind it — it fires solely from the '
        + '`customer.subscription.trial_will_end` webhook, which has to be enabled by hand on the Stripe '
        + 'endpoint. A zero here means the highest-intent message in the funnel has never been delivered.',
      evidence: [
        { label: 'Welcome emails sent', value: fmtCount(welcome.value) },
        { label: 'Ending reminders sent', value: '0' },
        { label: 'Trials started', value: fmtCount(trials.started) },
      ],
      action: 'Enable customer.subscription.trial_will_end on the Stripe webhook endpoint. Nothing in this '
        + 'codebase can turn it on — it is a setting in the Stripe dashboard.',
      sample: welcome.value,
      confidence: 'high',
    });
  },
};

/**
 * C4 · Share links minted against share links ever opened.
 *
 * The only virality signal the product has, and nothing else reads it. Two
 * numbers rather than one on purpose: 40 views across 2 of 30 links and 40 views
 * across 25 of them are different situations, and a single total cannot tell them
 * apart. Requires the metrics pack — `gallery_shares` has no CSV export.
 */
const shareVirality = {
  id: 'revenue.share-virality',
  area: AREA,
  run(input) {
    const shares = input.metrics && input.metrics.shares;
    if (!shares || typeof shares !== 'object') return null;

    const MIN = 10;
    if (shares.minted < MIN) {
      return suppressed(`Share-link engagement needs ${MIN} links minted; there are ${fmtCount(shares.minted)}.`);
    }

    const openRate = ratio(shares.viewed, shares.minted);
    const perShare = ratio(shares.views, shares.viewed);
    const evidence = [
      { label: 'Links minted', value: fmtCount(shares.minted) },
      { label: 'Ever opened', value: `${fmtCount(shares.viewed)} (${fmtPct((openRate || 0) * 100)})` },
      { label: 'Total views', value: fmtCount(shares.views) },
      perShare ? { label: 'Views per opened link', value: perShare.toFixed(1) } : null,
    ].filter(Boolean);

    if (openRate !== null && openRate < 0.2) {
      return finding({
        id: 'revenue.share-virality',
        severity: 'opportunity',
        area: AREA,
        title: `Only ${fmtPct(openRate * 100)} of share links have ever been opened`,
        detail: 'Share links are minted automatically by the listing, so most of these were created without '
          + 'anyone deciding to share. A low open rate is therefore weak evidence about the feature and strong '
          + 'evidence that the links are not reaching anyone — the two are worth telling apart before acting.',
        evidence,
        action: 'Check whether the share URL is actually surfaced where an agent would use it. If most links '
          + 'are minted by listings nobody sent on, that is a discoverability problem, not a feature problem.',
        sample: shares.minted,
        confidence: 'medium',
      });
    }
    if (openRate !== null && openRate >= 0.5) {
      return finding({
        id: 'revenue.share-virality',
        severity: 'healthy',
        area: AREA,
        title: `${fmtPct(openRate * 100)} of share links get opened`,
        detail: 'Shared renders are reaching people. This is the product’s only route to someone who does not '
          + 'have an account.',
        evidence,
        action: 'Nothing to do.',
        sample: shares.minted,
      });
    }
    return null;
  },
};

/**
 * C5 · Storage held per account, against what that account pays.
 *
 * Free accounts are capped at FREE_GALLERY_LIMIT renders, so a free account
 * holding an outsized share of the bytes means either large source photos or a
 * cap that is not doing its job. Needs the metrics pack; `render_blobs.bytes` has
 * no export.
 */
const storageOutliers = {
  id: 'revenue.storage-outliers',
  area: AREA,
  run(input) {
    const storage = input.metrics && input.metrics.storage;
    if (!storage || !storage.bytes) return null;
    // Array.isArray rather than `|| []` — the pack arrives over the wire, and a
    // truthy non-array satisfies `||` and then throws on .map.
    const topAccounts = Array.isArray(storage.topAccounts) ? storage.topAccounts : [];

    const users = input.users || [];
    const byId = new Map(users.map((u) => [String(u && u.id || ''), u]));
    const planOf = input.effectivePlan || ((u) => (u && u.plan) || 'free');

    const top = topAccounts.map((row) => {
      const user = byId.get(row.userId);
      return {
        ...row,
        plan: user ? planOf(user) : 'unknown',
        email: user ? String(user.email || '') : '',
        share: ratio(row.bytes, storage.bytes),
      };
    });

    const freeHeavy = top.filter((r) => r.plan === 'free' && (r.share || 0) >= 0.1);
    const evidence = [
      { label: 'Total stored', value: fmtBytes(storage.bytes) },
      { label: 'Blobs', value: fmtCount(storage.blobs) },
      { label: 'Reference images', value: `${fmtCount(storage.refCount)} (${fmtBytes(storage.refBytes)})` },
      top[0] ? { label: 'Largest account', value: `${fmtBytes(top[0].bytes)} (${fmtPct((top[0].share || 0) * 100)})` } : null,
    ].filter(Boolean);

    if (!freeHeavy.length) return null;
    return finding({
      id: 'revenue.storage-outliers',
      severity: 'opportunity',
      area: AREA,
      title: `${fmtCount(freeHeavy.length)} free account${freeHeavy.length === 1 ? '' : 's'} hold${freeHeavy.length === 1 ? 's' : ''} a large share of stored bytes`,
      detail: 'Free accounts are capped by render COUNT, not by bytes, so a handful of very large source '
        + 'photos can cost more to keep than a paying account does. This is object-store spend with a name '
        + 'on it.',
      evidence,
      accounts: freeHeavy.map((r) => ({
        email: r.email,
        id: r.userId,
        note: `${fmtBytes(r.bytes)} (${fmtPct((r.share || 0) * 100)} of all stored bytes)`,
      })),
      action: 'Check the downscale settings on the upload path before changing the cap — a byte problem is '
        + 'usually an input-size problem, and the gallery cap is doing what it was asked to do.',
      sample: topAccounts.length,
      confidence: 'medium',
    });
  },
};

/**
 * C6 · Enterprise domains using far less than their peers.
 *
 * Compared against the MEDIAN domain, not the mean: these populations are tiny
 * and one large customer would drag a mean high enough to mark every other
 * contract as underused. Only active/trialing domains are considered — a
 * cancelled domain using nothing is a completed churn, not a risk.
 */
const enterpriseUnderuse = {
  id: 'revenue.enterprise-underuse',
  area: AREA,
  run(input) {
    const spread = enterpriseUsageSpread(input.enterprise || []);
    if (!spread.active) return null;

    if (spread.median === 0) {
      return finding({
        id: 'revenue.enterprise-underuse',
        severity: 'warning',
        area: AREA,
        title: `No enterprise domain has recorded any usage`,
        detail: 'Every active enterprise domain is metered at zero. Either the contracts have not started '
          + 'being used, or usage is not reaching the meter — and those want opposite responses.',
        evidence: [{ label: 'Active domains', value: fmtCount(spread.active) }],
        action: 'Confirm reportEnterpriseUsage is firing for these domains before assuming it is a customer '
          + 'problem — the meter runs after the render, and it swallows its own errors.',
        sample: spread.active,
        confidence: 'medium',
      });
    }
    if (!spread.underused.length) return null;

    return finding({
      id: 'revenue.enterprise-underuse',
      severity: 'warning',
      area: AREA,
      title: `${fmtCount(spread.underused.length)} enterprise domain${spread.underused.length === 1 ? '' : 's'} barely used`,
      detail: `The median active domain has recorded ${fmtCount(spread.median || 0)} generations; these are far `
        + 'below it. Compared against the median rather than the mean, so one large customer cannot make '
        + 'everyone else look idle. Enterprise contracts are the largest single amounts at stake here.',
      evidence: [
        { label: 'Active domains', value: fmtCount(spread.active) },
        { label: 'Median usage', value: fmtCount(spread.median || 0) },
        ...spread.underused.slice(0, 4).map((d) => ({
          label: d.companyName || d.domain,
          value: `${fmtCount(d.usage)} generations`,
        })),
      ],
      action: 'Get in touch before the renewal. A domain metering near zero has nothing to point at when the '
        + 'invoice arrives.',
      sample: spread.active,
      confidence: 'medium',
    });
  },
};

/**
 * C7 · Free accounts pressing against the daily cap.
 *
 * TWO STRENGTHS, AND THE CARD SAYS WHICH ONE IT IS RUNNING AT.
 *
 * `usageCount` is TODAY's counter and resets on the day rollover, so on its own
 * this rule can only see who is at the cap right now and who renders a lot —
 * someone blocked on three separate days looks identical to someone never
 * blocked at all. That was the only version available while the dashboard did
 * not load `rejection_logs.csv`.
 *
 * With that file loaded, `daily_limit` rows carry the account and the date, so
 * repeat blocking becomes measurable and leads the ranking. **Days, not hits:**
 * someone who retried eight times in one evening met the cap once and learnt
 * where it was; someone stopped on four separate days keeps coming back and
 * keeps being turned away, which is the actual buying signal.
 *
 * The degraded branch is kept rather than deleted because the file may legitimately
 * be empty — a fresh deploy has refused nothing — and "no refusals recorded"
 * must not be reported as "nobody is hitting the cap".
 */
const upgradeCandidates = {
  id: 'revenue.upgrade-candidates',
  area: AREA,
  run(input) {
    const users = input.users || [];
    const planOf = input.effectivePlan || ((u) => (u && u.plan) || 'free');
    const index = input.index || { byEmail: {}, byUserId: {}, rendersByEmail: {} };

    const free = users.filter((u) => planOf(u) === 'free');
    if (free.length < 5) return null;

    // Days blocked per account, keyed by whichever identity the refusal carried.
    const rejectionRows = input.rejectionRows || [];
    const blocked = capHitDaysByPerson(rejectionRows, { top: 0 });
    /** @type {Record<string, {days: number, hits: number}>} */
    const blockedBy = {};
    blocked.forEach((b) => { blockedBy[String(b.identity).toLowerCase()] = { days: b.days, hits: b.hits }; });
    const measured = blocked.length > 0;

    const candidates = free
      .map((u) => {
        const limit = Number(u.dailyGenerationLimit) || 50;
        const used = Number(u.usageCount) || 0;
        const email = String(u.email || '').toLowerCase();
        const renders = index.rendersByEmail[email] || 0;
        const hit = blockedBy[email] || blockedBy[String(u.id || '').toLowerCase()] || null;
        return {
          user: u, used, limit, renders,
          atCap: used >= limit * 0.8,
          blockedDays: hit ? hit.days : 0,
        };
      })
      .filter((c) => c.atCap || c.renders >= 25 || c.blockedDays > 0)
      // Repeat blocking outranks everything else: it is the only one of the three
      // that says the cap actually cost this person work, more than once.
      .sort((a, b) => b.blockedDays - a.blockedDays
        || (b.used / b.limit) - (a.used / a.limit)
        || b.renders - a.renders);

    if (!candidates.length) return null;

    const repeat = candidates.filter((c) => c.blockedDays >= 2).length;
    const cov = capHitCoverage(rejectionRows);

    return finding({
      id: 'revenue.upgrade-candidates',
      severity: 'opportunity',
      area: AREA,
      title: `${fmtCount(candidates.length)} free account${candidates.length === 1 ? '' : 's'} using the product heavily`,
      detail: measured
        ? 'Ranked by how many SEPARATE DAYS the account was actually turned away at the daily cap, then by '
          + 'today’s usage and lifetime volume. A day blocked is a day this person wanted to work and '
          + 'could not, so an account blocked repeatedly has already demonstrated the demand a paid plan '
          + 'would serve.'
        : 'These are at or near the daily cap today, or have a high lifetime render count. This is a '
          + 'PARTIAL view: no cap refusals have been recorded yet, so someone blocked on three separate '
          + 'days would look identical here to someone who has never been blocked at all.',
      evidence: [
        { label: 'Free accounts', value: fmtCount(free.length) },
        { label: 'Heavy users', value: fmtCount(candidates.length) },
        measured
          ? { label: 'Blocked 2+ days', value: fmtCount(repeat) }
          : { label: 'Cap refusals recorded', value: 'none yet' },
        // An anonymous refusal is real usage this ranking structurally cannot
        // attribute, so the gap is printed rather than quietly absorbed — same
        // rule the activation funnel follows about its own coverage.
        measured && cov.ratio !== null && cov.ratio < 1
          ? { label: 'Unattributed refusals', value: `${fmtCount(cov.total - cov.attributed)} of ${fmtCount(cov.total)}` }
          : null,
      ].filter(Boolean),
      accounts: candidates.slice(0, 10).map((c) => ({
        email: String(c.user.email || ''),
        id: String(c.user.id || ''),
        note: c.blockedDays > 0
          ? `blocked on ${fmtCount(c.blockedDays)} day${c.blockedDays === 1 ? '' : 's'}`
          : c.atCap ? `${c.used}/${c.limit} today` : `${fmtCount(c.renders)} renders logged`,
      })),
      action: measured
        ? 'Reach out to the accounts blocked on more than one day first — they have hit the ceiling, come '
          + 'back, and hit it again.'
        : 'Treat this list as a shortlist rather than a count until cap refusals accumulate in the '
          + 'rejection log.',
      sample: free.length,
      // A ranking built on recorded refusals is evidence; one inferred from a
      // counter that resets every day is a guess, and must not read as more.
      confidence: measured ? 'high' : 'low',
    });
  },
};

/**
 * C8 · Paid conversion, reported as context rather than as an alarm.
 *
 * Present because every rule above is about the paying population and none of
 * them says how big it is. Deliberately never `critical`: a conversion rate is a
 * business fact, not an incident, and dressing it as one would train the operator
 * to ignore the section.
 */
const paidMix = {
  id: 'revenue.paid-mix',
  area: AREA,
  run(input) {
    const users = input.users || [];
    if (users.length < 15) return null;
    const planOf = input.effectivePlan || ((u) => (u && u.plan) || 'free');

    const paying = payingAccounts(users).length;
    const pro = users.filter((u) => planOf(u) === 'pro').length;
    const ent = users.filter((u) => planOf(u) === 'enterprise').length;
    const comped = Math.max(0, pro - paying);
    const rate = ratio(paying + ent, users.length);

    return finding({
      id: 'revenue.paid-mix',
      severity: 'quality',
      area: AREA,
      title: `${fmtPct((rate || 0) * 100)} of accounts are paying`,
      detail: 'Split out because the plan column alone cannot tell a subscription from a comp: both read as '
        + '"pro". Only an account with a Stripe subscription id is revenue, and only that subset is what the '
        + 'at-risk rule above watches.',
      evidence: [
        { label: 'Accounts', value: fmtCount(users.length) },
        { label: 'Paying (Stripe subscription)', value: fmtCount(paying) },
        { label: 'Comped (grant, no subscription)', value: fmtCount(comped) },
        { label: 'Enterprise domain members', value: fmtCount(ent) },
      ],
      action: 'Nothing to do — context for the findings above.',
      sample: users.length,
      confidence: 'high',
    });
  },
};

export const ACCOUNT_RULES = [
  atRiskPaying,
  compGrantsLapsing,
  trialEndingUnsent,
  shareVirality,
  storageOutliers,
  enterpriseUnderuse,
  upgradeCandidates,
  paidMix,
];
