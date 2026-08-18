// The homepage's #instagram section ships the post art LOCALLY and links out. It used to
// embed three <iframe>s pointing at instagram.com/p/<shortcode>/embed/, and the CSS then
// threw most of each one away — a negative margin clipped Instagram's header off the top
// and a fixed wrapper height cropped the footer. Three ~607 KB third-party documents, plus
// Instagram's own JS and fonts, to show a cropped picture.
//
// The covers are ~134 KB of WebP now and the page loads no Meta code at all. That is worth
// pinning from two directions, because the failure mode is silent: re-adding an embed
// looks like a content change, not like re-introducing a third-party frame on a page that
// has no cookie-consent gate and whose privacy policy never mentions Meta.
//
//   1. this section must contain no <iframe>, and its images must be same-origin;
//   2. lib/http/app-middleware.js must not re-allowlist instagram.com in frameSrc.
//
// Masters, the refetch command and the shortcode mapping: to-build/media-png/instagram/README.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');

const section = (needle) => {
  const at = html.indexOf(needle);
  const start = html.lastIndexOf('<section', at);
  return html.slice(start, html.indexOf('</section>', at));
};

const igSection = section('id="instagram"');
const cards = [...igSection.matchAll(/<a class="ig-card"[^>]*>/g)].map((m) => m[0]);

test('the Instagram section frames nothing', () => {
  assert.equal(
    /<iframe/i.test(igSection),
    false,
    'an <iframe> is back in #instagram — that reloads Meta code on the homepage. ' +
      'The section is local WebP covers that link out; see to-build/media-png/instagram/README.md'
  );
});

test('three cards, each an outbound link to a post', () => {
  assert.equal(cards.length, 3, `expected 3 .ig-card links, found ${cards.length}`);
  const seen = new Set();
  for (const card of cards) {
    const href = card.match(/\bhref="([^"]*)"/);
    assert.ok(href, `an .ig-card has no href: ${card}`);
    const shortcode = href[1].match(/^https:\/\/www\.instagram\.com\/p\/([\w-]+)\/$/);
    assert.ok(
      shortcode,
      `.ig-card href must be a canonical post permalink (no /embed/), got "${href[1]}"`
    );
    assert.equal(seen.has(shortcode[1]), false, `duplicate post ${shortcode[1]} in the section`);
    seen.add(shortcode[1]);

    assert.match(card, /\btarget="_blank"/, `.ig-card must open in a new tab: ${card}`);
    assert.match(
      card,
      /\brel="noopener noreferrer"/,
      `.ig-card must carry rel="noopener noreferrer": ${card}`
    );
  }
});

test('every cover is a local image with a keyed, translated alt', () => {
  const imgs = [...igSection.matchAll(/<img class="ig-card__img"[^>]*>/g)].map((m) => m[0]);
  assert.equal(imgs.length, 3, `expected 3 .ig-card__img, found ${imgs.length}`);

  const english = JSON.parse(readFileSync(join(root, 'public', 'languages', 'english.json'), 'utf8'));
  const posts = english.home?.instagram?.posts ?? {};

  for (const img of imgs) {
    const src = img.match(/\bsrc="([^"]*)"/);
    assert.ok(src, `an .ig-card__img has no src: ${img}`);
    // The point of the change: the bytes come from us, not from Instagram's CDN.
    assert.match(
      src[1],
      /^media-webp\/instagram\/[\w-]+\.webp$/,
      `.ig-card__img src must be a local WebP under media-webp/instagram/, got "${src[1]}"`
    );

    // Below-fold decoration: it must not compete with the hero for bandwidth.
    assert.match(img, /\bloading="lazy"/, `.ig-card__img must stay lazy: ${img}`);
    // width/height reserve the box before CSS lands. They are also why home.css must
    // keep `height: auto` on this class — see the geometry test below.
    assert.match(img, /\bwidth="\d+"/, `.ig-card__img needs a width attribute: ${img}`);
    assert.match(img, /\bheight="\d+"/, `.ig-card__img needs a height attribute: ${img}`);

    // The image is the link's only content, so its alt IS the link's accessible name.
    // An unkeyed alt would announce English inside an otherwise localized section.
    const keyed = img.match(/\bdata-lang-attr="([^"|]+)\|alt"/);
    assert.ok(keyed, `.ig-card__img alt must be keyed with data-lang-attr="<key>|alt": ${img}`);
    const key = keyed[1].replace(/^home\.instagram\.posts\./, '');
    assert.ok(
      posts[key],
      `${keyed[1]} is referenced by index.html but missing from english.json ` +
        '(the other ten packs are covered by test/server/static.test.js key parity)'
    );

    const alt = img.match(/\balt="([^"]*)"/);
    assert.ok(alt && alt[1].trim(), `.ig-card__img needs a non-empty fallback alt: ${img}`);
  }
});

// This one is invisible to every other test: no test covers rendered geometry, and the
// section looks fine in a static scan while being visibly wrong in a browser.
test('the cover images keep height:auto and stay uncropped', () => {
  const css = readFileSync(join(root, 'public', 'styles', 'home.css'), 'utf8');
  const rule = css.match(/\.ig-card__img\s*\{([^}]*)\}/);
  assert.ok(rule, '.ig-card__img rule is gone from home.css');

  // width/height attributes resolve as a presentational height, so with both axes
  // resolved a CSS aspect-ratio is ignored outright. .hgal-card__img rendered
  // 325x845 instead of 325x217 for exactly this reason.
  assert.match(
    rule[1],
    /height:\s*auto/,
    '.ig-card__img must keep `height: auto` — without it the width/height attributes ' +
      'pin the box and the cards render at the wrong height'
  );
  // Two of the three posts have artwork flush to an edge (a title bar against the top,
  // a caption pill against the bottom) that a cover-crop would eat.
  assert.equal(
    /object-fit|aspect-ratio/.test(rule[1]),
    false,
    '.ig-card__img must not crop: the masters are already 4:5 and are shown whole'
  );
});

test('the CSP no longer allowlists Instagram as a frame source', () => {
  const mw = readFileSync(join(root, 'lib', 'http', 'app-middleware.js'), 'utf8');
  const frameSrc = mw.match(/frameSrc:\s*\[([^\]]*)\]/);
  assert.ok(frameSrc, 'frameSrc is gone from the CSP directives');
  assert.equal(
    /['"]https:\/\/www\.instagram\.com['"]/.test(frameSrc[1]),
    false,
    'instagram.com is back in frameSrc — nothing frames Instagram any more, so this ' +
      'only re-opens the hole the local covers closed'
  );
});
