// The guides page: the walkthrough tablist and the troubleshooting highlight.
//
// Each walkthrough tab mounts the self-hosted player (window.STAGIFY_DEMOS +
// SupademoPlayer) into its panel on first activation — no third-party embed.
//
// `initGuides` takes its document and window rather than reading the globals, so the
// spec can drive it against a stand-in. The auto-start at the bottom is what the page
// itself uses.

/** The demo keys, in the order the tablist presents them. */
const PANEL_ID = (key) => `guide-demo-${key}`;

/** @param {any} win @returns {string} The demo key named by the URL hash, or ''. */
export function demoFromHash(win) {
  const hash = (win && win.location && win.location.hash) || '';
  const match = /^#guide-demo-([a-z]+)$/.exec(hash);
  return match ? match[1] : '';
}

/**
 * Wire the guides page.
 * @param {{ doc?: Document, win?: Window }} [deps]
 */
export function initGuides({ doc = document, win = window } = {}) {
  initDemoPicker(doc, win);
  initOverviewHighlight(doc, win);
}

function demoByKey(win, key) {
  const data = /** @type {any} */ (win).STAGIFY_DEMOS && /** @type {any} */ (win).STAGIFY_DEMOS.demos;
  if (!data) return null;
  for (let i = 0; i < data.length; i++) {
    if (data[i].key === key) return data[i];
  }
  return null;
}

function mountPlayer(win, panel) {
  const player = /** @type {any} */ (win).SupademoPlayer;
  if (!panel || /** @type {any} */ (panel).__player || !player) return;
  const demo = demoByKey(win, panel.getAttribute('data-demo'));
  if (!demo) return;
  /** @type {any} */ (panel).__player = player.mount(panel, demo);
}

function initDemoPicker(doc, win) {
  const picker = doc.querySelector('.guide-demo-picker');
  if (!picker) return;

  const buttons = Array.prototype.slice.call(picker.querySelectorAll('[data-demo]'));
  if (!buttons.length) return;

  /** @type {Record<string, any>} */
  const panels = {};
  const keys = buttons.map((btn) => {
    const key = btn.getAttribute('data-demo');
    panels[key] = doc.getElementById(PANEL_ID(key));
    return key;
  });

  // Mount on first activation (panel is visible → correct sizing); if already
  // mounted, just recompute the callout position for the current box size.
  function loadPanel(key) {
    const panel = panels[key];
    if (!panel) return;
    if (panel.__player) panel.__player.reflow();
    else mountPlayer(win, panel);
  }

  /**
   * @param {string} key
   * @param {{ focus?: boolean, publish?: boolean }} [opts]
   */
  function setDemo(key, opts = {}) {
    if (!panels[key]) return;
    buttons.forEach((btn) => {
      const active = btn.getAttribute('data-demo') === key;
      btn.classList.toggle('guide-demo-picker__btn--active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      // Roving tabindex: the tablist is ONE tab stop, and the arrow keys move within
      // it. Six independent tab stops is what it was before, which is both the wrong
      // ARIA pattern and six presses to get past a decorative control.
      btn.setAttribute('tabindex', active ? '0' : '-1');
      if (active && opts.focus) btn.focus();
    });
    Object.keys(panels).forEach((k) => {
      const panel = panels[k];
      if (!panel) return;
      const active = k === key;
      panel.classList.toggle('is-active', active);
      panel.hidden = !active;
      if (active) {
        panel.classList.remove('is-entering');
        void panel.offsetWidth;
        panel.classList.add('is-entering');
      }
    });
    loadPanel(key);
    if (opts.publish) publishHash(win, key);
  }

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      setDemo(btn.getAttribute('data-demo'), { publish: true });
    });
  });

  // Arrow/Home/End, per the ARIA tabs pattern. Activation follows focus, which is the
  // right choice here: showing a panel is cheap and has no side effects.
  picker.addEventListener('keydown', (event) => {
    const key = /** @type {any} */ (event).key;
    const at = buttons.indexOf(/** @type {any} */ (doc).activeElement);
    if (at === -1) return;
    let next = -1;
    if (key === 'ArrowRight' || key === 'ArrowDown') next = (at + 1) % buttons.length;
    else if (key === 'ArrowLeft' || key === 'ArrowUp') next = (at - 1 + buttons.length) % buttons.length;
    else if (key === 'Home') next = 0;
    else if (key === 'End') next = buttons.length - 1;
    if (next === -1) return;
    /** @type {any} */ (event).preventDefault?.();
    setDemo(buttons[next].getAttribute('data-demo'), { focus: true, publish: true });
  });

  /**
   * Open whichever walkthrough the URL names.
   *
   * The HowTo structured data in guides.html advertises `#guide-demo-<key>` as the URL
   * of every step, so these links are already being served by search engines. The panel
   * they point at ships `hidden`, so without this the browser has nothing to scroll to
   * and the visitor gets the Free walkthrough whichever result they clicked.
   */
  function applyHash(opts = {}) {
    const key = demoFromHash(win);
    if (!key || !panels[key]) return false;
    // publish: false — the hash is already what we are reacting to.
    setDemo(key, { focus: opts.focus });
    // The browser tried to scroll here while the panel was still `hidden`, i.e. to
    // nothing. Now that it is visible, take it there.
    scrollTo(win, panels[key]);
    return true;
  }

  if (!applyHash()) loadPanel(keys[0]);
  win.addEventListener('hashchange', () => { applyHash({ focus: true }); });

  win.addEventListener('pageshow', (event) => {
    if (!(/** @type {any} */ (event).persisted)) return;
    // On bfcache restore, reposition whichever player is currently visible.
    Object.keys(panels).forEach((k) => {
      if (panels[k] && !panels[k].hidden) loadPanel(k);
    });
  });
}

/**
 * Reflect the open walkthrough in the URL so it can be copied and shared — the same
 * links the structured data publishes.
 *
 * replaceState, not `location.hash`: assigning the hash both scrolls the page out from
 * under the click and pushes a history entry, so six tab presses would mean six presses
 * of Back to leave the page.
 */
/** Bring a just-revealed panel into view, honouring reduced motion. */
function scrollTo(win, panel) {
  if (!panel || typeof panel.scrollIntoView !== 'function') return;
  let smooth = false;
  try {
    smooth = typeof win.matchMedia === 'function'
      && !win.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch { /* no matchMedia — jump, don't glide */ }
  panel.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
}

function publishHash(win, key) {
  try {
    const history = /** @type {any} */ (win).history;
    if (!history || typeof history.replaceState !== 'function') return;
    history.replaceState(null, '', `#${PANEL_ID(key)}`);
  } catch {
    // Some embedded browsers throw on replaceState; the tab still works.
  }
}

// When a topic card in the top grid is clicked, briefly highlight the matching
// troubleshooting card it scrolls down to, so it's obvious which one is relevant.
function initOverviewHighlight(doc, win) {
  const cards = doc.querySelectorAll('.guides-overview-card');
  if (!cards.length) return;

  function highlight(id) {
    const target = doc.getElementById(id);
    if (!target || String(target.className).indexOf('guides-trouble-card') === -1) return;
    const all = doc.querySelectorAll('.guides-trouble-card--highlight');
    for (let i = 0; i < all.length; i++) all[i].classList.remove('guides-trouble-card--highlight');
    // Force a reflow so re-clicking the same card restarts the pulse animation.
    void target.offsetWidth;
    target.classList.add('guides-trouble-card--highlight');
  }

  Array.prototype.forEach.call(cards, (card) => {
    card.addEventListener('click', () => {
      const href = card.getAttribute('href') || '';
      if (href.charAt(0) === '#') highlight(href.slice(1));
    });
  });

  function fromHash() {
    if (win.location.hash && win.location.hash.length > 1) highlight(win.location.hash.slice(1));
  }
  win.addEventListener('hashchange', fromHash);
  fromHash();
}

// Not started under test: the spec drives initGuides() with its own document.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initGuides());
  } else {
    initGuides();
  }
}
