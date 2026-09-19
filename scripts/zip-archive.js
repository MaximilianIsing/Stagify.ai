// A minimal, dependency-free ZIP writer and central-directory reader.
//
// WHY NOT A LIBRARY
// The only thing this repo zips is the brand kit (scripts/build-brand-kit.js), and
// the archive is a handful of PNGs plus a text file. Pulling `archiver` or `adm-zip`
// into devDependencies for ~80 lines of well-specified binary layout would add a
// supply-chain surface to the deploy gate for no capability we need. Node already
// ships both halves: `zlib.deflateRawSync` produces the compressed member payload
// (method 8 is literally a raw deflate stream) and `zlib.crc32` produces the
// checksum that used to be the annoying part of doing this by hand.
//
// WHY THE TIMESTAMP IS FIXED
// The generated zip is committed. A real mtime would make every rebuild emit a
// different binary even when no input changed, so `git status` would show churn
// after any run of the build script and reviewers could not tell a content change
// from a no-op. FIXED_DOS_TIME makes the output a pure function of the inputs.
//
// Scope: store/deflate, no ZIP64, no encryption, no directory entries. If the kit
// ever needs >4GB or >65535 files, reach for a library then — not before.

import zlib from 'node:zlib';

// 1980-01-01 00:00:00 in MS-DOS packed form — the earliest the format can express,
// and the conventional "no meaningful time" value for reproducible archives.
const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = (1 << 5) | 1; // year 0 (=1980), month 1, day 1

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/**
 * @typedef {{ name: string, data: Buffer }} ZipInput
 */

/**
 * Build a ZIP archive in memory.
 *
 * Each member is deflated, and kept stored (method 0) when deflating made it
 * bigger — which it does for already-compressed payloads like PNG, where the
 * deflate stream is the original bytes plus block framing.
 *
 * @param {ZipInput[]} entries - Members, in the order they should appear.
 * @returns {Buffer} The complete archive.
 */
export function createZip(entries) {
  /** @type {Buffer[]} */
  const chunks = [];
  /** @type {Buffer[]} */
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = zlib.crc32(entry.data);
    const deflated = zlib.deflateRawSync(entry.data, { level: 9 });
    const stored = deflated.length >= entry.data.length;
    const method = stored ? 0 : 8;
    const payload = stored ? entry.data : deflated;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(FIXED_DOS_TIME, 10);
    local.writeUInt16LE(FIXED_DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    chunks.push(local, name, payload);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(CENTRAL_SIG, 0);
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0, 8); // flags
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(FIXED_DOS_TIME, 12);
    dir.writeUInt16LE(FIXED_DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(payload.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30); // extra
    dir.writeUInt16LE(0, 32); // comment
    dir.writeUInt16LE(0, 34); // disk number
    dir.writeUInt16LE(0, 36); // internal attrs
    dir.writeUInt32LE(0, 38); // external attrs
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += local.length + name.length + payload.length;
  }

  const dirBytes = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(dirBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, dirBytes, eocd]);
}

/**
 * Read the member names out of an archive's central directory.
 *
 * Only used by test/frontend/brand-kit.test.js, to prove the committed zip still
 * matches what is on disk. Reading the central directory rather than scanning for
 * local headers is deliberate: the central directory is the authoritative index,
 * and a local-header scan can false-positive on the signature bytes appearing
 * inside compressed data.
 *
 * @param {Buffer} buf - A complete archive.
 * @returns {string[]} Member names, in central-directory order.
 */
export function listZipEntries(buf) {
  // The EOCD is last, but may be followed by a variable-length comment, so it is
  // found by scanning backwards for its signature. We write no comment, so this
  // hits on the first try; the loop exists so a hand-edited archive still reads.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip archive: no end-of-central-directory record');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  /** @type {string[]} */
  const names = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIG) throw new Error('corrupt central directory');
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    names.push(buf.toString('utf8', p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}
