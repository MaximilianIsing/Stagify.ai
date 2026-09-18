// Tier: unit + integration — the blog's language picker (lib/i18n/blog-langs.js).
//
// WHAT THIS COVERS
// The picker is the only way a reader moves between languages of an article, and it is the
// only markup on the site whose hrefs name a locale explicitly. That makes it uniquely easy
// to break in ways that still look fine:
//
//   - render-page.js rewrites internal hrefs for the locale being rendered. Applied to this
//     menu it would point all eleven links at the current language — a switcher that cannot
//     switch, on every localized blog page, with nothing visibly wrong;
//   - it is baked into the English file by the build script, so one listing a locale whose
//     pack was deleted is a link to a 404 that no unit test of the renderer sees;
//   - injection runs on every build, so a non-idempotent one grows the file a line at a
//     time and only shows up as diff noise weeks later.
//
// Where it sits is asserted too, and is not a cosmetic detail: this shipped first as a link
// list above the footer, which is a language selector nobody scrolls far enough to find.
//
// The switcher-free decision is asserted here as well, because it reads like an omission and
// would otherwise be "fixed" by someone wiring language-switcher.js onto pages that do not
// load it.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server.js';
import { BLOG_HUB, ENGLISH, LOCALES, LOCALIZED_ARTICLES } from '../../lib/i18n/locales.js';
import { articleLocales } from '../../lib/i18n/blog-packs.js';
import { buildLangNav, injectLangNav, markCurrentLang } from '../../lib/i18n/blog-langs.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const readPublic = (rel) => fs.readFileSync(path.join(REPO_ROOT, 'public', ...rel.split('/')), 'utf8');
const pickerOf = (html) => (/<details class="blog-langs"[\s\S]*?<\/details>/.exec(html) || [null])[0];
const buttonName = (picker) => (/blog-langs__current">([^<]*)</.exec(picker) || [])[1];
const buttonFlag = (picker) => (/flags\/([A-Za-z]+\.svg)/.exec(picker) || [])[1];
/** Each menu entry as hreflang → {flag, name}, read per <li> so the button is never in it. */
const menuEntries = (picker) => [...picker.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => ({
  hreflang: (/hreflang="([^"]+)"/.exec(m[1]) || [])[1],
  flag: (/flags\/([A-Za-z]+\.svg)/.exec(m[1]) || [])[1],
  name: (/blog-langs__name">([^<]*)</.exec(m[1]) || [])[1],
}));

/** A blog page reduced to the parts injection anchors on. */
const TOPBAR = [
  '    <header class="blog-topbar">',
  '      <a class="blog-brand" href="/"><span>Stagify.ai</span></a>',
  '      <a class="blog-cta-btn" href="/" data-lang="navigation.tryFree">Try Stagify Free</a>',
  '    </header>',
  '    <main>hi</main>',
  '    <footer class="blog-footer">f</footer>',
  '',
].join('\n');

// --- the builder -----------------------------------------------------------------------

test('a picker lists exactly the locales it is given, English first and marked current', () => {
  const picker = buildLangNav('/blog/x', [ENGLISH, LOCALES[0], LOCALES[3]]);
  const links = [...picker.matchAll(/href="([^"]+)" hreflang="([^"]+)"/g)].map((m) => m.slice(1));
  assert.deepEqual(links, [['/blog/x', 'en'], ['/es/blog/x', 'es'], ['/zh/blog/x', 'zh-Hans']]);
  assert.equal((picker.match(/aria-current="page"/g) || []).length, 1);
  assert.match(picker, /hreflang="en"[^>]*aria-current="page"/);
  assert.equal(buttonName(picker), ENGLISH.label, 'the button names the language it is showing');
});

test('each entry carries its own language\'s flag', () => {
  // The failure this guards is silent and embarrassing: a flag beside the wrong language.
  // It is easy to introduce, because markCurrentLang rewrites a flag src at render time and
  // a global replace there would stamp the current locale's flag onto all eleven entries.
  const picker = buildLangNav('/blog/x', [ENGLISH, ...LOCALES]);
  assert.deepEqual(
    menuEntries(picker),
    [ENGLISH, ...LOCALES].map((l) => ({ hreflang: l.hreflang, flag: l.flag, name: l.label })),
  );
});

test('every flag a picker names is a file that exists', () => {
  // LOCALES[].flag is a filename, so a typo there is invisible until a broken image shows
  // up in the menu for one language.
  for (const locale of [ENGLISH, ...LOCALES]) {
    const file = path.join(REPO_ROOT, 'public', 'media-webp', 'flags', locale.flag);
    assert.ok(fs.existsSync(file), `${locale.lang}: no public/media-webp/flags/${locale.flag}`);
  }
});

test('the button flag is eager, the menu flags are lazy', () => {
  // The button is in the topbar, above the fold; lazy-loading it only makes it pop in late.
  // The ten in the closed menu are exactly what lazy is for.
  const picker = buildLangNav('/blog/x', [ENGLISH, ...LOCALES]);
  const button = /<summary[\s\S]*?<\/summary>/.exec(picker)[0];
  assert.ok(!button.includes('loading="lazy"'), 'the topbar flag must not be lazy');
  for (const [, item] of picker.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
    assert.ok(item.includes('loading="lazy"'), 'menu flags should be lazy');
  }
});

test('a page with no translations gets no picker at all', () => {
  // A one-entry picker is a control whose only option is the page you are already on.
  assert.equal(buildLangNav('/blog/x', [ENGLISH]), '');
  assert.equal(injectLangNav(TOPBAR, '/blog/x', [ENGLISH]), TOPBAR);
});

test('the picker lands in the topbar, before the CTA', () => {
  // Position is the whole point of this control, so it is a test rather than a convention.
  const out = injectLangNav(TOPBAR, '/blog/x', [ENGLISH, LOCALES[0]]);
  assert.ok(out.indexOf('blog-langs') > out.indexOf('blog-brand'), 'picker must follow the brand');
  assert.ok(out.indexOf('blog-langs') < out.indexOf('blog-cta-btn'), 'picker must precede the CTA');
  assert.ok(out.indexOf('blog-langs') < out.indexOf('</header>'), 'picker must be inside the topbar');
});

test('injection is idempotent, and re-injecting refreshes the list', () => {
  const once = injectLangNav(TOPBAR, '/blog/x', [ENGLISH, LOCALES[0]]);
  assert.equal(injectLangNav(once, '/blog/x', [ENGLISH, LOCALES[0]]), once, 'second build must be a no-op');

  const widened = injectLangNav(once, '/blog/x', [ENGLISH, LOCALES[0], LOCALES[1]]);
  assert.equal((widened.match(/<details class="blog-langs"/g) || []).length, 1, 'never two pickers');
  assert.match(widened, /\/fr\/blog\/x/);

  // And dropping the last pack removes the picker rather than stranding a stale one.
  assert.ok(!injectLangNav(once, '/blog/x', [ENGLISH]).includes('blog-langs'));
});

test('a page still carrying the retired footer nav loses it', () => {
  const stale = TOPBAR.replace('</main>', '</main>\n    <nav class="post-langs"><a href="/es/blog/x">x</a></nav>\n');
  const out = injectLangNav(stale, '/blog/x', [ENGLISH, LOCALES[0]]);
  assert.ok(!out.includes('post-langs'), 'the old footer nav must not survive beside the picker');
});

test('injection preserves CRLF', () => {
  const out = injectLangNav(TOPBAR.split('\n').join('\r\n'), '/blog/x', [ENGLISH, LOCALES[0]]);
  assert.ok(!/[^\r]\n/.test(out), 'a lone LF crept into a CRLF file');
});

test('markCurrentLang moves the marker, renames the button, and never leaves two', () => {
  const html = injectLangNav(TOPBAR, '/blog/x', [ENGLISH, LOCALES[0], LOCALES[3]]);
  const out = markCurrentLang(html, 'zh-Hans');
  assert.equal((out.match(/aria-current="page"/g) || []).length, 1);
  assert.match(out, /hreflang="zh-Hans"[^>]*aria-current="page"/);
  assert.ok(!/hreflang="en"[^>]*aria-current/.test(out), 'the English marker was not cleared');
  // The button must follow the marker, or every localized page shows "English" on a control
  // whose menu says otherwise.
  assert.equal(buttonName(pickerOf(out)), LOCALES[3].label);
  assert.equal(buttonFlag(pickerOf(out)), LOCALES[3].flag, 'the button kept the English flag');
  // …and the menu is untouched: the rewrite must hit the button's flag only.
  assert.deepEqual(
    menuEntries(pickerOf(out)).map((e) => e.flag),
    [ENGLISH, LOCALES[0], LOCALES[3]].map((l) => l.flag),
  );
});

test('markCurrentLang leaves a page with no picker alone', () => {
  assert.equal(markCurrentLang('<p>no picker here</p>', 'es'), '<p>no picker here</p>');
});

// --- what is committed -----------------------------------------------------------------

test('every blog page carries the picker the manifest implies', () => {
  for (const page of [BLOG_HUB, ...LOCALIZED_ARTICLES]) {
    const locales = articleLocales(page.slug);
    const picker = pickerOf(readPublic(page.file));
    if (locales.length < 2) {
      assert.equal(picker, null, `${page.file}: no translations, so no picker`);
      continue;
    }
    assert.ok(picker, `${page.file}: has translations but no language picker — rerun the i18n build`);
    const hrefs = [...picker.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(
      hrefs,
      locales.map((l) => (l.prefix ? `/${l.prefix}${page.path}` : page.path)),
      `${page.file}: the picker and lib/i18n/blog-i18n-manifest.js disagree about which `
        + 'languages exist — rerun `node scripts/build-i18n-seo.js`',
    );
  }
});

test('no blog page carries the site language switcher', () => {
  for (const file of fs.readdirSync(path.join(REPO_ROOT, 'public', 'blog'))) {
    if (!file.endsWith('.html')) continue;
    assert.ok(
      !readPublic(`blog/${file}`).includes('id="language-select"'),
      `public/blog/${file}: blog pages are server-rendered per language and load neither `
        + 'language-switcher.js nor language-loader.js. The no-JS .blog-langs <details> is '
        + 'the picker here — see lib/i18n/blog-langs.js for why.',
    );
  }
});

// --- over HTTP -------------------------------------------------------------------------

let server;
before(async () => { server = await startServer(); });
after(() => server?.close());

test('a localized page keeps all eleven hrefs and moves the marker', async () => {
  // The regression this file exists for: rewriteAnchors would otherwise prefix every href
  // in the menu with the locale being rendered.
  const article = LOCALIZED_ARTICLES.find((a) => articleLocales(a.slug).length > 1);
  if (!article) return;
  const locale = articleLocales(article.slug).find((l) => l.prefix);

  const html = await (await fetch(`${server.baseUrl}/${locale.prefix}${article.path}`)).text();
  const picker = pickerOf(html);
  assert.ok(picker, 'the localized render lost the picker');
  assert.ok(picker.includes(`href="${article.path}"`), 'the English entry was rewritten into this locale');
  assert.match(picker, new RegExp(`hreflang="${locale.hreflang}"[^>]*aria-current="page"`));
  assert.equal((picker.match(/aria-current="page"/g) || []).length, 1);
  assert.equal(buttonName(picker), locale.label, 'the button still names English');
  assert.equal(buttonFlag(picker), locale.flag, 'the button still flies the English flag');
  assert.deepEqual(
    menuEntries(picker),
    articleLocales(article.slug).map((l) => ({ hreflang: l.hreflang, flag: l.flag, name: l.label })),
    'a flag is beside the wrong language',
  );
});

test('every href the picker offers resolves', async () => {
  const article = LOCALIZED_ARTICLES.find((a) => articleLocales(a.slug).length > 1);
  if (!article) return;
  const picker = pickerOf(await (await fetch(`${server.baseUrl}${article.path}`)).text());
  for (const [, href] of picker.matchAll(/href="([^"]+)"/g)) {
    const res = await fetch(`${server.baseUrl}${href}`);
    assert.equal(res.status, 200, `the language picker offers ${href}, which does not resolve`);
  }
});

test('the accessible name is translated, not left English', async () => {
  const locale = LOCALES[0];
  const html = await (await fetch(`${server.baseUrl}/${locale.prefix}/blog/`)).text();
  const label = /blog-langs__hint[^>]*>([^<]*)</.exec(pickerOf(html));
  assert.ok(label, 'no accessible name on the picker');
  assert.notEqual(label[1], 'Read this in another language', 'navigation.readInLanguage did not resolve');
});
