// Resolution picker for the staged-result download (scripts/app.js).
//
// Plain exported factory — no app state. Owns both halves of the split button:
// "Download Result" keeps its original behaviour (full-size JPEG, no dimension
// suffix on the filename), and the caret beside it opens the resolution menu.
// Missing nodes degrade to no-ops so pages without the stage modal keep working.
//
// Sizes are multipliers of what the model actually produced (canvas1's natural
// dimensions), plus "Original" — the resolution of the photo the user uploaded.
// Every option is plain interpolation off the same canvas: upscaling adds no
// real detail, so each row shows its true pixel dimensions rather than implying
// otherwise.
//
// EVERY DOWNLOAD TRIES THE SERVER FIRST (resizeOnServer, POST /api/download-result):
// a canvas export can never carry the invisible Stagify provenance metadata
// (lib/image/output-metadata.js) the server embeds — browser canvas has no concept of
// EXIF/XMP passthrough, full stop, regardless of what bytes went in. resizeOnClient below
// is what every download did before that route existed, kept as the FAIL-OPEN fallback:
// a network hiccup costs a user their metadata for one download, never the download
// itself.

export const MULTIPLIERS = [2, 1, 0.5];
const JPEG_QUALITY = 0.92; // matches the plain Download Result path, and the server route's quality: 92

const t = (key, fallback) =>
  window.LanguageSystem?.getText?.(key) || fallback;

export const PROBE_TIMEOUT_MS = 1500;

/**
 * Whether canvas1 actually holds a staged result.
 *
 * An unsized <canvas> reports the HTML default 300x150, NOT 0, so a bare
 * `canvas.width > 0` reads "ready" before anything has ever been staged — which
 * is exactly how the download control first shipped enabled on a blank page.
 * The markup carries no width attribute until app.js assigns one, so require the
 * attribute to be present AND non-zero (reset assigns 0).
 *
 * @param {{ hasAttribute: (name: string) => boolean, width: number } | null | undefined} canvas - The staged-result canvas.
 * @returns {boolean} True only when a staged result has been drawn.
 */
export function canvasIsReady(canvas) {
  return !!canvas && canvas.hasAttribute('width') && canvas.width > 0;
}

/**
 * The menu's rows for a given staged-result size and original upload size.
 *
 * "Original" matches the upload's LONG EDGE rather than both dimensions: the
 * staged output's aspect ratio is a snapped Gemini bucket and may differ from the
 * upload's by a few percent, so forcing both would stretch the result. Each row
 * carries the exact target pixels, so a label can never promise a size the
 * download won't deliver.
 *
 * @param {number} width - Staged-result width in px.
 * @param {number} height - Staged-result height in px.
 * @param {{ width: number, height: number } | null} original - Original upload dimensions, or null when unmeasurable (drops the row).
 * @param {{ original: string, native: string }} labels - Localized "Original" / "native" strings.
 * @returns {Array<{ label: string, note: string, width: number, height: number }>} Rows, "Original" first when present.
 */
export function buildSizeRows(width, height, original, labels) {
  if (!width || !height) return [];
  const rows = [];
  if (original && original.width && original.height) {
    const factor = Math.max(original.width, original.height) / Math.max(width, height);
    rows.push({
      label: labels.original,
      note: '',
      width: Math.max(1, Math.round(width * factor)),
      height: Math.max(1, Math.round(height * factor)),
    });
  }
  for (const m of MULTIPLIERS) {
    rows.push({
      label: `${m}×`,
      note: m === 1 ? labels.native : '',
      width: Math.max(1, Math.round(width * m)),
      height: Math.max(1, Math.round(height * m)),
    });
  }
  return rows;
}

/**
 * Text for a row: the multiplier, with its note parenthesised when it has one.
 * @param {{ label: string, note: string }} row - A row from buildSizeRows.
 * @returns {string} e.g. "1× (native)" or "2×".
 */
export function rowLabelText(row) {
  return row.note ? `${row.label} (${row.note})` : row.label;
}

/**
 * Natural dimensions of an image source, or null when it can't be measured.
 *
 * Deliberately uses onload/onerror rather than img.decode(): decode() is tied to
 * the rendering pipeline and never settles while the tab is backgrounded or
 * throttled, which would leave the menu awaiting forever and simply never open.
 * The timeout is the same guarantee for any other stall — a missed probe costs
 * only the "Original" row, never the menu itself.
 *
 * @param {string} src - Image URL or data URL.
 * @param {number} [timeoutMs=PROBE_TIMEOUT_MS] - Give-up delay.
 * @returns {Promise<{ width: number, height: number } | null>}
 */
export function probeDimensions(src, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!src) { resolve(null); return; }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const img = new Image();
    img.onload = () => finish(
      img.naturalWidth && img.naturalHeight
        ? { width: img.naturalWidth, height: img.naturalHeight }
        : null
    );
    img.onerror = () => finish(null);
    img.src = src;
  });
}

/**
 * The client-side fallback: draw the finished result onto a (possibly resized) canvas
 * and export straight to JPEG. Everything download-menu.js did before server-side
 * resizing existed — kept as the path taken when resizeOnServer fails.
 * @param {HTMLCanvasElement} canvas - The staged-result canvas, already at its natural size.
 * @param {number} width - Target width in px.
 * @param {number} height - Target height in px.
 * @returns {string} A `data:image/jpeg;base64,...` URL.
 */
function resizeOnClient(canvas, width, height) {
  if (width === canvas.width && height === canvas.height) {
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY); // no resample needed
  }
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, width, height);
  return out.toDataURL('image/jpeg', JPEG_QUALITY);
}

/**
 * Ask the server to resize the CURRENT after-result to (width, height) and re-encode it as
 * JPEG with Stagify's invisible provenance metadata embedded. Takes its data source as a
 * parameter rather than a closure capture so it can be unit-tested without constructing a
 * whole download menu.
 * @param {() => string} getCurrentAfterSrc - Returns the currently-displayed after-result's
 *   data URL, or '' if there isn't one.
 * @param {number} width - Target width in px.
 * @param {number} height - Target height in px.
 * @returns {Promise<string>} A `data:image/jpeg;base64,...` URL.
 * @throws {Error} On any failure — callers fall back to resizeOnClient rather than surface this.
 */
export async function resizeOnServer(getCurrentAfterSrc, width, height) {
  const src = getCurrentAfterSrc();
  if (!src) throw new Error('no result to download');
  const token = window.StagifyAuth && window.StagifyAuth.getToken();
  const res = await fetch('/api/download-result', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: JSON.stringify({ image: src, width, height, authToken: token || undefined }),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.image) {
    throw new Error(data?.error || 'Could not prepare that download.');
  }
  return data.image;
}

/**
 * Wire the download-resolution split-button menu.
 * @param {{
 *   downloadBtn: HTMLElement | null,
 *   split: HTMLElement | null,
 *   toggle: HTMLElement | null,
 *   menu: HTMLElement | null,
 *   canvas: HTMLCanvasElement | null,
 *   getOriginalSrc: () => string,
 *   getCurrentAfterSrc?: () => string,
 *   buildFilename: (width?: number, height?: number) => string,
 * }} deps - The plain download button, split-button root, caret, menu container,
 *   the staged-result canvas, a getter for the original upload's source, an OPTIONAL
 *   getter for the current after-result's source (omitted → every download falls back to
 *   resizeOnClient, exactly today's behaviour, so existing callers keep working unchanged),
 *   and a filename builder (called with no args for the plain full-size download).
 * @returns {{ close: () => void }} Handle for closing the menu externally.
 */
export function createDownloadMenu(deps) {
  const { downloadBtn, split, toggle, menu, canvas, getOriginalSrc, getCurrentAfterSrc, buildFilename } = deps;
  if (!canvas) return { close() {} };

  const isReady = () => canvasIsReady(canvas);
  const getAfterSrc = getCurrentAfterSrc || (() => '');

  /**
   * The href for a download at (width, height): the server's tagged JPEG when available,
   * the client-side canvas export otherwise. See the file header for why this order.
   * @param {number} width
   * @param {number} height
   * @returns {Promise<string>}
   */
  async function resolveHref(width, height) {
    try {
      return await resizeOnServer(getAfterSrc, width, height);
    } catch {
      return resizeOnClient(canvas, width, height);
    }
  }

  /**
   * @param {string} href
   * @param {string} filename
   */
  function triggerDownload(href, filename) {
    const link = document.createElement('a');
    link.download = filename;
    link.href = href;
    link.click();
  }

  // Restores downloadBtn alone, WITHOUT going through the full syncEnabled() below — that
  // one also touches `split`, which is exactly the node this page may not have (see the
  // file header: "missing nodes degrade to no-ops"). syncEnabled() itself is still the one
  // used by downloadAt() further down, since anything that can call downloadAt only exists
  // once split/toggle/menu are already confirmed present.
  function restoreDownloadBtn() {
    /** @type {HTMLButtonElement} */ (downloadBtn).disabled = !isReady();
  }

  if (downloadBtn) downloadBtn.addEventListener('click', async () => {
    if (!isReady()) return;
    /** @type {HTMLButtonElement} */ (downloadBtn).disabled = true;
    try {
      triggerDownload(await resolveHref(canvas.width, canvas.height), buildFilename());
    } finally {
      restoreDownloadBtn();
    }
  });

  if (!split || !toggle || !menu) return { close() {} };

  function close() {
    menu.classList.add('hidden');
    split.classList.remove('open');
    toggle.setAttribute('aria-expanded', 'false');
  }

  /**
   * Rows for the current canvas + upload. The row maths lives in the pure
   * buildSizeRows above (unit-tested); this only supplies the live measurements.
   * @returns {Promise<Array<{ label: string, note: string, width: number, height: number }>>}
   */
  async function buildRows() {
    if (!isReady()) return [];
    const original = await probeDimensions(getOriginalSrc());
    return buildSizeRows(canvas.width, canvas.height, original, {
      original: t('modal.staging.downloadOriginal', 'Original'),
      native: t('modal.staging.downloadNative', 'native'),
    });
  }

  /**
   * Resize the staged result to the given pixels and download it as JPEG.
   * @param {number} width - Target width in px.
   * @param {number} height - Target height in px.
   */
  async function downloadAt(width, height) {
    if (!canvas.width) return;
    for (const btn of [downloadBtn, toggle]) { if (btn) /** @type {HTMLButtonElement} */ (btn).disabled = true; }
    try {
      triggerDownload(await resolveHref(width, height), buildFilename(width, height));
    } finally {
      syncEnabled();
    }
  }

  async function open() {
    const rows = await buildRows();
    if (!rows.length) return;
    menu.textContent = '';
    for (const row of rows) {
      const item = document.createElement('div');
      item.className = 'option download-size-option';
      item.setAttribute('role', 'menuitem');
      item.tabIndex = 0;

      const label = document.createElement('span');
      label.textContent = rowLabelText(row);
      const dims = document.createElement('span');
      dims.className = 'download-size-dims';
      dims.textContent = `${row.width} × ${row.height}`;
      item.append(label, dims);

      const choose = () => { downloadAt(row.width, row.height); close(); };
      item.addEventListener('click', choose);
      item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); }
      });
      menu.appendChild(item);
    }
    menu.classList.remove('hidden');
    split.classList.add('open');
    toggle.setAttribute('aria-expanded', 'true');
  }

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.classList.contains('hidden')) open(); else close();
  });

  // Both halves stay genuinely disabled until a staged result exists — the markup
  // ships them disabled, and this flips them the moment canvas1 is sized. Watching
  // the canvas's `width` attribute (it reflects `canvas.width = n`) keeps the
  // enable/disable rule in one place instead of threading a callback through every
  // site in app.js that stages, resets, or switches carousel version.
  function syncEnabled() {
    const ready = isReady();
    for (const btn of [downloadBtn, toggle]) {
      if (btn) /** @type {HTMLButtonElement} */ (btn).disabled = !ready;
    }
    split.classList.toggle('is-disabled', !ready);
    if (!ready) close();
  }
  syncEnabled();
  new MutationObserver(syncEnabled).observe(canvas, {
    attributes: true,
    attributeFilter: ['width'],
  });
  document.addEventListener('click', (e) => {
    if (!split.contains(/** @type {Node} */ (e.target))) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  return { close };
}
