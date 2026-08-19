# Stagify API & server routes

This document describes HTTP endpoints for the Stagify server. Routes are registered across `routes/*.js` (`public.js`, `auth.js`, `billing.js`, `staging.js`, `chat.js`, `admin.js`, `i18n.js`, `gallery.js`, `share-public.js`, `referrals.js`) and mounted from `server.js`; static files are also served from `public/`, and anything still unmatched reaches the catch-all 404 in `lib/http/not-found.js` (not every path is listed here). Default port: **`process.env.PORT` or `3000`**.

## Authentication helpers (used by several routes)

- **Bearer session:** `Authorization: Bearer <token>` (JWT/session token from `authToken` in login/register responses).
- **Token in body:** `authToken` in a JSON or multipart field — accepted by the handler-side
  check on most routes, but **not sufficient on the three multipart upload routes**
  (`/api/process-image`, `/api/enhance-exterior`, `/api/chat-upload`). Those refuse an
  unauthenticated caller in middleware *before* multer runs, so that they do not buffer up
  to 150 MB for a request they are about to reject — and at that point `req.body` does not
  exist yet, so only the header is readable. Send the header to those three.
- **Token in query:** not supported. A token in a URL leaks via access logs, browser
  history and `Referer`, so `getAuthUserFromRequest` deliberately never reads `req.query`
  (see the comment in `lib/services/auth-helpers.js`). This line previously claimed the
  opposite.

**`getAuthUserFromRequest`:** loads the user from a valid session token (header or body).

**`requireProAccount`:** requires a signed-in user with `plan === 'pro'`; otherwise `401` (`AUTH_REQUIRED`) or `403` (`PRO_REQUIRED`).

---

## Public pages & SEO (no API key)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Serves `public/index.html`. |
| `GET` | `/robots.txt` | Serves `public/robots.txt`. |
| `GET` | `/sitemap.xml` | Serves `public/sitemap.xml` — **generated** by `scripts/build-i18n-seo.js` (per-language `<url>` entries + `xhtml:link` alternates). A test fails if the committed file drifts from the generator. |
| `GET` | `/<lang>`, `/<lang>/<page>` | **Localized pages** — `/es`, `/fr/guides.html`, `/de/contact.html`, … Rendered server-side per language from `public/languages/*.json` by `routes/i18n.js` (`lib/i18n/`). `/<lang>/index.html` 301s to `/<lang>`. English stays un-prefixed at the root. See [`i18n.md`](../guides/i18n.md). |
| `GET` | `/status` | Serves `public/status.html` — the public status/uptime page. Client-side it polls `GET /api/status` and draws 24-hour and 7-day availability graphs. |
| `GET` | `/privacy` | Serves `public/privacy.html`. |
| `GET` | `/blog` | **301-redirects to `/blog/`** — `express.static` runs before the router and `public/blog/` is a real directory, so a `router.get('/blog')` would be dead code (don't add one). |
| `GET` | `/blog/` | Serves `public/blog/index.html` — the blog hub (static directory index). Canonical hub URL. |
| `GET` | `/blog/<slug>` | Serves an article via an **explicit clean, extensionless route** in `public.js` — e.g. `/blog/is-virtual-staging-allowed-on-the-mls`, `/blog/masking-studio-and-ai-designer`, `/blog/does-virtual-staging-help-sell-homes`. Route registration + sitemap sync are guarded by `test/server/public-endpoints.test.js`. |
| `GET` | `/i/:id` | **Public hosted-image serve.** `:id` is a 16–64-char hex id minted by `POST /api/host-image`. Streams the stored image with `Cache-Control: public, max-age=31536000, immutable` and `X-Content-Type-Options: nosniff`. `404` (plain text) for an invalid or unknown id. |
| `GET` | `/email/logo.png` | Email logo **and open-tracking pixel.** With `?email=<addr>`, logs an email open (only when the request looks like a genuine email-client fetch) to `email_open_logs.csv`, then serves the logo PNG with `Cache-Control: no-store`. |
| `GET` | `/<campaign-slug>` | **Referral / campaign short-URL** — `/columbia`, and any other link created in the admin **Referrals** tab. Records one arrival (`referral_hits`) and **`302`s to `/`** with `Cache-Control: no-store`. Slugs are operator data in `referral_links`, not routes: `routes/referrals.js` matches `/:slug` and resolves per request, and is **the last router mounted in `server.js`** so it only ever sees paths nothing else claimed — an unknown or retired slug `next('route')`s through to the catch-all `404` below. `HEAD` redirects without counting. Automated traffic is flagged `is_bot` and excluded from click totals. See [`admin-dashboard.md`](../guides/admin-dashboard.md#referrals-tab). |
| `GET` | `/bimi-logo.svg` | BIMI brand mark, served with an explicit content type. |
| `*` | *anything unmatched* | **The catch-all `404`** (`lib/http/not-found.js`), mounted after every router. Serves `public/404.html` at status `404` with `Cache-Control: no-cache`, localized off the URL's first path segment (`/es/nope` → Spanish, `/nope` → English). Under `/api/*`, or for any client that does not accept HTML, it returns the standard JSON body instead. Rationale for its three non-obvious choices: [`architecture.md`](../guides/architecture.md#the-404-handler). |

Other `.html` and assets are served by **`express.static('public')`** (e.g. `/stagify-plus.html`, `/ai-designer.html`, `/plus-welcome.html`, `/logo-full.png`). That mount runs **before** every router, and has no `extensions` option — which is why `/404.html` is reachable as a plain file with a `200` that no route can intercept, and why the page carries `noindex`.

### Indexing policy (robots.txt / sitemap.xml / canonical / hreflang)

`public/robots.txt` is hand-maintained; **`public/sitemap.xml` is generated** by
`scripts/build-i18n-seo.js` from `lib/i18n/locales.js` (rerun it after changing the
language or page set — a drift test enforces it). Every page falls into exactly one of
three buckets — keep `robots.txt` and the canonical/sitemap in sync when adding a page:

- **Indexable** — carries `<meta name="robots" content="index, follow">` **and** a
  `sitemap.xml` entry whose `<loc>` matches its `rel="canonical"`. These are the
  marketing/product/legal pages: `/`, `ai-designer.html`, `masking-studio.html`,
  `exterior-studio.html`, `basic-mask.html`, `stagify-plus.html`, `enterprise.html`,
  `guides.html`, `contact.html`, `/status`, `privacy.html`, `terms.html`. The first four
  are Stagify+ tools and are indexable **because** they no longer redirect a visitor
  without a token — each shows a public pitch or the tool on the same URL, which is what
  makes the canonical/hreflang work on them worth anything (see
  [`frontend.md`](../guides/frontend.md#paid-pages-reshape-they-do-not-redirect)).
  Each is **served in 11 languages at its own URL** (`/`
  English + `/<lang>/…` for the other 10) with a self-referential canonical, a full
  `hreflang` cluster (all languages + `x-default`), and one sitemap `<url>` per language
  carrying `xhtml:link` alternates — all driven by `lib/i18n/locales.js` (see
  [`i18n.md`](../guides/i18n.md)). **Plus the blog** (English-only): the hub `/blog/` and
  each article `/blog/<slug>` (self-contained pages under `public/blog/`, each carrying
  `index, follow`, a canonical, `BlogPosting`/`BreadcrumbList` JSON-LD, and a `sitemap.xml`
  entry). Not in `robots.txt`.
- **Internal** — `noindex, nofollow`, **absent** from the sitemap, and listed under
  `Disallow:` in `robots.txt`: `admin.html` (`/admin`), `reset-password.html`,
  `getpro.html` (`/getpro`), `plus-welcome.html`, and everything under `legal/`.

`404.html` fits **none** of the three buckets, and that is deliberate rather than an
oversight. It is `noindex, **follow**` (a lost crawler should still follow the nav out),
absent from the sitemap, and **not** in `robots.txt` — a `Disallow:` would stop the
crawler reading the `noindex` it needs to see. It is also the only page with no
`rel="canonical"`, because it answers at every unknown URL and so has no canonical
address; that absence is what suppresses its hreflang cluster. See
[`i18n.md`](../guides/i18n.md#the-localized-page-set).
**Every page carries exactly one `<h1>`**, and it is the page's own subject rather than
a section title — the crawler weighs it against the `<title>`, and a screen reader's
"jump to heading 1" has nothing to land on without it. `ai-designer.html` is the awkward
case and shows the rule: it is a full-height chat app with no title bar, so its `h1` is
`sr-only`. The chat's visible "AI Designer" empty-state heading cannot serve — that node
is removed on the first message, which would take the page's only `h1` with it.
Enforced by [`test/server/heading-structure.test.js`](../../test/server/heading-structure.test.js),
which also holds the three deliberate exemptions (the two redirect stubs below, and
`admin.html`'s two mutually-exclusive view shells).

- **Redirect stubs** — `pro.html` → `stagify-plus.html` and `faq.html` →
  `index.html#faq`, each a meta-refresh + `rel="canonical"` to its real page. These
  are deliberately **left out of `robots.txt`**: blocking them would stop crawlers
  from reading the canonical and folding the old URL into the new one. Keep them
  crawlable and out of the sitemap.

> **Stagify+ personal subscription flow (no server endpoint).** Unlike the enterprise
> plan (`POST /api/enterprise/create-checkout`, below), the individual Stagify+ plan does
> **not** create a server-side Checkout Session. The "Start free trial" button on
> `stagify-plus.html` is a Stripe **Payment Link** (`scripts/stagify-plus.js` appends the
> signed-in user's `client_reference_id` + `prefilled_email`). Stripe hosts checkout,
> fires `checkout.session.completed` to `POST /api/billing/stripe-webhook` (which upgrades
> the account to `pro`), then redirects the buyer to **`/plus-welcome.html`** — the
> post-purchase confirmation page. That redirect is configured on the Payment Link's
> *After payment* setting in the **Stripe dashboard, not in this repo**, and the same
> `https://stagify.ai/plus-welcome.html` URL is registered as the Google Ads conversion
> page. Renaming or removing `plus-welcome.html` therefore silently breaks the
> post-checkout hand-off and ad conversion tracking (guarded by `test/frontend/plus-welcome.test.js`).
>
> Both parameters are buyer-editable, and `customer_email` is unverified by Stripe, so
> the webhook treats them differently: an email match may **start** a Stagify+ billing
> relationship but never replace one that already exists (a live subscription or an admin
> comp grant). The button stays clickable while signed out, so a checkout with no
> `client_reference_id` is an ordinary purchase and still activates. Rationale:
> [`security.md`](../guides/security.md#stagify-checkout-an-unverified-email-may-start-a-subscription-never-take-one-over).

---

## Stagify+ pass link

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/getpro` | Serves `public/getpro.html` — the "activate Stagify+" page. **No key or auth on the GET itself** (`200` for everyone); the page collects the admin key and the user's session `authToken` and calls `POST /api/getpro`. |
| `POST` | `/api/getpro` | **Grants Stagify+ to the signed-in account.** Both secrets ride in **headers**, never the URL: `X-Stagify-Endpoint-Key: <LOGS_ACCESS_KEY>` (constant-time compare) plus a valid session (`Authorization: Bearer <token>`). **Returns:** `503` if the key isn't configured, `403` on a missing/wrong key, `401` if the key is valid but there's no session, `400` if the grant fails, `{ ok: true }` on success. Same secret as the log exports, `/api/stage-by-endpoint-key`, and `/api/send-email`. |

---

## Billing (Stripe)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/billing/stripe-webhook` | **Body:** raw JSON (must **not** go through `express.json()`; uses `express.raw`). **Header:** `stripe-signature` for verification. If Stripe is not configured: `503`. Forwards to internal `handleStripeEvent` (subscription lifecycle, etc.). Responds `{ received: true }` on success. **Idempotent:** each `event.id` is claimed in the `stripe_events` ledger (`lib/data/stripe-events.js`) before dispatch, so a Stripe redelivery is acked as `{ received: true, duplicate: true }` without re-running any handler. A handler that throws releases the claim and answers `500`, so Stripe's retry is processed normally. |
| `POST` | `/api/billing/customer-portal` | **Auth:** signed-in user with a Stripe customer id. **Body:** JSON (can be empty). Returns `{ url }` to Stripe Billing Portal, or `503` if Stripe off, `401` if not signed in, `400` if no `stripeCustomerId` on the user. |
| `GET` | `/api/enterprise/config` | Public. Returns `{ publishableKey }` (Stripe publishable key) for the enterprise checkout page; `''` if Stripe isn't configured. |
| `POST` | `/api/enterprise/create-checkout` | **Enterprise self-serve checkout** (from `enterprise.html`). **Body (JSON):** `{ domain, companyName, contactEmail, contactPhone? }`. Validates the fields, and creates a Stripe **subscription** Checkout Session for the metered enterprise price (`ENTERPRISE_PRICE_ID`), returning `{ url }` to redirect to. **Errors:** `503` if Stripe or the price id isn't configured, `400` on invalid input, `400` `PUBLIC_EMAIL_DOMAIN` if `domain` is a public mailbox provider (see below), `409` if the domain already has an active/trialing plan (worded so it doesn't confirm the customer relationship), `429` past `RL_CHECKOUT` (10/hour/IP). **Unauthenticated by design** — a company buys before it has accounts — so that limiter is the only bound on Stripe-session spam and customer probing; see [`security.md`](../guides/security.md#the-enterprise-checkout-is-public-on-purpose). |

> **Public email providers can't be registered as enterprise domains.** An enterprise
> domain is a *blanket grant* — `isActiveDomain()` upgrades every account whose email
> ends in it to `pro` — so selling `gmail.com` would hand Stagify+ to the whole
> internet for one seat. The domain list and matcher live in
> [`lib/data/public-email-domains.js`](../../lib/data/public-email-domains.js) (free
> consumer providers + common disposable services), and the refusal carries the stable
> code **`PUBLIC_EMAIL_DOMAIN`** so the page can localize it
> (`enterprise.errors.publicDomain`). Matching normalizes first, so `@GMAIL.com`, a
> whole address, a trailing dot, and subdomains such as `mail.gmail.com` are all
> caught. Adding a provider is a one-line edit to that file.
>
> The gate is enforced in **three** places, and the third is the one to keep:
> the checkout route above; `activateDomain()` (refuses to write the row, so a
> replayed webhook or a subscription created straight in the Stripe dashboard can't
> sneak one in); and **`isActiveDomain()`** itself. That last check looks redundant
> next to the write-path guard but is not — it is the single chokepoint every plan
> upgrade passes through, so it also neutralizes rows that arrived some other way (the
> legacy `enterprise-domains.json` import, `importStore()`, a hand-edited DB). Don't
> remove it as a duplicate.
>
> **Scope:** enterprise registration only. Ordinary signup (`/api/auth/register`)
> must keep accepting gmail/yahoo/outlook addresses — never wire this list into auth.

---

## Auth

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/auth/register` | **Body:** `{ email, password }`. Sends a 6-digit verification code to email. Returns `{ ok, needsVerification, message }` or `400`/`502`/`503`. |
| `POST` | `/api/auth/register/verify` | **Body:** `{ email, code }`. Verifies code and creates account. Returns `{ success, token, user }` or `400`. |
| `POST` | `/api/auth/register/resend` | **Body:** `{ email }`. Resends verification code for pending sign-up. |
| `POST` | `/api/auth/login` | **Body:** `{ email, password }`. Returns `{ success, token, user }` or `401`. |
| `GET` | `/api/auth/config` | Public. Returns `{ googleClientId: string \| null, isStaging: boolean, showStagingBanner: boolean }`. `isStaging` reflects the `IS_STAGING` env flag; when it's on, `googleClientId` is forced to `null` (UI hides the Google button) and the client blocks the Stripe subscribe / "help center" buttons. `showStagingBanner` is `IS_STAGING && !HIDE_STAGING_BANNER` — the red staging banner shows only when it's `true`, so `HIDE_STAGING_BANNER` can suppress the banner without lifting the Google/Stripe restrictions. |
| `POST` | `/api/auth/google` | **Body:** `{ credential }` (Google ID token). Returns `{ success, token, user }`, or `403` (`STAGING_DISABLED`) when `IS_STAGING` is on, or `4xx/503` if not configured or invalid. |
| `GET` | `/api/auth/me` | **Auth:** valid session. Returns `{ user }` (public user shape, including `dailyGenerationsUsed` / `dailyGenerationLimit` for free tier). `401` if not signed in (`AUTH_REQUIRED`). |
| `POST` | `/api/auth/logout` | **Body (optional):** `authToken`. **Or** `Authorization: Bearer` token. Invalidates the session. Returns `{ success: true }`. |
| `POST` | `/api/auth/forgot-password` | **Body:** `{ email }`. If account exists and email is configured, sends reset link; various `{ ok, emailSent, message }` or `503/502` if email not configured. |
| `POST` | `/api/auth/reset-password` | **Body:** `{ token, password }`. Completes reset and **revokes every live session for the account** (all devices signed out; no new session is minted, so the client goes to the login page), then emails the owner a "password was changed" notice **best-effort** (a send failure is logged, not surfaced). Returns `{ ok: true }` or `400`. |

---

## Virtual staging (image)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/validate-image` | **Pre-flight stageability check.** **Body (JSON):** `{ image }` — a data URL of the chosen photo (clients downscale to ~1024px first). **Auth:** a signed-in session is **required** (`Authorization: Bearer …`, or `authToken` in the body) — anything else gets `401` `AUTH_REQUIRED`, checked *before* the body is inspected. Every accepted call spends a paid vision pass, and `genLimiter` is a per-IP ceiling — a cost cap, not an identity — so the pre-flight is gated exactly like the staging it precedes. Nothing legitimate is lost: both studios already send the token, and both fail **open** on a non-2xx, so a signed-out browser silently skips the pre-check and meets the same gate one request later at `/api/process-image`. A cheap `gemini-2.5-flash-lite` vision pass decides whether the photo is a stageable room/property space or a piece of furniture. Always returns **`200`** with `{ valid: boolean, code: string \| null, reason: string }`. On a rejection, `code` is a **stable category** from a fixed taxonomy — `PERSON_PORTRAIT`, `ANIMAL`, `FOOD`, `DOCUMENT`, `VEHICLE`, `UNRELATED_OBJECT`, or `UNSTAGEABLE` (generic) — and `reason` is the canonical **English** copy for it; on approval both are `null` / `""`. Clients should localize `code` via `errors.unstageable.<CODE>` and use `reason` only as the fallback (see [`i18n.md`](../guides/i18n.md)); the taxonomy lives in `lib/staging/unstageable.js`. **Fails OPEN** (`valid: true`) whenever the reviewer is disabled, errors, **or returns an unreadable verdict**, so it never blocks a legitimate upload. `400` only for a missing/undecodable `image`. Called by the main stager (on upload; hard-gates staging) and the Masking Studio (on upload; blocks entering the editor). |
| `POST` | `/api/process-image` | **Multipart** staging upload (`stagingProcessUpload`). **File:** at least `image` (see multer field names in server). **Typical body fields** (strings): `roomType`, `furnitureStyle`, `additionalPrompt`, `removeFurniture`, `userRole`, `userReferralSource`, `userEmail`, and for pro: `model`, `variationCount`, `furnitureImage` (repeat), `authToken`. **Rules:** Requires a signed-in session — **any** unauthenticated request gets `401` with `AUTH_REQUIRED` (there is no anonymous/mobile staging path; this closes the IP-rotation cost-abuse vector). For a signed-in **free** user the per-account daily cap (`FREE_DAILY_LIMIT`) is enforced *before* any AI spend; **pro** accounts are uncapped and **enterprise-domain** users are metered separately. On success, may return `user` with updated usage. **Errors:** `401` `AUTH_REQUIRED` (no session); `429` `DAILY_LIMIT_REACHED` + `dailyGenerationsUsed` / `dailyGenerationLimit` (free cap hit); `422` `NO_IMAGE_GENERATED`; `500` if AI not configured. **Success:** `image` or `images` plus `success: true` and often `user` after consumption. Each returned image is a **WebP** data URL, upscaled ~2× (≈4× the pixels) from the model's ~1 MP native output for delivery — interpolation only, not added detail. |
| `POST` | `/api/enhance-exterior` | **Exterior Studio — curb-appeal enhancement.** **Multipart** (`stagingProcessUpload`); only the `image` field is read. **Auth: `requireProAccount`** — `401` `AUTH_REQUIRED` signed out, `403` `PRO_REQUIRED` on a free plan. The Exterior Studio page reveals its controls from JS, which is an affordance, not a boundary; **this gate is the boundary**. **Body fields** (strings): `timeOfDay` (`keep` \| `morning` \| `midday` \| `goldenHour` \| `dusk`), `sky` (`keep` \| `clearBlue` \| `lightClouds` \| `dramatic`), `removeVehicles` / `removeClutter` (`'true'` \| `'on'` \| anything else = off), `additionalPrompt` (clamped to 500 chars), optional `model`. Every option is **opt-in**: `keep` and an off toggle contribute *nothing* to the prompt, so a request that only asks for clutter removal gets exactly that. **Upload gate:** runs **inline, server-side, before any generation** (unlike `/api/validate-image`, which the interior studios call concurrently from the browser) — one cheap vision pass is far cheaper than a wasted image generation. It uses `EXTERIOR_CHECK_PROMPT`, which shares the `UNSTAGEABLE_CODES` taxonomy but **can never reject with `VEHICLE`**: a car on the driveway is this tool's canonical input. Rejection → `422` with `{ code, reason }`, localizable through the same `errors.unstageable.<CODE>` keys (no new keys were added). **Quality gate is OFF** (`skipQualityReview`): one generation, no vision review, no reshoot — a re-roll returns a different sky, not a better one. A thrown provider error is still retried. **Model:** defaults to the **plus** image model rather than the fast one, because the route is Pro-only and has no model picker. **Metering:** enterprise domains by `req._stagingGenerations`, everyone else via `recordStagingActivity`. Saves to the gallery as `roomType: 'Exterior'`. **Success:** `{ success, image, user, gallery? }` — one WebP data URL, never the `images` array. **Errors:** `422` `NO_IMAGE_GENERATED`; `500` with a `ref` otherwise. |
| `POST` | `/api/stage-by-endpoint-key` | **Server integration staging** — same multipart shape as `/api/process-image`, but **no user session**. **Auth:** `LOGS_ACCESS_KEY` from `endpointkey.txt` or `process.env.endpoint_key`, passed in the **`X-Stagify-Endpoint-Key` header only** — **never** `?key=` on the URL (a key in the URL leaks via access logs, proxies, browser history, and `Referer`; the compare is constant-time). Same secret as log CSV exports and `/api/send-email` — **highly sensitive**; treat like a root credential. **Behavior:** Staging runs with **Stagify+-level options** (`model` `gpt-4o-mini` \| `gpt-5-mini`, `variationCount` 1–3, up to three `furnitureImage` files). **Does not** increment per-user or per-IP free-tier daily counters. **Success:** same JSON as process-image (`image` / `images`, `user` is `null`). **`403`** if key missing/wrong, **`500`** if key not configured on server. |
| `GET` | `/api/disclosure-preview` | **Unauthenticated on purpose** — serves the "Preview" hover in the staging modal's disclosure controls, and gating an explanation of what a signup-time option does would hide it from the people deciding whether to sign up. **Query:** `lang`, `style`, `scale` — every value is snapped to a closed allow-list (`normalizePreviewParams`) before it reaches `sharp`, so nothing the caller supplies is rendered as-is. Stamps the SAME sample photo with the SAME code path (`lib/image/stamp-disclosure.js`) that will stamp the user's actual render, so the preview cannot drift from reality. **Success:** the PNG image bytes directly (`Content-Type: image/png`), not JSON. **Limiter:** `disclosurePreviewLimiter` (`RL_DISCLOSURE_PREVIEW`, 120 / 5 min), the only ceiling in front of it. |
| `POST` | `/api/stamp-image` | **Burns the visible "virtually staged" disclosure badge into a client-built composite** — the one endpoint that stamps an image the server did not itself generate. Serves Basic Mask / Masking Studio's *download* button, since both composite their result on a `<canvas>` and this is the only place those pixels ever reach the server. **Auth: `requireProAccount`** — Basic Mask is Stagify+ only. **Body (JSON):** `image` (data URL, ≤16 MB decoded) plus `lang`/`style`/`scale`, normalized identically to `/api/disclosure-preview`. **FAILS CLOSED**: if the badge cannot be applied, the response is a distinguishable `500` with `code: DISCLOSURE_STAMP_FAILED`, never the unstamped image — the caller is about to save a file believing it carries a disclosure. Also embeds Stagify's invisible provenance EXIF/XMP metadata (`lib/image/output-metadata.js`, mode `'edited'`) as a second, best-effort pass — a failure in *that* step does not block delivery, unlike the visible badge. **Success:** `{ success, image }`, a `data:image/png;base64,...` URL. **Limiter:** `stampImageLimiter` (`RL_STAMP_IMAGE`, 30 / 15 min). |
| `POST` | `/api/download-result` | **Server-side resize + re-encode for the homepage staging tool's download button and resolution menu** (`public/scripts/app/download-menu.js`). That UI used to resize entirely on `<canvas>` and export straight to JPEG, which meant nothing it produced could ever carry the invisible provenance metadata below — a browser canvas export has no concept of EXIF/XMP passthrough, regardless of what the server wrote into the source bytes. **Auth:** any signed-in session (free or Pro) — same level as `/api/process-image`, **not** `requireProAccount`. **Body (JSON):** `image` (the current after-result, data URL, ≤16 MB decoded), `width`, `height` (positive integers, capped at `2 × DELIVERY_MAX_EDGE` = 8192px). Resizes with `fit: 'fill'` (an exact stretch — the caller's own row math is what keeps the aspect ratio correct) and embeds the same provenance metadata as `/api/stamp-image` (mode `'staged'`). **Success:** `{ success, image }`, a `data:image/jpeg;base64,...` URL, quality 92. **Client fails OPEN on any error from this route** — falls back to the old client-side canvas export, so a hiccup here costs one download its metadata, never the download itself. **Limiter:** `downloadResultLimiter` (`RL_DOWNLOAD_RESULT`, 60 / 15 min). |

### Disclosure & provenance metadata

Staged output carries disclosure at two independent layers, and only the first is a
compliance requirement — see [`architecture.md`](../guides/architecture.md) for the
broader staging pipeline this fits into:

- **Visible pixel badge** (`lib/image/stamp-disclosure.js`) — the "Virtually staged"
  label burned into the image itself, for MLS/NAR Article 12 disclosure. This is the
  load-bearing layer: it **fails closed** (an image that cannot be labelled is not
  delivered) and is what `/api/process-image`, `/api/enhance-exterior`,
  `/api/masking-studio/save`, and `/api/stamp-image` all apply when the user has the
  "Label as virtually staged" option on.
- **Invisible EXIF/XMP provenance metadata** (`lib/image/output-metadata.js`) — Stagify
  `Software`/`ImageDescription`/`Artist` EXIF tags plus an XMP packet carrying IPTC's
  `Iptc4xmpExt:DigitalSourceType = .../compositeSynthetic` code (the field platforms and
  DAM tools check for AI/synthetic imagery). Applied **unconditionally** to every real
  staged output — independent of the visible badge's on/off toggle, since invisible
  metadata is provenance, not an appearance choice — at the delivery encode
  (`upscaleForDelivery`), gallery persistence (`render-persistence.js`'s `after`/`thumb`
  roles only — never `before` or reference photos, which are not AI-generated), and both
  `/api/stamp-image` and `/api/download-result`. **Best-effort, not load-bearing**: it is
  trivially stripped by a re-save or most social platforms' upload pipelines, and a
  failure to embed it never blocks delivery of the image. Not carried by every path —
  see the code comments in `download-menu.js` and `mask-core.js` for the client-composited
  cases (badge-off Basic Mask / Masking Studio / AI Designer mask-editor downloads) where
  no server round trip happens at all.

**Room types.** `roomType` is a free-text string, but only the keys in
[`lib/staging/promptMatrix.js`](../../lib/staging/promptMatrix.js) select a tailored
prompt — currently **`Bedroom`, `Living room`, `Dining room`, `Kitchen`, `Office`,
`Bathroom`, `Outdoors`, `Dorm`**. The value is **case- and space-sensitive** and is *not*
localized: clients send the English key regardless of UI language. Anything unrecognized
(including the AI Designer's `Other`) falls back to a generic
`Stage this <roomType> professionally.` prompt rather than erroring. Default when the
field is omitted: **`Living room`**. `Dorm` additionally applies fixed-furniture and
small-room-scale constraints — see
[`architecture.md`](../guides/architecture.md#staging-prompt-assembly).

**`POST /api/stage-by-endpoint-key` field reference (multipart):**

| Field | Notes |
|--------|--------|
| `image` | **Required.** One JPEG/JPG/PNG/WebP, same as public staging. |
| `roomType`, `furnitureStyle`, `additionalPrompt`, `removeFurniture` | Same defaults and meaning as `/api/process-image` (see **Room types** above; `roomType` defaults to `Living room`). |
| `userRole`, `userReferralSource`, `userEmail` | Optional analytics strings (default `unknown`). |
| `model` | `gpt-4o-mini` or `gpt-5-mini` (invalid values fall back to `gpt-4o-mini`). |
| `variationCount` | String or number `1`–`3`. |
| `furnitureImage` | Up to **5** files (same as Stagify+). |

Example: `POST https://your-host/api/stage-by-endpoint-key` with header `X-Stagify-Endpoint-Key: YOUR_SECRET` and a `multipart/form-data` body (do not put the secret in client-side browser code, and never in the URL).

---

## Gallery (the owner's saved renders)

All authenticated via the session (`getAuthUserFromRequest` **inside** each handler, the
house pattern — a route's middleware chain does not tell you whether it is gated).
Ownership is keyed on the **validated session id**, never on a request body, and every
"not yours" answers the same `404` as "does not exist" so the surface cannot be used to
probe which render ids are real. Limiter: `galleryLimiter` (120 / 15 min / IP), imported
directly rather than taken from the dep bag.

Every response under `/api/gallery` carries **`Cache-Control: no-store`** and
**`Referrer-Policy: no-referrer`** (`setSensitiveHeaders`, applied by a path-scoped
`router.use` so the `401` and `404` get them too). The bodies contain presigned R2 URLs
and live `/s/<token>` links — bearer credentials that happen to live in a URL — so they
must not be held by an intermediary or replayed from the back/forward cache.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/gallery` | The caller's saved renders, newest first. `?offset=` pages by 60 — **floored, clamped to `MAX_OFFSET` (100 000) and forgiving**: a fractional, negative, non-numeric or repeated value lands on the first page rather than 400ing, and the response echoes the offset actually applied. (Anything less was a `500`: better-sqlite3 binds `LIMIT ? OFFSET ?` directly and rejects a non-integer from inside the statement.) The page size is the server's alone — no `limit` parameter is read. Each entry carries the room type, style, the **prompt that produced it**, the owner's `name` for it (`''` when unnamed — see below), short-TTL **presigned URLs** for `after` / `before` / `thumb` — bytes come straight from R2, never through this process — and `share.url`, the render's client link. Returns `{ entries, total, offset, pageSize, enabled, urlTtlMs, search }`. **`?q=` searches (Stagify+ only — see below).** **`enabled: false`** with an empty list when the object store is unconfigured (the gallery is off on Render without R2) — a `200`, not a `500`, so the page can explain itself. `401` `AUTH_REQUIRED` when signed out. |
| `DELETE` | `/api/gallery/:id` | Delete one entry, and **the only way to take a link down**: it tombstones the bytes, so any outstanding presigned URL starts 404ing as soon as the reaper runs. `404` if the render is not the caller's. |
| `PATCH` | `/api/gallery/:id` | Name one render. **Body:** `{ name: string }` — required and required to be a *string*; anything else is a `400` `INVALID_NAME` rather than a silent clear. `name: ""` is a **reset**, storing `NULL` so the page goes back to deriving the default. The store trims, collapses whitespace, strips control characters and clamps to **80 code points**, and the response returns `{ success, name }` with what was actually **stored** — not what was submitted. `404` if the render is not the caller's, or has been evicted. |
| `PATCH` | `/api/gallery/:id/share` | Edit a link's presentation **without rotating it** — an agent fixing a typo in their own phone number must not invalidate the link they already sent. **Body:** `{ settings?: { headline, note, agentName, agentEmail, agentPhone, showBefore } }` — an allowlist, unknown keys are dropped. `showBefore` (default `false`, strict boolean) is what puts the source photo on the shared page; the rest have no UI yet. **Send the whole bag, not a delta:** the store rebuilds settings from what arrives, so an omitted key is a reset. |

> **A share link is not created and cannot be switched off.** Every finished render has
> one for its lifetime, minted by `GET /api/gallery` (`shares.ensureForRenders`, one
> transaction per page) and carried on the entry, so the panel copies a URL it already
> holds instead of round-tripping for it. That is why a GET here writes. `POST` and
> `DELETE /api/gallery/:id/share` — mint and revoke — were removed with the buttons that
> called them. `listForUser` returns finished renders only, so nothing is minted for bytes
> that never landed, which is the bar the old `POST` enforced with `status !== 'ok'`.

> **Searching is a Stagify+ feature, and the SERVER is the gate.** `?q=` on the listing is
> honoured only when `user.plan === 'pro'`; for a free account it is **dropped, not
> refused** — the listing itself is theirs, and a `403` for a parameter they cannot see on
> screen would be a worse answer than their own gallery. Either way the response carries
> `search: { enabled, q }`: `enabled` is what reveals the box on the page (never a
> client-side plan check, so the box cannot be offered for a filter the server will ignore),
> and `q` echoes what was actually **applied** — `''` for a free caller who sent one anyway.
> `total` is the **matching** count while a search is on, so the count line above the grid
> cannot contradict the tiles under it.
>
> Matching runs in **SQL, not over the loaded page** — the route pages at 60 and a Pro
> gallery is uncapped, so a client-side filter would only ever look at the first screenful
> of a set with no upper bound. The query
> is split on whitespace and every term must appear somewhere in `custom_name`, `room_type`,
> `furniture_style` or `additional_prompt`, **joined** — that concatenation is what makes the
> *derived* default name searchable, since neither column on its own contains "Luxury
> Bedroom". `%` and `_` are escaped, so punctuation is literal rather than a wildcard.
> Bounded at **80 characters and 8 terms** (each term is another `LIKE` in the `WHERE`).
> Case-insensitivity is SQLite's own `LIKE`, i.e. **ASCII-only** — a Cyrillic or Greek name
> matches case-sensitively.

> **A render's name is derived, not stored, until somebody types one.** `staged_renders`
> has a nullable `custom_name`; `shapeEntry` publishes it as `name` and does **not**
> substitute a default. The page builds `<Style> <Room type>` — "Luxury Bedroom" — from
> `furnitureStyle` and `roomType` at render time (`defaultName()` in
> `public/scripts/gallery/view.js`), so changing that wording re-labels every unnamed
> render rather than only the ones staged afterwards. The name is also **owner-only**: the
> public share page has its own `settings.headline`, and folding the two together would
> publish whatever private note a render was filed under to whoever holds the link.

## Client share links (public, no account)

The only unauthenticated read surface the gallery has. **The token in the path is the
entire credential**, which is why it is hashed at rest, returned once, and why the page
sets `Referrer-Policy: no-referrer` (an outbound click or third-party image load would
otherwise mail the live credential to a stranger in a `Referer` header). Limiter:
`shareLimiter` (60 / 15 min / IP) — it can be tight because one viewer costs one request
no matter how many images they scroll.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/s/:token` | The share page shell. **Performs no lookup at all**, so the response is byte-identical for a real token and an invented one — not because the comparison is careful, but because there is no comparison. Headers: `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, `Cache-Control: private, no-store`. |
| `GET` | `/api/share/:token` | The manifest: headline, note, agent card, the staged image as a **presigned R2 URL** (plus `beforeUrl`, the source photo, only when the owner opted in — see below), the MLS/NAR disclosure, and what the photo is — `name` (the owner's own label, so the page heads itself with the same title their gallery shows), `roomType`, `furnitureStyle` and `stagedAt`. The **prompt** behind the render stays out. **One identical `404`** — same status, body *and* headers — for unknown, revoked, expired, cross-tenant, deleted and not-yet-uploaded. A caller who could tell "revoked" from "never existed" would have learned that a token was once real. Counts a view, debounced to once per 30 min. |

> ⚠️ **A takedown is eventual for bytes.** Deleting the entry stops the manifest at once,
> but a presigned image URL already handed out keeps working until it expires (≤15 min).
> UI copy must say *"within 15 minutes"*, never *"immediately"*. It is still the hard
> option — a presigned URL to a deleted object 404s however valid its signature is.
>
> The source ("before") photo is published **only when the render's owner has ticked
> "include the before photo"**, and never by default. It used to be withheld
> unconditionally; the recipient is usually the seller whose empty room it is, so the pair
> is now offerable — behind `settings.showBefore`, which is a strict `true` (nothing merely
> truthy publishes a house) and which `buildManifest` checks *before* it looks the blob up,
> so the default path has no URL to leak. The frame carries `beforeUrl: ''` when the owner
> has not opted in **or** the entry has no source blob, and the page draws the staged image
> alone rather than half a slider. The source photo's **filename** is still never published
> — listing photos are named for the property address.

`GET /api/object/*` also exists in **dev and CI only**, mounted solely when the local
object backend is active; in production nothing serves render bytes from this process.

---

## Contact, email, and public counters

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/log-contact` | **Body:** JSON with `userRole`, `referralSource`, `email`, `userAgent` (and similar). Appends a row to `contact_logs.csv` and bumps an in-memory contact counter. Returns `{ success: true }`. |
| `POST` | `/api/send-email` | **Protected by server access key:** the **`X-Stagify-Endpoint-Key` header** must match `endpointkey.txt` or `process.env.endpoint_key` (`LOGS_ACCESS_KEY`), compared in constant time (a key in `?key=`/`body.key` is refused — it would leak via access logs, proxies, browser history, and `Referer`). **Body:** `to`, `subject`, `text` (Resend). Returns `403` if key wrong/missing, `500` if no Resend, etc. |
| `GET` | `/api/health` | **Public.** `{ status, timestamp, aiConfigured: boolean }` (and similar). Also registered as `GET /health` (same handler). |
| `GET` | `/api/status` | **Public.** Uptime/status snapshot for the `/status` page. `Cache-Control: no-store`. Returns `{ status, currentState, monitoringSince, lastBeat, lastCheckedMsAgo, bootCount, windows: { '24h','7d','30d': { uptimePct, downMs, monitoredMs, coverage, incidents } }, buckets: { '24h'(48), '7d'(56): [{ start, end, state, uptimePct }] }, incidents: [{ start, end, durationMs, cause, source, ongoing, affectsUptime }], totalIncidents }`. Computed by `lib/data/uptime-monitor.js` from a heartbeat written every 60s to the `uptime_state` row in `auth-store.db`; downtime is inferred from heartbeat gaps detected on restart, **plus** any incident an operator posted from the admin console (`source: 'manual'`, and `ongoing: true` while unresolved — see [`admin-dashboard.md`](../guides/admin-dashboard.md#server-status-tab)). An unresolved posted outage sets `currentState: 'down'`, so the public banner reports the disruption. `uptimePct` is `null` for a window with no monitored coverage yet. |
| `GET` | `/api/prompt-count` | Returns `{ promptCount }` (server-side counter, used for hero “Rooms staged” type stats). In-memory, **seeded at boot** by counting the records in `prompt_logs.csv` — see [`data-stores.md`](data-stores.md#csv-logs-append-only). |
| `GET` | `/api/contact-count` | Returns `{ contactCount, userCount, usersServed }` where `usersServed = contactCount + registered user count` (the hero "users served" stat). Under `STATS_DEBUG` returns only `{ usersServed: DEBUG_USERS }`. |

---

## AI Designer (chat, welcome, files)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/welcome-message` | **Auth:** **`requireProAccount`** — the session token **must** arrive as `Authorization: Bearer`; `getAuthUserFromRequest` never reads `req.query`, so a `?authToken=` always 401s (this endpoint was dead in production for exactly that reason). **No query params** — memories are keyed on the validated session account, not a client-supplied `userId`. Returns `{ message, isReturning }` for the AI Designer welcome, using optional stored “memories”. |
| `POST` | `/api/chat` | **Auth:** **`requireProAccount`**. **Body:** JSON with `messages` (OpenAI-style array), optional `model`, `messageTag`. Long-running: staging/CAD/generation inside JSON tool contract. Respects user message limits (e.g. 20 user messages) and may return `contextLimitReached`. When the model routes a staging request it must pick `roomType` from a **fixed enum** (`DESIGNER_ROUTING_SCHEMA` in `lib/staging/prompts.js`): every room type in **Room types** above, plus `Other` for a room with no template. A room type missing from that enum is unreachable from chat — the model falls back to `Other` and the generic prompt. |
| `POST` | `/api/chat-upload` | **Auth:** **`requireProAccount`**. **Multipart:** up to **5** files in field `files`, plus form fields (e.g. `conversationHistory`, `messageTag`). AI Designer flow with file attachments. Implemented in `routes/chat.js`. **PDFs never reach the server as PDFs** — see the floor-plan note below. |

### Floor plans: the `cad` routing branch

Both chat endpoints can route a turn to the **floor-plan renderer** (`cad` in
`DESIGNER_ROUTING_SCHEMA`) instead of ordinary staging. It produces **two different
things**, and which one is not inferred from the image — it is the model's `view` field:

| `view` | Output | `room` |
|--------|--------|--------|
| `top-down` *(default)* | A furnished 3D floor plan seen from directly above — the whole plan in frame, every room at once. | `null` |
| `eye-level` | A photorealistic interior photograph taken standing **inside one room** of that plan. | **Required** — the room to stand in. |

Notes that bite:

- **The default lives at the consumer** (`normalizeCadView` in `lib/staging/cad-handling.js`),
  not in the schema. A routing decision made before `view` existed — or one naming a view
  that does not exist — renders `top-down` rather than failing on a field the user never saw.
- **The schema is strict** (`additionalProperties: false`, every property also in
  `required`). A property added to `cad.properties` but not to `cad.required` makes OpenAI
  reject the whole request, which surfaces as the Designer failing on *every* turn. Pinned
  by a drift guard in `test/staging/prompts.test.js`.
- **Aspect ratio differs by view and that is deliberate.** `top-down` pins to the
  blueprint's own ratio; `eye-level` pins to `3:2`. Pinning a room photo to the plan's
  ratio would return a tall skinny "interior shot" for a tall skinny plan.
- **Disclosure is not fully the model's call.** An `eye-level` render is a furnished
  depiction of a real listing, so it is **always** stamped; a `top-down` plan render is a
  diagram, so there the routing model's `disclosure` decision stands.
- **PDFs are rasterized in the browser**, by `public/scripts/pdf-page-to-image.js`, before
  upload. The server has never been able to read a PDF: `lib/chat/chat-upload-prep.js`
  accepts `application/pdf` and reduces it to the placeholder text `[File: … Content
  cannot be directly read]`. Page 1 only.
- **The reply always carries `cadViews`** (one entry per render), unlike `cadParams`, which
  is set only in the multi-result branch. The browser needs it to describe the image: the
  two views take different alt text (`pdf.alt.cadRender` vs `pdf.alt.cadRenderInterior`),
  and for a lone render there was otherwise nothing on the wire to tell them apart.
- **CAD has its own status category**, `floorplan` (`chatIntentType`), not `staging`. It is
  checked first, so a turn doing both reports the floor-plan work — that is the half the
  user waits on (~30s on `gemini-3-pro-image` against ~8s for a staged photo).
- Max **3** `cad` entries per turn, same cap as staging and generate. All three dispatch
  steps run **unconditionally** (`lib/chat/chat-post-routing.js`), so one response can
  legitimately carry `stagedImages`, `generatedImages` **and** `cadImages` together.

---

## Bug reports & masking studio (mask edit + segment)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/bug-report` | **Body:** `description` (required), and optional `steps`, `email`, `userId`, `userAgent`, `url`, `timestamp`, `conversationHistory`. Appends to `bug_reports.csv`. Unauthenticated and writing to the volume the SQLite DB lives on, so every field is clamped (`lib/http/bug-report-row.js`), only a **count** of any images in `conversationHistory` is stored, the body keeps the 1 MB limit, and the route answers `503` once the CSV reaches `BUG_REPORT_LOG_MAX_BYTES`. |
| `POST` | `/api/mask-edit` | **Auth:** **`requireProAccount`**. **Body (JSON):** `image` and `mask` as data URLs, `prompt`, optional `model`, `referenceImage`, `seed`. Uses Gemini for the region edit; returns `{ success, editedImage }` (data URL) or `4xx/500` errors. Every area gets the **same** quality-retry budget: `batch` used to be accepted as a fan-out hint that trimmed the budget from `QUALITY_MAX_ATTEMPTS` to 2 for 3+ areas, which made a paid feature quietly worse the harder it was used. The field is ignored now, and a test pins that a stale client sending it cannot reintroduce the downgrade. |
| `POST` | `/api/segment` | **Auth:** **`requireProAccount`**. **Body (JSON):** `image` (data URL) + optional `query` (target a specific object; omitted → detect all movable objects in the room). Runs Gemini object detection for the Masking Studio "magic wand" and returns `{ success, items: [{ box_2d, label }] }` (boxes normalized 0–1000). `400` if no image, `500` if AI not configured. |
| `POST` | `/api/masking-studio/save` | **The Masking Studio's "Looks Good" → a gallery entry.** **Auth:** **`requireProAccount`**. The only gallery writer that generates nothing — the composite is made on a canvas in the browser and posted back, which is why it exists at all. **Body (JSON):** `after` (required data URL, the composite), `before` (optional data URL, the pristine original), `areas`, `prompts[]`, `sourceName`. **One outcome: every save INSERTS** a new entry named `Masking Studio — N areas`. There used to be a second, **replace-in-place**, taken when the studio had been opened on one of the owner's existing renders via "Refine in Masking Studio"; that hand-off was removed from the product, so no `renderId` can reach this handler and the branch, `replaceInBackground` and `replaceResult` all went with it. Do not reintroduce one without the other. **No metering:** the generations were already billed at `/api/mask-edit`, one per painted area. **Limiters:** `galleryImportLimiter` (20 / 15 min, `RL_GALLERY_IMPORT`) **and** `genLimiter` — the dedicated one because this is the only endpoint that accepts megabytes of client pixels and PUTs them to object storage with no model call in between to brake it. **Body size:** registered in `JSON_LARGE_LIMIT_PATHS`; without that it 413s before the handler runs. **Success:** `{ success, gallery }`, where `gallery` is `null` on a deployment with no object store. |

---

## Public developer API (`/api/v1/*`, API key + prepaid credits)

The only customer-facing machine interface. Authenticated by a per-account **API key**
(`Authorization: Bearer stg_live_…`, header only — never a query parameter), and paid for
with **prepaid credits**: one credit per delivered image, $0.15 at the smallest pack.

Three properties are worth knowing before reading the table:

* **A caller with no credits is refused before any model call.** The debit is a
  conditional `UPDATE … WHERE balance >= cost` (`lib/data/api-billing.js`), so the 402 is
  answered without spending a Gemini request. A limit that can be raced is not a limit.
* **A failed render is refunded, automatically and idempotently.** The band in
  `lib/staging/api-render-billing.js` settles from *two* paths — a `try/catch` and
  `res.on('finish')` — because `handleVirtualStagingMultipart` answers some errors
  in-band. Both route into one refund guarded by a status transition, so a double call
  changes nothing.
* **One credit is one generation.** The API passes `skipQualityReview: true`, so the
  quality-gate retry loop that can turn one delivered image into three model calls on the
  web tier does not run here. That is what makes $0.15 an honest price on this path and
  the reason it must not be "helpfully" re-enabled.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/v1/renders` | multipart. Same field names as `/api/process-image`. `variations` accepts only `1`. Honours `Idempotency-Key`. |
| GET | `/api/v1/options` | **No API key.** The accepted values for `roomType`, `furnitureStyle` and the stamp fields, derived from the renderer's own tables. |
| GET | `/api/v1/renders/:id` | Owner-scoped status. A stranger's id and a nonexistent id both 404 — not an oracle. |
| GET | `/api/v1/credits` | Balance and lifetime totals. |
| GET | `/api/v1/me` | The cheap "is my key working" call. |

Chain on the render route, in order: `apiRenderLimiter` → `requireApiKey` →
`concurrencyGate` → `stagingProcessUpload` → handler. Multer is **last** so 25MB is never
buffered for a caller who was going to be refused anyway.

`/api/v1/*` is deliberately **not** in `ALLOWED_ORIGINS`: it sends no CORS headers because
a key reachable from browser JavaScript is a leaked key.

`GET /api/v1/options` is the one route here with **no** `requireApiKey`. An integrator
needs the vocabulary while deciding whether to buy credits, which is before they have a
key to send, and `public/developers.html` renders against it as an anonymous visitor.
Nothing in the body is account-specific. It is still rate-limited.

Why it exists at all: every enum on the render route **fails soft**. An unrecognised
`furnitureStyle` silently resolves to `standard`, and an unrecognised `roomType` is not
rejected but interpolated into the prompt as free text — so a typo costs a credit and
returns a plausible-but-wrong image with a 200. A browser user picks from a dropdown and
cannot make that mistake; an API caller has nothing but the docs. `lib/staging/api-options.js`
derives every list from `promptMatrix` / `stamp-disclosure.js` / `locales.js` rather than
restating them, and `test/staging/api-options.test.js` plus
`test/frontend/developers-parameter-table.test.js` fail the build if the endpoint, the
docs table, or the quickstart curl drift from those tables.

**One credit is one image, enforced in `lib/staging/api-render-billing.js`.** The router
answers 400 `VARIATIONS_UNSUPPORTED` for `variations` *and* `variationCount`, and the
billing band then pins `variationCount` and strips `model` regardless. Both are needed:
the handler reads `variationCount`, not the documented `variations`, and `treatAsPro: true`
disables the `if (!isPro) variationCount = 1` demotion that would otherwise have caught it.
`model` is dropped silently rather than refused by name, because refusing it advertises a
parameter that is never going to be supported.

Error codes: `API_KEY_MISSING` / `API_KEY_INVALID` / `API_KEY_REVOKED` (401),
`INSUFFICIENT_CREDITS` (402, carries `credits_remaining`), `ACCOUNT_SUSPENDED` (403),
`VARIATIONS_UNSUPPORTED` (400), `REQUEST_IN_FLIGHT` / `CONCURRENCY_LIMIT` (409),
`IDEMPOTENCY_KEY_REUSED` / `NO_IMAGE_GENERATED` (422), `RATE_LIMITED` (429),
`DISCLOSURE_STAMP_FAILED` / `RENDER_FAILED` (500). The last four refund.

### Account surface (session auth) — `routes/api-keys.js`

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/api-keys` | List. Never carries a key, only the display prefix. |
| POST | `/api/api-keys` | Mint. **The only response in the product that ever contains a plaintext key.** |
| DELETE | `/api/api-keys/:id` | Revoke. Another account's id → 404. |
| PATCH | `/api/api-keys/:id` | Rename. |
| GET | `/api/api-credits` | Balance, lifetime totals, live key count, last 50 ledger rows. |
| GET | `/api/api-credits/packs` | Public pricing. Carries no Stripe price ids. |
| POST | `/api/api-credits/checkout` | Stripe Checkout in `payment` mode → `{ url }`. |

Credits arrive through the existing webhook: a paid one-time session carrying
`metadata.stagify_api_pack` is dispatched into `lib/services/stripe-credit-topup.js`,
which verifies `amount_total` against our own pack table before crediting anything.
`charge.refunded` / `charge.dispute.created` claw the credits back and suspend the account
on a shortfall — without that, spend-then-chargeback is a free render.

## Log download / admin (header key)

These routes use **`protectLogs`**: a shared secret `LOGS_ACCESS_KEY` from `endpointkey.txt` or `process.env.endpoint_key`, supplied in the **`X-Stagify-Endpoint-Key` header** — **never** the query string (a key in the URL leaks via access logs, proxies, browser history, and `Referer`). **If the server has no key configured:** `500`. **If the header is missing/invalid:** `403`.

`protectLogs` — and *only* `protectLogs` — also accepts an admin-console **session token** in the `X-Stagify-Admin-Session` header (`POST /api/admin/session` above). It is header-only for the same reason the key is, so these routes stay unreachable by anything a browser sends on its own. The token does **not** open `/api/stage-by-endpoint-key`, `POST /api/getpro` or `POST /api/send-email`: those compare the key itself.

The same `LOGS_ACCESS_KEY` authenticates several endpoints. All of them now take it via the **same** transport — the `X-Stagify-Endpoint-Key` header, compared in constant time; a key in `?key=`/`body.key` is refused (it would leak via access logs, proxies, browser history, and `Referer`):

- **`protectLogs`** routes below, **`POST /api/getpro`**, **`POST /api/stage-by-endpoint-key`**, and **`POST /api/send-email`** — `X-Stagify-Endpoint-Key` header **only**.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/admin/ping` | `{ ok: true }`. No payload, but still gated — it is an oracle for the admin credential. The console calls it on load to check a stored session token before revealing the dashboard. |
| `POST` | `/api/admin/session` | Exchange `endpoint_key` for a console session: `{ token, expiresAt }`, 30 days, sliding. **Key-only** (`requireEndpointKey`) — a session token cannot mint another, or revoking one would be meaningless. `503` if the store is unavailable. See [`lib/data/admin-sessions.js`](../../lib/data/admin-sessions.js). |
| `DELETE` | `/api/admin/session` | Sign out: revokes the token in the `X-Stagify-Admin-Session` header. Body `{ all: true }` (with the key) revokes **every** session — the lost-laptop lever. Returns `{ ok, revoked }`; an unknown token is `revoked: 0`, not an error. |
| `GET` | `/api/admin/status` | The admin server-status snapshot: everything `/api/status` returns, plus the 30-day graph, the operator-posted entries as their own list, and the monitor's configuration. Separate from the public route because that one is polled by every visitor to `/status`. `Cache-Control: no-store`. |
| `POST` | `/api/admin/incidents` | Post an incident by hand: `{ title, start?, end?, affectsUptime }` → `201 { incident }`. `end` omitted means **ongoing**; `affectsUptime` decides whether it moves the uptime percentages. It appears in **Recent incidents** on the public status page. A `400` carries a message written for the operator. See [`admin-dashboard.md`](../guides/admin-dashboard.md#server-status-tab). |
| `POST` | `/api/admin/incidents/:id/resolve` | Close an ongoing incident at now. `404` if unknown. |
| `DELETE` | `/api/admin/incidents/:id` | Delete a posted incident — it leaves the public page immediately. `404` if unknown. |
| `GET` | `/authstore` | Live **redacted** user list (`{ users: [...] }`) via `exportRedacted()`, streamed as `auth-store.json`. Carries only the fields the dashboard renders — id, email, plan, createdAt, usage, `googleSub`, Stripe ids, grant timestamps, plus the trial fields `lifetimeStaged`, `lastStagedAt` and a **projected** `trialLifecycle` (`{ startAt, sent: { welcome, activation, value, ending, canceled } }`). Still sensitive (every customer email), hence the key. **It deliberately does NOT carry credentials.** `exportRedacted` uses an *allowlist*, so a new field added to `extra_json` is withheld until someone adds it there on purpose — and `trialLifecycle` is projected key-by-key rather than listed in that allowlist, so anything a future feature parks *inside the bag* is withheld too. |
| `GET` | `/promptlogs` | Download `prompt_logs.csv` (or `404` if missing). |
| `GET` | `/contactlogs` | Download `contact_logs.csv`. |
| `GET` | `/chatlogs` | Download `chat_logs.csv`. |
| `GET` | `/bugreports` | Download `bug_reports.csv`. |
| `GET` | `/masklogs` | Download `mask_logs.csv`. |
| `GET` | `/rejectionlogs` | Download `rejection_logs.csv` — requests turned away **before** any render: refused uploads (`unstageable`), free accounts at their daily cap (`daily_limit`), and callers that hit a rate limiter (`rate_limit`). Its own file, not rows in `prompt_logs.csv`, because the dashboard counts every prompt-log row as a generation. |
| `GET` | `/email-open-logs` | Download `email_open_logs.csv` (email open-tracking rows; `404` if none yet). |
| `GET` | `/enterprise-domains` | Download `enterprise-domains.json` (active enterprise domains + Stripe ids); `{ domains: [] }` if none yet. |
| `POST` | `/api/admin/grant-plus` | **Comp Stagify+.** Body `{ userId }` or `{ email }`. Gives a **currently-free** account one calendar month of `plan: 'pro'` with **no Stripe subscription** — no card, no invoice, no webhook (`lib/data/pro-grants.js`). Refused (`400`) if the account already has Stagify+ or has a Stripe subscription. Returns `{ ok, userId, email, expiresAt }`. Expiry is enforced on **read**, so the account reverts to free by itself. |
| `POST` | `/api/admin/delete-user` | **GDPR erasure.** Body `{ userId }` or `{ email }`, plus optional `force: true`. Erases the account row and **everything keyed to it** — sessions, password-reset tokens, memories, and a pending registration for the same address — in one transaction (this DB has no foreign keys, so nothing cascades on its own), then redacts that person's identifying cells in the CSV logs. An address with only an unverified signup can be erased on its own. **Refused with `400 ACTIVE_SUBSCRIPTION`** if a Stripe subscription is still attached — cancel it in Stripe first, or pass `force` once that is done out of band. `404 NOT_FOUND` for an unknown account, `400` with no identifier. Returns `{ ok, userId, email, rows, logs }` — per-table row counts and a per-file redaction report. Irreversible; see [`data-stores.md`](data-stores.md#erasing-one-persons-data). |
| `POST` | `/api/admin/revoke-plus` | Body `{ userId }`. Ends a running comp grant immediately. Refused (`400`) if there is no active grant, or if the account is on a Stripe subscription (cancel that in Stripe). |
| `GET` | `/api/admin/renders` | `?userId=&limit=&offset=` → `{ enabled, total, limit, offset, entries[] }`. One account’s renders for the operator console, **including** the failed, pending and evicted rows the owner’s gallery filters out. Entries carry `source` / `sourceName` (which surface made the render — `api` is how the paid API is told apart from studio usage) and short-lived presigned URLs, so the response is `no-store`; an evicted row gets empty URLs. `{ enabled: false }` when no object store is configured — that is a deployment without a gallery, not an error. `storage_key` and `user_id` are never serialized. |
| `POST` | `/api/admin/revoke-sessions` | Body `{ userId }` → `{ ok, userId, email, revoked }`. Drops every live session for one account — “sign out everywhere”. The password is **not** changed and a live password-reset token is **not** invalidated. `404` for an unknown account. `revoked` may legitimately be `0`. |
| `GET` | `/api/admin/metrics` | **Signals tab.** Read-only SQL aggregates over the shared database — renders by source/status keyed on a **real `user_id`** (unlike the render log’s `email`, which is `unknown` whenever the client did not send one), storage bytes per account, share-link engagement, session and pending-registration counts, Stripe/reaper queue health, and CSV log sizes. Every window is a **duration**, never a calendar day — day keys are local to the reader and the server cannot know that timezone. Fails **open**: an unconfigured reader answers `200 {metrics: null}` so the tab degrades to its browser-computed half. Statements are prepared once at factory time; see the N+1 guard in `test/analytics/admin-metrics.test.js`. |
| `POST` | `/api/admin/brief` | **Signals tab.** Body `{ findings }` — the **finished** findings the browser already computed, never raw log rows. Returns `{ summary }`, two to four sentences restating them. The payload is projected through an allowlist and scrubbed of anything email- or IP-shaped before a model sees it ([`lib/services/admin-brief.js`](../../lib/services/admin-brief.js)), so account names never leave the browser. `temperature: 0`, capped output, body capped at 256kb, and `protectLogs` runs **before** the body parser. Never 500s: no key, a timeout or an empty completion all return `200 {summary: null, reason}`. |
| `GET` | `/api/admin/email-previews` | **Emails tab gallery.** Returns `{ emails: [{ id, label, category, description, subject, html, text }] }` — every user-facing email, built from the same renderers the senders use ([`lib/services/email-catalog.js`](../../lib/services/email-catalog.js)). Read-only; nothing is sent. |
| `GET` | `/api/admin/referrals` | **Referrals tab.** `{ days, links: […] }` — every campaign link (active first) with lifetime `clicks`, `botHits`, `windowClicks`, `last7`, `firstClickAt`/`lastClickAt`, a zero-filled daily `series`, and its top `referrers`. `?days=` (clamped 7–365, default 30) sizes the series and the windowed figure only; lifetime totals ignore it. |
| `POST` | `/api/admin/referrals` | Create a link. Body `{ slug, label, note? }`. `slug` is lowercased/trimmed and must be 2–31 chars of `[a-z0-9-]` starting and ending alphanumeric. Returns `{ ok, link }`; the link resolves **immediately**, with no deploy. `400` `SLUG_INVALID` / `LABEL_REQUIRED`; `409` `SLUG_TAKEN` (including a retired link — it still owns its URL) or `SLUG_RESERVED` (the slug is a real page, locale prefix or route root; such a link would never fire). Each rejection's `error` is operator-facing prose and the dashboard shows it verbatim. |
| `POST` | `/api/admin/referrals/:slug/deactivate` | **Retire.** The URL stops resolving at once (`404`), but the row and its clicks stay on the dashboard. Returns `{ ok, link }`; `404` for an unknown slug. |
| `POST` | `/api/admin/referrals/:slug/activate` | Put a retired link back into service; clears its retirement stamp. |
| `DELETE` | `/api/admin/referrals/:slug` | **Irreversible.** Drops the link and every hit it recorded, in one transaction. Returns `{ ok, slug, hitsDeleted }` so the caller can report what was destroyed. The dashboard offers this only on an already-retired link, so the destructive action is never the one beside a live campaign. |
| `POST` | `/api/admin/email-test-send` | Body `{ id, email }`. Sends a live `[Test] <subject>` copy of catalog email `id` to `email` (the exact address given — no `EMAIL_DEBUG_MODE` redirect). `400` on a missing/invalid id or email; `503` if Resend is unconfigured. The recipient address is never logged. |
| `GET` | `/memories` | Download AI Designer `memories` JSON. |
| `POST` | `/resetmemories` | **Clears** every user's AI Designer memories. Returns JSON success. **`POST`, not `GET`** — it mutates, so a retried or replayed request must not be able to wipe again; `GET` answers `405` with `Allow: POST` (behind the same key, so an unkeyed caller still just gets `403`). Matches `POST /api/status/reset`. |
| `POST` | `/api/status/reset` | **Wipes** all recorded uptime history, detected incidents **and operator-posted ones**, and restarts monitoring from now, via `uptimeMonitor.reset()` (rewrites the `uptime_state` row in `auth-store.db`). Backs the admin "Reset server status data" button and changes the public `/status` page immediately. Returns `{ success: true, message, snapshot }`. |

`POST` `/api/send-email` uses the **same** `LOGS_ACCESS_KEY` (see above), not only for logs.

---

## Admin dashboard & image hosting

The admin dashboard (`admin.html`) collects the `LOGS_ACCESS_KEY` client-side once, exchanges it for a session token, and calls these image-hosting APIs (and the log exports above) with the `X-Stagify-Admin-Session` header. Hosted images are served publicly at `GET /i/:id` (see Public pages).

**The danger zone.** The same expanded row ends with a danger section ([`public/scripts/admin/danger.js`](../../public/scripts/admin/danger.js)) holding *Sign out everywhere* (`revoke-sessions` above) and *Delete account* (`delete-user`). Deletion is gated on the operator typing the account’s own address — `confirm()` is one mis-click from erasing the wrong row, and there is no undo. The `force` flag that overrides the live-subscription refusal is never sent automatically; it appears as a second, separately-confirmed step carrying the server’s message.

**Comp Stagify+ grants.** In the **Users** tab, expanding a row shows a *Stagify+ Grant* section ([`public/scripts/admin/grant.js`](../../public/scripts/admin/grant.js)) that calls `POST /api/admin/grant-plus` / `revoke-plus` above. It renders one of four states: a free account gets a *Grant 1 month of Stagify+* button; a running grant shows its end date plus *Revoke now*; a Stripe subscriber and an enterprise-covered account are read-only. Nothing here touches Stripe — the grant expires on its own (see [`data-stores.md`](data-stores.md)), so there is no follow-up action to remember.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/admin` | Serves `public/admin.html` (internal dashboard). **No key on the GET** (`200`, `Cache-Control: no-store`); the page collects the admin key client-side. |
| `POST` | `/api/host-image` | **`protectLogs`** (header key). **Multipart:** one image in field `image`. Stores it and returns `{ ok, id, path: '/i/<id>', url, entry }`; the image is then publicly served at `GET /i/:id`. `400` on a bad/missing upload, `500` on save failure. |
| `GET` | `/api/hosted-images` | **`protectLogs`**. Lists hosted images newest-first: `{ images: [{ id, path, mime, size, uploadedAt, … }] }`. |
| `DELETE` | `/api/hosted-images/:id` | **`protectLogs`**. Deletes a hosted image (file + manifest entry). Returns `{ ok: true }`, `400` for an invalid id, `404` if unknown. |

---

## Notes

- **CORS** is enabled globally.
- **JSON body limit** is **1 MB** app-wide; only the four routes that carry base64 images
  (`/api/chat`, `/api/mask-edit`, `/api/segment`, `/api/validate-image`)
  get **25 MB**. Oversized bodies get `400` (bad JSON) / `413` (too large) as JSON.
- **Error shape** is uniform: failures return `{ error }` (plus optional machine-readable
  `code`, a fixed-string `details` hint, and `ref`) via `sendError()`. An unhandled error
  still returns a clean JSON `500` — never a stack-trace page (catch-all in `server.js`).
- **An unmatched path** is content-negotiated, and this is the one place the server answers
  in two formats: `{ "error": "Not found" }` under `/api/*` or when the client does not
  accept HTML, and the branded `public/404.html` page otherwise. Both carry status `404`.
- **`ref` on a 5xx** is an 8-char hex reference to the logged failure
  (`lib/http/error-ref.js`), e.g. `{ "error": "Image processing failed", "ref": "3f9a1c02" }`.
  A caught exception's message is **never** returned — quote the `ref` to support and the
  operator finds the exact log line. `details` carries only fixed strings written in the
  source, never exception text; a build-gating scan enforces that.
- **Trust proxy** can be toggled with `TRUST_PROXY` (for real client IPs behind Render/nginx).

If you add a route, append it to this file so operators can find auth and query requirements quickly.
