/**
 * The staging generation pipeline: builds the multipart request, drives the
 * progress-bar / loading-message state machine, honours the stageability
 * pre-check (fast-path reject + mid-flight abort), and maps server errors to
 * messages. Extracted from app.js; DOM refs, the shared upload/validation state
 * (as getters), lastEmptyRoomUrl (as a setter) and the messaging helpers are all
 * injected.
 *
 * @param {any} deps
 * @returns {{ processWithAI: (imageFile: File) => Promise<string[]> }}
 */
export function createStagingPipeline(deps) {
  const {
    stagePreview, progress, progressBar, progressText, loadingMessage, processingPlaceholder,
    roomSelect, styleSelect, additionalPrompt, furnitureRefs, FURNITURE_LIMIT, DEFAULT_UNSTAGEABLE_MESSAGE,
    getStageValidation, getStageValidationResult, getHasProcessedImage, setLastEmptyRoomUrl,
    hideStagingLimitInViewer, hideStagingError, showBeforeView, isProUser,
    showStagingError, messageForDailyLimitResponse, showStagingLimitInViewer,
  } = deps;

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

    // Stageability pre-check came back invalid → tear the loading UI back down
    // and surface the reason. Thrown so stageImage()'s catch re-enables the
    // button; the message is already on screen via showStagingError.
    function rejectUnstageable(reason) {
      clearStagingUiTimers();
      stagePreview.classList.remove('processing');
      loadingMessage.classList.add('hidden');
      progress.classList.add('hidden');
      progressBar.style.width = '0%';
      showStagingError(reason || DEFAULT_UNSTAGEABLE_MESSAGE);
      const err = /** @type {Error & { code?: string }} */ (new Error(reason || DEFAULT_UNSTAGEABLE_MESSAGE));
      err.code = 'NOT_STAGEABLE';
      throw err;
    }

    // Fast path: if the pre-check already finished (the usual case — it starts
    // at upload), honor a rejection NOW, before spending a generation. If it's
    // still in flight we don't wait: staging runs below while the check finishes
    // concurrently. Net cost of the check on a valid photo: zero added wait.
    if (getStageValidationResult() && getStageValidationResult().valid === false) {
      rejectUnstageable(getStageValidationResult().reason);
    }

    // If the check is still running, watch it: the moment it rejects the photo,
    // ABORT the in-flight generation and stop the loading bar — don't wait for
    // the generation to finish. The fetch below is wired to this signal, and its
    // catch turns the abort into the friendly "not stageable" rejection.
    const genAbort = new AbortController();
    /** @type {{ valid?: boolean, reason?: string } | null} */
    let validationRejection = null;
    if (getStageValidation() && !getStageValidationResult()) {
      getStageValidation().then((r) => {
        if (r && r.valid === false) {
          validationRejection = r;
          genAbort.abort();
        }
      });
    }

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
        if (validationRejection) rejectUnstageable(validationRejection.reason);
        clearStagingUiTimers();
        stagePreview.classList.remove('processing');
        loadingMessage.classList.add('hidden');
        progress.classList.add('hidden');
        throw e;
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
        if (validationRejection) rejectUnstageable(validationRejection.reason);
        clearStagingUiTimers();
        stagePreview.classList.remove('processing');
        loadingMessage.classList.add('hidden');
        progress.classList.add('hidden');
        throw e;
      }

      if (aiProgressInterval) {
        clearInterval(aiProgressInterval);
        aiProgressInterval = null;
      }
      currentProgress = Math.max(currentProgress, 75);
      progressBar.style.width = '75%';
    }

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
        throw limitErr;
      }
      if (errorData.code === 'FILE_TOO_LARGE') {
        throw new Error(
          window.LanguageSystem?.getText('errors.fileTooLarge') ||
            'File is too large. Please upload an image smaller than 100MB.'
        );
      }
      if (errorData.code === 'NO_IMAGE_GENERATED' || response.status === 422) {
        const msg = errorData.error || 'This image couldn\'t be staged. Please try a different photo of an interior room.';
        showStagingError(msg);
        const noImgErr = /** @type {Error & { code?: string }} */ (new Error(msg));
        noImgErr.code = 'NO_IMAGE_GENERATED';
        throw noImgErr;
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
      throw new Error(errMsg);
    }

    // Result gate: the pre-check ran concurrently with the (much longer)
    // generation, so it has finished by the time the image comes back. If it
    // rejected the photo, discard the freshly-staged image instead of showing
    // it. Normally getStageValidationResult() is already set, so the await is just a
    // safety net for a sub-second click and adds no real time.
    if (getStageValidation()) {
      const finalCheck = getStageValidationResult() || (await getStageValidation().catch(() => null));
      if (finalCheck && finalCheck.valid === false) {
        rejectUnstageable(finalCheck.reason);
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
