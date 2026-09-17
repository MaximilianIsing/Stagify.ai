// Tier: drift guard (static analysis of public/) — the site's ENTITY IDENTITY.
//
// WHY THIS EXISTS
// Four unrelated products share the name (stagify.io, stagify.app, stagify.online,
// stagifyai.com), so an answer engine that cannot pin "Stagify" to one entity answers
// about whichever one it read last. The Organization JSON-LD is what does the pinning,
// and before lib/seo/organization.js it was hand-copied into two pages and had already
// disagreed with itself: index.html listed five sameAs URLs, contact.html listed three,
// and three owned profiles were in neither. Nobody noticed, because nothing looked.
//
// So: the entity is declared once in lib/seo/organization.js, baked into every indexable
// page by scripts/build-i18n-seo.js, and compared here. A forgotten rebuild or a
// hand-edit of the baked markup fails the build — which is the only reason the single
// source of truth stays single.
//
// It also guards the two things that make the assertion mean something off-site: that
// llms.txt tells the same story as the JSON-LD, and that /about.html's FAQ answers are
// really on the page. An FAQPage whose answers a human cannot see is cloaking, and would
// put the homepage's own FAQ rich result at risk along with it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NON_AFFILIATION,
  ORGANIZATION_ID,
  SAME_AS,
  UNAFFILIATED_DOMAINS,
  WEBSITE_ID,
  organizationNode,
  websiteNode,
} from '../../lib/seo/organization.js';
import { identityPages } from '../../scripts/build-i18n-seo.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');

const read = (rel) => fs.readFileSync(path.join(PUBLIC, rel), 'utf8');

/** Every ld+json block on a page, parsed. */
function jsonLd(html) {
  return [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => JSON.parse(m[1]));
}

/** Every `.html` under public/, recursively. */
function allPages() {
  /** @param {string} dir @returns {string[]} */
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        return ['styles', 'scripts', 'fonts', 'media-webp', 'languages'].includes(e.name) ? [] : walk(p);
      }
      return e.name.endsWith('.html') ? [p] : [];
    });
  return walk(PUBLIC).map((f) => path.relative(PUBLIC, f).replace(/\\/g, '/'));
}

test('sanity: the identity page set is the indexable site, not a handful of files', () => {
  // Every assertion below iterates this list, so a list that shrank to nothing would
  // pass the whole file vacuously.
  const files = identityPages().map((p) => p.file);
  assert.ok(files.length >= 25, `expected the indexable set, got ${files.length}: ${files}`);
  for (const must of ['index.html', 'about.html', 'contact.html', 'privacy.html', 'blog/index.html']) {
    assert.ok(files.includes(must), `${must} must carry the identity block`);
  }
});

test('every indexable page carries exactly one Organization node, identical to the module', () => {
  const problems = [];
  for (const page of identityPages()) {
    const orgs = jsonLd(read(page.file)).filter((n) => n['@id'] === ORGANIZATION_ID);
    if (orgs.length !== 1) {
      problems.push(`${page.file}: ${orgs.length} #organization nodes, expected 1 — rerun node scripts/build-i18n-seo.js`);
      continue;
    }
    const want = organizationNode({ press: page.press });
    try {
      assert.deepEqual(orgs[0], want);
    } catch {
      problems.push(`${page.file}: the baked Organization differs from lib/seo/organization.js — rerun the build rather than editing the markup`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the press corroboration rides only on the two pages that are about the company', () => {
  // ~7 KB of subjectOf. On the homepage and /about it is the third-party evidence that
  // makes the entity more than a self-claim; on twenty other pages it would be weight.
  const withPress = identityPages()
    .filter((page) => jsonLd(read(page.file)).some((n) => n['@id'] === ORGANIZATION_ID && n.subjectOf))
    .map((p) => p.file)
    .sort();
  assert.deepEqual(withPress, ['about.html', 'index.html']);
});

test('the WebSite node exists exactly once, on the homepage', () => {
  const carriers = allPages().filter((f) => jsonLd(read(f)).some((n) => n['@id'] === WEBSITE_ID));
  assert.deepEqual(carriers, ['index.html'], 'there is one website; it is declared once');
  const [site] = jsonLd(read('index.html')).filter((n) => n['@id'] === WEBSITE_ID);
  assert.deepEqual(site, websiteNode());
});

test('no page declares a SECOND, anonymous Stagify Organization', () => {
  // This is the exact defect the module replaced: index.html, contact.html and the four
  // studio pages each carried their own nameless copy, and two of them had already
  // drifted apart on sameAs. An Organization named Stagify with no @id is a different
  // company as far as a crawler is concerned.
  /** @param {unknown} node @param {string[]} out */
  const walk = (node, out) => {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, out));
    if (!node || typeof node !== 'object') return;
    const obj = /** @type {Record<string, unknown>} */ (node);
    if (obj['@type'] === 'Organization' && typeof obj.name === 'string' && /^stagify/i.test(obj.name)) {
      if (obj['@id'] !== ORGANIZATION_ID) out.push(String(obj.name));
    }
    Object.values(obj).forEach((v) => walk(v, out));
  };

  const offenders = [];
  for (const file of allPages()) {
    const found = [];
    jsonLd(read(file)).forEach((n) => walk(n, found));
    if (found.length) offenders.push(`${file}: ${found.length} unidentified ${found.join(', ')}`);
  }
  assert.deepEqual(
    offenders,
    [],
    'these declare a Stagify Organization without the canonical @id, so a crawler reads ' +
      `them as separate companies — give them { "@id": "${ORGANIZATION_ID}" }:\n  ` +
      offenders.join('\n  '),
  );
});

test('the identity names every unaffiliated domain, and nothing is quietly dropped', () => {
  const org = organizationNode();
  for (const domain of UNAFFILIATED_DOMAINS) {
    assert.ok(
      String(org.disambiguatingDescription).includes(domain),
      `${domain} is in UNAFFILIATED_DOMAINS but not in the statement a crawler reads`,
    );
  }
  assert.equal(org.disambiguatingDescription, NON_AFFILIATION);
  // The short form is the string that actually collides. Losing it is losing the point.
  assert.ok(/** @type {string[]} */ (org.alternateName).includes('Stagify'));
});

test('llms.txt tells the same story as the JSON-LD', () => {
  // Two files, one set of facts. They are read by the same clients, and a crawler that
  // finds them disagreeing has learned less than if only one existed.
  const txt = fs.readFileSync(path.join(PUBLIC, 'llms.txt'), 'utf8');
  for (const domain of UNAFFILIATED_DOMAINS) {
    assert.ok(txt.includes(domain), `llms.txt does not name ${domain}`);
  }
  for (const url of SAME_AS) {
    assert.ok(txt.includes(url), `llms.txt is missing the profile ${url}, which sameAs claims`);
  }
  assert.ok(txt.includes('stagify.ai/about.html'), 'llms.txt must point at the entity hub');
  assert.ok(/not affiliated with/i.test(txt), 'llms.txt must carry the non-affiliation statement');
});

test('/about.html renders every FAQ answer it declares — no invisible Q&A', () => {
  // Cloaking guard, and the reason the disambiguation Q&A lives here rather than being
  // hidden in the homepage's FAQPage: Google requires FAQ answers to be visible on the
  // page that declares them, and a hidden one risks the rich result for the nine real
  // homepage questions too.
  const html = read('about.html');
  const [faq] = jsonLd(html).filter((n) => n['@type'] === 'FAQPage');
  assert.ok(faq, 'about.html no longer declares an FAQPage');

  // Strip tags and entities so the comparison is against what a reader actually sees.
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');

  for (const q of /** @type {Record<string, any>[]} */ (faq.mainEntity)) {
    assert.ok(visible.includes(q.name), `the question "${q.name}" is not visible on the page`);
    assert.ok(
      visible.includes(q.acceptedAnswer.text),
      `the answer to "${q.name}" is declared to crawlers but not rendered for readers`,
    );
  }
});

test('the disambiguation is visible prose on /about.html, not only structured data', () => {
  // Assistants lift spans of text far more readily than they traverse a fact graph, and
  // a human comparing four lookalike sites needs to read it too.
  const html = read('about.html');
  for (const domain of UNAFFILIATED_DOMAINS) {
    assert.ok(html.includes(domain), `/about.html does not name ${domain} in its copy`);
  }
});
