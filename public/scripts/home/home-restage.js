// #restage — "Press it again. Get a different room."
//
// One empty room and a button. The first press stages it; every press after deals a
// different pre-generated staging of the SAME photo. It replaced a before/after drag
// wipe, which the page already showed a second time in the studio showcase carousel
// (#exterior-studio-demo, still driven by staging-studio.js's mountWipe).
//
// FOUR THINGS HERE ARE LOAD-BEARING, and three of them fail silently:
//
//  1. THE DRAW IS A SHUFFLED BAG, NOT Math.random() PER PRESS. Picking uniformly at
//     random repeats fast — with a 100-image pool there is still roughly a 25% chance of
//     a duplicate inside the first eight presses, and a visitor reads one duplicate as
//     "it's broken", not "unlucky". Growing the pool barely dents that (60 was 39%), which
//     is exactly why the bag is the fix and a bigger pool is not. makeBag walks a shuffled
//     order and reshuffles on exhaustion, never dealing the card already on screen as the
//     first of a new cycle.
//
//  2. NOTHING IS PREFETCHED. The section ships the empty room and stops. Each press
//     fetches exactly one render (~49 KB) and only swaps it in once it has decoded, so
//     a visitor who never presses pays nothing for a 100-image pool existing. Do not add
//     a warming pass here "for smoothness" — that is 4.8 MB for a section most people
//     scroll past.
//
//  3. THE OUTGOING CARD IS REMOVED WHEN THE NEXT ARRIVES, not on its own exit timer.
//     Presses outrun the exit transition trivially once the images are warm; a
//     timer-only cleanup left 70 <div>s in the DOM after 70 presses.
//
//  4. THIS MODULE NEVER WRITES THE BUTTON'S TEXT. Both labels ship in the markup,
//     stacked in one grid cell, and `.has-staged` on the root swaps which is visible.
//     That is what keeps the button one fixed width across the flip in every language,
//     and it sidesteps language-loader.js re-applying every [data-lang] node on
//     `languagechange` — an imperatively-set label would silently revert to the
//     first-press wording on the next pass.
//
//     It DOES rewrite the label's internal markup, wrapping each glyph in a span so the
//     press animation can stagger them (splitLabels below). That is the same collision
//     seen from the other side: the loader assigns `textContent` on every apply pass,
//     which flattens the spans back to plain text and kills the stagger with no error.
//     The re-split therefore hangs off the `languagechange` event the loader fires at
//     the end of that pass. The spans carry no data-lang of their own, so the loader's
//     MutationObserver does not see them as new work and the two cannot feed each other.
//
//  5. THERE IS NO COOLDOWN, DELIBERATELY. The button is enabled once at mount and never
//     disabled again, and presses are not dropped while a fetch is in flight — mashing
//     it is a supported way to use this section, not an edge case, because every press
//     is another render seen. Consequences, all of which the code below depends on:
//       - presses overlap, so `is-working` is refcounted rather than toggled;
//       - each press animation must be RESTARTED (remove class, reflow, re-add), or the
//         second press inside 580ms plays nothing at all;
//       - renders land in arrival order, each throwing whatever is on screen. Note 3's
//         cleanup is what keeps that from growing the DOM;
//       - "See original" cancels presses still in flight via an epoch counter. Without
//         it a render that resolves just after a revert would silently re-stage the room.
//
// PROGRESSIVE ENHANCEMENT: index-deferred.js injects this after `load`, so the served
// markup is what every visitor sees first and what they keep if that batch fails. The
// button therefore ships `disabled`, and home.css keeps it invisible until `.rs--ready`
// is on the root — a dead control is worse than no control. The empty room, the copy
// and the "Before" tag are plain markup and need none of this to read correctly.

import { RESTAGE_DIR, RESTAGE_POOL } from './restage-pool.js';

/**
 * Fisher-Yates. Extracted so the bag can be tested with a seeded generator instead of
 * being at the mercy of Math.random.
 *
 * @template T
 * @param {readonly T[]} list
 * @param {() => number} rng
 * @returns {T[]} a new shuffled array; `list` is not mutated
 */
function shuffle(list, rng) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const swap = out[i];
    out[i] = out[j];
    out[j] = swap;
  }
  return out;
}

/**
 * A draw-without-replacement bag over `items`.
 *
 * The whole pool comes out before anything repeats, and a reshuffle never leads with
 * the item that was just dealt — that is the one repeat a visitor is guaranteed to
 * notice, because it lands back to back.
 *
 * @template T
 * @param {readonly T[]} items
 * @param {() => number} [rng] injectable for tests
 * @returns {{ draw: () => T | null, remaining: () => number }}
 */
export function makeBag(items, rng = Math.random) {
  /** @type {T[]} */
  let bag = [];
  /** @type {T | null} */
  let last = null;

  function refill() {
    bag = shuffle(items, rng);
    if (last !== null && bag.length > 1 && bag[0] === last) {
      const swap = bag[0];
      bag[0] = bag[1];
      bag[1] = swap;
    }
  }

  return {
    draw() {
      if (!items.length) return null;
      if (!bag.length) refill();
      const next = /** @type {T} */ (bag.shift());
      last = next;
      return next;
    },
    remaining: () => bag.length,
  };
}

/**
 * Localized string lookup. language-loader.js owns the packs and exposes getText on
 * window; before it has loaded (or if the fetch failed) the English fallback baked into
 * the markup is what the visitor already has, so returning it is correct rather than a
 * degradation.
 *
 * @param {string} key
 * @param {string} fallback
 * @returns {string}
 */
function t(key, fallback) {
  const sys = /** @type {{ getText?: (k: string, f: string) => string } | undefined} */ (
    /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window)).LanguageSystem
  );
  try {
    const value = sys && typeof sys.getText === 'function' ? sys.getText(key, fallback) : fallback;
    return typeof value === 'string' && value ? value : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Fetch and decode a render, resolving with the very <img> element that holds it.
 *
 * Returning the element rather than just settling a promise matters: the caller inserts
 * THIS element, so the bytes are fetched once and the decode is already done when it
 * lands. Building a second <img> on the same URL would hit the cache but is still free
 * to defer its decode, and a card that paints a frame or two late is visible here —
 * the departing card has already begun moving and would uncover a blank one.
 *
 * Waiting at all is also why nothing is prefetched: the wait belongs to the press that
 * asked for it, not to every visitor who scrolls past.
 *
 * @param {string} src
 * @returns {Promise<HTMLImageElement>}
 */
function preload(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    // DO NOT await image.decode() here. In a BACKGROUND TAB it never settles — the load
    // event fires, the decode promise stays pending indefinitely, and awaiting it leaves
    // this button disabled and the whole section dead until the tab is focused again.
    // (Measured: pending after 2.5s with `load` already fired.) Resolving on `load` is
    // enough, because the element that loaded is the element inserted — the browser
    // already holds its data and decodes it as part of painting that frame.
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`restage: could not load ${src}`));
    image.src = src;
  });
}

/**
 * The largest `--i` a glyph is given, so the stagger stops growing with the label.
 *
 * At 22ms a step (home.css), an unclamped index would push the last glyph of the German
 * label ("Diesen Raum neu einrichten", 26 characters) to a 550ms delay — the button's own
 * bounce is over by then, so the type would still be hopping after the pill had settled.
 * Clamping means every language finishes inside the same window; long labels simply move
 * their tail together instead of trailing off.
 */
const HOP_STAGGER_CAP = 11;

/**
 * Wrap each glyph of a label in a `<span class="rs__btn-char">` so the press animation
 * can stagger them.
 *
 * Spaces are left as bare text nodes on purpose. Wrapping them too would give the
 * accessible name a run of inline-block boxes with no real word boundaries, which some
 * screen readers read out character by character; keeping the spaces as text keeps the
 * name identical to the label's own string.
 *
 * Idempotent: it reads `textContent`, which round-trips through the spans unchanged, so
 * re-running it on an already-split label rebuilds the same thing. That matters because
 * it runs again on every `languagechange`, and a "have I split this?" flag would survive
 * the very `textContent` assignment it is meant to detect.
 *
 * @param {HTMLElement} label
 * @returns {void}
 */
function splitLabel(label) {
  const text = label.textContent || '';
  if (!text) return;
  const frag = document.createDocumentFragment();
  let index = 0;
  // Iterated with for..of rather than split(''), so an astral character (an emoji in a
  // translated label, say) stays one glyph instead of being torn into surrogate halves.
  for (const glyph of text) {
    if (glyph === ' ') {
      frag.appendChild(document.createTextNode(' '));
      continue;
    }
    const span = document.createElement('span');
    span.className = 'rs__btn-char';
    // Kept as data as well as as the custom property, because `--i` is rewritten on
    // every press (a glyph already in the air enters the new wave immediately) and this
    // is what it is restored to once the glyph is back at rest.
    span.dataset.hopIndex = String(Math.min(index, HOP_STAGGER_CAP));
    span.style.setProperty('--i', span.dataset.hopIndex);
    span.textContent = glyph;
    frag.appendChild(span);
    index++;
  }
  label.textContent = '';
  label.appendChild(frag);
}

/**
 * Wire one section root.
 *
 * @param {HTMLElement} root the `[data-restage]` element
 * @returns {void}
 */
function mountRestage(root) {
  const stack = root.querySelector('.rs__stack');
  const button = /** @type {HTMLButtonElement | null} */ (root.querySelector('[data-restage-btn]'));
  const revertBtn = root.querySelector('[data-restage-revert]');
  const emptyImg = /** @type {HTMLImageElement | null} */ (root.querySelector('.rs__empty'));
  if (!stack || !button || !emptyImg || !RESTAGE_POOL.length) return;

  const bag = makeBag(RESTAGE_POOL);
  /** @type {HTMLElement | null} */
  let current = null;
  /**
   * How many fetches are outstanding. A COUNT, not a flag: presses overlap by design
   * (note 5), and toggling a boolean meant the first render to arrive cleared the
   * loading sheen while three more were still in the air.
   */
  let inflight = 0;
  /**
   * Bumped by "See original". A press carries the epoch it started under and drops its
   * render if that no longer matches, so reverting cannot be silently undone a moment
   * later by a fetch that was already on its way.
   */
  let epoch = 0;

  /** One fetch finished, one way or another. */
  function settle() {
    inflight = Math.max(0, inflight - 1);
    if (!inflight) stack.classList.remove('is-working');
  }

  /**
   * Acknowledge a tap on the photo itself.
   *
   * Cleared on a timer rather than on `transitionend`, which is the one event that does
   * not reliably arrive here: the shadow may already be at the pressed value from a tap
   * a moment earlier, and a transition that has nothing to animate fires nothing at all,
   * leaving the photo stuck looking pressed. A timer cannot get stuck.
   *
   * @returns {void}
   */
  let tapTimer = 0;
  function playTap() {
    stack.classList.add('is-tapped');
    window.clearTimeout(tapTimer);
    tapTimer = window.setTimeout(() => stack.classList.remove('is-tapped'), 130);
  }

  /**
   * Hand each glyph its current height as `--from`, so the wave can restart from where
   * the letters actually are instead of from the baseline.
   *
   * MUST run before the class comes off. Removing `is-hopping` cancels the animation, and
   * because it has no fill the glyph reverts to `transform: none` in the same breath —
   * sample after that and every reading is 0, which is the snap this exists to avoid.
   *
   * The rendered matrix is read rather than the animation's progress recomputed by hand.
   * It already accounts for the easing and for the glyph's own stagger offset, so a
   * letter still waiting out its delay correctly reports 0 and one at the top of its arc
   * reports ~-5px, with no second copy of the curve to keep in step with home.css.
   *
   * Self-clearing: the next press re-samples, and once a wave has finished the computed
   * transform is `none` again, so `--from` goes back to 0 without anyone resetting it.
   */
  function captureHopOffsets() {
    for (const glyph of /** @type {HTMLElement[]} */ ([...button.querySelectorAll('.rs__btn-char')])) {
      const { transform } = window.getComputedStyle(glyph);
      // 'none' is both the resting value and what a browser without DOMMatrix leaves us
      // with; either way the glyph is treated as sitting at the baseline, which is the
      // pre-existing behaviour rather than a broken one.
      let offset = 0;
      if (transform && transform !== 'none' && typeof DOMMatrixReadOnly === 'function') {
        try {
          offset = new DOMMatrixReadOnly(transform).m42;
        } catch {
          offset = 0;
        }
      }
      glyph.style.setProperty('--from', `${offset.toFixed(2)}px`);
      // A glyph that is already in the air joins the new wave AT ONCE, with no stagger.
      // Holding it to its usual delay is continuous — `backwards` fill keeps it at
      // `--from` meanwhile — but it means a letter hanging motionless in mid-air for up
      // to 242ms while the pill bounces underneath it, which reads as stuck rather than
      // as springy. Letters at rest keep their place in the queue, so the wave is still
      // a wave; only the part of it that is already moving carries straight on.
      // The threshold, rather than `!== 0`: a glyph a hair off the baseline at the very
      // end of its arc is at rest for these purposes, and exact zero never arrives.
      const airborne = Math.abs(offset) > 0.01;
      glyph.style.setProperty('--i', airborne ? '0' : (glyph.dataset.hopIndex || '0'));
    }
  }

  /**
   * Play the press animation from the top.
   *
   * The remove/reflow/add dance is the whole point. Adding a class that is already
   * present is not a style change, so a second press inside the 580ms bounce would run
   * nothing — and with no cooldown, back-to-back presses are the normal case, not a
   * stress test. Reading `offsetWidth` between the two flushes the removal so the browser
   * sees two distinct states rather than coalescing them into none.
   *
   * Both the pill and the label re-fire on every press, so no press is ever swallowed.
   * The difference is where each one starts. The pill restarts flat, from the pressed
   * pose. The label restarts SOFTLY, from the heights captured just above — a hard
   * restart teleports 25 letters back to the baseline mid-hop and reads as a stutter,
   * while blocking the restart outright made the text feel dead under a fast press. This
   * is the middle: the letters change direction rather than jumping.
   *
   * Ordering is load-bearing throughout — sample, then remove, then reflow, then add.
   */
  function playPress() {
    captureHopOffsets();
    button.classList.remove('is-boing', 'is-hopping');
    void button.offsetWidth;
    button.classList.add('is-boing', 'is-hopping');
  }

  // NOTE: stage() plays NO feedback of its own. Each entry point animates the thing the
  // visitor actually touched — the button bounces its own pill, the photo dims itself —
  // and both fire before this runs, so neither sits behind the empty-pool guard below or
  // behind anything that can await. Bouncing the button when the PHOTO was clicked drew
  // the eye to the wrong side of the section, away from the room that had just changed.
  async function stage() {
    const file = bag.draw();
    if (!file) return;
    const mine = epoch;
    inflight += 1;
    stack.classList.add('is-working');

    /** @type {HTMLImageElement} */
    let image;
    try {
      image = await preload(RESTAGE_DIR + file);
    } catch {
      // A missing render is not fatal to the section — the next press simply draws the
      // next card. Nothing to re-enable, because nothing was ever disabled.
      //
      // But it must SAY so. Without this the failure was invisible: the pill bounced, the
      // sheen swept for a moment and the photo did not change, which is exactly what a
      // broken button looks like. On the first press it was worse still — `has-staged` is
      // only added on success, so "See original" never appeared either and there was no
      // evidence at all that the press had done anything.
      //
      // Only raised once the last outstanding fetch has failed. With presses overlapping
      // by design, one 404 among four in-flight requests is not a state worth reporting
      // while three of them are still likely to land.
      settle();
      if (!inflight) root.classList.add('has-error');
      return;
    }

    // Reverted while this was in flight: the visitor asked for the empty room, so honour
    // that rather than covering it back up with a render they had already dismissed.
    if (mine !== epoch) {
      settle();
      return;
    }

    // Decided BEFORE the new card goes in: on the first press (and on any press right
    // after a revert) there is no card on screen, so a copy of the empty room is what
    // gets thrown.
    const outgoing = current || makeGhost();

    const card = document.createElement('div');
    card.className = 'rs__card';
    // `image` is the very element preload() already fetched AND decoded, not a second
    // <img> pointing at the same URL. A fresh element would hit the cache but could
    // still defer its decode past the frame it is inserted in, which is a blank card for
    // as long as that takes — the departing card is already moving by then, so the gap
    // shows. Inserting the decoded element means it paints with the frame it lands in.
    image.alt = t('home.restage.stagedAlt', 'The same living room, staged by Stagify');
    card.appendChild(image);

    // Drop anything still mid-exit from an earlier press BEFORE adding another, so the
    // stack cannot grow past two however fast the button is hit. See note 3 up top.
    stack.querySelectorAll('.rs__card.is-leaving').forEach((stale) => stale.remove());
    // No forced reflow and no entrance class: the card is opaque on arrival and simply
    // waits under the one being thrown. See the note in home.css.
    stack.appendChild(card);

    throwAway(outgoing);
    current = card;

    // Flips the button label and fades "See original" in — both are pure CSS off this
    // one class, which is why nothing here writes the button's text.
    root.classList.add('has-staged');
    syncLabelAria(true);
    // A render landed, so whatever failed before is stale. Cleared here rather than at
    // the top of stage() so the message survives the press that is trying again: clearing
    // on press would blank the line the instant the visitor acted on it, and if that retry
    // also failed the line would flicker off and back on.
    root.classList.remove('has-error');
    settle();
  }

  /**
   * Send a card off to the left and drop it once it has landed.
   * @param {HTMLElement | null} card
   */
  function throwAway(card) {
    if (!card) return;
    card.classList.add('is-leaving');
    // Must outlast the exit transition in home.css, or the card is yanked mid-flight.
    window.setTimeout(() => card.remove(), 560);
  }

  /**
   * A disposable copy of the empty photo, so the FIRST press has something to throw.
   *
   * The empty room is the permanent base layer, not a card — it has to survive so
   * "See original" has something to reveal. Without this, the opening press (and every
   * press straight after a revert) would pop the staged room in with no throw at all,
   * which is the one press most visitors ever make. The copy is what flies off; the real
   * base stays put underneath, covered by the incoming card.
   *
   * `aria-hidden` and an empty alt because it is a duplicate of an image already in the
   * document — it carries no information a screen reader has not already been given.
   *
   * @returns {HTMLElement}
   */
  function makeGhost() {
    const ghost = document.createElement('div');
    ghost.className = 'rs__card';
    ghost.setAttribute('aria-hidden', 'true');
    const copy = document.createElement('img');
    copy.src = emptyImg.currentSrc || emptyImg.src;
    copy.alt = '';
    ghost.appendChild(copy);
    stack.appendChild(ghost);
    // Paint it at rest for one frame, or the browser coalesces "appeared" and "leaving"
    // into one style change and no transition runs.
    void ghost.offsetWidth;
    return ghost;
  }

  /**
   * Throw the staged card away and show the untouched photo underneath it.
   *
   * No longer gated on "nothing is loading" — with presses overlapping there is rarely a
   * quiet moment to wait for, and refusing the control mid-fetch made it feel broken.
   * Bumping the epoch is what makes it safe: every press already in the air is abandoned
   * on arrival instead of landing on top of the empty room a beat later.
   */
  function revert() {
    epoch += 1;
    if (!current) return;
    throwAway(current);
    current = null;
    root.classList.remove('has-staged');
    syncLabelAria(false);
  }

  const labelFirst = /** @type {HTMLElement | null} */ (root.querySelector('.rs__btn-label--first'));
  const labelAgain = /** @type {HTMLElement | null} */ (root.querySelector('.rs__btn-label--again'));

  /**
   * Keep the button's accessible name to whichever wording is current.
   *
   * This is `aria-hidden` and not `visibility` on purpose, and the two are not
   * interchangeable here. The labels CROSS-FADE: for a quarter second both are painted,
   * one going out and one coming in, because a swap with a blank frame in the middle
   * looks broken. Anything that hid a label properly enough to keep it out of the
   * accessibility tree would also stop it being drawn, which is the animation.
   *
   * So the name is switched instantly, at the start of the transition, while the pixels
   * take their time. A screen reader hears the new wording from the first frame; nobody
   * ever gets "Stage this room Stage it again" read as one name.
   *
   * Note this does NOT write the labels' text — the packs still own that, and
   * language-loader.js leaves attributes it did not set alone, so a language re-apply
   * cannot undo this.
   *
   * @param {boolean} staged
   * @returns {void}
   */
  function syncLabelAria(staged) {
    if (labelFirst) labelFirst.setAttribute('aria-hidden', String(staged));
    if (labelAgain) labelAgain.setAttribute('aria-hidden', String(!staged));
  }

  const labels = /** @type {HTMLElement[]} */ ([...root.querySelectorAll('.rs__btn-label')]);
  const splitLabels = () => {
    // Drop the wave class FIRST. Fresh spans inserted while it is still on the button
    // start their hop the instant they are parented, so a language switch that happened
    // to land mid-wave made the new label twitch on its own with nobody pressing
    // anything. The spans that were mid-hop are being replaced anyway.
    button.classList.remove('is-hopping');
    labels.forEach(splitLabel);
  };
  splitLabels();
  // language-loader.js fires this at the END of a pass in which it has just assigned
  // `textContent` to every [data-lang] node — including both labels, flattening the
  // spans. Re-splitting here is what keeps the stagger alive across a language switch.
  window.addEventListener('languagechange', splitLabels);

  // Each trigger owns its own feedback, and only its own.
  button.addEventListener('click', () => {
    playPress();
    stage();
  });

  // THE PHOTO IS A TRIGGER TOO. The heading promises "Click to see what staging does",
  // and below 900px the section stacks and puts the button roughly 290px under the room —
  // far enough that on a smaller phone you cannot watch the change while you press.
  //
  // No keyboard or ARIA wiring here on purpose: `button` above is the accessible control
  // for this exact action, and giving the stack a role and a tabindex would add a second
  // tab stop announcing the same thing twice. See the note in index.html before "fixing"
  // this.
  const tapTarget = root.querySelector('[data-restage-tap]');
  if (tapTarget) {
    tapTarget.addEventListener('click', () => {
      // A drag inside the frame is a text or image selection, not a press. Without this,
      // letting go after selecting the photo stages a new room and the selection the
      // visitor was making disappears under it.
      const selection = window.getSelection();
      if (selection && !selection.isCollapsed && selection.toString().trim()) return;
      // playTap() and NOT playPress(): the room acknowledges the tap, the button stays
      // still. Bouncing the pill here threw the eye to the other side of the section at
      // the exact moment the photo it controls was changing.
      playTap();
      stage();
    });
  }

  // Self-clearing, so the class is never left on to block the next press. Scoped to the
  // button's own animation: the per-glyph hops bubble their `animationend` up here too,
  // and the first of those fires while the pill is still bouncing.
  button.addEventListener('animationend', (event) => {
    if (event.target === button) button.classList.remove('is-boing');
  });
  if (revertBtn) revertBtn.addEventListener('click', revert);
  // The repeat wording is painted from the start (it holds the button's width open) but
  // must not be announced until it is the live one. Set here rather than in the markup so
  // the served HTML stays honest if this module never runs: with no JS the button is
  // invisible anyway, and nothing has claimed a label is hidden when it is not.
  syncLabelAria(false);
  // Enable and reveal only now that the press actually works. This is the LAST time the
  // button's disabled state is touched — see note 5.
  button.disabled = false;
  root.classList.add('rs--ready');
}

function init() {
  document.querySelectorAll('[data-restage]').forEach((node) => {
    mountRestage(/** @type {HTMLElement} */ (node));
  });
}

// Guarded on `document` so test/frontend/home-restage.test.js can import makeBag
// without this trying to initialise against a DOM that is not there.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // index-deferred.js injects this module after `load`, so DOMContentLoaded fired
    // long ago — a bare listener would never run. See the trap note in that file.
    init();
  }
}
