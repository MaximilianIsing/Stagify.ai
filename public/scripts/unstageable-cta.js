// The follow-up ACTION that belongs with an /api/validate-image rejection.
//
// A sibling of unstageable-message.js rather than part of it. That module answers "what
// sentence"; this one answers "and where do they go next", and only ONE category has an
// answer. Keeping them apart leaves the message resolver dependency-free — it is imported
// by both studios AND by the Exterior Studio's own 422 handler, which must never grow a
// link to itself — and lets this module own the plan lookup and the locale-aware href.
//
// EXTERIOR is the only code that gets a CTA, and that is a product fact rather than an
// omission: a rejected selfie has nowhere to go, but a rejected facade is the Exterior
// Studio's canonical input. test/frontend/unstageable-cta.test.js walks the SERVER's
// taxonomy and asserts every other code still resolves to null, so "only one" cannot
// quietly rot into "some".
import { localizedTarget } from './i18n-routing.js';

/**
 * The one code from lib/staging/unstageable.js this module answers for.
 *
 * Exported so the test can assert it is still a code the server can actually send. A
 * rename on that side would leave the sentence correct and the button silently gone —
 * the worst kind of breakage, because nothing errors.
 */
export const EXTERIOR_CODE = 'EXTERIOR';

// Stagify+ opens the tool; everyone else is sent to the page that sells it. Deliberately
// NOT both to exterior-studio.html: that page has a public pitch view and would work, but
// a user who has just been refused an upload wants the shortest honest path to the thing
// that unblocks them, and the label ("Get Stagify+") has to match where the click lands.
const EXTERIOR_PAGE = 'exterior-studio.html';
const PLUS_PAGE = 'stagify-plus.html';

/**
 * Live plan, read the way staging-menu.js and app/remove-furniture-gate.js read it:
 * prefer the predicate, fall back to the raw field for the window before auth.js has
 * finished wiring itself up.
 * @returns {boolean}
 */
function currentIsPro() {
  const auth = window.StagifyAuth;
  if (auth && typeof auth.isProUser === 'function') return !!auth.isProUser();
  return !!(auth && auth.user && auth.user.plan === 'pro');
}

/**
 * @typedef {object} UnstageableCta
 * @property {string} href - Already locale-prefixed; safe to assign straight to an anchor.
 * @property {string} labelKey - Language-pack key for the button label.
 * @property {string} fallbackLabel - English, used when the pack has not loaded.
 * @property {boolean} upgrade - True when this is the sell, false when it opens the tool.
 */

/**
 * The call to action for a rejection verdict, or null when the category has none.
 *
 * The `env` bag exists so the unit test can drive both plans and both locales without a
 * fake `window.location`; production call sites pass one argument.
 *
 * @param {{ code?: string | null } | null | undefined} result - The /api/validate-image response body.
 * @param {{ isPro?: boolean, localize?: (rel: string) => string }} [env] - Overrides for tests.
 * @returns {UnstageableCta | null}
 */
export function unstageableCta(result, env) {
  if (!result || result.code !== EXTERIOR_CODE) return null;
  const isPro = env && typeof env.isPro === 'boolean' ? env.isPro : currentIsPro();
  // Through localizedTarget, always: a bare 'exterior-studio.html' under <base href="/">
  // drops an /es visitor onto the English page. Invisible in English, wrong in ten
  // languages.
  const localize = (env && env.localize) || localizedTarget;
  return isPro
    ? {
      href: localize(EXTERIOR_PAGE),
      labelKey: 'errors.unstageableCta.exteriorOpen',
      fallbackLabel: 'Open the Exterior Studio',
      upgrade: false,
    }
    : {
      href: localize(PLUS_PAGE),
      labelKey: 'errors.unstageableCta.exteriorUpgrade',
      fallbackLabel: 'Get Stagify+',
      upgrade: true,
    };
}
