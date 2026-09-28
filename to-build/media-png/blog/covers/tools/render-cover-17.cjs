// Localized cover-17: the English master's layout with Noto, registered under private
// aliases so a system-installed "Noto Sans" cannot shadow the variable font's weights.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const R = process.cwd();
const req = createRequire(path.join(R, 'package.json'));
const sharp = req('sharp');
const { createCanvas, loadImage, GlobalFonts } = req('@napi-rs/canvas');

const FONTS = path.join(R, 'to-build/disclosure-badges/fonts');
const ALIAS = { latin: '"StgInter"', russian: '"StgInterCyr", "StgInter"', chinese: '"StgNotoSC"', japanese: '"StgNotoJP"', korean: '"StgNotoKR"' };
const CJK = new Set(['chinese', 'japanese', 'korean']);
const files = { StgNotoSC: 'NotoSansSC.ttf', StgNotoJP: 'NotoSansJP.ttf', StgNotoKR: 'NotoSansKR.ttf' };
if (!GlobalFonts.registerFromPath(path.join(R, 'public/fonts/inter-latin-700-normal.woff2'), 'StgInter')) throw new Error('inter');
if (!GlobalFonts.registerFromPath(path.join(R, 'public/fonts/inter-cyrillic-700-normal.woff2'), 'StgInterCyr')) throw new Error('inter-cyr');
for (const [alias, file] of Object.entries(files)) {
  if (!GlobalFonts.registerFromPath(path.join(FONTS, file), alias)) throw new Error('font ' + file);
}

const W = 1600, H = 900, TOP = 168, BOT = 812, GAP = 4;
const PW = (W - GAP) / 2, PH = BOT - TOP;
const recipe = JSON.parse(fs.readFileSync(path.join(R, 'to-build/media-png/blog/covers/covers.json'), 'utf8'))['cover-17'];
const MEDIA = path.join(R, 'public/media-webp/blog');

(async () => {
  // Photographs come straight from the English master, so every language shows identical pixels.
  const photos = await sharp(path.join(R, 'to-build/media-png/blog/cover-17.png'))
    .extract({ left: 0, top: TOP, width: W, height: PH }).png().toBuffer();
  const photoImg = await loadImage(photos);

  const langs = fs.readdirSync(path.join(R, 'to-build/media-png/blog/covers/text'))
    .map((f) => f.replace('.json', '')).filter((l) => l !== 'english');
  for (const lang of langs) {
    const s = JSON.parse(fs.readFileSync(path.join(R, 'to-build/media-png/blog/covers/text', lang + '.json'), 'utf8'))['cover-17'];
    const fam = ALIAS[lang] || ALIAS.latin;
    const cv = createCanvas(W, H);
    const ctx = cv.getContext('2d');
    const put = (text, x, y) => { ctx.fillText(text, x, y); if (CJK.has(lang)) { ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.strokeText(text, x, y); } };
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    ctx.drawImage(photoImg, 0, TOP);
    ctx.textBaseline = 'alphabetic';

    const eb = recipe.items[0], hl = recipe.items[1];
    ctx.font = `700 ${eb.size}px ${fam}`; ctx.letterSpacing = `${eb.tracking}px`; ctx.fillStyle = eb.fill;
    put(s.eyebrow.toUpperCase(), eb.x, eb.y);

    let size = hl.size;
    for (; size >= hl.minSize; size--) {
      ctx.font = `700 ${size}px ${fam}`; ctx.letterSpacing = '0px';
      if (ctx.measureText(s.headline).width <= hl.maxW) break;
    }
    ctx.fillStyle = hl.fill; put(s.headline, hl.x, hl.y);

    [recipe.items[2], recipe.items[3]].forEach((item, i) => {
      const [num, lab] = item.runs;
      ctx.font = `700 ${num.size}px ${fam}`; ctx.letterSpacing = '0px'; ctx.fillStyle = num.fill;
      put(num.text, item.x, item.y);
      const w = ctx.measureText(num.text).width;
      ctx.letterSpacing = `${lab.tracking}px`; ctx.fillStyle = lab.fill;
      put(s.labels[i].toUpperCase(), item.x + w + lab.gapBefore, item.y);
    });

    const png = cv.toBuffer('image/png');
    const stem = path.join(MEDIA, `cover-17.${lang}`);
    await sharp(png).webp({ quality: 82 }).toFile(`${stem}.webp`);
    await sharp(png).resize(800).webp({ quality: 80 }).toFile(`${stem}-thumb.webp`);
    await sharp(png).resize(1200, 630, { fit: 'cover' }).jpeg({ quality: 82 }).toFile(`${stem}-og.jpg`);
    console.log(lang, size);
  }
})().catch((e) => { console.error(e); process.exit(1); });
