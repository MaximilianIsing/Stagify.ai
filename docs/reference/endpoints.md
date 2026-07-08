# Stagify API & server routes

This document describes HTTP endpoints for the Stagify server. Routes are registered across `routes/*.js` (`public.js`, `auth.js`, `billing.js`, `staging.js`, `chat.js`, `admin.js`) and mounted from `server.js`; static files are also served from `public/` (not every path is listed here). Default port: **`process.env.PORT` or `3000`**.

## Authentication helpers (used by several routes)

- **Bearer session:** `Authorization: Bearer <token>` (JWT/session token from `authToken` in login/register responses).
- **Token in body:** `authToken` in JSON or multipart field (e.g. staging).
- **Token in query:** `?authToken=...` (used by some browser flows).

**`getAuthUserFromRequest`:** loads the user from a valid session token (header, body, or query).

**`requireProAccount`:** requires a signed-in user with `plan === 'pro'`; otherwise `401` (`AUTH_REQUIRED`) or `403` (`PRO_REQUIRED`).

---

## Public pages & SEO (no API key)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Serves `public/index.html`. |
| `GET` | `/robots.txt` | Serves `public/robots.txt`. |
| `GET` | `/sitemap.xml` | Serves `public/sitemap.xml`. |
| `GET` | `/status` | Serves `public/status.html` — the public status/uptime page. Client-side it polls `GET /api/status` and draws 24-hour and 7-day availability graphs. |
| `GET` | `/privacy` | Serves `public/privacy.html`. |
| `GET` | `/i/:id` | **Public hosted-image serve.** `:id` is a 16–64-char hex id minted by `POST /api/host-image`. Streams the stored image with `Cache-Control: public, max-age=31536000, immutable` and `X-Content-Type-Options: nosniff`. `404` (plain text) for an invalid or unknown id. |
| `GET` | `/email/logo.png` | Email logo **and open-tracking pixel.** With `?email=<addr>`, logs an email open (only when the request looks like a genuine email-client fetch) to `email_open_logs.csv`, then serves the logo PNG with `Cache-Control: no-store`. |
| `GET` | `/bimi-logo.svg`, `/logo-full.png` | Brand assets served with explicit content types (BIMI SVG and full-logo PNG). |

Other `.html` and assets are served by **`express.static('public')`** (e.g. `/stagify-plus.html`, `/ai-designer.html`).

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
| `POST` | `/api/billing/stripe-webhook` | **Body:** raw JSON (must **not** go through `express.json()`; uses `express.raw`). **Header:** `stripe-signature` for verification. If Stripe is not configured: `503`. Forwards to internal `handleStripeEvent` (subscription lifecycle, etc.). Responds `{ received: true }` on success. |
| `POST` | `/api/billing/customer-portal` | **Auth:** signed-in user with a Stripe customer id. **Body:** JSON (can be empty). Returns `{ url }` to Stripe Billing Portal, or `503` if Stripe off, `401` if not signed in, `400` if no `stripeCustomerId` on the user. |
| `GET` | `/api/enterprise/config` | Public. Returns `{ publishableKey }` (Stripe publishable key) for the enterprise checkout page; `''` if Stripe isn't configured. |
| `POST` | `/api/enterprise/create-checkout` | **Enterprise self-serve checkout** (from `enterprise.html`). **Body (JSON):** `{ domain, companyName, contactEmail, contactPhone? }`. Validates the fields, and creates a Stripe **subscription** Checkout Session for the metered enterprise price (`ENTERPRISE_PRICE_ID`), returning `{ url }` to redirect to. **Errors:** `503` if Stripe or the price id isn't configured, `400` on invalid input, `409` if the domain already has an active/trialing plan. |

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
| `POST` | `/api/auth/reset-password` | **Body:** `{ token, password }`. Completes reset. Returns `{ ok: true }` or `400`. |

---

## Virtual staging (image)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/validate-image` | **Pre-flight stageability check.** **Body (JSON):** `{ image }` — a data URL of the chosen photo (clients downscale to ~1024px first). No auth required (the main stager serves free/anonymous mobile visitors); rate-limited by `genLimiter`. A cheap `gpt-4o-mini` vision pass decides whether the photo is a stageable room/property space. Always returns **`200`** with `{ valid: boolean, reason: string }` — `reason` is a short, user-facing rejection message when `valid` is `false`, else `""`. **Fails OPEN** (`valid: true`) whenever the reviewer is disabled or errors, so it never blocks a legitimate upload. `400` only for a missing/undecodable `image`. Called by the main stager (on upload; hard-gates staging) and the Masking Studio (on upload; blocks entering the editor). |
| `POST` | `/api/process-image` | **Multipart** staging upload (`stagingProcessUpload`). **File:** at least `image` (see multer field names in server). **Typical body fields** (strings): `roomType`, `furnitureStyle`, `additionalPrompt`, `removeFurniture`, `userRole`, `userReferralSource`, `userEmail`, and for pro: `model`, `variationCount`, `furnitureImage` (repeat), `authToken`. **Rules:** (1) Signed-in user: enforces per-account daily free limit for non-pro; on success, may return `user` with updated usage. (2) **Not signed in:** only **mobile** user-agents can use a per-**IP** daily cap (no session); desktop browsers get `401` with `AUTH_REQUIRED`. **Errors:** `429` with `DAILY_LIMIT` + `dailyGenerationsUsed` / `dailyGenerationLimit`, `500` if AI not configured, etc. **Success:** `image` or `images` plus `success: true` and often `user` after consumption. |
| `POST` | `/api/stage-by-endpoint-key` | **Server integration staging** — same multipart shape as `/api/process-image`, but **no user session**. **Auth:** `LOGS_ACCESS_KEY` from `endpointkey.txt` or `process.env.endpoint_key`, passed as **`?key=`** on the request URL **or** header **`X-Stagify-Endpoint-Key`**. Same secret as log CSV exports and `/api/send-email` — **highly sensitive**; treat like a root credential. **Behavior:** Staging runs with **Stagify+-level options** (`model` `gpt-4o-mini` \| `gpt-5-mini`, `variationCount` 1–3, up to three `furnitureImage` files). **Does not** increment per-user or per-IP free-tier daily counters. **Success:** same JSON as process-image (`image` / `images`, `user` is `null`). **`403`** if key missing/wrong, **`500`** if key not configured on server. |

**`POST /api/stage-by-endpoint-key` field reference (multipart):**

| Field | Notes |
|--------|--------|
| `image` | **Required.** One JPEG/JPG/PNG/WebP, same as public staging. |
| `roomType`, `furnitureStyle`, `additionalPrompt`, `removeFurniture` | Same defaults and meaning as `/api/process-image`. |
| `userRole`, `userReferralSource`, `userEmail` | Optional analytics strings (default `unknown`). |
| `model` | `gpt-4o-mini` or `gpt-5-mini` (invalid values fall back to `gpt-4o-mini`). |
| `variationCount` | String or number `1`–`3`. |
| `furnitureImage` | Up to **3** files (same as Stagify+). |

Example URL: `POST https://your-host/api/stage-by-endpoint-key?key=YOUR_SECRET` with `multipart/form-data` body (do not put the secret in client-side browser code).

---

## Contact, email, and public counters

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/log-contact` | **Body:** JSON with `userRole`, `referralSource`, `email`, `userAgent` (and similar). Appends a row to `contact_logs.csv` and bumps an in-memory contact counter. Returns `{ success: true }`. |
| `POST` | `/api/send-email` | **Protected by server access key:** query `?key=` or `body.key` must match `endpointkey.txt` or `process.env.endpoint_key` (`LOGS_ACCESS_KEY`). **Body:** `to`, `subject`, `text` (Resend). Returns `403` if key wrong, `500` if no Resend, etc. |
| `GET` | `/api/health` | **Public.** `{ status, timestamp, aiConfigured: boolean }` (and similar). Also registered as `GET /health` (same handler). |
| `GET` | `/api/status` | **Public.** Uptime/status snapshot for the `/status` page. `Cache-Control: no-store`. Returns `{ status, currentState, monitoringSince, lastBeat, lastCheckedMsAgo, bootCount, windows: { '24h','7d','30d': { uptimePct, downMs, monitoredMs, coverage, incidents } }, buckets: { '24h'(48), '7d'(56): [{ start, end, state, uptimePct }] }, incidents: [{ start, end, durationMs, cause }], totalIncidents }`. Computed by `lib/uptime-monitor.js` from a heartbeat written every 60s to the `uptime_state` row in `auth-store.db`; downtime is inferred from heartbeat gaps detected on restart. `uptimePct` is `null` for a window with no monitored coverage yet. |
| `GET` | `/api/prompt-count` | Returns `{ promptCount }` (server-side counter, used for hero “Rooms staged” type stats). |
| `GET` | `/api/contact-count` | Returns `{ contactCount }` (in-memory + startup initialization). |

---

## PDF (AI Designer proxy)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/pdf-health` | Proxies to external `PDF_PROCESSING_SERVER` `GET /health`, returns that JSON or `500` on failure. |
| `POST` | `/api/process-pdf` | **Auth:** **`requireProAccount`** (Stagify+). **Body:** `multipart/form-data` with file field `pdf`. **Query:** e.g. `skip`, `concurrency`, `dpi`, `continue`, `merge`, `filename`. Proxies to the external PDF pipeline and streams the result (often a PDF download). |

---

## AI Designer (chat, welcome, files)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/welcome-message` | **Auth:** **`requireProAccount`**. **Query (optional):** `userId`. Returns `{ message, isReturning }` for the AI Designer welcome, using optional stored “memories”. |
| `POST` | `/api/chat` | **Auth:** **`requireProAccount`**. **Body:** JSON with `messages` (OpenAI-style array), optional `model`, `messageTag`. Long-running: staging/CAD/generation inside JSON tool contract. Respects user message limits (e.g. 20 user messages) and may return `contextLimitReached`. |
| `POST` | `/api/chat-upload` | **Auth:** **`requireProAccount`**. **Multipart:** up to **5** files in field `files`, plus form fields (e.g. `conversationHistory`, `messageTag`). AI Designer flow with file attachments. Implemented in `routes/chat.js`. |

---

## Bug reports & masking studio (mask edit + segment)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/bug-report` | **Body:** `description` (required), and optional `steps`, `email`, `userId`, `userAgent`, `url`, `timestamp`, `conversationHistory`. Appends to `bug_reports.csv`. |
| `POST` | `/api/mask-edit` | **Auth:** **`requireProAccount`**. **Body (JSON):** `image` and `mask` as data URLs, `prompt`, optional `model`, `referenceImage`, `seed`, `batch`. Uses Gemini for the region edit; returns `{ success, editedImage }` (data URL) or `4xx/500` errors. |
| `POST` | `/api/segment` | **Auth:** **`requireProAccount`**. **Body (JSON):** `image` (data URL) + optional `query` (target a specific object; omitted → detect all movable objects in the room). Runs Gemini object detection for the Masking Studio "magic wand" and returns `{ success, items: [{ box_2d, label }] }` (boxes normalized 0–1000). `400` if no image, `500` if AI not configured. |

---

## Log download / admin (header key)

These routes use **`protectLogs`**: a shared secret `LOGS_ACCESS_KEY` from `endpointkey.txt` or `process.env.endpoint_key`, supplied in the **`X-Stagify-Endpoint-Key` header** — **never** the query string (a key in the URL leaks via access logs, proxies, browser history, and `Referer`). **If the server has no key configured:** `500`. **If the header is missing/invalid:** `403`.

The same `LOGS_ACCESS_KEY` authenticates several endpoints, but each accepts it via a **different transport** — check per route:

- **`protectLogs`** routes below and **`POST /api/getpro`** — `X-Stagify-Endpoint-Key` header **only**.
- **`POST /api/stage-by-endpoint-key`** — `?key=` query **or** `X-Stagify-Endpoint-Key` header.
- **`POST /api/send-email`** — `?key=` query **or** `key` in the JSON body.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/authstore` | Download a live JSON snapshot of the auth store (users, session tokens, password hashes, Stripe ids, etc.), rebuilt from SQLite via `exportStore()` and streamed as `auth-store.json`. **Highly sensitive** — same `X-Stagify-Endpoint-Key` header as other admin exports. Backed by `data/auth-store.db` (or `/data/auth-store.db` on Render); the payload is a valid rollback/re-import shape. |
| `GET` | `/promptlogs` | Download `prompt_logs.csv` (or `404` if missing). |
| `GET` | `/contactlogs` | Download `contact_logs.csv`. |
| `GET` | `/chatlogs` | Download `chat_logs.csv`. |
| `GET` | `/bugreports` | Download `bug_reports.csv`. |
| `GET` | `/masklogs` | Download `mask_logs.csv`. |
| `GET` | `/email-open-logs` | Download `email_open_logs.csv` (email open-tracking rows; `404` if none yet). |
| `GET` | `/enterprise-domains` | Download `enterprise-domains.json` (active enterprise domains + Stripe ids); `{ domains: [] }` if none yet. |
| `GET` | `/memories` | Download AI Designer `memories` JSON. |
| `GET` | `/resetmemories` | **Clears** the memories file (all users). Returns JSON success. |
| `POST` | `/api/status/reset` | **Wipes** all recorded uptime history/incidents and restarts monitoring from now, via `uptimeMonitor.reset()` (rewrites the `uptime_state` row in `auth-store.db`). Backs the admin "Reset server status data" button and changes the public `/status` page immediately. Returns `{ success: true, message, snapshot }`. |

`POST` `/api/send-email` uses the **same** `LOGS_ACCESS_KEY` (see above), not only for logs.

---

## Admin dashboard & image hosting

The admin dashboard (`admin.html`) collects the `LOGS_ACCESS_KEY` client-side and calls these image-hosting APIs (and the log exports above) with the `X-Stagify-Endpoint-Key` header. Hosted images are served publicly at `GET /i/:id` (see Public pages).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/admin` | Serves `public/admin.html` (internal dashboard). **No key on the GET** (`200`, `Cache-Control: no-store`); the page collects the admin key client-side. |
| `POST` | `/api/host-image` | **`protectLogs`** (header key). **Multipart:** one image in field `image`. Stores it and returns `{ ok, id, path: '/i/<id>', url, entry }`; the image is then publicly served at `GET /i/:id`. `400` on a bad/missing upload, `500` on save failure. |
| `GET` | `/api/hosted-images` | **`protectLogs`**. Lists hosted images newest-first: `{ images: [{ id, path, mime, size, uploadedAt, … }] }`. |
| `DELETE` | `/api/hosted-images/:id` | **`protectLogs`**. Deletes a hosted image (file + manifest entry). Returns `{ ok: true }`, `400` for an invalid id, `404` if unknown. |

---

## Notes

- **CORS** is enabled globally.
- **JSON body limit** is very large (e.g. 50mb) for chat/history; oversized bodies get `400` / `413` with JSON error where configured.
- **Trust proxy** can be toggled with `TRUST_PROXY` (for real client IPs behind Render/nginx).

If you add a route, append it to this file so operators can find auth and query requirements quickly.
