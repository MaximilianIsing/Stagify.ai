// lib/data/s3-presign.js — the synchronous SigV4 query signer.
//
// THIS FILE IS THE REASON HAND-ROLLING THE SIGNER IS ACCEPTABLE.
//
// Hand-rolled SigV4 is normally a bad idea: canonicalization mistakes produce a
// signature that works for the case you tried and fails for someone's filename, and you
// find out from a customer rather than from CI. The differential test below removes
// that risk. aws4fetch is already a dependency (it signs the PUT/DELETE/HEAD calls in
// object-store-r2.js), it is a widely-used reference implementation, and it can produce
// the same presigned URLs — just asynchronously, which is why we do not use it on the
// request path. So it makes a perfect ORACLE: every case here asserts that our
// synchronous signer and aws4fetch agree byte for byte.
//
// If they ever disagree, the build fails and the answer is to delete lib/data/s3-presign.js
// and await aws4fetch behind `presignGet` — a one-function change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AwsClient } from 'aws4fetch';
import { presignGetUrl, encodeRfc3986, amzDates } from '../../lib/data/s3-presign.js';

// AWS's own documentation examples. Not real credentials.
const CRED = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};
const ORIGIN = 'https://acct123.r2.cloudflarestorage.com';
const BUCKET = 'stagify-renders';
const RID = '0123456789abcdef0123456789abcdef';
const NOW = Date.UTC(2026, 7, 2, 18, 30, 0);

/** The oracle: aws4fetch's presigned URL for the same inputs. */
async function aws4fetchSignature(objectPath, expiresSec, contentDisposition, now = NOW) {
  const aws = new AwsClient({ ...CRED, service: 's3', region: 'auto' });
  let url = `${ORIGIN}/${BUCKET}${objectPath}?X-Amz-Expires=${expiresSec}`;
  if (contentDisposition) url += `&response-content-disposition=${encodeRfc3986(contentDisposition)}`;
  const signed = await aws.sign(url, {
    method: 'GET',
    aws: { signQuery: true, datetime: amzDates(now).amzDate },
  });
  return new URL(signed.url).searchParams.get('X-Amz-Signature');
}

/** Ours. */
function oursSignature(objectPath, expiresSec, contentDisposition, now = NOW) {
  const url = presignGetUrl({
    url: `${ORIGIN}/${BUCKET}${objectPath}`,
    ...CRED,
    expiresSec,
    now,
    contentDisposition,
  });
  return new URL(url).searchParams.get('X-Amz-Signature');
}

const CASES = [
  ['a staged result', `/renders/${RID}/after.webp`, 900, undefined],
  ['a source photo', `/renders/${RID}/before.webp`, 900, undefined],
  ['a thumbnail, short ttl', `/renders/${RID}/thumb.webp`, 60, undefined],
  ['a reference blob', `/refs/${'a'.repeat(64)}.webp`, 3600, undefined],
  ['the 7-day maximum', `/renders/${RID}/after.webp`, 604800, undefined],
  ['a download filename', `/renders/${RID}/after.webp`, 900, 'attachment; filename="living-room.webp"'],
  // The five characters encodeURIComponent leaves alone but RFC3986 does not. This is
  // THE case a naive implementation gets wrong, and it reaches us through a furniture
  // reference whose filename has an apostrophe.
  ['a filename with !\'()*', `/renders/${RID}/after.webp`, 900, 'attachment; filename="o\'brien (1)*!.webp"'],
  ['a filename with spaces and unicode', `/renders/${RID}/after.webp`, 900, 'attachment; filename="salón grande.webp"'],
];

for (const [label, objectPath, expiresSec, disposition] of CASES) {
  test(`matches aws4fetch byte for byte — ${label}`, async () => {
    const [ours, theirs] = await Promise.all([
      Promise.resolve(oursSignature(objectPath, expiresSec, disposition)),
      aws4fetchSignature(objectPath, expiresSec, disposition),
    ]);
    assert.equal(ours, theirs, `signature disagreed with aws4fetch for ${label}`);
    assert.match(/** @type {string} */ (ours), /^[a-f0-9]{64}$/);
  });
}

test('matches aws4fetch across a range of signing clocks', async () => {
  // The signing key is derived per DAY (the credential scope carries YYYYMMDD), so a
  // date boundary is the interesting case: sign either side of midnight UTC and the
  // whole HMAC chain changes.
  const clocks = [
    Date.UTC(2026, 0, 1, 0, 0, 0),
    Date.UTC(2026, 0, 1, 23, 59, 59),
    Date.UTC(2026, 0, 2, 0, 0, 1),
    Date.UTC(2026, 11, 31, 23, 59, 59),
  ];
  for (const clock of clocks) {
    const ours = oursSignature(`/renders/${RID}/after.webp`, 900, undefined, clock);
    const theirs = await aws4fetchSignature(`/renders/${RID}/after.webp`, 900, undefined, clock);
    assert.equal(ours, theirs, `disagreed at clock ${new Date(clock).toISOString()}`);
  }
});

test('does not double-encode a path the URL parser already encoded', async () => {
  // REGRESSION. The first version of this module ran an RFC3986 encoder over
  // `parsed.pathname`, which `new URL()` has ALREADY percent-encoded — so a space became
  // %20 and then %2520, and the signature stopped matching what the server canonicalizes.
  //
  // It was invisible for the same reason it was harmless: every key object-keys.js
  // admits is RFC3986-unreserved, so both forms were byte-identical and the case matrix
  // above passed. Mutation testing found it — "forget to encode the path" survived,
  // which only makes sense if the encoding never did anything. This case reaches outside
  // the key alphabet on purpose, so the bug cannot return unnoticed.
  const url = 'https://acct123.r2.cloudflarestorage.com/my bucket/renders/x.webp';
  const ours = presignGetUrl({ url, ...CRED, expiresSec: 900, now: NOW });

  assert.equal(new URL(ours).pathname, '/my%20bucket/renders/x.webp', 'must not be %2520');

  const aws = new AwsClient({ ...CRED, service: 's3', region: 'auto' });
  const theirs = await aws.sign(`${url}?X-Amz-Expires=900`, {
    method: 'GET',
    aws: { signQuery: true, datetime: amzDates(NOW).amzDate },
  });
  assert.equal(
    new URL(ours).searchParams.get('X-Amz-Signature'),
    new URL(theirs.url).searchParams.get('X-Amz-Signature'),
    'signatures must agree even outside the constrained key alphabet',
  );
});

test('emits every SigV4 query parameter R2 requires', () => {
  const url = new URL(presignGetUrl({ url: `${ORIGIN}/${BUCKET}/renders/${RID}/after.webp`, ...CRED, expiresSec: 900, now: NOW }));
  for (const p of ['X-Amz-Algorithm', 'X-Amz-Credential', 'X-Amz-Date', 'X-Amz-Expires', 'X-Amz-SignedHeaders', 'X-Amz-Signature']) {
    assert.ok(url.searchParams.get(p), `${p} is missing`);
  }
  assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'host');
  assert.equal(url.searchParams.get('X-Amz-Credential'), `${CRED.accessKeyId}/20260802/auto/s3/aws4_request`);
});

test('the canonical query string is sorted, which the spec requires', () => {
  // Today this holds for free: the X-Amz-* names are inserted alphabetically and sort
  // before `response-content-disposition`. So the sort in presignGetUrl is an EQUIVALENT
  // MUTANT — removing it changes no current output, and mutation testing says so.
  //
  // It is asserted anyway, directly rather than through a signature, because the day
  // somebody adds a parameter that does not fall in insertion order this is the test
  // that explains why the signature broke.
  const url = new URL(presignGetUrl({
    url: `${ORIGIN}/${BUCKET}/renders/${RID}/after.webp`,
    ...CRED,
    expiresSec: 900,
    now: NOW,
    contentDisposition: 'attachment; filename="a.webp"',
  }));
  const names = [...url.searchParams.keys()].filter((k) => k !== 'X-Amz-Signature');
  assert.deepEqual(names, [...names].sort(), 'canonical query parameters must be in sorted order');
});

test('is deterministic, and the signature covers the expiry', () => {
  const at = (expiresSec) => oursSignature(`/renders/${RID}/after.webp`, expiresSec, undefined);
  assert.equal(at(900), at(900), 'same inputs must give the same signature');
  // If the expiry were not signed, anyone holding a URL could extend it forever by
  // editing the query string.
  assert.notEqual(at(900), at(901));
});

test('the signature covers the key, so one URL cannot be edited into another', () => {
  const a = oursSignature(`/renders/${RID}/after.webp`, 900, undefined);
  const b = oursSignature(`/renders/${RID}/before.webp`, 900, undefined);
  // before.webp is the owner-only source photo. If the key were not signed, a share
  // viewer holding the `after` URL could simply retype the path.
  assert.notEqual(a, b);
});

test('encodeRfc3986 escapes exactly what encodeURIComponent leaves behind', () => {
  assert.equal(encodeRfc3986("!'()*"), '%21%27%28%29%2A');
  assert.equal(encodeRfc3986('a b'), 'a%20b');
  assert.equal(encodeRfc3986('a/b'), 'a%2Fb');
  // Unreserved characters must survive untouched, or every key would be double-encoded.
  assert.equal(encodeRfc3986('AZaz09-_.~'), 'AZaz09-_.~');
});

test('amzDates produces the two forms SigV4 needs', () => {
  const { amzDate, dateStamp } = amzDates(Date.UTC(2026, 7, 2, 18, 30, 5));
  assert.equal(amzDate, '20260802T183005Z');
  assert.equal(dateStamp, '20260802');
});

// ---- the memoized signing key ---------------------------------------------------------
//
// `signingKey` caches its four-HMAC derivation, because a gallery page mints ~180 URLs and
// was re-deriving four constant values for every one of them. The cache is keyed on
// (secret, dateStamp, region, service) — these are the cases a cache keyed on too little
// would pass silently, and each is still asserted against the aws4fetch oracle rather than
// against our own previous answer, so a wrong cached key cannot agree with itself.
//
// The DATE half of this is already covered by 'matches aws4fetch across a range of signing
// clocks' above, which signs either side of midnight UTC in this same process.

test('a rotated credential never reuses the old signing key', async () => {
  // The failure mode if the cache were keyed on date alone: the second secret silently
  // signs with the first one's key. Both are minted back to back in ONE process, which is
  // the only way to catch it — a per-file cache looks fine when each test forks.
  const other = {
    accessKeyId: 'AKIAI44QH8DHBEXAMPLE',
    secretAccessKey: 'je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY',
  };
  const objectPath = `/renders/${RID}/after.webp`;
  const url = `${ORIGIN}/${BUCKET}${objectPath}`;

  const first = new URL(presignGetUrl({ url, ...CRED, expiresSec: 900, now: NOW }))
    .searchParams.get('X-Amz-Signature');
  const second = new URL(presignGetUrl({ url, ...other, expiresSec: 900, now: NOW }))
    .searchParams.get('X-Amz-Signature');
  // And back to the first, so a single-entry cache is exercised in both directions.
  const third = new URL(presignGetUrl({ url, ...CRED, expiresSec: 900, now: NOW }))
    .searchParams.get('X-Amz-Signature');

  assert.notEqual(first, second, 'two different secrets must not produce one signature');
  assert.equal(first, third, 'and coming back to the first secret must still be correct');

  const oracle = new AwsClient({ ...other, service: 's3', region: 'auto' });
  const signed = await oracle.sign(`${url}?X-Amz-Expires=900`, {
    method: 'GET',
    aws: { signQuery: true, datetime: amzDates(NOW).amzDate },
  });
  assert.equal(second, new URL(signed.url).searchParams.get('X-Amz-Signature'));
});

test('a different region derives a different signing key', async () => {
  // R2 is always `auto`, so this is the parameter most likely to be dropped from a cache
  // key on the grounds that it never varies. It is in the credential scope, so it must not
  // be — and the day it does vary, a stale key would be an unexplainable 403.
  const objectPath = `/renders/${RID}/after.webp`;
  const url = `${ORIGIN}/${BUCKET}${objectPath}`;

  const auto = new URL(presignGetUrl({ url, ...CRED, expiresSec: 900, now: NOW }))
    .searchParams.get('X-Amz-Signature');
  const useast = new URL(presignGetUrl({ url, ...CRED, region: 'us-east-1', expiresSec: 900, now: NOW }))
    .searchParams.get('X-Amz-Signature');
  assert.notEqual(auto, useast);

  const oracle = new AwsClient({ ...CRED, service: 's3', region: 'us-east-1' });
  const signed = await oracle.sign(`${url}?X-Amz-Expires=900`, {
    method: 'GET',
    aws: { signQuery: true, datetime: amzDates(NOW).amzDate },
  });
  assert.equal(useast, new URL(signed.url).searchParams.get('X-Amz-Signature'));
});
