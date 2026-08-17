// Tier: drift guard (static analysis of public/*.html, the injected templates, and
// public/styles/*.css) — every dialog and panel dismisses through ONE close control.
//
// WHAT THIS COVERS
// The X that closes a dialog used to be drawn eight different ways: three shapes (circle,
// pill, rounded square), six sizes (28/32/34/36/40px), five glyph encodings (`&times;`, a
// literal `×`, `✕`, a CSS `content:'×'`, and an SVG) and eight different hover treatments.
// Only ONE of the eight — the gallery's — declared a focus ring, so on the other seven a
// keyboard user could not see where they were. They are now all `.close-x`.
//
// WHY A GUARD AND NOT JUST THE FIX
// Nothing about this consolidation is self-enforcing. Each of these buttons lives on a
// different surface owned by a different feature, which is exactly how eight variants
// accumulated in the first place: every one of them looked locally reasonable. A ninth
// grows back the moment someone adds a dialog and writes `.my-thing__close { … }` beside
// it. Assertion 4 is the load-bearing one here — it fails on the RETIRED SELECTORS
// reappearing, so the guard catches the regrowth rather than merely describing the fix.
//
// THE data-lang ASSERTION IS A REAL BUG, NOT A STYLE RULE
// `#modal-close` on the staging modal carried `data-lang="modal.staging.close"`.
// language-loader.js assigns `el.textContent = value`, and that key was the string "x" in
// all eleven packs — so the authored glyph was overwritten at runtime and the site's most
// used dialog rendered a LOWERCASE LETTER X in every language, English included. The icon
// is not a translatable string; only its aria-label is. A `data-lang` on any of these
// buttons re-breaks that, silently and identically.
//
// WHY STATIC
// There is no jsdom here, three of the call sites are built by JS at runtime, and button
// geometry is a property of the stylesheet. The rendered result is covered by the browser
// pass in the change's own verification and by e2e/basic-mask.spec.js +
// e2e/ai-designer-a11y.spec.js, which click and focus these buttons for real.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @param {string} rel */
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** WCAG 2.5.8 (AA) minimum target edge, in px — the same floor carousel-touch-target.test.js defends. */
const FLOOR = 24;

/**
 * Every dialog/panel dismiss control on the site, and the file it is authored in.
 *
 * `corner` records whether the button is absolutely positioned in a panel corner or sits
 * in a flex header row. That split is why `.close-x` carries no positioning of its own and
 * `.close-x--corner` is a modifier — pinning the base class would have broken the three
 * header-row sites.
 */
const CLOSE_BUTTONS = [
  { label: 'image staging modal', file: 'public/index.html', id: 'modal-close', corner: true },
  { label: 'Basic Mask editor', file: 'public/index.html', id: 'stage-mask-close', corner: false },
  { label: 'empty-room viewer', file: 'public/index.html', id: 'empty-room-close', corner: false },
  { label: 'sign-in modal (static)', file: 'public/index.html', id: 'auth-modal-close', corner: true },
  { label: 'gallery detail dialog', file: 'public/gallery.html', id: 'gal-detail-close', corner: true },
  { label: 'Masking Studio help', file: 'public/masking-studio.html', id: 'ms-help-close', corner: true },
  { label: 'exterior hand-off dialog', file: 'public/masking-studio.html', id: 'ms-exterior-back', corner: true },
  { label: 'bug-report popup', file: 'public/ai-designer.html', id: 'bug-report-popup-close', corner: false },
  {
    label: 'AI Designer mask editor',
    file: 'public/scripts/ai-designer/mask-editor.js',
    id: 'mask-editor-close',
    corner: false,
  },
  {
    label: 'sign-in modal (injected twin)',
    file: 'public/scripts/profile-menu/auth-modal-template.js',
    id: 'auth-modal-close',
    corner: true,
  },
  {
    label: 'report-an-issue modal',
    file: 'public/scripts/profile-menu/report-issue-template.js',
    id: 'report-issue-close',
    corner: true,
  },
];

/**
 * The opening tag of the element carrying `id`, plus everything up to its `</button>`.
 * The templates are JS string concatenation, so the markup is not necessarily contiguous
 * in the source — the tag and its content are matched separately by the callers.
 *
 * @param {string} src
 * @param {string} id
 * @returns {string | null}
 */
function openTag(src, id) {
  const m = src.match(new RegExp(`<button[^>]*\\bid=["']${id}["'][^>]*>`));
  return m ? m[0] : null;
}

for (const c of CLOSE_BUTTONS) {
  test(`${c.label}: dismisses through the shared .close-x control`, () => {
    const src = read(c.file);
    const tag = openTag(src, c.id);
    assert.ok(tag, `#${c.id} moved out of ${c.file} — update this guard`);

    assert.match(tag, /^<button/, `#${c.id} must be a <button>: a <span> is not keyboard-reachable`);
    assert.match(tag, /type="button"/, `#${c.id}: a bare <button> in a form defaults to submit`);
    assert.match(
      tag,
      /class="[^"]*\bclose-x\b[^"]*"/,
      `#${c.id}: must use the shared .close-x control, not a private close style`,
    );
    assert.match(tag, /aria-label="[^"]+"/, `#${c.id}: without a label it announces as its glyph`);

    if (c.corner) {
      assert.match(
        tag,
        /class="[^"]*\bclose-x--corner\b[^"]*"/,
        `#${c.id} is corner-positioned, so it needs the --corner modifier (the base class has no position)`,
      );
    } else {
      assert.doesNotMatch(
        tag,
        /class="[^"]*\bclose-x--corner\b[^"]*"/,
        `#${c.id} sits in a flex header row — --corner would tear it out of the flow`,
      );
    }
  });

  test(`${c.label}: the glyph is the shared SVG, hidden from assistive tech`, () => {
    const src = read(c.file);
    const at = src.indexOf(`id="${c.id}"`);
    assert.notEqual(at, -1, `#${c.id} moved — update this guard`);
    // The button's content, up to its close tag. Enough to see the icon markup without
    // depending on how the surrounding template is line-broken or concatenated.
    const body = src.slice(at, src.indexOf('</button>', at));

    assert.match(body, /<svg\b/, `#${c.id}: a text × renders at a different weight per font — use the shared SVG`);
    assert.match(body, /d="M18 6 6 18M6 6l12 12"/, `#${c.id}: the icon path drifted from the shared one`);
    assert.match(body, /aria-hidden="true"/, `#${c.id}: the icon must be hidden or it lands in the accessible name`);
  });

  test(`${c.label}: the icon is not bound to a translatable string`, () => {
    const src = read(c.file);
    const tag = openTag(src, c.id);
    assert.ok(tag, `#${c.id} moved — update this guard`);

    // data-lang assigns textContent, which REPLACES the icon. This is the bug that made
    // the staging modal render a lowercase letter x in all eleven languages. data-lang-attr
    // is the correct one: it writes an attribute, so it can localise the aria-label safely.
    assert.doesNotMatch(
      tag,
      /\bdata-lang=/,
      `#${c.id}: data-lang overwrites textContent and would replace the icon — use data-lang-attr`,
    );
  });
}

test('the close control is defined once, and big enough to hit', () => {
  const css = read('public/styles/styles.css').replace(/\/\*[\s\S]*?\*\//g, '');

  const base = css.match(/(?:^|\})\s*\.close-x\s*\{([^}]*)\}/);
  assert.ok(base, '.close-x is not defined in styles.css — every page in scope loads that sheet');

  const width = /width:\s*(\d+)px/.exec(base[1]);
  const height = /height:\s*(\d+)px/.exec(base[1]);
  assert.ok(width && height, '.close-x must declare a px width and height, or its hit box is unknowable');
  assert.equal(width[1], height[1], '.close-x is a circle — a non-square box makes border-radius:50% an ellipse');
  assert.ok(
    Number(width[1]) >= FLOOR,
    `.close-x is ${width[1]}px, under the ${FLOOR}px WCAG 2.5.8 target floor`,
  );

  // Seven of the eight originals had no focus ring at all. That is the regression to hold.
  assert.match(css, /\.close-x:focus-visible\s*\{/, '.close-x needs a visible focus ring');
  assert.match(css, /\.close-x:hover\s*\{/, '.close-x needs a hover state');
  assert.match(css, /\.close-x--corner\s*\{/, '.close-x--corner is the corner-positioning modifier');
});

test('no surface has grown its own close style back', () => {
  // The eight this replaced. A ninth variant is what this whole guard exists to catch, and
  // it always starts by one of these names — or a new one like it — reappearing in a sheet.
  const RETIRED = [
    'modal-close',
    'stage-mask-close',
    'auth-modal__close',
    'report-modal__close',
    'gal-detail__close',
    'ms-help-close',
    'bug-report-popup-close',
    'mask-editor-close',
  ];

  const dir = path.join(ROOT, 'public', 'styles');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.css'))) {
    // Comments FIRST: this file's own explanation names every retired selector in prose,
    // and so do the sheets'. An unstripped scan would be grading the commentary.
    const css = fs.readFileSync(path.join(dir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const name of RETIRED) {
      assert.ok(
        !css.includes(`.${name}`),
        `public/styles/${file} styles .${name} again — that surface should use .close-x, not a private variant`,
      );
    }
  }
});

test('the staging modal close key is gone from every pack', () => {
  // Leaving it would be harmless until someone re-added the data-lang binding, at which
  // point the letter-x bug returns with a key that looks legitimate because it exists.
  const dir = path.join(ROOT, 'public', 'languages');
  const packs = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(packs.length >= 11, `expected the full language set, found ${packs.length}`);

  for (const file of packs) {
    const pack = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    assert.equal(
      pack.modal?.staging?.close,
      undefined,
      `${file} still defines modal.staging.close — the close icon is not a translatable string`,
    );
  }
});

test('common.close still names every close button', () => {
  // The aria-label side of the same story: data-lang-attr resolves against this key, so it
  // has to exist in all eleven or one language announces the button in English.
  const dir = path.join(ROOT, 'public', 'languages');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const pack = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    assert.equal(typeof pack.common?.close, 'string', `${file} cannot name the close button`);
    assert.ok(pack.common.close.trim(), `${file}: common.close is empty`);
  }
});

test('the help-icon insertion points still find their close button', () => {
  // Both mask editors insert a help icon immediately before the close button, selecting it
  // by CLASS — the only two class-based selectors in this set, everything else uses an id.
  // Renaming the class without these two is a silent no-op: insertBefore(el, null) appends,
  // so the icon lands on the wrong side of the X instead of throwing.
  for (const file of ['public/scripts/app/stage-mask-editor.js', 'public/scripts/ai-designer/mask-editor.js']) {
    const src = read(file);
    assert.match(
      src,
      /querySelector\('\.close-x'\)/,
      `${file} still queries a retired close class — the help icon would silently append instead`,
    );
  }
});
