// Stagify.ai — the PUBLIC-PREVIEW shape, shared by every Stagify+ page that has one.
//
// THE PATTERN, AND WHY IT EXISTS
// Every paid page used to load a render-blocking `*-gate.js` that `location.replace`d
// anyone without a token. That works as an affordance and is terrible as a front door:
// Googlebot carries no token either, so those pages' canonical/hreflang/JSON-LD setup
// earned nothing, and a curious visitor who clicked the tool in the nav was answered with
// a pricing table rather than with what the tool does.
//
// A preview page keeps the URL and changes SHAPE instead. Three audiences, two shapes:
//
//   anonymous → the pitch, and a Stagify+ call to action.
//   free      → exactly the same page. Deliberately not a wall: an upgrade dialog on top
//               of the pitch fires the instant somebody creates an account, which makes
//               signing up feel like hitting one, and it covers the very copy that is
//               supposed to do the selling.
//   pro       → the tool, and the pitch is taken away. Someone who already bought it does
//               not need selling.
//
// So the plan is a THREE-state fact about the visitor and a TWO-shape decision about the
// page: only `pro` changes what renders. The tri-state is kept anyway — it is what the
// page actually knows, and collapsing it hides which audience a future change is aimed at.
//
// NONE OF THIS IS A SECURITY BOUNDARY. Revealing the controls is an affordance; the gate
// is `requireProAccount` on the route each studio posts to, which a free account hits with
// a 403 no matter what the DOM says. Never authorize on anything in this file.
//
// WHY IT IS SHARED
// exterior-studio.html shipped this first, as `exterior-studio/access.js`. Three more
// pages wanted the identical behaviour, and four copies of a rule this subtle is four
// chances to fix a bug in one of them — the failure mode this repo has already paid for
// with the nav header (see docs) and with resolveDataDir. One pure predicate, one
// idempotent writer, one factory that binds them to a page's element ids.
//
// ALL FOUR PAGES ARE ON THIS MODULE NOW, exterior-studio.html included — it was the last
// holdout, still running its own predicate, writer and pre-paint gate, which agreed with
// these ones only because they were written on the same day. Each page keeps a small
// module of its own naming its ids (`*/access.js`), because auth.js has to import the
// writer and must not pull a studio's composition root onto all ten nav-bearing pages.
// test/frontend/preview-access.test.js runs every assertion below against all four, so a
// page missing from its PAGES list is a page nothing checks.

import { authSettled } from './session-state.js';

/**
 * Which audience a visitor belongs to.
 *
 * Pure, so the rule is testable on its own and "is this person Pro" has exactly one
 * definition across every preview page. Enterprise-domain accounts arrive already carrying
 * `plan: 'pro'` (enhanceUserWithEnterprise promotes them server-side), so they need no
 * special case here.
 *
 * @param {{ plan?: string } | null | undefined} user - The signed-in account, or null/undefined when signed out.
 * @returns {'anonymous' | 'free' | 'pro'} The audience to render for.
 */
export function previewView(user) {
  if (!user) return 'anonymous';
  return user.plan === 'pro' ? 'pro' : 'free';
}

/**
 * Apply a view to a page's three regions. Idempotent and REVERSIBLE — signing out has to
 * put the pitch back, which is the branch that runs when it does.
 *
 * Takes its elements as an argument so the writer can be driven by a test without a DOM
 * implementation, and no-ops entirely on the pages that have none of them (every field is
 * null there, which is the case that runs on all ten nav-bearing pages).
 *
 * @param {'anonymous' | 'free' | 'pro'} view - The audience to render for.
 * @param {{ pitch: HTMLElement | null, tool: HTMLElement | null, heroActions: HTMLElement | null }} els - The page regions this writer owns.
 * @returns {boolean} True when the tool was revealed (i.e. the visitor is on Stagify+).
 */
export function applyPreviewView(view, els) {
  const pro = view === 'pro';
  if (els.pitch) els.pitch.hidden = pro;
  if (els.tool) els.tool.hidden = !pro;
  // The hero's call to action is a SALES control — the only thing it ever says is "get
  // Stagify+". For someone who already has it the tool is right there underneath, so the
  // button is noise. Hidden rather than repointed at the uploader, which is what the first
  // build did: a control that changes job between views is one more thing to keep true
  // through every language switch. For everyone else it is the page's only upgrade prompt,
  // which is why the modal that used to sit on top of the pitch is gone.
  if (els.heroActions) els.heroActions.hidden = pro;
  return pro;
}

/**
 * Bind the writer to one page.
 *
 * Returns the single writer that page exports to auth.js's applyUserToUI(), so it runs on
 * every auth change — sign-in, sign-out, token refresh — and no-ops on the pages that are
 * not this one. `toolId` is the existence check: if that element is absent we are on some
 * other page and there is nothing to do.
 *
 * `pitchId` and `heroActionsId` are both optional, and Basic Mask is why: that page is a
 * pitch end to end, so there is no region to take away from a subscriber — only a button to
 * swap. A page that names neither still gets the tool reveal, which is the one part every
 * preview has.
 *
 * @param {{ toolId: string, pitchId?: string, heroActionsId?: string, pendingClass: string }} ids - The page's regions, and the class its pre-paint gate sets on <html>.
 * @returns {() => boolean} The page's sync function; true when the tool is visible.
 */
export function createPreviewAccess(ids) {
  return function syncPreviewAccess() {
    const doc = globalThis.document;
    const tool = doc?.getElementById(ids.toolId);
    if (!tool) return false;

    const pro = applyPreviewView(previewView(currentUser()), {
      pitch: ids.pitchId ? doc.getElementById(ids.pitchId) : null,
      tool,
      heroActions: ids.heroActionsId ? doc.getElementById(ids.heroActionsId) : null,
    });

    // Hand the page back from the pre-paint gate's CACHED guess to the live plan — but only
    // once there IS a live plan. Doing it unconditionally would strip the class on the
    // optimistic first call each page's entry point makes before the request has even been
    // sent, and re-create the very flash the gate exists to prevent. Done AFTER the writer
    // above, so the `hidden` properties are already correct when the CSS override stops
    // applying and the two never disagree for a frame. Each gate carries its own timeout as
    // a second escape.
    if (authSettled(globalThis.window?.StagifyAuth)) {
      doc.documentElement?.classList?.remove(ids.pendingClass);
    }
    return pro;
  };
}

/**
 * Paint from whatever is cached, wait for the real plan, paint again.
 *
 * Every preview page's entry point does exactly this at boot, and each of the three got it
 * subtly wrong on the way here, so it is one function:
 *
 *   - the FIRST sync is not optional. Without it a subscriber whose plan is still cached
 *     loses the pre-painted tool for the length of a round trip — the flash the gate exists
 *     to prevent, re-created by the page that mounts it.
 *   - a failed `fetchMe` is NOT a reason to do anything. These pages used to redirect on
 *     it; the public view is already on screen and is the correct page to show someone
 *     whose plan could not be confirmed.
 *   - the SECOND sync is what hands the page from the guess to the answer, and is the only
 *     thing that takes the pre-paint class off. Skipping it on the error path leaves a
 *     cancelled account looking at a tool the server will 403.
 *
 * @param {() => boolean} sync - The page's writer, from createPreviewAccess.
 * @returns {Promise<boolean>} True when the tool is visible once the plan is known.
 */
export async function settlePreview(sync) {
  sync();
  const auth = globalThis.window?.StagifyAuth;
  if (auth && typeof auth.fetchMe === 'function') {
    try {
      await auth.fetchMe();
    } catch {
      /* the pitch stands — see above */
    }
  }
  return sync();
}

/** The live plan, read the way every other island on the site reads it. */
function currentUser() {
  const auth = globalThis.window?.StagifyAuth;
  return (auth && auth.user) || null;
}
