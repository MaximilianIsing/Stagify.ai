// public/scripts/app/gallery-notice.js — the line under a finished render.
//
// The headline behaviour: saving is SILENT. There is no success confirmation at all — the
// gallery is somewhere renders simply are afterwards, not something announced each time
// it works. So the only thing that makes this speak is LOSS: it must actually
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

test('a render that saved cleanly says NOTHING', () => {
  // The common case, and the whole point: the gallery is somewhere renders simply are
  // afterwards, not a feature the app announces every time it works. A confirmation on
  // every success is noise the user cannot act on, sitting next to the Download button.
  const { notice, registry, container } = harness();
  notice.show({ ids: ['r1'], evicted: [] });

  const el = registry.get(NOTICE_ID);
  if (el) {
    assert.equal(el.textContent, '');
    assert.equal(el.classList.contains('hidden'), true);
  }
  // ...and it must not have appended a second element either.
  notice.show({ ids: ['r2'], evicted: [] });
  assert.ok(container.children.length <= 1);
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
  // Silence on success, a sentence on loss — this is the only thing that makes it speak.
  const { notice, registry } = harness();
  notice.show({ ids: ['r1'], evicted: [{ id: 'old', hadLiveShare: false }] });
  const text = registry.get(NOTICE_ID).textContent;
  assert.match(text, /Older stagings were removed/);
  assert.ok(!/Saved to your gallery/i.test(text), 'the success line is gone for good');
  // Nothing was shared, so the harsher sentence must not appear.
  assert.ok(!/share link/i.test(text));
});

test('a PRO eviction says nothing about the cap', () => {
  // Stagify+ is sold as unlimited staging — which it is — and the gallery's 200-entry
  // ceiling is deliberately not advertised. A pro eviction must not mention a plan
  // With the success line gone, a pro eviction that broke nothing is now COMPLETELY
  // silent — there is no cap to mention and nothing the user could act on.
  const { notice, registry } = harness();
  notice.show({ ids: ['r1'], tier: 'pro', evicted: [{ id: 'old', hadLiveShare: false }] });
  const el = registry.get(NOTICE_ID);
  if (el) {
    assert.equal(el.textContent, '');
    assert.equal(el.classList.contains('hidden'), true);
  }
});

test('a pro eviction STILL reports a broken share link', () => {
  // This is where "do not advertise the cap" stops. The agent's client has a dead link
  // and nowhere else to learn it. The sentence names the consequence without naming the
  // limit, so both things can be true at once.
  const { notice, registry } = harness();
  notice.show({ ids: ['r1'], tier: 'pro', evicted: [{ id: 'old', hadLiveShare: true }] });
  const text = registry.get(NOTICE_ID).textContent;
  assert.match(text, /active share link, which no longer works/);
  assert.ok(!/plan|limit/i.test(text), 'still no mention of the ceiling');
});

test('a FREE eviction does name the plan, because there it is the upgrade prompt', () => {
  const { notice, registry } = harness();
  notice.show({ ids: ['r1'], tier: 'free', evicted: [{ id: 'old', hadLiveShare: false }] });
  assert.match(registry.get(NOTICE_ID).textContent, /free plan keeps your most recent/);
});

test('a broken share link gets its own sentence', () => {
  // This is the consequence that reaches OUTSIDE the app: a link the agent already sent
  // a client is now dead, and there is nowhere else they would find out.
  const { notice, registry } = harness();
  notice.show({ ids: ['r1'], evicted: [{ id: 'a', hadLiveShare: false }, { id: 'b', hadLiveShare: true }] });
  assert.match(registry.get(NOTICE_ID).textContent, /active share link, which no longer works/);
});

test('showing a clean render after an eviction clears the warning', () => {
  // The notice element is reused, so a stale warning would sit under an unrelated render
  // — and with nothing else ever rendered there, a leftover would be the ONLY thing on
  // screen. This is the case that would look most broken if it regressed.
  const { notice, registry } = harness();
  notice.show({ ids: ['r1'], evicted: [{ id: 'b', hadLiveShare: true }] });
  assert.match(registry.get(NOTICE_ID).textContent, /share link/);

  notice.show({ ids: ['r2'], evicted: [] });
  assert.equal(registry.get(NOTICE_ID).textContent, '');
  assert.equal(registry.get(NOTICE_ID).classList.contains('hidden'), true);
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
  assert.ok(keys.length >= 2, `sanity: expected the notice's lookups, found ${keys.length}`);
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
    for (const key of ['galleryEvicted', 'galleryEvictedShared']) {
      assert.ok(pack.modal?.staging?.[key], `${file} is missing modal.staging.${key}`);
    }
    assert.ok(pack.profile?.yourGallery, `${file} is missing profile.yourGallery`);
  }
});
