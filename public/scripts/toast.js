// Non-blocking toast notifications — the app's single user-facing message channel.
//
// Previously this existed twice, byte-for-byte apart from a 20ms timing drift:
// once in scripts/ai-designer/toast.js and once inline in scripts/masking-studio-app.js.
// The main Stagify studio had neither, so it reached for native alert() instead —
// nine modal, unstyled, untranslatable-looking browser dialogs in the flagship
// upload/staging flow. One module now serves all three.
//
// NOT to be confused with the "Converting photo…" indicator in scripts/heic-convert.js:
// that one is a reference-counted, indefinite-duration progress spinner, not a
// transient message, so it stays separate on purpose.
//
// Styling lives in styles/toast.css, which every page using this must link.

const VISIBLE_MS = 4200;
const FADE_MS = 320; // must stay >= the transition duration in toast.css

/**
 * The shared toast container, created on first use so a page needs no markup for
 * it. masking-studio.html ships a static #toast-host; that one is reused as-is.
 * @returns {HTMLElement} The toast host element.
 */
function getHost() {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    // polite, not assertive: these accompany a visible UI change and shouldn't
    // interrupt a screen reader mid-sentence. Individual error toasts still get
    // role="alert" below, which does interrupt — that is the intended split.
    host.setAttribute('aria-live', 'polite');
    host.setAttribute('aria-atomic', 'false');
    document.body.appendChild(host);
  }
  return host;
}

/**
 * Show a transient toast message.
 * @param {string} message - Text to display. Set as textContent, never HTML.
 * @param {'error'|'success'} [type] - Visual treatment; omit for the neutral default.
 * @returns {void}
 */
export function showToast(message, type) {
  const host = getHost();
  const toast = document.createElement('div');
  toast.className = 'toast' + (type ? ' toast--' + type : '');
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.textContent = message;
  host.appendChild(toast);

  // Flip to the visible state one frame after insertion, so the element is laid
  // out first and the opacity/transform transition actually runs.
  //
  // rAF alone is not sufficient, and both implementations this replaces had the
  // bug: while the document is hidden the callback is deferred indefinitely, but
  // the removal timer below is a setTimeout and keeps counting. A toast raised on
  // a backgrounded tab could therefore be removed having never become visible —
  // the error silently never shown. The timer is a one-shot backstop for exactly
  // that case; whichever path runs first wins and the other is a no-op.
  let shown = false;
  const reveal = () => {
    if (shown) return;
    shown = true;
    toast.classList.add('toast--show');
  };
  requestAnimationFrame(reveal);
  setTimeout(reveal, 50);

  setTimeout(() => {
    toast.classList.remove('toast--show');
    setTimeout(() => toast.remove(), FADE_MS);
  }, VISIBLE_MS);
}

/**
 * Show an error toast. The common case at every call site that used to alert().
 * @param {string} message - Text to display.
 * @returns {void}
 */
export function showErrorToast(message) {
  showToast(message, 'error');
}
