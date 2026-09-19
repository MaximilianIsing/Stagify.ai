/* Stagify.ai — the home outro's "Leave a Google review" stars.
 *
 * The link (.qr__review) is five gold stars followed by a label, and hovering it grows
 * every star to 1.22 in a 0.06s-per-star wave. This module decides WHERE that wave starts:
 * it writes each star's distance in positions from the star nearest the cursor into
 * `--qr-star-step`, and home.css multiplies that by 0.06s. Cursor on the middle star ->
 * 2,1,0,1,2, the wave spreading outward; cursor on the label -> 4,3,2,1,0, right to left.
 *
 * WHY IT HOLDS THE STARS FOR A MOMENT FIRST. Reading the cursor on `pointerenter` and
 * letting CSS take it from there does NOT work, which is how the first two cuts shipped
 * and why they both still ran left to right. `pointerenter` fires at the instant the
 * cursor crosses the link's edge, so its clientX is always an EDGE coordinate — and this
 * link is the last item in its row, so the cursor arrives horizontally and that edge is
 * the first star, every time. The visitor is aiming at the middle star or at the label;
 * the browser tells us about the boundary they crossed on the way.
 *
 * So the stars are pinned at rest (inline `scale: 1`, which outranks the stylesheet's
 * hover rule) until the cursor settles, and the wave is released from wherever it settled.
 * One wave, from the cursor, whatever direction you came from. The hold is bounded at both
 * ends — SETTLE_MS of stillness, MAX_HOLD_MS in the worst case — because a hold that waits
 * indefinitely for a drifting hand is just lag, which is exactly how it felt.
 *
 * ONCE THE WAVE HAS RUN, THAT IS THE END OF IT. Moving on across the stars does not
 * re-aim it: a grown star that drops back to rest so the wave can sweep through it again
 * reads as the link flickering, not as the wave following the cursor. The origin is the
 * question "where did the pointer arrive", and it is asked once per hover.
 *
 * PROGRESSIVE ENHANCEMENT IS THE CONTRACT, as in home-whyus.js. home.css owns the whole
 * animation and authors the left-to-right step values itself, so if this module never
 * runs the stars behave exactly as they shipped. That is also why every inline value here
 * is REMOVED rather than zeroed on the way out: a keyboard focus afterwards must get the
 * stylesheet's defaults back, not the last mouse origin.
 */

/**
 * How long the cursor must stop moving before the wave is released from where it stopped.
 */
const SETTLE_MS = 60;

/**
 * A pointermove this small or smaller is a resting hand, not a cursor going somewhere.
 * Four pixels, not one: a mouse held still twitches by a few, and at four a deliberate
 * move is so slow that treating the cursor as arrived is right anyway.
 *
 * WITHOUT IT THE HOLD NEVER ENDS. Every pointermove used to restart the settle timer, and
 * a hand at rest still produces a pixel of tremor several times a second, so the wave was
 * pushed back indefinitely — the stars sat dead for something like a second. Tremor is
 * now stillness, and stillness is what releases the wave.
 */
const JITTER_PX = 4;

/**
 * The ceiling on the hold, measured from `pointerenter` — the backstop for a
 * cursor that crosses the link without ever coming to rest on it. Deliberately generous:
 * firing it early is worse than waiting, because the wave then goes off from some star the
 * cursor is merely passing over and has to replay when it finally stops. A normal approach
 * settles long before this and never reaches it.
 */
const MAX_HOLD_MS = 350;

/** Exported so test/frontend/home-review-stars.test.js can drive it against a fake DOM. */
export function initReviewStars() {
  const link = /** @type {HTMLElement | null} */ (document.querySelector('.qr__review'));
  if (!link) return;
  const stars = /** @type {SVGElement[]} */ ([...link.querySelectorAll('.qr__stars svg')]);
  if (!stars.length) return;

  /** The star the released wave runs from, or -1 while the cursor is away or still held. */
  let origin = -1;
  /** Whether a release is armed and waiting out SETTLE_MS. */
  let armed = false;
  /** Where the cursor was last seen, so a release uses the freshest position it has. */
  let lastX = 0;
  /** When the opening hold started, so it can be capped at MAX_HOLD_MS. */
  let heldSince = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let settleTimer;

  /**
   * Index of the star whose horizontal centre is nearest `clientX`. A cursor over the
   * label, or in one of the 3px gaps, resolves to the closest star rather than to nothing.
   *
   * @param {number} clientX
   * @returns {number}
   */
  function originFor(clientX) {
    let best = 0;
    let bestGap = Infinity;
    stars.forEach((star, i) => {
      const box = star.getBoundingClientRect();
      const gap = Math.abs((box.left + box.right) / 2 - clientX);
      if (gap < bestGap) {
        bestGap = gap;
        best = i;
      }
    });
    return best;
  }

  /** Pin every star at rest, outranking the stylesheet's hover rule. */
  function hold() {
    for (const star of stars) {
      star.style.transition = 'none';
      star.style.scale = '1';
    }
  }

  /**
   * Let the held stars go, so the hover rule grows them under a wave starting at `from`.
   *
   * @param {number} from
   */
  function release(from) {
    // Flush the held state into a style recalc first. Without it the browser coalesces
    // hold() and release() into a single change, sees a scale it can reach in one step,
    // and the delays never get to stagger anything.
    void link.offsetWidth;
    stars.forEach((star, i) => {
      star.style.setProperty('--qr-star-step', String(Math.abs(i - from)));
    });
    for (const star of stars) {
      star.style.removeProperty('transition');
      star.style.removeProperty('scale');
    }
    origin = from;
  }

  /** Run the wave from wherever the cursor is now. */
  function fire() {
    release(originFor(lastX));
  }

  /** Arm the release for SETTLE_MS from now, replacing one already armed. */
  function arm() {
    clearTimeout(settleTimer);
    armed = true;
    const delay = Math.max(0, Math.min(SETTLE_MS, MAX_HOLD_MS - (Date.now() - heldSince)));
    settleTimer = setTimeout(() => {
      armed = false;
      fire();
    }, delay);
  }

  link.addEventListener('pointerenter', (event) => {
    lastX = /** @type {PointerEvent} */ (event).clientX;
    origin = -1;
    heldSince = Date.now();
    hold();
    arm();
  });

  link.addEventListener('pointermove', (event) => {
    const x = /** @type {PointerEvent} */ (event).clientX;
    // The wave has already gone: the stars are up and they stay up. Nothing this pointer
    // does inside the link is worth taking them back down to rest to re-animate.
    if (origin !== -1) return;

    const moving = Math.abs(x - lastX) > JITTER_PX;
    lastX = x;
    // A cursor still travelling pushes the release ahead of itself, so the wave goes off
    // where it stops rather than at some star it merely passed over. Once it stops, the
    // armed release is left alone and runs.
    if (moving || !armed) arm();
  });

  link.addEventListener('pointerleave', () => {
    clearTimeout(settleTimer);
    armed = false;
    origin = -1;
    for (const star of stars) {
      star.style.removeProperty('transition');
      star.style.removeProperty('scale');
      star.style.removeProperty('--qr-star-step');
    }
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initReviewStars);
  } else {
    // index-deferred.js injects this module after `load`, so DOMContentLoaded fired long
    // ago — a bare listener would never run. See the trap note at the top of that file.
    initReviewStars();
  }
}
