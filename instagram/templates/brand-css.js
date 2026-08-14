// Pulls the brand's real tokens and real Inter faces out of the live site stylesheet at
// render time, so a post can never drift from the site.
//
// The alternative — copying the hex values into a file here — is how you end up with a
// post in last quarter's blue. This reads `public/styles/styles.css`, which
// test/frontend/css-tokens.test.js already guards as the token source of truth.
//
// It deliberately extracts ONLY the :root block and the Inter @font-face rules, not the
// whole sheet: styles.css also sets body backgrounds, resets and page chrome that would
// fight a 1080x1350 poster layout.
//
// Everything here throws rather than degrading. A missing token block would render a post
// with `var()` fallbacks silently, and per docs the bare-var() failure mode is that the
// whole declaration is dropped, which is exactly the kind of quiet wrongness that ships.
import fs from 'node:fs';
import path from 'node:path';

const SITE_STYLESHEET = 'public/styles/styles.css';

// Latin and latin-ext only. Posts are English; the cyrillic/greek/vietnamese subsets are
// dead weight in a renderer that never paints them.
const WANTED_FACE = /inter-latin(?:-ext)?-(?:400|600|700)-normal\.woff2/;
const EXPECTED_FACES = 6; // 2 subsets x 3 weights

/**
 * @param {string} repoRoot absolute path to the repository root
 * @returns {string} CSS: the Inter @font-face rules followed by the :root token block
 */
export function readBrandCss(repoRoot) {
  const sheetPath = path.join(repoRoot, SITE_STYLESHEET);
  const src = fs.readFileSync(sheetPath, 'utf8');

  // The :root block contains comments but no nested braces, so a lazy match to the first
  // `}` is the whole block. If that ever stops being true this throws on the next line
  // instead of silently truncating.
  const rootMatch = src.match(/:root\s*\{[^{}]*\}/);
  if (!rootMatch) {
    throw new Error(`No :root token block found in ${SITE_STYLESHEET}. The token source moved.`);
  }
  if (!rootMatch[0].includes('--brand:')) {
    throw new Error(`The :root block in ${SITE_STYLESHEET} has no --brand token. Extraction is wrong.`);
  }

  const faces = [...src.matchAll(/@font-face\s*\{[^{}]*\}/g)]
    .map((m) => m[0])
    .filter((block) => WANTED_FACE.test(block));

  if (faces.length !== EXPECTED_FACES) {
    throw new Error(
      `Expected ${EXPECTED_FACES} Inter @font-face rules in ${SITE_STYLESHEET}, found ${faces.length}. ` +
      'The font set changed; update WANTED_FACE.',
    );
  }

  // The sheet lives at /public/styles/, so its `../fonts/x.woff2` means /public/fonts/x.woff2.
  // We inline these rules into the post document, whose base is `/`, so the relative URL has
  // to be rewritten or every face 404s and the text silently renders in a fallback stack.
  const rewritten = faces.map((block) => {
    const out = block.replace(/\.\.\/fonts\//g, '/public/fonts/');
    if (out.includes('../fonts/')) {
      throw new Error('Font URL rewrite missed a path.');
    }
    return out;
  });

  return [
    `/* extracted from ${SITE_STYLESHEET} at render time — do not hand-edit */`,
    ...rewritten,
    rootMatch[0],
  ].join('\n');
}
