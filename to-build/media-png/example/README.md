# `to-build/media-png/example/` — masters for the hero's room/style grid

PNG masters for the WebP files served from `public/media-webp/example/`. Nothing here is
referenced by the server, and that is on purpose: these are build inputs, not runtime code.
Do not delete them because a grep finds no usages.

## What is in here

| File | What it is |
| --- | --- |
| `Original.png` | The one empty room every other image in this folder is a render of. **The source of truth.** Its WebP is also what the hero's "See original" button shows, so it is live, not just a build input. |
| `<style>-<room>.png` (36) | The hero grid: every furniture style crossed with every room type. |

The six standalone style renders that used to sit beside `Original` (`Modern.png`,
`Coastal.png`, …) were the hero carousel's slides. The carousel is gone and the grid
supersedes them, so they were deleted along with it.

The 36 grid files are `{modern, scandinavian, coastal, farmhouse, luxury, midcentury}` x
`{bedroom, living-room, dining-room, kitchen, office, bathroom}`. `Outdoors` and `Dorm` are
absent deliberately: `Outdoors` belongs to Exterior Studio and reads as broken in the hero
sentence ("Stage this Outdoors in Modern"), and `Dorm` was excluded by product decision.
Both still exist in `lib/staging/promptMatrix.js` and are untouched.

## Regenerating

```
node to-build/media-png/example/tools/generate-combos.mjs            # fill any gaps
node to-build/media-png/example/tools/generate-combos.mjs --only kitchen
node to-build/media-png/example/tools/generate-combos.mjs --redo luxury-kitchen
node to-build/media-png/example/tools/generate-combos.mjs --list
```

The script drives the repo's own pipeline (`createStagingGeneration().processStaging`), so
every image is genuine Stagify output built from `promptMatrix.js` with no extra prompting.
That is the point: the hero is a claim about what the product does, so it has to be what the
product does. It needs `GOOGLE_AI_API_KEY` in `.env`.

It is resumable. A combination whose `.webp` already exists is skipped, so an interrupted run
costs nothing to restart, and `--redo` is the way to re-roll one you have rejected.

### The changed-architecture gates

The source room has three things the model keeps rewriting so it has somewhere to put
furniture, and each is scored against the source as a mean absolute difference over one box:

| region | gate | what goes wrong |
| --- | --- | --- |
| `left` | 20 | the left glass wall gets clad in marble or tile, or walled over to hold a vanity |
| `column` | 26 | the structural column and the far wall behind it get buried in cabinetry |
| `right` | 26 | the right window bank gets walled over for a mirror, vanity or shower |

MAD rather than mean brightness, because the failure comes in both directions: walled over in
white, *and* a dark mirror or cabinet run hung across the glass. Same trick as the `#restage`
pool's `arch-check.mjs` on its doorway recess.

**Calibrated blind, twice.** A human picked the bad renders without seeing any numbers. Round
one (right bank): the five they rejected scored 33.5–55.1, the one they kept 24.4. Round two
(left wall): the four they rejected scored 32.0–37.8 against 15.9 for the next clean render,
and the metric additionally caught a fifth they had missed — a luxury Bathroom at 33.7 whose
left wall had been clad in marble. Each gate sits in its own gap.

**A high score is a screen, not a verdict**, and `column` is the weakest of the three: a
wardrobe, a bookcase or a tall plant standing near the column scores like removing it. Kitchens
sit over `column` and `right` across the board because cabinetry genuinely has to go somewhere.
So nothing here ever fails a render — it retries, keeps the best attempt, prints all three
regions, and lists whatever is still over under `LOOK AT THESE`. Go and look at those.

**Ranking uses the SUM of the three ratios, not the worst one.** Ranking on the worst region
alone lets a render trade a healthy region for a broken one and still look like an improvement:
a luxury Kitchen with an intact left wall and a mangled right one was replaced by a version
that had wrecked both, because its worst ratio was fractionally lower. Summing means breaking
something that was fine always costs more than it gains.

If a combination will not come under a gate after several passes, the item list is usually the
reason: `coastal` and `luxury` Bathroom both demand a glass shower enclosure, and an enclosure
needs walls this photo does not have.

### `removeFurniture: true` is load-bearing

The script passes `removeFurniture: true` even though the source room is already empty, and
that is not a formality. With `false`, `generatePrompt()` appends *"treat any furniture and
decor named above as a guide to the desired STYLE only, NOT a checklist of items to place
from scratch"* — correct when the photo contains the owner's furniture, wrong here. It demotes
"clawfoot bathtub, wooden vanity, farmhouse sink" to mood words, and farmhouse `Bathroom` came
back as a tastefully rustic **living room** twice in a row before this was spotted. Note that
the same prompt also says an empty room should be *"staged from scratch as normal"*, so the
two halves contradict each other; `true` is the branch that behaves.

The 30 images that predate this change were generated with `false` and were kept because they
were good. If you regenerate the whole grid you will get a slightly more literal, denser
result across the board — that is the flag, not the model drifting.

**Renders are not deterministic.** Re-running does not reproduce these pixels, it produces
new ones. That is why the masters are committed rather than treated as regenerable output.
They cost about 1 MB each (roughly 36 MB for the grid); if that becomes a problem the served
WebP is the same 900x600 image and the masters can be dropped, but then a rejected render
cannot be re-encoded, only re-rolled.

## Two room types render differently from the rest

`Original.png` is a corner living room with floor-to-ceiling glass, a structural column and a
herringbone floor. Staging it as a bedroom, living room, dining room or office keeps all of
that intact, so those 24 images read as one room wearing different furniture, which is what
the hero needs.

`Kitchen` and `Bathroom` push harder. A kitchen needs cabinetry and appliance walls the source
photo does not have, so the model builds them, and in the worst draws the structural column
disappears behind a cabinet run. Re-roll those individually until the column survives.

Bathrooms used to be the worse of the two, and that turned out to be the **prompt**, not the
model: every `Bathroom` entry in `lib/staging/promptMatrix.js` opened with "Add a `<style>`
toilet" and most also asked for a shower curtain, so the model dutifully put a toilet on the
hardwood and hung a curtain from the ceiling with nothing to attach it to. Those items were
removed from the prompts on 2026-08-17 — see the comment above `'Bathroom'` in that file. If
bathroom renders ever start installing plumbing again, read that comment before re-rolling.
