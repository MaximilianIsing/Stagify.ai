// The guides page: the walkthrough tablist and the troubleshooting topic rail.
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
  initDemoFullscreen(doc);
  initTopicRail(doc, win);
}

/**
 * The fullscreen control on each walkthrough panel — the same affordance the home
 * page's showcase carries, on the six full-chrome walkthroughs.
 *
 * The panel itself is what goes fullscreen: it is the player's root, so the frame,
 * the callout card and the step dots travel together. The button toggles rather than
 * only entering, so the same control gets you back out — `aria-pressed` carries the
 * state, which means the label never changes and the i18n pack needs one key.
 *
 * @param {any} doc
 */
function initDemoFullscreen(doc) {
  const buttons = Array.prototype.slice.call(doc.querySelectorAll('[data-guide-fullscreen]'));
  if (!buttons.length) return;
  // Some embedding contexts disallow fullscreen outright. Hide the control instead of
  // shipping a button whose only behaviour is a rejected promise.
  if (!doc.fullscreenEnabled) {
    buttons.forEach((btn) => { btn.hidden = true; });
    return;
  }
  const panelOf = (btn) => btn.closest('.guide-demo-panel');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const panel = panelOf(btn);
      if (!panel) return;
      if (doc.fullscreenElement === panel) doc.exitFullscreen();
      // A rejection here is normal — a user gesture can be refused — and there is
      // nothing to recover, so swallow it rather than surfacing an unhandled rejection.
      else panel.requestFullscreen().catch(() => {});
    });
  });
  doc.addEventListener('fullscreenchange', () => {
    buttons.forEach((btn) => {
      const panel = panelOf(btn);
      const on = doc.fullscreenElement === panel;
      btn.classList.toggle('is-fs', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      // The callout card is placed in frame pixels and the frame just changed size —
      // re-place it, on the way in and again on the way out.
      if (panel && panel.__player) panel.__player.reflow();
    });
  });
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

/**
 * Keep the sticky topic rail pointing at the troubleshooting card you are reading.
 *
 * This replaces a one-shot highlight pulse fired by the old overview grid — six cards
 * that carried no text of their own beyond the titles of the six cards they linked to.
 * The rail is that navigation now, so it has to stay correct while you scroll rather
 * than flash once on click.
 */
function initTopicRail(doc, win) {
  const links = Array.prototype.slice.call(doc.querySelectorAll('.guides-rail__link'));
  if (!links.length) return;

  /** @type {Array<{ id: string, link: any, card: any }>} */
  const topics = [];
  for (const link of links) {
    const href = link.getAttribute('href') || '';
    if (href.charAt(0) !== '#') continue;
    const card = doc.getElementById(href.slice(1));
    // Same guard the highlight used: only a troubleshooting card is a rail target, so a
    // rail entry pointed at something else silently drops out instead of tracking it.
    if (!card || String(card.className).indexOf('guides-trouble-card') === -1) continue;
    topics.push({ id: href.slice(1), link, card });
  }
  if (!topics.length) return;

  let current = '';
  function mark(id) {
    if (id === current) return;
    current = id;
    for (const topic of topics) {
      const on = topic.id === id;
      topic.link.classList.toggle('is-current', on);
      if (on) topic.link.setAttribute('aria-current', 'true');
      else topic.link.removeAttribute('aria-current');
    }
  }

  // Click marks immediately. Waiting for the scroll to settle would leave the rail on
  // the previous topic for the whole smooth glide, which reads as a dead click.
  for (const topic of topics) {
    topic.link.addEventListener('click', () => mark(topic.id));
  }

  function fromHash() {
    const id = (win.location.hash || '').slice(1);
    if (topics.some((t) => t.id === id)) mark(id);
  }
  win.addEventListener('hashchange', fromHash);
  fromHash();

  // This page scrolls inside <main>, not the document, so "am I at the bottom" cannot
  // be asked of the window. Find the box that actually scrolls instead of naming it —
  // the rail should keep working if the page ever goes back to scrolling normally.
  const scrollport = (() => {
    for (let node = topics[0].card.parentElement; node; node = node.parentElement) {
      const overflowY = win.getComputedStyle(node).overflowY;
      if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1) return node;
    }
    return doc.scrollingElement || doc.documentElement;
  })();

  /**
   * The card being read is the LAST one whose top has passed the reading line — not
   * the first one intersecting the viewport. Those differ constantly: a card's tail is
   * still on screen well after the next card's heading has reached reading position,
   * so "topmost visible" spends most of the scroll naming the card you just finished.
   */
  function pick() {
    const viewport = win.innerHeight;
    const base = viewport * 0.3;
    const remaining = scrollport.scrollHeight - scrollport.clientHeight - scrollport.scrollTop;
    // The line starts 30% down the viewport and slides toward the bottom of it as the
    // page runs out of scroll. A FIXED line leaves the trailing cards unreachable —
    // there is not enough page left below them for their tops to climb that high, so
    // the rail parks on the second-to-last topic however far you scroll. Measured on
    // this page with a fixed line, the last two topics were current for 30px and 15px
    // of scroll; sliding it gives them 120px and 225px. Continuous at the handover:
    // when remaining === viewport - base, this is exactly base.
    const line = remaining >= viewport - base ? base : viewport - remaining;

    let chosen = null;
    for (const topic of topics) {
      if (topic.card.getBoundingClientRect().top <= line) chosen = topic;
    }
    // Above the first card, it is the next thing to be read — name it, not nothing.
    return chosen || topics[0];
  }

  // Driven by scroll, not by an IntersectionObserver. An observer reports crossings,
  // and the moment that matters most here is not a crossing: the page runs out of
  // scroll while the last card's top is still well below the reading line, so nothing
  // intersects differently over that final stretch and no callback ever arrives. The
  // rail would sit on the second-to-last topic no matter how far down you scrolled.
  //
  // Coalesced onto a frame, so a fling costs one recompute per paint rather than one
  // per scroll event, and mark() exits without touching the DOM when nothing moved.
  let queued = false;
  function update() {
    queued = false;
    mark(pick().id);
  }
  function onScroll() {
    if (queued) return;
    queued = true;
    if (typeof win.requestAnimationFrame === 'function') win.requestAnimationFrame(update);
    else update();
  }
  scrollport.addEventListener('scroll', onScroll, { passive: true });
  win.addEventListener('resize', onScroll);
  update();
}

// Not started under test: the spec drives initGuides() with its own document.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initGuides());
  } else {
    initGuides();
  }
}
