// A three-line element builder, and the reason this page has no escaper in it.
//
// Every string on this page is operator-supplied: the listing title, the address, the
// headline, the agent's name, the free-text note. They are typed into the Listing Studio
// by a broker and rendered to a stranger on a phone, which is exactly the shape of an XSS
// bug. The repo has a shared `escapeHtml` (public/scripts/escape-html.js) for code that
// genuinely builds HTML strings — but the better answer, which that file's own header
// points at, is not to build HTML strings at all.
//
// So: NOTHING in public/scripts/share/ assigns `innerHTML`, `outerHTML` or calls
// `insertAdjacentHTML`. Text goes in through `textContent` and attributes through
// `setAttribute`, both of which treat their input as data by construction — there is no
// escaping to get wrong, no attribute-context edge case, and no way for a future edit to
// reintroduce one without switching APIs. test/frontend/share/share-page.test.js asserts
// that, by driving the render against a document that RECORDS any innerHTML write and
// failing if the count is not zero.

/**
 * @typedef {object} ElOptions
 * @property {string} [className]
 * @property {string} [id]
 * @property {string|number|null} [text] - Set via textContent. Never parsed as markup.
 * @property {Record<string, string|number|boolean|null|undefined>} [attrs] - `false`,
 *   `null` and `undefined` values are skipped; `true` becomes a bare attribute.
 * @property {Record<string, string>} [style] - Applied with setProperty, so custom
 *   properties (`--sh-pos`) work alongside ordinary declarations.
 * @property {Record<string, (event: any) => void>} [on] - addEventListener pairs. This is
 *   the ONLY way a handler is attached anywhere on this page: the site's CSP forbids
 *   inline `on*` attributes and inline <script>, and an inline module script silently
 *   no-ops rather than erroring.
 * @property {any[]} [children] - Falsy entries are skipped, so a conditional child can be
 *   written inline.
 */

/**
 * Build an element.
 * @param {Document} doc
 * @param {string} tag
 * @param {ElOptions} [options]
 * @returns {any} The new element.
 */
export function el(doc, tag, options = {}) {
  const node = doc.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.id) node.id = options.id;
  if (options.text !== undefined && options.text !== null) node.textContent = String(options.text);

  for (const [name, value] of Object.entries(options.attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    node.setAttribute(name, value === true ? '' : String(value));
  }
  for (const [name, value] of Object.entries(options.style || {})) {
    node.style.setProperty(name, String(value));
  }
  for (const [type, handler] of Object.entries(options.on || {})) {
    node.addEventListener(type, handler);
  }
  for (const child of options.children || []) {
    if (child) node.appendChild(child);
  }
  return node;
}

/**
 * Empty a container. Assigning `textContent = ''` detaches the children exactly the way
 * the browser does, and — unlike `innerHTML = ''` — keeps this module's no-markup rule
 * intact.
 * @param {any} node
 * @returns {void}
 */
export function clear(node) {
  if (node) node.textContent = '';
}

/**
 * Show or hide a node with the `hidden` attribute (not a class), so the element is out of
 * the accessibility tree and out of the tab order, not merely invisible.
 * @param {any} node
 * @param {boolean} hidden
 * @returns {void}
 */
export function setHidden(node, hidden) {
  if (!node) return;
  if (hidden) node.setAttribute('hidden', '');
  else node.removeAttribute('hidden');
}
