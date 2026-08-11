import { createGalleryNotice } from './gallery-notice.js';
import { unstageableMessage } from '../unstageable-message.js';
import { readStampOptions } from './stamp-style-row.js';

// How long a single staging request may run before the client gives up on it.
//
// There was no client timeout and no `server.setTimeout` either, so a provider that
// hung left the progress bar frozen at 70% for as long as the socket stayed open,
// with nothing to click. Generous on purpose: a Pro render is up to three variations,
// each of which may spend QUALITY_MAX_ATTEMPTS generations plus a vision review, and
// killing real work is worse than waiting. This is the "something is wrong" ceiling,
// not a target — the guides' old "refresh after a minute" advice was well inside the
// window where renders still finish normally.
//
// Declared above the docblock below on purpose: anything between a factory's JSDoc
// and its `export function` detaches the two, and test/frontend/island-deps-typed.js
// then reports the bag as untyped.
const STAGING_TIMEOUT_MS = 180000;

/**
 * The staging generation pipeline: builds the multipart request, drives the
 * progress-bar / loading-message state machine, honours the stageability
 * pre-check (fast-path reject + mid-flight abort), and maps server errors to
 * messages. Extracted from app.js; DOM refs, the shared upload/validation state
 * (as getters), lastEmptyRoomUrl (as a setter) and the messaging helpers are all
 * injected.
 *
 * @param {{
 *   stagePreview: HTMLImageElement,
 *   progress: HTMLElement | null,
 *   progressBar: HTMLElement | null,
 *   progressText: HTMLElement | null,
 *   loadingMessage: HTMLElement | null,
 *   processingPlaceholder: HTMLElement | null,
 *   roomSelect: { value: string } | null,
 *   styleSelect: { value: string } | null,
 *   additionalPrompt: HTMLTextAreaElement | null,
 *   furnitureRefs: { getFiles: () => File[], reset: () => void },
 *   FURNITURE_LIMIT: number,
 *   getStageValidation: () => Promise<{ valid: boolean, reason: string }> | null,
 *   getStageValidationResult: () => { valid: boolean, reason: string } | null,
 *   getHasProcessedImage: () => boolean,
 *   setLastEmptyRoomUrl: (url: string) => void,
 *   hideStagingLimitInViewer: () => void,
 *   hideStagingError: () => void,
 *   showBeforeView: () => void,
 *   isProUser: () => boolean,
 *   showStagingError: (message: string) => void,
 *   messageForDailyLimitResponse: (errorData: any) => string,
 *   showStagingLimitInViewer: (message: string) => void,
 *   galleryNotice?: { show: (gallery: any) => void, clear: () => void } | null,
 *   stagingTimeoutMs?: number,
 * }} deps - Progress/preview DOM, the room & style select handles, the
 *   furniture-reference island's handle, the shared upload-validation state as
 *   getters, the entry's error/limit messaging helpers, the optional
 *   saved-to-gallery notice, and (optionally) the request ceiling, which only a
 *   test overrides.
 * @returns {{ processWithAI: (imageFile: File) => Promise<string[]> }}
 */
export function createStagingPipeline(deps) {
  const {
    stagePreview, progress, progressBar, progressText, loadingMessage, processingPlaceholder,
    roomSelect, styleSelect, additionalPrompt, furnitureRefs, FURNITURE_LIMIT,
    getStageValidation, getStageValidationResult, getHasProcessedImage, setLastEmptyRoomUrl,
    hideStagingLimitInViewer, hideStagingError, showBeforeView, isProUser,
    showStagingError, messageForDailyLimitResponse, showStagingLimitInViewer,
    // Constructed here rather than injected from app.js, which is at 640 lines against a
    // 650 cap — three lines of wiring is not worth spending a quarter of what is left.
    // Still a dep, so a test injects a stub instead of needing the real viewer markup.
    //
    // The lookup is optional-chained because this default is evaluated at CONSTRUCTION,
    // and the existing pipeline specs hand in a minimal document shim with no
    // querySelector. A default parameter that reaches into the DOM has to survive the
    // DOM not being there; the island itself already treats a null container as a no-op.
    galleryNotice = createGalleryNotice({ container: document?.querySelector?.('.viewer-header') ?? null }),
    // Injectable so a test can drive the timeout without waiting three minutes.
    stagingTimeoutMs = STAGING_TIMEOUT_MS,
  } = deps;

  const cancelBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('stage-cancel-btn'));

  // The button is a bare stop glyph, so the hover tooltip is the only thing that tells a
  // sighted user what it does. data-lang-attr localizes exactly ONE attribute per element,
  // and it is spent on aria-label — so mirror that (already-translated) value into title
  // here, and again whenever the language changes. Optional-chained throughout because the
  // island's specs hand in a minimal document shim with no window and no real element.
  const syncCancelTooltip = () => {
    const label = cancelBtn?.getAttribute?.('aria-label');
    if (label) cancelBtn.title = label;
  };
  syncCancelTooltip();
  globalThis.window?.addEventListener?.('languagechange', syncCancelTooltip);

  async function processWithAI(imageFile) {
    hideStagingLimitInViewer();
    hideStagingError();

    stagePreview.classList.add('processing');
    showBeforeView();

    const formData = new FormData();
    formData.append('image', imageFile);
    formData.append('roomType', roomSelect?.value || 'Living room');
    formData.append('furnitureStyle', styleSelect?.value || 'standard');
    formData.append('additionalPrompt', additionalPrompt?.value || '');

    const removeFurnitureCheckbox = /** @type {HTMLInputElement} */ (document.getElementById('remove-furniture'));
    const removeChecked = removeFurnitureCheckbox?.checked || false;
    formData.append('removeFurniture', String(removeChecked));
    const keepFurnitureEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('keep-furniture'));
    formData.append('keepFurniture', (removeChecked && keepFurnitureEl?.value) ? keepFurnitureEl.value.trim() : '');

    // "Label as virtually staged" burns the disclosure into the delivered pixels.
    // DELIBERATELY OUTSIDE the isProUser() block below: it is available on every plan,
    // because a compliance control that only paying users get pushes everyone else into
    // publishing undisclosed staged photos. Moving these two lines into that block is the
    // easiest way to break this feature without breaking any obvious behaviour — the
    // server would just silently stop stamping for free accounts.
    const labelCheckbox = /** @type {HTMLInputElement} */ (document.getElementById('label-virtually-staged'));
    formData.append('labelVirtuallyStaged', String(labelCheckbox?.checked || false));
    // Which pre-rendered badge master the server composites. The server validates this
    // against lib/i18n/locales.js and falls back to English, so a stale value is harmless.
    formData.append('stampLang', localStorage.getItem('selectedLanguage') || 'english');
    // …and how it is drawn. Sent unconditionally, exactly like the flag above: the server
    // ignores both unless the flag is on, and reading them only when the row happens to be
    // visible would mean the values depended on the UI's state rather than the user's
    // choice. Both are re-validated server-side (allow-list + clamp).
    // Scoped to THIS modal's strip. index.html also carries the Basic Mask dialog's copy of
    // the same controls, and an unscoped read would return whichever comes first in the
    // markup — handing staging a style the user picked on a different screen, silently.
    const stampOptions = readStampOptions(document.getElementById('stamp-opts'));
    formData.append('stampStyle', stampOptions.style);
    formData.append('stampScale', String(stampOptions.scale));

    // INERT, deliberately kept. NOTHING writes these three localStorage keys — the
    // only keys ever set anywhere in public/ are stagifyAuthToken, selectedModel,
    // selectedLanguage, userId, msHelpSeen, stagifyBackgroundVideoTime and adm_ts —
    // so userRole and userReferralSource always reach prompt_logs.csv as
    // 'unknown'/'' and columns 5 and 6 (COL.PROMPT.ROLE / REFERRAL in
    // public/scripts/admin/analytics.js) carry no signal. Do not read them as data.
    //
    // The columns STAY regardless: analytics.js reads that CSV positionally, so
    // dropping them would shift EMAIL out from index 7 and corrupt every historical
    // row. The reads stay too, as the hook-up for onboarding capture if it is ever
    // built. `userEmail` is the exception that already works — the server overwrites
    // it with the session's address (virtual-staging-handler.js sets
    // req.body.authenticatedEmail), so the email column IS trustworthy.
    const userRole = localStorage.getItem('userRole') || 'unknown';
    const userReferralSource = localStorage.getItem('userReferralSource') || '';
    const userEmail = localStorage.getItem('userEmail') || '';
    formData.append('userRole', userRole);
    formData.append('userReferralSource', userReferralSource);
    formData.append('userEmail', userEmail);

    const tok = window.StagifyAuth && window.StagifyAuth.getToken();
    if (tok) formData.append('authToken', tok);

    const proPanel = document.getElementById('stagify-pro-panel');
    const proPanelUsable =
      proPanel &&
      !proPanel.classList.contains('hidden') &&
      window.getComputedStyle(proPanel).display !== 'none' &&
      window.getComputedStyle(proPanel).visibility !== 'hidden';
    if (isProUser() && proPanelUsable) {
      const modelSel = /** @type {HTMLSelectElement} */ (document.getElementById('stagify-model-select'));
      const varSel = /** @type {HTMLInputElement} */ (document.getElementById('stagify-variation-count'));
      if (modelSel) formData.append('model', modelSel.value || 'gpt-4o-mini');
      if (varSel) formData.append('variationCount', varSel.value || '1');
      const furnitureFiles = furnitureRefs.getFiles();
      if (furnitureFiles.length) {
        const n = Math.min(FURNITURE_LIMIT, furnitureFiles.length);
        for (let i = 0; i < n; i++) {
          formData.append('furnitureImage', furnitureFiles[i]);
        }
      }
    }

    // Pro: upload/prepare animation before fetch. Free: progress bar during fetch (no delay) for fast limit errors.
    const isProPlan = isProUser();

    const defaultLoadingLines = [
      'Finding the perfect furniture for you',
      'Staging your ideal room',
      'Selecting beautiful decor pieces',
      'Arranging furniture for maximum appeal',
      'Creating the perfect ambiance',
      'Enhancing your space with style',
      'Designing your dream interior',
      'Optimizing room layout and flow',
      'Adding finishing touches',
      'Bringing your vision to life',
    ];
    const loadingMessagesRaw = window.LanguageSystem?.getText('modal.staging.progress.loadingMessages');
    const messagesArray = Array.isArray(loadingMessagesRaw) ? loadingMessagesRaw : defaultLoadingLines;

    let progressInterval = null;
    let aiProgressInterval = null;
    let messageInterval = null;
    let phaseTimer = null;
    let isProcessingPhase = false;
    let currentProgress = 0;

    function clearStagingUiTimers() {
      if (progressInterval) clearInterval(progressInterval);
      if (aiProgressInterval) clearInterval(aiProgressInterval);
      if (messageInterval) clearInterval(messageInterval);
      if (phaseTimer) clearTimeout(phaseTimer);
      progressInterval = null;
      aiProgressInterval = null;
      messageInterval = null;
      phaseTimer = null;
      isProcessingPhase = false;
    }

    // Which failures have already put something on the user's screen.
    //
    // Most paths below paint their own message and then throw only to unwind, so
    // stageImage()'s catch must not paint a second one on top. The ones that throw
    // SILENTLY (AUTH_REQUIRED, FILE_TOO_LARGE, "no image data", a bare network
    // error) are the caller's to surface — and for years nothing did, so a desktop
    // session expiring mid-stage just made the progress bar vanish. Marking the
    // surfaced ones is what lets the catch tell the two apart, instead of guessing
    // by code and going silent on every code nobody thought to list.
    /** @param {any} err @returns {any} */
    function markSurfaced(err) {
      if (err && typeof err === 'object') err.stagingMessageShown = true;
      return err;
    }

    // Stageability pre-check came back invalid → tear the loading UI back down
    // and surface the reason. Thrown so stageImage()'s catch re-enables the
    // button; the message is already on screen via showStagingError.
    // Takes the whole verdict (not just its text) so the per-category copy is
    // resolved through the language pack in one place.
    /** @param {{ code?: string | null, reason?: string } | null} result */
    function rejectUnstageable(result) {
      clearStagingUiTimers();
      stagePreview.classList.remove('processing');
      loadingMessage.classList.add('hidden');
      progress.classList.add('hidden');
      progressBar.style.width = '0%';
      const message = unstageableMessage(result);
      showStagingError(message);
      const err = /** @type {Error & { code?: string }} */ (new Error(message));
      err.code = 'NOT_STAGEABLE';
      throw markSurfaced(err);
    }

    // Fast path: if the pre-check already finished (the usual case — it starts
    // at upload), honor a rejection NOW, before spending a generation. If it's
    // still in flight we don't wait: staging runs below while the check finishes
    // concurrently. Net cost of the check on a valid photo: zero added wait.
    if (getStageValidationResult() && getStageValidationResult().valid === false) {
      rejectUnstageable(getStageValidationResult());
    }

    // If the check is still running, watch it: the moment it rejects the photo,
    // ABORT the in-flight generation and stop the loading bar — don't wait for
    // the generation to finish. The fetch below is wired to this signal, and its
    // catch turns the abort into the friendly "not stageable" rejection.
    const genAbort = new AbortController();
    /** @type {{ valid?: boolean, code?: string | null, reason?: string } | null} */
    let validationRejection = null;
    if (getStageValidation() && !getStageValidationResult()) {
      getStageValidation().then((r) => {
        if (r && r.valid === false) {
          validationRejection = r;
          genAbort.abort();
        }
      });
    }

    // Three different things can abort this request and they must not be reported
    // the same way: a photo the pre-check refused, a request that ran past the
    // ceiling, and the user deciding to stop waiting. Without this the catch below
    // turned all of them into one generic network error.
    let timedOut = false;
    let userCancelled = false;
    const timeoutId = setTimeout(() => { timedOut = true; genAbort.abort(); }, stagingTimeoutMs);

    const onCancelClick = () => { userCancelled = true; genAbort.abort(); };
    if (cancelBtn) {
      cancelBtn.addEventListener('click', onCancelClick);
      cancelBtn.classList.remove('hidden');
    }
    /** Drop the timer and the button, whichever way this request ends. */
    const endWait = () => {
      clearTimeout(timeoutId);
      if (cancelBtn) {
        cancelBtn.removeEventListener('click', onCancelClick);
        cancelBtn.classList.add('hidden');
      }
    };

    /**
     * Turn an aborted fetch into the RIGHT error, painting a message where one is
     * wanted. Returns null when the caller already has its own handling.
     * @param {any} e - The error fetch rejected with.
     * @returns {any} The error to throw.
     */
    const explainAbort = (e) => {
      if (validationRejection) return null; // caller runs rejectUnstageable instead
      if (userCancelled) {
        // The user asked for this, so it is not a failure — throw only to unwind,
        // and mark it surfaced so the caller does not paint an error banner over a
        // deliberate action.
        const err = /** @type {Error & { code?: string }} */ (new Error('Staging cancelled.'));
        err.code = 'STAGING_CANCELLED';
        return markSurfaced(err);
      }
      if (timedOut) {
        const message = window.LanguageSystem?.getText('errors.stagingTimeout')
          || 'This is taking longer than usual and was stopped. Please try again.';
        showStagingError(message);
        const err = /** @type {Error & { code?: string }} */ (new Error(message));
        err.code = 'STAGING_TIMEOUT';
        return markSurfaced(err);
      }
      return e;
    };

    let response;
    if (isProPlan) {
      progress.classList.remove('hidden');
      progressBar.style.width = '0%';
      progressText.textContent =
        window.LanguageSystem?.getText('modal.staging.progress.uploading') || 'Uploading image…';

      loadingMessage.classList.remove('hidden');
      loadingMessage.textContent =
        window.LanguageSystem?.getText('modal.staging.progress.preparingAI') || 'Preparing AI model';

      currentProgress = 0;
      progressInterval = setInterval(() => {
        if (currentProgress < 15) {
          currentProgress += Math.random() * 3;
          progressBar.style.width = Math.min(currentProgress, 15) + '%';
        }
      }, 200);

      try {
        await new Promise((resolve) => setTimeout(resolve, 800));
      } catch (e) {
        clearStagingUiTimers();
        stagePreview.classList.remove('processing');
        loadingMessage.classList.add('hidden');
        progress.classList.add('hidden');
        throw e;
      }

      clearInterval(progressInterval);
      progressInterval = null;
      currentProgress = 25;
      progressBar.style.width = '25%';
      progressText.textContent =
        window.LanguageSystem?.getText('modal.staging.progress.preparingAI') || 'Preparing AI model…';

      phaseTimer = setTimeout(() => {
        isProcessingPhase = true;
        progressText.textContent =
          window.LanguageSystem?.getText('modal.staging.progress.staging') || 'AI is staging your room…';
        messageInterval = setInterval(() => {
          if (isProcessingPhase) {
            loadingMessage.textContent =
              messagesArray[Math.floor(Math.random() * messagesArray.length)];
          }
        }, 2000);
        loadingMessage.textContent = messagesArray[Math.floor(Math.random() * messagesArray.length)];
      }, 1000);

      aiProgressInterval = setInterval(() => {
        if (currentProgress < 70) {
          currentProgress += Math.random() * 2;
          progressBar.style.width = Math.min(currentProgress, 70) + '%';
        }
      }, 300);

      try {
        response = await fetch('/api/process-image', {
          method: 'POST',
          body: formData,
          signal: genAbort.signal,
        });
      } catch (e) {
        // Aborted because the pre-check rejected the photo mid-generation →
        // stop the bar and show the reason instead of a generic network error.
        // A timeout or a user cancel gets its own message for the same reason.
        endWait();
        if (validationRejection) rejectUnstageable(validationRejection);
        clearStagingUiTimers();
        stagePreview.classList.remove('processing');
        loadingMessage.classList.add('hidden');
        progress.classList.add('hidden');
        throw explainAbort(e) || e;
      }

      if (aiProgressInterval) {
        clearInterval(aiProgressInterval);
        aiProgressInterval = null;
      }
      currentProgress = Math.max(currentProgress, 75);
      progressBar.style.width = '75%';
      progressText.textContent =
        window.LanguageSystem?.getText('modal.staging.progress.staging') || 'AI is staging your room…';
    } else {
      progress.classList.remove('hidden');
      progressBar.style.width = '0%';
      progressText.textContent =
        window.LanguageSystem?.getText('modal.staging.progress.staging') || 'AI is staging your room…';

      loadingMessage.classList.remove('hidden');
      loadingMessage.textContent =
        window.LanguageSystem?.getText('modal.staging.progress.staging') || 'AI is staging your room…';

      currentProgress = 5;
      progressBar.style.width = '5%';
      isProcessingPhase = true;
      messageInterval = setInterval(() => {
        if (isProcessingPhase) {
          loadingMessage.textContent =
            messagesArray[Math.floor(Math.random() * messagesArray.length)];
        }
      }, 2000);

      aiProgressInterval = setInterval(() => {
        if (currentProgress < 70) {
          currentProgress += Math.random() * 2;
          progressBar.style.width = Math.min(currentProgress, 70) + '%';
        }
      }, 300);

      try {
        response = await fetch('/api/process-image', {
          method: 'POST',
          body: formData,
          signal: genAbort.signal,
        });
      } catch (e) {
        // Aborted because the pre-check rejected the photo mid-generation →
        // stop the bar and show the reason instead of a generic network error.
        // A timeout or a user cancel gets its own message for the same reason.
        endWait();
        if (validationRejection) rejectUnstageable(validationRejection);
        clearStagingUiTimers();
        stagePreview.classList.remove('processing');
        loadingMessage.classList.add('hidden');
        progress.classList.add('hidden');
        throw explainAbort(e) || e;
      }

      if (aiProgressInterval) {
        clearInterval(aiProgressInterval);
        aiProgressInterval = null;
      }
      currentProgress = Math.max(currentProgress, 75);
      progressBar.style.width = '75%';
    }

    // The request came back — whatever its status, the wait is over, so drop the
    // timeout and take the cancel button away before the response is unpacked.
    endWait();

    if (!response.ok) {
      clearStagingUiTimers();
      stagePreview.classList.remove('processing');
      loadingMessage.classList.add('hidden');
      progress.classList.add('hidden');
      progressBar.style.width = '0%';
      const errorData = await response.json().catch(() => ({}));
      if (errorData.code === 'AUTH_REQUIRED') {
        const authErr = /** @type {Error & { code?: string }} */ (new Error(errorData.error || 'Please sign in to stage images.'));
        authErr.code = 'AUTH_REQUIRED';
        throw authErr;
      }
      if (errorData.code === 'DAILY_LIMIT' || response.status === 429) {
        const limitMsg = messageForDailyLimitResponse(errorData);
        showStagingLimitInViewer(limitMsg);
        const limitErr = /** @type {Error & { code?: string }} */ (new Error(limitMsg));
        limitErr.code = 'DAILY_LIMIT';
        throw markSurfaced(limitErr);
      }
      if (errorData.code === 'FILE_TOO_LARGE') {
        throw new Error(
          window.LanguageSystem?.getText('errors.fileTooLarge') ||
            'File is too large. Please upload an image smaller than 25MB.'
        );
      }
      if (errorData.code === 'NO_IMAGE_GENERATED' || response.status === 422) {
        const msg = errorData.error || 'This image couldn\'t be staged. Please try a different photo of an interior room.';
        showStagingError(msg);
        const noImgErr = /** @type {Error & { code?: string }} */ (new Error(msg));
        noImgErr.code = 'NO_IMAGE_GENERATED';
        throw markSurfaced(noImgErr);
      }
      // The disclosure stamp fails closed, so the render actually succeeded and was then
      // withheld rather than shipped unlabelled. This MUST stay above the generic 500
      // branch below, which would otherwise report it as "Bad prompt inputted" — sending
      // the user off to rewrite a prompt that was never the problem.
      if (errorData.code === 'DISCLOSURE_STAMP_FAILED') {
        const msg =
          window.LanguageSystem?.getText('errors.disclosureStampFailed') ||
          errorData.error ||
          'We couldn\'t add the "virtually staged" label, so your image wasn\'t delivered. Untick that option to stage without it.';
        showStagingError(msg);
        const stampErr = /** @type {Error & { code?: string }} */ (new Error(msg));
        stampErr.code = 'DISCLOSURE_STAMP_FAILED';
        throw markSurfaced(stampErr);
      }
      const errMsg =
        response.status === 500
          ? window.LanguageSystem?.getText('errors.badPrompt') || 'Bad prompt inputted'
          : errorData.message ||
            errorData.error ||
            window.LanguageSystem?.getText('errors.processingFailed') ||
            'Processing failed';
      progress.classList.remove('hidden');
      progressBar.style.width = '0%';
      progressText.textContent =
        (window.LanguageSystem?.getText('modal.staging.progress.error') || 'Error: ') + errMsg;
      setTimeout(() => progress.classList.add('hidden'), 3000);
      throw markSurfaced(new Error(errMsg));
    }

    // Result gate: the pre-check ran concurrently with the (much longer)
    // generation, so it has finished by the time the image comes back. If it
    // rejected the photo, discard the freshly-staged image instead of showing
    // it. Normally getStageValidationResult() is already set, so the await is just a
    // safety net for a sub-second click and adds no real time.
    if (getStageValidation()) {
      const finalCheck = getStageValidationResult() || (await getStageValidation().catch(() => null));
      if (finalCheck && finalCheck.valid === false) {
        rejectUnstageable(finalCheck);
      }
    }

    let finalProgressInterval = setInterval(() => {
      if (currentProgress < 95) {
        currentProgress += Math.random() * 3;
        progressBar.style.width = Math.min(currentProgress, 95) + '%';
      }
    }, 150);

    const result = await response.json();
    setLastEmptyRoomUrl((result && typeof result.emptyRoom === 'string' && result.emptyRoom) ? result.emptyRoom : null);

    if (finalProgressInterval) {
      clearInterval(finalProgressInterval);
    }
    clearStagingUiTimers();

    if (result.user && window.StagifyAuth) {
      window.StagifyAuth.user = result.user;
      window.StagifyAuth.applyUserToUI();
    }

    const urls =
      result.images && result.images.length > 0
        ? result.images
        : result.image
          ? [result.image]
          : [];

    loadingMessage.classList.add('hidden');
    stagePreview.classList.remove('processing');

    progress.classList.remove('hidden');
    progressBar.style.width = '100%';
    progressText.textContent =
      window.LanguageSystem?.getText('modal.staging.progress.complete') || 'Complete!';

    if (result.success && urls.length > 0) {
      hideStagingLimitInViewer();
      // `result.gallery` is absent when the gallery is switched off (no object store) or
      // the caller was anonymous, and the notice stays silent for both. It is NOT a share
      // affordance: the bytes upload after this response, so the entry is still `pending`
      // and a link minted now would 404 — see gallery-notice.js.
      galleryNotice?.show(result.gallery);
      setTimeout(() => progress.classList.add('hidden'), 800);
      return urls;
    }

    if (processingPlaceholder && !getHasProcessedImage()) {
      processingPlaceholder.style.display = 'flex';
    }
    throw new Error(window.LanguageSystem?.getText('errors.noImageData') || 'No image data received');
  }

  return { processWithAI };
}
