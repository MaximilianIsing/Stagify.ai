// The mask-editor processing overlay: a spinner plus rotating status messages
// shown over the canvas while the AI runs.
//
// Shared by both mask editors. The two copies were identical apart from three
// things, all now parameters: which container to mount in, which class marks it
// busy (the AI Designer uses `processing`, the stage editor `smask-busy`), and
// one extra CSS rule the stage editor needs to blur its own canvas class.
//
// Worth knowing: both copies previously injected DIFFERENT stylesheet bodies
// under the SAME `smask-refine-styles` id. That only ever worked because the two
// editors live on different pages — on a shared page whichever loaded first would
// have won. The common rules now live here under that id and are genuinely
// identical for every consumer; anything page-specific goes through `extraCss`
// under its own id.
//
//   createMaskOverlay({ lang, getContainer, busyClass?, extraCss?, extraCssId? })
//     -> { start, stop, ensure }

const BASE_CSS_ID = 'smask-refine-styles';
const BASE_CSS =
  '.smask-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;background:rgba(255,255,255,.4);z-index:6;border-radius:inherit;}' +
  '.smask-overlay__spin{width:46px;height:46px;border-radius:50%;border:4px solid rgba(37,99,235,.25);border-top-color:#2563eb;animation:smask-spin .9s linear infinite;}' +
  '.smask-overlay__msg{font-weight:600;color:#1f2937;font-size:14px;text-align:center;max-width:80%;padding:0 12px;}' +
  '.smask-help{position:relative;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;border:1.5px solid #94a3b8;color:#64748b;font-size:11px;font-weight:700;cursor:help;margin-left:6px;margin-right:auto;line-height:1;user-select:none;flex:0 0 auto;}' +
  '.smask-help.hidden{display:none;}' +
  '.smask-help__tip{position:absolute;top:140%;left:0;width:min(290px,72vw);background:#1f2937;color:#fff;font-size:12px;font-weight:400;line-height:1.45;padding:10px 12px;border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.22);opacity:0;visibility:hidden;transition:opacity .15s ease;z-index:30;text-align:left;pointer-events:none;white-space:normal;}' +
  '.smask-help:hover .smask-help__tip,.smask-help:focus .smask-help__tip,.smask-help:focus-within .smask-help__tip{opacity:1;visibility:visible;}' +
  '@keyframes smask-spin{to{transform:rotate(360deg);}}';

// Rotated while the model runs. Only the first is translated — the rest are
// deliberately left in English, exactly as both copies had it.
const LOAD_MESSAGES = [
  'Applying your edit…',
  'Reworking the masked area…',
  'Blending in the new details…',
  'Refining textures and lighting…',
  'Adding finishing touches…',
];

const ROTATE_MS = 2000;

function injectCss(id, css) {
  if (!css || document.getElementById(id)) return;
  const st = document.createElement('style');
  st.id = id;
  st.textContent = css;
  document.head.appendChild(st);
}

/**
 * @param {{
 *   lang: (key: string, fallback: string) => string,
 *   getContainer: () => HTMLElement | null,
 *   busyClass?: string,
 *   extraCss?: string,
 *   extraCssId?: string,
 * }} deps - i18n lookup, the canvas container to mount over, the class marking it
 *   busy, and any consumer-specific CSS.
 * @returns {{ start: () => void, stop: () => void, ensure: () => void }}
 */
export function createMaskOverlay({ lang, getContainer, busyClass = 'processing', extraCss = '', extraCssId = '' }) {
  let msgTimer = null;
  let overlayEl = null;

  function ensure() {
    const container = getContainer();
    if (overlayEl || !container) return;
    injectCss(BASE_CSS_ID, BASE_CSS);
    if (extraCss) injectCss(extraCssId || `${BASE_CSS_ID}-extra`, extraCss);
    // The overlay is absolutely positioned; a static parent would let it escape.
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    overlayEl = document.createElement('div');
    overlayEl.className = 'smask-overlay hidden';
    const spin = document.createElement('div'); spin.className = 'smask-overlay__spin';
    const msg = document.createElement('div'); msg.className = 'smask-overlay__msg';
    overlayEl.appendChild(spin);
    overlayEl.appendChild(msg);
    container.appendChild(overlayEl);
  }

  function start() {
    ensure();
    const container = getContainer();
    if (container) container.classList.add(busyClass);
    if (!overlayEl) return;
    overlayEl.classList.remove('hidden');
    const msgEl = overlayEl.querySelector('.smask-overlay__msg');
    let i = 0;
    if (msgEl) msgEl.textContent = lang('pdf.maskEditor.loadApplying', LOAD_MESSAGES[0]);
    // Clear first: a Regenerate pressed straight after Apply would otherwise
    // leave two intervals racing the same element.
    if (msgTimer) clearInterval(msgTimer);
    msgTimer = setInterval(() => {
      i = (i + 1) % LOAD_MESSAGES.length;
      if (msgEl) msgEl.textContent = LOAD_MESSAGES[i];
    }, ROTATE_MS);
  }

  function stop() {
    if (msgTimer) { clearInterval(msgTimer); msgTimer = null; }
    const container = getContainer();
    if (container) container.classList.remove(busyClass);
    if (overlayEl) overlayEl.classList.add('hidden');
  }

  return { start, stop, ensure };
}
