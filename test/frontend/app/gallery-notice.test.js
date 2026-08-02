// public/scripts/app/gallery-notice.js — the line under a finished render.
//
// Two things are worth pinning. It must stay SILENT when the response carried no gallery
// payload, because that is what happens when the gallery is switched off and announcing
// a feature that is not running is worse than saying nothing. And it must actually
// mention the broken share link when eviction took one out — that is the only place an
// agent can learn a link they already sent a client has stopped working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGalleryNotice, NOTICE_ID } from '../../../public/scripts/app/gallery-notice.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The smallest DOM this island touches: createElement, getElementById, appendChild. */
function harness() {
  const registry = new Map();
  const make = (tag) => ({
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
    textContent: '',
    classList: {
      set: new Set(),
      add(...n) { n.forEach((x) => this.set.add(x)); },
      remove(...n) { n.forEach((x) => this.set.delete(x)); },
      contains(n) { return this.set.has(n); },
    },
  });
  const doc = {
    createElement: make,
    getElementById: (id) => registry.get(id) ?? null,
  };
  const container = { children: [], appendChild(node) { this.children.push(node); registry.set(node.id, node); } };
  // English fallbacks, so the assertions read as the shipped copy rather than key names.
  const lang = (key, fallback) => fallback;
  return { doc, container, notice: createGalleryNotice({ doc, container, lang }), registry };
}

test('a saved render says so, once', () => {
  const { notice, registry, container } = harness();
  notice.show({ ids: ['r1'], evicted: [] });

  const el = registry.get(NOTICE_ID);
  assert.equal(el.textContent, 'Saved to your gallery.');
  assert.equal(el.classList.contains('hidden'), false);

  // Re-showing must not append a second notice.
  notice.show({ ids: ['r2'], evicted: [] });
  assert.equal(container.children.length, 1);
});

test('no gallery payload means the notice stays silent', () => {
  // The gallery is off (no object store configured) or the caller was anonymous.
  // Announcing a feature that is not running would be worse than saying nothing.
  const { notice, registry } = harness();
  for (const payload of [undefined, null, {}, { ids: [] }]) {
    notice.show(payload);
    const el = registry.get(NOTICE_ID);
    if (el) {
      assert.equal(el.textContent, '');
      assert.equal(el.classList.contains('hidden'), true);
    }
  }
});

test('eviction is stated, not left for the agent to discover', () => {
  const { notice, registry } = harness();
  notice.show({ ids: ['r1'], evicted: [{ id: 'old', hadLiveShare: false }] });
  const text = registry.get(NOTICE_ID).textContent;
  assert.match(text, /Saved to your gallery\./);
  assert.match(text, /Older stagings were removed/);
  // Nothing was shared, so the harsher sentence must not appear.
  assert.ok(!/share link/i.test(text));
});

test('a broken share link gets its own sentence', () => {
  // This is the consequence that reaches OUTSIDE the app: a link the agent already sent
  // a client is now dead, and there is nowhere else they would find out.
  const { notice, registry } = harness();
  notice.show({ ids: ['r1'], evicted: [{ id: 'a', hadLiveShare: false }, { id: 'b', hadLiveShare: true }] });
  assert.match(registry.get(NOTICE_ID).textContent, /active share link, which no longer works/);
});

test('showing a clean render after an eviction clears the warning', () => {
  // The notice element is reused, so a stale warning would sit under an unrelated render.
  const { notice, registry } = harness();
  notice.show({ ids: ['r1'], evicted: [{ id: 'b', hadLiveShare: true }] });
  notice.show({ ids: ['r2'], evicted: [] });
  assert.equal(registry.get(NOTICE_ID).textContent, 'Saved to your gallery.');
});

test('clear() hides it', () => {
  const { notice, registry } = harness();
  notice.show({ ids: ['r1'] });
  notice.clear();
  assert.equal(registry.get(NOTICE_ID).textContent, '');
  assert.equal(registry.get(NOTICE_ID).classList.contains('hidden'), true);
});

test('no container is a no-op rather than a crash', () => {
  // The island is default-constructed inside staging-pipeline.js from a querySelector,
  // which is null on any page without the viewer.
  const notice = createGalleryNotice({ container: null, doc: harness().doc });
  assert.doesNotThrow(() => notice.show({ ids: ['r1'] }));
  assert.doesNotThrow(() => notice.clear());
});

test('it writes text, never markup', () => {
  // Nothing here is user-typed today. The day somebody adds a room name to one of these
  // strings is not the day to discover the difference.
  const src = fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'app', 'gallery-notice.js'), 'utf8');
  assert.ok(!/\.innerHTML\s*=/.test(src));
  assert.ok(!/insertAdjacentHTML/.test(src));
});

test('every string it renders exists in the English pack', () => {
  // The lookups have English fallbacks, so a missing key ships green and silently shows
  // English inside ten translated UIs. This is the guard that stops that.
  const pack = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'languages', 'english.json'), 'utf8'));
  const src = fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'app', 'gallery-notice.js'), 'utf8');
  const keys = [...src.matchAll(/t\('modal\.staging\.(\w+)'/g)].map((m) => m[1]);
  assert.ok(keys.length >= 3, `sanity: expected the notice's lookups, found ${keys.length}`);
  for (const key of keys) {
    assert.ok(pack.modal.staging[key], `english.json is missing modal.staging.${key}`);
  }
});

test('all eleven packs carry those strings, not just English', () => {
  const dir = path.join(ROOT, 'public', 'languages');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.equal(files.length, 11, 'sanity: eleven packs');
  for (const file of files) {
    const pack = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    for (const key of ['savedToGallery', 'galleryEvicted', 'galleryEvictedShared']) {
      assert.ok(pack.modal?.staging?.[key], `${file} is missing modal.staging.${key}`);
    }
    assert.ok(pack.profile?.yourGallery, `${file} is missing profile.yourGallery`);
  }
});
