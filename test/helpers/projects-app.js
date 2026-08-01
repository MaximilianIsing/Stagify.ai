// Mounts the real listing-staging router (routes/projects.js) on a bare Express app with
// fully faked dependencies, then listens on an ephemeral port. Mirrors
// test/helpers/staging-app.js (mountStaging): it exercises the ACTUAL handlers — the
// in-handler auth gate, the ownership re-keying, input clamping, the 409 pre-conditions,
// blob-vs-row ordering, and the byte-serve route's headers — with the store, the blob
// storage, and every vision call swapped for deterministic in-process fakes. No full
// server boot, no SQLite file, no network.
//
// The store is an IN-MEMORY fake rather than a real better-sqlite3 database on purpose:
// the router's contract with the store is "call these methods, in this order, with these
// arguments", and a fake is the only way to assert the order (see `calls`) and to inject
// a failure at one method. lib/data/projects.js has its own tests for the SQL.
//
// The upload route runs REAL multer, so tests post a genuine FormData body and the
// handler sees genuine req.files Buffers (a pass-through stub would leave req.files
// undefined and the handler would 400 out before reaching anything worth testing).
//
// THE FAKE IMPLEMENTS THE CLAIM BARRIER, NOT JUST THE METHOD NAMES
// `claimNextRender` here reproduces CLAIMABLE_WHERE and the FIFO order from
// lib/data/project-renders.js: a queued render is claimable only when its PHOTO row is
// the hero or a bible is attached, ordered by created_at then insertion. That is what
// makes the router's enqueue contract testable at all — "/stage answered 200" says
// nothing, because the bug it hid was a queue in which NOTHING was ever claimable. A test
// that only reads the HTTP status cannot see that; one that drains the queue can.

import express from 'express';
import multer from 'multer';
import createProjectsRouter from '../../routes/projects.js';

const pass = (req, res, next) => next();

/** A 1x1 PNG — enough for sharp to report real dimensions. */
export const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

/** A WebP data URL body the fake staging pipeline hands back. */
export const WEBP_BYTES = Buffer.from('webp-render-bytes');

let idCounter = 0;
const newId = (prefix) => `${prefix}_${(idCounter += 1)}`;

/**
 * An in-memory stand-in for lib/data/projects.js. Only the methods routes/projects.js
 * calls are implemented, with the same return shapes (including the `{ ok: false }`
 * unions), so the router's narrowing is genuinely exercised.
 * @param {string[]} calls - Ordered log of `store.<method>` names, for ordering assertions.
 * @returns {any} The fake store, plus a `db` handle for seeding and inspection.
 */
export function createFakeProjects(calls = []) {
  /** @type {any[]} */ const projectRows = [];
  /** @type {any[]} */ const photoRows = [];
  /** @type {any[]} */ const renderRows = [];
  /** @type {any[]} */ const bibleRows = [];
  const log = (name) => calls.push(`projects.${name}`);

  const store = {
    db: { projects: projectRows, photos: photoRows, renders: renderRows, bibles: bibleRows },

    createProject({ userId, title = '', address = '', now = Date.now() } = {}) {
      log('createProject');
      const row = { id: newId('p'), userId, title, address, status: 'draft', createdAt: now, updatedAt: now, extra: null };
      projectRows.unshift(row);
      return row;
    },
    getProject(id) {
      return projectRows.find((p) => p.id === String(id)) || null;
    },
    listProjects(userId, { limit = 50, offset = 0 } = {}) {
      log('listProjects');
      return projectRows.filter((p) => p.userId === userId).slice(offset, offset + limit);
    },
    updateProject(id, patch = {}) {
      log('updateProject');
      const row = store.getProject(id);
      if (!row) return null;
      if (patch.title !== undefined) row.title = patch.title;
      if (patch.address !== undefined) row.address = patch.address;
      if (patch.status !== undefined) row.status = patch.status;
      if (patch.extraJson !== undefined) row.extra = JSON.parse(patch.extraJson);
      row.updatedAt = Date.now();
      return row;
    },
    deleteProject(id) {
      log('deleteProject');
      const before = { photos: photoRows.length, renders: renderRows.length, bibles: bibleRows.length };
      for (const list of [photoRows, renderRows, bibleRows]) {
        for (let i = list.length - 1; i >= 0; i -= 1) if (list[i].projectId === id) list.splice(i, 1);
      }
      const idx = projectRows.findIndex((p) => p.id === id);
      if (idx >= 0) projectRows.splice(idx, 1);
      return {
        photos: before.photos - photoRows.length,
        renders: before.renders - renderRows.length,
        bibles: before.bibles - bibleRows.length,
      };
    },

    addPhoto(arg = {}) {
      log('addPhoto');
      if (!store.getProject(arg.projectId)) return { ok: false, code: 'PROJECT_NOT_FOUND', error: 'gone' };
      const dup = photoRows.find((p) => p.projectId === arg.projectId && p.sha256 === arg.sha256);
      if (dup) return { ok: true, photo: dup, duplicate: true };
      const row = {
        id: newId('ph'),
        projectId: arg.projectId,
        storageKey: arg.storageKey,
        seq: arg.seq ?? photoRows.length,
        roomKey: arg.roomKey ?? null,
        roomType: arg.roomType ?? null,
        frameRole: 'support',
        width: arg.width ?? null,
        height: arg.height ?? null,
        arLabel: arg.arLabel ?? null,
        stageable: null,
        unstageableCode: null,
        sha256: arg.sha256,
        createdAt: arg.now ?? Date.now(),
      };
      photoRows.push(row);
      return { ok: true, photo: row, duplicate: false };
    },
    getPhoto(id) {
      return photoRows.find((p) => p.id === String(id)) || null;
    },
    listPhotos(projectId) {
      return photoRows.filter((p) => p.projectId === projectId);
    },
    updatePhoto(id, patch = {}) {
      log('updatePhoto');
      const row = store.getPhoto(id);
      if (!row) return null;
      for (const key of ['roomKey', 'roomType', 'frameRole', 'stageable', 'unstageableCode', 'seq']) {
        if (patch[key] !== undefined) row[key] = patch[key];
      }
      return row;
    },
    deletePhoto(id) {
      log('deletePhoto');
      const row = store.getPhoto(id);
      if (!row) return { ok: false, code: 'NOT_FOUND', error: 'gone' };
      const keys = [row.storageKey];
      for (let i = renderRows.length - 1; i >= 0; i -= 1) {
        if (renderRows[i].photoId !== row.id) continue;
        if (renderRows[i].storageKey) keys.push(renderRows[i].storageKey);
        renderRows.splice(i, 1);
      }
      photoRows.splice(photoRows.indexOf(row), 1);
      return { ok: true, photoId: row.id, renders: keys.length - 1, storageKeys: keys };
    },
    setHero(projectId, roomKey, photoId) {
      log('setHero');
      const row = store.getPhoto(photoId);
      if (!row) return { ok: false, code: 'NOT_FOUND', error: 'gone' };
      if (row.projectId !== projectId) return { ok: false, code: 'WRONG_PROJECT', error: 'nope' };
      let demoted = 0;
      for (const p of photoRows) {
        if (p.projectId === projectId && p.roomKey === roomKey && p.id !== row.id && p.frameRole === 'hero') {
          p.frameRole = 'support';
          demoted += 1;
        }
      }
      row.roomKey = roomKey;
      row.frameRole = 'hero';
      return { ok: true, photo: row, demoted };
    },

    createBible(arg = {}) {
      log('createBible');
      const row = { id: newId('b'), projectId: arg.projectId, roomKey: arg.roomKey, version: bibleRows.length + 1, heroRenderId: arg.heroRenderId ?? null, doc: arg.doc ?? null, roomType: arg.roomType ?? '', furnitureStyle: arg.furnitureStyle ?? '', createdAt: arg.now ?? Date.now() };
      bibleRows.push(row);
      return row;
    },
    getBible(id) {
      return bibleRows.find((b) => b.id === String(id)) || null;
    },
    latestBible(projectId, roomKey) {
      const matches = bibleRows.filter((b) => b.projectId === projectId && b.roomKey === String(roomKey ?? ''));
      return matches.length ? matches[matches.length - 1] : null;
    },
    listBibles(projectId) {
      return bibleRows.filter((b) => b.projectId === projectId);
    },

    enqueueRender(arg = {}) {
      log('enqueueRender');
      const row = { id: newId('r'), projectId: arg.projectId, photoId: arg.photoId, bibleId: arg.bibleId ?? null, variation: arg.variation ?? 1, storageKey: null, status: 'queued', promptText: null, model: null, genAttempts: 0, qualityScore: null, consistencyScore: null, errorCode: null, durationMs: null, claimedAt: null, createdAt: arg.now ?? Date.now(), extra: null };
      renderRows.push(row);
      return row;
    },
    getRender(id) {
      return renderRows.find((r) => r.id === String(id)) || null;
    },
    listRenders(projectId) {
      return renderRows.filter((r) => r.projectId === projectId);
    },
    /**
     * The real claim barrier, not an approximation of it — see the header. A queued row is
     * eligible only when its photo row exists (the JOIN) and is either the room's hero or
     * has a bible attached; the winner is the oldest by created_at, ties broken by
     * insertion order (the real query's `rowid`).
     */
    claimNextRender({ now = Date.now() } = {}) {
      log('claimNextRender');
      const eligible = renderRows
        .map((r, index) => ({ r, index }))
        .filter(({ r }) => {
          if (r.status !== 'queued') return false;
          const photo = store.getPhoto(r.photoId);
          if (!photo) return false;
          return photo.frameRole === 'hero' || r.bibleId !== null;
        })
        .sort((a, b) => (a.r.createdAt - b.r.createdAt) || (a.index - b.index));
      if (!eligible.length) return null;
      const row = eligible[0].r;
      row.status = 'running';
      row.claimedAt = now;
      return row;
    },
    failRender(id, arg = {}) {
      log('failRender');
      const row = store.getRender(id);
      if (!row) return null;
      row.status = 'failed';
      row.errorCode = arg.errorCode ?? null;
      row.durationMs = arg.durationMs ?? null;
      row.genAttempts += 1;
      row.claimedAt = null;
      return row;
    },
    completeRender(id, arg = {}) {
      log('completeRender');
      const row = store.getRender(id);
      if (!row) return null;
      row.status = 'ok';
      row.storageKey = arg.storageKey ?? null;
      row.claimedAt = null;
      return row;
    },
    supersedeRendersForRoom(projectId, roomKey) {
      log('supersedeRendersForRoom');
      let n = 0;
      for (const r of renderRows) {
        const photo = store.getPhoto(r.photoId);
        if (r.projectId === projectId && photo?.roomKey === roomKey && r.status === 'ok') {
          r.status = 'superseded';
          n += 1;
        }
      }
      return n;
    },
    attachBibleToQueuedRenders(projectId, roomKey, bibleId) {
      log('attachBibleToQueuedRenders');
      let n = 0;
      for (const r of renderRows) {
        const photo = store.getPhoto(r.photoId);
        if (r.projectId === projectId && r.status === 'queued' && photo?.roomKey === roomKey) {
          r.bibleId = bibleId;
          n += 1;
        }
      }
      return n;
    },
    progressFor(projectId) {
      const rows = store.listRenders(projectId);
      const count = (s) => rows.filter((r) => r.status === s).length;
      // `blocked` is derived exactly as the real store derives it: queued minus claimable,
      // so a test can tell "waiting its turn" from "waiting for something that will never
      // arrive".
      const claimable = rows.filter((r) => {
        if (r.status !== 'queued') return false;
        const photo = store.getPhoto(r.photoId);
        return !!photo && (photo.frameRole === 'hero' || r.bibleId !== null);
      }).length;
      return {
        queued: count('queued'), running: count('running'), ok: count('ok'),
        failed: count('failed'), superseded: count('superseded'), total: rows.length,
        blocked: Math.max(0, count('queued') - claimable),
      };
    },
  };
  return store;
}

/**
 * An in-memory stand-in for lib/data/project-storage.js. `read` REJECTS on a missing key,
 * exactly as the real one does (ENOENT), so the router's `.catch()` paths are real.
 * @param {string[]} calls - Ordered log of `storage.<method>` names.
 * @returns {any} The fake storage, plus a `blobs` Map for seeding and inspection.
 */
export function createFakeStorage(calls = []) {
  /** @type {Map<string, Buffer>} */
  const blobs = new Map();
  const log = (name) => calls.push(`storage.${name}`);
  return {
    blobs,
    projectsRoot: () => '/fake/projects',
    keyFor: ({ projectId, kind, id, ext }) => `projects/${projectId}/${kind}/${id}.${ext}`,
    absolutePathFor: (key) => `/fake/${key}`,
    async write(key, buf) {
      log('write');
      blobs.set(key, Buffer.from(buf));
      return { key, bytes: buf.length };
    },
    async read(key) {
      const buf = blobs.get(key);
      if (!buf) {
        const err = /** @type {any} */ (new Error(`ENOENT: ${key}`));
        err.code = 'ENOENT';
        throw err;
      }
      return buf;
    },
    async remove(key) {
      log('remove');
      return blobs.delete(key);
    },
    async removeProject(projectId) {
      log('removeProject');
      for (const key of [...blobs.keys()]) if (key.startsWith(`projects/${projectId}/`)) blobs.delete(key);
      return true;
    },
    async stat(key) {
      const buf = blobs.get(key);
      return buf ? { bytes: buf.length, mtimeMs: 0 } : null;
    },
  };
}

/**
 * Defaults every dep the router destructures so construction succeeds. Middleware deps
 * (used at route-definition time) must be real functions; everything else is a harmless
 * fake an individual test overrides.
 * @param {{ projects: any, storage: any }} wired - The store/storage instances to inject.
 * @returns {any} The dep bag.
 */
export function baseDeps({ projects, storage }) {
  return {
    projects,
    storage,
    // Labels every photo as the same living room, so assignRoomKeys yields one room.
    roomClustering: { labelPhoto: async () => ({ roomType: 'Living room', roomLabel: 'main', isWide: true, confidence: 0.9 }) },
    assignRoomKeys: (labels) => new Map(labels.map((l) => [l.photoId, l.roomType ? 'living-room-1' : null])),
    // Mirrors the CONTRACT of the real pickHero (lib/staging/room-clustering.js) rather
    // than its aspect-ratio scoring: an existing hero wins, excluded and upload-gate
    // rejected frames are never chosen, and a room with no eligible frame answers null.
    // Deterministic (first eligible) so ordering assertions do not depend on the scorer.
    pickHero: (photos) => {
      const existing = photos.find((p) => p.frameRole === 'hero');
      if (existing) return existing.id;
      const eligible = photos.find((p) => p.frameRole !== 'excluded' && p.stageable !== false);
      return eligible ? eligible.id : null;
    },
    listingWorker: { stats: () => ({ ticks: 0, completed: 0, failed: 0, blockedByMissingBible: 0 }) },
    getAuthUserFromRequest: () => null,
    // Default: reject as unauthenticated. Tests that need to get past the gate override
    // this (mountProjects({ user })) — matching test/helpers/staging-app.js.
    requireProAccount: (req, res) => {
      res.status(401).json({ error: 'Sign in required', code: 'AUTH_REQUIRED' });
      return null;
    },
    validateStageableImage: async () => ({ valid: true, code: null, reason: '' }),
    setSensitiveHeaders: (res) => {
      res.set('Cache-Control', 'no-store');
      res.set('Referrer-Policy', 'no-referrer');
    },
    genLimiter: pass,
    DEBUG_MODE: false,
  };
}

/**
 * Mount the router with `overrides` merged over the fakes.
 * @param {{ user?: any } & Record<string, any>} [overrides] - `user` installs a
 *   requireProAccount that returns it (the authorized case); every other key overrides a
 *   dep directly.
 * @returns {Promise<{ baseUrl: string, projects: any, storage: any, calls: string[], deps: any, close: () => Promise<void> }>}
 */
export async function mountProjects(overrides = {}) {
  const { user, ...rest } = overrides;
  /** @type {string[]} */
  const calls = [];
  const projects = rest.projects || createFakeProjects(calls);
  const storage = rest.storage || createFakeStorage(calls);
  const deps = { ...baseDeps({ projects, storage }), ...rest };
  if (user) deps.requireProAccount = () => user;

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(createProjectsRouter(deps));
  // Mirrors server.js: multer's own errors become a clean 413/400 instead of a 500.
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: 'Upload error', code: err.code });
    }
    return next(err);
  });
  // Catch-all, as in server.js — without it Express renders a stack trace as HTML.
  app.use((err, req, res, _next) => {
    if (res.headersSent) return;
    res.status(500).json({ error: 'Server error', code: err?.code || 'ERROR' });
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = /** @type {any} */ (server.address());
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    projects,
    storage,
    calls,
    deps,
    close: () => new Promise((r) => server.close(() => r(undefined))),
  };
}

/**
 * Add `photoCount` photos of one room to an existing project, with their source blobs
 * present. Used on its own to build a MULTI-ROOM listing, which is the only shape in which
 * cross-room queue ordering can be observed.
 * @param {any} app - The object mountProjects resolved to.
 * @param {any} project - The project row to add to.
 * @param {{ photoCount?: number, roomKey?: string|null, roomType?: string|null,
 *   hero?: number|null, stageable?: boolean|null }} [opts] - `hero` is the index promoted
 *   to 'hero' (null leaves every frame 'support', i.e. the state an operator's "Move to a
 *   new room…" produces); `stageable` is written to every frame added here.
 * @returns {any[]} The photo rows, in order.
 */
export function seedRoom(app, project, {
  photoCount = 2, roomKey = 'living-room-1', roomType = null, hero = 0, stageable = true,
} = {}) {
  const photos = [];
  for (let i = 0; i < photoCount; i += 1) {
    // Numbered by position in the PROJECT, not in this call, so a second seedRoom for
    // another room does not collide on the dedup hash or the blob key.
    const idx = app.projects.listPhotos(project.id).length;
    const key = `projects/${project.id}/src/photo${idx}.png`;
    app.storage.blobs.set(key, PNG_1X1);
    const { photo } = app.projects.addPhoto({ projectId: project.id, storageKey: key, sha256: `sha${idx}`, seq: idx, width: 100, height: 60 });
    app.projects.updatePhoto(photo.id, {
      roomKey, roomType, stageable, frameRole: hero === i ? 'hero' : 'support',
    });
    photos.push(photo);
  }
  return photos;
}

/**
 * Seed one project owned by `userId`, with `photoCount` photos in one room and their
 * source blobs present.
 * @param {any} app - The object mountProjects resolved to.
 * @param {{ userId?: string, photoCount?: number, roomKey?: string|null, roomType?: string|null,
 *   hero?: number|null, stageable?: boolean|null, title?: string }} [opts] - Seed options; `hero`
 *   defaults to the first photo, matching what a successful upload produces.
 * @returns {any} `{ project, photos }`.
 */
export function seedProject(app, {
  userId = 'u_a', photoCount = 2, roomKey = 'living-room-1', roomType = null,
  hero = 0, stageable = true, title = 'Seed',
} = {}) {
  const project = app.projects.createProject({ userId, title, address: '1 Main St' });
  const photos = seedRoom(app, project, { photoCount, roomKey, roomType, hero, stageable });
  return { project, photos };
}

/**
 * Mark a render finished with bytes on disk — the only state the archive route serves.
 * @param {any} app - The object mountProjects resolved to.
 * @param {any} render - A render row from the fake store.
 * @param {Buffer} [bytes] - The stored blob (defaults to WEBP_BYTES).
 * @param {string} [ext] - Storage-key extension, so a PNG fallback can be exercised.
 * @returns {any} The render row.
 */
export function finishRender(app, render, bytes = WEBP_BYTES, ext = 'webp') {
  render.storageKey = `projects/${render.projectId}/out/${render.id}.${ext}`;
  render.status = 'ok';
  app.storage.blobs.set(render.storageKey, Buffer.from(bytes));
  return render;
}
