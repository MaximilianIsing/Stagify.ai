# Stagify design system — how to build with it

Stagify is a **token / brand foundation**, not (yet) a component library. There are
no React components, no CSS utility classes, and no provider to wrap. You style by
referencing Stagify's CSS custom properties — the `--st-*` tokens — directly in your
own markup and CSS. Load `styles.css` and every token below is available on `:root`.

## The styling idiom: `var(--st-*)` tokens

Two layers. **Always reach for the semantic (role) aliases first** — they point at the
primitives, so the brand stays consistent and a rebrand is a one-line change. Drop to a
primitive only when no role fits.

**Color — semantic (use these):**
`--st-color-primary` (`#2563eb`, the core brand blue), `--st-color-primary-hover`,
`--st-color-primary-active`, `--st-color-primary-subtle`, `--st-color-accent`,
`--st-color-on-primary` · `--st-color-heading` (deep navy `#1e3a8a`), `--st-color-text`,
`--st-color-text-muted`, `--st-color-text-subtle`, `--st-color-text-link` ·
`--st-color-surface`, `--st-color-surface-muted`, `--st-color-surface-sunken`,
`--st-color-border`, `--st-color-border-strong`, `--st-color-focus` ·
feedback triads `--st-color-success{,-bg,-border,-text}`, `--st-color-danger{,-bg,-border,-text}`,
`--st-color-warning{,-bg,-border,-text}`.

**Color — primitives** (raw ramps, when a role doesn't fit): `--st-blue-50…950`,
`--st-gray-50…900`, `--st-slate-100…900`, `--st-navy-tint-100…900`, `--st-green-*`,
`--st-emerald-*`, `--st-red-*`, `--st-amber-*`, `--st-violet-*`, `--st-indigo-600`,
`--st-rose-600`, `--st-pink-700`, plus prebuilt alpha overlays `--st-overlay-black-08…50`,
`--st-overlay-white-40…92`, `--st-overlay-primary-10…25`, `--st-overlay-navy-10…14`.

**Type:** family `--st-font-sans` (Inter) / `--st-font-serif` / `--st-font-mono`;
sizes `--st-text-xs` (12) `--st-text-sm` (13) `--st-text-base` (14, body) `--st-text-md` (16)
`--st-text-lg` (18) `--st-text-xl` (20) `--st-text-2xl` (24) `--st-text-3xl` (32)
`--st-text-display` (fluid hero clamp); weights `--st-font-regular…-black` (400–900);
line-heights `--st-leading-tight/-snug/-normal`.

**Spacing** (4px base): `--st-space-0/1/2/3/4/5/6/8/10/12/16` → 0…64px.
**Radii:** `--st-radius-xs/sm/md/lg/xl/2xl/3xl/pill/circle`.
**Elevation:** `--st-shadow-xs/sm/md/lg/card/brand/glass`; focus ring `--st-focus-ring`.
**Motion:** `--st-duration-fast/base/slow/slower`, `--st-ease`, `--st-ease-out`.
**Z-index:** `--st-z-base/raised/sticky/dropdown/nav/overlay/modal/toast/mask-modal/top`.

## Where the truth lives

- `tokens/tokens.css` — the authoritative token definitions (both layers, with inline
  notes). Read this before styling.
- `tokens/tokens.json` — the same tokens in W3C Design Tokens format, for tooling.
- `fonts.css` / `fonts/` — self-hosted Inter (400/600/700); already imported by `styles.css`.

## One idiomatic snippet

```html
<!-- A primary button, styled entirely from tokens — the Stagify idiom. -->
<button style="
  font-family: var(--st-font-sans);
  font-weight: var(--st-font-semibold);
  font-size: var(--st-text-base);
  color: var(--st-color-on-primary);
  background: var(--st-color-primary);
  border: 0;
  padding: var(--st-space-3) var(--st-space-5);
  border-radius: var(--st-radius-md);
  box-shadow: var(--st-shadow-brand);
  cursor: pointer;
">Stage this room</button>
```

Prefer moving repeated declarations into your own CSS class; the point is that every
*value* comes from an `--st-*` token, never a hardcoded hex or px.

## Not here yet (deliberately)

No components, no `_ds_bundle.js`. Stagify's live site is vanilla HTML/CSS; a React
component library mapped onto these tokens is the planned next step. Until then, compose
UI from your own elements styled with the tokens above.
