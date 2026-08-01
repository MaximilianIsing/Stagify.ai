// Tier: unit (real SQLite in a temp dir) — lib/data/projects.js + lib/data/project-renders.js.
//
// WHAT THIS COVERS
// The row half of the Listing Studio: one listing, its photos grouped into rooms, the
// versioned per-room design bible, and the render queue. The parts worth testing are the
// ones where the database is load-bearing rather than incidental:
//
//   - THE BIBLE BARRIER in `claimNextRender`. A support frame must be unclaimable until its
//     room's bible exists, and that rule lives in the claim's single UPDATE statement. Note
//     the shape of those tests below: "a barred row is not returned" passes even if the
//     barrier is moved into a JS post-filter, so the assertions that actually PIN the SQL are
//     (a) a barred row FIRST in FIFO order must be SKIPPED in favour of a later eligible one
//     (a post-filter returns null and stalls the queue), and (b) two claims in a row must
//     never hand out the same render.
//   - THE EXPLICIT CASCADES. This database declares no foreign keys, so `deleteProject`,
//     `deleteProjectsForUser` and `deletePhoto` are the only things standing between a
//     deletion and a pile of orphan rows. Their counts are asserted, not assumed.
//   - THE sha256 DEDUP, which has to return the existing row rather than throw, because
//     re-dragging a folder of 30 photos is normal behaviour.
//   - `updatePhoto`'s allowlist, since the alternative to an allowlist is building SQL from
//     caller-supplied column names.
//   - The LEASE lifecycle: claim, release, complete, fail, reclaim-what-a-crash-abandoned.
//
// Runs against a throwaway data dir, so no real project data is touched.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createProjects,
  newId,
  PROJECT_STATUSES,
  FRAME_ROLES,
  RENDER_STATUSES,
  DEFAULT_LEASE_MS,
  MAX_LIST_LIMIT,
} from '../../lib/data/projects.js';
import { closeDb, getDb } from '../../lib/data/db.js';

const T0 = Date.UTC(2026, 6, 28, 12);
const MINUTE = 60 * 1000;
const USER = 'u_agent_1';

const dirs = [];

/** A store on a fresh data dir. */
function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stagify-proj-'));
  dirs.push(dir);
  return { dir, projects: createProjects(dir) };
}

/** A store with one listing already in it — most tests need one. */
function withProject(over = {}) {
  const s = store();
  const project = s.projects.createProject({ userId: USER, title: '12 Oak St', address: '12 Oak St, Denver', now: T0, ...over });
  return { ...s, project };
}

let shaCounter = 0;
/**
 * Add a photo, asserting it landed. Each call gets a fresh content hash unless one is given,
 * so the dedup index only fires where a test means it to.
 */
function addPhoto(projects, projectId, over = {}) {
  const id = newId();
  const result = projects.addPhoto({
    projectId,
    storageKey: `projects/${projectId}/src/${id}.webp`,
    sha256: `sha-${(shaCounter += 1)}`,
    width: 4000,
    height: 3000,
    arLabel: '4:3',
    now: T0,
    ...over,
  });
  assert.equal(result.ok, true, `precondition: addPhoto failed — ${result.error || ''}`);
  return result.photo;
}

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    // Windows cannot unlink the .db/-wal/-shm files while the shared handle is open.
    closeDb(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Ids and constants -----------------------------------------------------

test('newId mints 32 lowercase hex characters, distinct every time', () => {
  // The shape is load-bearing: these ids become path segments in a storage_key, and
  // STORAGE_KEY_PATTERN in project-storage.js accepts only [a-f0-9]{8,64}.
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) {
    const id = newId();
    assert.match(id, /^[a-f0-9]{32}$/);
    ids.add(id);
  }
  assert.equal(ids.size, 200, 'no collisions');
});

test('the exported status lists match the CHECK constraints the database enforces', () => {
  const { dir, projects } = withProject();
  const db = getDb(dir);
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?");
  for (const status of PROJECT_STATUSES) assert.ok(sql.get('projects').sql.includes(`'${status}'`), status);
  for (const role of FRAME_ROLES) assert.ok(sql.get('project_photos').sql.includes(`'${role}'`), role);
  for (const state of RENDER_STATUSES) assert.ok(sql.get('renders').sql.includes(`'${state}'`), state);
  // And the constraint really refuses something outside the list.
  assert.throws(() => db.prepare('UPDATE projects SET status = ? WHERE id = ?').run('bogus', projects.getProject(projects.listProjects(USER)[0].id).id), /CHECK/);
});

test('no table in this store declares a foreign key', () => {
  // The standing rule for this database (see the note in lib/data/db.js). It is why every
  // cascade below is written out by hand — and test/data/db.test.js fails the build if it is
  // ever broken, so this is the local, faster-failing copy of that guard.
  const { dir } = withProject();
  const db = getDb(dir);
  for (const table of ['projects', 'project_photos', 'design_bibles', 'renders']) {
    assert.deepEqual(db.pragma(`foreign_key_list(${table})`), [], `${table} gained an FK — see db.js`);
  }
});

// ---- Projects --------------------------------------------------------------

test('a created listing round-trips with its defaults', () => {
  const { projects, project } = withProject();
  assert.match(project.id, /^[a-f0-9]{32}$/);
  assert.equal(project.userId, USER);
  assert.equal(project.title, '12 Oak St');
  assert.equal(project.address, '12 Oak St, Denver');
  assert.equal(project.status, 'draft', 'a new listing starts as a draft');
  assert.equal(project.createdAt, T0);
  assert.equal(project.updatedAt, T0);
  assert.equal(project.extra, null);
  assert.deepEqual(projects.getProject(project.id), project);
});

test('a listing created with nothing but a user id is still valid', () => {
  const { projects } = store();
  const project = projects.createProject({ userId: USER, now: T0 });
  assert.equal(project.title, '');
  assert.equal(project.address, '');
  assert.equal(projects.countAll().projects, 1);
});

test('getProject answers null for an id that does not exist', () => {
  const { projects } = store();
  assert.equal(projects.getProject('nope'), null);
  assert.equal(projects.getProject(''), null);
});

test('listProjects is scoped to the user and ordered by most recent activity', () => {
  const { projects } = store();
  const a = projects.createProject({ userId: USER, title: 'A', now: T0 });
  const b = projects.createProject({ userId: USER, title: 'B', now: T0 + MINUTE });
  projects.createProject({ userId: 'someone-else', title: 'Theirs', now: T0 + 2 * MINUTE });

  assert.deepEqual(projects.listProjects(USER).map((p) => p.title), ['B', 'A'], 'newest first');
  // Touching the older one moves it to the top: the ordering tracks activity, not creation.
  projects.touchProject(a.id, T0 + 3 * MINUTE);
  assert.deepEqual(projects.listProjects(USER).map((p) => p.title), ['A', 'B']);
  assert.deepEqual(projects.listProjects('someone-else').map((p) => p.title), ['Theirs']);
  assert.deepEqual(projects.listProjects('nobody'), []);
  assert.equal(projects.getProject(b.id).updatedAt, T0 + MINUTE, 'the other listing was not touched');
});

test('listProjects paginates, and clamps a limit nobody should be asking for', () => {
  const { projects } = store();
  for (let i = 0; i < 5; i += 1) projects.createProject({ userId: USER, title: `P${i}`, now: T0 + i * MINUTE });

  assert.deepEqual(projects.listProjects(USER, { limit: 2 }).map((p) => p.title), ['P4', 'P3']);
  assert.deepEqual(projects.listProjects(USER, { limit: 2, offset: 2 }).map((p) => p.title), ['P2', 'P1']);
  assert.equal(projects.listProjects(USER, { limit: 999 }).length, 5, `clamped to ${MAX_LIST_LIMIT}, not refused`);
  // A falsy limit (0, '', junk) takes the DEFAULT page rather than returning nothing: an
  // explicit 0 is a caller bug, and an empty list would read as "this user has no listings".
  assert.equal(projects.listProjects(USER, { limit: 0 }).length, 5, 'a zero limit is the default page, not an empty one');
  assert.equal(projects.listProjects(USER, { limit: /** @type {any} */ ('junk') }).length, 5, 'and so is a junk limit');
  assert.equal(projects.listProjects(USER, { limit: -3 }).length, 1, 'a negative limit floors at one row');
  assert.equal(projects.listProjects(USER, { offset: -5 }).length, 5, 'a negative offset is floored at 0');
  assert.equal(projects.listProjects(USER, { offset: 99 }).length, 0, 'past the end is empty');
});

test('updateProject patches the fields it owns and bumps updated_at', () => {
  const { projects, project } = withProject();
  const updated = projects.updateProject(project.id, { title: 'Renamed', status: 'staging', now: T0 + MINUTE });
  assert.equal(updated.title, 'Renamed');
  assert.equal(updated.status, 'staging');
  assert.equal(updated.address, '12 Oak St, Denver', 'an unmentioned field is left alone');
  assert.equal(updated.updatedAt, T0 + MINUTE);
  assert.equal(updated.createdAt, T0, 'createdAt is never rewritten');
});

test('updateProject ignores keys that are not its columns', () => {
  // The allowlist is the whole defence: the alternative is building SQL from caller keys.
  const { projects, project } = withProject();
  const updated = projects.updateProject(project.id, /** @type {any} */ ({
    title: 'Kept', id: 'hijacked', userId: 'someone-else', createdAt: 0, 'title = 1; DROP TABLE projects; --': 'x',
  }));
  assert.equal(updated.title, 'Kept');
  assert.equal(updated.id, project.id, 'the primary key is not patchable');
  assert.equal(updated.userId, USER, 'ownership is not patchable');
  assert.equal(updated.createdAt, T0);
  assert.equal(projects.countAll().projects, 1, 'and the table is still there');
});

test('an empty patch is a save: it touches the listing rather than failing', () => {
  const { projects, project } = withProject();
  const updated = projects.updateProject(project.id, { now: T0 + MINUTE });
  assert.equal(updated.updatedAt, T0 + MINUTE);
  assert.equal(updated.title, '12 Oak St');
  assert.equal(projects.updateProject('ghost', { title: 'x' }), null, 'and an unknown listing is null, not a throw');
  assert.equal(projects.touchProject('ghost'), null);
});

test('extra_json round-trips as a parsed object, and survives being unparseable', () => {
  const { dir, projects, project } = withProject();
  const patched = projects.updateProject(project.id, { extraJson: JSON.stringify({ mls: 'A1', beds: 3 }) });
  assert.deepEqual(patched.extra, { mls: 'A1', beds: 3 });

  // Corrupt the column behind the store's back: a bad row must not take down the listing.
  getDb(dir).prepare('UPDATE projects SET extra_json = ? WHERE id = ?').run('{not json', project.id);
  assert.equal(projects.getProject(project.id).extra, null, 'degrades to null instead of throwing');
  assert.equal(projects.getProject(project.id).title, '12 Oak St', 'the rest of the row still reads');
});

// ---- Photos ----------------------------------------------------------------

test('a photo round-trips with its measurements and an auto-assigned seq', () => {
  const { projects, project } = withProject();
  const first = addPhoto(projects, project.id);
  const second = addPhoto(projects, project.id);

  assert.equal(first.projectId, project.id);
  assert.equal(first.seq, 1, 'seq starts at 1');
  assert.equal(second.seq, 2, 'and increments per project');
  assert.equal(first.width, 4000);
  assert.equal(first.height, 3000);
  assert.equal(first.arLabel, '4:3');
  assert.equal(first.frameRole, 'support', 'frames are support until one is made hero');
  assert.equal(first.roomKey, null, 'and ungrouped until clustering runs');
  assert.equal(first.stageable, null, 'tri-state: not checked yet is not the same as rejected');
  assert.equal(first.unstageableCode, null);
  assert.deepEqual(projects.getPhoto(first.id), first);
  assert.equal(projects.getPhoto('ghost'), null);
});

test('seq counts per listing, not globally, and an explicit seq is honoured', () => {
  const { projects, project } = withProject();
  const other = projects.createProject({ userId: USER, now: T0 });
  addPhoto(projects, project.id);
  assert.equal(addPhoto(projects, other.id).seq, 1, 'a second listing starts its own numbering');
  assert.equal(addPhoto(projects, project.id, { seq: 99 }).seq, 99);
  assert.equal(addPhoto(projects, project.id).seq, 100, 'and the next auto seq follows the max');
});

test('re-uploading the same bytes returns the existing photo instead of throwing', () => {
  // The dedup is idempotency, not an error: re-dragging a folder because one file failed is
  // normal, and a UNIQUE-constraint exception at that moment reads as data loss.
  const { projects, project } = withProject();
  const first = addPhoto(projects, project.id, { sha256: 'same-bytes' });
  const again = projects.addPhoto({
    projectId: project.id, storageKey: 'projects/x/src/y.webp', sha256: 'same-bytes', now: T0 + MINUTE,
  });
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true, 'reported as a duplicate so the UI can say so');
  assert.equal(again.photo.id, first.id, 'and it is the SAME row, not a second one');
  assert.equal(again.photo.storageKey, first.storageKey, 'the original blob is still the one on file');
  assert.equal(projects.countAll().photos, 1);
});

test('the same bytes in a different listing are a separate photo', () => {
  // The dedup key is (project_id, sha256): two agents staging the same stock shot must not
  // collide, and an empty room photographed twice for two listings is two photos.
  const { projects, project } = withProject();
  const other = projects.createProject({ userId: USER, now: T0 });
  const mine = addPhoto(projects, project.id, { sha256: 'shared-bytes' });
  const theirs = addPhoto(projects, other.id, { sha256: 'shared-bytes' });
  assert.notEqual(mine.id, theirs.id);
  assert.equal(projects.countAll().photos, 2);
});

test('addPhoto refuses what it cannot store, each with its own code', () => {
  const { projects, project } = withProject();
  assert.deepEqual(
    projects.addPhoto({ projectId: project.id, storageKey: 'k' }),
    { ok: false, code: 'SHA_REQUIRED', error: 'A content hash is required to de-duplicate the upload.' },
  );
  assert.equal(projects.addPhoto({ projectId: project.id, sha256: 's' }).code, 'KEY_REQUIRED');
  // The foreign key this database cannot declare, enforced at the one place that inserts.
  assert.equal(projects.addPhoto({ projectId: 'ghost', storageKey: 'k', sha256: 's' }).code, 'PROJECT_NOT_FOUND');
  assert.equal(projects.addPhoto({}).code, 'SHA_REQUIRED');
  assert.equal(projects.addPhoto().code, 'SHA_REQUIRED', 'called with nothing at all');
  assert.equal(projects.countAll().photos, 0, 'nothing was written');
});

test('a frameRole outside the allowed set falls back to support', () => {
  const { projects, project } = withProject();
  assert.equal(addPhoto(projects, project.id, { frameRole: 'hero' }).frameRole, 'hero');
  assert.equal(addPhoto(projects, project.id, { frameRole: 'excluded' }).frameRole, 'excluded');
  assert.equal(addPhoto(projects, project.id, { frameRole: 'nonsense' }).frameRole, 'support');
  assert.equal(addPhoto(projects, project.id, { frameRole: null }).frameRole, 'support');
});

test('listPhotos orders by seq', () => {
  const { projects, project } = withProject();
  const third = addPhoto(projects, project.id, { seq: 3 });
  const first = addPhoto(projects, project.id, { seq: 1 });
  const second = addPhoto(projects, project.id, { seq: 2 });
  assert.deepEqual(projects.listPhotos(project.id).map((p) => p.id), [first.id, second.id, third.id]);
  assert.deepEqual(projects.listPhotos('ghost'), []);
});

test('updatePhoto writes the grouping and verdict fields', () => {
  const { projects, project } = withProject();
  const photo = addPhoto(projects, project.id);
  const updated = projects.updatePhoto(photo.id, {
    roomKey: 'living-1', roomType: 'living_room', frameRole: 'hero', stageable: true, seq: 7, now: T0 + MINUTE,
  });
  assert.equal(updated.roomKey, 'living-1');
  assert.equal(updated.roomType, 'living_room');
  assert.equal(updated.frameRole, 'hero');
  assert.equal(updated.stageable, true);
  assert.equal(updated.seq, 7);
  assert.equal(projects.getProject(project.id).updatedAt, T0 + MINUTE, 'the listing was touched');
});

test('stageable keeps three distinct states through the round trip', () => {
  // null (not checked) must not read the same as false (checked and rejected) — the studio
  // shows a spinner for one and a reason for the other.
  const { projects, project } = withProject();
  const photo = addPhoto(projects, project.id);
  assert.equal(projects.getPhoto(photo.id).stageable, null);
  assert.equal(projects.updatePhoto(photo.id, { stageable: false, unstageableCode: 'EXTERIOR' }).stageable, false);
  assert.equal(projects.getPhoto(photo.id).unstageableCode, 'EXTERIOR');
  assert.equal(projects.updatePhoto(photo.id, { stageable: true, unstageableCode: null }).stageable, true);
  assert.equal(projects.getPhoto(photo.id).unstageableCode, null);
  assert.equal(projects.updatePhoto(photo.id, { stageable: null }).stageable, null, 'and it can go back to unchecked');
});

test('updatePhoto ignores every key outside its allowlist', () => {
  const { projects, project } = withProject();
  const photo = addPhoto(projects, project.id, { sha256: 'original-hash' });
  const updated = projects.updatePhoto(photo.id, /** @type {any} */ ({
    roomKey: 'kitchen-1',            // allowed
    sha256: 'rewritten',             // NOT allowed: the dedup key must not be patchable
    storageKey: 'projects/evil/src/x.webp',
    id: 'hijacked',
    projectId: 'someone-elses-listing',
    createdAt: 0,
    'room_key = 1; DROP TABLE project_photos; --': 'x',
  }));
  assert.equal(updated.roomKey, 'kitchen-1');
  assert.equal(updated.sha256, 'original-hash');
  assert.equal(updated.storageKey, photo.storageKey);
  assert.equal(updated.id, photo.id);
  assert.equal(updated.projectId, project.id);
  assert.equal(updated.createdAt, T0);
  assert.equal(projects.countAll().photos, 1, 'and the table survived');
});

test('a patch with nothing patchable in it returns the photo unchanged', () => {
  const { projects, project } = withProject();
  const photo = addPhoto(projects, project.id);
  assert.deepEqual(projects.updatePhoto(photo.id, /** @type {any} */ ({ nope: 1 })), photo);
  assert.deepEqual(projects.updatePhoto(photo.id), photo);
  assert.equal(projects.updatePhoto('ghost', { roomKey: 'x' }), null);
});

test('setHero promotes one frame and demotes the room’s previous hero', () => {
  const { projects, project } = withProject();
  const a = addPhoto(projects, project.id, { roomKey: 'living-1' });
  const b = addPhoto(projects, project.id, { roomKey: 'living-1' });

  const first = projects.setHero(project.id, 'living-1', a.id);
  assert.equal(first.ok, true);
  assert.equal(first.photo.frameRole, 'hero');
  assert.equal(first.demoted, 0, 'nothing to demote yet');

  const second = projects.setHero(project.id, 'living-1', b.id);
  assert.equal(second.demoted, 1, 'the previous hero stepped down');
  assert.equal(second.photo.frameRole, 'hero');
  assert.equal(projects.getPhoto(a.id).frameRole, 'support', 'and became a support frame');
  assert.equal(projects.listPhotos(project.id).filter((p) => p.frameRole === 'hero').length, 1);
});

test('setHero also assigns the room, and leaves other rooms’ heroes alone', () => {
  const { projects, project } = withProject();
  const kitchen = addPhoto(projects, project.id);
  const living = addPhoto(projects, project.id);
  projects.setHero(project.id, 'kitchen-1', kitchen.id);
  projects.setHero(project.id, 'living-1', living.id);

  assert.equal(projects.getPhoto(kitchen.id).roomKey, 'kitchen-1', 'choosing a hero is how a room gets named');
  assert.equal(projects.getPhoto(kitchen.id).frameRole, 'hero', 'the kitchen hero was not demoted by the living-room one');
  assert.equal(projects.getPhoto(living.id).frameRole, 'hero');
});

test('setHero refuses a photo that is missing or belongs to another listing', () => {
  const { projects, project } = withProject();
  const other = projects.createProject({ userId: 'someone-else', now: T0 });
  const theirs = addPhoto(projects, other.id);
  assert.equal(projects.setHero(project.id, 'living-1', 'ghost').code, 'NOT_FOUND');
  assert.equal(projects.setHero(project.id, 'living-1', theirs.id).code, 'WRONG_PROJECT');
  assert.equal(projects.getPhoto(theirs.id).frameRole, 'support', 'and their photo was not touched');
});

test('a room can be keyed as null, and setHero handles that room like any other', () => {
  // Ungrouped frames all share `room_key IS NULL`, and `IS ?` is what makes the demote query
  // match them — `= ?` would silently match nothing and leave two heroes.
  const { projects, project } = withProject();
  const a = addPhoto(projects, project.id);
  const b = addPhoto(projects, project.id);
  projects.setHero(project.id, null, a.id);
  const second = projects.setHero(project.id, null, b.id);
  assert.equal(second.demoted, 1);
  assert.equal(projects.getPhoto(a.id).frameRole, 'support');
  assert.equal(projects.getPhoto(b.id).roomKey, null);
});

test('deletePhoto removes its renders and reports every orphaned blob key', () => {
  // The keys come back because the rows go in a synchronous transaction while blob removal is
  // async fs work — the caller pairs the two.
  const { projects, project } = withProject();
  const photo = addPhoto(projects, project.id);
  const keep = addPhoto(projects, project.id);
  const r1 = projects.enqueueRender({ projectId: project.id, photoId: photo.id, now: T0 });
  projects.enqueueRender({ projectId: project.id, photoId: photo.id, variation: 2, now: T0 });
  projects.enqueueRender({ projectId: project.id, photoId: keep.id, now: T0 });
  projects.completeRender(r1.id, { storageKey: `projects/${project.id}/out/${newId()}.webp`, now: T0 });

  const result = projects.deletePhoto(photo.id);
  assert.equal(result.ok, true);
  assert.equal(result.renders, 2, 'both of its renders went with it');
  assert.deepEqual(result.storageKeys.length, 2, 'the photo blob plus the one render that produced a file');
  assert.ok(result.storageKeys.includes(photo.storageKey));
  assert.equal(projects.getPhoto(photo.id), null);
  assert.equal(projects.rendersForPhoto(photo.id).length, 0, 'no orphan render rows left behind');
  assert.equal(projects.rendersForPhoto(keep.id).length, 1, 'the other photo is untouched');
  assert.deepEqual(projects.deletePhoto(photo.id), { ok: false, code: 'NOT_FOUND', error: 'That photo no longer exists.' });
});

// ---- Design bibles ---------------------------------------------------------

const DOC = {
  roomType: 'living_room',
  furnitureStyle: 'modern',
  palette: { walls: 'warm white', accent: 'ochre' },
  lighting: { key: 'window left', mood: 'bright' },
  pieces: [{ slot: 'sofa', identity: '3-seat, 4 tapered oak legs, 3 back cushions', placement: 'facing the window', critical: true }],
  negatives: ['no floating furniture'],
};

test('a bible round-trips as a parsed document, self-describing about its version and room', () => {
  const { projects, project } = withProject();
  const bible = projects.createBible({
    projectId: project.id, roomKey: 'living-1', roomType: 'living_room', furnitureStyle: 'modern',
    heroRenderId: null, doc: DOC, now: T0,
  });
  assert.match(bible.id, /^[a-f0-9]{32}$/);
  assert.equal(bible.version, 1);
  assert.equal(bible.roomKey, 'living-1');
  assert.equal(bible.furnitureStyle, 'modern');
  assert.equal(bible.roomType, 'living_room');
  assert.equal(bible.heroRenderId, null);
  assert.deepEqual(bible.doc.pieces, DOC.pieces);
  assert.equal(bible.doc.version, 1, 'the document carries its own version so it reads without its row');
  assert.equal(bible.doc.roomKey, 'living-1');
  assert.deepEqual(projects.getBible(bible.id), bible);
  assert.equal(projects.getBible('ghost'), null);
});

test('bible versions auto-increment per room, and each room counts independently', () => {
  const { projects, project } = withProject();
  const make = (roomKey) => projects.createBible({ projectId: project.id, roomKey, doc: DOC, roomType: 'r', furnitureStyle: 'f', now: T0 });

  assert.equal(make('living-1').version, 1);
  assert.equal(make('living-1').version, 2);
  assert.equal(make('kitchen-1').version, 1, 'a second room starts at 1, not 3');
  assert.equal(make('living-1').version, 3);
  assert.equal(make('kitchen-1').version, 2);

  assert.equal(projects.latestBible(project.id, 'living-1').version, 3);
  assert.equal(projects.latestBible(project.id, 'kitchen-1').version, 2);
  assert.equal(projects.latestBible(project.id, 'no-such-room'), null);
  assert.deepEqual(projects.listBibles(project.id).map((b) => `${b.roomKey}v${b.version}`),
    ['kitchen-1v1', 'kitchen-1v2', 'living-1v1', 'living-1v2', 'living-1v3']);
});

test('bible versions are per listing too', () => {
  const { projects, project } = withProject();
  const other = projects.createProject({ userId: USER, now: T0 });
  const args = { roomKey: 'living-1', doc: DOC, roomType: 'r', furnitureStyle: 'f', now: T0 };
  projects.createBible({ ...args, projectId: project.id });
  assert.equal(projects.createBible({ ...args, projectId: other.id }).version, 1);
  assert.deepEqual(projects.listBibles(other.id).length, 1);
});

test('a bible with an unparseable document reads as doc:null rather than throwing', () => {
  const { dir, projects, project } = withProject();
  const bible = projects.createBible({ projectId: project.id, roomKey: 'living-1', doc: DOC, roomType: 'r', furnitureStyle: 'f', now: T0 });
  getDb(dir).prepare('UPDATE design_bibles SET doc_json = ? WHERE id = ?').run('{truncated', bible.id);
  const read = projects.getBible(bible.id);
  assert.equal(read.doc, null);
  assert.equal(read.version, 1, 'the row still reads — only the document is lost');
});

test('a bible built with no document at all is still a usable row', () => {
  const { projects, project } = withProject();
  const bible = projects.createBible({ projectId: project.id, roomKey: 'living-1', now: T0 });
  assert.deepEqual(bible.doc, {});
  assert.equal(bible.furnitureStyle, '');
  assert.equal(projects.createBible().version, 1, 'called with nothing at all');
});

// ---- The render queue ------------------------------------------------------

/** A project with a hero and a support frame in one room, matching the real flow. */
function roomFixture() {
  const { dir, projects, project } = withProject();
  const hero = addPhoto(projects, project.id, { roomKey: 'living-1', frameRole: 'hero' });
  const support = addPhoto(projects, project.id, { roomKey: 'living-1', frameRole: 'support' });
  return { dir, projects, project, hero, support };
}

test('an enqueued render starts queued and unclaimed', () => {
  const { projects, project, hero } = roomFixture();
  const render = projects.enqueueRender({ projectId: project.id, photoId: hero.id, now: T0 });
  assert.match(render.id, /^[a-f0-9]{32}$/);
  assert.equal(render.status, 'queued');
  assert.equal(render.variation, 1);
  assert.equal(render.bibleId, null);
  assert.equal(render.storageKey, null);
  assert.equal(render.claimedAt, null);
  assert.equal(render.genAttempts, 0);
  assert.equal(render.createdAt, T0);
  assert.deepEqual(projects.getRender(render.id), render);
  assert.equal(projects.getRender('ghost'), null);
});

test('THE BIBLE BARRIER: a support render with no bible is not claimable', () => {
  const { projects, project, support } = roomFixture();
  const render = projects.enqueueRender({ projectId: project.id, photoId: support.id, now: T0 });

  assert.equal(projects.claimNextRender({ now: T0 + MINUTE }), null, 'the only queued row is barred');
  assert.equal(projects.getRender(render.id).status, 'queued', 'and it stays queued, not failed');
});

test('THE BIBLE BARRIER lifts the moment a bible is attached', () => {
  const { projects, project, support } = roomFixture();
  const render = projects.enqueueRender({ projectId: project.id, photoId: support.id, now: T0 });
  const bible = projects.createBible({ projectId: project.id, roomKey: 'living-1', doc: DOC, roomType: 'r', furnitureStyle: 'f', now: T0 });

  assert.equal(projects.attachBibleToQueuedRenders(project.id, 'living-1', bible.id), 1, 'one queued render was released');
  const claimed = projects.claimNextRender({ now: T0 + MINUTE });
  assert.equal(claimed.id, render.id);
  assert.equal(claimed.bibleId, bible.id);
  assert.equal(claimed.status, 'running');
  assert.equal(claimed.claimedAt, T0 + MINUTE);
});

test('THE BIBLE BARRIER is in the SQL: a barred row is SKIPPED, not allowed to stall the queue', () => {
  // This is the assertion that pins the barrier to the claim's WHERE clause. Move the check
  // into a JS post-filter ("claim the oldest queued row, then reject it if it is barred") and
  // the two tests above still pass — but this one fails, because a post-filter would return
  // null here and the hero render would never run, deadlocking the whole listing behind the
  // support frame that is waiting for it.
  const { projects, project, hero, support } = roomFixture();
  const barred = projects.enqueueRender({ projectId: project.id, photoId: support.id, now: T0 });          // FIRST in FIFO
  const eligible = projects.enqueueRender({ projectId: project.id, photoId: hero.id, now: T0 + 1000 });    // later, but claimable

  const claimed = projects.claimNextRender({ now: T0 + MINUTE });
  assert.ok(claimed, 'the queue must not stall behind a barred row');
  assert.equal(claimed.id, eligible.id, 'the hero render was claimed even though the barred one is older');
  assert.equal(projects.getRender(barred.id).status, 'queued', 'and the barred row was left alone');
});

test('a render is never handed to two workers', () => {
  // The claim is one UPDATE … WHERE id = (SELECT …) RETURNING *. A read-then-write pair would
  // let a second caller see the same candidate and bill the listing twice for one image.
  const { projects, project, hero } = roomFixture();
  const a = projects.enqueueRender({ projectId: project.id, photoId: hero.id, now: T0 });
  const b = projects.enqueueRender({ projectId: project.id, photoId: hero.id, variation: 2, now: T0 + 1000 });

  const first = projects.claimNextRender({ now: T0 + MINUTE });
  const second = projects.claimNextRender({ now: T0 + MINUTE });
  const third = projects.claimNextRender({ now: T0 + MINUTE });

  assert.deepEqual([first.id, second.id].sort(), [a.id, b.id].sort(), 'each queued render exactly once');
  assert.notEqual(first.id, second.id, 'never the same row twice');
  assert.equal(first.id, a.id, 'FIFO: the older one went first');
  assert.equal(third, null, 'and the queue is empty afterwards');
  assert.equal(projects.progressFor(project.id).running, 2);
});

test('a render whose photo row is gone is inert rather than claimable', () => {
  // The claim JOINs project_photos, which is what a database with no foreign keys needs: an
  // orphan must not be dequeued into a crash.
  const { dir, projects, project, hero } = roomFixture();
  const render = projects.enqueueRender({ projectId: project.id, photoId: hero.id, now: T0 });
  getDb(dir).prepare('DELETE FROM project_photos WHERE id = ?').run(hero.id);

  assert.equal(projects.claimNextRender({ now: T0 + MINUTE }), null);
  assert.equal(projects.getRender(render.id).status, 'queued');
});

test('claiming from an empty queue is null, not an error', () => {
  const { projects } = roomFixture();
  assert.equal(projects.claimNextRender(), null);
  assert.equal(projects.claimNextRender({ now: T0, leaseMs: DEFAULT_LEASE_MS }), null);
});

test('attachBibleToQueuedRenders only touches queued renders of that room', () => {
  const { projects, project, hero, support } = roomFixture();
  const otherRoom = addPhoto(projects, project.id, { roomKey: 'kitchen-1' });
  const queued = projects.enqueueRender({ projectId: project.id, photoId: support.id, now: T0 });
  const elsewhere = projects.enqueueRender({ projectId: project.id, photoId: otherRoom.id, now: T0 });
  const running = projects.enqueueRender({ projectId: project.id, photoId: hero.id, now: T0 });
  projects.claimNextRender({ now: T0 }); // takes the hero render — work already in flight
  const bible = projects.createBible({ projectId: project.id, roomKey: 'living-1', doc: DOC, roomType: 'r', furnitureStyle: 'f', now: T0 });

  assert.equal(projects.attachBibleToQueuedRenders(project.id, 'living-1', bible.id), 1);
  assert.equal(projects.getRender(queued.id).bibleId, bible.id);
  assert.equal(projects.getRender(elsewhere.id).bibleId, null, 'another room is not affected');
  assert.equal(projects.getRender(running.id).bibleId, null, 'work already running is not re-pointed');
  assert.equal(projects.attachBibleToQueuedRenders(project.id, 'no-such-room', bible.id), 0);
});

test('a newer bible re-points the renders that have not started yet', () => {
  const { projects, project, support } = roomFixture();
  const render = projects.enqueueRender({ projectId: project.id, photoId: support.id, now: T0 });
  const args = { projectId: project.id, roomKey: 'living-1', doc: DOC, roomType: 'r', furnitureStyle: 'f', now: T0 };
  const v1 = projects.createBible(args);
  projects.attachBibleToQueuedRenders(project.id, 'living-1', v1.id);
  const v2 = projects.createBible(args);

  assert.equal(projects.attachBibleToQueuedRenders(project.id, 'living-1', v2.id), 1);
  assert.equal(projects.getRender(render.id).bibleId, v2.id, 'queued work follows the newest bible');
});

test('completeRender records the outcome and clears the lease', () => {
  const { projects, project, hero } = roomFixture();
  projects.enqueueRender({ projectId: project.id, photoId: hero.id, now: T0 });
  const claimed = projects.claimNextRender({ now: T0 });
  const key = `projects/${project.id}/out/${newId()}.webp`;

  const done = projects.completeRender(claimed.id, {
    storageKey: key, promptText: 'a modern living room', model: 'gemini-2.5-flash-image',
    genAttempts: 2, qualityScore: 91, consistencyScore: 88, durationMs: 12345, now: T0 + MINUTE,
  });
  assert.equal(done.status, 'ok');
  assert.equal(done.storageKey, key);
  assert.equal(done.promptText, 'a modern living room');
  assert.equal(done.model, 'gemini-2.5-flash-image');
  assert.equal(done.genAttempts, 2);
  assert.equal(done.qualityScore, 91);
  assert.equal(done.consistencyScore, 88);
  assert.equal(done.durationMs, 12345);
  assert.equal(done.errorCode, null);
  assert.equal(done.claimedAt, null, 'the lease is released');
  assert.equal(projects.getProject(project.id).updatedAt, T0 + MINUTE);
  assert.equal(projects.completeRender('ghost', { storageKey: key }), null);
});

test('completeRender leaves gen_attempts alone when the caller does not say', () => {
  const { projects, project, hero } = roomFixture();
  const render = projects.enqueueRender({ projectId: project.id, photoId: hero.id, now: T0 });
  projects.failRender(render.id, { errorCode: 'TRANSIENT', now: T0 });
  assert.equal(projects.getRender(render.id).genAttempts, 1);
  assert.equal(projects.completeRender(render.id, { storageKey: 'k', now: T0 }).genAttempts, 1, 'not reset to 0');
});

test('failRender counts the attempt and keeps the reason', () => {
  const { projects, project, hero } = roomFixture();
  projects.enqueueRender({ projectId: project.id, photoId: hero.id, now: T0 });
  const claimed = projects.claimNextRender({ now: T0 });

  const failed = projects.failRender(claimed.id, { errorCode: 'GEMINI_REFUSED', durationMs: 900, now: T0 + MINUTE });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'GEMINI_REFUSED');
  assert.equal(failed.durationMs, 900);
  assert.equal(failed.claimedAt, null);
  assert.equal(failed.genAttempts, 1, 'the attempt count is the database’s business, not the caller’s');
  assert.equal(projects.failRender(claimed.id, { errorCode: 'AGAIN' }).genAttempts, 2, 'and it accumulates');
  assert.equal(projects.failRender('ghost', { errorCode: 'x' }), null);
});

test('releaseRender puts a claimed render back, and refuses anything else', () => {
  const { projects, project, hero } = roomFixture();
  const render = projects.enqueueRender({ projectId: project.id, photoId: hero.id, now: T0 });
  projects.claimNextRender({ now: T0 });

  const released = projects.releaseRender(render.id, { now: T0 + MINUTE });
  assert.equal(released.status, 'queued');
  assert.equal(released.claimedAt, null);
  assert.equal(projects.claimNextRender({ now: T0 + 2 * MINUTE }).id, render.id, 'and it is claimable again');

  projects.completeRender(render.id, { storageKey: 'k', now: T0 });
  assert.equal(projects.releaseRender(render.id, { now: T0 }), null, 'a finished render cannot be resurrected');
  assert.equal(projects.releaseRender('ghost'), null);
});

test('reclaimStaleClaims requeues an abandoned lease and leaves a live one running', () => {
  const { projects, project, hero } = roomFixture();
  const stale = projects.enqueueRender({ projectId: project.id, photoId: hero.id, now: T0 });
  const fresh = projects.enqueueRender({ projectId: project.id, photoId: hero.id, variation: 2, now: T0 + 1000 });
  projects.claimNextRender({ now: T0 });                 // stale: claimed long ago
  projects.claimNextRender({ now: T0 + 9 * MINUTE });     // fresh: claimed recently

  const now = T0 + 11 * MINUTE; // stale is 11 minutes old, fresh is 2 — the lease is 10
  assert.equal(projects.reclaimStaleClaims({ now, leaseMs: DEFAULT_LEASE_MS }), 1);
  assert.equal(projects.getRender(stale.id).status, 'queued');
  assert.equal(projects.getRender(stale.id).claimedAt, null);
  assert.equal(projects.getRender(fresh.id).status, 'running', 'a slow render is not stolen mid-flight');
  assert.equal(projects.reclaimStaleClaims({ now, leaseMs: DEFAULT_LEASE_MS }), 0, 'nothing left to reclaim');
});

test('reclaimStaleClaims defaults its lease, and rescues a running row with no claim stamp', () => {
  // status='running' with claimed_at NULL is unreachable through this module, so if it exists
  // something wrote the table by hand — and without this it would be stuck running forever.
  const { dir, projects, project, hero } = roomFixture();
  const render = projects.enqueueRender({ projectId: project.id, photoId: hero.id, now: T0 });
  getDb(dir).prepare("UPDATE renders SET status = 'running', claimed_at = NULL WHERE id = ?").run(render.id);

  assert.equal(projects.reclaimStaleClaims(), 1, 'called with no options at all');
  assert.equal(projects.getRender(render.id).status, 'queued');
});

test('claimNextRender with a lease reclaims a crashed worker’s row for itself', () => {
  const { projects, project, hero } = roomFixture();
  const render = projects.enqueueRender({ projectId: project.id, photoId: hero.id, now: T0 });
  projects.claimNextRender({ now: T0 });
  assert.equal(projects.claimNextRender({ now: T0 + MINUTE, leaseMs: DEFAULT_LEASE_MS }), null, 'the lease is still good');

  const reclaimed = projects.claimNextRender({ now: T0 + 11 * MINUTE, leaseMs: DEFAULT_LEASE_MS });
  assert.equal(reclaimed.id, render.id, 'the abandoned row came back to this very call');
  assert.equal(reclaimed.status, 'running');
  assert.equal(reclaimed.claimedAt, T0 + 11 * MINUTE);
});

test('supersedeRendersForRoom retires only the finished renders of that room', () => {
  const { projects, project, hero, support } = roomFixture();
  const kitchen = addPhoto(projects, project.id, { roomKey: 'kitchen-1', frameRole: 'hero' });
  const ok = projects.enqueueRender({ projectId: project.id, photoId: hero.id, now: T0 });
  const queued = projects.enqueueRender({ projectId: project.id, photoId: support.id, now: T0 });
  const failed = projects.enqueueRender({ projectId: project.id, photoId: hero.id, variation: 2, now: T0 });
  const elsewhere = projects.enqueueRender({ projectId: project.id, photoId: kitchen.id, now: T0 });
  projects.completeRender(ok.id, { storageKey: 'k1', now: T0 });
  projects.failRender(failed.id, { errorCode: 'X', now: T0 });
  projects.completeRender(elsewhere.id, { storageKey: 'k2', now: T0 });

  assert.equal(projects.supersedeRendersForRoom(project.id, 'living-1', { now: T0 + MINUTE }), 1);
  assert.equal(projects.getRender(ok.id).status, 'superseded');
  assert.equal(projects.getRender(queued.id).status, 'queued', 'pending work is left to run');
  assert.equal(projects.getRender(failed.id).status, 'failed', 'a failure is not rewritten as superseded');
  assert.equal(projects.getRender(elsewhere.id).status, 'ok', 'another room keeps its render');
  assert.equal(projects.supersedeRendersForRoom(project.id, 'living-1', { now: T0 + MINUTE }), 0, 'idempotent');
  assert.equal(projects.supersedeRendersForRoom(project.id, null), 0, 'and an unused room key matches nothing');
});

test('listRenders and rendersForPhoto order for their two different readers', () => {
  const { projects, project, hero, support } = roomFixture();
  const first = projects.enqueueRender({ projectId: project.id, photoId: hero.id, now: T0 });
  const second = projects.enqueueRender({ projectId: project.id, photoId: hero.id, variation: 2, now: T0 + 1000 });
  const other = projects.enqueueRender({ projectId: project.id, photoId: support.id, now: T0 + 2000 });

  assert.deepEqual(projects.listRenders(project.id).map((r) => r.id), [other.id, second.id, first.id], 'newest first for the activity feed');
  assert.deepEqual(projects.rendersForPhoto(hero.id).map((r) => r.variation), [1, 2], 'by variation for the compare view');
  assert.deepEqual(projects.rendersForPhoto('ghost'), []);
  assert.deepEqual(projects.listRenders('ghost'), []);
});

test('progressFor adds up to the total, and is all zeroes for a listing with no work', () => {
  const { projects, project, hero, support } = roomFixture();
  assert.deepEqual(projects.progressFor(project.id), { queued: 0, running: 0, ok: 0, failed: 0, superseded: 0, total: 0, blocked: 0 });

  const ids = [];
  for (let i = 0; i < 6; i += 1) ids.push(projects.enqueueRender({ projectId: project.id, photoId: hero.id, variation: i + 1, now: T0 + i }).id);
  projects.enqueueRender({ projectId: project.id, photoId: support.id, now: T0 + 10 }); // stays queued (barred)
  projects.completeRender(ids[0], { storageKey: 'k', now: T0 });
  projects.completeRender(ids[1], { storageKey: 'k', now: T0 });
  projects.failRender(ids[2], { errorCode: 'X', now: T0 });
  projects.claimNextRender({ now: T0 });
  projects.setHero(project.id, 'living-1', hero.id);
  projects.supersedeRendersForRoom(project.id, 'living-1', { now: T0 });

  const progress = projects.progressFor(project.id);
  assert.equal(progress.total, 7);
  assert.equal(progress.queued + progress.running + progress.ok + progress.failed + progress.superseded, progress.total,
    `the buckets must partition the total: ${JSON.stringify(progress)}`);
  assert.equal(progress.superseded, 2, 'both completed renders were retired');
  assert.equal(progress.failed, 1);
  assert.equal(progress.running, 1);
  assert.deepEqual(projects.progressFor('ghost'), { queued: 0, running: 0, ok: 0, failed: 0, superseded: 0, total: 0, blocked: 0 });
});

test('progressFor reports the barred subset of queued as `blocked`', () => {
  // The distinction the UI depends on: `queued` alone cannot tell "a worker is about to
  // pick this up" from "nothing will ever pick this up". Without it a room whose bible
  // extraction failed left the listing looking busy forever.
  const { projects, project, hero, support } = roomFixture();
  const heroRender = projects.enqueueRender({ projectId: project.id, photoId: hero.id, now: T0 });
  projects.enqueueRender({ projectId: project.id, photoId: support.id, now: T0 + 1 });

  let progress = projects.progressFor(project.id);
  assert.equal(progress.queued, 2);
  assert.equal(progress.blocked, 1, 'the support frame is barred until a bible exists');
  assert.equal(progress.queued - progress.blocked, 1, 'only the hero is claimable');
  assert.equal(projects.hasPendingWork(project.id), true);

  // Attaching a bible releases the bar, so nothing is blocked any more.
  projects.completeRender(heroRender.id, { storageKey: 'k', now: T0 });
  const bible = projects.createBible({
    projectId: project.id, roomKey: 'living-1', heroRenderId: heroRender.id,
    roomType: 'Living room', furnitureStyle: 'standard', doc: { pieces: [] }, now: T0,
  });
  projects.attachBibleToQueuedRenders(project.id, 'living-1', bible.id);
  progress = projects.progressFor(project.id);
  assert.equal(progress.blocked, 0, 'the bible unblocked it');
  assert.equal(projects.hasPendingWork(project.id), true);

  // Draining the queue leaves no pending work — which is what lets the worker finally
  // move the project off 'staging'.
  const claimed = projects.claimNextRender({ now: T0 });
  projects.completeRender(claimed.id, { storageKey: 'k2', now: T0 });
  assert.equal(projects.hasPendingWork(project.id), false);
  assert.equal(projects.progressFor(project.id).blocked, 0);
});

test('render extra_json degrades to null when it cannot be parsed', () => {
  const { dir, projects, project, hero } = roomFixture();
  const render = projects.enqueueRender({ projectId: project.id, photoId: hero.id, now: T0 });
  assert.equal(projects.getRender(render.id).extra, null, 'absent reads as null');
  getDb(dir).prepare('UPDATE renders SET extra_json = ? WHERE id = ?').run('{nope', render.id);
  assert.equal(projects.getRender(render.id).extra, null);
  getDb(dir).prepare('UPDATE renders SET extra_json = ? WHERE id = ?').run('{"tries":3}', render.id);
  assert.deepEqual(projects.getRender(render.id).extra, { tries: 3 });
});

// ---- Explicit cascades -----------------------------------------------------

/** A listing with photos, bibles and renders in every state — what a cascade has to clear. */
function populated(projects, userId, now = T0) {
  const project = projects.createProject({ userId, title: 'Full', now });
  const hero = addPhoto(projects, project.id, { roomKey: 'living-1', frameRole: 'hero', now });
  const support = addPhoto(projects, project.id, { roomKey: 'living-1', now });
  const bible = projects.createBible({ projectId: project.id, roomKey: 'living-1', doc: DOC, roomType: 'r', furnitureStyle: 'f', now });
  projects.createBible({ projectId: project.id, roomKey: 'kitchen-1', doc: DOC, roomType: 'r', furnitureStyle: 'f', now });
  projects.enqueueRender({ projectId: project.id, photoId: hero.id, now });
  projects.enqueueRender({ projectId: project.id, photoId: support.id, bibleId: bible.id, now });
  projects.enqueueRender({ projectId: project.id, photoId: hero.id, variation: 2, now });
  return { project, hero, support, bible };
}

test('deleteProject clears every child row in one transaction and reports the counts', () => {
  const { projects } = store();
  const { project } = populated(projects, USER);
  const survivor = populated(projects, USER);
  assert.deepEqual(projects.countAll(), { projects: 2, photos: 4, bibles: 4, renders: 6, shares: 0, feedback: 0 });

  assert.deepEqual(projects.deleteProject(project.id), { photos: 2, renders: 3, bibles: 2, shares: 0, feedback: 0 });
  assert.deepEqual(projects.countAll(), { projects: 1, photos: 2, bibles: 2, renders: 3, shares: 0, feedback: 0 }, 'no orphan rows anywhere');
  assert.equal(projects.getProject(project.id), null);
  assert.deepEqual(projects.listPhotos(project.id), []);
  assert.deepEqual(projects.listBibles(project.id), []);
  assert.deepEqual(projects.listRenders(project.id), []);
  assert.equal(projects.listPhotos(survivor.project.id).length, 2, 'the other listing is intact');
});

test('deleting a listing that does not exist is a clean zero', () => {
  const { projects } = store();
  assert.deepEqual(projects.deleteProject('ghost'), { photos: 0, renders: 0, bibles: 0, shares: 0, feedback: 0 });
});

test('deleteProjectsForUser erases that user’s listings and nobody else’s', () => {
  // The hook account erasure needs: without it, deleting a `users` row would leave the
  // photographs of their listings behind with nothing left pointing at them.
  const { projects } = store();
  populated(projects, USER);
  populated(projects, USER, T0 + MINUTE);
  const theirs = populated(projects, 'other-user');

  assert.deepEqual(projects.deleteProjectsForUser(USER), { projects: 2, photos: 4, renders: 6, bibles: 4, shares: 0, feedback: 0 });
  assert.deepEqual(projects.listProjects(USER), []);
  assert.deepEqual(projects.countAll(), { projects: 1, photos: 2, bibles: 2, renders: 3, shares: 0, feedback: 0 }, 'only the other user is left');
  assert.equal(projects.getProject(theirs.project.id).userId, 'other-user');
  assert.deepEqual(projects.deleteProjectsForUser('nobody'), { projects: 0, photos: 0, renders: 0, bibles: 0, shares: 0, feedback: 0 });
});

// ---- Durability ------------------------------------------------------------

test('everything survives reopening the same data dir', () => {
  const { dir, projects } = store();
  const { project, hero, bible } = populated(projects, USER);
  projects.updateProject(project.id, { status: 'staging', now: T0 });

  const reopened = createProjects(dir);
  assert.equal(reopened.getProject(project.id).status, 'staging');
  assert.equal(reopened.getPhoto(hero.id).frameRole, 'hero');
  assert.deepEqual(reopened.getBible(bible.id).doc.pieces, DOC.pieces);
  assert.deepEqual(reopened.countAll(), { projects: 1, photos: 2, bibles: 2, renders: 3, shares: 0, feedback: 0 });
  assert.equal(reopened.progressFor(project.id).queued, 3);
});
