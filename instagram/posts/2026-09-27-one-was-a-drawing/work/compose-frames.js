// Lay the plan and the render out for the diagonal wipe (leftY 66, rightY 36).
//
// The template cover-fits both images to 1080 by 1350. For the plan that would scale the
// drawing, and for a 3:2 render it crops to the middle 53 per cent, which on the first pass
// left the island filling the frame with the hob and pendant cut away. So both frames are
// composed here at the frame's own size and the template's cover-fit becomes a no-op.
//
//  * Before: the SAME drawing the model was given (planSvg, identical geometry), at 100 px
//    per metre, placed so the whole plan, door included, sits above the wipe. The wipe's
//    lowest point under the plan is its bottom right outer corner (600, 640); the line
//    there is at y 666.
//  * After: the render scaled, never stretched, to 880 px tall and placed at the bottom of
//    the sheet. Everything above y 470 is behind the plan wedge (the wipe is at y 486 at
//    its highest), so the strip above it is filled with the render's own top row and is
//    never seen.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { planSvg } from './build-images.js';
import { createAcquire } from '../../../lib/images/acquire.js';
import { loadConfig } from '../../../lib/history/store.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const W = 1080; const H = 1350;

const images = JSON.parse(fs.readFileSync(path.join(HERE, 'images.json'), 'utf8'));
// Round 2's best: square-on, QA perfect, and checked by eye against the plan.
const RENDER = images.best;
if (!RENDER) throw new Error('no usable render in images.json');

const acquire = createAcquire({ config: loadConfig(REPO_ROOT), repoRoot: REPO_ROOT, stagify: null, stock: null, fal: null });

const before = await sharp(Buffer.from(planSvg({ scale: 100, ox: 100, oy: 200, width: W, height: H })))
  .png().toBuffer();

const renderFile = path.join(REPO_ROOT, RENDER.url.replace(/^\//, ''));
const AFTER_H = 880;
const scaled = await sharp(renderFile).resize({ height: AFTER_H }).toBuffer({ resolveWithObject: true });
// Horizontal crop: keep the hob on the left run and the window on the right in frame.
const left = Math.round((scaled.info.width - W) * 0.45);
const band = await sharp(scaled.data).extract({ left, top: 0, width: W, height: AFTER_H }).toBuffer();
const topRow = await sharp(band).extract({ left: 0, top: 0, width: W, height: 1 })
  .resize({ width: W, height: H - AFTER_H, fit: 'fill' }).toBuffer();
const after = await sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } })
  .composite([{ input: topRow, top: 0, left: 0 }, { input: band, top: H - AFTER_H, left: 0 }])
  .webp({ quality: 92 }).toBuffer();

const b = await acquire.store(before, 'image/png');
const a = await acquire.store(after, 'image/webp');
images.frames = {
  diagonal: { leftY: 66, rightY: 36 },
  before: { url: b.url, sha256: b.hash },
  after: { url: a.url, sha256: a.hash, fromRender: RENDER.sha256, scaledHeight: AFTER_H, cropLeft: left },
};
fs.writeFileSync(path.join(HERE, 'images.json'), `${JSON.stringify(images, null, 2)}\n`);
console.log('before', b.url);
console.log('after ', a.url);
