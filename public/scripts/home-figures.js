/* Stagify.ai — the two interactive figures on the home page.
 *
 *   #compare  — a savings calculator. Drag a listings-per-year slider and watch the
 *               traditional-staging cost climb against Stagify's $0.
 *   #ai-shift — the NAR adoption chart. Static: the bar and its numerals are the
 *               markup's own. All this adds is the legend highlight.
 *
 * WHY ONE MODULE. Both features want the same scaffolding — a reduced-motion check, a
 * play-once-when-in-view observer, and a rAF ramp driven by count-up.js's `rampValue`.
 * Only the calculator still uses the last two, but the pair stayed together because the
 * chart's legend is the other half of the same section's behaviour and a file per
 * widget is not worth it. index-inline.js already groups two unrelated homepage
 * behaviours.
 *
 * PROGRESSIVE ENHANCEMENT IS THE CONTRACT, not a nicety:
 *   - the chart's final segment widths live in `--seg-w` in the markup and its final
 *     numerals are the authored text, so with no JS at all it is already the finished
 *     chart and nothing here touches its appearance;
 *   - the calculator's authored text is the value at CALC.initial, so the pre-JS paint
 *     agrees with the first render. test/frontend/home-figures.test.js pins both.
 */

import { rampValue } from "./count-up.js";
import { initNarYears } from "./home-nar-years.js";

/** The calculator's one-time intro ramp. Dragging never ramps — see initCalculator. */
const CALC_INTRO_MS = 1200;

/* ==========================================================================
   Pure model — no DOM, unit-tested directly by test/frontend/home-figures.test.js
   ========================================================================== */

/**
 * The calculator's single source of truth. index.html's slider attributes and its
 * authored fallback text are both pinned to these numbers by the drift test, so
 * changing one here fails the build until the markup follows.
 *
 * `costPerHome` is the LOW end of the range the old comparison table quoted
 * ("$2,000–$5,000+ per home", still in the packs as home.compare.rows.cost.trad) —
 * deliberately the conservative figure, since the number is the whole argument.
 *
 * `weeksPerHome: 2` IS LOAD-BEARING. Being even is what keeps weeksFor() off 1 at every
 * point of the range, and so keeps the `{n} weeks` string out of singular territory in
 * all 11 language packs — none of which ship a one/other pair. An ODD weeksPerHome would
 * put "1 week" on screen at the floor and make ten translations quietly ungrammatical.
 * The slider floor does not carry this; the multiplier does.
 */
export const CALC = Object.freeze({
  min: 1,
  max: 20,
  initial: 5,
  costPerHome: 2000,
  weeksPerHome: 2,
});

/**
 * @param {unknown} value
 * @returns {number} an integer within [CALC.min, CALC.max]
 */
export function clampListings(value) {
  // A blank or absent value means "no slider state", not "zero listings" — Number('')
  // and Number(null) are both 0, which would clamp to the minimum and silently disagree
  // with the markup's authored fallback.
  if (value === "" || value === null || value === undefined) return CALC.initial;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return CALC.initial;
  return Math.min(Math.max(n, CALC.min), CALC.max);
}

/** @param {number} listings */
export function costFor(listings) {
  return listings * CALC.costPerHome;
}

/** @param {number} listings */
export function weeksFor(listings) {
  return listings * CALC.weeksPerHome;
}

/**
 * The week count to display at intro-ramp progress `t` (0 → 1).
 *
 * Ramps from the FLOOR, not from zero. weeksPerHome keeps every *settled* value even and
 * so never 1, but the intro ramp paints ~60 intermediate values, and counting up from 0
 * walks through 1 on the way — the exact form ten languages have no singular for.
 * Starting at weeksFor(CALC.min) keeps every frame at or above that floor and lands
 * exactly on target.
 *
 * @param {number} target the settled week count
 * @param {number} t ramp progress, 0 → 1
 */
export function weeksAtRamp(target, t) {
  const floor = weeksFor(CALC.min);
  return floor + rampValue(Math.max(target - floor, 0), t);
}

/**
 * Substitute the count into a translated template. Uses `{n}`, the convention already
 * used by ~43 keys in the packs (maskingStudio.areaName = "Area {n}"). The placeholder
 * — rather than concatenation — is what lets ja/zh write "{n}週間" / "{n}周" with no
 * space and lets ru reorder it entirely.
 *
 * A template that has lost its placeholder comes back unchanged rather than throwing:
 * a translator's slip must not take the page down (e2e/index.spec.js fails the build on
 * any pageerror).
 *
 * @param {string} template
 * @param {number} n
 */
export function fillCount(template, n) {
  return String(template).replace("{n}", String(n));
}

/** Memoised formatter. Rebuilt only when the tag changes, so a 60-frame count-up does
 *  not construct 60 Intl.NumberFormat instances. Keyed on the resolved tag, so
 *  formatCurrency stays a pure function of its arguments. */
let fmtTag;
/** @type {((n: number) => string) | null} */
let fmtFn = null;

/**
 * @param {string|undefined} tag
 * @returns {(n: number) => string}
 */
function buildCurrencyFormatter(tag) {
  // Annotated rather than inferred: a bare object literal widens `style` to `string`,
  // which does not satisfy Intl.NumberFormatOptions' keyof-registry union.
  /** @type {Intl.NumberFormatOptions} */
  const opts = { style: "currency", currency: "USD", maximumFractionDigits: 0 };
  /** @type {Intl.NumberFormatOptions} */
  const narrow = { ...opts, currencyDisplay: "narrowSymbol" };
  // In descending order of niceness. `currencyDisplay: 'narrowSymbol'` is what gives
  // "$48,000" instead of "US$48,000" / "USD 48.000", but it throws on Safari < 14.1.
  // A malformed tag throws in both of the first two, hence the third.
  const attempts = [
    () => new Intl.NumberFormat(tag, narrow),
    () => new Intl.NumberFormat(tag, opts),
    () => new Intl.NumberFormat(undefined, opts),
  ];
  for (const make of attempts) {
    try {
      const nf = make();
      return (n) => nf.format(n);
    } catch (_err) {
      /* try the next one */
    }
  }
  // Only reachable on a browser with no usable Intl at all. An uncaught throw anywhere
  // in here would fail e2e/index.spec.js's zero-pageerror gate, so always return a
  // string rather than letting the caller see the failure.
  return (n) => "$" + Math.round(n).toLocaleString("en-US");
}

/**
 * Format a USD amount for the language the page is actually being read in.
 *
 * @param {number} amount
 * @param {string} [locale] a BCP-47 tag; blank/absent means the runtime default
 */
export function formatCurrency(amount, locale) {
  // `new Intl.NumberFormat('')` throws RangeError, so a blank tag must become
  // `undefined`, never ''. An unknown-but-well-formed tag ('zz') does not throw.
  const tag = typeof locale === "string" && locale.trim() ? locale.trim() : undefined;
  if (fmtFn === null || fmtTag !== tag) {
    fmtFn = buildCurrencyFormatter(tag);
    fmtTag = tag;
  }
  return fmtFn(amount);
}

/* ==========================================================================
   Shared DOM helpers
   ========================================================================== */

function prefersReducedMotion() {
  return Boolean(
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * How much of an element has to be showing before its animation plays.
 *
 * `bottomPct` lifts the trigger line UP off the bottom edge of the scrollport (the
 * observer's negative bottom rootMargin) and `threshold` is the share of the element
 * that must be inside what is left.
 *
 * @typedef {{ threshold: number, bottomPct: number }} ViewGate
 */
/** @type {ViewGate} */
const DEFAULT_GATE = { threshold: 0.15, bottomPct: 5 };

/**
 * The trigger line for `gate`, in client coordinates: the scrollport's bottom edge,
 * lifted by `bottomPct`.
 *
 * @param {{ top: number, bottom: number }} band
 * @param {ViewGate} gate
 */
function triggerLine(band, gate) {
  return band.bottom - ((band.bottom - band.top) * gate.bottomPct) / 100;
}

/**
 * The element the page actually scrolls in, or null for the viewport.
 *
 * THE HOMEPAGE DOES NOT SCROLL THE WINDOW. `<main>` is the scroll container
 * (`overflow-y: auto`, ~8800px of content in a ~740px box) and `window.scrollY` is
 * pinned at 0 for the entire page. So the box content is clipped to is main's border
 * box — on a 900px viewport that is roughly [89, 831], NOT [0, 900]. Measuring against
 * `window.innerHeight`, or letting the observer default to `root: null`, silently
 * budgets ~70px of headroom that does not exist and fires animations below the last
 * visible pixel. Everything here resolves this once and hands it to both call sites.
 *
 * @param {Element} el
 * @returns {Element|null}
 */
function scrollRootOf(el) {
  let node = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    const oy = getComputedStyle(node).overflowY;
    if (oy === "auto" || oy === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * The client-coordinate band `root` actually paints — its border box, or the viewport.
 *
 * @param {Element|null} root
 */
function viewportBand(root) {
  if (root) {
    const r = root.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom };
  }
  const vh = window.innerHeight || document.documentElement.clientHeight;
  return { top: 0, bottom: vh };
}

/**
 * The share of `el` inside the gate's band — the same ratio the observer below
 * thresholds on, so the synchronous fast path and the observer agree.
 *
 * @param {Element} el
 * @param {ViewGate} gate
 * @param {Element|null} root
 */
function viewRatio(el, gate, root) {
  const r = el.getBoundingClientRect();
  const band = viewportBand(root);
  const overlap = Math.min(r.bottom, triggerLine(band, gate)) - Math.max(r.top, band.top);
  return Math.max(overlap, 0) / (r.height || 1);
}

/**
 * Has `el` reached its trigger line — or gone straight past it?
 *
 * THE SECOND HALF IS NOT OPTIONAL. `entry.intersectionRatio` is a sample, not a
 * history: a 16px bar crossing a 0.5 threshold occupies an 8px window, and a brisk
 * wheel scroll moves ~40px per frame, so the observer can be handed a ratio of 0 on
 * both sides and the animation never runs at all — leaving the bar blanked forever.
 * Re-measuring live geometry and treating "already above the band" as reached makes
 * the trigger impossible to outrun, at the cost of the animation sometimes playing
 * off screen, which is the strictly better failure.
 *
 * @param {Element} el
 * @param {ViewGate} gate
 * @param {Element|null} root
 */
function reached(el, gate, root) {
  const r = el.getBoundingClientRect();
  const band = viewportBand(root);
  if (r.bottom <= band.top) return true; // scrolled clean past
  return viewRatio(el, gate, root) >= gate.threshold;
}

/**
 * Run `fn` once, as soon as `el` is far enough into the scrollport for `gate`.
 *
 * DELIBERATELY ITS OWN OBSERVER, not a watch on home-reveal.js's `.is-visible` class.
 * That script's showAll() fallback (home-reveal.js, no-IO / reduced-motion path) adds
 * the class to EVERY `.reveal` on the page at once, so keying off it would fire this
 * for a card 4000px below the fold and the visitor would scroll down to an animation
 * that had already finished. Same shape home-text-animate.js uses.
 *
 * @param {Element} el
 * @param {() => void} fn
 * @param {ViewGate} [gate]
 */
function playWhenInView(el, fn, gate = DEFAULT_GATE) {
  // An explicit element root, so rootMargin is a percentage OF THE SCROLLPORT rather
  // than of a viewport the content never reaches the bottom of.
  const root = scrollRootOf(el);
  if (reached(el, gate, root) || !("IntersectionObserver" in window)) {
    fn();
    return;
  }
  const observer = new IntersectionObserver(
    () => {
      // The entries are only a nudge to look; `reached` is the decision.
      if (!reached(el, gate, root)) return;
      observer.disconnect();
      fn();
    },
    // A spread of thresholds purely to get called often enough near the line. The
    // bottom margin mirrors the gate's own lift, so the callbacks arrive against the
    // same box `reached` measures against.
    {
      root,
      threshold: [0, gate.threshold, 1],
      rootMargin: `0px 0px -${gate.bottomPct}% 0px`,
    }
  );
  observer.observe(el);
}

/**
 * Drive `onFrame(t)` with t ramping 0 → 1 over `durationMs`, then exactly 1 once.
 *
 * @param {number} durationMs
 * @param {(t: number) => void} onFrame
 * @returns {() => void} cancels the ramp; safe to call after it has finished
 */
function ramp(durationMs, onFrame) {
  // Timed from the first frame rather than from now(), so a ramp scheduled while the
  // tab is backgrounded does not arrive already finished.
  let start = -1;
  let raf = 0;
  /** @param {number} now */
  function step(now) {
    if (start < 0) start = now;
    const t = Math.min(Math.max((now - start) / durationMs, 0), 1);
    onFrame(t);
    raf = t < 1 ? requestAnimationFrame(step) : 0;
  }
  raf = requestAnimationFrame(step);
  return () => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };
}

/**
 * The language the page is actually being read in.
 *
 * language-detect.js sets <html lang> before first paint for the language that will
 * really apply (URL locale → localStorage → browser tag), and lib/i18n/render-page.js
 * sets it server-side on /es, /fr, … We run after `load`, so it is always in place —
 * which is why this is right even on plain /index.html viewed with a Spanish
 * preference, where the source file's `lang` still says "en".
 */
function activeLocale() {
  const tag = document.documentElement.getAttribute("lang");
  return tag && tag.trim() ? tag.trim() : undefined;
}

/**
 * Look a key up in the loaded pack, falling back to the English string we pass in.
 * `LanguageSystem` is installed by the head module language-loader.js; if the pack has
 * not landed yet we render the fallback and the `languagechange` listener repaints.
 *
 * @param {string} key
 * @param {string} fallback
 */
function tx(key, fallback) {
  if (typeof LanguageSystem === "undefined" || !LanguageSystem) return fallback;
  if (typeof LanguageSystem.getText !== "function") return fallback;
  const value = LanguageSystem.getText(key, fallback);
  return typeof value === "string" && value ? value : fallback;
}

/* ==========================================================================
   #ai-shift — the NAR adoption chart
   ========================================================================== */

/**
 * Hover / focus / click a legend row to light its bar segment and dim the rest.
 *
 * The rows are real <button aria-pressed> elements, not `tabindex="0"` list items:
 * click PINS the highlight, which is the only affordance a touch visitor gets since
 * there is no hover on a phone. The bar itself keeps role="img" and its full translated
 * aria-label, so this is purely a visual enhancement and nothing is lost without it.
 *
 * @param {Element} card
 */
function wireNarLegend(card) {
  const buttons = Array.from(card.querySelectorAll("[data-nar-key]"));
  if (!buttons.length) return;

  /** @type {Map<string, Element>} */
  const segments = new Map();
  card.querySelectorAll("[data-nar-seg]").forEach((seg) => {
    segments.set(seg.getAttribute("data-nar-seg") || "", seg);
  });

  let pinned = "";

  /** @param {string} key the segment to light, or "" for none */
  function light(key) {
    // `data-nar-focus` on the card is the hook the CSS dims everything else off.
    if (key) card.setAttribute("data-nar-focus", key);
    else card.removeAttribute("data-nar-focus");
    buttons.forEach((btn) => {
      btn.classList.toggle("is-lit", Boolean(key) && btn.getAttribute("data-nar-key") === key);
    });
    segments.forEach((seg, segKey) => {
      seg.classList.toggle("is-lit", Boolean(key) && segKey === key);
    });
  }

  buttons.forEach((btn) => {
    const key = btn.getAttribute("data-nar-key") || "";
    btn.addEventListener("pointerenter", () => {
      if (!pinned) light(key);
    });
    btn.addEventListener("pointerleave", () => {
      if (!pinned) light("");
    });
    btn.addEventListener("focus", () => {
      if (!pinned) light(key);
    });
    btn.addEventListener("blur", () => {
      if (!pinned) light("");
    });
    btn.addEventListener("click", () => {
      pinned = pinned === key ? "" : key;
      buttons.forEach((b) => {
        b.setAttribute("aria-pressed", b.getAttribute("data-nar-key") === pinned ? "true" : "false");
      });
      light(pinned);
    });
  });
}

function initNarChart() {
  const card = /** @type {HTMLElement|null} */ (document.querySelector("[data-nar-chart]"));
  if (!card) return;

  // Both of these are direct manipulation, not motion — they stay on under reduced
  // motion. The chart still ships as finished markup: `--seg-w` carries the four final
  // widths and the percentages are authored text, for the default 2025 year.
  wireNarLegend(card);
  // The year switch only ever writes off a click, so the 2025 card above is untouched
  // until the visitor asks for 2024. See the header note in home-nar-years.js.
  initNarYears(card, tx);

  // THE BAR HAS NO ENTRANCE ANIMATION, and re-adding one is the bug, not the feature.
  // It used to wipe in from a collapsed clip-path (`is-narm` → `is-ncharted`), but the
  // markup ships the bar already drawn, so blanking it is an ERASE-then-redraw. That
  // leaves exactly two outcomes and no third: arm the wipe early enough to finish
  // unseen below the fold, in which case nobody ever sees it; or arm it late enough to
  // be seen, in which case the visitor scrolls to the chart, finds an empty gap where
  // the bar should be — `.nar-bar` has no track background, so a clipped bar renders as
  // nothing — and watches it fill ~0.9s later. That reads as a loading glitch. The
  // trigger point was retuned three times chasing a middle ground that does not exist.
  // The card's shared `.reveal` fade is the section's entrance; the bar is just there.
  //
  // THE PERCENTAGES ARE NEVER COUNTED UP FROM ZERO, for a different reason. They were
  // at first, and it read as nonsense: a survey share is a fixed measured fact, not a
  // quantity accumulating, so ramping "68%" up from "0%" implies a process that never
  // happened and shows six wrong figures on the way to the right one. (The calculator
  // in #compare ramps because its numbers ARE a running total the visitor is building.)
  //
  // The year switch tweening 68% to 55% is NOT that and is deliberate: both ends are
  // published figures, the visitor asked for it, and it cannot fire on load because
  // only the click path passes `animate`. The distinction is spelled out in
  // test/frontend/home-figures.test.js, which still bans the load-time hooks.
}

/* ==========================================================================
   #compare — the savings calculator
   ========================================================================== */

function initCalculator() {
  const root = document.querySelector("[data-calc]");
  if (!root) return;

  const range = /** @type {HTMLInputElement|null} */ (root.querySelector("[data-calc-range]"));
  const costEl = root.querySelector("[data-calc-cost]");
  const weeksEl = root.querySelector("[data-calc-weeks]");
  if (!range || !costEl || !weeksEl) return;

  const results = root.querySelector("[data-calc-results]");
  const zeroEl = root.querySelector("[data-calc-zero]");
  const readoutEl = root.querySelector("[data-calc-listings]");

  let listings = clampListings(range.value);
  /** @type {(() => void) | null} */
  let cancelIntro = null;
  // Once the visitor has driven the slider themselves, the intro is forfeit. Without
  // this the observer can fire AFTER a first interaction — the card is reachable and
  // draggable while still below the 0.15 visibility threshold — and the ramp would then
  // animate over a value the visitor had already chosen.
  let userTouched = false;

  /** @param {number} costValue @param {number} weeksValue */
  function paint(costValue, weeksValue) {
    const locale = activeLocale();
    costEl.textContent = formatCurrency(costValue, locale);
    weeksEl.textContent = fillCount(
      tx("home.compare.calc.weeks", "{n} weeks"),
      Math.round(weeksValue)
    );
    if (zeroEl) zeroEl.textContent = formatCurrency(0, locale);
    if (readoutEl) readoutEl.textContent = String(listings);
    // Fill the track to the left of the thumb. Constant across the intro ramp (only
    // the money and the weeks ramp), so this is cheap to do here.
    const span = CALC.max - CALC.min;
    const pct = span > 0 ? ((listings - CALC.min) / span) * 100 : 0;
    range.style.setProperty("--calc-pct", pct.toFixed(2) + "%");
  }

  function paintFinal() {
    paint(costFor(listings), weeksFor(listings));
  }

  // Only switched on once the intro ramp is done: a live region during a 60-frame
  // count-up is a torrent, and the numbers it would read are meaningless mid-ramp.
  function announce() {
    if (results) results.setAttribute("aria-live", "polite");
  }

  range.addEventListener("input", () => {
    const next = clampListings(range.value);
    if (next === listings) return; // guards the live-region queue on sub-step drags
    listings = next;
    userTouched = true;
    if (cancelIntro) {
      cancelIntro();
      cancelIntro = null;
    }
    // Unconditional: from the first interaction the visitor is driving, so the results
    // must be announced whether or not the intro ramp ever got to run.
    announce();
    // The drag IS the animation. Ramping on input would lag the thumb.
    paintFinal();
  });

  // language-loader.js fires this once the pack is applied. The three computed nodes
  // carry no data-lang (it would overwrite them), so this is what re-localises the
  // "{n} weeks" template and the currency symbol. Skipped mid-ramp — the ramp repaints
  // every frame and picks the new template up on its own.
  window.addEventListener("languagechange", () => {
    if (!cancelIntro) paintFinal();
  });

  paintFinal();

  if (prefersReducedMotion() || !("IntersectionObserver" in window)) {
    announce();
    return;
  }

  playWhenInView(root, () => {
    if (userTouched) {
      announce();
      return;
    }
    const cost = costFor(listings);
    const weeks = weeksFor(listings);
    cancelIntro = ramp(CALC_INTRO_MS, (t) => {
      // Money may ramp from zero; weeks may not. See weeksAtRamp.
      paint(rampValue(cost, t), weeksAtRamp(weeks, t));
      if (t === 1) {
        cancelIntro = null;
        announce();
      }
    });
  });
}

function init() {
  initNarChart();
  initCalculator();
}

// Guarded on `document` so test/frontend/home-figures.test.js can import the pure
// helpers above without this trying to initialise against a DOM that is not there.
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    // index-deferred.js injects this module after `load`, so DOMContentLoaded fired
    // long ago — a bare listener would never run and the feature would silently
    // not happen. See the trap note at the top of index-deferred.js.
    init();
  }
}
