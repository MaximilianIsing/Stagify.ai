// Config/secret readers. Every secret is read from its env var only (see createConfig).
import crypto from 'crypto';
import { logger } from '../logger.js';

export function createConfig() {
  // Every secret comes from its env var: the Render dashboard in production, `.env`
  // locally (load-env.js). There is deliberately no file fallback: a stray .txt on disk
  // used to override the dashboard value, so one source of truth is the whole point.
  const env = (name) => {
    const v = process.env[name];
    return v && String(v).trim() ? String(v).trim() : '';
  };

  // A value that must carry a known prefix (sk_, pk_, price_) is ignored, with a
  // warning, when it doesn't: a pasted publishable key in the secret slot should fail
  // loudly at boot, not at the first Stripe call.
  const prefixed = (name, prefix) => {
    const v = env(name);
    if (!v) return '';
    if (v.startsWith(prefix)) return v;
    logger.warn(`[config] ${name} must start with ${prefix} (ignored)`);
    return '';
  };

  const readStripeSecretKey = () => prefixed('STRIPE_SECRET_KEY', 'sk_');
  const readStripeWebhookSecret = () => env('STRIPE_WEBHOOK_SECRET');
  const readStripePublishableKey = () => prefixed('STRIPE_PUBLISHABLE_KEY', 'pk_');
  const readEnterprisePriceId = () => prefixed('ENTERPRISE_PRICE_ID', 'price_');
  const readGoogleClientId = () => env('GOOGLE_CLIENT_ID');
  /** Optional. Sign-In With Google (ID token) only needs the client id; secret is for other OAuth flows. */
  const readGoogleClientSecret = () => env('GOOGLE_CLIENT_SECRET');
  const readEndpointAccessKey = () => env('endpoint_key');

  function endpointKeyMatches(received, expected) {
    if (!received || !expected || typeof received !== 'string' || typeof expected !== 'string') {
      return false;
    }
    const a = crypto.createHash('sha256').update(received, 'utf8').digest();
    const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
    return crypto.timingSafeEqual(a, b);
  }

  const readEnterpriseMeterEventName = () => env('ENTERPRISE_METER_EVENT_NAME') || 'user_generation';

  /**
   * Stripe price ids for the API credit packs, by pack id.
   *
   * Separate from readEnterprisePriceId because these are a different PRODUCT in a
   * different mode: one-time `payment` prices, not a metered subscription. Sharing the
   * enterprise price would put credit purchases on the same meter, and an account
   * holding both would have one generation billed twice.
   *
   * Missing ids are not an error — an unconfigured pack simply is not offered for sale
   * (lib/data/credit-packs.js filters them out), which is the same posture the rest of
   * the Stripe config takes: billing off, product still up.
   * @returns {{ api_20: string, api_50: string, api_100: string, api_500: string }} The ids, '' when unset.
   */
  function readApiCreditPriceIds() {
    return {
      api_20: prefixed('API_CREDIT_PRICE_20', 'price_'),
      api_50: prefixed('API_CREDIT_PRICE_50', 'price_'),
      api_100: prefixed('API_CREDIT_PRICE_100', 'price_'),
      api_500: prefixed('API_CREDIT_PRICE_500', 'price_'),
    };
  }

  return {
    readStripeSecretKey,
    readStripeWebhookSecret,
    readStripePublishableKey,
    readEnterprisePriceId,
    readGoogleClientId,
    readGoogleClientSecret,
    readEndpointAccessKey,
    readEnterpriseMeterEventName,
    readApiCreditPriceIds,
    endpointKeyMatches,
  };
}
