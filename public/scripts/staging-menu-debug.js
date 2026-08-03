// On-page debug overlay for the nav "Staging" dropdown. Behind ?navdebug=1, loaded
// by a dynamic import() from staging-menu.js, so a normal page load never fetches it.
//
// WHY THIS EXISTS. The menu closes/hides a second or so after being tapped on real
// phones, and NOTHING here reproduces it: Chromium/Pixel 5 and WebKit/iPhone 13, six
// pages, four widths, against the live site — the panel stays open and opaque for the
// full sample every time. What emulation cannot produce is exactly the list this
// logs: a collapsing URL bar (window + visualViewport resize), touchcancel /
// pointercancel from a finger that moved, scroll-into-view from a real focus, and
// backgrounding. So the phone has to report for itself.
//
// It answers ONE question first — is the panel CLOSED (data-open gone, i.e. some
// event ran close()) or merely INVISIBLE (still open, but opacity/visibility/geometry
// changed)? Those have completely different causes, and "hides away" does not say
// which. Every line is timestamped from the tap so the culprit is whatever sits
// immediately above the transition.
//
// Delete this file and its import once the bug is found.

/** @param {Element} root @param {Element} panel */
export function installStagingMenuDebug(root, panel) {
  const box = document.createElement('pre');
  box.setAttribute('aria-hidden', 'true');
  box.style.cssText = [
    'position:fixed', 'left:4px', 'right:4px', 'bottom:4px', 'max-height:46vh',
    'overflow:auto', 'margin:0', 'padding:6px 8px', 'z-index:2147483647',
    'background:rgba(0,0,0,.88)', 'color:#0f0', 'font:11px/1.35 ui-monospace,monospace',
    'white-space:pre-wrap', 'border-radius:6px', 'pointer-events:none',
  ].join(';');
  document.body.appendChild(box);

  const t0 = performance.now();
  /** @type {string[]} */
  const lines = [];
  /** @param {string} s */
  const log = (s) => {
    lines.push(`${String(Math.round(performance.now() - t0)).padStart(5)}ms ${s}`);
    if (lines.length > 40) lines.shift();
    box.textContent = lines.join('\n');
    box.scrollTop = box.scrollHeight;
  };

  /** @param {EventTarget|null} target */
  const name = (target) => {
    if (!(target instanceof Element)) return target === window ? 'window' : 'doc';
    const cls = String(target.className || '').split(' ')[0];
    const inside = target.closest('[data-staging-menu]') ? '*' : '';
    return `${inside}${target.tagName.toLowerCase()}${cls ? '.' + cls : ''}`;
  };

  log('ready — tap Staging. "open=false" means something CLOSED it.');

  new MutationObserver(() => {
    log(`>>> data-open = ${root.hasAttribute('data-open')}`);
  }).observe(root, { attributes: true, attributeFilter: ['data-open'] });

  // Capture phase, so this sees an event even if a handler stops it. pointerdown is
  // the one that closes the menu (staging-menu.js's onOutside), and the touch* and
  // *cancel events are the real-device-only ones worth having next to it.
  const EVENTS = ['pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend',
    'touchcancel', 'click', 'keydown', 'focusin', 'focusout'];
  for (const type of EVENTS) {
    document.addEventListener(type, (e) => {
      log(`${type} ${name(e.target)}`);
    }, true);
  }
  // Coalesced: a phone fires these in bursts and they would bury everything else.
  for (const [type, target] of /** @type {[string, EventTarget][]} */ ([
    ['scroll', document], ['resize', window], ['orientationchange', window],
    ['pageshow', window], ['visibilitychange', document],
  ])) {
    let pending = false;
    target.addEventListener(type, () => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        log(`${type} scrollY=${Math.round(window.scrollY)} innerH=${window.innerHeight}`);
      }, 120);
    }, true);
  }
  if (window.visualViewport) {
    let pending = false;
    window.visualViewport.addEventListener('resize', () => {
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        const vv = window.visualViewport;
        if (vv) log(`vv-resize h=${Math.round(vv.height)} offsetTop=${Math.round(vv.offsetTop)}`);
      }, 120);
    });
  }

  // The other half of the question: if it never closed, what changed visually?
  const el = /** @type {HTMLElement} */ (panel);
  let prev = '';
  setInterval(() => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const now = [
      root.hasAttribute('data-open') ? 'open' : 'shut',
      `op=${Number(cs.opacity).toFixed(2)}`, `vis=${cs.visibility}`, `disp=${cs.display}`,
      `xy=${Math.round(r.x)},${Math.round(r.y)}`, `wh=${Math.round(r.width)}x${Math.round(r.height)}`,
      `left=${el.offsetLeft}`,
    ].join(' ');
    if (now !== prev) {
      prev = now;
      log(now);
    }
  }, 100);
}
