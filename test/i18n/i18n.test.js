// Tests for the localized-URL SEO layer: the config, the pure page renderer, the
// sitemap builder, the baked-in English hreflang, and the live localized routes.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../helpers/server.js';
import {
  ALL_LOCALES,
  ENGLISH,
  LOCALES,
  LOCALIZED_PAGES,
  buildHreflangCluster,
  buildOgLocaleBlock,
  localeByPrefix,
  localizedUrl,
} from '../../lib/i18n/locales.js';
import { renderLocalizedPage } from '../../lib/i18n/render-page.js';
import { buildSitemap } from '../../lib/i18n/sitemap.js';
import { injectHreflang, injectOgLocale } from '../../scripts/build-i18n-seo.js';
import { splitLocale, urlLanguage, hrefForLanguage, localizedTarget } from '../../public/scripts/i18n-routing.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'public');

// ── Config sanity ───────────────────────────────────────────────────────────

test('every locale maps to a real language file and a unique prefix', () => {
  const prefixes = new Set();
  for (const loc of LOCALES) {
    assert.ok(!prefixes.has(loc.prefix), `duplicate prefix ${loc.prefix}`);
    prefixes.add(loc.prefix);
    assert.ok(
      fs.existsSync(path.join(PUBLIC, 'languages', `${loc.lang}.json`)),
      `missing languages/${loc.lang}.json for prefix ${loc.prefix}`,
    );
  }
});

test('every localized page file exists and has a unique path', () => {
  const paths = new Set();
  for (const page of LOCALIZED_PAGES) {
    assert.ok(!paths.has(page.path), `duplicate page path ${page.path}`);
    paths.add(page.path);
    assert.ok(fs.existsSync(path.join(PUBLIC, page.file)), `missing public/${page.file}`);
  }
});

test('hreflang cluster lists every locale plus x-default', () => {
  const cluster = buildHreflangCluster('/guides.html');
  for (const loc of ALL_LOCALES) {
    assert.ok(cluster.includes(`hreflang="${loc.hreflang}"`), `cluster missing ${loc.hreflang}`);
  }
  assert.ok(cluster.includes('hreflang="x-default"'), 'cluster missing x-default');
  assert.ok(cluster.includes('href="https://stagify.ai/es/guides.html"'), 'Spanish alternate URL wrong');
});

test('og:locale block names the locale itself and every OTHER locale, never itself twice', () => {
  for (const loc of ALL_LOCALES) {
    const block = buildOgLocaleBlock(loc);
    assert.ok(
      block.startsWith(`    <meta property="og:locale" content="${loc.ogLocale}">`),
      `${loc.lang}: og:locale must be the locale's own, and come first`,
    );
    const alternates = [...block.matchAll(/og:locale:alternate" content="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(alternates.length, ALL_LOCALES.length - 1, `${loc.lang}: wrong alternate count`);
    assert.ok(!alternates.includes(loc.ogLocale), `${loc.lang}: must not list itself as its own alternate`);
    assert.equal(new Set(alternates).size, alternates.length, `${loc.lang}: duplicate alternates`);
    for (const other of ALL_LOCALES) {
      if (other.ogLocale === loc.ogLocale) continue;
      assert.ok(alternates.includes(other.ogLocale), `${loc.lang}: missing alternate ${other.ogLocale}`);
    }
  }
});

test('every locale has a distinct, well-formed og:locale', () => {
  const seen = new Set();
  for (const loc of ALL_LOCALES) {
    assert.match(loc.ogLocale, /^[a-z]{2}_[A-Z]{2}$/, `${loc.lang}: og:locale must be ll_CC`);
    assert.ok(!seen.has(loc.ogLocale), `duplicate og:locale ${loc.ogLocale}`);
    seen.add(loc.ogLocale);
    // The region half is free (pt → pt_BR), but the language half must match the
    // locale's own language — that mismatch is exactly how pt_PT survived here.
    assert.equal(loc.ogLocale.slice(0, 2), loc.bcp47.slice(0, 2), `${loc.lang}: og:locale language ≠ bcp47`);
  }
});

// ── Pure renderer ───────────────────────────────────────────────────────────

const FIXTURE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title data-lang="meta.title">English Title</title>
<meta name="description" data-lang-attr="meta.description|content" content="English description">
<link rel="canonical" href="https://stagify.ai/guides.html">
<!-- Single URL serves all languages, so we only expose x-default hreflang here. -->
<link rel="alternate" hreflang="x-default" href="https://stagify.ai/guides.html">
<meta property="og:url" content="https://stagify.ai/guides.html">
<meta property="og:locale" content="en_US">
<meta property="og:locale:alternate" content="es_ES">
<meta property="og:locale:alternate" content="ru_RU">
<meta property="og:title" content="English OG title">
</head>
<body>
<p data-lang="hero.catchphrase">Upload.</p>
<span data-lang="does.not.exist">Keep me</span>
<div data-lang-html="whyUs.body">Old <strong>bold</strong> <div>nested</div></div>
<a href="contact.html">Contact</a>
<a href="index.html#faq">FAQ</a>
<a href="#section">Section</a>
<a href="/status">Status</a>
<a href="/blog/">Blog</a>
<a href="https://example.com">External</a>
<input type="text" data-lang="search.ph" placeholder="EN placeholder">
<textarea data-lang="modal.ta">EN textarea body</textarea>
<div class="option" data-value="Dorm"><span data-lang="roomTypes.dorm">Dorm</span><span data-lang="common.newBadge">New</span></div>
</body>
</html>`;

const FIXTURE_TR = {
  meta: { title: 'Título ES', description: 'Descripción ES', keywords: 'kw' },
  hero: { catchphrase: 'Sube <esto>' }, // '<' verifies text is HTML-escaped
  whyUs: { body: 'Nuevo <em>HTML</em>' },
  search: { ph: 'buscar' },
  modal: { ta: 'texto' },
  roomTypes: { dorm: 'Habitación ES' },
  common: { newBadge: 'Nuevo' },
};

test('renderer applies translations, SEO head, base, and link rewriting', () => {
  const out = renderLocalizedPage({
    html: FIXTURE,
    translations: FIXTURE_TR,
    locale: localeByPrefix('es'),
    path: '/guides.html',
  });

  // <html> + base
  assert.match(out, /<html[^>]*\blang="es"/, 'html lang not set');
  assert.match(out, /<html[^>]*\bdata-locale="spanish"/, 'data-locale not set');
  assert.ok(out.includes('<base href="/">'), 'base tag not injected');

  // data-lang text is escaped; data-lang-html is raw; missing key keeps fallback
  assert.ok(out.includes('Sube &lt;esto&gt;'), 'text content not escaped/translated');
  assert.ok(!out.includes('Sube <esto>'), 'unescaped translated text leaked');
  assert.ok(out.includes('Nuevo <em>HTML</em>'), 'data-lang-html not applied raw');
  assert.ok(!out.includes('nested'), 'nested content not replaced (balanced close failed)');
  assert.ok(out.includes('>Keep me</span>'), 'missing key should keep the English fallback');

  // data-lang-attr + JSON-LD-adjacent meta
  assert.ok(out.includes('content="Descripción ES"'), 'meta description not translated');
  assert.ok(out.includes('<title data-lang="meta.title">Título ES</title>'), 'title not translated');

  // Sibling data-lang children under an untranslated wrapper are BOTH translated, and
  // the wrapper's own attributes survive. This is the badged-option shape from the
  // room-type dropdown (label span + "New" badge span inside a plain .option div):
  // the renderer walks left-to-right and skips past replaced inner content, so getting
  // this wrong drops the badge or eats the rest of the element.
  assert.ok(out.includes('>Habitación ES</span><span data-lang="common.newBadge">Nuevo</span>'),
    'sibling data-lang children not both translated');
  assert.ok(out.includes('<div class="option" data-value="Dorm">'),
    'wrapper attributes must survive — data-value is the untranslated API contract');

  // input/textarea are left for the client (placeholder, not content)
  assert.ok(out.includes('placeholder="EN placeholder"'), 'input placeholder should be untouched');
  assert.ok(!out.includes('>buscar<'), 'input should not get content');
  assert.ok(out.includes('>EN textarea body</textarea>'), 'textarea content should be untouched');
  assert.ok(!out.includes('>texto</textarea>'), 'textarea should not get translated content');

  // SEO head
  assert.ok(out.includes('<link rel="canonical" href="https://stagify.ai/es/guides.html">'), 'canonical wrong');
  assert.ok(!out.includes('Single URL serves all languages'), 'stale hreflang comment not removed');
  assert.equal((out.match(/hreflang="/g) || []).length, ALL_LOCALES.length + 1, 'expected full hreflang cluster');
  assert.ok(out.includes('content="https://stagify.ai/es/guides.html"'), 'og:url not localized');
  assert.ok(out.includes('property="og:title" content="Título ES"'), 'og:title not localized');

  // og:locale block: Spanish names ITSELF, lists the other ten (incl. en_US, which the
  // hand-written block omitted), and — the bug this replaced — never lists es_ES as an
  // alternate of itself. The stale hand-written en_US/ru_RU pair must be gone.
  assert.ok(out.includes('<meta property="og:locale" content="es_ES">'), 'og:locale not localized');
  assert.equal((out.match(/property="og:locale"/g) || []).length, 1, 'exactly one og:locale');
  const ogAlts = [...out.matchAll(/og:locale:alternate" content="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(ogAlts.length, ALL_LOCALES.length - 1, 'expected one alternate per OTHER locale');
  assert.ok(!ogAlts.includes('es_ES'), 'Spanish must not be an alternate of itself');
  assert.ok(ogAlts.includes('en_US'), 'en_US must be an alternate on a non-English page');
  assert.ok(ogAlts.includes('nl_NL'), 'Dutch must be listed — the hand-written block omitted it');
  assert.ok(ogAlts.includes('pt_BR') && !ogAlts.includes('pt_PT'), 'Portuguese must be pt_BR, not pt_PT');

  // link rewriting
  assert.ok(out.includes('href="/es/contact.html"'), 'relative page link not prefixed');
  assert.ok(out.includes('href="/es#faq"'), 'index.html#faq not mapped to localized home');
  assert.ok(out.includes('href="/es/guides.html#section"'), 'bare #anchor not pinned to page');
  assert.ok(out.includes('href="/es/status"'), 'root-absolute localized link not prefixed');
  assert.ok(out.includes('href="/blog/"'), 'non-localized /blog/ link should be left alone');
  assert.ok(out.includes('href="https://example.com"'), 'external link should be left alone');
});

test('renderer leaves English (no prefix) links and lang correct', () => {
  const out = renderLocalizedPage({
    html: FIXTURE,
    translations: { meta: { title: 'T' } },
    locale: localeByPrefix(''),
    path: '/guides.html',
  });
  assert.match(out, /<html[^>]*\blang="en"/);
  // No prefix rewriting for English
  assert.ok(out.includes('href="contact.html"'), 'English should keep relative links as-authored');
  assert.ok(out.includes('<link rel="canonical" href="https://stagify.ai/guides.html">'));
});

test('renderer produces localized real index.html without English title leaking', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const tr = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'languages', 'spanish.json'), 'utf8'));
  const out = renderLocalizedPage({ html, translations: tr, locale: localeByPrefix('es'), path: '/' });

  const titleMatch = out.match(/<title[^>]*>([^<]*)<\/title>/i);
  assert.ok(titleMatch, 'title present');
  assert.ok(!/Free virtual staging with one click/.test(titleMatch[1]), 'English title leaked in <title>');
  assert.ok(out.includes('<base href="/">'));
  assert.ok(out.includes('<link rel="canonical" href="https://stagify.ai/es">'));
  assert.ok(out.includes('src="scripts/gtag.js"'), 'relative asset refs must be preserved (base resolves them)');
});

// ── Sitemap + baked English hreflang (drift guards) ─────────────────────────

test('committed sitemap.xml matches the generator (rebuild if this fails)', () => {
  // Normalize EOL: a Windows checkout (core.autocrlf) yields CRLF, the generator LF.
  const committed = fs.readFileSync(path.join(PUBLIC, 'sitemap.xml'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(committed, buildSitemap(), 'sitemap.xml is stale — run: node scripts/build-i18n-seo.js');
});

test('sitemap lists every language of every page + blog', () => {
  const map = buildSitemap();
  for (const page of LOCALIZED_PAGES) {
    for (const loc of ALL_LOCALES) {
      assert.ok(map.includes(`<loc>${localizedUrl(loc, page.path)}</loc>`), `sitemap missing ${loc.prefix || 'en'} ${page.path}`);
    }
  }
  assert.ok(map.includes('<loc>https://stagify.ai/blog/</loc>'), 'sitemap missing blog hub');
});

test('every English indexable page carries the full baked-in hreflang cluster', () => {
  for (const page of LOCALIZED_PAGES) {
    // Normalize EOL: the working tree is CRLF (core.autocrlf) but the cluster string
    // is LF — compare content, not line endings (the repo stores LF either way).
    const html = fs.readFileSync(path.join(PUBLIC, page.file), 'utf8').replace(/\r\n/g, '\n');
    const cluster = buildHreflangCluster(page.path);
    assert.ok(html.includes(cluster), `${page.file} is missing/stale hreflang — run: node scripts/build-i18n-seo.js`);
  }
});

test('every English page with an Open Graph card carries the full baked-in og:locale block', () => {
  const block = buildOgLocaleBlock(ENGLISH);
  let withCard = 0;
  for (const page of LOCALIZED_PAGES) {
    const html = fs.readFileSync(path.join(PUBLIC, page.file), 'utf8').replace(/\r\n/g, '\n');
    // Pages with no og:url have no Open Graph card at all; the builder skips them on
    // purpose (a lone og:locale would describe a card that isn't there). Assert they
    // carry NO stray og:locale either, so "skipped" can't quietly mean "half-done".
    if (!/<meta\s+property="og:url"/i.test(html)) {
      assert.ok(!/property="og:locale/i.test(html), `${page.file} has og:locale but no og:url card`);
      continue;
    }
    withCard += 1;
    assert.ok(html.includes(block), `${page.file} is missing/stale og:locale — run: node scripts/build-i18n-seo.js`);
    assert.equal(
      (html.match(/property="og:locale"/g) || []).length, 1,
      `${page.file} must declare og:locale exactly once`,
    );
  }
  assert.ok(withCard > 0, 'no English page had an og:url card — the guard would be vacuous');
});

// ── Client routing helpers (public/scripts/i18n-routing.js) ─────────────────

/** Run `fn` with a stubbed browser `location`. */
function withLocation(pathname, hash, fn) {
  const prev = /** @type {any} */ (globalThis).location;
  /** @type {any} */ (globalThis).location = { pathname, hash: hash || '' };
  try {
    return fn();
  } finally {
    /** @type {any} */ (globalThis).location = prev;
  }
}

test('splitLocale separates the locale prefix from the base path', () => {
  assert.deepEqual(splitLocale('/es/guides.html'), { prefix: 'es', basePath: '/guides.html' });
  assert.deepEqual(splitLocale('/es'), { prefix: 'es', basePath: '/' });
  assert.deepEqual(splitLocale('/es/index.html'), { prefix: 'es', basePath: '/' });
  assert.deepEqual(splitLocale('/contact.html'), { prefix: '', basePath: '/contact.html' });
  assert.deepEqual(splitLocale('/'), { prefix: '', basePath: '/' });
  // a two-letter segment that isn't a known prefix is not treated as a locale
  assert.deepEqual(splitLocale('/ai-designer.html'), { prefix: '', basePath: '/ai-designer.html' });
});

test('urlLanguage returns the URL language, or null on the English root', () => {
  withLocation('/es/guides.html', '', () => assert.equal(urlLanguage(), 'spanish'));
  withLocation('/fr', '', () => assert.equal(urlLanguage(), 'french'));
  withLocation('/', '', () => assert.equal(urlLanguage(), null));
  withLocation('/contact.html', '', () => assert.equal(urlLanguage(), null));
});

test('hrefForLanguage builds the localized URL of the current page (switcher target)', () => {
  withLocation('/es/guides.html', '', () => {
    assert.equal(hrefForLanguage('french'), '/fr/guides.html'); // switch locale, same page
    assert.equal(hrefForLanguage('english'), '/guides.html'); // English drops the prefix
  });
  withLocation('/es', '', () => {
    assert.equal(hrefForLanguage('german'), '/de'); // home stays home
    assert.equal(hrefForLanguage('english'), '/');
  });
  withLocation('/guides.html', '#faq', () => {
    assert.equal(hrefForLanguage('spanish'), '/es/guides.html#faq'); // hash preserved
  });
  // a page with no localized variant (faq) sends a non-English pick to that locale's home
  withLocation('/faq.html', '', () => assert.equal(hrefForLanguage('spanish'), '/es'));
});

test('localizedTarget prefixes in-app redirects (no-op on the English root)', () => {
  withLocation('/es/ai-designer.html', '', () => {
    assert.equal(localizedTarget('stagify-plus.html'), '/es/stagify-plus.html');
    assert.equal(localizedTarget('index.html#ai-designer-demo'), '/es#ai-designer-demo');
  });
  withLocation('/ai-designer.html', '', () => {
    assert.equal(localizedTarget('stagify-plus.html'), 'stagify-plus.html'); // English → unchanged
  });
});

// ── Build script (scripts/build-i18n-seo.js) ────────────────────────────────

test('injectHreflang is idempotent and preserves line endings', () => {
  const lf = '<head>\n    <link rel="canonical" href="https://stagify.ai/contact.html">\n    <!-- next -->\n</head>';
  const once = injectHreflang(lf, '/contact.html');
  assert.equal(once, injectHreflang(once, '/contact.html'), 'running twice must equal running once');
  assert.ok(once.includes(buildHreflangCluster('/contact.html')), 'LF cluster present');
  assert.ok(!once.includes('\r\n'), 'LF input stays LF');

  const crlf = lf.replace(/\n/g, '\r\n');
  const crOnce = injectHreflang(crlf, '/contact.html');
  assert.ok(crOnce.includes('\r\n') && !/[^\r]\n/.test(crOnce), 'CRLF input stays CRLF (no lone LF)');
  assert.equal(crOnce, injectHreflang(crOnce, '/contact.html'), 'CRLF idempotent');
});

test('injectOgLocale replaces a stale block, is idempotent, and preserves line endings', () => {
  const lf = [
    '<head>',
    '    <meta property="og:url" content="https://stagify.ai/contact.html">',
    '    <meta property="og:locale" content="en_US">',
    '    <meta property="og:locale:alternate" content="pt_PT">',
    '',
    '    <meta name="twitter:card" content="summary">',
    '</head>',
  ].join('\n');

  const once = injectOgLocale(lf);
  assert.ok(once.includes(buildOgLocaleBlock(ENGLISH)), 'English block not injected at the page indent');
  assert.ok(!once.includes('pt_PT'), 'stale pt_PT alternate not removed');
  assert.equal((once.match(/property="og:locale"/g) || []).length, 1, 'og:locale duplicated');
  assert.equal(once, injectOgLocale(once), 'running twice must equal running once');
  assert.ok(!once.includes('\r\n'), 'LF input stays LF');
  // The blank line separating the OG section from the Twitter card must survive —
  // the strip regex deliberately does not swallow following blank lines.
  assert.ok(once.includes('\n\n    <meta name="twitter:card"'), 'blank-line separator eaten');

  const crlf = lf.replace(/\n/g, '\r\n');
  const crOnce = injectOgLocale(crlf);
  assert.ok(crOnce.includes('\r\n') && !/[^\r]\n/.test(crOnce), 'CRLF input stays CRLF (no lone LF)');
  assert.equal(crOnce, injectOgLocale(crOnce), 'CRLF idempotent');

  // A page with no Open Graph card is left exactly as-is — no anchor, no lone og:locale.
  const noCard = '<head>\n    <link rel="canonical" href="https://stagify.ai/terms.html">\n</head>';
  assert.equal(injectOgLocale(noCard), noCard, 'card-less page must be untouched');
});

// ── Live routes ─────────────────────────────────────────────────────────────

let server;
before(async () => { server = await startServer(); });
after(() => server?.close());
const get = (p, opts) => fetch(`${server.baseUrl}${p}`, opts);

test('localized home renders in-language with SEO head', async () => {
  const res = await get('/es');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/html/);
  const html = await res.text();
  assert.match(html, /<html[^>]*\blang="es"/);
  assert.ok(html.includes('<base href="/">'));
  assert.ok(html.includes('<link rel="canonical" href="https://stagify.ai/es">'));
  assert.ok(html.includes('hreflang="x-default"'));
});

test('localized subpages render for other locales', async () => {
  const res = await get('/fr/guides.html');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<html[^>]*\blang="fr"/);
  assert.ok(html.includes('<link rel="canonical" href="https://stagify.ai/fr/guides.html">'));
});

test('a localized page preloads ITS OWN language pack, not english.json', async () => {
  // The English source hard-codes `preload href="languages/english.json"`. Passed through
  // unchanged it was a guaranteed-unused high-priority fetch of 84 KB on every localized
  // URL — the browser then downloaded the real pack anyway (russian.json is 131 KB), so it
  // was pure waste competing with the LCP image. Both halves matter: the right pack must be
  // named AND english.json must be gone, since a preload that is never used is the bug.
  const res = await get('/ru/guides.html');
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(
    html.includes('<link rel="preload" href="languages/russian.json" as="fetch" crossorigin>'),
    'the preload should name the Russian pack, which is what language-loader.js actually fetches',
  );
  assert.ok(!html.includes('languages/english.json'), 'the unused English pack preload must be gone');
});

test('every locale rewrites the language-pack preload to its own pack', async () => {
  // One locale passing is not evidence the mapping is right — locale.lang is the
  // languages/<lang>.json basename and differs from the URL prefix on every one of them
  // (es/spanish, zh/chinese, pt/portuguese …), so a wrong token would still look plausible.
  for (const locale of LOCALES) {
    const res = await get(`/${locale.prefix}/contact.html`);
    assert.equal(res.status, 200, `/${locale.prefix}/contact.html should render`);
    const html = await res.text();
    assert.ok(
      html.includes(`href="languages/${locale.lang}.json"`),
      `/${locale.prefix}/contact.html should preload languages/${locale.lang}.json`,
    );
    assert.ok(
      !html.includes('languages/english.json'),
      `/${locale.prefix}/contact.html still preloads the English pack`,
    );
  }
});

test('the static English page still preloads english.json', async () => {
  // The rewrite must be localized-render-only; English is served as a plain static file.
  const res = await get('/contact.html');
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes('languages/english.json'));
});

test('localized home /prefix/index.html 301s to /prefix', async () => {
  const res = await get('/es/index.html', { redirect: 'manual' });
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/es');
});

test('unknown localized subpage 404s', async () => {
  assert.equal((await get('/es/not-a-real-page.html')).status, 404);
});

test('English page exposes localized alternates; sitemap is served', async () => {
  const home = await (await get('/')).text();
  assert.ok(home.includes('<link rel="alternate" hreflang="es" href="https://stagify.ai/es">'), 'English home missing es alternate');

  const map = await (await get('/sitemap.xml')).text();
  assert.ok(map.includes('https://stagify.ai/es/guides.html'), 'sitemap should list localized URLs');
  assert.ok(map.includes('xhtml:link'), 'sitemap should carry xhtml alternates');
});
