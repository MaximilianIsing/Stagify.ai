# Admin dashboard

The operator console at [`/admin`](../../public/admin.html) — accounts, logs, image
hosting, data exports, and the analytics charts. It is a single static page gated by the
`endpoint_key`, with no dedicated backend: it downloads the same CSV/JSON files the
[export endpoints](../reference/endpoints.md) already serve and does every aggregation in
the browser.

> **Access.** `endpoint_key` is sent in the `X-Stagify-Endpoint-Key` header, never in a
> URL. It lives in a closure for the session only — it is never persisted, so a reload
> always asks again. See [`security.md`](security.md).

## Module map

Follows the [entry + islands pattern](frontend.md#pages-entries-and-islands): the entry
owns auth/fetch/wiring, each island owns one cohesive concern.

| File | Role |
|---|---|
| [`scripts/admin.js`](../../public/scripts/admin.js) | **Entry.** Login + lockout, the in-closure key, `apiFetchQ` / `apiSend` / `secureBlobDownload`, `loadAll()`, tab switching, upload wiring, sign-out. |
| [`scripts/admin/renderers.js`](../../public/scripts/admin/renderers.js) | The table tabs (users + detail drawer, enterprise, contacts, email opens, bugs, hosting, downloads) and `effectivePlan`, which both chart islands take as a dependency. |
| [`scripts/admin/overview.js`](../../public/scripts/admin/overview.js) | The **Overview** tab: the range selector, stat cards, the two generation charts, top users, recent signups. |
| [`scripts/admin/insights.js`](../../public/scripts/admin/insights.js) | The **Insights** tab: the chart grid. |
| [`scripts/admin/analytics.js`](../../public/scripts/admin/analytics.js) | **Pure aggregation** — bucketing, distributions, deltas, render outcomes. Owns `COL`, the CSV column map. No DOM. |
| [`scripts/admin/analytics-users.js`](../../public/scripts/admin/analytics-users.js) | **Pure per-account aggregation** — last-active, activation funnel, cohort retention. No DOM. |
| [`scripts/admin/charts.js`](../../public/scripts/admin/charts.js) | **SVG chart primitives** — area, bar, ranked bars, donut, funnel, cohort grid, sparkline, card chrome. |
| [`scripts/admin/grant.js`](../../public/scripts/admin/grant.js) | The comp-Stagify+ control inside the user detail drawer. |
| [`scripts/admin/emails.js`](../../public/scripts/admin/emails.js) | The **Emails** tab: the preview gallery + per-template test send. Lazy-loaded on first open. |
| [`scripts/admin/referrals.js`](../../public/scripts/admin/referrals.js) | The **Referrals** tab: one card per campaign short-URL. Lazy-loaded on first open; `Refresh` invalidates it. |
| [`scripts/admin/helpers.js`](../../public/scripts/admin/helpers.js) | DOM/format helpers + the icon set. `esc` is re-exported from the shared [`scripts/escape-html.js`](../../public/scripts/escape-html.js). |
| [`styles/admin.css`](../../public/styles/admin.css) | Page styles, including everything the SVG charts are painted with. |

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
| `/promptlogs` | `lib/services/logging.js` | `timestamp, roomType, furnitureStyle, additionalPrompt, removeFurniture, userRole, referralSource, email, ipAddress, status, durationMs, model, attempts, errorCode` |
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

**Adding an email to the gallery:** write (or reuse) a pure `render…Email()` that returns
`{ subject, html, text }`, then add one entry to the `defs` array in `email-catalog.js` with
an `id`, `label`, `category`, `description`, and a `render()` thunk supplying sample data.
`test/services/email-catalog.test.js` pins the roster, so update its `EXPECTED_IDS` too.

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
