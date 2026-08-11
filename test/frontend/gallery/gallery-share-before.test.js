// The "include the before photo" checkbox.
//
// WHAT THIS COVERS
// This is the only control an owner has over what a live share link publishes, and it is
// the reversal of a property this codebase used to hold structurally: the source photo was
// never published, by construction, in two files. It is publishable now, so the guards move
// from "impossible" to "off unless asked", and those are the properties pinned here:
//
//   1. It ships OFF and paints OFF. A link the owner has not touched shows the staged photo
//      alone, and a box that arrives ticked from the previous entry would be an owner
//      publishing a house they never chose to publish.
//   2. It saves the WHOLE settings bag. The store rebuilds settings from what it is sent
//      (normalizeShareSettings), so a delta would blank the headline and contact details
//      on the way past — silently, since nothing on this page displays them yet.
//   3. A failed save puts the box back. A control that shows ticked while the server has it
//      off is telling the owner their client can see a photo their client cannot.
//   4. No before photo, no question. The row is removed rather than disabled, because there
//      is nothing to include and a dead checkbox is a question with no answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { start } from '../../../public/scripts/gallery-app.js';
import { galleryDocument, fakeRoutes, cards } from '../../helpers/gallery-dom.js';

const LINK = 'https://stagify.test/s/TOKEN';

const ENTRY = {
  id: 'r1',
  createdAt: Date.UTC(2026, 7, 1),
  roomType: 'Bedroom',
  urls: { after: '/a.webp', before: '/b.webp', thumb: '/t.webp' },
  share: {
    url: LINK,
    viewCount: 0,
    settings: {
      headline: 'Ready to view', note: 'Tell me what you think',
      agentName: 'A. Broker', agentEmail: 'a@example.com', agentPhone: '+1 555 0100',
      showBefore: false,
    },
  },
};

/**
 * Boot with one entry, open it, and record every PATCH the panel sends.
 * @param {{ entry?: any, patchStatus?: number }} [arg]
 */
async function openCard({ entry = ENTRY, patchStatus = 200 } = {}) {
  const patches = [];
  const listing = fakeRoutes({
    '/api/gallery': { status: 200, body: { entries: [structuredClone(entry)], total: 1, enabled: true } },
  });
  /** @type {any} */
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('/share') && init.method === 'PATCH') {
      patches.push(JSON.parse(String(init.body)));
      return {
        ok: patchStatus < 400,
        status: patchStatus,
        json: async () => ({ success: patchStatus < 400 }),
      };
    }
    return listing(url, init);
  };

  const ctx = galleryDocument();
  await start({ doc: ctx.document, fetchImpl });
  cards(ctx.byId)[0].fire('click');
  return { ...ctx, patches };
}

// ---- what it shows --------------------------------------------------------------------

test('the box is offered, and unticked, for a render with a before photo', async () => {
  const ctx = await openCard();
  assert.equal(ctx.byId('gal-share-before-row').hidden, false, 'the row must be offered');
  assert.equal(ctx.byId('gal-share-before').checked, false, 'the default is off');
});

test('a link already set to show the before photo paints ticked', async () => {
  const entry = structuredClone(ENTRY);
  entry.share.settings.showBefore = true;
  const ctx = await openCard({ entry });
  assert.equal(ctx.byId('gal-share-before').checked, true);
});

test('only a real `true` paints ticked', async () => {
  // The server sends a boolean. Anything else reaching this far means something upstream
  // is coercing, and the safe reading of an unclear value is "not published".
  const entry = structuredClone(ENTRY);
  entry.share.settings.showBefore = /** @type {any} */ ('true');
  const ctx = await openCard({ entry });
  assert.equal(ctx.byId('gal-share-before').checked, false);
});

test('a render with no before photo is not asked the question', async () => {
  const entry = structuredClone(ENTRY);
  entry.urls.before = '';
  const ctx = await openCard({ entry });
  assert.equal(ctx.byId('gal-share-before-row').hidden, true, 'nothing to include');
});

test('an entry that came back without a link is not asked either', async () => {
  // Same reasoning as the copy button: there is no link for the setting to be about.
  const ctx = await openCard({ entry: { ...structuredClone(ENTRY), share: null } });
  assert.equal(ctx.byId('gal-share-before-row').hidden, true);
});

// ---- what it saves --------------------------------------------------------------------

test('ticking it sends the WHOLE settings bag, not just the flag', async () => {
  const ctx = await openCard();
  const box = ctx.byId('gal-share-before');
  box.checked = true;
  await box.fire('change');

  assert.equal(ctx.patches.length, 1, 'exactly one write');
  assert.deepEqual(ctx.patches[0], {
    settings: {
      headline: 'Ready to view',
      note: 'Tell me what you think',
      agentName: 'A. Broker',
      agentEmail: 'a@example.com',
      agentPhone: '+1 555 0100',
      showBefore: true,
    },
  }, 'a delta would blank everything it left out');
});

test('unticking it sends showBefore false rather than dropping the key', async () => {
  const entry = structuredClone(ENTRY);
  entry.share.settings.showBefore = true;
  const ctx = await openCard({ entry });
  const box = ctx.byId('gal-share-before');
  box.checked = false;
  await box.fire('change');

  assert.equal(ctx.patches[0].settings.showBefore, false);
});

test('a saved change is reflected back, so a second edit does not resend the old value', async () => {
  const ctx = await openCard();
  const box = ctx.byId('gal-share-before');
  box.checked = true;
  await box.fire('change');
  box.checked = false;
  await box.fire('change');

  assert.equal(ctx.patches.length, 2);
  assert.equal(ctx.patches[1].settings.showBefore, false);
  assert.equal(ctx.patches[1].settings.headline, 'Ready to view', 'the rest of the bag survived the round trip');
});

test('a save that failed puts the box back and says so', async () => {
  const ctx = await openCard({ patchStatus: 500 });
  const box = ctx.byId('gal-share-before');
  box.checked = true;
  await box.fire('change');

  assert.equal(box.checked, false, 'the box must not claim a state the server refused');
  const status = ctx.byId('gal-share-status').textContent;
  assert.match(status, /could not/i, `the failure was silent: ${JSON.stringify(status)}`);
});

test('the panel says which way it went, not just that it saved', async () => {
  // "Saved" leaves the owner to work out what a link now shows. The two messages name it.
  const ctx = await openCard();
  const box = ctx.byId('gal-share-before');
  box.checked = true;
  await box.fire('change');
  const on = ctx.byId('gal-share-status').textContent;

  box.checked = false;
  await box.fire('change');
  const off = ctx.byId('gal-share-status').textContent;

  assert.notEqual(on, off, 'both directions reported the same thing');
  assert.match(on, /before/i);
  assert.match(off, /staged/i);
});
