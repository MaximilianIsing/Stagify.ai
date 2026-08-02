#!/usr/bin/env node
// Verify the gallery's R2 credentials end to end: PUT, HEAD, presigned GET, DELETE.
//
// WHY THIS EXISTS RATHER THAN "just deploy and see"
// A wrong R2 setting does not crash anything. lib/data/object-store.js fails SAFE — the
// gallery simply turns off — so a typo'd secret looks exactly like a feature that has
// not shipped yet, and the first symptom is renders quietly not being saved. This asks
// the bucket directly and says which of the four settings is wrong.
//
// It also proves the PRESIGNED path, not just the credentials: that URL is fetched with
// no headers at all, exactly as a buyer's browser will fetch it, so a signing mistake
// shows up here instead of as a broken image on a client's phone.
//
//   node scripts/check-r2.js
//
// Reads the same env the server does (including .env via load-env.js). Writes one small
// object under a `renders/<hex>/` key and deletes it again; nothing else is touched.
import '../load-env.js';
import { createObjectStore } from '../lib/data/object-store.js';
import { keyForRender, newRenderId } from '../lib/data/object-keys.js';

const REQUIRED = ['R2_ACCOUNT_ENDPOINT', 'R2_RENDERS_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

/**
 * Report and exit. Declared as a `function` returning `never` rather than an arrow
 * const, so the checker knows control does not continue past a call and the null checks
 * below narrow without a cast.
 * @param {string} msg
 * @returns {never}
 */
function fail(msg) {
  console.error(`\n  FAILED  ${msg}\n`);
  process.exit(1);
}

const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  fail(
    `these are not set: ${missing.join(', ')}\n`
    + '          Add them to .env (local) or the Render dashboard (production).\n'
    + '          See .env.example for what each one is.',
  );
}

console.log(`  bucket    ${process.env.R2_RENDERS_BUCKET}`);
console.log(`  endpoint  ${process.env.R2_ACCOUNT_ENDPOINT}`);

// Deliberately NOT `env: process.env` shorthand — going through the real selector is the
// point, so this exercises the same construction the server does.
const store = createObjectStore({ baseDir: process.cwd() });
if (store.backend !== 'r2') {
  fail(`the object store resolved to "${store.backend}", not r2 — one of the four settings is being rejected.`);
}

const key = keyForRender({ renderId: newRenderId(), role: 'after' });
const body = Buffer.from('stagify r2 connectivity check');

try {
  const put = await store.put(key, body, 'text/plain');
  console.log(`  put       ok (${put.bytes} bytes)`);
} catch (e) {
  fail(
    `PUT was refused: ${e?.message}\n`
    + '          A 403 here usually means the API token is not scoped to this bucket,\n'
    + '          or it is Read-only rather than Object Read & Write.\n'
    + '          A 404 usually means the bucket name is wrong or it does not exist yet.',
  );
}

try {
  const head = await store.head(key);
  if (!head) fail('HEAD found nothing straight after a successful PUT — wrong bucket?');
  console.log(`  head      ok (${head.bytes} bytes)`);
} catch (e) {
  fail(`HEAD was refused: ${e?.message}`);
}

// The half that actually matters for the share page: a URL fetched with NO credentials.
try {
  const url = store.presignGet(key, { ttlMs: 60_000 });
  const res = await fetch(url);
  if (!res.ok) {
    fail(
      `the presigned URL came back ${res.status}.\n`
      + '          The credentials work (PUT succeeded) but the SIGNATURE does not, so\n'
      + '          share links would show broken images. Check R2_ACCOUNT_ENDPOINT has no\n'
      + '          bucket name in it and no trailing path.',
    );
  }
  const text = await res.text();
  if (text !== body.toString()) fail('the presigned URL returned different bytes than were uploaded.');
  console.log('  presign   ok (fetched with no headers, bytes match)');
} catch (e) {
  if (e?.message?.includes('presigned')) throw e;
  fail(`the presigned GET failed: ${e?.message}`);
}

try {
  await store.remove(key);
  const gone = await store.head(key);
  if (gone) fail('DELETE reported success but the object is still there — the token may lack delete permission.');
  console.log('  delete    ok');
} catch (e) {
  fail(
    `DELETE was refused: ${e?.message}\n`
    + '          The tombstone reaper needs this, or erased accounts leave bytes behind.',
  );
}

console.log('\n  R2 is configured correctly. The gallery will store renders here.\n');
