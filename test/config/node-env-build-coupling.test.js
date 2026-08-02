// NODE_ENV=production and build.sh's `npm ci` are coupled — pin them together.
//
// WHY THIS EXISTS: docs/reference/environment-variables.md claimed "NODE_ENV is set
// to 'production' by render.yaml on deploy". It is not — render.yaml declares no
// envVars at all. The doc has been corrected, but the underlying trap is still live
// and is the kind someone fixes on a Friday:
//
//   npm omits devDependencies when NODE_ENV=production. scripts/build.sh runs
//   `npm ci` and then `npm test`, whose first step is `npm run typecheck` →
//   `tsc --noEmit`. Setting NODE_ENV=production in render.yaml WITHOUT also making
//   build.sh install dev dependencies means typescript is not there, `set -e`
//   aborts, and the deploy gate stops running — failing for a reason that has
//   nothing to do with the tests it exists to run.
//
// CI never executes build.sh (.github/workflows only runs npm test directly), so
// nothing else exercises this path before Render does. Hence a static guard.
//
// This test does NOT insist NODE_ENV stay unset. It only insists the two changes
// land together, whichever way round they are made.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(rootDir, rel), 'utf8');

/** Strip `#` comments so a line merely DISCUSSING NODE_ENV is not read as setting it. */
function stripHashComments(src) {
  return src
    .split('\n')
    .map((line) => {
      // Not inside a quoted string — these files have no quoted '#' in practice, and
      // treating one as a comment start would only ever under-report a setting,
      // which the "is it actually set?" assertions below would then catch.
      const at = line.indexOf('#');
      return at === -1 ? line : line.slice(0, at);
    })
    .join('\n');
}

const renderYaml = stripHashComments(read('render.yaml'));
const buildSh = stripHashComments(read('scripts/build.sh'));

/** Does render.yaml actually set NODE_ENV to production (not just mention it)? */
const setsProduction = /key:\s*NODE_ENV[\s\S]{0,120}?value:\s*["']?production["']?/i.test(renderYaml)
  || /NODE_ENV\s*[:=]\s*["']?production["']?/i.test(renderYaml);

/** Does build.sh force dev dependencies in regardless of NODE_ENV? */
const installsDevDeps = /npm\s+ci[^\n]*--include[=\s]dev/.test(buildSh)
  || /npm\s+ci[^\n]*--production[=\s]false/.test(buildSh)
  || /NPM_CONFIG_PRODUCTION\s*=\s*false/.test(buildSh)
  || /npm\s+ci[^\n]*--also[=\s]dev/.test(buildSh);

test('the guard is reading the real files (self-test)', () => {
  // Without this, a moved or renamed file would make every assertion below vacuous.
  assert.match(renderYaml, /services:/, 'render.yaml does not look like a Render blueprint');
  assert.match(buildSh, /npm\s+ci/, 'scripts/build.sh no longer runs npm ci — update this guard');
  assert.match(buildSh, /npm\s+test/, 'scripts/build.sh no longer runs npm test — update this guard');
});

test('NODE_ENV=production in render.yaml requires build.sh to install devDependencies', () => {
  if (!setsProduction) return; // the current state; nothing to enforce
  assert.ok(
    installsDevDeps,
    'render.yaml now sets NODE_ENV=production, so `npm ci` in scripts/build.sh will omit '
      + 'devDependencies — and the next line runs `npm test`, whose typecheck step needs '
      + 'typescript. Add `--include=dev` to that npm ci (see the note in '
      + 'docs/reference/environment-variables.md).',
  );
});

test('the docs do not claim render.yaml sets NODE_ENV when it does not', () => {
  const doc = read('docs/reference/environment-variables.md');
  if (setsProduction) return; // the claim would be true; nothing to check
  assert.doesNotMatch(
    doc,
    /NODE_ENV is set to "production" by render\.yaml/,
    'the docs claim render.yaml sets NODE_ENV=production, but it declares no envVars at all',
  );
});

test('the typecheck step really is what would break, so the coupling is real', () => {
  // If `npm test` ever stops needing a devDependency, this whole coupling dissolves
  // and the guard should be deleted rather than left to rot.
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts.test, /typecheck/, 'npm test no longer runs typecheck — re-evaluate this guard');
  assert.ok(
    pkg.devDependencies && pkg.devDependencies.typescript,
    'typescript is no longer a devDependency — re-evaluate this guard',
  );
});
