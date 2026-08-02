// Element building for the share page.
//
// NOTHING HERE EVER ASSIGNS innerHTML, and that is the point of the module existing at
// all. Every string this page renders — the headline, the note, the agent's name, the
// room label — is attacker-influenced in the sense that matters: it is typed by an
// account holder and read by a stranger who is not signed in. `textContent` makes the
// whole class of injection unreachable rather than escaped, and
// test/frontend/share/share-page.test.js asserts no innerHTML write exists in this
// directory.

/**
 * Build an element with text and attributes. Text goes in via textContent, always.
 *
 * `doc` is threaded rather than read off the global so the injection main.js already
 * does is REAL: a module that takes a document and then builds nodes from
 * `globalThis.document` is only pretending to be injectable, and the seam silently stops
 * working the moment the two differ.
 *
 * @param {string} tag - Tag name.
 * @param {{ className?: string, text?: string, attrs?: Record<string, string>,
 *   children?: (Node | null | undefined)[], doc?: Document }} [options]
 * @returns {HTMLElement}
 */
export function el(tag, options = {}) {
  const node = (options.doc ?? document).createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined && options.text !== null) node.textContent = String(options.text);
  for (const [key, value] of Object.entries(options.attrs ?? {})) {
    if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  for (const child of options.children ?? []) if (child) node.appendChild(child);
  return node;
}

/**
 * Replace an element's children.
 * @param {Element | null} parent @param {(Node | null | undefined)[]} children
 */
export function replaceChildren(parent, children) {
  if (!parent) return;
  parent.textContent = '';
  for (const child of children) if (child) parent.appendChild(child);
}

/**
 * A `mailto:`/`tel:` href that is safe to put in the DOM.
 *
 * VALIDATION, NOT ESCAPING. The agent's email and phone come from a text field they typed
 * and end up in an `href` a stranger clicks. Escaping the string would still let
 * `javascript:...` through, because the danger is the SCHEME, not the characters. So this
 * builds the URL from a scheme we chose plus a value that has to match a conservative
 * shape — anything else returns null and the caller renders plain text instead of a link.
 *
 * @param {'mailto' | 'tel'} scheme
 * @param {unknown} value - The agent-supplied contact detail.
 * @returns {string | null} A safe href, or null when the value cannot make one.
 */
export function contactHref(scheme, value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || raw.length > 120) return null;
  if (scheme === 'mailto') {
    // Deliberately strict: one @, no spaces, no control characters, no colons (which is
    // what stops a nested scheme).
    if (!/^[^\s@:;,<>"']+@[^\s@:;,<>"']+\.[A-Za-z]{2,}$/.test(raw)) return null;
    return `mailto:${encodeURIComponent(raw)}`;
  }
  if (scheme === 'tel') {
    if (!/^\+?[0-9][0-9 ()\-.]{4,30}$/.test(raw)) return null;
    return `tel:${raw.replace(/[^\d+]/g, '')}`;
  }
  return null;
}
