// Stagify.ai — who sees what on the Exterior Studio page.
//
// This page is the one Stagify+ surface with THREE audiences on one URL, and that is
// deliberate. Every other paid page (`masking-studio.html`, `ai-designer.html`,
// `gallery.html`) loads a render-blocking `*-gate.js` that `location.replace`s anyone
// without a token. That works, but it also means Googlebot — which carries no token —
// is redirected away, so those pages' canonical/hreflang/JSON-LD setup earns nothing.
// Here the page stays put and changes shape instead:
//
//   anonymous → the pitch, and a Stagify+ call to action. No modal: they have not been
//               told the price yet, so a dialog is the wrong first thing to show them.
//   free      → the same pitch, plus the upgrade dialog. They have an account, so the
//               ask is concrete.
//   pro       → the tool, and the pitch is taken away. Someone who already bought it
//               does not need selling.
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

/**
 * Which of the three views a visitor gets.
 *
 * Pure so the rule is testable on its own and "is this person Pro" has exactly one
 * definition on this page. Enterprise-domain accounts arrive here already carrying
 * `plan: 'pro'` (enhanceUserWithEnterprise promotes them server-side), so they need no
 * special case.
 *
 * @param {{ plan?: string } | null | undefined} user - The signed-in account, or null/undefined when signed out.
 * @returns {'anonymous' | 'free' | 'pro'} The view to render.
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

/**
 * Apply a view to the page. Idempotent and reversible — signing out must put the pitch
 * back, which is the branch that runs when it does.
 *
 * Takes its elements as an argument so the writer can be driven by a test without a DOM
 * implementation, and no-ops entirely on the other nine nav-bearing pages (they have none
 * of these ids, so every field is null).
 *
 * @param {'anonymous' | 'free' | 'pro'} view - The view to render.
 * @param {{ features: HTMLElement | null, tool: HTMLElement | null, heroActions: HTMLElement | null, gate: HTMLElement | null }} els - The page regions this writer owns.
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
  if (els.heroActions) els.heroActions.hidden = pro;
  // Only a SIGNED-IN free account gets the dialog. An anonymous visitor is reading the
  // page for the first time; interrupting them with an upgrade modal before they know
  // what the tool does is how a landing page stops converting.
  if (els.gate) els.gate.classList.toggle('active', view === 'free');
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
  return applyExteriorView(exteriorView(currentUser()), {
    features: document.getElementById('ex-features'),
    tool,
    heroActions: document.getElementById('ex-hero-actions'),
    gate: document.getElementById('ex-pro-gate'),
  });
}
