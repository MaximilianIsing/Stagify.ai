// A kitchen floor plan, and the eye-level photograph the product builds from it.
//
// The "before" is a drawing, not a photograph, so it is not sourced: it is drawn here as
// SVG at exact metric scale. That is what makes the post checkable. The plan and the render
// can be compared feature by feature (window on the far wall over the sink, the L run on the
// left, the hob on that run, the island in the middle), and a reviewer has a ground truth
// to compare against rather than a stock blueprint of unknown provenance.
//
// The "after" is a genuine blueprintTo3D render (view: eye-level), the same function the
// chat route calls. Up to three full runs, keeping the best, because each run is already the
// product's own three-attempt retry loop with the QA gate switched on.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { createStagifyImages } from '../../../lib/images/stagify.js';
import { createAcquire } from '../../../lib/images/acquire.js';
import { loadConfig } from '../../../lib/history/store.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── The plan, in metres. Interior origin at the inside top-left corner. ──────────────────
const W = 4.8;           // interior width
const D = 4.2;           // interior depth
const T = 0.2;           // wall thickness
const PAPER = '#fbfaf7';
const INK = '#1d232b';
const FILL = '#e7e3da';

export function planSvg({ scale, ox, oy, width, height, dims = true }) {
  const m = (v) => (v * scale).toFixed(1);
  const X = (v) => (ox + v * scale).toFixed(1);
  const Y = (v) => (oy + v * scale).toFixed(1);
  const rect = (x, y, w, h, extra = '') =>
    `<rect x="${X(x)}" y="${Y(y)}" width="${m(w)}" height="${m(h)}" ${extra}/>`;
  const line = (x1, y1, x2, y2, extra = '') =>
    `<line x1="${X(x1)}" y1="${Y(y1)}" x2="${X(x2)}" y2="${Y(y2)}" ${extra}/>`;
  const circle = (cx, cy, r, extra = '') =>
    `<circle cx="${X(cx)}" cy="${Y(cy)}" r="${m(r)}" ${extra}/>`;
  const pen = `stroke="${INK}" stroke-width="${Math.max(1.5, scale * 0.012).toFixed(1)}"`;
  const stroke = `${pen} fill="none"`;
  const thin = `stroke="${INK}" stroke-width="${Math.max(1, scale * 0.007).toFixed(1)}" fill="none"`;
  const font = (size) => `font-family="Inter, Arial, sans-serif" font-size="${(size * scale).toFixed(1)}" fill="${INK}"`;

  const parts = [];
  parts.push(`<rect width="${width}" height="${height}" fill="${PAPER}"/>`);

  // Walls: solid ink band around the interior.
  parts.push(rect(-T, -T, W + 2 * T, D + 2 * T, `fill="${INK}"`));
  parts.push(rect(0, 0, W, D, `fill="${PAPER}"`));

  // Window in the north wall, 1.8 m, centred over the sink.
  const winX = 1.8; const winW = 1.8;
  parts.push(rect(winX, -T, winW, T, `fill="${PAPER}"`));
  parts.push(line(winX, -T, winX + winW, -T, thin));
  parts.push(line(winX, -T / 2, winX + winW, -T / 2, thin));
  parts.push(line(winX, 0, winX + winW, 0, thin));
  parts.push(line(winX, -T, winX, 0, thin));
  parts.push(line(winX + winW, -T, winX + winW, 0, thin));

  // Door in the east wall, 0.9 m, swinging in.
  const doorY = 2.9; const doorW = 0.9;
  parts.push(rect(W, doorY, T, doorW, `fill="${PAPER}"`));
  parts.push(line(W, doorY, W - doorW, doorY, stroke));
  parts.push(`<path d="M ${X(W - doorW)} ${Y(doorY)} A ${m(doorW)} ${m(doorW)} 0 0 0 ${X(W)} ${Y(doorY + doorW)}" ${thin} stroke-dasharray="${m(0.06)} ${m(0.05)}"/>`);

  // North run: full width, 0.6 m deep. West run: down the left wall to 3.0 m.
  parts.push(rect(0.6, 0, W - 0.6, 0.6, `fill="${FILL}" ${pen}`));
  parts.push(rect(0, 0, 0.6, 3.0, `fill="${FILL}" ${pen}`));
  // Tall fridge unit at the end of the west run.
  parts.push(rect(0, 2.3, 0.65, 0.7, `fill="${FILL}" ${pen}`));
  parts.push(line(0, 2.3, 0.65, 3.0, thin));
  parts.push(line(0.65, 2.3, 0, 3.0, thin));

  // Double sink under the window.
  parts.push(rect(2.15, 0.08, 0.5, 0.42, `rx="${m(0.05)}" ${thin}`));
  parts.push(rect(2.75, 0.08, 0.5, 0.42, `rx="${m(0.05)}" ${thin}`));

  // Hob on the west run: four rings.
  for (const [cx, cy] of [[0.18, 1.05], [0.42, 1.05], [0.18, 1.35], [0.42, 1.35]]) {
    parts.push(circle(cx, cy, 0.09, thin));
  }

  // Island, 2.2 by 1.0 m, centred on the window.
  parts.push(rect(1.6, 1.8, 2.2, 1.0, `fill="${FILL}" ${pen}`));

  parts.push(`<text x="${X(1.9)}" y="${Y(3.6)}" text-anchor="middle" letter-spacing="${(0.04 * scale).toFixed(1)}" ${font(0.2)}>KITCHEN</text>`);

  if (dims) {
    // Width above the plan, depth to its left.
    const dy = -0.5;
    parts.push(line(0, dy, W, dy, thin));
    parts.push(line(0, dy - 0.08, 0, dy + 0.08, thin));
    parts.push(line(W, dy - 0.08, W, dy + 0.08, thin));
    parts.push(`<text x="${X(W / 2)}" y="${Y(dy - 0.1)}" text-anchor="middle" ${font(0.17)}>4.80 m</text>`);
    const dx = -0.5;
    parts.push(line(dx, 0, dx, D, thin));
    parts.push(line(dx - 0.08, 0, dx + 0.08, 0, thin));
    parts.push(line(dx - 0.08, D, dx + 0.08, D, thin));
    parts.push(`<text x="${X(dx - 0.12)}" y="${Y(D / 2)}" text-anchor="middle" transform="rotate(-90 ${X(dx - 0.12)} ${Y(D / 2)})" ${font(0.17)}>4.20 m</text>`);
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join('')}</svg>`;
}

// The model's input: the plan alone, tight, at 160 px per metre.
export async function planForModel() {
  const scale = 160; const margin = 1.0;
  const width = Math.round((W + 2 * margin) * scale);
  const height = Math.round((D + 2 * margin) * scale);
  return sharp(Buffer.from(planSvg({ scale, ox: margin * scale, oy: margin * scale, width, height })))
    .png().toBuffer();
}


// Round 2. Round 1 (images-round1.json) came back with the island turned 90 degrees and
// its worktop sheared off the base, seen from the door corner. A square-on view from the
// middle of the opposite wall makes the island's orientation unmistakable.
const ADDITIONAL = 'Style it midcentury modern: flat slab walnut cabinetry, a warm white '
  + 'terrazzo floor, a white quartz worktop, mustard yellow accents in a pendant shade and a '
  + 'tea towel, brass handles. No bar stools, no chairs and no seating of any kind anywhere '
  + 'in the room. The island is a simple rectangular box 2.2 m long and 1.0 m deep, its LONG '
  + 'side parallel to the window wall, square to the room, centred in front of the sink, with '
  + 'the worktop sitting centred on its base and an equal small overhang on every side. Stand '
  + 'against the middle of the wall opposite the window and look straight at the window wall, '
  + 'so the island is seen broadside in the foreground, the window with the double sink under '
  + 'it is centred behind it, and the run with the hob is on the left.';

async function main() {
  const config = loadConfig(REPO_ROOT);
  const stagify = createStagifyImages({ config });
  const acquire = createAcquire({ config, repoRoot: REPO_ROOT, stagify, stock: null, fal: null });

  const planBuf = await planForModel();
  const planStored = await acquire.store(planBuf, 'image/png');
  console.log('plan (model input):', planStored.url);

  const runs = [];
  for (let i = 1; i <= 3; i += 1) {
    console.log(`\nrun ${i}: blueprintTo3D eye-level kitchen`);
    const started = Date.now();
    try {
      const r = await stagify.blueprintRender({
        blueprintBuffer: planBuf, mimeType: 'image/png', view: 'eye-level', room: 'kitchen',
        additionalPrompt: ADDITIONAL,
      });
      const stored = await acquire.store(r.buffer, r.mime);
      runs.push({ run: i, url: stored.url, sha256: stored.hash, width: stored.width, height: stored.height,
        quality: r.quality, params: r.params, model: r.model, seconds: Math.round((Date.now() - started) / 1000) });
      console.log(`  -> ${stored.url} perfect=${r.quality.perfect} best=${r.quality.bestScore} attempts=${r.quality.attempts}`);
      if (r.quality.defects.length) console.log('  defects:', r.quality.defects);
      if (r.quality.perfect) break;
    } catch (err) {
      console.log(`  run ${i} failed: ${err.message}`);
      runs.push({ run: i, error: err.message });
    }
  }

  const ok = runs.filter((r) => !r.error);
  const best = ok.sort((a, b) => Number(b.quality.perfect) - Number(a.quality.perfect)
    || (b.quality.bestScore ?? 0) - (a.quality.bestScore ?? 0))[0] ?? null;

  const out = {
    planForModel: { url: planStored.url, sha256: planStored.hash, width: planStored.width, height: planStored.height },
    additionalPrompt: ADDITIONAL,
    runs,
    best,
  };
  fs.writeFileSync(path.join(HERE, 'images.json'), `${JSON.stringify(out, null, 2)}\n`);
  console.log('\nbest:', best ? `${best.url} perfect=${best.quality.perfect} score=${best.quality.bestScore}` : 'none');
}

// Importable: compose-frames.js reuses the drawing without re-rendering.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
