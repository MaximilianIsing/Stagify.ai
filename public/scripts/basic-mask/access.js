// Stagify.ai — who sees what on the Basic Mask page.
//
// One binding of the shared preview pattern (scripts/preview-access.js), and the one that
// bends it, so read the mapping before the ids:
//
//   toolId: 'bm-tool'  — NOT a tool. Basic Mask lives in the staging flow on the home page,
//                        so this is the "Open Basic Mask" button, which is the thing only a
//                        subscriber may be shown. Same rule as a real tool: revealed for
//                        Pro, hidden for everyone else.
//   pitchId: 'bm-pitch' — the line that SELLS ("Included with Stagify+, alongside …"), and
//                        only that line. The three feature columns sit outside it on
//                        purpose: they describe what the tool does and are worth reading
//                        whether or not you have bought it, so taking them away from a
//                        subscriber would leave the page saying nothing.
//   heroActionsId      — the "Get Stagify+" button, the counterpart to bm-tool.
//
// Nothing here is a security boundary. The button reveals a link to a panel whose own
// render route answers 403 for a free account, and that route is the gate.

import { createPreviewAccess } from '../preview-access.js';

/**
 * Swap the page between its two shapes: the sales button and the upgrade line for anyone
 * without Stagify+, the "Open Basic Mask" button for anyone with it.
 *
 * Called from auth.js's applyUserToUI(), so it runs on sign-in, sign-out and token refresh
 * — and from basic-mask-page.js's boot, twice, around the plan check.
 *
 * `bm-pro-pending` is the class scripts/preview-gate.js puts on <html> before the first
 * paint when the cached plan says Stagify+; the rules that give it meaning are in
 * basic-mask.css. This writer takes it off once the live plan is known.
 *
 * @returns {boolean} True when the visitor is on Stagify+.
 */
export const syncBasicMaskAccess = createPreviewAccess({
  toolId: 'bm-tool',
  pitchId: 'bm-pitch',
  heroActionsId: 'bm-hero-actions',
  pendingClass: 'bm-pro-pending',
});
