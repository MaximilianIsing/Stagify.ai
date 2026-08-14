// One interface over every image source, plus the content-addressed store.
//
// A post needs a believable "before" room and a real Stagify "after". The before is the
// hard part: the repo's own media is already all over the site, so reusing it makes posts
// look like reruns. Three ways to get a fresh one, tried in order of how convincing the
// result is:
//
//   1. Free-license stock. A real photograph of a real empty room. Most convincing, and it
//      costs nothing but a search.
//   2. fal.ai. Photoreal generation when stock has nothing matching the brief.
//   3. Gemini text to image. Always available, no extra key, slightly more likely to read
//      as generated.
//
// The "after" is always a genuine processStaging render. That is not negotiable: a post
// advertising the product should contain the product's actual output.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

const EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif',
};

export function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * @param {{ config: object, repoRoot: string, stagify: object,
 *           stock: object|null, fal: object|null }} deps
 */
export function createAcquire({ config, repoRoot, stagify, stock, fal }) {
  const storeDir = path.join(repoRoot, 'instagram', 'assets', 'sources');

  /**
   * Write bytes into the content-addressed store, deduplicated forever.
   * The same photograph fetched twice occupies one file and keeps one hash, which is what
   * makes "never reuse a source photo" enforceable across the whole history.
   */
  async function store(buffer, mime = 'image/jpeg') {
    const hash = sha256(buffer);
    const ext = EXT_BY_MIME[mime] ?? 'jpg';
    const file = path.join(storeDir, `${hash}.${ext}`);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(storeDir, { recursive: true });
      fs.writeFileSync(file, buffer);
    }
    const meta = await sharp(buffer).metadata();
    return {
      hash,
      path: file,
      // Repo-root-relative URL, which is what the renderer's asset server serves.
      url: `/instagram/assets/sources/${hash}.${ext}`,
      width: meta.width,
      height: meta.height,
      bytes: buffer.length,
    };
  }

  /**
   * Find an empty room photo matching the brief.
   * @param {{ query: string, prompt: string, orientation?: string, usedHashes?: Set<string> }} brief
   * @returns {Promise<{ buffer: Buffer, mime: string, license: object, origin: string }>}
   */
  // Takes the whole brief rather than destructuring it away. The relevance screen below
  // needs brief.roomType and brief.wants, and this used to destructure only the four
  // fields it read directly, leaving `brief` unbound at that call. The resulting
  // ReferenceError landed inside the stock try/catch and was reported as an ordinary
  // "stock: ..." miss, so stock silently failed for EVERY post and every run fell through
  // to fal or Gemini. A generated room is the fallback by design, not the default.
  async function acquireBefore(brief) {
    const { query, prompt, orientation = 'portrait', usedHashes = new Set() } = brief;
    const attempts = [];

    if (stock && (stock.available.pexels || stock.available.unsplash)) {
      try {
        const candidates = await stock.search(query, { orientation });
        for (const candidate of candidates) {
          const got = await stock.download(candidate);
          if (usedHashes.has(sha256(got.buffer))) continue; // already used in an earlier post

          // The product's own upload gate, reused. If Stagify would reject this photo from
          // a customer, it has no business in a post advertising Stagify.
          if (stagify.available.gemini) {
            const verdict = await stagify.validateSource(got.buffer).catch(() => null);
            if (verdict && verdict.stageable === false) {
              attempts.push(`stock ${candidate.id}: rejected by the upload gate (${verdict.category ?? 'unstageable'})`);
              continue;
            }
          }

          // Then the question the upload gate does not ask: is this the room we asked for.
          // A macro shot of wrapped boxes passes "could Stagify stage this" and then gets
          // staged into a room bearing no relation to it, which is a false before and after.
          const fit = await stagify.fitsBrief(got.buffer, { roomType: brief.roomType, wants: brief.wants ?? '' })
            .catch((error) => ({ ok: false, reason: error.message }));
          if (!fit.ok) {
            attempts.push(`stock ${candidate.id}: does not fit the brief (${fit.reason})`);
            continue;
          }
          if (fit.skipped) attempts.push('warning: relevance was not checked, no GPT_KEY');

          return { buffer: got.buffer, mime: 'image/jpeg', license: got.license, origin: got.provider };
        }
        attempts.push(`stock: ${candidates.length} candidates, none usable`);
      } catch (error) {
        attempts.push(`stock: ${error.message}`);
      }
    } else {
      attempts.push('stock: no PEXELS_API_KEY or UNSPLASH_ACCESS_KEY');
    }

    if (fal) {
      try {
        const generated = await fal.generate(config.models.fal, {
          prompt,
          image_size: orientation === 'portrait' ? 'portrait_4_3' : 'landscape_4_3',
          num_images: 1,
        });
        return {
          buffer: generated.buffer,
          mime: generated.mime,
          origin: 'fal',
          license: {
            type: 'generated', licenseName: 'Generated by fal.ai, no third-party rights',
            attributionRequired: false, model: generated.model, prompt,
            retrievedAt: new Date().toISOString(),
          },
        };
      } catch (error) {
        attempts.push(`fal: ${error.message}`);
      }
    } else {
      attempts.push('fal: no FAL_KEY');
    }

    try {
      const generated = await stagify.generate(prompt);
      return {
        buffer: generated.buffer,
        mime: generated.mime,
        origin: 'gemini',
        license: {
          type: 'generated', licenseName: 'Generated by Google Gemini, no third-party rights',
          attributionRequired: false, model: generated.model, prompt,
          retrievedAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      attempts.push(`gemini: ${error.message}`);
    }

    throw new Error(`Could not source a "before" photo. Tried:\n  ${attempts.join('\n  ')}`);
  }

  return {
    store,
    acquireBefore,

    /**
     * The whole pair, ready to hand to a template.
     *
     * Retries with a DIFFERENT source photo when the render fails QA rather than rerolling
     * the same one. processStaging already retried three times internally against this
     * photo; a fourth roll of the same dice is unlikely to help, whereas a room with
     * clearer geometry usually renders cleanly. Awkward source photos are the common cause
     * of warped furniture.
     *
     * @param {object} brief
     * @param {{ maxSourceAttempts?: number }} opts
     * @returns {Promise<{ before: object, after: object, provenance: object[], quality: object }>}
     */
    async acquirePair(brief, { maxSourceAttempts = 2 } = {}) {
      const tried = new Set(brief.usedHashes ?? []);
      let best = null;
      let attemptsMade = 0;

      for (let attempt = 1; attempt <= maxSourceAttempts; attempt += 1) {
        attemptsMade = attempt;
        const sourced = await acquireBefore({ ...brief, usedHashes: tried });
        tried.add(sha256(sourced.buffer));

        const staged = await stagify.stage({
          sourceBuffer: sourced.buffer,
          roomType: brief.roomType,
          furnitureStyle: brief.style,
          additionalPrompt: brief.additionalPrompt,
          removeFurniture: brief.removeFurniture ?? false,
          promptOverride: brief.promptOverride,
          // Furniture the post claims the customer already owns. Null unless the brief
          // says otherwise, so an ordinary pair is still staged from presets alone.
          furnitureBuffers: brief.furnitureBuffers,
          // Undefined by design, which leaves stage() on its own default of
          // config.models.staging. The ONLY reason this passthrough exists is a post whose
          // subject is the free tier: getGeminiImageModel (lib/config/model-config.js) maps
          // a free account to gemini-2.5-flash-image and a Stagify+ account to
          // gemini-3.1-flash-image, so a post claiming "this is what free gives you" while
          // showing a 3.1 render is a false advertisement. Set it ONLY when the model the
          // render came from is itself part of the claim. Everywhere else, leave it alone:
          // rule 3 says never trade quality for a cheaper call.
          model: brief.model,
          // The disclosure lives in template chrome for these posts, matching what 07-25
          // and 07-27 already do, so a burned-in badge would repeat the same claim twice.
          labelVirtuallyStaged: brief.labelVirtuallyStaged ?? false,
        });

        const candidate = { sourced, staged, attempt };
        if (staged.quality.perfect) { best = candidate; break; }
        if (!best || (staged.quality.bestScore ?? 0) > (best.staged.quality.bestScore ?? 0)) {
          best = candidate;
        }
      }

      const { sourced, staged } = best;
      const before = await store(sourced.buffer, sourced.mime);
      const after = await store(staged.buffer, staged.mime);

      return {
        before: { ...before, role: 'before', origin: sourced.origin },
        after: { ...after, role: 'after', origin: 'stagify' },
        // Surfaced, never swallowed. A post built on a render the reviewer flagged is
        // something the image reviewer subagent and the user should both get to see.
        // sourcePhotosTried is how many different photos were attempted; keptAttempt is
        // which one won. Conflating them reads as "it only tried once" when it did not.
        quality: { ...staged.quality, sourcePhotosTried: attemptsMade, keptAttempt: best.attempt },
        provenance: [
          { role: 'before', hash: before.hash, source: sourced.origin, license: sourced.license },
          {
            role: 'after', hash: after.hash, source: 'stagify',
            license: { type: 'generated', licenseName: 'Stagify render', attributionRequired: false },
            generation: {
              fn: 'processStaging', model: staged.model, params: staged.params,
              quality: staged.quality,
            },
          },
        ],
      };
    },
  };
}
