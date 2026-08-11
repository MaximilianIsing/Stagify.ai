// Stagify.ai — Exterior Studio entry point.
//
// Composition root for public/exterior-studio.html: resolves which of the page's three
// views this visitor gets, then wires the photo → opt-in options → enhance → compare flow
// for the one view that has a tool in it.
//
// There is NO render-blocking head gate on this page, unlike every other Stagify+ page.
// See exterior-studio/access.js for why, and for the reminder that none of this is a
// security boundary — requireProAccount on POST /api/enhance-exterior is.

import { syncExteriorAccess } from './exterior-studio/access.js';
import { createControls } from './exterior-studio/controls.js';
import { createCompare } from './exterior-studio/compare.js';
import { createBusyOverlay } from './exterior-studio/busy-overlay.js';
import { enhanceExterior, EnhanceError } from './exterior-studio/enhance.js';
import { initStampStyleRow } from './app/stamp-style-row.js';
import { createStampOption } from './mask/stamp-option.js';
import { showToast, showErrorToast } from './toast.js';

/**
 * "Label as virtually staged" for this page: the checkbox, and the strip it reveals.
 *
 * Only `badgeFields()` is used. The other half of createStampOption — the round trip to
 * /api/stamp-image — is for surfaces whose finished pixels exist only in the browser; here
 * POST /api/enhance-exterior is already holding the photo, so the server stamps the render
 * before it comes back. That is also what makes the download, the compare slider and the
 * gallery master agree by construction rather than by three call sites remembering to.
 */
const STAMP_IDS = { checkboxId: 'ex-label-virtually-staged', optsId: 'ex-stamp-opts' };

const $ = (id) => document.getElementById(id);

/**
 * Translate a key, falling back to the English already in the markup.
 * @param {string} key - Dotted language-pack key.
 * @param {string} fallback - English to use when the pack cannot answer.
 * @returns {string} The resolved string.
 */
function tx(key, fallback) {
  const sys = window.LanguageSystem;
  return (sys && typeof sys.getText === 'function' && sys.getText(key, fallback)) || fallback;
}

function init() {
  const tool = $('ex-tool');
  if (!tool) return;

  // Paint from whatever auth state already exists, then again once /api/auth/me answers.
  // auth.js's applyUserToUI() calls syncExteriorAccess() on every later change, so
  // signing in or out from this page re-shapes it without a reload.
  syncExteriorAccess();
  if (window.StagifyAuth && typeof window.StagifyAuth.fetchMe === 'function') {
    // A failure here is not fatal: the page is already showing the public view, which is
    // the correct thing to show someone whose plan we could not confirm.
    Promise.resolve(window.StagifyAuth.fetchMe()).catch(() => {});
  }

  const els = {
    form: /** @type {HTMLFormElement | null} */ ($('ex-form')),
    file: /** @type {HTMLInputElement | null} */ ($('ex-file')),
    drop: $('ex-drop'),
    preview: $('ex-preview'),
    previewImg: /** @type {HTMLImageElement | null} */ ($('ex-preview-img')),
    photoCard: $('ex-replace'),
    photoThumb: /** @type {HTMLImageElement | null} */ ($('ex-photo-thumb')),
    photoHint: $('ex-photo-hint'),
    result: $('ex-result'),
    enhance: /** @type {HTMLButtonElement | null} */ ($('ex-enhance')),
    done: $('ex-done'),
    download: $('ex-download'),
    again: $('ex-again'),
  };
  if (!els.form || !els.file || !els.enhance) return;

  const compare = createCompare({
    root: /** @type {HTMLElement} */ ($('ex-compare')),
    before: /** @type {HTMLImageElement} */ ($('ex-compare-before')),
    after: /** @type {HTMLImageElement} */ ($('ex-compare-after')),
    range: /** @type {HTMLInputElement} */ ($('ex-compare-range')),
    valueText: (percent) => tx('exteriorStudio.result.rangeValue', '{percent}% enhanced').replace('{percent}', percent),
  });

  // Covers the uploaded photo while the render is out. It is the only feedback in this
  // column — the submit button lives in the other one.
  const busyOverlay = createBusyOverlay({ host: els.preview });

  /** @type {{ file: File | null, previewUrl: string, resultUrl: string, busy: boolean }} */
  const state = { file: null, previewUrl: '', resultUrl: '', busy: false };

  const controls = createControls({ root: els.form, onChange: () => refreshSubmit() });

  // Deliberately NOT part of `controls`. That island answers one question — what should
  // change about the property — and the submit button is gated on its answer. The badge is
  // not a change to the property, so ticking it alone must leave the button disabled:
  // otherwise a visitor could buy a render that does nothing but add a caption.
  const stampOption = createStampOption(STAMP_IDS);
  initStampStyleRow(STAMP_IDS);

  /**
   * The submit button is live only when there is a photo AND something to do to it.
   *
   * Both halves matter. Without a photo there is nothing to send; without a requested
   * change the server falls through to a generic correction pass, which is a real render,
   * really billed, that the visitor did not ask for and probably will not notice.
   *
   * The disabled button is the whole message — there is no standing hint underneath it
   * explaining itself, which read as clutter under a panel of unticked boxes.
   * @returns {void}
   */
  function refreshSubmit() {
    if (!els.enhance) return;
    const ready = !!state.file && controls.hasRequest();
    els.enhance.disabled = state.busy || !ready;
  }

  /** Release the object URL backing the current preview, if any. */
  function releasePreview() {
    if (state.previewUrl.startsWith('blob:')) URL.revokeObjectURL(state.previewUrl);
    state.previewUrl = '';
  }

  /**
   * Accept a chosen file: convert HEIC if needed, show it in the workspace and on the
   * toolbar's photo card, and re-evaluate the submit button.
   * @param {File | null | undefined} raw - The file the visitor picked or dropped.
   * @returns {Promise<void>}
   */
  async function acceptFile(raw) {
    if (!raw) return;
    let file = raw;
    // iPhones hand over HEIC, which no browser can paint and Gemini will not read. The
    // shared converter is already loaded on this page; if it is missing we still send the
    // original rather than refusing, and the server's mime allow-list has the last word.
    try {
      const heic = window.StagifyHeic;
      if (heic && heic.isHeic(file)) file = await heic.toDisplayableFile(file);
    } catch {
      /* fall through with the original file */
    }

    releasePreview();
    state.file = file;
    state.previewUrl = URL.createObjectURL(file);
    state.resultUrl = '';

    if (els.previewImg) els.previewImg.src = state.previewUrl;
    if (els.photoThumb) els.photoThumb.src = state.previewUrl;
    if (els.drop) els.drop.hidden = true;
    if (els.preview) els.preview.hidden = false;
    if (els.result) els.result.hidden = true;
    if (els.done) els.done.classList.add('hidden');
    // The toolbar's step 1 swaps its "upload on the right" hint for the photo card.
    els.photoCard?.classList.remove('hidden');
    if (els.photoHint) els.photoHint.hidden = true;
    refreshSubmit();
  }

  /**
   * Clear the PHOTO — the upload, the result, and every part of the workspace that shows
   * one — and leave the toolbar's options exactly as they are.
   *
   * There is deliberately no counterpart that also clears the options. "Start over" was
   * that, and it was the wrong offer: the answer someone has just given about what to
   * change is the part worth keeping, and a stray unticking is a click away in the toolbar
   * anyway. Every exit from a finished render comes through here.
   * @returns {void}
   */
  function clearPhoto() {
    releasePreview();
    state.file = null;
    state.resultUrl = '';
    if (els.file) els.file.value = '';
    if (els.drop) els.drop.hidden = false;
    if (els.preview) els.preview.hidden = true;
    if (els.result) els.result.hidden = true;
    if (els.done) els.done.classList.add('hidden');
    els.photoCard?.classList.add('hidden');
    if (els.photoHint) els.photoHint.hidden = false;
    refreshSubmit();
  }

  /**
   * Next photo, same request.
   *
   * The common case after a good render is a second shot of the SAME property wanting the
   * same treatment — the bins gone, the same sky — so the options stay and only the photo
   * is asked for.
   * @returns {void}
   */
  function enhanceAnother() {
    clearPhoto();
    els.file?.click();
  }

  /**
   * Flip the form between idle and working.
   * @param {boolean} busy - Whether a render is in flight.
   * @returns {void}
   */
  function setBusy(busy) {
    state.busy = busy;
    if (els.enhance) {
      els.enhance.textContent = busy
        ? tx('exteriorStudio.actions.working', 'Working on it…')
        : tx('exteriorStudio.actions.enhance', 'Enhance Exterior');
      // Move the key with the text, or the next language switch re-renders the button with
      // whichever label the markup last named — the trap custom-select.js shipped with.
      els.enhance.setAttribute(
        'data-lang',
        busy ? 'exteriorStudio.actions.working' : 'exteriorStudio.actions.enhance',
      );
    }
    // Driven from here rather than from the submit handler so that every exit — result,
    // error, or timeout — takes the overlay down with it. There is no second place that
    // can leave a spinner running over a photo.
    if (busy) busyOverlay.start(); else busyOverlay.stop();
    refreshSubmit();
  }

  // --- wiring ---------------------------------------------------------------

  els.file.addEventListener('change', () => { void acceptFile(els.file?.files?.[0]); });
  els.photoCard?.addEventListener('click', () => els.file?.click());
  els.drop?.addEventListener('click', () => els.file?.click());
  els.drop?.addEventListener('keydown', (e) => {
    // The dropzone is role="button", so it owes the keyboard the same activation.
    const key = /** @type {KeyboardEvent} */ (e).key;
    if (key === 'Enter' || key === ' ') { e.preventDefault(); els.file?.click(); }
  });
  ['dragenter', 'dragover'].forEach((type) => {
    els.drop?.addEventListener(type, (e) => {
      e.preventDefault();
      els.drop?.classList.add('is-drag-over');
    });
  });
  ['dragleave', 'drop'].forEach((type) => {
    els.drop?.addEventListener(type, () => els.drop?.classList.remove('is-drag-over'));
  });
  els.drop?.addEventListener('drop', (e) => {
    e.preventDefault();
    void acceptFile(/** @type {DragEvent} */ (e).dataTransfer?.files?.[0]);
  });

  els.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.busy) return;
    if (!state.file) {
      showToast(tx('exteriorStudio.upload.title', 'Drop an exterior photo here'), 'error');
      els.file?.click();
      return;
    }
    if (!controls.hasRequest()) {
      showToast(tx('exteriorStudio.enhanceHint', 'Pick at least one change, or describe one above.'), 'error');
      return;
    }

    setBusy(true);
    try {
      const body = await enhanceExterior({
        file: state.file,
        options: controls.read(),
        badge: stampOption.badgeFields(),
        token: window.StagifyAuth?.getToken?.() || null,
        tx,
      });

      state.resultUrl = body.image;
      compare.show(state.previewUrl, body.image);
      if (els.preview) els.preview.hidden = true;
      if (els.result) els.result.hidden = false;
      if (els.done) els.done.classList.remove('hidden');
      if (window.StagifyAuth && body.user) {
        window.StagifyAuth.user = body.user;
        window.StagifyAuth.applyUserToUI?.();
      }
    } catch (err) {
      showErrorToast(err instanceof EnhanceError
        ? err.message
        : tx('exteriorStudio.errors.generic', 'That photo could not be enhanced. Please try another shot of the property exterior.'));
    } finally {
      setBusy(false);
    }
  });

  els.download?.addEventListener('click', () => {
    if (!state.resultUrl) return;
    const a = document.createElement('a');
    a.href = state.resultUrl;
    a.download = 'stagify-exterior.webp';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  els.again?.addEventListener('click', enhanceAnother);
  refreshSubmit();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
