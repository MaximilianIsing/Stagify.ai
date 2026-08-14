// The copy rules, enforced mechanically.
//
// Rule one of this tool is "never use em dashes". That rule cannot live in a prompt: the
// repo's own post instagram/history/backfill/07-27.png shipped with one ("Coastal preset —
// staged in ~8 seconds"), written by a careful human who meant not to. So it is a gate the
// render path runs, and a hit is a hard failure.
//
// The ban covers the whole family, not just U+2014. An en dash used as a sentence break
// reads exactly like the thing being banned, and a bare " -- " is the ASCII spelling of it.

/** @type {ReadonlyArray<{ char: string, name: string }>} */
export const BANNED_DASHES = Object.freeze([
  { char: '‒', name: 'figure dash U+2012' },
  { char: '–', name: 'en dash U+2013' },
  { char: '—', name: 'em dash U+2014' },
  { char: '―', name: 'horizontal bar U+2015' },
  { char: '⸺', name: 'two-em dash U+2E3A' },
  { char: '⸻', name: 'three-em dash U+2E3B' },
]);

/** ASCII double hyphen used as a dash. A hyphenated word or a CLI flag must not trip this. */
const ASCII_DASH = /(?<=\s)--(?=\s)|(?<=\w)\s--\s(?=\w)/g;

const EXCERPT_RADIUS = 30;

function excerptAt(text, index) {
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(text.length, index + EXCERPT_RADIUS);
  return `${start > 0 ? '...' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '...' : ''}`;
}

/**
 * @param {string} text
 * @returns {Array<{ name: string, index: number, excerpt: string }>}
 */
export function findDashes(text) {
  if (typeof text !== 'string' || !text) return [];
  const hits = [];

  for (const { char, name } of BANNED_DASHES) {
    let from = 0;
    for (;;) {
      const index = text.indexOf(char, from);
      if (index === -1) break;
      hits.push({ name, index, excerpt: excerptAt(text, index) });
      from = index + 1;
    }
  }

  for (const match of text.matchAll(ASCII_DASH)) {
    hits.push({
      name: 'ASCII double hyphen used as a dash',
      index: match.index ?? 0,
      excerpt: excerptAt(text, match.index ?? 0),
    });
  }

  return hits.sort((a, b) => a.index - b.index);
}

/**
 * @param {string} text
 * @param {string} where human-readable location, used in the thrown message
 */
export function assertNoDashes(text, where) {
  const hits = findDashes(text);
  if (!hits.length) return;
  const detail = hits
    .map((h) => `  ${h.name} at ${h.index}: ${h.excerpt}`)
    .join('\n');
  throw new Error(`Banned dash in ${where}:\n${detail}\nRewrite the sentence. Use a period, a comma, or a colon.`);
}

/**
 * Strip `<style>` and `<script>` bodies before scanning generated markup.
 *
 * Necessary, not cosmetic: brand-css.js inlines the site's own :root block, and that block
 * carries the comment "Brand blues — the ramp the app actually paints with." Scanning raw
 * HTML would fail every render on a dash that no viewer will ever see, and the fix people
 * would reach for is disabling the check.
 * @param {string} html
 */
export function stripNonVisibleBlocks(html) {
  return String(html)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '<style></style>')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '<script></script>');
}

/**
 * Scan a rendered document for banned dashes in anything a viewer can actually read:
 * text nodes and attribute values, with stylesheets and scripts removed first.
 * @param {string} html
 * @param {string} where
 */
export function assertHtmlClean(html, where) {
  assertNoDashes(stripNonVisibleBlocks(html), where);
}

/**
 * The copy limits from config.json, enforced.
 *
 * These were declared in config and checked by nobody, which is how the first real post
 * reached its hand-off folder with 205 characters of alt text against a documented limit of
 * 100. A limit that lives only in a config file is a suggestion.
 *
 * @param {object} record a post record
 * @param {object} config the parsed config.json
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function checkCopy(record, config) {
  const problems = [];
  const limits = config.caption;
  const copy = record.copy ?? {};

  if (!copy.caption) {
    problems.push('no caption');
  } else if (copy.caption.length > limits.maxChars) {
    problems.push(`caption is ${copy.caption.length} chars, limit ${limits.maxChars}`);
  }

  if (copy.altText && copy.altText.length > limits.altMaxChars) {
    problems.push(`alt text is ${copy.altText.length} chars, limit ${limits.altMaxChars}`);
  }
  if (!copy.altText) problems.push('no alt text');

  const tags = record.hashtagSet ?? [];
  const [minTags, maxTags] = limits.hashtagRange;
  if (tags.length < minTags || tags.length > maxTags) {
    problems.push(`${tags.length} hashtags, expected ${minTags} to ${maxTags}`);
  }
  for (const tag of tags) {
    if (!/^#[a-z0-9_]+$/.test(tag)) problems.push(`hashtag "${tag}" is not lowercase alphanumeric`);
  }

  // The disclosure is not optional on anything containing a render.
  const hasRender = (record.images ?? []).some((i) => i.source === 'stagify');
  if (hasRender && !/virtually staged/i.test(copy.caption ?? '')) {
    problems.push('caption does not carry the virtual staging disclosure');
  }

  // Per-post tracked links were deliberately not built. A caption inventing one sends
  // people to a URL that does not resolve.
  if (/[?&](utm_|ref=)/i.test(copy.caption ?? '')) {
    problems.push('caption contains a tracked URL; this account uses one static bio link');
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Walk every string in a nested object and assert it is clean.
 * @param {unknown} value
 * @param {string} where
 */
export function assertCopyClean(value, where) {
  const walk = (node, keyPath) => {
    if (typeof node === 'string') {
      assertNoDashes(node, `${where}${keyPath}`);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${keyPath}[${i}]`));
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) walk(child, `${keyPath}.${key}`);
    }
  };
  walk(value, '');
}
