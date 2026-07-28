// The one HTML escaper for the browser code. Anything interpolated into an
// `innerHTML` string — including the admin dashboard and the profile menu — goes
// through this.
//
// Why one shared file: there were three implementations, and one of them
// (`admin/helpers.js`'s `esc`) was `String(s || '')` — a no-op named like a
// security function, wired into three `innerHTML` sinks. Its arguments were all
// literals, so it escaped nothing and broke nothing; the hazard was the next
// person writing `esc(user.email)` and believing they had escaped it. A helper
// that lies about what it does is worse than no helper, so the name now tells the
// truth everywhere it is imported.
//
// Prefer `textContent` / the `el()` builder when you are only inserting text —
// that needs no escaping at all and can't be got wrong. Reach for this when you
// are genuinely building an HTML string.

/**
 * Escape a value for interpolation into an HTML string.
 *
 * Escapes the five characters that can change the meaning of markup: `&`, `<`,
 * `>`, `"` and `'`. Quotes matter because the value may land inside a **quoted
 * attribute** (`title="…"`, `aria-label="…"`), where escaping only `&<>` still
 * lets a quote close the attribute early. `&` is replaced first, so already-safe
 * output is never double-escaped in the wrong order.
 *
 * `null` / `undefined` become `''`; every other value is stringified, so `0`
 * renders as `"0"` rather than vanishing.
 *
 * NOTE: this is for *content and quoted attribute values*. It is not sufficient
 * for unquoted attributes, `javascript:`/`data:` URLs, inline event handlers, or
 * `<script>`/`<style>` bodies — none of which this codebase builds from data, and
 * none of which any escaper alone makes safe.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
