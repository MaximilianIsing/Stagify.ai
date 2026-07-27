// The public-mailbox-provider gate (lib/data/public-email-domains.js) plus its
// drift guard against the language packs.
//
// Why this matters more than a typical validator: an enterprise domain upgrades
// EVERY account under it to `pro`. A hole here isn't a bad error message, it's
// free Stagify+ for every gmail.com address on the internet — so the matcher is
// tested against the evasions someone would actually try (case, @-prefix, a
// whole address, a trailing dot, a subdomain).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOCALES } from '../../lib/i18n/locales.js';
import {
  isPublicEmailDomain,
  normalizeDomain,
  PUBLIC_EMAIL_DOMAINS,
  PUBLIC_EMAIL_DOMAIN_CODE,
  PUBLIC_EMAIL_DOMAIN_MESSAGE,
} from '../../lib/data/public-email-domains.js';

test('the majors the gate exists for are all blocked', () => {
  for (const d of [
    'gmail.com', 'yahoo.com', 'aol.com', 'outlook.com', 'hotmail.com',
    'icloud.com', 'live.com', 'msn.com', 'protonmail.com', 'proton.me',
    'gmx.com', 'gmx.de', 'web.de', 'mail.ru', 'yandex.ru', 'qq.com',
    '163.com', 'naver.com', 'zoho.com', 'mail.com', 'comcast.net',
  ]) {
    assert.equal(isPublicEmailDomain(d), true, `${d} should be blocked`);
  }
});

test('disposable mailbox services are blocked too', () => {
  for (const d of ['mailinator.com', 'yopmail.com', '10minutemail.com', 'guerrillamail.com', 'trashmail.com']) {
    assert.equal(isPublicEmailDomain(d), true, `${d} should be blocked`);
  }
});

test('real company domains pass through', () => {
  for (const d of [
    'acme.com', 'stagify.ai', 'compass.com', 'kw.com', 'remax.net',
    'sothebysrealty.com', 'my-brokerage.co.uk', 'gmailer.com', 'notgmail.com',
    'mail.acme.com', 'aol-agency.com',
  ]) {
    assert.equal(isPublicEmailDomain(d), false, `${d} should be allowed`);
  }
});

test('matching survives the obvious evasions', () => {
  for (const input of [
    'GMAIL.COM',
    '  gmail.com  ',
    '@gmail.com',
    'someone@gmail.com',
    'Someone.Else@YAHOO.co.uk',
    'gmail.com.',
    'https://gmail.com/signup',
  ]) {
    assert.equal(isPublicEmailDomain(input), true, `${JSON.stringify(input)} should be blocked`);
  }
});

test('a subdomain of a public provider is blocked', () => {
  // The buyer controls neither `gmail.com` nor anything under it.
  assert.equal(isPublicEmailDomain('mail.gmail.com'), true);
  assert.equal(isPublicEmailDomain('a.b.c.yahoo.com'), true);
  // ...but a lookalike parent is not a match.
  assert.equal(isPublicEmailDomain('gmail.com.evil.co'), false);
});

test('junk input is not treated as a public domain', () => {
  for (const v of [null, undefined, '', '   ', 42, {}, [], '@', 'com']) {
    assert.equal(isPublicEmailDomain(/** @type {any} */ (v)), false, `${JSON.stringify(v)}`);
  }
});

test('normalizeDomain reduces addresses and URLs to a bare hostname', () => {
  assert.equal(normalizeDomain('Someone@Example.COM'), 'example.com');
  assert.equal(normalizeDomain('weird+tag@sub.example.com.'), 'sub.example.com');
  assert.equal(normalizeDomain('https://example.com/path?q=1'), 'example.com');
  assert.equal(normalizeDomain('@example.com'), 'example.com');
  assert.equal(normalizeDomain(/** @type {any} */ (null)), '');
});

test('the list itself is well-formed', () => {
  for (const d of PUBLIC_EMAIL_DOMAINS) {
    assert.equal(d, d.toLowerCase(), `${d} is not lowercase`);
    assert.equal(d, d.trim(), `${d} has surrounding whitespace`);
    assert.ok(d.includes('.'), `${d} is not a domain`);
    assert.ok(!d.startsWith('@'), `${d} carries an @ prefix`);
  }
});

// ---- i18n drift guard ------------------------------------------------------
// Same shape as test/unstageable-i18n.test.js: the browser localizes the refusal
// by code, and a missing key silently degrades to the server's English — so the
// omission would ship unnoticed without this.

const LANG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'languages');
const LANGS = [...new Set(['english', ...LOCALES.map((l) => l.lang)])];
const packFor = (lang) => JSON.parse(fs.readFileSync(path.join(LANG_DIR, `${lang}.json`), 'utf8'));

test('every language pack translates the public-domain refusal', () => {
  for (const lang of LANGS) {
    const msg = packFor(lang).enterprise?.errors?.publicDomain;
    assert.equal(typeof msg, 'string', `${lang}.json is missing enterprise.errors.publicDomain`);
    assert.ok(msg.trim().length > 0, `${lang}.json has an empty enterprise.errors.publicDomain`);
  }
});

test('non-English packs actually translate the refusal', () => {
  const english = packFor('english').enterprise.errors.publicDomain;
  for (const lang of LANGS.filter((l) => l !== 'english')) {
    assert.notEqual(
      packFor(lang).enterprise.errors.publicDomain,
      english,
      `${lang}.json still has the English string for enterprise.errors.publicDomain`,
    );
  }
});

test('the wire code the browser switches on is stable', () => {
  // public/scripts/enterprise.js compares against this literal; changing the
  // constant without changing the page would silently drop the localization.
  assert.equal(PUBLIC_EMAIL_DOMAIN_CODE, 'PUBLIC_EMAIL_DOMAIN');
  assert.ok(PUBLIC_EMAIL_DOMAIN_MESSAGE.trim().length > 0);
});
