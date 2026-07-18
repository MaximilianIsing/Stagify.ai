// Tests for the localized-URL SEO layer: the config, the pure page renderer, the
// sitemap builder, the baked-in English hreflang, and the live localized routes.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './helpers/server.js';
import {
  ALL_LOCALES,
  LOCALES,
  LOCALIZED_PAGES,
  buildHreflangCluster,
  localeByPrefix,
  localizedUrl,
} from '../lib/i18n/locales.js';
import { renderLocalizedPage } from '../lib/i18n/render-page.js';
import { buildSitemap } from '../lib/i18n/sitemap.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
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
</body>
</html>`;

const FIXTURE_TR = {
  meta: { title: 'Título ES', description: 'Descripción ES', keywords: 'kw' },
  hero: { catchphrase: 'Sube <esto>' }, // '<' verifies text is HTML-escaped
  whyUs: { body: 'Nuevo <em>HTML</em>' },
  search: { ph: 'buscar' },
  modal: { ta: 'texto' },
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
  assert.ok(out.includes('content="es_ES"'), 'og:locale not localized');
  assert.ok(out.includes('property="og:title" content="Título ES"'), 'og:title not localized');

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
