// Taking the page behind a modal out of the accessibility tree and the tab order.
//
// `aria-modal="true"` only tells a screen reader that the dialog is modal. It does
// nothing to the rest of the document: the virtual cursor still reads the whole page
// underneath, and Tab still walks into it. A dialog can therefore be modal to the eye,
// modal to the mouse (a full-viewport backdrop swallows the clicks) and completely
// porous to a keyboard and a reader — which is exactly how both dialogs in this app
// shipped. The gallery's Tab trap hid its half of the problem; the auth modal has no
// trap at all, so Tab simply left the dialog and kept going through the nav behind it.
//
// `inert` is the attribute that actually does it: an inert subtree is unfocusable,
// unreachable by Tab, and hidden from assistive technology. It is a **boolean content
// attribute**, so the correct value is the empty string — `setAttribute('inert', '')`,
// never `'true'`. Where it is unsupported it is simply ignored, which is the behaviour
// we have today, so there is no fallback to write.
//
// Everything here goes through setAttribute/removeAttribute and plain child lists
// rather than the `.inert` IDL property or `querySelectorAll`, because the specs on
// both call sites drive hand-built document stand-ins (test/helpers/auth-modal-dom.js,
// and the gallery's own) rather than jsdom. Keep it that way — a helper the tests
// cannot drive is a helper that stops being tested.

/**
 * Toggle `inert` on a set of nodes.
 *
 * Null/undefined entries are skipped so callers can pass the result of a lookup
 * straight in without filtering — a missing landmark is not an error, it just means
 * there is nothing to take out of the tree on that page.
 *
 * @param {ArrayLike<any>} nodes
 * @param {boolean} on
 * @returns {void}
 */
export function setInert(nodes, on) {
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (!node || typeof node.setAttribute !== 'function') continue;
    if (on) node.setAttribute('inert', '');
    else node.removeAttribute('inert');
  }
}

/**
 * Everything that should go inert while `modal` is open: every direct child of
 * `<body>` except the modal itself.
 *
 * Direct children of `<body>`, rather than a hand-listed set of landmark ids, because
 * this has to work on every page the auth modal is injected into — and those pages do
 * not agree on their structure (five have no `<main>` at all). Body children is the one
 * partition that holds everywhere, and it cannot miss a sibling somebody adds later.
 *
 * Both dialogs that use this are mounted as direct children of `<body>`
 * (`document.body.insertBefore(…, document.body.firstChild)` for the auth modal), which
 * is what makes the exemption a simple identity check. A dialog nested deeper would
 * have its own ancestors inerted and go dead along with the page, so if you mount one
 * inside `<main>`, do not reach for this.
 *
 * @param {any} modal The dialog to leave interactive.
 * @param {any} [doc] Document to read; defaults to the global one.
 * @returns {any[]}
 */
export function backgroundOf(modal, doc) {
  const d = doc || document;
  const kids = (d.body && d.body.children) || [];
  const out = [];
  for (let i = 0; i < kids.length; i += 1) {
    if (kids[i] !== modal) out.push(kids[i]);
  }
  return out;
}
