// Copying text to the clipboard, in the two ways browsers allow.
//
// `navigator.clipboard` is only available in a secure context, so it is absent over
// plain http and inside some embedded webviews. The textarea + execCommand path is the
// fallback for exactly those, and it is deprecated rather than gone.
//
// This returns whether it WORKED, which the admin copy button never needed — it always
// said "Copied!" — but the gallery does: its share token is displayed once and never
// again, so telling somebody it is on their clipboard when it is not costs them the
// link.

/**
 * The pre-clipboard-API path: a throwaway off-screen textarea and execCommand.
 * @param {string} text @param {Document} doc @returns {boolean}
 */
function legacyCopy(text, doc) {
  try {
    const ta = doc.createElement('textarea');
    ta.value = text;
    // Fixed and transparent rather than display:none — a hidden element cannot be
    // selected, which is the usual way this fallback silently does nothing.
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.opacity = '0';
    ta.setAttribute('readonly', 'readonly');
    doc.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = doc.execCommand('copy');
    doc.body.removeChild(ta);
    return !!ok;
  } catch {
    return false;
  }
}

/**
 * Put `text` on the clipboard.
 * @param {string} text
 * @param {{ doc?: Document, nav?: Navigator }} [deps]
 * @returns {Promise<boolean>} Whether the copy actually happened.
 */
export async function copyText(text, { doc = document, nav = typeof navigator === 'undefined' ? null : navigator } = {}) {
  if (!text) return false;
  const async = /** @type {any} */ (nav)?.clipboard?.writeText;
  if (typeof async === 'function') {
    try {
      await /** @type {any} */ (nav).clipboard.writeText(text);
      return true;
    } catch {
      // Denied permission, or not a secure context after all — fall through.
    }
  }
  return legacyCopy(text, doc);
}
