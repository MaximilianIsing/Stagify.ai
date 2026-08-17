// Stagify.ai — who sees what on the AI Designer page.
//
// One binding of the shared preview pattern; the reasoning for three audiences on one URL,
// and the reminder that none of it is a security boundary, is in scripts/preview-access.js.
//
// ONE THING IS DIFFERENT HERE, and it is worth knowing before reading the gate: this page
// is also DESKTOP-ONLY, and that half is still a redirect. scripts/ai-designer-gate.js
// sends any viewport at or below 768px to the home page before anything else runs, so a
// phone never reaches the pitch either. That is a deliberate decision rather than an
// oversight — the studio is a desktop layout, and a mobile landing page would sell
// something the visitor could not then use — but it does mean this preview earns nothing
// from mobile search, which is where most cold traffic lands. The two decisions are joined
// and should be revisited together.
//
// A module of its own rather than a few lines inside ai-designer-app.js because auth.js's
// applyUserToUI() has to call the writer on every auth change, and importing the designer's
// composition root into auth.js would load the whole studio on all ten nav-bearing pages.
// The writer no-ops everywhere else by construction: `#ai-tool` exists on exactly one page.

import { createPreviewAccess } from '../preview-access.js';

/**
 * Apply the right view to the AI Designer, resolving the plan and the elements from the
 * live document.
 *
 * Called from auth.js's applyUserToUI(), so it runs on sign-in, sign-out and token refresh
 * — and from ai-designer-app.js's boot, twice: once optimistically before /api/auth/me is
 * sent, and again with the answer.
 *
 * `ai-pro-pending` is the class ai-designer-gate.js puts on <html> before the first paint
 * when the plan auth.js cached last visit says Stagify+; the rules that give it meaning are
 * in ai-designer.css. This writer takes it off once the live plan is known.
 *
 * @returns {boolean} True when the studio is visible to this visitor.
 */
export const syncDesignerAccess = createPreviewAccess({
  toolId: 'ai-tool',
  pitchId: 'ai-pitch',
  heroActionsId: 'ai-hero-actions',
  pendingClass: 'ai-pro-pending',
});
