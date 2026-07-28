// Tier: drift guard — the ledger of island factories whose dependency bag is
// still an untyped `any`.
//
// WHY THIS EXISTS: the three studio entries wire their islands by injecting one
// object literal per factory — `createDrawTools({ state, stack, baseCanvas, … })`,
// 25 keys in the largest case. `tsconfig.frontend.json` deliberately runs with
// `noImplicitAny: false` for the rollout, so a factory written as
// `createX(deps)` with no JSDoc gets `deps: any` and EVERY key destructured out
// of it is `any` too. `npm run typecheck` then proves nothing whatsoever about
// that seam: a renamed state field, a dropped dependency, or a callback invoked
// with the wrong arity all type-check clean and fail in the browser instead.
//
// A code review named this directly ("8 islands read/write one untyped state
// object with no contract"). The masking-studio bags are now typed against
// `public/scripts/masking-studio/types.d.ts`, which makes the checker enforce
// the contract. This test is what stops that from rotting: without it, the very
// next `createFoo(deps)` added to the folder is silently `any` again and the
// typecheck stays green.
//
// The assertion is set equality against the ledger below, so it fails in three
// useful directions — the same shape as untested-frontend-modules.test.js:
//   1. a new factory arrives with an untyped bag  -> must be added here (visible debt)
//   2. a listed factory gains a typed bag         -> must be removed here (ratchet)
//   3. a listed factory is deleted/renamed        -> must be removed here (no stale rot)
// Only ever shrink this list.
//
// HOW "typed" IS DETERMINED: by asking the real TypeScript checker for the type
// of each parameter, NOT by grepping for `@param`. That distinction is load-
// bearing. A text scan for JSDoc is satisfied by a comment that merely mentions
// the right token — including, in the worst case, this file's own explanatory
// comment — so it would pass with the annotation deleted. Resolving the actual
// parameter type cannot be faked by any comment: only a real annotation that the
// checker accepts moves a factory off this list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { collectEsmFrontend } from '../../scripts/collect-esm-frontend.js';

const HERE = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, '/');
const ROOT = path.resolve(HERE, '../..').replace(/\\/g, '/');
const SCRIPTS = `${ROOT}/public/scripts`;

// ── the ledger ───────────────────────────────────────────────────────────────
// "<scripts-relative path>#<factory name>", sorted. SHRINK ONLY. See the header.
//
// The eight masking-studio factories are deliberately absent: they are typed
// against ./masking-studio/types.d.ts. These eleven are the remaining debt in
// the other two studios — the same fix applies, it just has not been done yet.
const UNTYPED_DEPS = [
  'ai-designer/chat-messages.js#createChatMessages',
  'ai-designer/chat-response.js#createChatResponse',
  'ai-designer/file-intake.js#createFileIntake',
  'ai-designer/image-viewer.js#createImageViewer',
  'ai-designer/mask-editor.js#createMaskEditor',
  'ai-designer/thumbnail-strip.js#createThumbnailStrip',
  'app/empty-room-viewer.js#createEmptyRoomViewer',
  'app/furniture-refs.js#createFurnitureRefs',
  'app/stage-mask-editor.js#createStageMaskEditor',
  'app/staging-pipeline.js#createStagingPipeline',
  'app/version-carousel.js#createVersionCarousel',
];

// Build a program over exactly the files `npm run typecheck` checks, with
// exactly its compiler options, so this guard and the deploy gate agree on what
// a type even is. readConfigFile parses JSONC — tsconfig.frontend.json is
// heavily commented.
function buildProgram() {
  const configPath = `${ROOT}/tsconfig.frontend.json`;
  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(error, undefined, 'tsconfig.frontend.json must parse');
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, ROOT);
  const files = collectEsmFrontend(SCRIPTS, ROOT).map((rel) => path.join(ROOT, rel));
  files.push(path.join(SCRIPTS, 'globals.d.ts'));
  return ts.createProgram(files, parsed.options);
}

// Every exported `create*` factory in the frontend, with the resolved type of
// each of its parameters. A factory counts as untyped when any parameter is
// `any` — which, under noImplicitAny:false, is exactly what an unannotated
// `(deps)` produces.
//
// Returns BOTH the untyped subset and every factory the walk visited. The
// caller asserts on both, and that pairing is deliberate: see the population
// test below.
function scanFactories(program) {
  const checker = program.getTypeChecker();
  const untyped = [];
  const all = [];
  const depsTypes = new Map();
  for (const sf of program.getSourceFiles()) {
    const file = sf.fileName.replace(/\\/g, '/');
    if (!file.startsWith(SCRIPTS + '/') || file.endsWith('.d.ts')) continue;
    if (file.includes('/vendor/')) continue;
    const rel = file.slice(SCRIPTS.length + 1);

    ts.forEachChild(sf, (node) => {
      if (!ts.isFunctionDeclaration(node) || !node.name) return;
      if (!/^create[A-Z]/.test(node.name.text)) return;
      const exported = ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export;
      if (!exported) return;
      if (!node.parameters.length) return;

      const id = `${rel}#${node.name.text}`;
      all.push(id);
      depsTypes.set(id, checker.getTypeAtLocation(node.parameters[0]));
      const anyParam = node.parameters.some((p) => {
        const t = checker.getTypeAtLocation(p);
        return (t.flags & ts.TypeFlags.Any) !== 0;
      });
      if (anyParam) untyped.push(id);
    });
  }
  return { untyped: untyped.sort(), all: all.sort(), depsTypes, checker };
}

test('island factory dependency bags: untyped set matches the ledger', () => {
  const { untyped } = scanFactories(buildProgram());

  assert.deepEqual(
    untyped,
    [...UNTYPED_DEPS].sort(),
    'The set of island factories with an untyped `deps` bag changed.\n' +
      'If you added a factory: type its bag (see masking-studio/draw-tools.js for the\n' +
      'shape) — or, deliberately, add it to UNTYPED_DEPS as visible debt.\n' +
      'If you typed one: remove it from UNTYPED_DEPS.',
  );
});

// Sanity assertion, and it must run through the SAME scan the ledger uses.
//
// An earlier version of this file walked the AST separately here, which made it
// worthless: blinding the ledger's walk (so it matched nothing) while emptying
// the ledger left BOTH tests green — the scan saw zero factories and zero were
// expected. Mutation-testing caught it. Asserting on `all` from the one shared
// scan is what closes that hole: a walk that goes blind now fails here loudly,
// whatever the ledger happens to say.
test('island factory scan sees the whole factory population', () => {
  const { all, untyped } = scanFactories(buildProgram());

  // Every ledger entry must actually be found — a renamed or deleted factory
  // that the walk can no longer see is stale debt, not resolved debt.
  for (const id of UNTYPED_DEPS) {
    assert.ok(all.includes(id), `ledger entry no longer exists in the source: ${id}`);
  }

  // The eight masking-studio islands are the ones this guard exists to protect.
  const MASKING_STUDIO = [
    'masking-studio/draw-tools.js#createDrawTools',
    'masking-studio/generate-pipeline.js#createGeneratePipeline',
    'masking-studio/layers-ui.js#createLayersUi',
    'masking-studio/seg-wand.js#createSegWand',
    'masking-studio/session-store.js#createSessionStore',
    'masking-studio/snap-refine.js#createSnapRefine',
    'masking-studio/upload.js#createUpload',
    'masking-studio/viewer.js#createViewer',
  ];
  for (const id of MASKING_STUDIO) {
    assert.ok(all.includes(id), `masking-studio factory not seen by the scan: ${id}`);
    assert.ok(!untyped.includes(id), `masking-studio factory lost its types: ${id}`);
  }
});

// The bag must be the REAL wiring, not merely some non-`any` type. A typedef
// that drifted down to `{ state: MsState }` would satisfy the ledger while
// silently dropping 24 checked dependencies, so pin the shape itself.
test('the largest bag is typed against the real wiring', () => {
  const { depsTypes, checker } = scanFactories(buildProgram());
  const bag = depsTypes.get('masking-studio/draw-tools.js#createDrawTools');
  assert.ok(bag, 'createDrawTools must be found by the shared scan');

  const keys = checker.getPropertiesOfType(bag).map((s) => s.name).sort();
  assert.ok(keys.includes('state'), 'createDrawTools deps must carry the shared state');
  assert.equal(
    keys.length,
    25,
    `createDrawTools takes a 25-key bag; scan saw ${keys.length}. Update this if the wiring changes.`,
  );
});
