// The strip of badge controls under "Label as virtually staged": four styles, a size
// slider, and the preview that shows what the two of them produce.
//
// WHY THE PREVIEW IS A SERVER IMAGE AND NOT CSS
// The whole value of a preview here is that it cannot be wrong. A CSS mock would need its
// own copy of the padding, the capsule radius, the size curve and the font — four things
// that would each drift from lib/image/stamp-disclosure.js without anything failing — and
// the person who found the drift would be an agent looking at a published listing photo.
// /api/disclosure-preview runs the real stamp, so the preview and the render are the same
// code by construction. See lib/image/disclosure-preview.js.
//
// The row's VALUES are read straight back out of the DOM by staging-pipeline.js via
// readStampOptions(), rather than being mirrored into module state here. One reader, one
// source: a mirror would be a second place for the submitted style to disagree with the
// selected one, and the failure would be silent — the user gets a badge they did not pick.

// The browser's copy of two server constants. It cannot import the real ones —
// lib/image/stamp-disclosure.js pulls in sharp — so these are pinned instead: the drift
// test in test/frontend/app/stamp-style-row.test.js imports both sides and fails if they
// stop agreeing, and it checks the slider's min/max/step in index.html against the same
// server range. Without that, widening STAMP_SCALE_MAX would leave the slider silently
// capped at the old value with nothing to show for it.
/** Must equal DEFAULT_STAMP_STYLE in lib/image/stamp-disclosure.js. */
export const FALLBACK_STYLE = 'dark';
/** Must equal STAMP_SCALE_DEFAULT in lib/image/stamp-disclosure.js. */
export const FALLBACK_SCALE = 1;

/** How long to sit still after a slider move before asking the server for a new preview. */
const PREVIEW_DEBOUNCE_MS = 180;

/**
 * The badge configuration the user has chosen, ready to post.
 *
 * Falls back to the defaults on any page without the row (the studios that reuse this
 * pipeline do not render it) and on a scale that is somehow not a number, so a caller can
 * always append the fields without checking.
 * @returns {{ style: string, scale: number }} The chosen style and size multiplier.
 */
export function readStampOptions() {
  const checked = /** @type {HTMLInputElement | null} */ (
    document.querySelector('.stamp-swatch__input:checked')
  );
  const slider = /** @type {HTMLInputElement | null} */ (document.getElementById('stamp-scale'));
  const scale = parseFloat(slider?.value ?? '');
  return {
    style: checked?.value || FALLBACK_STYLE,
    scale: Number.isFinite(scale) ? scale : FALLBACK_SCALE,
  };
}

/**
 * The URL of the preview for the current controls and the current UI language.
 *
 * Rebuilt from scratch every time rather than patched, so switching site language while
 * the modal is open cannot leave a preview captioned in the previous one.
 * @returns {string} A same-origin `/api/disclosure-preview?…` URL.
 */
function previewUrl() {
  const { style, scale } = readStampOptions();
  const lang = localStorage.getItem('selectedLanguage') || 'english';
  return `/api/disclosure-preview?lang=${encodeURIComponent(lang)}`
    + `&style=${encodeURIComponent(style)}&scale=${encodeURIComponent(String(scale))}`;
}

/**
 * Wire the row up: reveal it with the checkbox, keep the preview in step with the
 * controls, and keep the slider's announcement meaningful.
 *
 * Safe on pages without the row, and safe to call more than once — it is idempotent by
 * way of a marker on the container, because app.js initialises the stage modal from more
 * than one entry point and a second set of listeners would fire a second preview request
 * per keystroke.
 * @returns {void}
 */
export function initStampStyleRow() {
  const row = document.getElementById('stamp-opts');
  const checkbox = /** @type {HTMLInputElement | null} */ (
    document.getElementById('label-virtually-staged')
  );
  const image = /** @type {HTMLImageElement | null} */ (document.getElementById('stamp-preview-img'));
  if (!row || !checkbox || row.dataset.wired === 'true') return;
  row.dataset.wired = 'true';

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let pending;
  /**
   * Point the preview at the current configuration.
   *
   * Only while the row is visible: the browser fetches an <img> the moment its src is
   * set, so refreshing a hidden row would spend a request on a preview nobody asked to
   * see — including on page load, before the option is even switched on.
   * @returns {void}
   */
  function refreshPreview() {
    if (!image || row.hidden) return;
    const next = previewUrl();
    // Re-setting the same src re-decodes the image and flashes the popup for no reason.
    if (image.getAttribute('src') !== next) image.setAttribute('src', next);
  }

  /**
   * Refresh after the controls stop moving. Dragging the slider fires `input` per pixel;
   * a request each would be ~10 renders for one decision, and the intermediate ones are
   * never seen.
   * @returns {void}
   */
  function refreshSoon() {
    clearTimeout(pending);
    pending = setTimeout(refreshPreview, PREVIEW_DEBOUNCE_MS);
  }

  /**
   * Show or hide the whole strip. The checkbox is the only thing that governs it — the
   * controls configure an option that is off, which is nothing to configure.
   * @returns {void}
   */
  function syncVisibility() {
    row.hidden = !checkbox.checked;
    if (checkbox.checked) refreshPreview();
  }

  checkbox.addEventListener('change', syncVisibility);

  for (const input of row.querySelectorAll('.stamp-swatch__input')) {
    input.addEventListener('change', refreshPreview);
  }

  const slider = /** @type {HTMLInputElement | null} */ (document.getElementById('stamp-scale'));
  if (slider) {
    slider.addEventListener('input', () => {
      // The raw value is a multiplier ("1.3"), which is meaningless read aloud. A percentage
      // of the default size is the same information in the units the user is thinking in.
      slider.setAttribute('aria-valuetext', `${Math.round(parseFloat(slider.value) * 100)}%`);
      refreshSoon();
    });
  }

  // Rebuild on the way in as well as on change: the UI language is not one of this row's
  // controls, but it does change the badge, and nothing here is notified when it changes.
  const preview = row.querySelector('.stamp-preview');
  if (preview) {
    preview.addEventListener('pointerenter', refreshPreview);
    preview.addEventListener('focusin', refreshPreview);
  }

  syncVisibility();
}
