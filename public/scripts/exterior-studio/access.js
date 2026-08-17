// Stagify.ai — who sees what on the Exterior Studio page.
//
// One binding of the shared preview pattern; everything about WHY the page has three
// audiences on one URL, and why none of it is a security boundary, is in
// scripts/preview-access.js. This file exists only to name the four things that are
// specific to this page, and to be the import auth.js reaches for.
//
// This page invented the pattern and was, for a while, the only page still running its own
// copy of it — a predicate, a writer and a pre-paint gate duplicated from the three pages
// that had since been folded onto the shared module. The copies agreed when they were
// written, which is the whole problem: nothing would have said so when they stopped. The
// exterior-specific pieces that remain are the ones that really are specific — the pitch
// markup guard in pitch.test.js, and the CTA that must never become a control.
//
// It is a module of its own rather than a few lines inside exterior-studio-app.js because
// auth.js's applyUserToUI() has to call the writer on every auth change, and importing the
// studio's composition root into auth.js would load the whole studio on all ten nav-bearing
// pages. The writer no-ops everywhere else by construction: `#ex-tool` exists on exactly
// one page.

import { createPreviewAccess } from '../preview-access.js';

/**
 * Apply the right view to the Exterior Studio, resolving the plan and the elements from the
 * live document.
 *
 * Called from auth.js's applyUserToUI(), so it runs on sign-in, sign-out and token refresh
 * — and from exterior-studio-app.js's boot, twice: once optimistically before
 * /api/auth/me is sent, and again with the answer.
 *
 * `ex-pro-pending` is the class scripts/preview-gate.js puts on <html> before the first
 * paint when the plan auth.js cached last visit says Stagify+; the three rules that give it
 * meaning are in exterior-studio.css. This writer takes it off once the live plan is known.
 *
 * The pitch id is `ex-features` rather than `ex-pitch` — it predates the shared naming and
 * is load-bearing in pitch.test.js, which asserts the pitch is ONE container so a section
 * added outside it cannot be left on screen for a subscriber.
 *
 * @returns {boolean} True when the tool is visible to this visitor.
 */
export const syncExteriorAccess = createPreviewAccess({
  toolId: 'ex-tool',
  pitchId: 'ex-features',
  heroActionsId: 'ex-hero-actions',
  pendingClass: 'ex-pro-pending',
});
