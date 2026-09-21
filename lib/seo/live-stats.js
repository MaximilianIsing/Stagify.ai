// Writes the live usage counts into the HTML the server is about to send.
//
// WHY THIS EXISTS: the hero figures were only ever written by the browser —
// public/scripts/app/hero-stats.js fetches them and public/scripts/count-up.js animates
// them in. Anything that reads the *served* markup instead of running the page (an answer
// engine, an LLM crawler, curl) saw two `&nbsp;` placeholders and reported that Stagify
// publishes no numbers. This puts them in the bytes.
//
// It is a pure string transform, applied at the two places that own a finished HTML body
// (lib/http/text-assets.js for the English statics, routes/i18n.js for the locale
// renders). Both send with res.send(), so Express derives the ETag from the injected body
// and the caching story needs no special handling — see the note at the send site.
//
// Every replacement is a no-op when it does not match. If the markup drifts, the page is
// served exactly as authored (blank figures, i.e. today's behaviour) rather than
// corrupted; test/seo/live-stats.test.js runs against the real public/index.html so the
// drift is caught at build time instead of in production.

/**
 * Group digits the same way public/scripts/count-up.js's `format` does — en-US on every
 * locale, deliberately, so the server-rendered figure and the animated one never differ
 * by a separator.
 * @param {number} n
 * @returns {string}
 */
export function formatCount(n) {
  return Math.round(n).toLocaleString('en-US');
}

// <span class="hp-stat__num" data-stat="roomsStaged" aria-hidden="true">&nbsp;</span>
// Attribute order is not assumed; the capture groups are (open tag)(key)(inner)(close).
const STAT_SPAN =
  /(<span\b[^>]*\bclass="hp-stat__num"[^>]*\bdata-stat="(roomsStaged|usersServed)"[^>]*>)([\s\S]*?)(<\/span>)/g;

const ARIA_HIDDEN = /\s+aria-hidden="true"/i;

/**
 * The `userInteractionCount` belonging to one InteractionCounter, matched by its
 * interactionType so the two counters cannot be swapped. The bounded `{0,160}` keeps the
 * match inside a single counter object.
 * @param {string} action
 */
const counterPattern = (action) =>
  new RegExp(
    // String.raw, not a plain template: `\s` in a template literal collapses to a bare
    // "s" and the pattern silently stops matching.
    String.raw`("interactionType"\s*:\s*"https://schema\.org/${action}"[\s\S]{0,160}?"userInteractionCount"\s*:\s*)\d+`,
  );

const ROOMS_COUNTER = counterPattern('CreateAction');
const USERS_COUNTER = counterPattern('RegisterAction');

/**
 * Substitute live counts into a page's hero-stat spans and its InteractionCounter
 * structured data. Idempotent, and a cheap no-op for every page without the hero block.
 *
 * @param {string} html
 * @param {import('../data/public-stats.js').PublicStats | null} stats
 * @returns {string}
 */
export function injectLiveStats(html, stats) {
  if (!stats || typeof html !== 'string') return html;
  // One indexOf over the body rules out every page but the homepage before any regex
  // runs — this sits in the path of every HTML response on the site.
  if (!html.includes('hp-stat__num')) return html;

  let out = html.replace(STAT_SPAN, (match, open, key, _inner, close) => {
    const value = stats[key];
    if (!Number.isFinite(value)) return match;
    // aria-hidden comes off: the figure is real text now, so it belongs in the
    // accessibility tree and in whatever a crawler extracts. count-up.js re-adds it for
    // the duration of the ramp and removes it again at the end, so the end state for a
    // JS visitor is unchanged.
    return `${open.replace(ARIA_HIDDEN, '')}${formatCount(value)}${close}`;
  });

  if (Number.isFinite(stats.roomsStaged)) {
    out = out.replace(ROOMS_COUNTER, (_m, head) => `${head}${Math.round(stats.roomsStaged)}`);
  }
  if (Number.isFinite(stats.usersServed)) {
    out = out.replace(USERS_COUNTER, (_m, head) => `${head}${Math.round(stats.usersServed)}`);
  }

  return out;
}
