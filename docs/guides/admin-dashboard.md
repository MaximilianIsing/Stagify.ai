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
| [`scripts/admin/overview.js`](../../public/scripts/admin/overview.js) | The **Overview** tab: stat cards, the two generation charts, top users, recent signups. |
| [`scripts/admin/insights.js`](../../public/scripts/admin/insights.js) | The **Insights** tab: the chart grid. |
| [`scripts/admin/analytics.js`](../../public/scripts/admin/analytics.js) | **Pure aggregation** — bucketing, distributions, deltas. No DOM. |
| [`scripts/admin/charts.js`](../../public/scripts/admin/charts.js) | **SVG chart primitives** — area, bar, ranked bars, donut, sparkline, card chrome. |
| [`scripts/admin/grant.js`](../../public/scripts/admin/grant.js) | The comp-Stagify+ control inside the user detail drawer. |
| [`scripts/admin/helpers.js`](../../public/scripts/admin/helpers.js) | DOM/format helpers + the icon set. |
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

**Overview** — `#adm-stats` (8 stat cards with trailing-window deltas and sparklines),
then `#adm-charts`:

| Chart | Source |
|---|---|
| Daily generation activity | Trailing 30 days, zero-filled, area |
| Generation activity — all time | First render → today, **auto-bucketed** day/week/month |

**Insights** — `#adm-insights`, one grid of cards: cumulative generations · total accounts
over time · new signups per bucket · plan mix · sign-in method · feature usage mix ·
furniture removal · room types · furniture styles · referral sources · user roles ·
mask-edit models · enterprise usage by domain · activity by hour · activity by weekday ·
chat messages (30d) · mask edits (30d).

The two generation charts answer different questions on purpose. The 30-day one is "is it
busy right now", so its window is fixed and zero-filled — a dead week must *look* dead.
The all-time one is the shape of the whole history, so it re-buckets itself as history
grows (`pickGranularity`: ≤70 days → daily, ≤550 → weekly, beyond → monthly), keeping the
point count in a readable 20–90 band at every scale.

### Adding a chart

1. Add the aggregation to `analytics.js` as a **pure function** and cover it in
   `test/admin-analytics.test.js`.
2. Render it in `insights.js` (or `overview.js`) with an existing primitive from
   `charts.js`, wrapped in `chartCard({title, sub, body, notes})`.
3. Only add a new primitive if no existing one fits — and cover it in
   `test/admin-charts.test.js`.

## Data sources

Everything is fetched in one `Promise.all` in `admin.js#loadAll`. The CSV files are parsed
by `helpers.js#parseCSV` (RFC 4180) into arrays of string cells addressed **by index**, so
the column maps below are load-bearing. They are duplicated as named constants at the top
of `insights.js` — if a writer gains a column, fix both.

| Endpoint | Written by | Columns |
|---|---|---|
| `/authstore` | `lib/data/auth-store.js` | JSON — `{users: [...]}` |
| `/promptlogs` | `lib/services/logging.js` | `timestamp, roomType, furnitureStyle, additionalPrompt, removeFurniture, userRole, referralSource, email, ipAddress` |
| `/chatlogs` | `lib/services/logging.js` | `timestamp, userId, userMessage, aiResponse, fileNames, fileTypes, ipAddress, userAgent` |
| `/masklogs` | `lib/services/logging.js` | `timestamp, prompt, model, geminiModel, imageWidth, imageHeight, userId, ipAddress, userAgent` |
| `/contactlogs` | `routes/public.js` | `timestamp, userRole, referralSource, email, userAgent, ipAddress` |
| `/bugreports` | `routes/public.js` | `timestamp, description, stepsToReproduce, email, userId, userAgent, url, ipAddress, conversationHistory` |
| `/email-open-logs` | `lib/services/email.js` | `timestamp, email, ipAddress, userAgent` |
| `/enterprise-domains` | `lib/data/enterprise-store.js` | JSON — `{domains: [...]}` |
| `/api/hosted-images` | `lib/image/hosted-images.js` | JSON — `{images: [...]}` |

Two conventions the aggregators depend on:

- **Every log file starts with a `timestamp,…` header row**, and `parseCSV` has no reason
  to know that — to it the header is just another row. `analytics.js#stripHeader` drops
  it. Skip that call and totals are off by one and the header lands in the charts as a
  user named `email`.
- **Day keys are local, not UTC.** The dashboard is read by a human in one timezone, so
  "today" must be *their* today. `toISOString().slice(0,10)` looks equivalent but shifts
  every row by a day for anyone east of UTC. Everything goes through
  `analytics.js#dayKeyLocal`.

## Testing

Three suites, all pure/DOM-stubbed — no jsdom, no browser (see
[`testing.md`](testing.md)):

- [`test/admin-analytics.test.js`](../../test/admin-analytics.test.js) — the aggregators:
  local day keys, zero-fill, granularity thresholds, window deltas, distributions.
  Fixtures are built relative to `new Date()` so the suite can't rot.
- [`test/admin-charts.test.js`](../../test/admin-charts.test.js) — the SVG builders,
  asserted on invariants rather than coordinates: one hover target per point, geometry
  proportional to the data, a zero drawing nothing, axis labels that don't collide.
- [`test/admin-helpers.test.js`](../../test/admin-helpers.test.js) — `parseCSV` and the
  formatters. [`test/admin-grant-ui.test.js`](../../test/admin-grant-ui.test.js) covers
  the grant control; [`test/admin-route.test.js`](../../test/admin-route.test.js) covers
  the server side.

## Conventions when editing

- Build DOM with `helpers.js#el` and set `textContent`, never `innerHTML`, for anything
  derived from logged data — prompts, emails and user agents are user-supplied.
- Style through a class in `admin.css`, not an inline `style` attribute. The tokens are
  declared once on `.page-admin`.
- The 650-line ESLint cap applies here like everywhere else — split into a sibling island
  rather than raising it.
