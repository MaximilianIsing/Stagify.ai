// Serves public/*.html and public/styles/*.css with their comments removed.
//
// WHY. This codebase documents itself in its source files, heavily and on purpose — the
// prose in styles.css and index.html is institutional memory, and several drift tests strip
// comments themselves before scanning precisely so it can stay. But every byte of it is
// also shipped to, decompressed by, and tokenised by every browser that loads the homepage,
// and the five render-blocking stylesheets are the one thing standing between the page and
// its first paint. Measured across those five sheets plus index.html:
//
//     raw   663,547 B -> 376,416 B   (-287,131 B the main thread no longer tokenises)
//     br q6 169,318 B ->  62,921 B   (-106,397 B on the wire, ~83 ms at PageSpeed's
//                                     10 Mbps desktop link)
//
// That is the largest single saving available on this page, and it costs nothing: the files
// on disk keep every word. The comments were 60-72% of those sheets by weight.
//
// WHAT THIS IS NOT. It is not a minifier. Whitespace, formatting, selector names and
// declaration order are all left exactly as authored, because those are what make a
// stylesheet diffable and debuggable in devtools, and squeezing them buys single-digit
// kilobytes after brotli. Only comments go.
//
// SCANNERS, NOT REGEXES. `/\/\*[\s\S]*?\*\//g` is wrong on CSS: a `/*` inside a
// `content: "..."` string or a `url(data:...)` is not a comment, and eating from there to
// the next `*/` silently deletes real declarations. Same story in HTML, where a `<!--` may
// legitimately sit inside a <script> or <style> body. Both functions below track the state
// that distinguishes those cases. The homepage happens to contain an inline <style> block
// (the noscript .reveal un-hide), so the HTML case is not hypothetical.
//
// CACHING. Results are memoised per absolute path and invalidated on mtime, so a running
// dev server still reflects edits. DEBUG_MODE bypasses the whole thing — when you are
// reading served markup to debug something, you want the comments.

import fs from 'node:fs';
import path from 'node:path';
import { DEBUG_MODE } from '../config/runtime-flags.js';
import { logger } from '../logger.js';

/**
 * Remove `/* ... *\/` comments from CSS, leaving strings and url() tokens intact.
 *
 * CSS comments do not nest, so a single pass with three states is enough: in a
 * single-quoted string, in a double-quoted string, or in code. `url(` is handled by the
 * string states when quoted; an UNQUOTED url() cannot contain `/*` and still be a valid
 * URL token (a `*` is legal but the two-character sequence would have to be escaped), so
 * it needs no state of its own.
 *
 * @param {string} src
 * @returns {string}
 */
export function stripCssComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  /** @type {'' | '"' | "'"} */
  let quote = '';

  while (i < n) {
    const c = src[i];

    if (quote) {
      out += c;
      // A backslash escapes the next character, including the closing quote.
      if (c === '\\' && i + 1 < n) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (c === quote) quote = '';
      i += 1;
      continue;
    }

    if (c === '"' || c === "'") {
      quote = /** @type {'"' | "'"} */ (c);
      out += c;
      i += 1;
      continue;
    }

    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      // An unterminated comment is a broken stylesheet either way; drop the remainder
      // rather than emitting half a comment.
      if (end === -1) return out;
      i = end + 2;
      // Leave a newline behind so two declarations that were separated only by a
      // comment do not fuse into one token.
      out += '\n';
      continue;
    }

    out += c;
    i += 1;
  }

  return out;
}

/**
 * Remove `<!-- ... -->` comments from HTML, leaving <script> and <style> bodies verbatim.
 *
 * Those two elements have raw-text/escapable-raw-text content models, so `<!--` inside them
 * is data rather than markup — and index.html really does carry an inline <style>. The
 * doctype is not a comment and is untouched.
 *
 * @param {string} src
 * @returns {string}
 */
export function stripHtmlComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;

  while (i < n) {
    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      if (end === -1) return out;
      i = end + 3;
      continue;
    }

    // Entering a raw-text element: copy through its end tag without interpreting anything.
    const raw = /^<(script|style)\b/i.exec(src.slice(i, i + 8));
    if (raw) {
      const tag = raw[1].toLowerCase();
      const close = src.toLowerCase().indexOf(`</${tag}`, i);
      if (close === -1) {
        out += src.slice(i);
        return out;
      }
      const closeEnd = src.indexOf('>', close);
      const stop = closeEnd === -1 ? src.length : closeEnd + 1;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }

    out += src[i];
    i += 1;
  }

  return out;
}

/** @type {Map<string, { mtimeMs: number, size: number, body: string }>} */
const cache = new Map();

/** Extensions this module answers for, and the stripper each one uses. */
const STRIPPERS = {
  '.css': stripCssComments,
  '.html': stripHtmlComments,
};

/**
 * The comment-stripped body for a file, memoised on (path, mtime, size).
 *
 * @param {string} absPath
 * @param {string} ext
 * @returns {string | null} null when the file cannot be read or the extension is not ours
 */
export function strippedBody(absPath, ext) {
  const strip = STRIPPERS[ext];
  if (!strip) return null;

  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return null; // Not a file we serve — let express.static answer (and 404).
  }
  if (!stat.isFile()) return null;

  const hit = cache.get(absPath);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.body;

  let body;
  try {
    body = strip(fs.readFileSync(absPath, 'utf8'));
  } catch (err) {
    // Never fail a page over this: falling through to express.static serves the
    // original file, which is correct, just larger.
    logger.warn(`[text-assets] could not strip ${path.basename(absPath)}: ${err.message}`);
    return null;
  }

  cache.set(absPath, { mtimeMs: stat.mtimeMs, size: stat.size, body });
  return body;
}

/**
 * Middleware serving stripped .html/.css out of `publicDir`, ahead of express.static.
 *
 * Everything it does not answer for calls next(), so express.static remains the single
 * source of truth for what exists, for every other extension, and for 404s.
 *
 * @param {string} publicDir
 */
export function createTextAssetMiddleware(publicDir) {
  const root = path.resolve(publicDir);

  return function serveStrippedTextAsset(req, res, next) {
    // When you are reading served markup to debug, you want the comments.
    if (DEBUG_MODE) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    let pathname;
    try {
      pathname = decodeURIComponent(req.path);
    } catch {
      return next(); // Malformed escape — express.static will deal with it.
    }

    // A directory request is express.static's `index` option, and on this site that is
    // the single most important URL there is: the homepage is served as "/", not
    // "/index.html". Resolving it here rather than leaving it to the layer below is the
    // difference between this module saving 27 KB on every real visit and saving it only
    // for whoever types the filename.
    if (pathname.endsWith('/')) pathname += 'index.html';

    const ext = path.extname(pathname).toLowerCase();
    if (!STRIPPERS[ext]) return next();

    const abs = path.resolve(root, '.' + pathname);
    // Containment check: `path.resolve` has already normalised any `..`, so this rejects
    // a traversal rather than trusting the URL.
    if (abs !== root && !abs.startsWith(root + path.sep)) return next();

    const body = strippedBody(abs, ext);
    if (body === null) return next();

    res.type(ext);
    // Matches the .html/.css arm of express.static's setHeaders below it: always
    // revalidate markup and styling so a deploy is picked up, at the cost of a 304.
    res.setHeader('Cache-Control', 'no-cache');
    // res.send() derives the ETag from THIS body. That is the point of setting it here
    // rather than reusing express.static's stat-based one, which describes the file on
    // disk — a different payload under the same ETag would poison every cache in front
    // of us. It also answers a conditional request with 304 for us.
    return res.send(body);
  };
}
