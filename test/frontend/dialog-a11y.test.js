// Every modal in the studios must announce as a dialog.
//
// WHY A SOURCE-LEVEL GUARD
// Four dialogs shipped without `role="dialog"`, `aria-modal` or `aria-labelledby`:
// both mask editors, the bug-report popup and the image lightbox (whose close
// control was a <span>, so keyboard users could not reach it at all). One of them
// is BUILT IN JS at first open (ai-designer/mask-editor.js) rather than written in
// markup, which is how it escaped notice longest — a reviewer reading the HTML
// never sees it, and there is no jsdom here to render it.
//
// So the check reads the source of each dialog, in whichever form it is authored.
// The mask editors in particular are a known fork (shared slices in
// public/scripts/mask/) that has diverged before.
//
// These assertions are deliberately structural. Whether a screen reader actually
// announces the dialog is an e2e concern (e2e/ai-designer-a11y.spec.js drives a
// real browser); what fails the DEPLOY is the attribute going missing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const markupAttr = (name, value) => new RegExp(`${name}="${value}"`);

/**
 * Narrow a whole HTML file to one element's opening tag. Necessary because these
 * pages hold several dialogs that DO carry the attributes — a whole-file assertion
 * passes on a neighbour's markup and proves nothing about this element.
 */
const tagWithId = (id) => (src) => {
  const tag = src.match(new RegExp(`<div[^>]*id="${id}"[^>]*>`));
  assert.ok(tag, `the #${id} element moved — update this guard`);
  return tag[0];
};

const DIALOGS = [
  {
    label: 'AI Designer mask editor (built in JS)',
    file: 'public/scripts/ai-designer/mask-editor.js',
    titleId: 'mask-editor-title',
    // Match the setAttribute call itself, not "role" appearing near "dialog" —
    // a loose pattern happily matches `modal.dataset.role = 'dialog'`, which sets
    // no ARIA at all. (It did, until a mutation caught it.)
    attr: (name, value) => new RegExp(`setAttribute\\(\\s*'${name}'\\s*,\\s*'${value}'\\s*\\)`),
    // The attributes are setAttribute() calls between the id assignment and the
    // innerHTML that follows it. Scoping to that block matters: asserting against
    // the whole file would pass on an aria-modal belonging to some other element.
    scope: (src) => {
      const from = src.indexOf("modal.id = 'mask-editor-modal'");
      const to = src.indexOf('modal.innerHTML', from);
      assert.ok(from !== -1 && to > from, 'the dialog construction block moved — update this guard');
      return src.slice(from, to);
    },
  },
  {
    label: 'stage mask editor (static markup)',
    file: 'public/index.html',
    titleId: 'stage-mask-title',
    attr: markupAttr,
    // index.html holds several dialogs that DO carry these attributes, so the
    // assertion has to be pinned to this one's own opening tag.
    scope: tagWithId('stage-mask-modal'),
  },
  {
    label: 'AI Designer bug-report popup',
    file: 'public/ai-designer.html',
    titleId: 'bug-report-popup-title',
    attr: markupAttr,
    scope: tagWithId('bug-report-popup'),
  },
  {
    label: 'AI Designer image lightbox',
    file: 'public/ai-designer.html',
    // No heading to point at — a lightbox is one image — so it is named directly
    // with aria-label instead of aria-labelledby.
    labelledByAttr: 'aria-label',
    attr: markupAttr,
    scope: tagWithId('image-modal'),
  },
];

for (const d of DIALOGS) {
  test(`${d.label}: declares role=dialog, aria-modal and aria-labelledby`, () => {
    const src = read(d.file);
    const tag = d.scope(src);

    assert.match(tag, d.attr('role', 'dialog'), `${d.label}: no role="dialog"`);
    assert.match(tag, d.attr('aria-modal', 'true'), `${d.label}: no aria-modal="true"`);

    if (d.titleId) {
      assert.match(
        tag,
        d.attr('aria-labelledby', d.titleId),
        `${d.label}: aria-labelledby must point at #${d.titleId}`,
      );
      // The label target has to exist, or the dialog has an empty accessible name —
      // which reads exactly like having no aria-labelledby at all.
      assert.match(src, new RegExp(`id=["']${d.titleId}["']`), `${d.label}: no element with id="${d.titleId}"`);
    } else {
      // Named directly. Non-empty, and not the raw i18n key.
      const label = tag.match(new RegExp(`${d.labelledByAttr}="([^"]*)"`));
      assert.ok(label && label[1].trim(), `${d.label}: has neither aria-labelledby nor a non-empty aria-label`);
      assert.doesNotMatch(label[1], /^[a-z]+(\.[a-zA-Z]+)+$/, `${d.label}: aria-label looks like an untranslated key`);
    }
  });
}

// Every dialog's close control must be a real button with a name — the two that
// were fixed last both had a bare "×" as their only content, and the lightbox's was
// a <span>, so keyboard users could not reach it at all.
const CLOSE_BUTTONS = [
  { label: 'bug-report popup', file: 'public/ai-designer.html', id: 'bug-report-popup-close' },
  { label: 'image lightbox', file: 'public/ai-designer.html', id: 'image-modal-close' },
];

for (const c of CLOSE_BUTTONS) {
  test(`${c.label}: the close control is a named <button>, not a bare glyph`, () => {
    const src = read(c.file);
    const tag = src.match(new RegExp(`<[a-z]+[^>]*id="${c.id}"[^>]*>`));
    assert.ok(tag, `#${c.id} moved — update this guard`);
    assert.match(tag[0], /^<button/, `#${c.id} must be a <button> (a <span> is not keyboard-reachable)`);
    assert.match(tag[0], /type="button"/, `#${c.id}: a bare <button> in a form defaults to submit`);
    assert.match(tag[0], /aria-label="[^"]+"/, `#${c.id}: without a label it announces as its glyph`);
    assert.match(
      tag[0],
      /data-lang-attr="common\.close\|aria-label"/,
      `#${c.id}: the label must come from the shared, translated common.close key`,
    );
  });
}

test('the lightbox close listener resolves its callback at call time, not registration', () => {
  // ai-designer-model-selector.js is a CLASSIC script: it runs while the document is
  // parsed, before the deferred <script type="module"> that defines closeImageModal.
  // `addEventListener('click', closeImageModal)` evaluates that identifier
  // immediately, so it threw a ReferenceError and the listener was never attached —
  // the "×" did nothing for as long as it existed. Escape and click-outside kept
  // working because they resolve the name inside their own handler body, which is
  // why nobody noticed.
  const src = read('public/scripts/ai-designer-model-selector.js');
  assert.doesNotMatch(
    src,
    /addEventListener\(\s*'click'\s*,\s*closeImageModal\s*\)/,
    'passing the bare identifier re-breaks the close button — call window.closeImageModal() inside the handler',
  );
  assert.match(src, /typeof window\.closeImageModal === 'function'/);
});

test('the AI Designer close button has a name that is not the "×" glyph', () => {
  const src = read('public/scripts/ai-designer/mask-editor.js');
  const button = src.match(/<button[^>]*id="mask-editor-close"[^>]*>.*?<\/button>/s);
  assert.ok(button, 'the close button markup moved — update this guard');
  assert.match(button[0], /aria-label=/, 'without a label it announces as "times"');
  // The glyph itself must be hidden, otherwise it is appended to the label.
  assert.match(button[0], /aria-hidden="true"/, 'the × glyph must be hidden from assistive tech');
  assert.match(button[0], /type="button"/, 'a bare <button> in a form defaults to submit');
});

test('both close buttons resolve their label from the same translated key', () => {
  // common.close is already in all 11 packs (the Masking Studio and stage dialogs
  // use it via data-lang-attr); the JS dialog has no data-lang-attr pass, so it
  // looks the key up itself in mask-editor-i18n.js.
  assert.match(read('public/scripts/ai-designer/mask-editor-i18n.js'), /common\.close/);
  assert.match(read('public/index.html'), /data-lang-attr="common\.close\|aria-label"/);

  const english = JSON.parse(read('public/languages/english.json'));
  assert.equal(typeof english.common?.close, 'string');
  assert.ok(english.common.close.length > 0);
});

test('every language pack can name the close button', () => {
  // A missing key here would silently fall back to English for that language only —
  // invisible in e2e, which always runs with a loaded pack.
  const dir = path.join(root, 'public', 'languages');
  const packs = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(packs.length >= 11, `expected the full language set, found ${packs.length}`);
  for (const pack of packs) {
    const json = JSON.parse(fs.readFileSync(path.join(dir, pack), 'utf8'));
    assert.equal(typeof json.common?.close, 'string', `${pack} is missing common.close`);
  }
});

test('the AI Designer dialog moves focus in on open and restores it on close', () => {
  // Focus is what makes the dialog reachable at all: without it focus stays on the
  // button behind the overlay, so the dialog is never announced and Escape/Tab act
  // on the page underneath. The Tab trap in ai-designer-app.js cannot start this —
  // it only reacts once Tab is pressed.
  const src = read('public/scripts/ai-designer/mask-editor.js');
  assert.match(src, /maskEditorOpener\s*=\s*\/\*\*[^*]*\*\/\s*\(document\.activeElement\)/,
    'openMaskEditor must capture the element that opened it');
  assert.match(src, /getElementById\('mask-editor-close'\)\);\s*[\r\n]+\s*if \(closeBtn\) closeBtn\.focus\(\)/,
    'opening must move focus into the dialog');
  assert.match(src, /opener\.isConnected/,
    'restoring focus must skip a detached opener, or focus silently drops to <body>');
});
