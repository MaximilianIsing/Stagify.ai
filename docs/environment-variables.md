# Environment variables

```dotenv
# For any key with a "file fallback", the server reads the env var first and only
# falls back to the gitignored .txt file if the var is unset — use one or the other.

# --- Stripe ---
# Secret API key (starts with sk_). Powers all billing; billing endpoints return
# 503 until it's set. File fallback: stripe_secret_key.txt
STRIPE_SECRET_KEY=
# Webhook signing secret (starts with whsec_). Used to verify incoming Stripe
# webhook signatures; the webhook endpoint 503s without it. File fallback: stripe_webhook_secret.txt
STRIPE_WEBHOOK_SECRET=
# Publishable key (starts with pk_). Safe for the browser; used to start checkout.
# File fallback: stripe_publishable.txt
STRIPE_PUBLISHABLE_KEY=
# Stripe price id for the Enterprise plan (starts with price_). Used for metered
# enterprise billing. File fallback: priceid.txt
ENTERPRISE_PRICE_ID=

# --- Google Sign-In ---
# OAuth client id. Enables the "Sign in with Google" button; ID-token sign-in
# needs only this id. Sign-in is disabled if unset. File fallback: googleclientID.txt
GOOGLE_CLIENT_ID=
# OAuth client secret. Only required for OAuth authorization-code flows — plain
# ID-token sign-in works without it. File fallback: googlesecret.txt
GOOGLE_CLIENT_SECRET=
# Not read by the server today; preserved here so the value isn't lost.
GOOGLE_PUBLISHER_ID=

# --- AI providers ---
# Google Generative AI (Gemini) key. Powers the core staging pipeline — staging
# fails without it. Also accepted under the name GEMINI_API_KEY. File fallback: key.txt
GOOGLE_AI_API_KEY=
# OpenAI key. Powers the chat assistant only; the rest of the app works without
# it (chat is simply disabled). File fallback: gpt-key.txt
GPT_KEY=

# --- Email (Resend) ---
# Resend API key for transactional email (password resets, notifications). If
# unset, email is silently skipped rather than erroring. File fallback: resendkey.txt
RESEND_API_KEY=

# --- Access / admin ---
# Access key that guards the protected log/admin endpoints (see endpoints.md).
# Compared in constant time. Note the lowercase name. File fallback: endpointkey.txt
endpoint_key=

# --- Monitoring (Sentry) ---
# Sentry DSN for production error tracking. Unset → the SDK is fully disabled (no
# network calls, no overhead), so leave blank locally. Set it in the host dashboard
# (Render) to start capturing errors.
# PRODUCTION ONLY: errors are reported only when IS_STAGING is falsey (false/empty/unset).
# When IS_STAGING is true/on/yes/1 the SDK is hard-disabled even if SENTRY_DSN is set, so a
# staging deploy never reports. Ensure the production service does NOT have IS_STAGING=true.
SENTRY_DSN=

# --- Debug flags — all default OFF. Set true ONLY for local dev, never in production. ---
# Verbose server logging (startup, key loading, etc.). true/false. File fallback: debug.txt
DEBUG=false
# Redirects ALL outbound email to the developer debug address instead of real
# recipients — silently hides mail from real users, so keep this false in production.
# true/false. File fallback: emaildebug.txt
EMAIL_DEBUG=false
# Replaces the real home-page hero stats with the two values below. true/false.
STATS_DEBUG=false
# Only take effect when STATS_DEBUG=true (example values kept commented so they stay inert).
# DEBUG_ROOMS=154000
# DEBUG_USERS=2420
IS_STAGING=false
HIDE_STAGING_BANNER=false

# --- Advanced / optional (sensible defaults; only set to override) ---
# HTTP port the server listens on. Default 3000.
# PORT=3000
# Express trust-proxy setting: trusts 1 hop by default; set 0 to disable.
# TRUST_PROXY=1
# Set 1 to turn OFF the Content-Security-Policy (only to debug a blocked resource).
# DISABLE_CSP=0
# Comma-separated CORS allow-list.
# Default: https://stagify.ai,https://www.stagify.ai,http://localhost:3000
# ALLOWED_ORIGINS=
# Absolute base URL for building return links (e.g. the Stripe portal).
# Defaults to the incoming request's host. APP_URL is the fallback for PUBLIC_APP_URL.
# PUBLIC_APP_URL=
# APP_URL=
# Rate limits: auth attempts / 15 min, emails / 15 min, AI generations / 5 min.
# RL_AUTH=40
# RL_EMAIL=6
# RL_GEN=60
# Extra directory searched first for the stripe_*.txt secret files.
# STRIPE_SECRETS_DIR=
# Stripe meter event name for enterprise usage billing. Default user_generation.
# ENTERPRISE_METER_EVENT_NAME=user_generation
# "From" address for outbound Resend email. Default team@stagify.ai.
# RESEND_FROM_EMAIL=team@stagify.ai

# --- Platform (set automatically — do not set these yourself) ---
# RENDER is set by Render; the app reads it to use the /data persistent disk.
# NODE_ENV is set to "production" by render.yaml on deploy.
```
