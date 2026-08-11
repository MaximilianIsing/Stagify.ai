// Stagify.ai — the Exterior Studio's "we're working on it" overlay.
//
// One enhance is one POST that can take up to 180 seconds (see enhance.js), with no
// intermediate progress to report. Before this existed the right-hand pane sat completely
// still for that whole time — the only sign of life was the submit button in the LEFT
// column relabelling itself, which is not where the user is looking.
//
// So: blur the photo, float a spinner over it, and rotate a line of copy so the page reads
// as working rather than stuck. Same shape as the Masking Studio's `.ms-busy-overlay`
// (public/scripts/masking-studio/viewer.js), minus its per-layer dots — that studio has
// sub-steps to report and this one does not.
//
// The overlay is built here rather than declared in exterior-studio.html on purpose: its
// text changes every 2.2s, so a `data-lang` attribute on it would fight the language
// loader, which repaints `[data-lang]` nodes from the pack on every switch.

/** How long each line stays up. Matches the Masking Studio so the two studios feel alike. */
const ROTATE_MS = 2200;

/**
 * The English the pack falls back to.
 *
 * Deliberately about the exterior rather than the model: what gets touched, and — the line
 * that does the most work — what does NOT. The whole promise of this tool is that anything
 * left unticked comes back exactly as photographed.
 */
const FALLBACK_MESSAGES = [
  'Cleaning up the exterior…',
  'Balancing the light…',
  'Refreshing the sky…',
  'Keeping the house itself untouched…',
  'Adding finishing touches…',
];

/**
 * Read the rotating copy out of the language pack.
 *
 * `tx()` in the app is string-shaped and this key is an ARRAY, so it cannot be used here —
 * the pack is asked directly, exactly as viewer.js does for `maskingStudio.loadingMessages`.
 * A pack that answers with anything but a non-empty array loses to the English above; a
 * half-translated pack blanking the label would look like a hung render.
 * @returns {string[]} The lines to cycle.
 */
function packMessages() {
  const sys = globalThis.window && globalThis.window.LanguageSystem;
  const fromPack = sys && typeof sys.getText === 'function'
    ? sys.getText('exteriorStudio.loadingMessages')
    : null;
  return Array.isArray(fromPack) && fromPack.length ? fromPack : FALLBACK_MESSAGES;
}

/**
 * Build the busy overlay for the workspace's preview figure.
 *
 * @param {{ host: HTMLElement | null, doc?: Document, getMessages?: () => string[] }} deps - The
 *   figure to cover (`#ex-preview`), the document to build in, and an override for the copy
 *   (the test injects one; production reads the language pack).
 * @returns {{ start: () => void, stop: () => void }} Run control.
 */
export function createBusyOverlay({ host, doc = globalThis.document, getMessages = packMessages }) {
  /** @type {HTMLElement | null} */
  let overlay = null;
  /** @type {HTMLElement | null} */
  let msgEl = null;
  /** @type {any} */
  let timer = null;

  /** Create the overlay once, on first use. Later calls are no-ops. */
  function ensure() {
    if (overlay || !host) return;
    overlay = doc.createElement('div');
    overlay.className = 'ex-busy hidden';
    // role=status, not alert: this is progress, and it must not interrupt.
    overlay.setAttribute('role', 'status');

    const spin = doc.createElement('div');
    spin.className = 'ex-busy__spin';
    spin.setAttribute('aria-hidden', 'true');

    msgEl = doc.createElement('div');
    msgEl.className = 'ex-busy__msg';
    // Atomic: each line replaces the last, so announce the whole line, not the diff.
    msgEl.setAttribute('aria-live', 'polite');
    msgEl.setAttribute('aria-atomic', 'true');

    overlay.appendChild(spin);
    overlay.appendChild(msgEl);
    host.appendChild(overlay);
  }

  /** Cover the photo and start cycling the copy. */
  function start() {
    ensure();
    if (!overlay || !msgEl || !host) return;
    host.classList.add('is-busy');
    overlay.classList.remove('hidden');

    const msgs = getMessages();
    let i = 0;
    msgEl.textContent = msgs[0];
    // Clear before re-arming: a second start() without this leaves the first interval
    // running forever with nothing holding its handle, and the two race over the label.
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      i = (i + 1) % msgs.length;
      if (msgEl) msgEl.textContent = msgs[i];
    }, ROTATE_MS);
  }

  /**
   * Uncover the photo and stop the timer.
   *
   * Safe to call when the host is already `hidden` — the success path hides `#ex-preview`
   * before the submit handler's `finally` gets here — and safe to call when nothing ever
   * started, which is what happens if the render fails before the overlay was built.
   */
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (overlay) overlay.classList.add('hidden');
    if (host) host.classList.remove('is-busy');
  }

  return { start, stop };
}
