// Tier: markup drift guard — the shared site footer (Legal · About · Status · API · ©),
// across every page that carries it.
//
// "Legal" is a <details> disclosure holding the four legal documents — Privacy Policy,
// Terms of Service, Subprocessors, Enterprise MSA. It replaced the bare Privacy/Terms
// pair, which spent two of the footer's five slots on the least-clicked links while the
// two documents an enterprise review actually asks for were linked from nowhere but the
// legal pages themselves. The anchors stay LITERAL inside the panel — helpers/nav-pages.js
// identifies this footer by `href="privacy.html"`, and a JS-built menu would ship
// untranslated (see the pure-string-transform note below).
//
// WHY THIS EXISTS
// The footer has to sit literally in every page: lib/i18n/render-page.js is a PURE
// STRING TRANSFORM over the static English HTML, so a footer injected by client-side JS
// would never be server-side translated. It used to be hand-copied, and it drifted:
//
//   • guides.html and 404.html carried NO data-lang attributes on the links, so both
//     shipped an English footer on all eleven locales.
//   • stagify-plus.html and enterprise.html lacked data-lang="footer.copyright".
//   • Two rival year mechanisms coexisted (`<span id="year">` vs `.footer-year`).
//   • enterprise.html's classed copy drifted to a lighter colour and another font stack.
//
// It is now baked from lib/site/partials/site-footer.html by scripts/build-i18n-seo.js,
// between generated markers, and styled by `.page-footer` in styles/styles.css instead
// of inline style= attributes. This file fails the build when a page's baked copy is
// stale, or a page carries the footer without being listed in CHROME_PAGES.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicPages, footerPages, allHtmlPages, extractSiteFooter } from '../helpers/nav-pages.js';
import { CHROME_PAGES, FOOTER_BEGIN, bakedRegion, expectedRegion, injectChrome, renderSiteFooter } from '../../lib/site/chrome.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REBUILD = 'rerun `node scripts/build-i18n-seo.js`';

const listed = CHROME_PAGES.filter((p) => p.footer);

/** Every discovered page's footer — a page that stops being extractable must fail loudly. */
function footersByPage() {
  const pages = footerPages();
  // A ratchet: lowering it means a page LOST its footer, which is the thing to explain.
  assert.ok(
    pages.length >= 8,
    `expected the shared footer on at least 8 pages, found ${pages.length} ` +
      `(${pages.map((p) => p.name).join(', ')}) — if a page dropped it, say why here`,
  );
  return pages.map(({ name, html }) => {
    const block = extractSiteFooter(html);
    assert.ok(block, `${name}: could not extract a balanced site <footer> block`);
    return { name, html, block };
  });
}

test('every page carrying the site footer is listed in CHROME_PAGES', () => {
  assert.deepEqual(
    footersByPage().map((p) => p.name).sort(),
    listed.map((p) => p.file).sort(),
    'the set of pages with the site footer differs from CHROME_PAGES in lib/site/chrome.js. ' +
      `Add the page there (do not copy the footer by hand), then ${REBUILD}`,
  );
});

test('every listed page carries the current baked footer', () => {
  const stale = [];
  for (const { name, html, block } of footersByPage()) {
    const page = listed.find((p) => p.file === name);
    if (!page) continue; // reported by the listing test above
    const region = bakedRegion(html, 'footer');
    assert.ok(region, `${name}: no ${FOOTER_BEGIN.slice(0, 22)}… marker. ${REBUILD}`);
    assert.ok(region.includes(block), `${name}: the site footer sits outside its markers`);
    if (region !== expectedRegion(html, page, 'footer')) stale.push(name);
  }
  assert.deepEqual(stale, [], `the baked site footer is stale on: ${stale.join(', ')}. ${REBUILD}`);
});

test('the footer is styled by .page-footer, not inline styles', () => {
  const footer = renderSiteFooter();
  assert.ok(footer.startsWith('<footer class="page-footer">'), 'site-footer.html must open with <footer class="page-footer">');
  assert.ok(!/ style="/.test(footer), 'site-footer.html carries an inline style= — put it in .page-footer');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'styles', 'styles.css'), 'utf8');
  assert.match(css, /\.page-footer\s*\{/, 'styles.css has no .page-footer rule');
  assert.match(css, /\.page-footer a\s*\{/, 'styles.css has no .page-footer a rule');
});

test('injectChrome bakes the bare footer, then refreshes idempotently', () => {
  const bare = '<main></main>\n    <footer style="x"><a href="privacy.html">P</a><a href="/status">S</a></footer>\n';
  const page = { file: 'x.html', footer: true };
  const once = injectChrome(bare, page);
  assert.equal(injectChrome(once, page), once, 'a second run changed the output');
  assert.ok(once.includes(`\n    ${FOOTER_BEGIN}\n    <footer class="page-footer">`));
  assert.ok(!once.includes('style="x"'));
});

test('every site footer localizes every string and uses the shared year span', () => {
  // Belt-and-braces over the parity check above: parity alone is satisfied by all six
  // pages being identically WRONG, which is exactly the state this change fixed.
  const required = [
    // The four documents behind the "Legal" disclosure. Privacy and Terms moved INTO
    // it; Subprocessors and the Enterprise MSA were previously linked from nowhere but
    // the legal pages themselves.
    'data-lang="footer.legal"',
    'data-lang="footer.privacy"',
    'data-lang="footer.terms"',
    'data-lang="footer.subprocessors"',
    'data-lang="footer.msa"',
    'href="legal/subprocessors.html"',
    'href="legal/enterprise-msa.html"',
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
  // `.footer-year` + scripts/site/footer-year.js. Two mechanisms meant the footer could not
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
    .filter((p) => !p.html.includes('scripts/site/footer-year.js'))
    .map((p) => p.name);
  assert.deepEqual(missing, [], `pages with .footer-year but no footer-year.js: ${missing.join(', ')}`);
});

test('every page carrying the shared footer also loads legal-menu.js', () => {
  // The Legal menu is a native <details>, so it opens and closes without this script —
  // but Escape, the outside click and the arrow keys are all it, and a page that shipped
  // the markup without the module would lose them silently.
  const missing = footerPages()
    .filter((p) => !p.html.includes('scripts/site/legal-menu.js'))
    .map((p) => p.name);
  assert.deepEqual(missing, [], `pages with the Legal menu but no legal-menu.js: ${missing.join(', ')}`);
});

test('every .footer-year span ships a literal year, not an empty placeholder', () => {
  // The span used to ship EMPTY and be filled by scripts/site/footer-year.js. That script is
  // a module, so it is defer-by-default AND costs its own request: the footer painted as
  // "© Stagify.ai" and the year popped in about a second later. Seeding the markup makes
  // it correct in the first paint and demotes the script to a corrector.
  //
  // Checked across public/**/*.html, not just the top level: the blog and legal pages
  // carry their own footer shapes (extractSiteFooter returns null for them) and so are
  // invisible to every other test in this file — which is exactly where an empty span
  // would come back from, since new blog articles are written by copying an old one.
  //
  // Deliberately tolerant of a STALE seed (2026 still sitting there in 2027): the script
  // fixes that in the browser, and a guard that failed on New Year would block the deploy
  // — npm test gates it — at the least convenient possible moment for no visible defect.
  const years = new Map();
  for (const { name, html } of allHtmlPages()) {
    for (const m of html.matchAll(/<span class="footer-year">([^<]*)<\/span>/g)) {
      if (!years.has(m[1])) years.set(m[1], []);
      years.get(m[1]).push(name);
    }
  }
  assert.ok(years.size > 0, 'no .footer-year spans found at all — has the footer changed shape?');
  assert.equal(
    years.size,
    1,
    'the seeded copyright year disagrees between pages:\n' +
      [...years].map(([y, pages]) => `  ${y === '' ? '(empty)' : y}: ${pages.join(', ')}`).join('\n'),
  );
  const [seed] = [...years.keys()];
  assert.match(seed, /^\d{4}$/, `the seeded year is not a four-digit year: ${JSON.stringify(seed)}`);
  assert.ok(
    Number(seed) >= 2026 && Number(seed) <= new Date().getFullYear(),
    `the seeded year ${seed} is impossible — a future year would ship a wrong copyright ` +
      'until the corrector script runs, which is worse than the blank it replaced',
  );
});

test('the site footer sits after </main>, never inside it', () => {
  // enterprise.html had it INSIDE <main>, and this guard could not see it: the markup
  // was byte-correct, all four keys were there, and every assertion above passed. But
  // <main> is the scroll container on this site, so a footer in there scrolls away with
  // the content and is laid out inside the page's max-width column instead of resting
  // under the page. Same block, wrong place, and it read as a missing footer.
  //
  // Checked by index rather than by parsing: the footer must start after the LAST
  // </main> on the page. A page with no <main> at all (404.html) simply has nothing to
  // be inside of and passes trivially.
  const offenders = [];
  for (const { name, html } of footerPages()) {
    const mainClose = html.lastIndexOf('</main>');
    if (mainClose === -1) continue;
    const footer = extractSiteFooter(html);
    const at = html.indexOf(footer);
    assert.notEqual(at, -1, `${name}: the extracted footer is not findable in the source`);
    if (at < mainClose) offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    'the site footer is inside <main>, which is the scroll container, so it scrolls away ' +
      `with the page content instead of sitting under it: ${offenders.join(', ')}`,
  );
});

test('sanity: the extractor picks the site footer, not some other <footer> on the page', () => {
  // listing-share.html has a <footer class="sh-footer"> that is a different component:
  // it must NOT be pulled into the comparison set just for being a <footer>.
  const share = publicPages().find((p) => p.name === 'listing-share.html');
  assert.ok(share, 'listing-share.html is gone — update this check');
  assert.ok(share.html.includes('<footer'), 'listing-share.html no longer has a footer — this check is moot');
  assert.equal(extractSiteFooter(share.html), null, 'extractor mistook .sh-footer for the site footer');
});
