// Tier: drift guard — the ledger of island factories whose dependency bag is
// still an untyped `any`.
//
// WHY THIS EXISTS: the three studio entries wire their islands by injecting one
// object literal per factory — `createDrawTools({ state, stack, baseCanvas, … })`,
// 24 keys in the largest case. `tsconfig.frontend.json` deliberately runs with
// `noImplicitAny: false` for the rollout, so a factory written as
// `createX(deps)` with no JSDoc gets `deps: any` and EVERY key destructured out
// of it is `any` too. `npm run typecheck` then proves nothing whatsoever about
// that seam: a renamed state field, a dropped dependency, or a callback invoked
// with the wrong arity all type-check clean and fail in the browser instead.
//
// A code review named this directly ("8 islands read/write one untyped state
// object with no contract"). Every injected factory under public/scripts/ is now
// typed — the studios against masking-studio/types.d.ts and ai-designer/types.d.ts,
// the rest with inline bags — which makes the checker enforce the contract. This
// test is what stops that from rotting: without it, the very next
// `createFoo(deps)` added is silently `any` again and the typecheck stays green.
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
// EMPTY, and that is the point: every island factory across all three studios
// now types its bag. Adding an entry here is allowed but is a deliberate,
// reviewable act — it means shipping a factory whose wiring nothing checks.
const UNTYPED_DEPS = [];

// Every exported `create*` factory the scan should find, sorted. This is a
// registry, not a debt list — adding a factory means adding it here.
//
// It exists because the ledger above is empty: set-equality against an empty
// list passes just as happily when the scan is BROKEN and finds nothing at all.
// Pinning the population is what tells those two states apart.
//
// Wider than the three studio entries' islands, because the rule is worth
// applying to every injected factory: the shared scripts/mask/ slices, the
// admin panels and the profile-menu pieces were all already typed when this
// guard landed, and should stay that way.
const ALL_FACTORIES = [
  'admin/emails.js#createEmailsPanel',
  'admin/grant.js#createGrantSection',
  'admin/insights.js#createInsights',
  'admin/overview.js#createOverview',
  'admin/referrals.js#createReferralsPanel',
  'admin/renderers.js#createRenderers',
  'ai-designer/chat-messages.js#createChatMessages',
  'ai-designer/chat-response.js#createChatResponse',
  'ai-designer/file-intake.js#createFileIntake',
  'ai-designer/image-viewer.js#createImageViewer',
  'ai-designer/mask-editor.js#createMaskEditor',
  'ai-designer/thumbnail-strip.js#createThumbnailStrip',
  'app/download-menu.js#createDownloadMenu',
  'app/empty-room-viewer.js#createEmptyRoomViewer',
  'app/furniture-refs.js#createFurnitureRefs',
  'app/refine-handoff.js#createRefineHandoff',
  'app/stage-mask-editor.js#createStageMaskEditor',
  'app/staging-failure.js#createStagingFailure',
  'app/staging-pipeline.js#createStagingPipeline',
  'app/version-carousel.js#createVersionCarousel',
  'exterior-studio/compare.js#createCompare',
  'exterior-studio/controls.js#createControls',
  'mask/brush.js#createMaskBrush',
  'mask/fit.js#createMaskFit',
  'mask/overlay.js#createMaskOverlay',
  'mask/reference.js#createMaskReference',
  'mask/viewport.js#createMaskViewport',
  'gallery/refine.js#createRefineButton',
  'masking-studio/draw-tools.js#createDrawTools',
  'masking-studio/gallery-save.js#createGallerySave',
  'masking-studio/generate-pipeline.js#createGeneratePipeline',
  'masking-studio/layers-ui.js#createLayersUi',
  'masking-studio/layers.js#createLayer',
  'masking-studio/layers.js#createPool',
  'masking-studio/seg-wand.js#createSegWand',
  'masking-studio/session-store.js#createSessionStore',
  'masking-studio/snap-refine.js#createSnapRefine',
  'masking-studio/upload.js#createUpload',
  'masking-studio/viewer.js#createViewer',
  'app/gallery-notice.js#createGalleryNotice',
  'gallery/delete-confirm.js#createDeleteConfirm',
  'gallery/rename.js#createRenameRow',
  'gallery/share-panel.js#createSharePanel',
  'profile-menu/auth-modal.js#createAuthModal',
  'profile-menu/google-signin.js#createGoogleSignIn',
  'profile-menu/report-issue-modal.js#createReportIssueModal',
  'share/refresh.js#createRefresher',
  'share/view.js#createLightbox',
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
// scan is what closes that hole, and it matters more now that the ledger really
// is empty: without this, a scan that finds nothing is indistinguishable from a
// codebase with nothing left to find.
test('island factory scan sees the whole factory population', () => {
  const { all } = scanFactories(buildProgram());

  assert.deepEqual(
    all,
    [...ALL_FACTORIES].sort(),
    'The set of exported island factories changed.\n' +
      'Added one? Add it to ALL_FACTORIES (and type its bag).\n' +
      'Removed or renamed one? Drop it from ALL_FACTORIES.\n' +
      'Saw NOTHING? The scan is broken — that is exactly what this test is for.',
  );
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
    24,
    `createDrawTools takes a 24-key bag; scan saw ${keys.length}. Update this if the wiring changes.`,
  );
});
