// A module-resolution hook that teaches node the browser's root-absolute specifiers.
//
// WHY: some frontend modules load a shared slice by its SERVED path rather than a
// relative one — public/scripts/masking-studio/generate-pipeline.js does
// `import('/scripts/mask-core.js')`. In a browser that is the same file every page
// already has cached. Under node it resolves against the filesystem root
// (`C:\scripts\mask-core.js` on Windows) and rejects with ERR_MODULE_NOT_FOUND, which
// takes the whole island down with it: the factory stores that rejected promise and
// every path that awaits it throws.
//
// Rewriting the source to a relative specifier would work in both, but the two are
// NOT equivalent under the localized URL prefixes — a page at /es/ pulls its scripts
// from /es/scripts/, and a relative specifier would resolve to a second copy of
// mask-core there while the absolute one keeps everyone on the single root module.
// So the browser behaviour is deliberate and the test environment is what has to
// adapt.
//
// Register it from a test file BEFORE the module under test does its dynamic import:
//
//   import { register } from 'node:module';
//   register('../helpers/browser-abs-specifier.mjs', import.meta.url);
//
// node:test runs each test file in its own process, so the hook stays scoped to the
// file that asks for it.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, '..', '..', 'public');

/** Map `/scripts/x.js` (and any other root-absolute asset) into public/. */
export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('/') && !specifier.startsWith('//')) {
    const onDisk = path.join(PUBLIC, specifier);
    return nextResolve(pathToFileURL(onDisk).href, context);
  }
  return nextResolve(specifier, context);
}
