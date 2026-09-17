// The advertising opt-out control on privacy.html §16.3.
//
// WHY THIS EXISTS. scripts/gtag.js loads Google Ads and builds remarketing
// audiences, which under the CPRA is "sharing personal information for
// cross-context behavioral advertising". A policy that says so has to offer a way
// out, and this is it: a switch that writes the flag gtag.js checks before it
// configures anything. The policy text and this control are two halves of one
// promise — test/frontend/ad-tag-disclosure.test.js fails the build if the copy
// ever drifts back to denying the tag exists.
//
// GPC is the other half, and it is handled entirely in gtag.js: a browser sending
// `navigator.globalPrivacyControl` is opted out before this file is even parsed.
// This control is for everyone whose browser does not send that signal, and it is
// what lets the site rely on the opt-out-preference-signal route rather than
// posting a "Do Not Sell or Share" link into all six hand-copied site footers.
//
// PROGRESSIVE ENHANCEMENT. The markup ships a fallback paragraph naming the two
// routes that work without JavaScript (send GPC, or email us). This module
// replaces it only once it is running, so a visitor with scripts off is told the
// truth instead of being shown a dead button.

// Also declared in scripts/gtag.js, which cannot import from a module — see the
// note there. test/frontend/gtag-optout.test.js pins the two spellings together.
export const STORAGE_KEY = 'stagifyAdOptOut';

/**
 * Whether the manual opt-out is stored.
 *
 * A storage exception reads as NOT opted out, matching gtag.js: the tag loads in
 * that case, and this control must describe what actually happened rather than
 * what was preferred.
 *
 * @returns {boolean}
 */
function isOptedOut() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Write (or clear) the opt-out flag.
 *
 * @param {boolean} on
 * @returns {boolean} Whether the write actually landed. False means storage is
 *   unavailable, which the caller must surface — silently failing here would be a
 *   button that claims to have opted someone out and did nothing.
 */
function setOptedOut(on) {
  try {
    if (on) window.localStorage.setItem(STORAGE_KEY, '1');
    else window.localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

/** Whether gtag.js skipped itself on THIS page load. */
function taggedThisLoad() {
  return window.__gtagConfigured === true;
}

/**
 * Whether gtag.js withheld the tag because of where this visitor appears to be,
 * rather than because of anything they chose. Set by the region gate in gtag.js —
 * see THE REGION GATE there.
 *
 * @returns {boolean}
 */
function regionBlocked() {
  return window.__gtagRegionBlocked === true;
}

/**
 * Render the control into its container.
 *
 * Exported so the state machine can be driven directly by
 * test/frontend/ad-optout.test.js: the module wires itself on import, and a
 * page-module body runs exactly once per process, which would otherwise pin the
 * whole suite to whichever storage state happened to exist at import time.
 *
 * @param {HTMLElement} host
 */
export function render(host) {
  const out = isOptedOut();
  const gpc = navigator.globalPrivacyControl === true;
  host.textContent = '';

  const state = document.createElement('p');
  state.className = 'pp-optout-state';

  if (regionBlocked()) {
    // Checked before GPC because it is the stronger statement: a visitor here is
    // opted out whatever their browser sends and whatever this control stores, so
    // there is nothing to toggle and nothing they need to do.
    state.textContent = 'You appear to be in the EEA, the UK, or Switzerland, where '
      + 'we do not load advertising cookies at all. Nothing has been set in this '
      + 'browser and nothing has been sent to Google. No action is needed.';
    host.appendChild(state);
    return;
  }

  if (gpc) {
    // Nothing to toggle: the browser signal wins on every load, and offering a
    // button that cannot change the outcome would be misleading.
    state.textContent = 'Your browser is sending a Global Privacy Control signal, '
      + 'so advertising cookies are switched off on every page of this site. No '
      + 'further action is needed.';
    host.appendChild(state);
    return;
  }

  state.textContent = out
    ? 'You are opted out. Google Ads cookies are not loaded on this site in this browser.'
    : 'Advertising cookies are currently active in this browser.';
  host.appendChild(state);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pp-optout-btn';
  btn.textContent = out ? 'Turn advertising cookies back on' : 'Do not share my personal information';
  btn.addEventListener('click', () => {
    if (!setOptedOut(!out)) {
      state.textContent = 'This browser is blocking local storage, so your choice '
        + 'could not be saved. Email team@stagify.ai and we will action it, or turn on '
        + 'Global Privacy Control in your browser settings.';
      btn.remove();
      return;
    }
    render(host);
    const note = document.createElement('p');
    note.className = 'pp-optout-note';
    // Said plainly because it is the one thing a visitor could otherwise
    // reasonably misread: the tag on THIS page load has already run.
    note.textContent = !out && taggedThisLoad()
      ? 'Saved. The tag already loaded on this page — reload, and it will not load again.'
      : 'Saved.';
    host.appendChild(note);
  });
  host.appendChild(btn);
}

const host = document.getElementById('ad-optout');
if (host) render(/** @type {HTMLElement} */ (host));
