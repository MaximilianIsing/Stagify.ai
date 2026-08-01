// Entry script for the Listing Studio (public/projects.html) — the client-side
// composition root, in the same shape as app.js / masking-studio-app.js: resolve the
// page's elements once, then construct and wire the islands under scripts/projects/.
//
// THE ACCESS GATE IS DONE HERE, NOT IN A HEAD SCRIPT. The other two studios ship a
// render-blocking `<script src>` gate so an anonymous visitor never sees the page. This
// one inverts it: projects.css hides the shell until `html.pj-ready` is set, so the
// gated state is the DEFAULT and JavaScript opens it. That is a stronger default (a
// stalled or failed check reveals nothing rather than everything) and it keeps
// test/frontend/head-scripts.test.js's blocking-script allowlist untouched. The
// stall-out redirect from the other gates is kept — never strand a signed-in user on a
// hidden page.
//
// THE OPEN LISTING IS IN THE URL (`?project=<id>`). It has to be: a run takes 45 minutes to
// two hours, and without it closing the tab — or a reload, or a shared link to a colleague —
// returned the operator to "No listing open" with no way back except the picker. Written
// with `history.replaceState` rather than pushState, so opening six listings does not put
// six entries in the back button.
//
// The page is internal and English-only for v1: no data-lang attributes, no language
// switcher, `noindex`, and not in the i18n page set. `localizedTarget` is still used for
// the redirect so a future localized variant cannot silently throw operators back to the
// English root. (public/projects.html does load language-loader.js, for exactly one reason:
// the unstageable rejection sentences already live in the packs and the shared reader looks
// them up there. No new keys, and nothing on the page is [data-lang]-translated.)
import {
  ApiError,
  cancelStaging,
  fetchImageBlobUrl,
  fetchProgress,
  fetchProject,
  fetchProjects,
  newProject,
  patchPhoto,
  postPhotos,
  regenerateBible,
  removePhoto,
  removeProject,
  retryRender,
  startStaging,
} from './projects/api.js';
import {
  groupByRoom,
  isProgressComplete,
  makeProjectsStore,
  progressPercent,
  progressSummary,
  roomsMissingBible,
} from './projects/state.js';
import {
  blockedSummary,
  stagePlan,
  stagePlanSummary,
} from './projects/summaries.js';
import { makeBlobRegistry, mountRenderGrid } from './projects/render-grid.js';
import { mountPhotoTray } from './projects/upload.js';
import { dropzoneHint } from './projects/intake.js';
import { drawPicker, projectLabel } from './projects/picker.js';
import { mountConfirmDialog } from './projects/dialog.js';
import { mountProgressPoller, shouldWatch } from './projects/polling.js';
import { mountSharePanel } from './projects/share-panel.js';
import { downloadZip } from './projects/download.js';
import { localizedTarget } from './i18n-routing.js';
import { showToast, showErrorToast } from './toast.js';

// Re-exported, not redefined: the poller owns its own timing (projects/polling.js) and
// several tests import these from here. One definition, two import paths.
export { POLL_INTERVAL_MS, MAX_EMPTY_POLLS } from './projects/polling.js';

/** Query parameter that remembers the open listing across a reload. */
export const PROJECT_PARAM = 'project';

/** Root element; its absence is how this module stays inert off its own page. */
const ROOT_ID = 'pj-root';

// Re-exported: it was defined here before the picker became its own module, and
// test/frontend/projects-app.test.js plus anything else importing it should not have to
// care which file it moved to.
export { projectLabel };

/**
 * What to do with the signed-in user, given their plan.
 *
 * Split out and exported because it is the whole security-relevant decision on this
 * page and the rest of the gate is redirects and class toggles. No user at all
 * (missing/expired token, or a failed /me) is a redirect, not an upgrade prompt: we do
 * not know who they are, so we cannot show them anything.
 * @param {{ plan?: string }|null|undefined} user
 * @returns {'redirect'|'upgrade'|'allow'}
 */
export function proAccessDecision(user) {
  if (!user) return 'redirect';
  return user.plan === 'pro' ? 'allow' : 'upgrade';
}

/**
 * The listing id in the current URL, or '' when there is none.
 *
 * Read off `location.search` by hand rather than with URLSearchParams so this stays
 * testable against the same minimal location stub the rest of the page uses. Ids are
 * 32 hex characters; anything longer or with other characters is ignored rather than
 * sent to the API, so a hand-edited URL cannot turn into a request.
 * @param {string} search - e.g. `'?project=abc123'`.
 * @returns {string}
 */
export function projectIdFromSearch(search) {
  const match = /[?&]project=([^&]*)/.exec(String(search || ''));
  if (!match) return '';
  const value = decodeURIComponent(match[1] || '');
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : '';
}

/** @param {string} id @returns {HTMLElement} */
function need(id) {
  return /** @type {HTMLElement} */ (document.getElementById(id));
}

/**
 * Wire the page. Exported so the boot below stays a one-liner and so a test can drive
 * it against a DOM stub instead of relying on import side effects.
 * @returns {void}
 */
export function initProjectsPage() {
  const root = document.getElementById(ROOT_ID);
  if (!root) return;

  const checking = need('pj-checking');
  const gate = need('pj-gate');
  const titleInput = /** @type {HTMLInputElement} */ (need('pj-title'));
  const addressInput = /** @type {HTMLInputElement} */ (need('pj-address'));
  const createBtn = /** @type {HTMLButtonElement} */ (need('pj-create'));
  const projectList = need('pj-project-list');
  const openTitle = need('pj-open-title');
  const openAddress = need('pj-open-address');
  const openStatus = need('pj-open-status');
  const deleteBtn = /** @type {HTMLButtonElement} */ (need('pj-delete'));
  const styleSelect = /** @type {HTMLSelectElement} */ (need('pj-style'));
  const removeFurniture = /** @type {HTMLInputElement} */ (need('pj-remove-furniture'));
  const variations = /** @type {HTMLSelectElement} */ (need('pj-variations'));
  const extraPrompt = /** @type {HTMLTextAreaElement} */ (need('pj-extra'));
  const stageBtn = /** @type {HTMLButtonElement} */ (need('pj-stage'));
  const cancelBtn = /** @type {HTMLButtonElement} */ (need('pj-cancel'));
  const downloadAllBtn = /** @type {HTMLButtonElement} */ (need('pj-download-all'));
  const progressWrap = need('pj-progress');
  const progressBar = need('pj-progress-bar');
  const progressText = need('pj-progress-text');
  const progressLive = need('pj-progress-live');
  const blockedLine = need('pj-blocked');
  const dropzoneSub = need('pj-dropzone-hint');

  const store = makeProjectsStore();

  // Two registries, deliberately: each surface releases everything in its own on
  // redraw, so sharing one would revoke the other's live thumbnails.
  const gridRegistry = makeBlobRegistry();
  const trayRegistry = makeBlobRegistry();

  /** @returns {string} */
  const projectId = () => {
    const current = store.get().project;
    return current ? current.id : '';
  };

  /** @param {unknown} error */
  function reportError(error) {
    const message =
      error instanceof ApiError ? error.message : 'Something went wrong. Please try again.';
    showErrorToast(message);
  }

  const dialog = mountConfirmDialog({
    root: need('pj-confirm'),
    title: need('pj-confirm-title'),
    body: need('pj-confirm-body'),
    yes: /** @type {HTMLButtonElement} */ (need('pj-confirm-yes')),
    no: /** @type {HTMLButtonElement} */ (need('pj-confirm-no')),
  });
  const ask = dialog.ask;
  mountSharePanel({ store, ask });

  // The limits copy is generated from the constants the validator actually uses, so the
  // dropzone cannot advertise a ceiling the server does not honour.
  if (dropzoneSub) dropzoneSub.textContent = dropzoneHint();

  // ── Islands ────────────────────────────────────────────────────────────────
  const grid = mountRenderGrid({
    root: need('pj-grid'),
    registry: gridRegistry,
    getProjectId: projectId,
    loadImage: (path) => fetchImageBlobUrl(path),
    onRegenerate: (roomKey, label) => {
      ask(
        'Regenerate this room’s look?',
        `Every existing render for ${label} will be superseded and re-run against a new look bible. Renders already downloaded are unaffected.`,
        'Regenerate',
        () => {
          regenerateBible(projectId(), roomKey)
            .then(() => {
              showToast('Re-running that room.');
              startPolling();
              return refresh();
            })
            .catch(reportError);
        }
      );
    },
    onRetry: (renderId) => {
      // No confirm: a retry costs one render and the alternative is a frame the operator
      // has already paid for and cannot use.
      retryRender(projectId(), renderId)
        .then(() => {
          showToast('Frame requeued.');
          startPolling();
          return refresh();
        })
        .catch(reportError);
    },
    onDownloadError: reportError,
  });

  const tray = mountPhotoTray({
    dropzone: need('pj-dropzone'),
    fileInput: /** @type {HTMLInputElement} */ (need('pj-file-input')),
    tray: need('pj-tray'),
    status: need('pj-tray-status'),
    bar: need('pj-upload-bar'),
    bulk: need('pj-bulk'),
    registry: trayRegistry,
    getProjectId: projectId,
    getPhotos: () => store.get().photos,
    loadImage: (path) => fetchImageBlobUrl(path),
    upload: async (files, onProgress) => {
      try {
        const result = await postPhotos(projectId(), files, onProgress);
        const duplicates = result.duplicates ? result.duplicates.length : 0;
        showToast(
          `Added ${result.photos.length} photo(s)${duplicates ? `, skipped ${duplicates} duplicate(s)` : ''}.`
        );
        await refresh();
      } catch (error) {
        reportError(error);
      }
    },
    onPatch: (photoId, fields) => {
      patchPhoto(projectId(), photoId, fields).then(refresh).catch(reportError);
    },
    // ONE refresh for the whole batch. Thirty single patches were thirty full re-reads and
    // thirty full redraws, each one rebuilding the tray the operator was working in.
    onBulkPatch: async (patches) => {
      const id = projectId();
      if (!id || !patches.length) return;
      try {
        for (const patch of patches) await patchPhoto(id, patch.photoId, patch.fields);
        showToast(`Updated ${patches.length} photo(s).`);
      } catch (error) {
        reportError(error);
      }
      await refresh();
    },
    onRemove: (photoId) => {
      ask('Remove this photo?', 'It leaves the listing along with any renders made from it.', 'Remove', () => {
        removePhoto(projectId(), photoId).then(refresh).catch(reportError);
      });
    },
    notify: (message, type) => showToast(message, type === 'error' ? 'error' : undefined),
  });

  // ── Rendering ──────────────────────────────────────────────────────────────

  /** @param {import('./projects/state.js').PjState} state */
  function drawOpenProject(state) {
    const project = state.project;
    root.classList.toggle('has-project', !!project);
    openTitle.textContent = project ? projectLabel(project) : 'No listing open';
    openAddress.textContent = project && project.address ? project.address : '';
    openStatus.textContent = project && project.status ? project.status : '';
    stageBtn.disabled = !project || !state.photos.length;
    deleteBtn.disabled = !project;
    // Nothing to zip until at least one render finished. Enabled off the renders we have
    // rather than the status, because a cancelled or partly-failed run still has frames
    // worth delivering.
    downloadAllBtn.disabled = !state.renders.some((render) => render.status === 'ok');
  }

  /** @param {import('./projects/state.js').PjState} state */
  function drawProgress(state) {
    const progress = state.progress;
    const running = !!progress && !isProgressComplete(progress);
    progressWrap.classList.toggle('hidden', !progress);
    progressBar.style.width = `${progressPercent(progress)}%`;
    progressWrap.setAttribute('aria-valuenow', String(progressPercent(progress)));
    progressText.textContent = progressSummary(progress);
    stageBtn.classList.toggle('is-running', running);
    // Cancel exists only while there is something left to cancel.
    cancelBtn.classList.toggle('hidden', !running);

    const blocked = blockedSummary(progress);
    blockedLine.textContent = blocked;
    blockedLine.classList.toggle('hidden', !blocked);
  }

  /** @param {import('./projects/state.js').PjState} state */
  function draw(state) {
    drawPicker({
      root: projectList,
      projects: state.projects,
      currentId: state.project ? state.project.id : '',
      onOpen: openProject,
    });
    drawOpenProject(state);
    drawProgress(state);
    tray.draw(state.photos);
    const groups = groupByRoom(state.photos, state.renders, state.bibles);
    grid.draw(groups);
    const missing = roomsMissingBible(groups);
    if (missing.length) {
      // Surfaced once per redraw as well as per room, so it is not only visible to
      // someone who happens to scroll to that room. `roomsMissingBible` now counts only
      // rooms with COMPLETED renders and no bible, so this can no longer claim "9 room(s)
      // rendered without a look bible" about a run that has produced nothing.
      progressText.textContent += ` · ${missing.length} room(s) rendered without a look bible`;
    }
  }

  store.subscribe(draw);

  // ── Loading ────────────────────────────────────────────────────────────────

  async function loadProjects() {
    try {
      const { projects } = await fetchProjects(50);
      store.set({ projects: projects || [] });
    } catch (error) {
      reportError(error);
    }
  }

  /**
   * Put the open listing in the URL, replacing rather than pushing.
   *
   * `replaceState` because opening five listings in a session is one task, not five
   * navigations; pushState would make the back button walk back through them. A browser
   * without History (or a stubbed one) is a no-op — the URL is a convenience, never a
   * dependency for state.
   * @param {string} id - '' clears the parameter.
   */
  function rememberInUrl(id) {
    const history = /** @type {any} */ (window).history;
    if (!history || typeof history.replaceState !== 'function') return;
    const path = String(window.location.pathname || '');
    const url = id ? `${path}?${PROJECT_PARAM}=${encodeURIComponent(id)}` : path;
    try {
      history.replaceState(null, '', url);
    } catch (e) { /* a sandboxed or file:// document — the page still works */ }
  }

  /** @param {string} id */
  async function openProject(id) {
    stopPolling();
    try {
      const detail = await fetchProject(id);
      const progress = detail.progress || null;
      poller.seed(progress);
      store.set({
        project: detail.project || null,
        photos: detail.photos || [],
        renders: detail.renders || [],
        bibles: detail.bibles || [],
        progress,
      });
      rememberInUrl(detail.project ? detail.project.id : '');
      if (shouldWatch(detail.project || null, progress)) startPolling();
    } catch (error) {
      reportError(error);
    }
  }

  /** Re-read the open listing. Used after every mutation. */
  async function refresh() {
    const id = projectId();
    if (id) await openProject(id);
  }

  // ── Progress polling ───────────────────────────────────────────────────────
  // The timer, the bounded retry, the live-region announcement and the backgrounded-tab
  // listener all live in projects/polling.js — read its header before changing any of it;
  // two of the rules in there exist because of loops that shipped.

  const poller = mountProgressPoller({ store, projectId, fetchProgress, reportError, refresh, progressLive });
  const startPolling = poller.start;
  const stopPolling = poller.stop;

  function teardown() {
    stopPolling();
    grid.destroy();
    tray.destroy();
  }
  window.addEventListener('pagehide', teardown);

  // ── Controls ───────────────────────────────────────────────────────────────
  createBtn.addEventListener('click', () => {
    const title = titleInput.value.trim();
    const address = addressInput.value.trim();
    if (!title) {
      showErrorToast('Give the listing a title.');
      titleInput.focus();
      return;
    }
    createBtn.disabled = true;
    newProject({ title, address })
      .then(async ({ project }) => {
        titleInput.value = '';
        addressInput.value = '';
        await loadProjects();
        if (project) await openProject(project.id);
        showToast('Listing created.');
      })
      .catch(reportError)
      .finally(() => {
        createBtn.disabled = false;
      });
  });

  stageBtn.addEventListener('click', () => {
    const id = projectId();
    if (!id) return;
    const variationCount = Math.max(1, Math.min(3, Number(variations.value) || 1));
    const options = {
      furnitureStyle: styleSelect.value,
      removeFurniture: removeFurniture.checked,
      variationCount,
      additionalPrompt: extraPrompt ? extraPrompt.value.trim().slice(0, 500) : '',
    };
    // PRE-FLIGHT. This used to fire immediately: no count, no time, no confirm — for a
    // 45-minute-to-two-hour run, on a page that already confirmed the far cheaper "remove
    // one photo". The count is computed the way the server enqueues (one render for each
    // room's hero, `variationCount` for every other frame), not as photos × variations.
    const plan = stagePlan(store.get().photos, variationCount);
    ask('Stage this listing?', stagePlanSummary(plan), 'Stage it', () => {
      stageBtn.disabled = true;
      startStaging(id, options)
        .then(async () => {
          showToast('Staging queued.');
          await refresh();
          startPolling();
        })
        .catch(reportError)
        // The button's real enabled state is "a listing is open and has photos", which
        // drawOpenProject owns. Re-asserting it here (rather than `disabled = false`)
        // stops the finally from overriding what the refresh just decided.
        .finally(() => drawOpenProject(store.get()));
    });
  });

  cancelBtn.addEventListener('click', () => {
    const id = projectId();
    if (!id) return;
    ask(
      'Cancel the rest of this run?',
      'Frames still queued are dropped. Anything already rendered is kept, and you can stage again afterwards.',
      'Cancel staging',
      () => {
        cancelStaging(id)
          .then(async () => {
            stopPolling();
            showToast('Remaining frames cancelled.');
            await refresh();
          })
          .catch(reportError);
      }
    );
  });

  downloadAllBtn.addEventListener('click', () => {
    const state = store.get();
    const id = projectId();
    if (!id) return;
    downloadAllBtn.disabled = true;
    downloadZip({ projectId: id, project: state.project })
      .then((filename) => showToast(`Saved ${filename}.`))
      .catch(reportError)
      .finally(() => drawOpenProject(store.get()));
  });

  deleteBtn.addEventListener('click', () => {
    const id = projectId();
    if (!id) return;
    ask(
      'Delete this listing?',
      'The listing, its photos and every render go with it. This cannot be undone.',
      'Delete',
      () => {
        removeProject(id)
          .then(async () => {
            stopPolling();
            store.reset();
            rememberInUrl('');
            await loadProjects();
            showToast('Listing deleted.');
          })
          .catch(reportError);
      }
    );
  });

  // ── Access gate ────────────────────────────────────────────────────────────
  const leave = () => window.location.replace(localizedTarget('stagify-plus.html'));

  function reveal() {
    checking.classList.add('hidden');
    document.documentElement.classList.add('pj-ready');
  }

  // Never strand a signed-in operator on a hidden page if the plan check stalls.
  const stallOut = window.setTimeout(() => {
    if (!document.documentElement.classList.contains('pj-ready')) leave();
  }, 9000);

  (async () => {
    const auth = window.StagifyAuth;
    if (!auth) {
      // auth.js is a module script earlier in document order and assigns the global
      // synchronously, so a miss means it failed to load — waiting cannot help.
      leave();
      return;
    }
    /** @type {{ plan?: string }|null} */
    let user = null;
    try {
      user = await auth.fetchMe();
    } catch (e) { /* treated as no user, below */ }
    const decision = proAccessDecision(user);
    clearTimeout(stallOut);
    if (decision === 'redirect') {
      leave();
      return;
    }
    reveal();
    if (decision === 'upgrade') {
      gate.classList.add('is-open');
      gate.setAttribute('aria-hidden', 'false');
      return;
    }
    await loadProjects();
    // Re-open whatever the URL names, AFTER the picker is populated so a stale or
    // foreign id fails as a plain 404 toast with the listings still on screen.
    const wanted = projectIdFromSearch(String(window.location.search || ''));
    if (wanted) await openProject(wanted);
  })();
}

// Boot only on the page that owns the markup. The `typeof document` guard is what lets
// the module be imported by test/frontend/projects-app.test.js — and by anything else
// that only wants its exported helpers — without a browser.
if (typeof document !== 'undefined') initProjectsPage();
