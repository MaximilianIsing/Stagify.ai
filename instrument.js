// Sentry initialization. Imported at the very top of server.js (right after load-env,
// so SENTRY_DSN is available) and before any app code, so the SDK can instrument the
// libraries it loads. Errors are then captured automatically.
//
// Degrades gracefully: with no SENTRY_DSN set (e.g. local dev), Sentry.init() is a
// no-op — no network calls, no overhead — exactly like the Gemini/Stripe/Resend keys.
import * as Sentry from '@sentry/node';

// Only report from PRODUCTION. This deploy is "staging" when IS_STAGING is 1/true/on/yes
// (same parse as server.js:75); anything else — including "false", empty, or unset — is
// production. Note: process.env.IS_STAGING is a STRING, so the string "false" is truthy —
// hence the explicit regex rather than a bare truthiness check.
const IS_STAGING = /^(1|true|on|yes)$/i.test(String(process.env.IS_STAGING || '').trim());

Sentry.init({
  dsn: process.env.SENTRY_DSN, // unset → SDK disabled, zero effect on the app

  // Report from PRODUCTION only. `enabled: false` hard-stops all event sending, so staging
  // never reports even though SENTRY_DSN is present in that environment. (Passing dsn:
  // undefined does NOT work here — the SDK auto-falls-back to reading process.env.SENTRY_DSN,
  // so gating must use the explicit `enabled` flag.)
  enabled: !IS_STAGING,
  environment: IS_STAGING ? 'staging' : 'production',

  // Error tracking only for now. Bump this (e.g. 0.1) later to sample performance traces.
  tracesSampleRate: 0,

  // Do NOT ship personally-identifiable request data (cookies, auth headers, client IP)
  // by default. This app handles password hashes and user uploads, so keep PII off until
  // a deliberate decision to include specific, scrubbed fields.
  sendDefaultPii: false,
});
