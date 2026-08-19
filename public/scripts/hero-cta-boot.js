// Keeps the two "stage a photo" buttons alive while scripts/app.js is no longer in the
// LCP window.
//
// WHY app.js MOVED. It is the largest thing the homepage used to download before it could
// paint: 38 modules, 267 KB of source, ~89 KB brotli, all fetched and compiled while the
// browser was trying to get the hero photo on screen. Almost none of it is reachable until
// somebody actually starts staging — the mask editor, the staging pipeline, the download
// menu, the version carousel. So it now loads from scripts/index-deferred.js after `load`,
// and this file — zero imports, a couple of hundred bytes — holds the entry points open in
// the meantime.
//
// THE WHOLE PROBLEM IS THE GAP. Between first paint and app.js arriving there is a window,
// short on a fast connection and not short on a slow one, in which #hero-upload is visible
// and does nothing. A visitor who clicks in that window must not be ignored: that is the
// primary call to action on the site, and "I clicked it and nothing happened" is a worse
// bug than a slower LCP. So a click here PULLS app.js in and then performs the action,
// rather than waiting for it.
//
// THE HOOK IS window.__stagifyOpenStaging, published by app/staging-entry.js
// (initStagingEntry, called near the end of app.js). Its presence is also how this file
// knows app.js has finished evaluating — there is no other signal, and `import()`
// resolving is not the same thing on the injected-tag path.
//
// AND app.js NO LONGER BINDS THESE BUTTONS. It used to do
// `[heroUpload, outroUpload].forEach(btn => btn.addEventListener('click', openFilePicker))`.
// That line is gone, because with this file also bound a single click would open the
// picker twice. app.js is index-only (every other page uses page-chrome.js), so this file
// is the only binder on the only page that has the buttons.

/** Resolves once app.js has evaluated. Started at most once. */
let appLoading = null;

function loadApp() {
  // The same module instance index-deferred.js injects later — the module map dedupes,
  // so whichever path gets there first wins and the other is free.
  //
  // The .catch() is not decoration. Without it, a failed fetch or a throw during app.js's
  // evaluation becomes an unhandled rejection AND leaves the pressed button stuck at
  // aria-busy="true" forever, which reads as a hung page rather than a failed one. With
  // it, the press simply does nothing — the same outcome the visitor would have had if
  // app.js had never been wired up, which is the honest floor here. Nothing is logged:
  // routes/, lib/ and this tree are under no-console, and the browser has already
  // reported the module failure in its own console.
  if (!appLoading) appLoading = import('./app.js').catch(() => null);
  return appLoading;
}

/**
 * Open the staging flow, pulling app.js in first if it has not arrived.
 *
 * @param {HTMLElement | null} btn the control that was pressed, for the busy state
 */
async function openStaging(btn) {
  if (typeof window.__stagifyOpenStaging === 'function') {
    window.__stagifyOpenStaging();
    return;
  }
  // aria-busy rather than a spinner or a disabled state: the button must stay focusable
  // and must not look broken, and this is normally a few hundred milliseconds at most.
  if (btn) btn.setAttribute('aria-busy', 'true');
  try {
    await loadApp();
    if (typeof window.__stagifyOpenStaging === 'function') window.__stagifyOpenStaging();
  } finally {
    if (btn) btn.removeAttribute('aria-busy');
  }
}

function init() {
  const buttons = ['hero-upload', 'outro-upload']
    .map((id) => document.getElementById(id))
    .filter(Boolean);

  for (const btn of buttons) {
    btn.addEventListener('click', () => openStaging(/** @type {HTMLElement} */ (btn)));
  }

  // A visitor who arrived on a deep link is already asking for the studio, so there is
  // nothing to defer — app/staging-entry.js consumes these fragments itself.
  if (location.hash === '#stage' || location.hash === '#basic-mask') {
    loadApp();
    return;
  }

  // Otherwise warm it on the first sign of a real person. Any of these means the page has
  // been seen and the LCP measurement is over, so the download is free from here on and a
  // later click finds app.js already in memory rather than paying for it then.
  // `{ once: true }` on each, and loadApp() is idempotent, so whichever fires first wins.
  for (const evt of ['pointerdown', 'keydown', 'scroll']) {
    document.addEventListener(evt, () => loadApp(), { once: true, passive: true });
  }
}

/* Loaded as a normal module tag in <head>, so this runs before DOMContentLoaded and the
   guard takes the addEventListener branch. Written in the guarded form anyway so the file
   is still correct if it is ever moved into index-deferred.js's after-`load` list. */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
