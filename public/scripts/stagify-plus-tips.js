/**
 * Info bubbles for the Compare-plans table on stagify-plus.html.
 *
 * WHY THERE IS A PORTAL AND NOT A CSS TOOLTIP
 * The obvious build — an absolutely-positioned span in the row, revealed by
 * `:hover`/`:focus-within` — cannot work here. Each row sits inside
 * `.sp-compare-scroll` (`overflow-x: auto`, and per spec a non-`visible` value on one
 * axis forces the other to `auto`, so it clips vertically too) nested in
 * `.sp-compare-table-wrap` (`overflow: hidden`, which is what rounds the card's
 * corners). A bubble above the first row or below the last would be cut off at the
 * card edge, and the top and bottom rows are exactly the ones a visitor reads first.
 *
 * So there is ONE bubble, appended to <body> and positioned `fixed` against the
 * trigger's viewport rect. It carries no accessible name of its own
 * (`aria-hidden`): the text it shows is a copy of the row's `.sp-tip-text` span,
 * which is `hidden` in the row and wired to the button with `aria-describedby` —
 * a directly-referenced hidden node is still announced, so assistive tech reads the
 * source and never this duplicate.
 *
 * The copy is read out of the DOM at show time rather than cached at startup,
 * because language-loader.js rewrites those spans whenever the visitor switches
 * language and a cached string would be stale in the second language.
 */

const MARGIN = 8;      // keep the bubble this far from the viewport edge
const GAP = 10;        // between the trigger and the bubble
const MIN_ABOVE = 120; // flip below the trigger if there is less room than this above

/** @type {HTMLElement | null} */
let pop = null;
/** @type {HTMLElement | null} */
let openFor = null;
let raf = 0;
/** Whether the gesture in flight came from a finger — see the click handler. */
let touchLast = false;

/** Build the single portal bubble, once, on first show. */
function ensurePop() {
  if (pop) return pop;
  const el = document.createElement('div');
  el.className = 'sp-tip-pop';
  // Hidden from the a11y tree on purpose — see the header. The real description is
  // the row's own span, reached through aria-describedby.
  el.setAttribute('aria-hidden', 'true');
  document.body.appendChild(el);
  pop = el;
  return el;
}

/**
 * The explanation belonging to a trigger: the span its aria-describedby points at.
 * @param {HTMLElement} btn
 * @returns {string}
 */
function textFor(btn) {
  const id = btn.getAttribute('aria-describedby');
  const source = id ? document.getElementById(id) : null;
  return source ? (source.textContent || '').trim() : '';
}

/**
 * Park the bubble against its trigger. Called on show and again on scroll/resize, so
 * it tracks rather than vanishing under a trackpad nudge — note that on this site the
 * scroller is <main>, not the window, which is why the scroll listener below captures.
 */
function place() {
  if (!pop || !openFor) return;
  const anchor = openFor.getBoundingClientRect();
  const box = pop.getBoundingClientRect();

  const below = anchor.top < Math.max(box.height + GAP, MIN_ABOVE);
  const top = below ? anchor.bottom + GAP : anchor.top - box.height - GAP;

  // Centre on the trigger, then clamp into the viewport. The arrow chases the trigger
  // afterwards, so a clamped bubble still points at the row it belongs to.
  const wanted = anchor.left + anchor.width / 2 - box.width / 2;
  const maxLeft = Math.max(MARGIN, window.innerWidth - box.width - MARGIN);
  const left = Math.min(Math.max(wanted, MARGIN), maxLeft);

  pop.classList.toggle('sp-tip-pop--below', below);
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
  pop.style.setProperty('--sp-tip-arrow', `${Math.round(anchor.left + anchor.width / 2 - left)}px`);
}

/** @param {HTMLElement} btn */
function show(btn) {
  const text = textFor(btn);
  if (!text) return;
  const el = ensurePop();
  if (openFor && openFor !== btn) openFor.setAttribute('aria-expanded', 'false');
  openFor = btn;
  btn.setAttribute('aria-expanded', 'true');
  el.textContent = text;
  // Measure BEFORE revealing: place() centres on the bubble's own width, and the
  // closed state is `visibility: hidden` rather than `display: none` precisely so it
  // still has one. Reveal after, or the first frame paints at the wrong x.
  place();
  el.classList.add('sp-tip-pop--open');
}

function hide() {
  if (openFor) openFor.setAttribute('aria-expanded', 'false');
  openFor = null;
  if (pop) pop.classList.remove('sp-tip-pop--open');
}

function reposition() {
  if (!openFor || raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    place();
  });
}

function init() {
  const buttons = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('.sp-tip-btn')]);
  if (!buttons.length) return;

  for (const btn of buttons) {
    btn.setAttribute('aria-expanded', 'false');

    // A tap is a whole sequence — pointerenter, pointerdown, focus, click — and three
    // of those four would open the bubble, so a naive `click` toggle CLOSES on the
    // first tap and the button looks dead. What decides the toggle is therefore the
    // state captured at pointerdown, before focus has had a chance to open anything.
    let wasOpen = false;

    btn.addEventListener('pointerenter', (e) => {
      if (/** @type {PointerEvent} */ (e).pointerType === 'touch') return;
      show(btn);
    });
    btn.addEventListener('pointerleave', (e) => {
      if (/** @type {PointerEvent} */ (e).pointerType === 'touch') return;
      hide();
    });
    btn.addEventListener('pointerdown', (e) => {
      touchLast = /** @type {PointerEvent} */ (e).pointerType === 'touch';
      wasOpen = openFor === btn;
    });
    btn.addEventListener('focus', () => show(btn));
    btn.addEventListener('blur', () => hide());
    btn.addEventListener('click', (e) => {
      // The button does nothing but reveal text, so a click must not submit, navigate,
      // or scroll the page to the top.
      e.preventDefault();
      // With a mouse the bubble is already open from hover and clicking it should not
      // take it away; only touch, which has no hover to leave, gets a second tap that
      // dismisses. Keyboard activation (detail 0) leaves the focus-opened bubble alone.
      if (touchLast && wasOpen) hide();
      else show(btn);
    });
  }

  document.addEventListener('keydown', (e) => {
    if (/** @type {KeyboardEvent} */ (e).key === 'Escape') hide();
  });
  // Capture, because the page's scroller is <main> and a scroll event on it does not
  // bubble to window.
  document.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
  // A tap anywhere else dismisses, which is the only way out on touch.
  document.addEventListener('pointerdown', (e) => {
    const target = /** @type {Node | null} */ (e.target);
    if (openFor && target && !openFor.contains(target)) hide();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
