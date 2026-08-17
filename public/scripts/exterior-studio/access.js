// Stagify.ai — who sees what on the Exterior Studio page.
//
// This page is the one Stagify+ surface with THREE audiences on one URL, and that is
// deliberate. Every other paid page (`masking-studio.html`, `ai-designer.html`,
// `gallery.html`) loads a render-blocking `*-gate.js` that `location.replace`s anyone
// without a token. That works, but it also means Googlebot — which carries no token —
// is redirected away, so those pages' canonical/hreflang/JSON-LD setup earns nothing.
// This page has a gate too (`scripts/exterior-studio-gate.js`), but it only ever
// RESHAPES: no visitor is ever sent anywhere. The page stays put and changes shape:
//
//   anonymous → the pitch, and a Stagify+ call to action.
//   free      → exactly the same page. A signed-in free account USED to get a
//               full-screen "your account is on the free plan" dialog on top of the
//               pitch, with no close button. It fired the instant somebody created an
//               account, which made signing up feel like hitting a wall, and it covered
//               the very pitch that was supposed to do the selling. The hero's "Get
//               Stagify+ to use it" button already makes the ask, in place, without
//               taking the page away.
//   pro       → the tool, and the pitch is taken away. Someone who already bought it
//               does not need selling.
//
// So the plan is a THREE-state fact about the visitor and a TWO-shape decision about the
// page: only `pro` changes what renders. Keep the tri-state anyway — it is what the page
// actually knows, and collapsing it would hide which audience a future change is aimed at.
//
// NONE OF THIS IS A SECURITY BOUNDARY. Revealing the controls is an affordance; the
// gate is requireProAccount on POST /api/enhance-exterior, which a free account hits
// with a 403 no matter what the DOM says.
//
// Follows the same two patterns as staging-menu.js and app/remove-furniture-gate.js:
// a pure predicate plus ONE idempotent writer, because applyUserToUI() calls this from
// eight sites and nothing may fight over the same attributes. The markup ships in the
// ANONYMOUS state, so signed-out is the no-JS default and the tool is revealed once
// /api/auth/me answers — the other direction would flash the studio at everyone and
// then take it away.
//
// That default is right for everyone except the people who already paid, who watched the
// sales pitch paint and then vanish a round trip later. The head gate covers exactly that
// gap: it pre-applies the Pro shape in CSS from the plan auth.js cached last visit, and
// `exteriorPlanSettled` below decides when the guess gives way to the real answer. The
// cached plan is never an authorization — requireProAccount still answers 403.

import { authSettled } from '../session-state.js';

/**
 * Which audience a visitor belongs to.
 *
 * Pure so the rule is testable on its own and "is this person Pro" has exactly one
 * definition on this page. Enterprise-domain accounts arrive here already carrying
 * `plan: 'pro'` (enhanceUserWithEnterprise promotes them server-side), so they need no
 * special case.
 *
 * @param {{ plan?: string } | null | undefined} user - The signed-in account, or null/undefined when signed out.
 * @returns {'anonymous' | 'free' | 'pro'} The audience to render for.
 */
export function exteriorView(user) {
  if (!user) return 'anonymous';
  return user.plan === 'pro' ? 'pro' : 'free';
}

/** Live plan, read exactly the way staging-menu.js and remove-furniture-gate.js read it. */
function currentUser() {
  const auth = window.StagifyAuth;
  return (auth && auth.user) || null;
}

/** The class scripts/exterior-studio-gate.js puts on <html> before the first paint. */
export const PENDING_CLASS = 'ex-pro-pending';

/**
 * Apply a view to the page. Idempotent and reversible — signing out must put the pitch
 * back, which is the branch that runs when it does.
 *
 * Takes its elements as an argument so the writer can be driven by a test without a DOM
 * implementation, and no-ops entirely on the other nine nav-bearing pages (they have none
 * of these ids, so every field is null).
 *
 * @param {'anonymous' | 'free' | 'pro'} view - The audience to render for.
 * @param {{ features: HTMLElement | null, tool: HTMLElement | null, heroActions: HTMLElement | null }} els - The page regions this writer owns.
 * @returns {boolean} True when the tool was revealed (i.e. the visitor is on Stagify+).
 */
export function applyExteriorView(view, els) {
  const pro = view === 'pro';
  if (els.features) els.features.hidden = pro;
  if (els.tool) els.tool.hidden = !pro;
  // The hero's call to action is a SALES control — the only thing it ever says is "get
  // Stagify+". For someone who already has it the tool is right there underneath, so the
  // button is noise; the masking studio has no equivalent for exactly that reason. Hidden
  // rather than repointed, which is what it used to do (a "jump to the uploader" link),
  // because a control that changes job between views is one more thing to keep true.
  //
  // For everyone else it is the ONLY upgrade prompt on the page, which is why the modal
  // that used to sit on top of it is gone: one in-place ask, never an interruption.
  if (els.heroActions) els.heroActions.hidden = pro;
  return pro;
}

/**
 * The single writer, resolving both the plan and the elements from the live document.
 *
 * Called from auth.js's applyUserToUI(), so it runs on every auth change — sign-in,
 * sign-out, token refresh — and no-ops on the pages that have no Exterior Studio in them.
 * @returns {boolean} True when the tool is visible to this visitor.
 */
export function syncExteriorAccess() {
  const tool = document.getElementById('ex-tool');
  if (!tool) return false;
  const pro = applyExteriorView(exteriorView(currentUser()), {
    features: document.getElementById('ex-features'),
    tool,
    heroActions: document.getElementById('ex-hero-actions'),
  });
  // Hand the page back from the head gate's cached guess to the live plan — but only once
  // there IS a live plan. Doing it unconditionally would strip the class on the optimistic
  // first call from exterior-studio-app.js, which runs with no user yet, and re-create the
  // very flash the gate exists to prevent. Done after the writer above so the `hidden`
  // properties are already correct when the CSS override stops applying; the two never
  // disagree for a frame. The gate carries its own timeout as a second escape.
  if (authSettled(window.StagifyAuth)) {
    document.documentElement?.classList?.remove(PENDING_CLASS);
  }
  return pro;
}
