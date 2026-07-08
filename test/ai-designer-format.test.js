// Unit tests for the pure formatting helpers extracted from the AI Designer
// browser entry into public/scripts/ai-designer/format.js. These functions have
// no DOM/window dependency, so they import and run directly under node --test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatFileSize,
  imageCountSuffix,
  escapeHtml,
  applyInlineFormatting,
  formatMarkdown,
  getFileStem,
  truncateThumbnailStem,
  slugifyName,
  messageTypeFromTag,
} from '../public/scripts/ai-designer/format.js';

test('formatFileSize: zero, and each unit boundary', () => {
  assert.equal(formatFileSize(0), '0 Bytes');
  assert.equal(formatFileSize(512), '512 Bytes');
  assert.equal(formatFileSize(1024), '1 KB');
  assert.equal(formatFileSize(1536), '1.5 KB');
  assert.equal(formatFileSize(1024 * 1024), '1 MB');
  assert.equal(formatFileSize(1024 * 1024 * 1024), '1 GB');
});

test('imageCountSuffix: empty when singular, 1-based when multiple', () => {
  assert.equal(imageCountSuffix(0, 1), '');
  assert.equal(imageCountSuffix(0, 2), ' (1)');
  assert.equal(imageCountSuffix(2, 3), ' (3)');
});

test('escapeHtml: escapes &,<,> (not quotes), and null/undefined -> ""', () => {
  assert.equal(escapeHtml('a & <b> "c"'), 'a &amp; &lt;b&gt; "c"');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(escapeHtml(0), '0');
});

test('applyInlineFormatting: bold and italic', () => {
  assert.equal(applyInlineFormatting('**bold**'), '<strong>bold</strong>');
  assert.equal(applyInlineFormatting('an *em* word'), 'an <em>em</em> word');
  // A double star is bold, not two italics.
  assert.equal(applyInlineFormatting('**x**'), '<strong>x</strong>');
});

test('formatMarkdown: bullet list', () => {
  assert.equal(formatMarkdown('* a\n* b'), '<ul><li>a</li><li>b</li></ul>');
  assert.equal(formatMarkdown('- one\n+ two\n• three'),
    '<ul><li>one</li><li>two</li><li>three</li></ul>');
});

test('formatMarkdown: paragraphs get <br> between lines, inline formatting applied', () => {
  assert.equal(formatMarkdown('hello\nworld'), 'hello<br>world');
  assert.equal(formatMarkdown('a **b** c'), 'a <strong>b</strong> c');
  assert.equal(formatMarkdown(''), '');
  assert.equal(formatMarkdown(null), '');
});

test('formatMarkdown: escapes HTML before adding tags (no injection)', () => {
  const out = formatMarkdown('<img src=x onerror=alert(1)>');
  assert.ok(!out.includes('<img'), 'raw <img> must not survive');
  assert.ok(out.includes('&lt;img'), 'angle brackets must be escaped');
});

test('getFileStem: strips extension, trims, null when empty/invalid', () => {
  assert.equal(getFileStem('room.png'), 'room');
  assert.equal(getFileStem('my.photo.jpeg'), 'my.photo');
  assert.equal(getFileStem('  spaced.png  '), 'spaced');
  assert.equal(getFileStem('noext'), 'noext');
  assert.equal(getFileStem(''), null);
  assert.equal(getFileStem(null), null);
  assert.equal(getFileStem(123), null);
});

test('truncateThumbnailStem: passthrough <=22, ellipsis when longer, "Upload" when empty', () => {
  assert.equal(truncateThumbnailStem(''), 'Upload');
  assert.equal(truncateThumbnailStem(null), 'Upload');
  assert.equal(truncateThumbnailStem('short name'), 'short name');
  assert.equal(truncateThumbnailStem('a'.repeat(22)), 'a'.repeat(22));
  assert.equal(truncateThumbnailStem('a'.repeat(30)), 'a'.repeat(20) + '…');
});

test('slugifyName: lowercases, drops extension, dashes, clamps, "image" fallback', () => {
  assert.equal(slugifyName('Main Living.png'), 'main-living');
  assert.equal(slugifyName('  Weird__Name!!.JPG '), 'weird-name');
  assert.equal(slugifyName(''), 'image');
  assert.equal(slugifyName(null), 'image');
  assert.equal(slugifyName('!!!'), 'image');
  assert.equal(slugifyName('x'.repeat(80)).length, 60);
});

test('messageTypeFromTag: maps known tags, else "general"', () => {
  assert.equal(messageTypeFromTag('generate'), 'generating');
  assert.equal(messageTypeFromTag('stage'), 'staging');
  assert.equal(messageTypeFromTag('cad-stage'), 'staging');
  assert.equal(messageTypeFromTag('describe'), 'analyzing');
  assert.equal(messageTypeFromTag('auto'), 'general');
  assert.equal(messageTypeFromTag(undefined), 'general');
});
