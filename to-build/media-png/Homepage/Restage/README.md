# Restage section — source masters

Masters for the home page's `#restage` section ("Press it again. Get a different room.").
Served copies live in `public/media-webp/Homepage/Restage/`.

## What's here

- **`empty.png`** — the lossless master for `empty.webp`, the un-staged room the whole
  section is built on. Generated with Fal.ai `flux/dev` at 1216×832. Chosen from six
  candidates for being *stylistically uncommitted*: plain walls, warm oak, no period
  detail, a big blank focal wall, generous clear floor, and no hard shadow pattern where
  furniture goes — all of which matter because dozens of different stagings have to look
  plausible in it.

- **`r01.png`–`r100.png`** — the 100 staged renders, one per pool image. Kept so the set can be
  re-cropped, recolored or re-exported at a different quality without going back through the
  model. (`r100` is the one three-digit name in a two-digit set; the disk-vs-list test sorts
  both sides the same way, so it lines up regardless.)

## What `r01`–`r100` are, and what they are not

**They are pixel-identical copies of the served WebP, not a higher-fidelity source.** Read that
before treating them like the other masters in `to-build/`, because the direction of truth is
reversed here:

- Everywhere else in `to-build/media-png/`, the PNG came first and the WebP is its lossy export.
- Here the WebP came first. The generator piped model output straight into
  `sharp().resize(1216, 832).webp({ quality: 74 })`; the pre-encode bytes were never written to
  disk, so the served WebP *is* as far back as the chain goes.
- So each PNG is a lossless *container* of already-lossy pixels — ~19× the bytes for exactly the
  same image. It buys editability, not detail. Sharpening or upscaling one will amplify WebP
  artifacts, not recover anything.

**The served WebP is the only copy of every render's pixels.** The first sixty were once
mirrored as `pNN-*.webp` inside `studio-section-concepts/`, a prototype folder that has since
been deleted; batches 2–4 were never mirrored there. Nothing is lost by that — those files
were byte-identical duplicates of what `public/media-webp/Homepage/Restage/` already serves,
and the eight belonging to replaced slots had stopped matching anything shipped. The recipes
behind all of them survive in `manifest.json`, where the retired rows are marked
`supersededBy`.

`empty.png` is the exception: it is a genuine lossless master, and `empty.webp` is its export.

**The reproduction path is the generator, not these files.** `tools/generate.mjs` grows or
repairs the pool, and `manifest.json` records the exact style and six variation axes behind
every render ever shipped. Both sit in this folder — see `tools/README.md`.

```
node to-build/media-png/Homepage/Restage/tools/generate.mjs --add 20
```

## If you regenerate

Four checks are not optional. Only the first has a numeric screen; the two after it are
invisible until you compare a full-size render against the source, which is why growing this
pool costs a human look at every image.

1. **Architecture drift — and measure it the right way.** The doorway recess in the left
   wall is what the model destroys, in two different directions:
   - it walls the recess over with flat wall plus pale artwork, which makes that box
     *brighter*; or
   - it hangs a dark canvas, mirror or bookcase across it, or parks a plant in the opening,
     which makes it *darker*.

   **A mean-luminance threshold only catches the first.** The original note here prescribed
   exactly that (box x 215..300 / y 250..540, source 162, healthy median 153, failures
   181–205) — and when the six worst renders in the shipped pool were re-measured, four of
   them scored *below* the median, because something dark was covering the doorway. Compare
   against the source instead: mean absolute difference over box x 205..305 / y 200..580 put
   all six in the top seven of sixty. Batch 2 gated on MAD ≤ 26 (median 16, and 24 of 26
   cleared it first try). Anything over ~40 needs eyes; it is not automatically wrong, since
   a console table legitimately standing beside the opening also scores there.

2. **Other architecture changes the doorway box cannot see — check by eye.** One batch-4
   render kept the doorway perfectly (a healthy MAD 25.3) and then recoloured the oak floor
   to dark brown across half the frame and added louvred shutters to the window. A
   floor-region diff is not a usable screen for this, because a staged room's floor is mostly
   under a rug — it would fire on every render. Scan each render against the source for the
   floor, the window and the ceiling as well as the doorway.

3. **Sparseness — check by eye; no metric found.** Renders that keep the architecture
   perfectly and then furnish the room with two chairs and a bare back wall read as
   "barely staged". Eight of batch 2's first pass failed this way. Coverage-of-frame does
   **not** separate them (a large rug counts as changed pixels, so a sparse room with a big
   rug scores at the pool median), so this one costs a human look at every render. What
   fixed it on the retry was naming an inventory — sofa, two more seats, coffee table, side
   table, rug, art on the back wall, two lamps, a plant — rather than asking for "generous".
   Ban lettering in the same breath: one farmhouse render came back with a mangled
   `HOME SWEET HOME` sign.

4. **The count must match `public/scripts/restage-pool.js`.**
   `test/frontend/home-restage.test.js` fails the build if the checked-in list and the
   files on disk disagree, and also caps each render at 150 KB.

And a new render needs its `rNN.png` twin here as well — nothing enforces that, since no test
reads this folder.
