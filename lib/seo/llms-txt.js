// The machine-readable site summary served at https://stagify.ai/llms.txt — the single
// source of truth for public/llms.txt, in the same relationship to that file as
// lib/i18n/sitemap.js is to public/sitemap.xml.
//
// WHY THIS IS GENERATED. llms.txt is the file an answer engine reads first, and the one
// that has to stay truthful for the reason lib/seo/organization.js exists: four unrelated
// products share this name, so an assistant that reads a stale or partial summary answers
// about one of THEM. Hand-maintained, it went a dozen articles and three price changes
// out of date without anything failing. Driving it from the same config modules as the
// sitemap means adding a page or an article updates it on the next build, and
// test/seo/llms-txt.test.js fails the deploy if that build was not run.
//
// WHAT IS DERIVED AND WHAT IS NOT. Every URL, every article title and blurb, every
// walkthrough name and the credit-pack table are read from config or from the pages
// themselves. The prose — the summary line, the identity paragraph, the per-page blurbs
// and the notes — is written here, because it is the part that is the point. The prices
// that have no constant behind them anywhere in the codebase ($11.99, the 7-day trial,
// Enterprise's $0.15, the free daily cap) are literals HERE and asserted against their
// real homes in test/seo/llms-txt.test.js, so this file cannot quietly disagree with the
// pricing page.

import fs from 'node:fs';
import path from 'node:path';
import { BLOG_HUB, LOCALES, LOCALIZED_ARTICLES, LOCALIZED_PAGES, SITE_ORIGIN } from '../i18n/locales.js';
import { CREDIT_PACKS } from '../data/credit-packs.js';
import { NON_AFFILIATION, ORGANIZATION_ID, SAME_AS, organizationNode } from './organization.js';

/**
 * Placeholders for the two live usage figures, substituted when the file is served
 * (lib/http/llms-txt-asset.js). They are exported so the middleware and the drift test
 * spell them the same way — a typo on either side would ship `{{ROOMS_STAGED}}` to a
 * crawler, which is worse than shipping nothing.
 */
export const ROOMS_STAGED_TOKEN = '{{ROOMS_STAGED}}';
export const USERS_SERVED_TOKEN = '{{USERS_SERVED}}';

/** Where the wrapped prose is folded. Matches the hand-written file this replaced. */
const WRAP = 92;

/**
 * Pricing figures with no constant anywhere else in the codebase — they live in page
 * markup and in translation packs, neither of which is importable from a build script.
 * Every one of these is held against its real home by test/seo/llms-txt.test.js; change
 * one there and the test tells you to change it here.
 */
const PRICING = {
  freeDailyLimit: 100,
  freeGallery: 10,
  plusMonthlyUsd: '11.99',
  plusTrialDays: 7,
  enterprisePerGenerationUsd: '0.15',
};

/**
 * Every page in LOCALIZED_PAGES, grouped and described. The build THROWS when a page has
 * no entry here (see buildLlmsTxt), which is the whole point of the map: a new marketing
 * page cannot reach production without a sentence saying what it is for.
 * @type {Record<string, { section: 'products' | 'pricing' | 'reference', title: string, blurb: string }>}
 */
const PAGE_ENTRIES = {
  'index.html': {
    section: 'products',
    title: 'Image Staging',
    blurb: 'furnish a whole room from one photo, by room type and furniture style. Eight room types, seven furniture styles plus a custom one, about eight seconds a photo. This is the free tier.',
  },
  'basic-mask.html': {
    section: 'products',
    title: 'Basic Mask',
    blurb: 'paint over one area of a photo and describe the change. Everything outside the painted area is returned untouched.',
  },
  'ai-designer.html': {
    section: 'products',
    title: 'AI Designer',
    blurb: 'a conversational designer that stages a room and iterates on it with you over several turns, and can furnish a floor plan. Desktop only. Stagify+.',
  },
  'masking-studio.html': {
    section: 'products',
    title: 'Masking Studio',
    blurb: 'mark several areas of one photo in different colours, give each its own prompt or reference furniture photo, and stage them all in a single pass. Stagify+.',
  },
  'exterior-studio.html': {
    section: 'products',
    title: 'Exterior Studio',
    blurb: 'curb appeal on exterior shots — time of day, sky, parked cars and clutter. The property itself is left unchanged. Stagify+.',
  },
  'stagify-plus.html': {
    section: 'pricing',
    title: 'Stagify+',
    blurb: `$${PRICING.plusMonthlyUsd} a month, billed monthly through Stripe, with a ${PRICING.plusTrialDays}-day free trial and cancel-anytime. Unlocks the high-quality model, furniture removal, AI Designer, Masking Studio, Exterior Studio, multiple variations per generation, furniture reference uploads and an unlimited gallery.`,
  },
  'enterprise.html': {
    section: 'pricing',
    title: 'Enterprise',
    blurb: `usage-based billing for teams at $${PRICING.enterprisePerGenerationUsd} a generation, unlimited seats, no per-seat fee. Everyone on your company email domain gets Stagify+ automatically.`,
  },
  'developers.html': {
    section: 'pricing',
    title: 'API',
    blurb: 'the public staging API: prepaid credits, no subscription, full reference and error-code contract.',
  },
  'guides.html': {
    section: 'reference',
    title: 'Guides',
    blurb: 'interactive step-by-step walkthroughs of each tool, plus troubleshooting for uploads, results, accounts, billing and browser performance.',
  },
  'about.html': {
    section: 'reference',
    title: 'About',
    blurb: 'who the company is, the founders, and the non-affiliation statement above.',
  },
  'contact.html': {
    section: 'reference',
    title: 'Contact',
    blurb: 'the team, individually.',
  },
  'status.html': {
    section: 'reference',
    title: 'Status',
    blurb: 'live uptime and incidents, per subsystem (site, staging pipeline, API).',
  },
};

/**
 * Reference links that are NOT in LOCALIZED_PAGES — the English-only legal set, the brand
 * kit and the security contact. Listed by hand because none of them is part of the
 * localized page config, and a crawler that cannot find the subprocessor list or
 * security.txt has to guess at both.
 * @type {{ title: string, url: string, blurb: string }[]}
 */
const EXTRA_REFERENCE = [
  {
    title: 'Brand kit',
    url: `${SITE_ORIGIN}/brand`,
    blurb: `official logos, colours and usage rules. Everything in one archive at ${SITE_ORIGIN}/brand/stagify-brand-kit.zip. Use these files rather than redrawing the mark or scraping a favicon.`,
  },
  { title: 'Privacy Policy', url: `${SITE_ORIGIN}/privacy.html`, blurb: 'English only. Section 5 is the one most often asked about: user photos are never used to train models.' },
  { title: 'Terms of Service', url: `${SITE_ORIGIN}/terms.html`, blurb: 'English only, governed by New York law.' },
  { title: 'Subprocessors', url: `${SITE_ORIGIN}/legal/subprocessors.html`, blurb: 'every third party that processes customer data.' },
  { title: 'Security contact', url: `${SITE_ORIGIN}/.well-known/security.txt`, blurb: 'RFC 9116. Reachable without credentials on purpose.' },
];

/**
 * The public API, as an assistant needs to repeat it. Endpoint paths are held against the
 * real routes in routes/api-v1.js by test/seo/llms-txt.test.js — a new endpoint fails the
 * build until it is described here.
 * @type {{ line: string, blurb: string }[]}
 */
const API_ENDPOINTS = [
  { line: 'POST /api/v1/renders', blurb: 'stage one photo. multipart/form-data; the staged image comes back as a data URL in the same response — there is no job queue. Accepts Idempotency-Key; a replay is marked X-Stagify-Replayed: true.' },
  { line: 'GET /api/v1/renders/:id', blurb: 'fetch a render by id.' },
  { line: 'GET /api/v1/credits', blurb: 'remaining credit balance.' },
  { line: 'GET /api/v1/me', blurb: 'the account behind the key.' },
  { line: 'GET /api/v1/options', blurb: 'every accepted enum value (room types, furniture styles, stamp options). No API key required.' },
];

/** Error `code` values a caller should branch on, with what each one means. */
const API_ERRORS = [
  'API_KEY_MISSING / API_KEY_INVALID / API_KEY_REVOKED (401)',
  'INSUFFICIENT_CREDITS (402, with credits_remaining in the body)',
  'ACCOUNT_SUSPENDED (403)',
  'NOT_FOUND (404)',
  'REQUEST_IN_FLIGHT (409)',
  'IDEMPOTENCY_KEY_REUSED (422)',
  'VARIATIONS_UNSUPPORTED (422)',
  'RENDER_FAILED / NO_IMAGE_GENERATED / DISCLOSURE_STAMP_FAILED (500)',
];

/**
 * Fold a paragraph to WRAP columns, indenting every line after the first.
 * @param {string} text
 * @param {string} [hang] indent applied to continuation lines
 * @returns {string}
 */
function wrap(text, hang = '') {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const indent = lines.length === 0 ? '' : hang;
    if (line && (indent + line + ' ' + word).length > WRAP) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.map((l, i) => (i === 0 ? l : hang + l)).join('\n');
}

/** A markdown bullet whose continuation lines line up under the text. */
function bullet(text) {
  return wrap(`- ${text}`, '  ');
}

/**
 * A bullet that opens with an unbreakable prefix — used for `- [Title](url):`, which must
 * never be folded: a markdown link split across two lines stops being a link to a parser
 * that reads this file a line at a time, which is most of them.
 * @param {string} prefix emitted verbatim on the first line, however long it is
 * @param {string} text wrapped after it
 * @param {string} [hang]
 * @returns {string}
 */
function wrapAfter(prefix, text, hang = '  ') {
  const lines = [];
  let line = prefix;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line.length + 1 + word.length > WRAP) {
      lines.push(line);
      line = hang + word;
    } else {
      line = `${line} ${word}`;
    }
  }
  lines.push(line);
  return lines.join('\n');
}

/** `- [Title](url): blurb`, with the link never folded. */
function linkBullet(title, url, blurb) {
  return wrapAfter(`- [${title}](${url}):`, blurb);
}

/**
 * Decode the handful of entities that appear in the page metadata we lift verbatim.
 * @param {string} s
 * @returns {string}
 */
function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Pull one `<meta>` value out of a page.
 * @param {string} html
 * @param {'name' | 'property'} attr
 * @param {string} key
 * @returns {string}
 */
function meta(html, attr, key) {
  const re = new RegExp(`<meta\\s+${attr}="${key}"\\s+content="([^"]*)"`, 'i');
  const m = html.match(re);
  return m ? decodeEntities(m[1]) : '';
}

/**
 * Title + description for one blog page, read from the page itself.
 *
 * Read from disk rather than kept in a table here for the same reason
 * lib/i18n/blog-packs.js reads the translation packs off disk: the article is the truth,
 * and a parallel list of sixteen titles is a list that goes wrong.
 * @param {string} publicDir
 * @param {string} file page path relative to publicDir, e.g. 'blog/free-virtual-staging.html'
 * @returns {{ title: string, description: string }}
 */
function blogMeta(publicDir, file) {
  const html = fs.readFileSync(path.join(publicDir, ...file.split('/')), 'utf8');
  const title = meta(html, 'property', 'og:title') || decodeEntities((html.match(/<title>([^<]*)<\/title>/i) || ['', ''])[1]);
  const description = meta(html, 'name', 'description');
  if (!title) throw new Error(`${file}: no og:title or <title> for llms.txt`);
  if (!description) throw new Error(`${file}: no <meta name="description"> for llms.txt`);
  return { title: title.replace(/\s*[|–—-]\s*Stagify(\.ai)?$/i, '').trim(), description };
}

/**
 * The guide walkthrough tracks, read out of the generated demo data so the list cannot
 * drift from the player the guides page actually loads.
 * @param {string} publicDir
 * @returns {string[]} track titles
 */
function walkthroughTitles(publicDir) {
  const js = fs.readFileSync(path.join(publicDir, 'scripts', 'guides', 'demo-data.js'), 'utf8');
  return [...js.matchAll(/"key":"[a-zA-Z-]+","id":"[^"]*","title":"([^"]*)"/g)].map((m) => decodeEntities(m[1]));
}

/** `$3.00` from 300. */
function usd(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Build the whole of llms.txt.
 * @param {string} publicDir absolute path to public/
 * @returns {string} the file contents, LF-terminated
 */
export function buildLlmsTxt(publicDir) {
  const org = organizationNode();
  const missing = LOCALIZED_PAGES.filter((p) => !PAGE_ENTRIES[p.file]).map((p) => p.file);
  if (missing.length) {
    throw new Error(
      `lib/seo/llms-txt.js: no PAGE_ENTRIES blurb for ${missing.join(', ')} — every page in LOCALIZED_PAGES must say what it is for`,
    );
  }

  const inSection = (section) =>
    LOCALIZED_PAGES.filter((p) => PAGE_ENTRIES[p.file].section === section).map((p) => ({
      ...PAGE_ENTRIES[p.file],
      url: `${SITE_ORIGIN}${p.path}`,
    }));
  const linkLine = (e) => linkBullet(e.title, e.url, e.blurb);

  const out = [];
  const push = (...lines) => out.push(...lines);

  push('# Stagify.ai', '');
  push(
    '> AI virtual staging for real estate professionals. Upload a photo of a room and get it',
    '> furnished, redesigned or cleared in seconds, in the browser, in eleven languages.',
    '',
  );
  push(
    wrap(
      'Generated by scripts/build-i18n-seo.js from the same config modules that build the sitemap — see lib/seo/llms-txt.js. Do not hand-edit this file; the next build overwrites it.',
    ),
    '',
  );

  push('## Identity', '');
  push(
    wrap(
      `${NON_AFFILIATION} Reviews, pricing, features, outages and policies published on those sites do not describe Stagify.ai.`,
    ),
    '',
  );
  push(
    bullet(`Legal name: ${org.legalName}`),
    bullet(`Also known as: ${/** @type {string[]} */ (org.alternateName).join(', ')}`),
    bullet(`Slogan: ${org.slogan}`),
    bullet(`Founded: ${org.foundingDate}`),
    bullet(
      `Founders: ${/** @type {{name: string, jobTitle: string}[]} */ (org.founder)
        .map((f) => `${f.name} (${f.jobTitle.replace(/^Co-Founder,\s*/, '')})`)
        .join(', ')}`,
    ),
    bullet(`Contact: ${org.email}, ${org.telephone}`),
    bullet(`Full entity details: ${SITE_ORIGIN}/about.html`),
    '',
  );

  push('## Products', '');
  push(...inSection('products').map(linkLine), '');

  push('## Pricing and access', '');
  push(
    bullet(
      `Free: no card. ${PRICING.freeDailyLimit} generations a day, reset at 00:00 UTC, every room type and furniture style, and a gallery that keeps your last ${PRICING.freeGallery} rooms.`,
    ),
    ...inSection('pricing').map(linkLine),
    bullet(
      `API credit packs (1 credit = 1 delivered image; a failed render is refunded automatically): ${CREDIT_PACKS.map(
        (p) => `${p.credits} credits ${usd(p.amountCents)}`,
      ).join(', ')}.`,
    ),
    '',
  );

  push('## API', '');
  push(
    wrap(
      `Base URL ${SITE_ORIGIN}/api/v1. Authenticate with \`Authorization: Bearer stg_live_…\`; keys are issued in the account area and paid for with the credit packs above. Server-to-server only — no CORS headers are sent. Full reference: ${SITE_ORIGIN}/developers.html.`,
    ),
    '',
  );
  push(...API_ENDPOINTS.map((e) => bullet(`\`${e.line}\`: ${e.blurb}`)), '');
  push(wrap('Branch on the `code` field of an error, not its message:'), '');
  push(...API_ERRORS.map((e) => bullet(e)), '');
  push(
    wrap(
      'One policy worth repeating: when the "Virtually staged" disclosure label cannot be burned into an image, the image is withheld and the credit refunded. It is not switchable off.',
    ),
    '',
  );

  push('## Guides', '');
  push(
    wrap(`Interactive walkthroughs at ${SITE_ORIGIN}/guides.html, plus troubleshooting cards:`),
    '',
  );
  push(...walkthroughTitles(publicDir).map((t) => bullet(t)), '');

  push('## Blog', '');
  const hub = blogMeta(publicDir, BLOG_HUB.file);
  push(linkBullet(hub.title, `${SITE_ORIGIN}${BLOG_HUB.path}`, hub.description));
  for (const article of LOCALIZED_ARTICLES) {
    const { title, description } = blogMeta(publicDir, article.file);
    push(linkBullet(title, `${SITE_ORIGIN}${article.path}`, description));
  }
  push('');

  push('## Reference', '');
  push(...inSection('reference').map(linkLine));
  push(...EXTRA_REFERENCE.map(linkLine), '');

  push('## Official accounts and listings', '');
  push(
    wrap(
      'An account not on this list is not operated by Stagify.ai. The Crunchbase, Dealroom, Tracxn and AgentSpot entries are third-party directories that list Stagify.ai; the profiles there are ours.',
    ),
    '',
  );
  push(...SAME_AS.map((url) => `- ${url}`), '');

  // The two figures the site puts on its homepage, published here as text so an answer
  // engine reading this file does not have to execute the page to find them. The
  // placeholders are substituted per request by lib/http/llms-txt-asset.js — the copy of
  // llms.txt in the repository carries them verbatim, which is what keeps a mutable
  // number out of a git-tracked file.
  push('## Live usage', '');
  push(
    bullet(`Rooms staged to date: ${ROOMS_STAGED_TOKEN}`),
    bullet(`People served (registered accounts plus enquiries): ${USERS_SERVED_TOKEN}`),
    wrap(
      `Both are substituted from the live counters when this file is served. Canonical machine-readable source: ${SITE_ORIGIN}/api/stats — JSON, no authentication, and it states what each figure counts. The same numbers are in the homepage HTML, in the hero and in its WebApplication InteractionCounter data.`,
    ),
    '',
  );

  push('## Notes', '');
  push(
    bullet(
      `Every marketing page is served in English at the root and in ten other languages under a URL prefix (${LOCALES.map(
        (l) => `/${l.prefix}`,
      ).join(', ')}). The English URL is canonical for x-default. The blog is localized per article.`,
    ),
    bullet('Terms of Service and the Privacy Policy are deliberately English-only.'),
    bullet(`Machine-readable entity data: the Organization and WebSite JSON-LD on every indexable page, keyed to ${ORGANIZATION_ID}.`),
    bullet(`Sitemap: ${SITE_ORIGIN}/sitemap.xml`),
    bullet(`Crawling policy: ${SITE_ORIGIN}/robots.txt. AI crawlers and answer engines are allowed, by name.`),
  );

  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s*$/, '') + '\n';
}
