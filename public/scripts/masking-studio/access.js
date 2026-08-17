// Stagify.ai — who sees what on the Masking Studio page.
//
// One binding of the shared preview pattern; everything about WHY the page has three
// audiences on one URL, and why none of it is a security boundary, is in
// scripts/preview-access.js. This file exists only to name the four things that are
// specific to this page, and to be the import auth.js reaches for.
//
// It is a module of its own rather than a few lines inside masking-studio-app.js because
// auth.js's applyUserToUI() has to call the writer on every auth change, and importing the
// studio's 900-line composition root into auth.js would load the whole studio on all ten
// nav-bearing pages. The writer no-ops everywhere else by construction: `#ms-tool` exists
// on exactly one page.

import { createPreviewAccess } from '../preview-access.js';

/**
 * Apply the right view to the Masking Studio, resolving the plan and the elements from the
 * live document.
 *
 * Called from auth.js's applyUserToUI(), so it runs on sign-in, sign-out and token refresh
 * — and from masking-studio-app.js's boot, twice: once optimistically before
 * /api/auth/me is sent, and again with the answer.
 *
 * `ms-pro-pending` is the class scripts/preview-gate.js puts on <html> before the first
 * paint when the plan auth.js cached last visit says Stagify+; the three rules that give it
 * meaning are in masking-studio.css. This writer takes it off once the live plan is known.
 *
 * @returns {boolean} True when the tool is visible to this visitor.
 */
export const syncMaskingStudioAccess = createPreviewAccess({
  toolId: 'ms-tool',
  pitchId: 'ms-pitch',
  heroActionsId: 'ms-hero-actions',
  pendingClass: 'ms-pro-pending',
});
