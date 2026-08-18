# Admin dashboard

The operator console at [`/admin`](../../public/admin.html) — accounts, logs, image
hosting, data exports, and the analytics charts. It is a single static page gated by the
`endpoint_key`, with no dedicated backend: it downloads the same CSV/JSON files the
[export endpoints](../reference/endpoints.md) already serve and does every aggregation in
the browser.

> **Access.** Signing in sends `endpoint_key` in the `X-Stagify-Endpoint-Key` header —
> never in a URL — to `POST /api/admin/session`, which returns a **session token**. The
> key is a local inside that one request and is never persisted or even kept in memory;
> the token is what survives a reload, and it is scoped to these routes, expires in 30
> days, and can be revoked. Every later request carries it in `X-Stagify-Admin-Session`.
> See [`security.md`](security.md#the-console-holds-a-session-token-never-the-key) and
> [`lib/data/admin-sessions.js`](../../lib/data/admin-sessions.js).

## The shell

The console does **not** wear the marketing chrome. `admin.html` ships no
`<header class="site-header">` and no `<video id="background-video">`: a tinted, blurred
backdrop behind dense tables and charts fights every value on the page, and the blur
softens exactly the edges a data UI needs. `styles.css` is still linked — for the Inter
`@font-face` set, the reset and the shared colour tokens — and `.page-admin` paints its
own opaque canvas over it. Two guards pin that: the styles.css-pages-without-a-video list
in [`test/frontend/background-video-mobile.test.js`](../../test/frontend/background-video-mobile.test.js),
which also asserts `.page-admin` supplies a background of its own, and the token rules in
[`test/frontend/css-tokens.test.js`](../../test/frontend/css-tokens.test.js), which fail
the build if a colour in `admin.css` duplicates a shared one.

The layout is a **fixed rail + a scrolling column**:

- `.adm-side` — the rail. One `.adm-tab` per section, grouped under `.adm-nav-group`
  headings, each with an icon and (where it has one) a count chip. Under 1040px it
  unpins into a horizontally-scrolling strip across the top; there is no hamburger.
- `.adm-main` > `.adm-topbar` — sticky, and the **only** place a section is named. The
  labels ride on the button as `data-title` / `data-sub`, so the markup stays the single
  source of truth and `admin.js#setPageHeading` just copies them across.
- `.adm-content` — the panels, unchanged: `.adm-panel` + `.active`, one per `data-tab`.

Adding a section therefore means: a `.adm-tab` with `data-tab`/`data-title`/`data-sub`, a
`#panel-<data-tab>`, and (if it counts something) a `#tc-*` chip written from
`renderers.js#setTabCount`. All three are pinned against each other by
[`test/frontend/admin/admin-shell-markup.test.js`](../../test/frontend/admin/admin-shell-markup.test.js)
— every one of those mismatches is otherwise silent at runtime.

**Styling goes through the token block at the top of `admin.css`.** Surfaces, the four
inks, the status triples (`--adm-pos` / `-wash` / `-line`) and the eight series tones are
declared once on `.page-admin`; components compose them and never introduce a colour. The
tones are the same eight hues as `charts.js#PALETTE` — the DOM half and the SVG half of one
palette, so change them together.

## Module map

Follows the [entry + islands pattern](frontend.md#pages-entries-and-islands): the entry
owns auth/fetch/wiring, each island owns one cohesive concern.

| File | Role |
|---|---|
| [`scripts/admin.js`](../../public/scripts/admin.js) | **Entry.** Login + lockout, the in-closure key, `apiFetchQ` / `apiSend` / `secureBlobDownload`, `loadAll()`, tab switching (and the topbar heading that follows it), upload wiring, sign-out. |
| [`scripts/admin/renderers.js`](../../public/scripts/admin/renderers.js) | The table tabs (users + detail drawer, enterprise, contacts, email opens, bugs, hosting, downloads) and `effectivePlan`, which both chart islands take as a dependency. |
| [`scripts/admin/overview.js`](../../public/scripts/admin/overview.js) | The **Overview** tab: the range selector, stat cards, the two generation charts, top users, recent signups. |
| [`scripts/admin/insights.js`](../../public/scripts/admin/insights.js) | The **Insights** tab: the chart grid. |
| [`scripts/admin/signals.js`](../../public/scripts/admin/signals.js) | The **Signals** tab: ranked findings + the written brief, and the Overview teaser. See [§Signals tab](#signals-tab). |
| [`scripts/admin/analytics.js`](../../public/scripts/admin/analytics.js) | **Pure aggregation** — bucketing, distributions, deltas, render outcomes. Owns `COL`, the CSV column map. No DOM. |
| [`scripts/admin/analytics-users.js`](../../public/scripts/admin/analytics-users.js) | **Pure per-account aggregation** — last-active, activation funnel, cohort retention. No DOM. |
| [`scripts/admin/charts.js`](../../public/scripts/admin/charts.js) | **SVG chart primitives** — area, bar, ranked bars, donut, funnel, cohort grid, sparkline, card chrome. |
| [`scripts/admin/grant.js`](../../public/scripts/admin/grant.js) | The comp-Stagify+ control inside the user detail drawer. |
| [`scripts/admin/emails.js`](../../public/scripts/admin/emails.js) | The **Emails** tab: the preview gallery + per-template test send. Lazy-loaded on first open. |
| [`scripts/admin/status-panel.js`](../../public/scripts/admin/status-panel.js) | The **Server status** tab: the live monitor view and the incident composer. Lazy-loaded on first open, then polls while its tab is visible. |
| [`scripts/admin/referrals.js`](../../public/scripts/admin/referrals.js) | The **Referrals** tab: one card per campaign short-URL. Lazy-loaded on first open; `Refresh` invalidates it. |
| [`scripts/admin/helpers.js`](../../public/scripts/admin/helpers.js) | DOM/format helpers + the icon set. `esc` is re-exported from the shared [`scripts/escape-html.js`](../../public/scripts/escape-html.js). |
| [`styles/admin.css`](../../public/styles/admin.css) | Page styles: the token block, the shell, and everything the SVG charts are painted with. |

State is one shared mutable `ctx` object created in the entry and handed to the islands by
reference; `ctx.data` is swapped wholesale on sign-out, so islands read through `ctx`
rather than capturing `ctx.data`.

## Charts

There is **no charting library.** The app has [no build step](architecture.md#decision-no-frontend-build-step),
so a dependency would mean vendoring a bundle for a handful of shapes. `charts.js` builds
the SVG directly, under three rules:

- **Fixed viewBox, fluid box.** A chart draws into a fixed user-space grid and is scaled
  by CSS (`width:100%; height:auto`). Nothing measures the DOM — which is also why the
  module is testable against a stub `document`.
- **`viewBox` width is an inverse font size.** Scaling is uniform, so a chart in a ~350px
  grid cell that used the full-width default (`1000`) would render its 11px axis labels at
  ~4px. `insights.js` wraps `areaChart`/`barChart` to pass its own `CARD_VB_W`; anything
  dropped into a narrow container must do the same.
- **Tooltips are native `<title>`.** No listeners, no positioning math, no cleanup — a
  panel re-render can't leak handlers. Axis labels may be abbreviated; the tooltip always
  carries the exact number.

### Catalog

**Overview** — a **range selector** (`#adm-range`: 7 / 30 / 90 days / all time), then
`#adm-stats` (8 stat cards with deltas and sparklines) and `#adm-charts`:

| Chart | Source |
|---|---|
| Daily generation activity | The selected range, zero-filled, area |
| Generation activity — all time | First render → today, **auto-bucketed** day/week/month |

The range scopes the stat cards, the first chart, and both tables. It does **not** touch
the all-time chart — and selecting "All time" hides the first chart rather than drawing
the same series twice at a worse granularity.

The two charts answer different questions on purpose. The first is "is it busy right now",
so its window is fixed and zero-filled — a dead week must *look* dead. The all-time one is
the shape of the whole history, so it re-buckets itself as history grows
(`pickGranularity`: ≤70 days → daily, ≤550 → weekly, beyond → monthly), keeping the point
count in a readable 20–90 band at every scale.

**Insights** — `#adm-insights`, six labelled sections, **each with its own grid**:

- **Reliability** — render outcomes · failed renders per day · failure reasons · render
  duration (p50/p90/p95 + histogram) · staging models.
- **Lifecycle** — activation funnel · cohort retention · trials · trial emails sent
  (the first three full width).
- **Growth** — cumulative generations · total accounts over time · new signups per bucket.
- **Composition** — plan mix · sign-in method · feature usage mix · furniture removal.
- **What gets staged** — room types · furniture styles · referral sources · user roles ·
  mask-edit models · enterprise usage by domain.
- **When it happens** — activity by hour · activity by weekday · chat messages (30d) ·
  mask edits (30d).

The per-section grid is the layout fix, not just organisation. A grid row is sized by its
tallest card, so with all 24 in one grid an empty-state card ("No failures recorded") sat
beside a full chart and left large dead areas, and one very tall card stranded the band
next to it. Within a section the cards are the same *kind* of thing and so roughly the same
height. Three rules keep the rows clean:

- Cards **stretch** to a shared row height (the grid default — don't reintroduce
  `align-items: start`), and `.adm-chart-notes` uses `margin-top: auto` so the note chips
  land on one baseline across the row.
- A section of exactly **four** in-flow cards switches to two columns
  (`adm-chart-grid--2col`), because 2×2 beats three-plus-an-orphan.
- A card that is tall or needs the width passes `wide: true` and takes a full row — the
  funnel and the cohort grid both do.

### Counting people vs. counting rows

`userRole` and `userReferralSource` are **onboarding answers stored per person**, which the
client replays onto *every* render it sends. Counting them off the render log therefore
reports render volume weighted by whoever staged the most rooms — a few hundred answers
charted as tens of thousands of "people". Those two cards read `contact_logs.csv` (one row
per answer) through `topValuesByPerson`, which deduplicates by email.

Rule of thumb: **a per-person attribute must be counted from a per-person table.** Only
per-event columns (room type, style, model, outcome) may be counted off the render log, and
those cards say "renders" in their unit.

### Category grouping

`topValues` / `topValuesByPerson` group through `categoryKey` — lower-cased with whitespace
runs collapsed — because these columns are free text written by several client versions.
Grouping on the raw string charted `Living room` and `Living Room` as two different rooms.
The label shown is the **most common original spelling**, not a machine-lowercased one.

The folded tail bucket is labelled `Other (N more)`, built to be unique. A fixed `Other`
collided with the genuine `Other` room type, so the chart drew two rows both labelled
Other, one real and one synthetic, with different numbers.

### Three places "absent" must not read as "zero"

These are the invariants most likely to be broken by an innocent-looking edit:

1. **Unrecorded outcomes.** The outcome columns were added on 2026-07-26; every render
   before that has empty cells. `withOutcome` excludes them. Counting them as failures
   would paint an error spike across the whole history; counting them as successes would
   hide a live outage behind old data. A success rate with nothing recorded is `null`,
   rendered `—`, never 100%.
2. **Unattributed renders.** A render row's email is `unknown` whenever the client didn't
   send one, so a large share of usage belongs to no account. The funnel and the cohort
   grid can only see the attributed remainder, so both print the coverage and are
   documented as **a floor, not a count**.
3. **Months that haven't elapsed.** A cohort three weeks old has no month-2 cell. The grid
   renders those blank (hatched), never 0% — 0% is a measured value and is drawn.

### Trials

`plan` is only `'free' | 'pro'` — `trialing`, `active` and `past_due` all collapse into
`'pro'`, and a cancellation rewrites it back to `'free'` *and* nulls the subscription id.
So the account table cannot say how a trial ended. Both trial cards read
`trialLifecycle` instead, whose `startAt` is stamped at checkout and whose
`sent.canceled` is stamped when the win-back email goes out — which only happens on
`customer.subscription.deleted`. **That flag is the only durable churn timestamp stored
locally**, so `cancelled` is a floor: a cancellation whose win-back mail failed to send
leaves no trace at all.

Same nesting rule as the funnel above, for the same reason: only **started → activated**
is a subset relationship. "Still paying past the trial" is reported in the card's notes,
because someone can convert without ever staging, which would draw a step wider than its
parent.

**"Trial emails sent" earns its place by what a zero means.** `ending` is the only one of
the five with no sweep behind it — it fires solely from the
`customer.subscription.trial_will_end` webhook, which has to be enabled by hand on the
Stripe endpoint. A non-zero `welcome` beside a zero `ending` means the highest-intent
touch in the funnel has never been sent, and the card says so in as many words.

**Paid is not a funnel step.** `activationFunnel` is a strictly nested usage ladder
(accounts → activated → repeat → power), so it can only narrow — `funnelMonotonic` asserts
it. Paying doesn't nest: a subscriber whose renders all logged anonymously is paid but not
activated, and on live data the paid count *exceeded* the activated count, drawing a step
wider than its parent. `paidConversion` reports it separately, beside the chart.

### Adding a chart

1. Add the aggregation as a **pure function** — `analytics.js` for time series and
   distributions, `analytics-users.js` if it joins accounts to activity — and cover it in
   the matching `test/frontend/admin/admin-analytics*.test.js`.
2. Render it in `insights.js` (or `overview.js`) with an existing primitive from
   `charts.js`, wrapped in `chartCard({title, sub, body, notes})`.
3. Only add a new primitive if no existing one fits — and cover it in
   `test/frontend/admin/admin-charts.test.js`.

## Data sources

Everything is fetched in one `Promise.all` in `admin.js#loadAll`. The CSV files are parsed
by `helpers.js#parseCSV` (RFC 4180) into arrays of string cells addressed **by index**, so
the column maps below are load-bearing. They live in code as `analytics.js#COL`, the single
source of truth — if a writer gains a column, update `COL` and this table.

| Endpoint | Written by | Columns |
|---|---|---|
| `/authstore` | `lib/data/auth-store.js` | JSON — `{users: [...]}`, **redacted** via `exportRedacted()`. Only `ADMIN_VISIBLE_USER_KEYS` are present; credentials and session/reset tokens are never sent (see the security guide). Need a new column here? Add it to that allowlist. Trial state (`lifetimeStaged`, `lastStagedAt`, `trialLifecycle`) rides along — but `trialLifecycle` is **projected** through `ADMIN_VISIBLE_TRIAL_EMAILS`, not allowlisted wholesale, so a future field parked inside that bag is not auto-exported. |
| `/promptlogs` | `lib/services/logging.js` | `timestamp, roomType, furnitureStyle, additionalPrompt, removeFurniture, userRole, referralSource, email, ipAddress, status, durationMs, model, attempts, errorCode, architectureDrift, seed` — the last two were appended after `COL` was written and went **unread** until the Signals tab; `architectureDrift` is `'yes' | 'no' | ''`, where empty means the question was never asked, NOT that the render was clean. |
| `/rejectionlogs` | `lib/services/logging.js` | `timestamp, kind, code, detail, email, userId, ipAddress, userAgent` — requests refused **before** a render. Deliberately NOT rows in `prompt_logs.csv`: every row there is counted as a generation, so folding rejections in would inflate the headline volume and the success rate with work that never ran. |
| `/chatlogs` | `lib/services/logging.js` | `timestamp, userId, userMessage, aiResponse, fileNames, fileTypes, ipAddress, userAgent` |
| `/masklogs` | `lib/services/logging.js` | `timestamp, prompt, model, geminiModel, imageWidth, imageHeight, userId, ipAddress, userAgent` |
| `/contactlogs` | `routes/public.js` | `timestamp, userRole, referralSource, email, userAgent, ipAddress` |
| `/bugreports` | `routes/public.js` | `timestamp, description, stepsToReproduce, email, userId, userAgent, url, ipAddress, conversationHistory` |
| `/email-open-logs` | `lib/services/email.js` | `timestamp, email, ipAddress, userAgent` |
| `/enterprise-domains` | `lib/data/enterprise-store.js` | JSON — `{domains: [...]}` |
| `/api/hosted-images` | `lib/image/hosted-images.js` | JSON — `{images: [...]}` |

Three conventions the aggregators depend on:

- **Every log file starts with a `timestamp,…` header row**, and `parseCSV` has no reason
  to know that — to it the header is just another row. `analytics.js#stripHeader` drops
  it. Skip that call and totals are off by one and the header lands in the charts as a
  user named `email`.
- **Day keys are local, not UTC.** The dashboard is read by a human in one timezone, so
  "today" must be *their* today. `toISOString().slice(0,10)` looks equivalent but shifts
  every row by a day for anyone east of UTC. Everything goes through
  `analytics.js#dayKeyLocal`.
- **New CSV columns are APPENDED, never inserted.** Every consumer reads these files by
  index, so inserting a column mid-row silently re-labels the entire history. The five
  outcome columns were appended for exactly this reason, and `logPromptToFile` upgrades an
  existing file's header line in place (temp + rename) so a download still opens with the
  right labels.

### Render outcomes

`logPromptToFile` is called **once per render, after the model call settles** — from the
success path and from the `catch` alike, guarded so only one row is written. It records
`status`, `durationMs`, `model`, `attempts` (images produced, quality-gate retries
included) and `errorCode`.

`attempts` counts **that render only**. It used to read `req._stagingGenerations`, the
request-wide total across every variation, so in a 3-variation job each row reported the
running total rather than its own cost — and now that variations run concurrently, which
total a row happened to observe would be timing-dependent as well. The request-wide
counter still exists and is still what enterprise billing meters; it just isn't what a
single render's row should say. Before this the row was written *before* the Gemini call, so it
counted attempts and carried no result: the dashboard could show volume but not whether
staging actually worked. A failure that happens before the prompt is even assembled still
logs a row, with an empty prompt, so it lands in the error rate.

## Testing

Three suites, all pure/DOM-stubbed — no jsdom, no browser (see
[`testing.md`](testing.md)):

- [`test/frontend/admin/admin-analytics.test.js`](../../test/frontend/admin/admin-analytics.test.js) — the aggregators:
  local day keys, zero-fill, granularity thresholds, window deltas, distributions, and the
  outcome maths (unrecorded rows excluded, success rate `null` not 100%, duration
  percentiles over successes only). Fixtures are built relative to `new Date()` so the
  suite can't rot.
- [`test/frontend/admin/admin-analytics-users.test.js`](../../test/frontend/admin/admin-analytics-users.test.js) — the
  per-account joins: last-active across both identifiers, the funnel's monotonicity
  (including the real-data regression where paid exceeded activated), and cohort cells that
  keep "hasn't happened" distinct from 0%. `now` is injected, so nothing is clock-dependent.
- [`test/frontend/admin/admin-charts.test.js`](../../test/frontend/admin/admin-charts.test.js) — the SVG builders,
  asserted on invariants rather than coordinates: one hover target per point, geometry
  proportional to the data, a zero drawing nothing, axis labels that don't collide, funnel
  bars scaled against the top step, and cohort cells that stay blank for a month that
  hasn't elapsed.
- [`test/frontend/admin/admin-helpers.test.js`](../../test/frontend/admin/admin-helpers.test.js) — `parseCSV` and the
  formatters. [`test/frontend/admin/admin-grant-ui.test.js`](../../test/frontend/admin/admin-grant-ui.test.js) covers
  the grant control; [`test/routes/admin-route.test.js`](../../test/routes/admin-route.test.js) covers
  the server side.

## Signals tab

Everything above this section shows **what happened**. Signals is the one tab that
says **so what** — a ranked list of findings, each a claim with the numbers behind
it and a concrete next step, plus an optional written brief over the top.

It exists because reading 24 charts and knowing which shapes are bad is work that
was being redone on every visit. The precedent was already in the codebase, as a
single note chip on the Insights tab: a conditional that fires only when
`welcome > 0 && ending === 0` and then says, in words, *"No trial-ending reminders
have EVER been sent — enable `customer.subscription.trial_will_end` on the Stripe
webhook endpoint."* That is a rule, a threshold, evidence and an action. This tab
generalises it to ~30 rules.

### The split that makes it testable

Two halves, and the separation is deliberate rather than tidy:

- **A deterministic rules engine** (`scripts/admin/findings*.js`) produces every
  finding. Pure functions, no DOM, no network — unit-tested, identical on every
  refresh, and working with no API key at all. **This is the product.**
- **A written brief** (`POST /api/admin/brief`) puts two to four sentences over the
  top. It restates the findings; it never computes. No key, a timeout or an empty
  completion all render as "no brief" with the findings untouched.

The rule that keeps the second honest: **the model only ever sees conclusions, not
data.** The request body is the finished findings — title, severity, area, numeric
evidence — projected through an allowlist and scrubbed of anything address-shaped
in [`lib/services/admin-brief.js`](../../lib/services/admin-brief.js). Account names
never leave the browser.

### Module map

| File | Role |
|---|---|
| [`scripts/admin/stats.js`](../../public/scripts/admin/stats.js) | Statistical primitives: Wilson intervals, MAD/robust z, least-squares trend, Welch changepoint, projection. No domain knowledge. |
| [`scripts/admin/findings.js`](../../public/scripts/admin/findings.js) | The registry, the `Finding` shape, severity ranking, the runner, and the suppression roll-up. |
| `scripts/admin/findings-reliability.js` | Is staging working — proportions with intervals. |
| `scripts/admin/findings-performance.js` | Latency, retry cost, failure timing — continuous quantities across time windows. |
| `scripts/admin/findings-growth.js` | Direction of travel, projections, activation. |
| `scripts/admin/findings-accounts.js` | Revenue at risk, silent state changes, storage cost. |
| `scripts/admin/findings-quality.js` | Which numbers cannot be trusted, and why. |
| [`scripts/admin/signals.js`](../../public/scripts/admin/signals.js) | The tab + the Overview teaser. DOM only; decides nothing. |
| [`lib/analytics/admin-metrics.js`](../../lib/analytics/admin-metrics.js) | Read-only SQL aggregates — the numbers no CSV can give. |
| [`lib/services/admin-brief.js`](../../lib/services/admin-brief.js) | The brief, with its redaction and its fail-open contract. |

### Severities

Five, mapping onto three colours because two pairs are the same kind of thing at
different weights:

| Severity | Means |
|---|---|
| `critical` | Money or reliability is being lost right now. |
| `warning` | Something moved that wants an explanation. |
| `opportunity` | Nothing is broken; something is being left on the table. |
| `healthy` | Confirmed working. **Not filler** — without it there is no way to tell "fine" from "not measured". |
| `quality` | A caveat about the instruments. Never an alarm: ranking these as incidents would train you to scroll past the section that explains the rest of the page. |

The rail chip and the Overview teaser count the **actionable** three only. A chip
that included the healthy cards could never read zero, and zero is the one value
that has to mean something.

### The two gates every threshold rule passes

1. **A minimum sample**, and it is **not redundant with the interval below.**
   3 failures out of 8 is an observed 37.5% whose Wilson interval still starts at
   ~13.7% — so it *excludes* a 4% baseline and would fire as a critical built on
   eight renders. `admin-stats.test.js` pins that number precisely so nobody
   deletes the `n` floor as duplicated effort.
2. **A statistical gate** — an interval that excludes the baseline (proportions),
   or a robust z past its threshold (series).

A rule that clears neither returns `suppressed(...)`, never silence.

### Silence must be honest

The invariant the whole tab turns on, and the reason `suppressed()` exists as a
distinct return value from `null`:

- `null` — this rule does not apply (no enterprise domains, so nothing to say
  about enterprise usage).
- `suppressed('…')` — it applies, and there is not enough data yet. These roll up
  into one visible card listing what could not be checked and how much is missing.

Without that card, **an empty Signals tab and a clean bill of health render
identically** — and a brand-new deployment, a broken loader and a genuinely
healthy product all produce an empty tab.

This is the same rule the aggregators already keep: an unrecorded outcome makes
`successRate().pct` null rather than 100, and a cohort month that has not elapsed
renders blank rather than 0%.

### Why the metrics endpoint exists

The dashboard has deliberately had no backend — it downloads the CSV/JSON exports
and aggregates in the browser. `GET /api/admin/metrics` is the exception, and it
earns it by shipping numbers the CSVs structurally cannot:

- **Attribution.** A `prompt_logs.csv` row's email comes from the request *body*
  and is `unknown` whenever the client did not send one, which is why every funnel
  on the Insights tab is documented as "a floor, not a count".
  `staged_renders.user_id` comes from the **validated session**, so it is the
  count. That is what turns `quality.attribution-gap` from a warning label into a
  measurement.
- **Bytes, shares and queue health** exist only in SQL: `render_blobs.bytes`,
  `gallery_shares.view_count`, stuck `stripe_events`, the `blob_tombstones` backlog.

Two rules the module keeps:

- **Every statement is prepared once, at factory time.** The snapshot is a fixed
  number of `GROUP BY` queries regardless of row count.
  `test/analytics/admin-metrics.test.js` counts `prepare` calls across datasets
  three orders of magnitude apart and fails if the number moves — this endpoint
  gets pointed at the production database, so an accidental N+1 is an outage.
- **No calendar-day bucketing.** Every window is a *duration* ("the last 30
  days"), never a day key. Day keys here are local to whoever is reading
  (`analytics.js#dayKeyLocal`) and the server cannot know that timezone. Series
  that need day keys are built in the browser from the CSV exports.

### Two columns this tab reads first

`prompt_logs.csv` writes **16** columns; `analytics.js#COL` read 14.
`architectureDrift` (index 14) and `seed` (index 15) were appended to the writer
after the column map was written and went unread in production for weeks.

`architectureDrift` is now `reliability.architecture-drift`: a per-render
quality-defect rate over renders that **all logged `status: ok`**. The model
produced an image and the quality gate passed it, but the output no longer matches
the room in the photo — the defect a virtual-staging customer notices first, and
one that is invisible in a success rate. `''` means the question was never asked,
**not** that the render was clean, so those rows are excluded exactly as
unrecorded outcomes are.

### What is deliberately not wired up

`rejection_logs.csv` is served at `GET /rejectionlogs` and the dashboard has never
fetched it. It records every request turned away *before* a render — refused
uploads, daily-cap hits, rate-limit bounces — which is the drop-off nothing else
can see. `revenue.upgrade-candidates` is degraded without it and says so on the
card: it can see who is at the cap *today*, but not who has been blocked on three
separate days. Adding it is one entry in `admin.js#loadAll` and one `COL.REJECTION`
block.

### Adding a rule

1. Write it as a **pure function** in the matching `findings-*.js`, exported
   through that file's `*_RULES` array. It must return a `Finding`, an array of
   them, `null`, or `suppressed(reason)` — and it must carry a `minSample`.
2. Give it a namespaced `id` (`area.what-it-checks`); ids are the sort tiebreak, so
   they must be unique and stable.
3. Put account names in `finding.accounts`, **never** in `title`, `detail` or
   `evidence` — `admin-findings.test.js` sweeps every rendered string for an
   address, and `admin-brief.js` drops that field before the model sees anything.
4. Cover it in `test/frontend/admin/admin-findings.test.js`. The table-driven
   sweeps there (empty dataset, tiny dataset, junk input, action present) cover a
   new rule automatically; add a case for its own behaviour.

## Emails tab

A gallery of **every email a user can receive**, each rendered exactly as it arrives, with
a per-template **"Send test"** button that mails a live copy to an address the operator
types in. It exists so you can eyeball the real templates (and check a change) without
digging through code or triggering a real signup/trial.

**Single source of truth.** The preview is built from the *same* pure renderers the real
senders use — never a copy — so a preview can't drift from what actually ships:

- Account mail lives in [`lib/services/email.js`](../../lib/services/email.js) as
  `renderRegistrationVerificationEmail` / `renderAccountExistsEmail` /
  `renderPasswordResetEmail` / `renderPasswordChangedEmail` (the senders and
  `routes/auth.js` build from these).
- Trial mail lives in [`lib/services/lifecycle-emails.js`](../../lib/services/lifecycle-emails.js)
  as `renderTrialWelcomeEmail` / `…ActivationNudge…` / `…Value…` / `…Ending…` /
  `renderSubscriptionCanceledEmail`.
- [`lib/services/email-catalog.js`](../../lib/services/email-catalog.js) collects them all
  with representative **sample data** into `list()` (the gallery) and `renderById(id)` (the
  test send). Operator-only mail (bug reports, contact form) is deliberately excluded — this
  is a "what users see" gallery.

**Endpoints** (both `protectLogs`-gated, like every admin route):

| Route | Purpose |
|---|---|
| `GET /api/admin/email-previews` | Returns the catalog — `{ emails: [{ id, label, category, description, subject, html, text }] }`. Read-only. |
| `POST /api/admin/email-test-send` | `{ id, email }` → sends `[Test] <subject>` to that address. Validates the id + email; the recipient is never logged. |

`sendTestEmail` (built in `server.js`) sends to the **exact address entered** — it does not
apply the `EMAIL_DEBUG_MODE` redirect, because the operator is deliberately testing delivery
to themselves. It returns `{ ok, status?, error? }` and never throws, so a Resend outage
surfaces as a clean error rather than a 500.

**Rendering.** Each preview HTML is shown in a `<iframe sandbox="allow-same-origin" srcdoc>`
— `allow-same-origin` *without* `allow-scripts` isolates the email's own inline styles from
the dashboard and lets the island auto-size the frame to its content, while still guaranteeing
no script in the markup can run.

Two details make that auto-size actually fit. It measures **`body.scrollHeight`, not
`documentElement`'s**: `documentElement.scrollHeight` is floored at the iframe's own height,
so measuring it lets a frame grow but never shrink and every short email sits in the CSS
default with dead space under it. And the frame document sets `display: flow-root` on
`<body>`, so a first child with a top margin cannot collapse it through the body and measure
short. A single measurement on `load` is not enough either — logos and webfont metrics land
after it — so a `ResizeObserver` (plus per-image `load`) re-fits as the document settles.

**Adding an email to the gallery:** write (or reuse) a pure `render…Email()` that returns
`{ subject, html, text }`, then add one entry to the `defs` array in `email-catalog.js` with
an `id`, `label`, `category`, `description`, and a `render()` thunk supplying sample data.
`test/services/email-catalog.test.js` pins the roster, so update its `EXPECTED_IDS` too.

## Server status tab

The operator's view of the same monitor that feeds the public
[`/status`](../../public/status.html) page — plus the one thing that page cannot have:
a way to **post an incident by hand**.

**Why posting exists at all.** [`uptime-monitor.js`](../../lib/data/uptime-monitor.js)
infers downtime from *missed heartbeats*, so it only ever learns that the **process**
died. An outage the process survived — a dead upstream model, a bad deploy, an expired
key — is invisible to it, and the page cheerfully reports 100% through the whole thing.
A posted incident is the only way that reaches a reader.

**What each posted entry carries:** a title (what the public page shows, verbatim), a
start, an end (**blank = ongoing**), and `affectsUptime`. That last flag is the reason a
scheduled-maintenance notice and a real outage can share one form: only an entry flagged
as downtime moves the 24h/7d/30d figures.

Three rules the implementation depends on:

- **Manual entries never go through `mergeIncidents`.** That function coalesces anything
  within two heartbeats and keeps a single `cause` — correct for a burst of missed beats,
  fatal for a sentence someone typed. They live in `state.manual`, their own array.
- **The percentages come from the union.** `downtimeIntervals()` merges the auto gaps with
  the manual entries flagged as downtime, so an operator logging an outage the heartbeat
  also caught is not counted twice.
- **`cause` carries the title.** `status.js` already renders `cause` for auto entries, so
  reusing the field is what lets a posted incident appear on the public page. The only
  client change it needed was rendering `ongoing` instead of a null end date
  (`status.incidents.ongoing`, in all 11 packs).

An **ongoing** entry flagged as downtime flips `currentState` to `down`, so the public
banner reads "Service disruption detected" until it is resolved — and the rail carries a
dot while one is open.

**What makes the admin view deeper than `/status`**, concretely: per-window **coverage**
(a 100% figure means nothing if only four of the last 24 hours were observed), a **30-day
graph** the public page does not draw, the monitor's own configuration (cadence, the gap
that counts as an outage, retention, where the state lives), and the two feeds separated —
detected vs posted — with the actions on the second.

| Route | Purpose |
|---|---|
| `GET /api/admin/status` | The richer snapshot. Separate from `/api/status`, which every visitor polls. |
| `POST /api/admin/incidents` | `{ title, start?, end?, affectsUptime }` → `201`. A `400` carries a message written for the operator; the panel shows it verbatim. |
| `POST /api/admin/incidents/:id/resolve` | Close an ongoing entry at now. |
| `DELETE /api/admin/incidents/:id` | Remove it — from the public page too, immediately. |

**Backdating before monitoring began does not move the figure.** A percentage is only ever
computed over the stretch actually watched, so a fresh monitor cannot be talked into
claiming knowledge of the week before it existed. The entry still publishes; `coverage` is
what explains the gap. Same rule the auto side follows.

**Reset wipes posted entries too.** The confirm dialog says it wipes everything, so it does.

## Referrals tab

Campaign short-URLs — `stagify.ai/columbia` and any sibling — that **302 to the home page
while counting the arrival**, so you can hand a different link to each channel and see which
one works. Links are **created and retired from this tab**; there is no deploy in the loop.
A compact list of every link, and selecting one opens its detail: chart, referring sites,
copy button, and its actions.

**How a hit becomes a click.** [`routes/referrals.js`](../../routes/referrals.js) matches
`/:slug` and resolves it against [`lib/data/referral-links.js`](../../lib/data/referral-links.js)
per request, records a row, and redirects. Counting is best-effort on purpose: the store
swallows its own write errors and `referralLimiter` drops rows instead of answering 429,
because a stranger opening the URL must reach the site whether or not the analytics write
lands. Unresolved slugs `next('route')` **before** the limiter, so the stray 404 traffic this
route inevitably sees cannot exhaust the bucket protecting the real links.

**Mount position is a safety property, not a style choice.** The router is mounted LAST in
`server.js`, after every other route. A `/:slug` pattern matches anything, so this placement
is the only reason an operator-typed slug cannot shadow a real page — mounted here it only
ever sees paths nothing else claimed. `createLink` also refuses reserved names
(`RESERVED_ROUTE_ROOTS` + locale prefixes + everything in `public/`), but that is a helpful
error, not the guarantee. `test/routes/referral-route.test.js` pins both independently.

**Retire vs delete.** Retiring sets `active = 0`: the URL 404s immediately, the row and its
clicks stay on the dashboard, and the slug is still taken (reusing it would silently graft a
new campaign onto an old one's history). Only a retired link offers **Delete permanently**,
which drops the link and every hit it recorded in one transaction — so the irreversible
button is never the one next to a live campaign.

**Bots are flagged, not dropped.** A link pasted into Slack/iMessage/WhatsApp is fetched by
that platform's unfurler before any human clicks it, so counting those would inflate a
campaign badly — but silently discarding them leaves you wondering where the hits went.
`isBotUserAgent` classifies on the user-agent, and everything the dashboard calls a "click"
is `is_bot = 0`; the excluded count is shown beside it. A **missing** user-agent counts as a
bot (every real browser sends one). `HEAD` requests are redirected without being counted.

**What is not stored:** no IP address, no user-agent string (inspected in memory, then
dropped), and no referrer query string — only `host/path`, since a referring URL routinely
carries the sending site's own tracking params. Hits are pruned past 400 days and capped per
slug; both tables live in the shared SQLite DB, so Litestream already backs them up.

**Endpoints** (all behind `protectLogs`): `GET /api/admin/referrals?days=` for the rollup,
`POST /api/admin/referrals` to create, `POST /api/admin/referrals/:slug/deactivate` and
`…/activate`, `DELETE /api/admin/referrals/:slug`. A create rejection carries a `code`
(`SLUG_INVALID`, `SLUG_RESERVED`, `SLUG_TAKEN`, `LABEL_REQUIRED`) and a message written for
the operator — the panel shows it verbatim, because it is the only thing telling them what
to type instead.

**The one hardcoded thing left** is the seed: `/columbia` predates links being data, so it is
inserted once behind a `meta` guard. The guard matters — without it, deleting that link would
resurrect it on the next boot.

## Conventions when editing

- Build DOM with `helpers.js#el` and set `textContent`, never `innerHTML`, for anything
  derived from logged data — prompts, emails and user agents are user-supplied. If you
  genuinely must assemble markup, `helpers.js#esc` is the shared
  [`escapeHtml`](../../public/scripts/escape-html.js) (it was a no-op returning its input
  until 2026-07-28 — anything written against the old behaviour is now escaped for real).
- Style through a class in `admin.css`, not an inline `style` attribute. The tokens are
  declared once on `.page-admin`.
- The 650-line ESLint cap applies here like everywhere else — split into a sibling island
  rather than raising it.
