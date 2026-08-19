// The homepage's closing row (#contact-cta).
//
// The bug this section exists to fix: index.html had exactly ONE conversion CTA,
// `#hero-upload`, and it sat above the fold. Across the ~8,000px below it every
// remaining CTA was a demo control or an outbound link, and the LAST `.btn-primary`
// on the page asked for a Google review. These tests pin the properties that make
// the fix real rather than cosmetic — most importantly that the closing button is
// wired to the staging flow, which is the one thing a reader of the markup cannot
// verify on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');
const css = readFileSync(join(root, 'public', 'styles', 'home.css'), 'utf8');
const appJs = readFileSync(join(root, 'public', 'scripts', 'app.js'), 'utf8');
const boot = readFileSync(join(root, 'public', 'scripts', 'hero-cta-boot.js'), 'utf8');

// Bounded at the first </section>, which is this one's: the closing row contains no
// nested <section>. An unbounded slice runs to the end of the file and silently drags
// in the staging modal and the footer, which makes every count below meaningless.
const outroStart = html.indexOf('<section class="home-section home-outro"');
const outro = html.slice(outroStart, html.indexOf('</section>', outroStart) + '</section>'.length);

// Guards that assert an identifier is GONE have to read declarations, not prose —
// otherwise the comment explaining the removal is itself enough to fail them.
const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
const stripJsComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('the closing row exists and is the last section in <main>', () => {
  assert.ok(
    outro.startsWith('<section class="home-section home-outro"'),
    'no .home-outro section found in index.html',
  );
  const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
  const ids = [...main.matchAll(/<section[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
  // The staging modal lives inside <main> after this row, but it is a dialog, not a
  // band — #contact-cta is the last section a scrolling visitor reaches.
  assert.equal(
    ids[ids.length - 2],
    'contact-cta',
    `expected #contact-cta to be the last homepage band, got ${ids.slice(-3).join(', ')}`,
  );
});

// THE LOAD-BEARING ONE. A closing CTA that opens nothing is worse than no closing
// CTA, and the wiring lives in a different file from the markup, so nothing else
// catches a rename on either side.
test('the closing button is wired to the staging flow in hero-cta-boot.js', () => {
  // THE BINDING MOVED OUT OF app.js on 2026-08-19. app.js is 38 modules and ~267 KB, and
  // nothing in it is reachable until somebody starts staging, so it now loads from
  // scripts/index-deferred.js after `load` instead of inside the LCP window. That leaves a
  // window where these buttons are painted and app.js has not arrived, which is why the
  // binding lives in a small zero-import module that IS still in <head>: a click there
  // pulls app.js in and then calls the hook. app.js must NOT also bind them — two
  // listeners means one click opens the picker twice.
  assert.match(
    outro,
    /<button[^>]*\bid="outro-upload"/,
    'the closing row must carry #outro-upload',
  );
  assert.match(
    boot,
    /'hero-upload',\s*'outro-upload'/,
    'hero-cta-boot.js must look up both #hero-upload and #outro-upload',
  );
  assert.match(
    boot,
    /addEventListener\('click',[\s\S]{0,80}?openStaging/,
    'the upload buttons must still be bound to the staging opener',
  );
  assert.match(
    boot,
    /__stagifyOpenStaging/,
    'hero-cta-boot.js must call the window.__stagifyOpenStaging hook app.js publishes — '
      + 'that hook is also how it knows app.js has finished evaluating',
  );
  assert.ok(
    !/\$\('#outro-upload'\)/.test(appJs) && !/\$\('#hero-upload'\)/.test(appJs),
    'app.js is binding the upload buttons again as well as hero-cta-boot.js. Two click '
      + 'listeners on the same button means one press opens the staging picker twice.',
  );
  assert.match(
    html,
    /<script type="module" src="scripts\/hero-cta-boot\.js">/,
    'index.html must still load hero-cta-boot.js as a normal <head> module — deferring it '
      + 'too would put the gap it exists to cover back exactly where it was',
  );
});

// These two were bound for a long time while existing in no HTML file on the site.
// Reviving either would re-create a hook that looks wired and is not.
test('the dead #nav-upload / #pricing-upload hooks stay dead', () => {
  for (const id of ['nav-upload', 'pricing-upload']) {
    assert.ok(!stripJsComments(appJs).includes(`#${id}`), `app.js still references #${id}`);
    assert.ok(!stripHtmlComments(html).includes(`id="${id}"`), `index.html re-added #${id}`);
  }
});

test('contact and review survive, folded into the row', () => {
  assert.match(outro, /href="mailto:team@stagify\.ai"/, 'the inbox address was dropped');
  assert.match(outro, /href="tel:\+19292514372"/, 'the phone number was dropped');
  assert.match(outro, /g\.page\/r\/Cd6NiqfUAJ7bEAE\/review/, 'the review link was dropped');
});

// The row is one link carrying the stars AND the label, not a star link stacked on a
// button both pointing at the same URL, which is what it replaced.
test('the review link is a single control', () => {
  const reviewLinks = [...outro.matchAll(/g\.page\/r\/Cd6NiqfUAJ7bEAE\/review/g)];
  assert.equal(reviewLinks.length, 1, 'there must be exactly one review link');
  assert.match(outro, /class="qr__stars" aria-hidden="true"/, 'the stars must be hidden from AT');
});

// It costs zero new translation keys, and that is the reason the copy reads as it
// does. A new data-lang here means someone added a string without adding it to the
// other ten packs — which the English fallback would hide.
test('every string in the row resolves to a key that already shipped', () => {
  const keys = [...outro.matchAll(/data-lang(?:-attr)?="([^"|]+)/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(keys)].sort(),
    [
      'home.contactCta.email',
      'home.contactCta.phone',
      'home.finalCta.button',
      'home.finalCta.title',
      'home.reviewCta.aria',
      'home.reviewCta.button',
    ],
    'the closing row must reuse existing keys only',
  );
  const packs = ['english', 'german', 'spanish', 'french', 'italian', 'dutch',
    'portuguese', 'russian', 'chinese', 'japanese', 'korean'];
  for (const name of packs) {
    const pack = JSON.parse(readFileSync(join(root, 'public', 'languages', `${name}.json`), 'utf8'));
    for (const key of new Set(keys)) {
      const value = key.split('.').reduce((o, k) => (o == null ? o : o[k]), pack);
      assert.equal(typeof value, 'string', `${name}.json is missing ${key}`);
      assert.ok(value.trim().length > 0, `${name}.json has an empty ${key}`);
    }
  }
});

// One heading where there were two, and it must stay a heading: dropping to a <p>
// would leave the page's outline ending on the FAQ.
test('the row keeps exactly one heading, and it names the section', () => {
  const headings = [...outro.matchAll(/<h([1-6])[^>]*\bid="([^"]+)"/g)];
  assert.equal(headings.length, 1, 'the closing row must have exactly one heading');
  assert.equal(headings[0][1], '2', 'it must be an h2, like every other section head');
  assert.match(
    outro,
    new RegExp(`aria-labelledby="${headings[0][2]}"`),
    'the section must be labelled by its own heading',
  );
});

// The whole point of this variant is that it is quiet. An animated heading undoes it.
test('the closing heading carries no data-tx effect', () => {
  const h2 = outro.match(/<h2[^>]*>/)[0];
  assert.ok(!h2.includes('data-tx'), `the closing h2 must stay unanimated: ${h2}`);
});

// `.qr` carries .reveal, whose `transition: opacity .6s, transform .6s` is (0,1,0).
// `.home-outro .qr` is (0,2,0) and later in the file, so a transition declared there
// REPLACES the reveal's instead of merging and the section stops animating in. This
// has already shipped once on .rs__stack; see home-restage.test.js.
test('no transition is declared on the .reveal element itself', () => {
  const block = css.slice(css.indexOf('.home-outro .qr {'));
  const rule = block.slice(0, block.indexOf('}'));
  assert.ok(
    !/(^|[\s;]) *transition\s*:/.test(rule),
    `.home-outro .qr must not declare a transition:\n${rule}`,
  );
});

// English fits the row with 118px to spare at the 1044px content width; German
// overflows by 72px. With `flex-wrap: wrap` that shortfall dropped the small print
// onto a second row in four of the eleven locales (de, nl, pt, fr) and took the
// section from 63px to 102px — the classic "English looks perfect, German is broken"
// failure. `nowrap` + a shrinkable heading moves the break into the heading instead.
test('the row does not wrap on desktop, and the heading is what gives', () => {
  const block = css.slice(css.indexOf('.home-outro .qr {'));
  const base = block.slice(0, block.indexOf('}'));
  assert.match(base, /flex-wrap:\s*nowrap/, 'the desktop row must not wrap');

  const line = css.slice(css.indexOf('.qr__line {'));
  assert.match(
    line.slice(0, line.indexOf('}')),
    /min-width:\s*0/,
    '.qr__line needs min-width:0 or nowrap pushes the small print out of the row',
  );
  // If either of these could shrink, the shortfall would land on the button's label
  // or between the stars and theirs.
  const fixed = css.slice(css.indexOf('.qr__cta,'));
  assert.match(fixed.slice(0, fixed.indexOf('}')), /flex:\s*none/);

  // …and the wrap has to come back below 760px, where three columns do not fit.
  // Searched from the closing row's own rules onward: home.css has three
  // `@media (max-width: 760px)` blocks and the first two belong to other sections.
  const mobile = css.slice(css.indexOf('@media (max-width: 760px)', css.indexOf('.qr__cta,')));
  assert.match(
    mobile.slice(0, mobile.indexOf('\n}')),
    /flex-wrap:\s*wrap/,
    'the row must wrap again on a phone',
  );
});

// The row's layout is `space-between` over exactly three children; a fourth silently
// redistributes the spacing and the composition stops reading left / centre / right.
test('the row still has exactly three flex children', () => {
  const inner = outro.slice(outro.indexOf('<div class="qr reveal">'));
  const depth0 = [];
  let depth = 0;
  for (const tag of inner.matchAll(/<(\/?)(\w+)[^>]*?(\/?)>/g)) {
    const [full, close, name, selfClose] = tag;
    if (close) { depth -= 1; if (depth === 0) break; continue; }
    if (depth === 1) depth0.push(name);
    if (!selfClose && !/^(img|br|input|hr|meta|link)$/.test(name)) depth += 1;
    if (full.startsWith('<div class="qr reveal"')) depth = 1;
  }
  assert.deepEqual(depth0, ['h2', 'button', 'div'], 'expected line, CTA, small print');
});

// The old block's reason for existing was out-specifying the global mobile
// `.btn { width: 100%; max-width: 280px }`. Making the new button a .btn brings that
// fight back — and via index.css it would also inherit `font-size: 24px !important`.
test('the closing button is not a .btn', () => {
  const button = outro.match(/<button[^>]*id="outro-upload"[^>]*>/)[0];
  assert.ok(!/\bclass="[^"]*\bbtn\b/.test(button), `#outro-upload must not be a .btn: ${button}`);
});

// …but it must still speak the site's CTA language. A flat fill shipped here first and
// read as off-pattern beside `.ig-follow`, which sits six rows above it in the same
// gradient family. The token is the fix; a literal copy of the stack would be the
// eleventh on the site.
test('the closing button uses the shared CTA gradient token', () => {
  const rule = css.slice(css.indexOf('.qr__cta {'));
  const body = rule.slice(0, rule.indexOf('}'));
  assert.match(body, /background:\s*var\(--cta-gradient\)/, '.qr__cta must use --cta-gradient');
  assert.ok(
    !/radial-gradient/.test(body),
    '.qr__cta must not inline the gradient stack — that is what the token is for',
  );
  // Rule 3 of css-tokens.test.js: a var() that resolves to nothing DROPS the whole
  // declaration, silently. The token has to be defined where index.html can see it.
  const base = readFileSync(join(root, 'public', 'styles', 'styles.css'), 'utf8');
  assert.match(base, /--cta-gradient:/, '--cta-gradient must be defined in styles.css :root');
});

// "A little shiny" was the ask, and it is the drop-shadow pulse — not the translateY
// float the old 34px stars also had, which bobbed them off the row's shared baseline.
test('the stars are gradient-filled and glow, but do not move', () => {
  assert.match(outro, /fill="url\(#reviewStarGrad\)"/, 'the stars must use the gold ramp');
  assert.match(outro, /<linearGradient id="reviewStarGrad"/, 'the gradient must be defined inline');

  const stars = css.slice(css.indexOf('.qr__stars svg {'));
  const body = stars.slice(0, stars.indexOf('}'));
  assert.match(body, /animation:\s*qrStarGlow/, 'the glow pulse is the shine');
  assert.match(body, /width:\s*20px/, 'at 15px the ramp is invisible and they read as punctuation');

  const frames = css.slice(css.indexOf('@keyframes qrStarGlow'));
  assert.ok(
    !/translate/.test(frames.slice(0, frames.indexOf('\n}'))),
    'the glow must not move the stars — it shares a baseline with the row',
  );
});

// The two-up band is gone; these are the classes it took with it.
test('the removed outro classes do not come back', () => {
  // `reviewStarGrad` is deliberately NOT in this list: the gradient came back when the
  // stars went from 15px flat to 20px, because the gold ramp is what makes them read
  // as a rating. What stayed gone is `.review-star-defs`, the separate 0×0 <svg> that
  // used to hold it — a gradient id is document-global, so the defs now live inside
  // the first star.
  for (const gone of [
    'home-contact-cta', 'home-review-cta', 'contact-cta-email', 'contact-cta-phone',
    'review-cta-stars', 'review-cta-btn', 'review-star-defs',
  ]) {
    assert.ok(!stripHtmlComments(html).includes(gone), `index.html still uses .${gone}`);
  }
  // The CSS mentions the old names only in the comment that explains their removal.
  const declarations = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const gone of ['contact-cta-email', 'review-cta-stars', 'reviewStarGlow', 'review-cta-btn']) {
    assert.ok(!declarations.includes(gone), `home.css still declares ${gone}`);
  }
});
