// Tier: frontend island logic — public/scripts/app/stamp-style-row.js, the badge
// style/size/preview strip under "Label as virtually staged".
//
// Two kinds of assertion here, and the second kind is the reason the file exists.
//
// BEHAVIOUR: the strip is revealed by the checkbox, the preview URL is rebuilt from the
// live controls, and readStampOptions() answers with something usable on a page that has
// no strip at all. Each of those fails silently if it breaks — a stale preview shows the
// user a badge they are not going to get, and a broken reader posts a style they did not
// pick, both with nothing on screen to say so.
//
// DRIFT: this row is a browser-side copy of a server-side range. The slider's min/max/step
// live in index.html, the fallbacks live in the island, and the truth lives in
// lib/image/stamp-disclosure.js — three places, no import between them (the server module
// pulls in sharp, so the browser cannot share it). Widening STAMP_SCALE_MAX would leave the
// slider quietly capped at the old value and the extra range simply unreachable, which is
// not a crash and not a visible bug. The tests at the bottom are the only thing that
// notices.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readStampOptions, initStampStyleRow, FALLBACK_STYLE, FALLBACK_SCALE } from '../../../public/scripts/app/stamp-style-row.js';
import {
  STAMP_STYLE_NAMES,
  DEFAULT_STAMP_STYLE,
  STAMP_SCALE_MIN,
  STAMP_SCALE_MAX,
  STAMP_SCALE_DEFAULT,
} from '../../../lib/image/stamp-disclosure.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const REAL = { document: globalThis.document, localStorage: globalThis.localStorage };
afterEach(() => { Object.assign(globalThis, REAL); });

/** Minimal event-target stand-in — enough to register a listener and fire it. */
function node(extra = {}) {
  const listeners = new Map();
  return {
    dataset: {},
    hidden: false,
    addEventListener: (type, fn) => { listeners.set(type, [...(listeners.get(type) || []), fn]); },
    fire: (type) => { for (const fn of listeners.get(type) || []) fn(); },
    setAttribute(name, value) { this[`attr_${name}`] = value; },
    getAttribute(name) { return this[`attr_${name}`] ?? null; },
    ...extra,
  };
}

/**
 * Build the strip's DOM as the island expects to find it.
 * @param {{ checked?: boolean, style?: string, scale?: string, lang?: string }} [opts] - Starting state.
 * @returns {{ row: any, checkbox: any, slider: any, image: any, radios: any[] }} The nodes, for driving and inspecting.
 */
function mount(opts = {}) {
  const { checked = false, style = 'dark', scale = '1', lang = 'english' } = opts;
  const radios = STAMP_STYLE_NAMES.map((name) => node({ value: name, checked: name === style }));
  const image = node({});
  const slider = node({ value: scale });
  const checkbox = node({ checked });
  const preview = node({});
  const row = node({
    hidden: !checked,
    querySelectorAll: () => radios,
    querySelector: (sel) => (sel === '.stamp-preview' ? preview : null),
  });

  const byId = new Map([
    ['stamp-opts', row],
    ['label-virtually-staged', checkbox],
    ['stamp-preview-img', image],
    ['stamp-scale', slider],
  ]);
  globalThis.document = {
    getElementById: (id) => byId.get(id) || null,
    querySelector: (sel) => (sel === '.stamp-swatch__input:checked' ? radios.find((r) => r.checked) || null : null),
  };
  globalThis.localStorage = { getItem: (k) => (k === 'selectedLanguage' ? lang : null) };
  return { row, checkbox, slider, image, radios, preview };
}

test('readStampOptions reports the checked swatch and the slider', async () => {
  mount({ style: 'minimal', scale: '1.3' });
  assert.deepEqual(readStampOptions(), { style: 'minimal', scale: 1.3 });
});

test('readStampOptions falls back on a page with no strip', async () => {
  globalThis.document = { getElementById: () => null, querySelector: () => null };
  assert.deepEqual(readStampOptions(), { style: FALLBACK_STYLE, scale: FALLBACK_SCALE });
});

test('the strip follows the checkbox, and nothing else', async () => {
  const dom = mount({ checked: false });
  initStampStyleRow();
  assert.equal(dom.row.hidden, true, 'hidden while the option is off');

  dom.checkbox.checked = true;
  dom.checkbox.fire('change');
  assert.equal(dom.row.hidden, false, 'revealed when it is ticked');

  dom.checkbox.checked = false;
  dom.checkbox.fire('change');
  assert.equal(dom.row.hidden, true, 'and hidden again');
});

test('the preview is not fetched while the strip is hidden', async () => {
  // An <img> fetches the moment its src is set, so pointing it at a preview the user has
  // not asked to see spends a render on page load, for every visitor, forever.
  const dom = mount({ checked: false });
  initStampStyleRow();
  assert.equal(dom.image.getAttribute('src'), null, 'no request before the option is on');

  dom.checkbox.checked = true;
  dom.checkbox.fire('change');
  assert.match(String(dom.image.getAttribute('src')), /^\/api\/disclosure-preview\?/, 'fetched on reveal');
});

test('the preview URL carries the live style, size and UI language', async () => {
  const dom = mount({ checked: true, style: 'dark', scale: '1', lang: 'german' });
  initStampStyleRow();
  assert.equal(dom.image.getAttribute('src'), '/api/disclosure-preview?lang=german&style=dark&scale=1');

  // Switching swatch re-points it immediately: this is a click, not a drag, so there is
  // nothing to debounce.
  dom.radios[0].checked = false;
  dom.radios[2].checked = true;
  dom.radios[2].fire('change');
  assert.equal(dom.image.getAttribute('src'), '/api/disclosure-preview?lang=german&style=minimal&scale=1');
});

test('re-opening the preview rebuilds the URL, so a language switch cannot go stale', async () => {
  // The UI language is not one of this strip's controls and nothing here is told when it
  // changes — so the popup rebuilds its URL on the way in rather than trusting the last one.
  let lang = 'english';
  const dom = mount({ checked: true });
  globalThis.localStorage = { getItem: (k) => (k === 'selectedLanguage' ? lang : null) };
  initStampStyleRow();
  assert.match(String(dom.image.getAttribute('src')), /lang=english/);

  lang = 'korean';
  dom.preview.fire('pointerenter');
  assert.match(String(dom.image.getAttribute('src')), /lang=korean/, 'reopening picks up the new language');
});

test('the slider announces a percentage, and refreshes the preview once it settles', async () => {
  // Two things in one drag. The announcement: "1.3" read aloud is meaningless, and the
  // control has no visible value either, so aria-valuetext is the only thing telling a
  // screen-reader user where the slider is. The debounce: `input` fires per pixel of drag,
  // and a request each would be ten renders for one decision, nine of them never seen.
  const dom = mount({ checked: true });
  initStampStyleRow();
  dom.slider.value = '1.3';
  dom.slider.fire('input');
  assert.equal(dom.slider.getAttribute('aria-valuetext'), '130%', 'announced immediately');
  assert.match(String(dom.image.getAttribute('src')), /scale=1$/, 'but not fetched mid-drag');

  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.match(String(dom.image.getAttribute('src')), /scale=1\.3$/, 'fetched once the drag settles');
});

test('initStampStyleRow is idempotent — a second call adds no second listener', async () => {
  // app.js initialises the stage modal from more than one entry point. Double-wiring would
  // double every preview request and, worse, be invisible.
  const dom = mount({ checked: true });
  initStampStyleRow();
  initStampStyleRow();
  let sets = 0;
  dom.image.setAttribute = (name) => { if (name === 'src') sets += 1; };
  // Report the src as unset so every handler that runs actually writes — the module skips
  // a write that would not change the URL, which would otherwise mask the second handler.
  dom.image.getAttribute = () => null;
  dom.preview.fire('pointerenter');
  assert.equal(sets, 1, 'one handler, one refresh');
});

// ── drift: the browser's copy of the server's range ──────────────────────────

test('the island fallbacks match the server defaults', async () => {
  assert.equal(FALLBACK_STYLE, DEFAULT_STAMP_STYLE);
  assert.equal(FALLBACK_SCALE, STAMP_SCALE_DEFAULT);
});

test('the slider in index.html spans exactly the range the server accepts', async () => {
  const input = /<input[^>]*id="stamp-scale"[^>]*>/.exec(html);
  assert.ok(input, 'the size slider is still in the markup');
  const attr = (name) => new RegExp(`${name}="([^"]*)"`).exec(input[0])?.[1];
  assert.equal(Number(attr('min')), STAMP_SCALE_MIN, 'a narrower min hides range the server would accept');
  assert.equal(Number(attr('max')), STAMP_SCALE_MAX, 'a wider max posts values the server will clamp away');
  assert.equal(Number(attr('value')), STAMP_SCALE_DEFAULT, 'it starts at the size the server would have used anyway');
  assert.equal(attr('type'), 'range');
});

test('the swatches offer exactly the styles the server can draw, with the default preselected', async () => {
  const radios = [...html.matchAll(/<input[^>]*name="stamp-style"[^>]*>/g)].map((m) => m[0]);
  const values = radios.map((r) => /value="([^"]*)"/.exec(r)?.[1]);
  assert.deepEqual(
    values.sort(),
    [...STAMP_STYLE_NAMES].sort(),
    'a swatch with no style behind it renders the default; a style with no swatch is unreachable',
  );
  const checked = radios.filter((r) => r.includes(' checked'));
  assert.equal(checked.length, 1, 'exactly one is preselected');
  assert.match(checked[0], new RegExp(`value="${DEFAULT_STAMP_STYLE}"`), 'and it is the server default');
});

test('every swatch carries a text name, because the visible part is a picture', async () => {
  // The swatch is a coloured rectangle with "Aa" in it — meaningless to a screen reader.
  // The .sr-only sibling is the whole accessible name, and data-lang means it is also the
  // only place the localized name lands.
  const group = /<div class="stamp-opts__styles"[\s\S]*?<\/div>\s*<input/.exec(html);
  assert.ok(group, 'the swatch group is still there');
  for (const style of STAMP_STYLE_NAMES) {
    assert.match(
      group[0],
      new RegExp(`data-lang="modal\\.staging\\.stampStyles\\.${style}"`),
      `${style} has a localized text name`,
    );
  }
});
