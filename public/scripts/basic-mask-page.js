// Stagify.ai — public/basic-mask.html.
//
// The thinnest of the four preview entry points, because this page has no tool on it.
// Basic Mask opens as a panel inside the staging flow on the home page, so the Stagify+
// view here is a way IN — an "Open Basic Mask" button — rather than the studio embedded.
// That maps onto the shared writer exactly: the button non-subscribers must not see is the
// one preview-access.js calls the "tool", and the line that sells is the "pitch".
//
// So there is nothing to wire beyond settling the plan, which is why this file has no
// listeners, no DOM refs and no state.

import { syncBasicMaskAccess } from './basic-mask/access.js';
import { settlePreview } from './preview-access.js';

// Paint from the cached plan, wait for /api/auth/me, paint again. A failure is not fatal
// and not a reason to navigate: the public view is already on screen and is the right page
// for someone whose plan could not be confirmed.
void settlePreview(syncBasicMaskAccess);
