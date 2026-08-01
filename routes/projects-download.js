// The Listing Studio's render archive — `GET /api/projects/:id/renders.zip`.
//
// WHY THIS ROUTE HAS TO EXIST
// The studio shows every render as an authenticated `blob:` URL, and the byte route it
// fetches is session-gated (`getAuthUserFromRequest` never reads a query parameter, on
// purpose), so pasting an image URL into a tab 401s. That left right-click → "Save image
// as" — under a meaningless blob name — as the ONLY way to get output out of a feature
// whose entire product is bulk delivery of 30–90 staged photos. This is that way out.
//
// WHY THE ZIP IS HAND-ROLLED, AND WHY "STORE"
// The payload is already-compressed WebP/JPEG. Deflate cannot shrink it (a percent at
// best) and would cost CPU on every download, so the archive uses the STORE method — the
// bytes are copied through verbatim. That removes the only genuinely hard part of writing
// a zip: with no compression there is nothing to stream through a codec, each entry's
// compressed size EQUALS its uncompressed size, and both are known before the local
// header is written (we read one blob at a time, so the CRC and length are in hand). What
// is left is three fixed-layout records — local file header, central directory header,
// end-of-central-directory — which is why a 15-dependency repo does not gain a 16th here.
//
// Entry by entry, never buffered whole: one render's bytes are in memory at a time and
// `writeChunk` respects backpressure, so a 90-render listing streams in ~4 MB of RAM
// rather than several hundred.
//
// ZIP32 ONLY. No ZIP64 extra fields, so the archive is capped at 4 GiB and 65 535 entries
// (MAX_ZIP_ENTRIES). A listing is ~120 renders of a few MB, so the ceiling is theoretical
// — but it is ENFORCED rather than assumed, because silently emitting a corrupt archive
// past 4 GiB is far worse than truncating a listing nobody has.

import { sendError } from '../lib/http/http-helpers.js';
import { reportError } from '../lib/http/error-ref.js';
import { logger } from '../lib/logger.js';
import { buildDisclosureFile, DISCLOSURE_ENTRY_NAME } from '../lib/staging/staging-disclosure.js';
import { extensionOf, slugify } from './projects-shared.js';

/** @typedef {import('../lib/types/projects.js').Project} Project */
/** @typedef {import('../lib/types/projects.js').ProjectPhoto} ProjectPhoto */
/** @typedef {import('../lib/types/projects.js').Render} Render */
/** @typedef {ReturnType<typeof import('../lib/data/projects.js').createProjects>} ProjectsStore */
/** @typedef {ReturnType<typeof import('../lib/data/project-storage.js').createProjectStorage>} ProjectStorage */

/**
 * @typedef {Object} ZipEntry
 * @property {string} name Entry name inside the archive; already slugified and de-duplicated.
 * @property {string} storageKey Blob key to stream. Empty for a synthesized entry.
 * @property {number} modifiedAt Epoch ms, written as the entry's DOS timestamp.
 * @property {Buffer} [inline] Bytes built in-process rather than read from storage — the
 *   virtual-staging disclosure. Kept as a field on the entry (rather than a second entry
 *   list) so it flows through the SAME size accounting, CRC and 4 GiB ceiling as a blob.
 */

/**
 * @typedef {Object} CentralEntry
 * @property {string} name
 * @property {number} crc
 * @property {number} size
 * @property {number} time DOS time field.
 * @property {number} date DOS date field.
 * @property {number} offset Byte offset of this entry's local header.
 */

/** The end-of-central-directory record stores the entry count in 16 bits. */
export const MAX_ZIP_ENTRIES = 0xffff;
/** Local-header and central-directory offsets/sizes are 32-bit without ZIP64. */
const ZIP32_MAX_BYTES = 0xffffffff;

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** Zip 2.0 — the version that defines STORE and deflate; nothing newer is used. */
const ZIP_VERSION = 20;
/** General-purpose bit 11: entry names are UTF-8. Set even though `slugify` yields ASCII. */
const FLAG_UTF8 = 0x0800;
/** Compression method 0 = STORE. See the header for why. */
const METHOD_STORE = 0;

/** CRC-32 (IEEE 802.3) table, built once. The one piece of maths a zip needs. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * CRC-32 of a buffer, as an unsigned 32-bit integer.
 * @param {Buffer} buf - Bytes to checksum.
 * @returns {number} The CRC.
 */
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Split an epoch-ms timestamp into the two 16-bit MS-DOS fields a zip entry carries.
 * Clamped to the representable range (1980–2107): a row with a nonsense `created_at`
 * must produce a valid archive, not an unopenable one.
 * @param {unknown} epochMs - Render `createdAt`.
 * @returns {{ time: number, date: number }} The DOS time and date fields.
 */
export function dosDateTime(epochMs) {
  const ms = typeof epochMs === 'number' && Number.isFinite(epochMs) && epochMs > 0 ? epochMs : Date.now();
  const d = new Date(ms);
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  const date = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/**
 * The 30-byte local file header plus the entry name. Compressed size equals uncompressed
 * size because the method is STORE; both are known up front, so no data descriptor (and
 * therefore no streaming-flag bit 3) is needed.
 * @param {CentralEntry} entry - The entry being written.
 * @returns {Buffer} Header bytes.
 */
function localHeader(entry) {
  const name = Buffer.from(entry.name, 'utf8');
  const head = Buffer.alloc(30);
  head.writeUInt32LE(LOCAL_SIG, 0);
  head.writeUInt16LE(ZIP_VERSION, 4);
  head.writeUInt16LE(FLAG_UTF8, 6);
  head.writeUInt16LE(METHOD_STORE, 8);
  head.writeUInt16LE(entry.time, 10);
  head.writeUInt16LE(entry.date, 12);
  head.writeUInt32LE(entry.crc, 14);
  head.writeUInt32LE(entry.size, 18);
  head.writeUInt32LE(entry.size, 22);
  head.writeUInt16LE(name.length, 26);
  head.writeUInt16LE(0, 28);
  return Buffer.concat([head, name]);
}

/**
 * The 46-byte central-directory header plus the entry name. This is the record an
 * unpacker actually reads, which is why `offset` (where the local header sits) has to be
 * tracked as the stream is written.
 * @param {CentralEntry} entry - The entry being catalogued.
 * @returns {Buffer} Header bytes.
 */
function centralHeader(entry) {
  const name = Buffer.from(entry.name, 'utf8');
  const head = Buffer.alloc(46);
  head.writeUInt32LE(CENTRAL_SIG, 0);
  head.writeUInt16LE(ZIP_VERSION, 4);
  head.writeUInt16LE(ZIP_VERSION, 6);
  head.writeUInt16LE(FLAG_UTF8, 8);
  head.writeUInt16LE(METHOD_STORE, 10);
  head.writeUInt16LE(entry.time, 12);
  head.writeUInt16LE(entry.date, 14);
  head.writeUInt32LE(entry.crc, 16);
  head.writeUInt32LE(entry.size, 20);
  head.writeUInt32LE(entry.size, 24);
  head.writeUInt16LE(name.length, 28);
  head.writeUInt16LE(0, 30);
  head.writeUInt16LE(0, 32);
  head.writeUInt16LE(0, 34);
  head.writeUInt16LE(0, 36);
  head.writeUInt32LE(0, 38);
  head.writeUInt32LE(entry.offset, 42);
  return Buffer.concat([head, name]);
}

/**
 * The 22-byte end-of-central-directory record that closes the archive.
 * @param {number} count - Entries written.
 * @param {number} cdSize - Total central-directory bytes.
 * @param {number} cdOffset - Where the central directory starts.
 * @returns {Buffer} The EOCD record.
 */
function endOfCentralDirectory(count, cdSize, cdOffset) {
  const buf = Buffer.alloc(22);
  buf.writeUInt32LE(EOCD_SIG, 0);
  buf.writeUInt16LE(0, 4);
  buf.writeUInt16LE(0, 6);
  buf.writeUInt16LE(count, 8);
  buf.writeUInt16LE(count, 10);
  buf.writeUInt32LE(cdSize, 12);
  buf.writeUInt32LE(cdOffset, 16);
  buf.writeUInt16LE(0, 20);
  return buf;
}

/**
 * Write one chunk, waiting for 'drain' when the socket is full.
 *
 * Resolving on 'close'/'error' as well as 'drain' is load-bearing: a client that walks
 * away mid-download never drains, and awaiting only 'drain' would leave the handler (and
 * its file handles) parked forever.
 * @param {import('express').Response} res - The response stream.
 * @param {Buffer} chunk - Bytes to write.
 * @returns {Promise<void>} Resolves once the stream can take more.
 */
function writeChunk(res, chunk) {
  if (res.write(chunk)) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      res.off('error', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
    res.on('error', done);
  });
}

/**
 * Stream a STORE-method zip of `entries` to `res` and end the response.
 *
 * An entry whose bytes cannot be read is SKIPPED, not fatal: a row can outlive its blob
 * (the reverse ordering of DELETE is deliberate, see routes/projects.js), and aborting
 * would throw away 89 good renders over one missing file. The skip count comes back so
 * the operator log can say so.
 * @param {import('express').Response} res - The response stream (headers already sent).
 * @param {ZipEntry[]} entries - Entries in archive order.
 * @param {(entry: ZipEntry) => Promise<Buffer|null>} readBytes - Blob reader; resolves null when the blob is gone.
 * @returns {Promise<{ written: number, skipped: number }>} What actually made it in.
 */
export async function streamStoreZip(res, entries, readBytes) {
  /** @type {CentralEntry[]} */
  const central = [];
  let offset = 0;
  let skipped = 0;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (res.writableEnded || res.destroyed) break;
    const bytes = await readBytes(entry);
    if (!bytes || !bytes.length) {
      skipped += 1;
      continue;
    }
    const projected = offset + 30 + Buffer.byteLength(entry.name, 'utf8') + bytes.length;
    // Past 4 GiB the 32-bit offsets in the central directory would wrap and the archive
    // would be silently unopenable. Stop cleanly instead and close what we have.
    if (projected > ZIP32_MAX_BYTES) {
      skipped += entries.length - i;
      break;
    }
    const { time, date } = dosDateTime(entry.modifiedAt);
    /** @type {CentralEntry} */
    const record = { name: entry.name, crc: crc32(bytes), size: bytes.length, time, date, offset };
    const head = localHeader(record);
    await writeChunk(res, head);
    await writeChunk(res, bytes);
    offset += head.length + bytes.length;
    central.push(record);
  }

  const directory = Buffer.concat(central.map(centralHeader));
  await writeChunk(res, directory);
  await writeChunk(res, endOfCentralDirectory(central.length, directory.length, offset));
  res.end();
  return { written: central.length, skipped };
}

/**
 * The name one render takes inside the archive: `<room>-<photo seq>-v<variation>.<ext>`.
 *
 * The room comes from the operator/model-supplied label when there is one and the stable
 * room key otherwise, and BOTH go through `slugify` — the result is a filename, so an
 * unslugified label is a path-traversal vector in whatever unpacks the zip. `seq` is the
 * photo's position in the shoot, zero-padded so a file manager sorts the archive the way
 * the tray shows it.
 * @param {ProjectPhoto|undefined} photo - The source photo row.
 * @param {Render} render - The finished render.
 * @returns {string} The entry name.
 */
export function renderEntryName(photo, render) {
  const room = slugify(photo?.roomType || photo?.roomKey || '', 40) || 'room';
  const seq = typeof photo?.seq === 'number' && Number.isFinite(photo.seq)
    ? Math.min(99999, Math.max(0, Math.trunc(photo.seq)))
    : 0;
  const variation = typeof render.variation === 'number' && Number.isFinite(render.variation)
    ? Math.min(99, Math.max(1, Math.trunc(render.variation)))
    : 1;
  const ext = extensionOf(render.storageKey) || 'webp';
  return `${room}-${String(seq).padStart(2, '0')}-v${variation}.${ext}`;
}

/**
 * Make `name` unique within `used`, inserting `-2`, `-3`, … before the extension.
 *
 * Names collide in practice, not just in theory: two `ok` renders of the same (photo,
 * variation) exist in any listing staged before the double-enqueue fix, and a zip with
 * two identical entry names silently loses one of them in most unpackers.
 * @param {Set<string>} used - Names already taken; mutated.
 * @param {string} name - Preferred name.
 * @returns {string} A name not previously in `used`.
 */
export function uniqueEntryName(used, name) {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; n <= MAX_ZIP_ENTRIES; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  // Unreachable while the entry cap is MAX_ZIP_ENTRIES, but a duplicate name is worse
  // than an ugly one, so fall back to something that cannot already be present.
  const fallback = `${stem}-${used.size}${ext}`;
  used.add(fallback);
  return fallback;
}

/**
 * The downloaded file's name. Derived from the listing title so a folder of archives is
 * legible; slugified because it is interpolated into a `Content-Disposition` header.
 * @param {Project} project - The listing.
 * @returns {string} e.g. `12-oak-avenue-staged.zip`
 */
export function archiveFileName(project) {
  return `${slugify(project.title, 60) || 'listing'}-staged.zip`;
}

/**
 * @typedef {Object} ArchiveRouteContext
 * @property {import('express').Router} router The router the route is registered on.
 * @property {ProjectsStore} projects Project/photo/render store.
 * @property {ProjectStorage} storage Blob store the render bytes are read from.
 * @property {(req: import('express').Request, res: import('express').Response) => any} requireProAccount Responds 401/403 and returns null when the caller is not Stagify+.
 * @property {(context: string, fn: (req: import('express').Request, res: import('express').Response) => Promise<unknown>) => import('express').RequestHandler} guard Wraps a handler so an unexpected throw becomes a 500 carrying only a log reference.
 * @property {(res: import('express').Response) => import('express').Response} notFound The uniform 404.
 * @property {(req: import('express').Request, user: { id: string }) => Project|null} ownedProject Loads `:id` only when this session owns it.
 */

/**
 * Register `GET /api/projects/:id/renders.zip`.
 *
 * Same gate as every other byte route: `requireProAccount` INSIDE the handler, ownership
 * re-keyed on the validated session user's id, and a foreign or unknown listing answers
 * the identical 404 as a listing that does not exist.
 * @param {ArchiveRouteContext} ctx - Router, store, blob storage, auth gate and error helpers.
 * @returns {void}
 */
export function registerRenderArchiveRoute(ctx) {
  const { router, projects, storage, requireProAccount, guard, notFound, ownedProject } = ctx;

  router.get('/api/projects/:id/renders.zip', guard('projects.renders.zip', async (req, res) => {
    const user = requireProAccount(req, res);
    if (!user) return;
    const project = ownedProject(req, user);
    if (!project) return notFound(res);

    const photos = new Map(projects.listPhotos(project.id).map((p) => [p.id, p]));
    // 'ok' is exactly "finished and current": a retired render is 'superseded', which is a
    // different value of the same column, so there is no second condition to write.
    const finished = projects.listRenders(project.id)
      .filter((r) => r.status === 'ok' && r.storageKey && photos.has(r.photoId))
      .sort((a, b) => {
        const pa = photos.get(a.photoId);
        const pb = photos.get(b.photoId);
        return (pa?.roomKey || '').localeCompare(pb?.roomKey || '')
          || (pa?.seq ?? 0) - (pb?.seq ?? 0)
          || a.variation - b.variation
          || a.id.localeCompare(b.id);
      });

    /** @type {Set<string>} */
    const used = new Set();
    /** @type {ZipEntry[]} */
    const entries = [];
    for (const render of finished) {
      // -1 reserves the slot the disclosure entry is unshifted into below; without it a
      // maximal listing would push the count to 65 536 and wrap the EOCD's 16-bit field.
      if (entries.length >= MAX_ZIP_ENTRIES - 1) break;
      // stat BEFORE any header goes out, so "every blob is missing" is still an honest
      // 404 rather than a 200 carrying an empty archive. A file that disappears between
      // this stat and the read is skipped mid-stream instead (streamStoreZip).
      const info = await storage.stat(String(render.storageKey)).catch(() => null);
      if (!info || !info.bytes) continue;
      entries.push({
        name: uniqueEntryName(used, renderEntryName(photos.get(render.photoId), render)),
        storageKey: String(render.storageKey),
        modifiedAt: render.createdAt,
      });
    }

    // 404 rather than an empty-but-valid archive, deliberately. An empty zip downloads as
    // a file that looks like the feature worked, and the studio cannot tell it apart from
    // "still rendering" — so the operator would sit with 0 KB of photos and no error. A
    // status plus a code lets the UI say "nothing has finished yet".
    if (!entries.length) {
      return sendError(res, 404, 'This listing has no finished renders to download yet', { code: 'NO_RENDERS' });
    }

    // The disclosure rides along as the archive's FIRST entry, after the empty check so an
    // archive that would otherwise be a 404 does not become a 200 carrying nothing but a
    // legal notice. Unshifted rather than appended because unpackers list in archive order
    // and the point is that the broker sees it. See lib/staging/staging-disclosure.js for
    // why shipping it with the pixels is not optional.
    entries.unshift({
      name: uniqueEntryName(used, DISCLOSURE_ENTRY_NAME),
      storageKey: '',
      modifiedAt: Date.now(),
      inline: Buffer.from(buildDisclosureFile({ title: project.title, address: project.address }), 'utf8'),
    });

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${archiveFileName(project)}"`);
    // No Content-Length: the total is only known once every blob has been read, and
    // reading them twice to find out would double the I/O for no gain.
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Content-Type-Options', 'nosniff');

    try {
      const summary = await streamStoreZip(res, entries, (entry) => (
        entry.inline ? Promise.resolve(entry.inline) : storage.read(entry.storageKey).catch(() => null)
      ));
      if (summary.skipped) {
        logger.warn(`[projects] render archive for ${project.id} skipped ${summary.skipped} render(s) with unreadable bytes`);
      }
    } catch (err) {
      // Headers are already out, so there is no status left to send: log a reference and
      // terminate the stream rather than leaving the socket open until it times out.
      const ref = reportError('projects.renders.zip.stream', err);
      logger.warn(`[projects] render archive for ${project.id} ended early (ref ${ref})`);
      if (!res.writableEnded) res.end();
    }
  }));
}
