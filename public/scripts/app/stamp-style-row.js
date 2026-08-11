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
 *
 * SCOPED, because index.html now carries TWO of these strips — the staging modal's and the
 * Basic Mask dialog's. Reading them off the document would hand whichever one happens to
 * come first in the markup to both callers, and the bug would be silent: the user gets a
 * badge they configured on the other screen. Callers pass their own container; the
 * document-wide default is only for the single-strip case and for pages with none.
 * @param {ParentNode | null} [root] - The `.stamp-opts` element to read, or the document.
 * @returns {{ style: string, scale: number }} The chosen style and size multiplier.
 */
export function readStampOptions(root) {
  const scope = root || document;
  const checked = /** @type {HTMLInputElement | null} */ (
    scope.querySelector('.stamp-swatch__input:checked')
  );
  // By class, not by id: the two strips cannot share an id, and this is the one lookup
  // that would otherwise have to be told which page it is on.
  const slider = /** @type {HTMLInputElement | null} */ (scope.querySelector('.stamp-opts__size'));
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
 * @param {ParentNode | null} [root] - The strip whose values to read.
 * @returns {string} A same-origin `/api/disclosure-preview?…` URL.
 */
export function previewUrl(root) {
  const { style, scale } = readStampOptions(root);
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
 * per keystroke. That marker lives on the container, so it already scopes per instance.
 *
 * Parameterised for the second instance in the Basic Mask dialog. Everything inside is
 * found WITHIN the container rather than by document id, so the two differ only in the two
 * ids passed here.
 * @param {{ optsId?: string, checkboxId?: string }} [ids] - Container and checkbox ids;
 *   defaults are the staging modal's.
 * @returns {void}
 */
export function initStampStyleRow(ids = {}) {
  const { optsId = 'stamp-opts', checkboxId = 'label-virtually-staged' } = ids;
  const row = document.getElementById(optsId);
  const checkbox = /** @type {HTMLInputElement | null} */ (document.getElementById(checkboxId));
  if (!row || !checkbox || row.dataset.wired === 'true') return;
  const image = /** @type {HTMLImageElement | null} */ (row.querySelector('.stamp-preview__img'));
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
    const next = previewUrl(row);
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
    // Only where the checkbox declares itself the panel's trigger — the staging strip is a
    // plain revealed row, and claiming it is expandable would announce a widget that isn't.
    if (checkbox.hasAttribute('aria-expanded')) {
      checkbox.setAttribute('aria-expanded', checkbox.checked ? 'true' : 'false');
    }
    if (checkbox.checked) refreshPreview();
  }

  checkbox.addEventListener('change', syncVisibility);

  for (const input of row.querySelectorAll('.stamp-swatch__input')) {
    input.addEventListener('change', refreshPreview);
  }

  const slider = /** @type {HTMLInputElement | null} */ (row.querySelector('.stamp-opts__size'));
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
  // The Basic Mask panel shows its preview inline with no hover trigger, so the row itself
  // is the host there.
  const preview = row.querySelector('.stamp-preview') || row;
  preview.addEventListener('pointerenter', refreshPreview);
  preview.addEventListener('focusin', refreshPreview);

  syncVisibility();
}
