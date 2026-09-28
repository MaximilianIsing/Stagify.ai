// Authors the ENGLISH cover-17 in cover-16's layout: white header (eyebrow + headline),
// two photographs edge to edge, white footer with numbered labels. Inter, like cover-16.
const path = require('path');
const { createRequire } = require('module');
const R = process.cwd();
const req = createRequire(path.join(R, 'package.json'));
const sharp = req('sharp');
const { createCanvas, loadImage, GlobalFonts } = req('@napi-rs/canvas');

for (const w of ['700']) {
  const ok = GlobalFonts.registerFromPath(path.join(R, `public/fonts/inter-latin-${w}-normal.woff2`), 'Inter');
  if (!ok) throw new Error('Inter did not register');
}

const W = 1600, H = 900, TOP = 168, BOT = 812, GAP = 4;
const PW = (W - GAP) / 2, PH = BOT - TOP;
const EX = path.join(R, 'public/media-webp/example');

async function panel(file) {
  // Same crop box for both, so the room lines up across the pair.
  const sw = 1872, sh = 1248, cw = Math.round(sh * PW / PH), left = 235;
  return sharp(path.join(EX, file)).extract({ left, top: 0, width: cw, height: sh }).resize(PW, PH).png().toBuffer();
}

(async () => {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.drawImage(await loadImage(await panel('Original-1872.webp')), 0, TOP);
  ctx.drawImage(await loadImage(await panel('modern-living-room-1872.webp')), PW + GAP, TOP);

  ctx.textBaseline = 'alphabetic';
  ctx.font = '700 25px "Inter"'; ctx.letterSpacing = '3.4px'; ctx.fillStyle = '#2563eb';
  ctx.fillText('BEFORE & AFTER', 64, 62);
  ctx.font = '700 54px "Inter"'; ctx.letterSpacing = '0px'; ctx.fillStyle = '#0f1729';
  ctx.fillText('Same room. Nothing retouched.', 64, 136);

  const label = (x, n, text) => {
    ctx.font = '700 30px "Inter"'; ctx.letterSpacing = '0px'; ctx.fillStyle = '#2563eb';
    ctx.fillText(n, x, 860);
    const w = ctx.measureText(n).width;
    ctx.letterSpacing = '2.2px'; ctx.fillStyle = '#0f1729';
    ctx.fillText(text, x + w + 18, 860);
  };
  label(64, '01', 'BEFORE');
  label(PW + GAP + 64, '02', 'AFTER');

  const png = canvas.toBuffer('image/png');
  await sharp(png).toFile(path.join(R, 'to-build/media-png/blog/cover-17.png'));
  await sharp(png).webp({ quality: 82 }).toFile(path.join(R, 'public/media-webp/blog/cover-17.webp'));
  await sharp(png).resize(1200, 630, { fit: 'cover' }).jpeg({ quality: 85, mozjpeg: true }).toFile(path.join(R, 'public/media-webp/blog/cover-17-og.jpg'));
  console.log('ok');
})().catch((e) => { console.error(e); process.exit(1); });
