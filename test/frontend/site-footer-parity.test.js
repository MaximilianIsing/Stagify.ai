// Tier: markup drift guard — the shared site footer (Privacy · Terms · Status · ©),
// across every page that carries it.
//
// WHY THIS EXISTS
// This is site-header-parity.test.js's argument, one block further down the page. The
// footer is hand-copied into six public/*.html files and there cannot be a runtime
// partial: lib/i18n/render-page.js is a PURE STRING TRANSFORM over the static English
// HTML, so a footer injected by client-side JS would never be server-side translated.
// The markup has to stay literal in every file, which means the only thing standing
// between it and drift is a test.
//
// The header had that test. The footer did not, and it drifted — which is the whole
// reason this file exists. What it cost, before this guard:
//
//   • guides.html and 404.html carried NO data-lang attributes at all on the three
//     links. guides.html is in LOCALIZED_PAGES and 404.html is rendered per-locale by
//     lib/http/not-found.js, so both shipped an English "Privacy Policy / Terms of
//     Service / Status" footer on all eleven locales. All four keys already existed in
//     all eleven language packs — nothing was missing but the attributes.
//   • plus-welcome.html was missing them too (English-only, so inert — but it is one
//     copy-paste away from a localized page, and parity is cheaper than judgement).
//   • stagify-plus.html and enterprise.html had the link keys but not
//     data-lang="footer.copyright".
//   • Two rival year mechanisms coexisted: `<span id="year">` wired in app.js (index
//     only) versus `.footer-year` + scripts/footer-year.js (everywhere else).
//
// WHAT IS COMPARED
// Whitespace is collapsed before comparing, so indentation and line breaks are NOT
// policed — every attribute, element, key and text node is. Same tradeoff as the header
// guard: failing CI over a re-indent trains people to weaken the guard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicPages, footerPages, extractSiteFooter } from '../helpers/nav-pages.js';

/**
 * enterprise.html's footer is the one sanctioned second shape. It carries the same
 * links, keys and year span, but is styled by a class (`.ent-site-footer`, in
 * styles/enterprise.css) instead of the inline `style=` the other five use, and sits
 * inside the page's own bounded layout wrapper rather than spanning the viewport.
 * Its i18n hooks are still asserted below, with everyone else's.
 */
const OWN_SHAPE = new Set(['enterprise.html']);

/** Collapse to the semantic content: comments out, whitespace flat. */
function normalize(block) {
  return block
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every discovered page's footer — a page that stops being extractable must fail loudly. */
function footersByPage() {
  const pages = footerPages();
  assert.ok(
    pages.length >= 6,
    `expected the shared footer on at least 6 pages, found ${pages.length} ` +
      `(${pages.map((p) => p.name).join(', ')}) — if a page dropped it, say why here`,
  );
  return pages.map(({ name, html }) => {
    const block = extractSiteFooter(html);
    assert.ok(block, `${name}: could not extract a balanced site <footer> block`);
    return { name, block };
  });
}

test('the site footer is identical on every page that uses the shared shape', () => {
  /** @type {Map<string, string[]>} */
  const shapes = new Map();
  for (const { name, block } of footersByPage()) {
    if (OWN_SHAPE.has(name)) continue;
    const key = normalize(block);
    if (!shapes.has(key)) shapes.set(key, []);
    shapes.get(key).push(name);
  }

  assert.equal(
    shapes.size,
    1,
    'the site footer has drifted between pages — it is copied by hand into every file ' +
      'that carries it and must stay identical. Groups that disagree:\n' +
      [...shapes.values()].map((g) => '  ' + g.join(', ')).join('\n'),
  );
});

test('enterprise.html is the only page with its own footer shape', () => {
  // Pinned so a SIXTH shape cannot appear and be waved through as "that one's allowed
  // to differ" — the escape hatch has to stay exactly one page wide.
  const odd = footersByPage()
    .filter(({ block }) => !block.includes('style="text-align:center;'))
    .map(({ name }) => name);
  assert.deepEqual(
    odd.sort(),
    [...OWN_SHAPE].sort(),
    'the set of pages with a non-inline-styled site footer changed — if that is ' +
      'deliberate, update OWN_SHAPE and say why in its comment',
  );
});

test('every site footer localizes all four strings and uses the shared year span', () => {
  // Belt-and-braces over the parity check above: parity alone is satisfied by all six
  // pages being identically WRONG, which is exactly the state this change fixed.
  const required = [
    'data-lang="footer.privacy"',
    'data-lang="footer.terms"',
    'data-lang="footer.status"',
    'data-lang="footer.copyright"',
    'class="footer-year"',
  ];
  const missing = [];
  for (const { name, block } of footersByPage()) {
    for (const needle of required) if (!block.includes(needle)) missing.push(`${name}: ${needle}`);
  }
  assert.deepEqual(missing, [], `footer i18n hooks missing:\n  ${missing.join('\n  ')}`);
});

test('there is exactly one year mechanism — no page reintroduces id="year"', () => {
  // index.html used to fill `<span id="year">` from app.js while seven other pages used
  // `.footer-year` + scripts/footer-year.js. Two mechanisms meant the footer could not
  // be one block, which is how the rest of the drift got in.
  const offenders = publicPages()
    .filter((p) => p.html.includes('id="year"'))
    .map((p) => p.name);
  assert.deepEqual(offenders, [], `pages still using the retired id="year" span: ${offenders.join(', ')}`);
});

test('every page carrying the shared footer also loads footer-year.js', () => {
  // .footer-year is filled by a script, so the markup hook alone is not enough — a page
  // with the span and no script renders "© <blank> Stagify.ai".
  const missing = footerPages()
    .filter((p) => !p.html.includes('scripts/footer-year.js'))
    .map((p) => p.name);
  assert.deepEqual(missing, [], `pages with .footer-year but no footer-year.js: ${missing.join(', ')}`);
});

// ---- sanity: the guard would actually notice ------------------------------------
// A normalizer that flattens too much passes forever for the wrong reason.

test('sanity: normalize() does not hide a dropped data-lang', () => {
  const [{ block }] = footersByPage();
  const mutated = block.replace(' data-lang="footer.terms"', '');
  assert.notEqual(mutated, block, 'the mutation did not apply — update this sanity check');
  assert.notEqual(normalize(mutated), normalize(block));
});

test('sanity: normalize() does not hide a dropped link or a changed key', () => {
  const [{ block }] = footersByPage();
  const dropped = block.replace(/<a href="\/status"[^>]*>Status<\/a>/, '');
  assert.notEqual(dropped, block, 'the mutation did not apply — update this sanity check');
  assert.notEqual(normalize(dropped), normalize(block));

  const rekeyed = block.replace('data-lang="footer.privacy"', 'data-lang="footer.privacyPolicy"');
  assert.notEqual(rekeyed, block, 'the mutation did not apply — update this sanity check');
  assert.notEqual(normalize(rekeyed), normalize(block));
});

test('sanity: the extractor picks the site footer, not some other <footer> on the page', () => {
  // listing-share.html has a <footer class="sh-footer"> that is a different component:
  // it must NOT be pulled into the comparison set just for being a <footer>.
  const share = publicPages().find((p) => p.name === 'listing-share.html');
  assert.ok(share, 'listing-share.html is gone — update this check');
  assert.ok(share.html.includes('<footer'), 'listing-share.html no longer has a footer — this check is moot');
  assert.equal(extractSiteFooter(share.html), null, 'extractor mistook .sh-footer for the site footer');
});
