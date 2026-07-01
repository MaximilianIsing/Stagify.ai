# design-sync notes

- **Shape: tokens-only, off-script (hand-authored).** Stagify is a vanilla HTML/CSS
  repo (Express server, `server.js`). There is no React, no Storybook, and no component
  build/`dist/`, so the converter (`package-build.mjs`) does not apply. The `ds-bundle/`
  layout is authored by hand from `design-system/tokens.{css,json}` + `public/fonts`
  (Inter 400/600/700) + the `@font-face` block in `public/styles/styles.css`.
- **What's synced:** `styles.css` (entry) → `@import` `fonts.css` + `tokens/tokens.css`;
  `tokens/tokens.{css,json}`; the six Inter font files; `README.md` (conventions header,
  also in `.design-sync/conventions.md`); `_ds_sync.json` anchor (file sha256 hashes).
  No `components/`, `_ds_bundle.js`, or `_vendor/` — there's nothing to bundle.
- **Re-sync:** re-run this hand-authored path. The `_ds_sync.json` fileHashes let a
  future run diff cheaply. If `design-system/tokens.css` or the fonts change, re-copy
  into `ds-bundle/`, regenerate `_ds_sync.json`, and re-upload the changed files.
- **When components exist:** once a React component library mapped onto the `--st-*`
  tokens is built (the planned "React gap" work), switch this to the real converter
  path — the token layer synced here becomes the styling foundation those components
  render against.
- **Project:** "Stagify" — https://claude.ai/design/p/2f3dba42-9eae-4cb2-ac1d-bdfe05597973
