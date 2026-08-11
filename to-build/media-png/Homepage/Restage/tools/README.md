# Restage pool generator

Grows or repairs the `#restage` pool on the home page. Consolidated here from
`studio-section-concepts/tools/`, which held four near-identical batch scripts and was
deleted; this is the single surviving path.

```
node to-build/media-png/Homepage/Restage/tools/generate.mjs --add 20
# look at every render in tools/pending/
node to-build/media-png/Homepage/Restage/tools/generate.mjs --reject r107
node to-build/media-png/Homepage/Restage/tools/generate.mjs --accept
```

Reads `GOOGLE_AI_API_KEY` from `.env` or the environment. Run it from the repo root.

## Why two phases

Renders land in `tools/pending/` and go nowhere until you run `--accept`. That is not
ceremony. Of the four ways a render comes back unusable, **only one has a numeric screen**:

| Failure | Caught by |
|---|---|
| The doorway recess is walled over, covered or blocked | `arch-check.mjs`, automatically, before it reaches `pending/` |
| The oak floor is restained, or blinds/shutters appear on the window | **eye only** |
| The room is furnished so sparsely it reads as unstaged | **eye only** |
| Lettering in frame comes back mangled | **eye only** |

Ten renders have been replaced across the pool's life. Every one was caught by looking;
none by a metric. `--accept` therefore refuses to be the default.

The two eye-only architecture failures are the reason a coverage metric was tried and
abandoned: a sparse room with a big rug scores at the pool median, because the rug counts as
changed pixels exactly like furniture does. There is no cheap proxy. Look at the images.

## What `--accept` does

1. Copies each pending WebP into `public/media-webp/Homepage/Restage/`.
2. Mints the PNG master beside this folder and **verifies it is pixel-identical** to the
   WebP. (The direction of truth is reversed for this set — see `../README.md`.)
3. Appends the recipe to `../manifest.json` as a new batch, and marks any slot it replaced
   `supersededBy`.
4. Rewrites the `RESTAGE_POOL` array in `public/scripts/restage-pool.js` to match the disk.

Step 4 is the one a test enforces (`test/frontend/home-restage.test.js` fails the build when
the checked-in list and the files disagree), and it is the step that used to get forgotten.
Run `npm test` after accepting.

## Commands

| Command | Effect |
|---|---|
| `--add <n>` | Renders `n` new slots after the highest one in use, at recipes no live render has |
| `--replace r44,r46` | Re-renders those existing slots at fresh recipes |
| `--reject r94` | Re-rolls one pending render at a different recipe |
| `--accept` | Installs everything pending (the four steps above) |
| `--discard` | Throws the pending batch away, changes nothing else |

`--reject` deliberately moves to a *different* recipe rather than re-rolling the same one.
The failures that survive the doorway gate are the recipe interacting badly with this
particular room, not an unlucky sample — re-rolling reproduces them.

## Recipes and diversity

`axes.mjs` holds the axis values; `../manifest.json` records which recipe produced every
render ever shipped. The generator walks a recipe space and skips anything the live pool
already uses, so **no two live renders share a recipe** — verified at 100/100.

Two rules are baked into the axis values and must survive any edit:

1. **No layout puts seating along or into the LEFT wall.** The doorway recess is there. Eight
   of the ten renders ever rejected used a left-wall or far-left-corner layout.
2. **Every wall-mounted accent names the BACK wall explicitly.** "A mirror against the wall
   beside the window" is how a mirror ends up hung across the doorway.

If two presses start looking alike, add **palettes** first — it is the axis a visitor
actually registers, and a repeat there reads as a repeat even when everything else differs.
Phrase them as furniture and textile colour, never wall colour: `HARD_ARCHITECTURE` forbids
repainting, and naming a wall tone invites the model to try.

The pool's first sixty renders used an earlier axis set. Those values are kept in the
manifest for provenance but are **not** reused here — several break rule 1, which is how the
problem was found.
