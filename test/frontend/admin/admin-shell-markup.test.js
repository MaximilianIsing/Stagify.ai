// Tier: drift guard (static analysis of public/admin.html) — the console shell.
//
// WHY THIS EXISTS. The dashboard's navigation is split across three files that
// have to agree, and nothing else checks that they do:
//
//   - public/admin.html declares the rail: one `.adm-tab` per section, carrying
//     `data-tab` (which panel it opens) and `data-title`/`data-sub` (what the
//     sticky topbar says while it is open),
//   - scripts/admin.js reads those attributes — `#panel-<data-tab>` and the two
//     labels — and never validates them,
//   - scripts/admin/renderers.js writes the count chips by id (`#tc-users`, …).
//
// Every one of those failures is silent. A tab whose `#panel-*` is missing opens
// a blank page; a missing `data-title` retitles the section with the button's own
// text; and a renamed count chip simply never updates (`setTabCount` skips a null
// rather than throwing, which is right at runtime and invisible in review).
//
// So: the rail, the panels and the chips are pinned against each other here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HTML = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
const RENDERERS = fs.readFileSync(path.join(ROOT, 'public', 'scripts', 'admin', 'renderers.js'), 'utf8');

/** Every rail button, as its opening tag plus inner markup. */
const TABS = [...HTML.matchAll(/<button class="adm-tab[^"]*"([^>]*)>([\s\S]*?)<\/button>/g)]
  .map(([, attrs, inner]) => ({
    attrs,
    inner,
    tab: (attrs.match(/data-tab="([^"]*)"/) || [])[1],
    title: (attrs.match(/data-title="([^"]*)"/) || [])[1],
    sub: (attrs.match(/data-sub="([^"]*)"/) || [])[1],
  }));

const PANEL_IDS = [...HTML.matchAll(/<div class="adm-panel[^"]*" id="panel-([a-z-]+)"/g)].map((m) => m[1]);

test('the scan finds the rail it claims to check', () => {
  // A regex that stopped matching would make every assertion below vacuous.
  assert.ok(TABS.length >= 10, `expected the full rail, found ${TABS.length} tabs`);
  assert.ok(PANEL_IDS.includes('overview'), 'the overview panel must be in the scan');
});

test('every rail button opens a panel that exists, and every panel has a button', () => {
  const tabbed = TABS.map((t) => t.tab);
  assert.deepEqual(
    tabbed.filter((t) => !PANEL_IDS.includes(t)),
    [],
    'these tabs have no #panel-<data-tab>, so clicking one shows an empty page',
  );
  assert.deepEqual(
    PANEL_IDS.filter((p) => !tabbed.includes(p)),
    [],
    'these panels are unreachable — nothing in the rail opens them',
  );
});

test('every rail button names its section for the topbar', () => {
  // admin.js falls back to the button's own text, which includes the count chip —
  // "Users 2" as a page title. The fallback is for the DOM-stubbed suites, not
  // for real markup.
  const missing = TABS.filter((t) => !t.title || !t.sub).map((t) => t.tab);
  assert.deepEqual(missing, [], 'these tabs are missing data-title and/or data-sub');
});

test('exactly one rail button starts active, and it matches the panel and the topbar', () => {
  // Read the active state off the raw markup: `active` lives in the class
  // attribute, which the TABS regex consumed before capturing.
  const activeTabs = [...HTML.matchAll(/<button class="adm-tab active"[^>]*data-tab="([^"]*)"[^>]*data-title="([^"]*)"/g)];
  assert.equal(activeTabs.length, 1, 'exactly one tab may carry .active on first paint');

  const [, tab, title] = activeTabs[0];
  assert.match(
    HTML,
    new RegExp(`<div class="adm-panel active" id="panel-${tab}"`),
    'the active tab and the active panel must be the same section',
  );
  assert.match(
    HTML,
    new RegExp(`<h1 id="adm-page-title">${title}</h1>`),
    'the topbar is server-rendered with the first section\'s title; nothing sets it '
      + 'until the operator clicks, so a mismatch persists for the whole first view',
  );
});

test('every count chip the renderers write is present in the rail', () => {
  const written = [...RENDERERS.matchAll(/setTabCount\('#(tc-[a-z-]+)'/g)].map((m) => m[1]);
  assert.ok(written.length >= 5, `expected the count chips, found ${written.length}`);

  const missing = written.filter((id) => !HTML.includes(`id="${id}"`));
  assert.deepEqual(
    missing,
    [],
    'renderers.js writes these count chips but admin.html has no element with that id. '
      + 'setTabCount skips a missing node, so the chip would just never update.',
  );
});

test('the rail is grouped, and the groups are labelled', () => {
  // Eleven flat items is the layout this replaced. The group headings are the
  // whole reason the rail is scannable, so losing them is a real regression.
  const groups = [...HTML.matchAll(/<p class="adm-nav-group">([^<]+)<\/p>/g)].map((m) => m[1]);
  assert.ok(groups.length >= 4, `expected the rail to stay grouped, found ${groups.length} headings`);
  assert.equal(new Set(groups).size, groups.length, 'two rail groups share a heading');
});
