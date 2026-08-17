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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicPages, footerPages, allHtmlPages, extractSiteFooter } from '../helpers/nav-pages.js';

const STYLES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'styles');

/**
 * enterprise.html's footer is the one sanctioned second shape. It carries the same
 * links, keys and year span, but is styled by a class (`.ent-site-footer`, in
 * styles/enterprise.css) instead of the inline `style=` the other five use. That is not
 * cosmetic preference: the mobile contrast override at the bottom of enterprise.css
 * needs no `!important` precisely because these links are not inline-styled.
 *
 * It used ALSO to sit inside the page's layout wrapper, and that half was not
 * sanctioned, just unnoticed — see the placement test below. Its i18n hooks are
 * asserted with everyone else's.
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
  // A ratchet, not a description: it went 6 → 8 when contact.html and status.html got
  // the footer (2026-08-16). Raise it when a page gains one; lowering it means a page
  // LOST its footer, which is the thing to explain rather than accommodate.
  assert.ok(
    pages.length >= 8,
    `expected the shared footer on at least 8 pages, found ${pages.length} ` +
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

test('every .footer-year span ships a literal year, not an empty placeholder', () => {
  // The span used to ship EMPTY and be filled by scripts/footer-year.js. That script is
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

/** `:root`'s custom properties from styles.css, so `var(--accent)` can be compared to `#374151`. */
function rootTokens() {
  const css = fs.readFileSync(path.join(STYLES, 'styles.css'), 'utf8');
  /** @type {Record<string, string>} */
  const out = {};
  for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}]+)/gi)) out[m[1]] = m[2].trim();
  return out;
}

/** `prop: value; …` → a map, with `var(--x)` resolved and whitespace flattened. */
function declarations(body, tokens) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const part of body.split(';')) {
    const at = part.indexOf(':');
    if (at === -1) continue;
    const prop = part.slice(0, at).trim().toLowerCase();
    if (!prop || prop.startsWith('--')) continue;
    const value = part
      .slice(at + 1)
      .replace(/var\((--[a-z0-9-]+)\)/gi, (_m, name) => tokens[name] ?? _m)
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    out[prop] = value;
  }
  return out;
}

test('enterprise.html’s class-styled footer renders the same as the inline-styled one', () => {
  // The class is a MECHANISM (it keeps the mobile override below free of !important),
  // not a licence to restyle. It had become both: colour --muted instead of #374151, and
  // a -apple-system font-family stack that opted this one page out of Inter — narrower
  // glyphs at the same 13px, so the footer looked smaller as well as greyer than the
  // identical block one page over. Neither is visible to the markup comparison above,
  // because the markup was never wrong. The rendered result is what has to match.
  const tokens = rootTokens();

  const inline = /<footer style="([^"]+)"/.exec(
    footerPages().find((p) => !OWN_SHAPE.has(p.name)).html,
  );
  assert.ok(inline, 'no inline-styled footer left to compare against — update this guard');
  const shared = declarations(inline[1], tokens);

  const css = fs.readFileSync(path.join(STYLES, 'enterprise.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /\.ent-site-footer\s*\{([^}]*)\}/.exec(css);
  assert.ok(rule, '.ent-site-footer no longer has a rule in enterprise.css');
  const own = declarations(rule[1], tokens);

  for (const [prop, value] of Object.entries(shared)) {
    assert.equal(own[prop], value, `.ent-site-footer sets ${prop}: ${own[prop] ?? '(nothing)'}, the other pages ${value}`);
  }
  // And nothing EXTRA: font-family was the declaration that made this footer look
  // different without changing a single value the loop above compares.
  assert.deepEqual(
    Object.keys(own).filter((p) => !(p in shared)).sort(),
    [],
    '.ent-site-footer declares properties the shared footer does not, so the two render differently: ',
  );

  // The link colour is the fifth value, and it lives in its own rule on this page.
  const linkRule = /\.ent-site-footer a\s*\{([^}]*)\}/.exec(css);
  assert.ok(linkRule, '.ent-site-footer a no longer has a rule');
  const sharedLink = /<a [^>]*style="([^"]+)"/.exec(
    extractSiteFooter(footerPages().find((p) => !OWN_SHAPE.has(p.name)).html),
  );
  assert.ok(sharedLink, 'the shared footer’s links are no longer inline-styled — update this guard');
  const wantedLink = declarations(sharedLink[1], tokens);
  const gotLink = declarations(linkRule[1], tokens);
  for (const [prop, value] of Object.entries(wantedLink)) {
    assert.equal(gotLink[prop], value, `.ent-site-footer a sets ${prop}: ${gotLink[prop] ?? '(nothing)'}, the other pages ${value}`);
  }
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
