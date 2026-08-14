// Turn a post record into files on disk.
//
// Output contract per format:
//   out/<format>.jpg    1080-wide, what you upload
//   full/<format>.webp  the 2x archive, q95, committed
//   thumb.jpg           400px, what the reviewer and the next run's sameness check read
//
// WebP q95 rather than PNG for the archive: these are flat-design posters over photos, so
// q95 is visually lossless, and the repo's existing hand-made posts are 5 to 7 MB of PNG
// each. At one post a day that difference is the whole clone weight budget.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
import { FRAME } from '../../templates/_macros.js';
import { readBrandCss } from '../../templates/brand-css.js';
import { assertHtmlClean, assertCopyClean } from '../validate/rules.js';

const THUMB_WIDTH = 400;
const UPLOAD_QUALITY = 92;
const ARCHIVE_QUALITY = 95;

/**
 * @param {string} repoRoot
 * @param {string} templateId
 */
/**
 * Load a template module.
 *
 * `meta` lives in template.js rather than a sibling meta.json on purpose: two copies of the
 * same facts drift, and the format list in particular is load bearing (post.js refuses a
 * format the template does not declare). One definition cannot disagree with itself.
 * `bin/templates.js --list` exists so the library is still browsable without executing
 * anything by hand.
 */
export async function loadTemplate(repoRoot, templateId) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(templateId)) {
    throw new Error(`Bad template id: ${templateId}`);
  }
  const file = path.join(repoRoot, 'instagram', 'templates', templateId, 'template.js');
  const mod = await import(pathToFileURL(file).href);
  if (typeof mod.render !== 'function') {
    throw new Error(`Template ${templateId} does not export render()`);
  }
  if (!mod.meta?.formats?.length) {
    throw new Error(`Template ${templateId} does not export meta.formats`);
  }
  if (mod.meta.id !== templateId) {
    throw new Error(`Template ${templateId} declares meta.id "${mod.meta.id}". They must match.`);
  }
  return { meta: mod.meta, render: mod.render };
}

/** Every template on disk, with its metadata. */
export async function loadTemplates(repoRoot) {
  const dir = path.join(repoRoot, 'instagram', 'templates');
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const ids = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
    .map((e) => e.name)
    .sort();
  return Promise.all(ids.map((id) => loadTemplate(repoRoot, id)));
}

/**
 * How many slides this carousel has.
 *
 * The template declares the legal range and the data decides within it, because a template
 * that always emits eight slides cannot express a three-slide idea. Out-of-range throws
 * rather than clamping: silently dropping slide seven would lose content the copy refers to.
 */
function resolveSlideCount(meta, data) {
  const [min, max] = meta.slides ?? [1, 1];
  const asked = data.slides?.length ?? data.slideCount ?? min;
  if (asked < min || asked > max) {
    throw new Error(
      `Template ${meta.id} supports ${min} to ${max} slides but the data asks for ${asked}.`,
    );
  }
  return asked;
}

/**
 * @param {object} record a post record (see history/posts.jsonl schema)
 * @param {{ repoRoot: string, outDir: string, renderer: import('./capture.js').Renderer, formats?: string[] }} ctx
 * @returns {Promise<{ files: string[], formats: string[] }>}
 */
export async function renderPost(record, { repoRoot, outDir, renderer, formats }) {
  const { meta, render } = await loadTemplate(repoRoot, record.template);
  const wanted = formats ?? record.formats ?? ['single'];

  const unsupported = wanted.filter((f) => !meta.formats.includes(f));
  if (unsupported.length) {
    throw new Error(
      `Template ${record.template} supports [${meta.formats.join(', ')}] but was asked for [${unsupported.join(', ')}].`,
    );
  }

  // Gate the copy before spending a render on it.
  assertCopyClean(record.copy ?? {}, `${record.id} copy`);
  assertCopyClean(record.data ?? {}, `${record.id} data`);

  await fs.mkdir(path.join(outDir, 'out'), { recursive: true });
  await fs.mkdir(path.join(outDir, 'full'), { recursive: true });

  const brandCss = readBrandCss(repoRoot);
  const written = [];
  const data = record.data ?? record;

  for (const format of wanted) {
    const frame = FRAME[format];
    const slideCount = format === 'carousel' ? resolveSlideCount(meta, data) : 1;

    for (let slideIndex = 0; slideIndex < slideCount; slideIndex += 1) {
      const html = render(data, { format, brandCss, slideIndex, slideCount });
      const label = slideCount > 1
        ? `${format}-${String(slideIndex + 1).padStart(2, '0')}`
        : format;
      assertHtmlClean(html, `${record.id} rendered ${label}`);

      const png = await renderer.shot(html, { ...frame, id: `${record.id}-${label}` });

      const uploadPath = path.join(outDir, 'out', `${label}.jpg`);
      await sharp(png)
        .resize(frame.width, frame.height, { fit: 'fill' })
        .jpeg({ quality: UPLOAD_QUALITY, chromaSubsampling: '4:4:4' })
        .toFile(uploadPath);

      const archivePath = path.join(outDir, 'full', `${label}.webp`);
      await sharp(png).webp({ quality: ARCHIVE_QUALITY }).toFile(archivePath);

      written.push(uploadPath, archivePath);
    }
  }

  // The thumbnail is the sameness check's only input, so it comes from the first image the
  // viewer actually sees: slide one of a carousel, or the single frame otherwise.
  const primary = path.basename(written[0], '.jpg');
  const thumbPath = path.join(outDir, 'thumb.jpg');
  await sharp(path.join(outDir, 'out', `${primary}.jpg`))
    .resize({ width: THUMB_WIDTH })
    .jpeg({ quality: 82 })
    .toFile(thumbPath);
  written.push(thumbPath);

  return { files: written, formats: wanted };
}
