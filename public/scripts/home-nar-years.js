/**
 * #ai-shift — the 2024 / 2025 survey-year switch on the "Don't fall behind" card.
 *
 * The card ships 2025 as authored markup (bar widths, legend percentages, the 68%
 * note, the bar's aria-label, both stat tiles, the citation). That is deliberate and
 * load-bearing in two directions:
 *
 *   1. No-JS and pre-hydration readers get a complete, correct 2025 card. This module
 *      only ever runs off a click, so nothing here is on the first-paint path.
 *   2. lib/i18n/render-page.js renders /es, /fr, … server-side straight from the packs.
 *      A placeholder the server cannot fill (`{year}`) would ship literally into those
 *      static pages, so the year is NEVER templated into a translated string — the
 *      2025 wording stays whole in every pack and this module swaps to the 2024 wording
 *      client-side. See yearizeSource() for the one exception and why it is safe.
 *
 * WHY THE TILES CHANGE MEANING, NOT JUST VALUE. NAR did not ask the 2025 questions in
 * 2024: there is no 2024 figure for "clients responded positively" (82%) or "AI to
 * generate listing content" (46%) because neither question was on the 2024 instrument.
 * Rather than blank the tiles or leave them showing 2025 numbers under a 2024 label,
 * each tile carries its own sentence per year, and 2024 shows two figures that really
 * are in the 2024 report (ChatGPT use 42%, AI/ML tools 28%). Every number on screen is
 * therefore true to the selected year. The trade is that the two tiles are NOT a
 * year-over-year comparison — only the bar, the legend and the note are.
 */

// The calculator's ease-out cubic. Shared rather than re-derived so the two animated
// figures on this page move on one curve — and so does the bar, whose CSS easing is the
// bezier form of the same shape.
import { rampValue } from "./count-up.js";

/**
 * @typedef {object} NarYear
 * @property {number} daily
 * @property {number} weekly
 * @property {number} monthly
 * @property {number} none
 * @property {number} any     the derived "already use AI" share — 100 minus `none`
 * @property {number} stat1   the first tile's figure
 * @property {number} stat2   the second tile's figure
 */

/**
 * Both years, read out of the NAR Research Group PDFs rather than press coverage.
 *
 * The four frequency shares do NOT sum to 100 in either year (2025 sums to 101, 2024 to
 * 101): NAR rounds each share independently. `.nar-bar` is a flex row, so the extra
 * point is absorbed by flex-shrink and the bar still renders flush — the same tolerance
 * test/frontend/home-figures.test.js allows on the authored markup.
 *
 * `2025` here MUST agree with the authored markup in index.html; that is not a
 * convention, it is asserted by test/frontend/home-nar-years.test.js, which reads the
 * HTML and compares. Change one without the other and the suite fails.
 *
 * @type {Record<string, NarYear>}
 */
export const NAR_YEARS = {
  2025: { daily: 20, weekly: 22, monthly: 27, none: 32, any: 68, stat1: 82, stat2: 46 },
  2024: { daily: 9, weekly: 17, monthly: 30, none: 45, any: 55, stat1: 42, stat2: 28 },
};

/** The citation target per year. Both are NAR-official; 2024 has no press release. */
export const NAR_SOURCE_URL = {
  2025:
    "https://www.nar.realtor/press-releases/" +
    "realtors-embrace-ai-digital-tools-to-enhance-client-service-nar-survey-finds",
  2024:
    "https://www.nar.realtor/sites/default/files/documents/" +
    "2024-technology-survey-report-08-08-2024.pdf",
};

export const NAR_DEFAULT_YEAR = "2025";

/** Pack keys per year. 2025 keeps the original flat keys so no pack string moved. */
const TX_KEYS = {
  2025: { stat1: "home.nar.stat1", stat2: "home.nar.stat2", aria: "home.nar.usageAria" },
  2024: {
    stat1: "home.nar.y2024.stat1",
    stat2: "home.nar.y2024.stat2",
    aria: "home.nar.y2024.usageAria",
  },
};

/** English fallbacks, used until the pack lands and on a pack that is missing the key. */
const TX_FALLBACK = {
  2025: {
    stat1: "of agents say clients responded positively to technology in the buying and selling process",
    stat2: "already use AI to generate listing content",
    aria: "AI usage among agents: 20% daily, 22% weekly, 27% a few times a month, 32% not yet",
  },
  2024: {
    stat1: "of agents have used ChatGPT in the past 12 months",
    stat2: "use AI and machine learning tools in their business",
    aria: "AI usage among agents: 9% daily, 17% weekly, 30% a few times a month, 45% not yet",
  },
};

/** The citation's own English fallbacks, carrying the default year like the packs do. */
const SOURCE_FALLBACK = {
  text: "Figures from the National Association of Realtors’ 2025 Technology Survey of real estate agents.",
  cite: "Source: National Association of Realtors, 2025 Technology Survey",
};

/**
 * Retarget a translated citation sentence at another survey year.
 *
 * This is a digit swap on an already-translated string, not a template: every pack
 * writes the year as Arabic numerals ("2025 Technology Survey", "…, 2025"), including
 * the CJK and Cyrillic packs, so the substitution is position-independent and needs no
 * per-language rule. Matching `20\d\d` rather than a literal "2025" means it also works
 * when the pack has already been retargeted, which is what makes repeated switching
 * idempotent.
 *
 * test/frontend/home-nar-years.test.js pins the premise — that every pack's two citation
 * strings contain exactly one four-digit year — so a reworded pack fails the build here
 * rather than silently shipping a card that cites the wrong survey.
 *
 * @param {string} text
 * @param {string} year
 */
export function yearizeSource(text, year) {
  return text.replace(/\b20\d\d\b/g, year);
}

export const NAR_TWEEN_MS = 620;

/** Motion is opt-out at the OS level, and the switch still switches without it. */
function prefersReducedMotion() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** In-flight tween per card, so a fast second click replaces the first rather than
 *  racing it — two rAF loops writing the same seven nodes would flicker between years.
 *  `safety` is the background-tab backstop; see tweenNumerals.
 *  @type {WeakMap<Element, { frame?: number, safety?: ReturnType<typeof setTimeout> }>} */
const running = new WeakMap();

/** @param {Element} card */
function cancelTween(card) {
  const state = running.get(card);
  if (!state) return;
  if (typeof cancelAnimationFrame === "function" && state.frame !== undefined) {
    cancelAnimationFrame(state.frame);
  }
  if (state.safety !== undefined) clearTimeout(state.safety);
  running.delete(card);
}

/**
 * Ease seven numerals from whatever they read now to their new year.
 *
 * The start value is PARSED FROM THE DOM rather than taken from the year we came from.
 * That is what makes an interrupted tween pick up where it visibly is instead of
 * snapping back to a value nobody is looking at any more.
 *
 * Every frame is rounded to a whole percent: these sit beside translated sentences that
 * have no plural machinery, so a fractional or unexpected value would be as wrong as a
 * mistranslation — see the note on why the sentences are never part of the tween.
 *
 * @param {Element} card
 * @param {Array<{ el: Element | null, to: number }>} numerals
 */
function tweenNumerals(card, numerals) {
  cancelTween(card);
  const pairs = [];
  for (const { el, to } of numerals) {
    if (!el) continue;
    const from = Number(String(el.textContent || "").replace(/[^\d.-]/g, ""));
    pairs.push({ el, from: Number.isFinite(from) ? from : to, to });
  }
  if (!pairs.length) return;

  // Nothing to watch if every figure already reads its target (a repaint of the same
  // year, or a language change) — write through and skip the loop entirely.
  if (pairs.every((p) => p.from === p.to)) {
    pairs.forEach((p) => {
      p.el.textContent = `${p.to}%`;
    });
    return;
  }

  if (typeof requestAnimationFrame !== "function" || typeof performance === "undefined") {
    pairs.forEach((p) => {
      p.el.textContent = `${p.to}%`;
    });
    return;
  }

  /** Land exactly on the published figures — never on a rounding artefact, and never
   *  on an intermediate value that NAR did not publish. */
  const settle = () => {
    pairs.forEach((p) => {
      p.el.textContent = `${p.to}%`;
    });
    cancelTween(card);
  };

  const start = performance.now();
  const step = (now) => {
    const t = Math.min(Math.max((now - start) / NAR_TWEEN_MS, 0), 1);
    if (t >= 1) {
      settle();
      return;
    }
    pairs.forEach((p) => {
      // rampValue is the calculator's ease-out cubic — reused so the two animated
      // figures on this page share one motion curve, and so does the bar's CSS easing.
      const value = p.from + rampValue(p.to - p.from, t);
      p.el.textContent = `${Math.round(value)}%`;
    });
    const state = running.get(card);
    if (state) state.frame = requestAnimationFrame(step);
  };

  // THE SAFETY NET, and it is not belt-and-braces. requestAnimationFrame is PAUSED in a
  // background tab, so switching away mid-tween strands the card on whatever frame it
  // reached — "14%", a figure from no survey — and it stays there until the tab is
  // looked at again. A timer still fires there, so this guarantees the card always
  // settles on real numbers whether or not anyone is watching it happen.
  running.set(card, {
    frame: requestAnimationFrame(step),
    safety: setTimeout(settle, NAR_TWEEN_MS + 250),
  });
}

export const NAR_DISSOLVE_MS = 280;

/**
 * Drop any dissolve ghost still on the card.
 *
 * Called before every un-animated paint as well, so a language change or a reduced-
 * motion switch landing mid-dissolve cannot leave a stale sentence stacked over the
 * live one — the ghost is absolutely positioned, so it would sit there looking like
 * doubled text rather than disappearing.
 *
 * @param {Element} card
 */
function clearGhosts(card) {
  card.querySelectorAll(".nar-ghost").forEach((g) => g.remove());
}

/**
 * Dissolve the citation from one year to the next: both wordings on screen at once.
 *
 * ONE GHOST FOR THE WHOLE PARAGRAPH, not one per changed node. The sentence and the
 * `<cite>` beneath it are inline content that wraps, and an inline element's box is not
 * a rectangle you can lay another element over — a per-node ghost would misalign the
 * moment the citation wrapped to a second line. The paragraph IS a block, its two years
 * are the same width, so a clone of it overlays its original exactly.
 *
 * The ghost is inert to everyone: `aria-hidden` so a reader does not meet the citation
 * twice, `pointer-events: none` in CSS, and its link untabbable — a duplicate focus stop
 * on a link that is about to vanish is a trap.
 *
 * @param {Element} card
 * @param {() => void} write
 */
function dissolveCitation(card, write) {
  const live = card.querySelector("[data-nar-dissolve]");
  if (!(live instanceof HTMLElement) || !live.parentElement) {
    write();
    return;
  }
  clearGhosts(card);

  const ghost = /** @type {HTMLElement} */ (live.cloneNode(true));
  ghost.classList.add("nar-ghost");
  ghost.setAttribute("aria-hidden", "true");
  ghost.removeAttribute("data-nar-dissolve");
  ghost.querySelectorAll("a").forEach((a) => a.setAttribute("tabindex", "-1"));
  // Pinned to the live paragraph's own box rather than stretched to the row: the row is
  // a flex line holding the logo and the year switch too, so `inset: 0` would stretch
  // the clone across both and re-wrap its text differently from the thing it is copying.
  //
  // THE WIDTH MUST BE THE FRACTIONAL ONE, and this is not a detail. `offsetWidth` is
  // rounded to an integer, and the paragraph is a flex item sized to its own content —
  // so the citation always sits EXACTLY on its wrap boundary, with no slack by
  // construction. Measured: the sentence needs 640.21px and the paragraph is 640.208px
  // wide, so an `offsetWidth` of 640 handed the clone 0.21px less than its text needs.
  // It wrapped to a second line, which pushed its <cite> 21.7px down, and the outgoing
  // "Source: …" appeared to drop below the incoming one before fading. getBoundingClientRect
  // keeps the fraction and reproduces the original layout exactly.
  //
  // (The years differ here too: "2024" is 0.5px wider than "2025" in Inter, which is why
  // the clone and the live copy can disagree at all.)
  const box = live.getBoundingClientRect();
  ghost.style.left = `${live.offsetLeft}px`;
  ghost.style.top = `${live.offsetTop}px`;
  ghost.style.width = `${box.width}px`;
  live.parentElement.appendChild(ghost);
  write();

  // ONLY THE OUTGOING COPY ANIMATES. The new citation stays fully opaque underneath the
  // whole time, so there is no instant at which the reader sees nothing — which is the
  // entire point of dissolving rather than fading. Cross-fading BOTH (new text up from
  // 0 while the old goes down) was the first attempt and it is subtly wrong: two
  // opacities crossing sum to less than 1 in the middle, so the sentence dips to grey
  // and back, and if either half fails to start you get a blank instead. Measured: the
  // pair hit 0/0 together and the citation vanished for ~150ms.
  //
  // Because the two wordings differ only in the year, the aligned characters sit exactly
  // on top of each other and only the digits appear to change. There is nothing to see
  // in the rest of the sentence, which is what makes this read as a morph.
  //
  // One forced reflow commits the ghost at full opacity so it has a frame to ease FROM;
  // no requestAnimationFrame, which a background tab would pause.
  void ghost.offsetHeight;
  ghost.style.opacity = "0";

  // If the tab is frozen mid-dissolve the ghost simply sits there over near-identical
  // text — the year is the only part that looks doubled — and this still clears it.
  setTimeout(() => ghost.remove(), NAR_DISSOLVE_MS + 60);
}

/**
 * Swap the un-interpolatable wording behind a short opacity dip.
 *
 * The write happens at the bottom of the fade-out, so the reader never sees the two
 * years' sentences trade places mid-opacity.
 *
 * @param {Element} card
 * @param {() => void} write
 */
function crossfadeText(card, write) {
  const nodes = Array.from(card.querySelectorAll(".nar-swap"));
  if (!nodes.length) {
    write();
    return;
  }
  nodes.forEach((n) => n.classList.add("is-swapping"));
  setTimeout(() => {
    write();
    // Removed on a TIMER, never inside requestAnimationFrame. rAF is paused outright in
    // a background tab, so a visitor who clicks a year and switches tab before the
    // callback runs comes back to permanently invisible sentences — the class is never
    // taken off. setTimeout is throttled there but still fires, so the text always
    // comes back. (No extra frame is needed to make the fade happen: `is-swapping` was
    // added 200ms ago and has long since been painted.)
    nodes.forEach((n) => n.classList.remove("is-swapping"));
  }, 200);
}

/**
 * @param {Element} card
 * @param {string} year
 * @param {(key: string, fallback: string) => string} tx
 * @param {{ animate?: boolean }} [options] animate ONLY on a real year switch — never
 *   on load, and never on a language repaint, where there is no change to show.
 */
export function paintNarYear(card, year, tx, options = {}) {
  const data = NAR_YEARS[year];
  if (!data) return;
  const keys = TX_KEYS[year];
  const fallback = TX_FALLBACK[year];
  const animate = Boolean(options.animate) && !prefersReducedMotion();

  // The bar: `--seg-w` is the only width source, exactly as the authored markup has it.
  // Setting it is all the bar needs — `.nar-bar span` transitions `width`, so the
  // segments ease to the new year on their own. A transition fires on CHANGE, so this
  // is silent on load and silent when a repaint writes the same year back.
  const order = ["daily", "weekly", "monthly", "none"];
  order.forEach((key) => {
    const seg = card.querySelector(`[data-nar-seg="${key}"]`);
    if (seg instanceof HTMLElement) seg.style.setProperty("--seg-w", `${data[key]}%`);
  });

  // The seven numerals. These are TWEENED between two real years, which is a different
  // act from the count-up that was removed: that one ramped from 0% on load and implied
  // a process that never happened. Here both endpoints are measured figures and the
  // visitor asked for the change, so the motion is the comparison the switch exists to
  // make. It still never runs on load — only `select()` passes `animate`.
  /** @type {Array<{ el: Element | null, to: number }>} */
  const numerals = [
    ...order.map((key) => ({
      el: card.querySelector(`[data-nar-key="${key}"] .pct`),
      to: data[key],
    })),
    { el: card.querySelector(".nar-usage__note strong"), to: data.any },
    { el: card.querySelectorAll(".nar-stat__num")[0] || null, to: data.stat1 },
    { el: card.querySelectorAll(".nar-stat__num")[1] || null, to: data.stat2 },
  ];
  if (animate) tweenNumerals(card, numerals);
  else {
    cancelTween(card);
    numerals.forEach(({ el, to }) => {
      if (el) el.textContent = `${to}%`;
    });
  }

  // The bar is role="img", so this label is the whole chart to a screen reader. It is a
  // fourth copy of the same four numbers and drifts silently — hence the pinned string
  // per year rather than one assembled from the legend labels. Set ONCE, never per
  // frame: a label that churned sixty times would be noise to a reader, and the
  // intermediate values are not figures NAR published.
  const bar = card.querySelector(".nar-bar");
  if (bar) bar.setAttribute("aria-label", tx(keys.aria, fallback.aria));

  // TWO KINDS OF TEXT CHANGE, AND THEY DO NOT DESERVE THE SAME TREATMENT.
  //
  // The tiles genuinely swap sentences — "clients responded positively to technology"
  // becomes "have used ChatGPT", because the 2024 survey asked different questions.
  // There is no visual relationship between the two, so they fade out, swap while
  // nothing is on screen, and fade back. Dissolving those would smear two unrelated
  // sentences through each other.
  //
  // The citation changes by FOUR CHARACTERS — the year, twice. Blanking a sentence to
  // reprint it almost identically overstates the change and reads as a flicker, so it
  // dissolves instead: the old wording and the new are both on screen at once and the
  // year appears to morph in place.
  const writeTiles = () => {
    const txts = card.querySelectorAll(".nar-stat__txt");
    if (txts[0]) txts[0].textContent = tx(keys.stat1, fallback.stat1);
    if (txts[1]) txts[1].textContent = tx(keys.stat2, fallback.stat2);
  };
  const writeCitation = () => {
    const sourceText = card.querySelector("[data-nar-source-text]");
    if (sourceText) {
      sourceText.textContent = yearizeSource(tx("home.nar.source", SOURCE_FALLBACK.text), year);
    }
    const link = card.querySelector("[data-nar-source-link]");
    if (link) {
      link.textContent = yearizeSource(tx("home.nar.sourceCite", SOURCE_FALLBACK.cite), year);
      link.setAttribute("href", NAR_SOURCE_URL[year] || NAR_SOURCE_URL[NAR_DEFAULT_YEAR]);
    }
  };

  if (animate) {
    crossfadeText(card, writeTiles);
    dissolveCitation(card, writeCitation);
  } else {
    clearGhosts(card);
    writeTiles();
    writeCitation();
  }
}

/**
 * Wire the two year buttons.
 *
 * The buttons are `aria-pressed` toggles in a `role="group"`, not a tablist: there are
 * no panels here, only one chart whose numbers change, so tab semantics would promise a
 * structure that does not exist.
 *
 * On first run this module takes over the five year-dependent nodes from
 * language-loader.js by dropping their `data-lang` / `data-lang-attr` hooks — the same
 * single-writer move hero-picker.js makes. Two writers on one node means the applier
 * would repaint the 2025 wording over a 2024 card on the next `languagechange`. Owning
 * them means we are also responsible for repainting them, which is what the listener at
 * the bottom does.
 *
 * @param {Element} card
 * @param {(key: string, fallback: string) => string} tx
 */
export function initNarYears(card, tx) {
  const buttons = Array.from(card.querySelectorAll("[data-nar-year]"));
  if (!buttons.length) return;

  card.querySelectorAll("[data-nar-owned]").forEach((el) => {
    el.removeAttribute("data-lang");
    el.removeAttribute("data-lang-attr");
  });

  let current = NAR_DEFAULT_YEAR;

  /** @param {string} year */
  function select(year) {
    if (!NAR_YEARS[year]) return;
    // Re-pressing the year already on screen does nothing. Without this it repainted:
    // a dissolve clone went up over an identical citation, the tiles crossfaded to the
    // wording they already had, and the numerals tweened from each value to itself —
    // half a second of flicker to arrive exactly where the card started.
    //
    // It also makes the switch safe to hammer. `current` moves on the FIRST click, so a
    // second press of the same button during the animation is swallowed here rather
    // than restarting a tween that is already running toward that year.
    if (year === current) return;
    current = year;
    buttons.forEach((btn) => {
      const isOn = btn.getAttribute("data-nar-year") === year;
      btn.setAttribute("aria-pressed", isOn ? "true" : "false");
      btn.classList.toggle("is-on", isOn);
    });
    // The click is the only place `animate` is passed — the one moment there is a
    // change to show and a visitor looking at it.
    paintNarYear(card, year, tx, { animate: true });
  }

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      select(btn.getAttribute("data-nar-year") || NAR_DEFAULT_YEAR);
    });
  });

  window.addEventListener("languagechange", () => paintNarYear(card, current, tx));
}
