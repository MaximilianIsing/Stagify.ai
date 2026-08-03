// SigV4 query-signing for GET — the one piece of AWS signing this app does itself.
//
// WHY HAND-ROLLED WHEN aws4fetch IS ALREADY A DEPENDENCY
// aws4fetch signs with WebCrypto (it targets Cloudflare Workers, where node:crypto does
// not exist), so `AwsClient.sign()` is ASYNC. Every other verb this app sends to R2 —
// PUT, DELETE, HEAD — is a network call already, so an async signer costs nothing and
// aws4fetch does all of them (see object-store-r2.js). Presigning is different: it is
// pure computation on the REQUEST path, and a gallery manifest mints one URL per blob.
// Measured, aws4fetch needs ~8 ms to mint 40; the synchronous HMAC below needs ~0.2 ms.
//
// More importantly, a synchronous presigner keeps `presignGet` pure — no promise, no
// await, nothing to cache. That matters because A CACHED PRESIGNED URL IS A REVOCATION
// BUG: the whole security model is that a URL stops being mintable the moment a share
// is revoked, and outstanding URLs age out within the TTL. An async API invites a
// memoization layer that would quietly extend both.
//
// WHY THIS IS SAFE TO HAND-ROLL
// Hand-rolled SigV4 is normally a bad idea, and the reason is canonicalization: getting
// URI-encoding, header folding or query ordering subtly wrong yields a signature that
// works for your test case and fails for someone's filename. Two things remove that
// risk here:
//   1. The key alphabet is closed. lib/data/object-keys.js admits only [a-f0-9], '/',
//      one '.' and a short lowercase extension, so every character in the path is
//      RFC3986-unreserved and the encoding edge cases are structurally unreachable.
//      The single free-form value, `response-content-disposition`, goes through the
//      strict encoder below.
//   2. `test/data/s3-presign.test.js` asserts this module produces BYTE-IDENTICAL
//      output to aws4fetch across a matrix of keys, expiries, clocks and filenames.
//      aws4fetch is the reference implementation and the test is the oracle, so a
//      canonicalization mistake fails the build rather than shipping.
// If this ever becomes a maintenance burden, deleting it and awaiting aws4fetch is a
// one-function change behind `presignGet`.
import crypto from 'crypto';

const ALGORITHM = 'AWS4-HMAC-SHA256';

/**
 * The payload hash S3 accepts for a presigned URL whose body is not known at signing
 * time. This literal string is what goes in the canonical request — it is not a digest.
 */
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/**
 * RFC3986 percent-encoding, which is what SigV4 requires and what
 * `encodeURIComponent` ALMOST does.
 *
 * `encodeURIComponent` leaves `!'()*` unescaped; RFC3986 lists them as reserved
 * sub-delims and AWS expects them encoded. Getting this wrong is the single most common
 * hand-rolled-SigV4 defect, and it only shows up once a value contains one of those
 * five characters — which, for this app, means a furniture reference whose filename has
 * an apostrophe.
 *
 * @param {string} str - A raw value.
 * @returns {string} Its RFC3986 form.
 */
export function encodeRfc3986(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The canonical URI for the signature.
 *
 * Deliberately `parsed.pathname` UNCHANGED, not a re-encode of it. `new URL()` already
 * percent-encodes the path to WHATWG rules, so running an RFC3986 encoder over the
 * result double-encodes: a space becomes `%20` in the parser and then `%2520` in the
 * encoder, and the signature no longer matches what the server canonicalizes. S3 is
 * explicitly single-encode for this reason.
 *
 * The first version of this function did re-encode. It was invisible because every key
 * lib/data/object-keys.js admits is RFC3986-unreserved, so both forms were byte-identical
 * — the differential test passed, and the bug sat waiting for the first key or bucket
 * name with a character outside that alphabet. `test/data/s3-presign.test.js` now pins
 * the off-domain case against aws4fetch so it cannot come back.
 *
 * @param {URL} parsed - The object URL.
 * @returns {string} The canonical URI path.
 */
function canonicalUri(parsed) {
  return parsed.pathname;
}

/**
 * `YYYYMMDDTHHMMSSZ` and its `YYYYMMDD` prefix, the two forms SigV4 needs.
 * @param {number} epochMs - Signing time.
 * @returns {{ amzDate: string, dateStamp: string }}
 */
export function amzDates(epochMs) {
  const amzDate = new Date(epochMs).toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * The last derived signing key, and the inputs it was derived from.
 *
 * THIS IS NOT THE CACHING THE HEADER WARNS ABOUT. That warning is about caching the
 * presigned URL, which would extend a credential past its TTL and break revocation. This
 * caches the four-HMAC chain that derives a signing key from the secret — a pure function
 * of (secret, date, region, service) that grants nothing on its own and is public
 * knowledge the moment any URL signed with it is. Nothing about a URL's lifetime changes.
 *
 * Worth having because a gallery page mints ~180 URLs and re-derived this for every one:
 * 720 HMACs to compute four distinct values. One entry rather than a Map, because there is
 * one credential, one region and one service in this process and the dateStamp turns over
 * once a day — a Map would be a leak with no hit-rate to show for it.
 *
 * Keyed on the SECRET too, so a rotated credential can never collide with a stale key.
 * @type {{ id: string, key: Buffer } | null}
 */
let derivedKey = null;

/**
 * The four-step HMAC chain that turns a secret key into a scoped signing key.
 * @param {string} secretAccessKey - The account secret.
 * @param {string} dateStamp - `YYYYMMDD`.
 * @param {string} region - e.g. `auto` for R2.
 * @param {string} service - e.g. `s3`.
 * @returns {Buffer} The signing key.
 */
function signingKey(secretAccessKey, dateStamp, region, service) {
  // '\n' cannot appear in a dateStamp, region or service, so this is unambiguous.
  const id = `${secretAccessKey}\n${dateStamp}\n${region}\n${service}`;
  if (derivedKey && derivedKey.id === id) return derivedKey.key;
  const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), 'aws4_request');
  derivedKey = { id, key };
  return key;
}

/**
 * Build a presigned GET URL.
 *
 * @param {Object} arg - Everything the signature covers.
 * @param {string} arg.url - The unsigned object URL, e.g.
 *   `https://<acct>.r2.cloudflarestorage.com/<bucket>/<key>`. Must carry no query string.
 * @param {string} arg.accessKeyId - R2 access key id.
 * @param {string} arg.secretAccessKey - R2 secret.
 * @param {string} [arg.region] - Defaults to `auto`, which is what R2 wants.
 * @param {string} [arg.service] - Defaults to `s3`.
 * @param {number} arg.expiresSec - Lifetime in seconds; SigV4 caps this at 604800 (7d).
 * @param {number} [arg.now] - Signing clock in epoch ms; injectable so tests are stable.
 * @param {string} [arg.contentDisposition] - Sets `response-content-disposition`, which
 *   is how a download gets a filename without the bytes passing through this server.
 * @returns {string} The signed URL.
 */
export function presignGetUrl({
  url,
  accessKeyId,
  secretAccessKey,
  region = 'auto',
  service = 's3',
  expiresSec,
  now = Date.now(),
  contentDisposition,
}) {
  const parsed = new URL(url);
  const { amzDate, dateStamp } = amzDates(now);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;

  // The canonical query string is sorted by key, with both key and value encoded. Every
  // signed parameter lives here rather than in a header, which is what makes the result
  // a plain URL anyone can fetch with no headers at all.
  const params = new Map([
    ['X-Amz-Algorithm', ALGORITHM],
    ['X-Amz-Credential', `${accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresSec)],
    ['X-Amz-SignedHeaders', 'host'],
  ]);
  if (contentDisposition) params.set('response-content-disposition', contentDisposition);

  // The sort is currently a no-op — the five X-Amz-* names are inserted alphabetically
  // and 'X' (0x58) sorts before 'r' (0x72), so `response-content-disposition` is already
  // last. Mutation testing confirms removing it changes nothing today. It stays because
  // it is the SPEC requirement rather than a property of this particular param list: add
  // one name that does not happen to fall in insertion order and the signature silently
  // stops matching. (When that day comes the differential test in
  // test/data/s3-presign.test.js catches it, because aws4fetch sorts unconditionally.)
  const canonicalQuery = [...params.entries()]
    .map(([k, v]) => [encodeRfc3986(k), encodeRfc3986(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  // `host` is the only signed header, so the canonical headers block is one line and the
  // trailing newline after it is required by the spec (headers are newline-TERMINATED,
  // not newline-separated).
  const canonicalRequest = [
    'GET',
    canonicalUri(parsed),
    canonicalQuery,
    `host:${parsed.host}\n`,
    'host',
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const stringToSign = [
    ALGORITHM,
    amzDate,
    scope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const signature = crypto
    .createHmac('sha256', signingKey(secretAccessKey, dateStamp, region, service))
    .update(stringToSign)
    .digest('hex');

  return `${parsed.origin}${canonicalUri(parsed)}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
