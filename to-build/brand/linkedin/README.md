# LinkedIn company-page assets

Source masters, not runtime code — nothing in `public/` or the server references
these. See the "Intentionally-kept source assets" section of `CLAUDE.md`.

## Cover banner

`make-banner.js` composites the banner from the existing homepage before/after
pair. Run it from the repo root so `sharp` resolves:

```
node to-build/brand/linkedin/make-banner.js
```

Outputs, both regenerated on every run:

- `linkedin-banner-2256x382.png` — 2x master, upload this one
- `linkedin-banner-1128x191.png` — 1x proof, for checking legibility

### Why this pair

`Before2.webp` / `After2.webp` are the same camera on the same room, so scaling
both to the banner width and extracting the identical horizontal band makes the
wipe line up pixel for pixel — one continuous room, furniture appearing at the
seam. `Before1` is a *re-staging* (already furnished), so it will not read as a
before; pairs 2 and 3 are the genuinely empty ones.

### Knobs

- `BAND_TOP` (env) — which 382px band of the scaled 2256x1516 photo survives the
  5.9:1 crop. 700 keeps the bed, pillows, nightstand and lamp. Lower values ride
  up into bare wall; higher ones chop the headboard.
- `OUT_NAME` (env) — filename stem, for rendering trial variants side by side.
- `SEAM` — seam position as a fraction of width. 0.38 keeps the empty side short,
  since that half of the room is mostly blank wall.

### Layout constraints

- LinkedIn overlays the company logo tile over the **lower left**; that region is
  deliberately empty floor.
- Mobile crops the sides hard. The seam sits near center so it survives; the
  headline at the right edge is a desktop-first element and may be clipped.
