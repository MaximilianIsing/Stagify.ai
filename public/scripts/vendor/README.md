# `public/scripts/vendor/` — third-party browser bundles

Pre-built libraries copied in from npm and served from our own origin. **Not** npm
dependencies: they are never imported by the server, do not appear in `package.json`, and
are not part of any build. They are checked in so the browser can fetch them from
`https://stagify.ai/scripts/vendor/…`.

## Why these are self-hosted rather than loaded from a CDN

`script-src` in `lib/http/app-middleware.js` is a real allowlist with no third-party
JavaScript host on it (Google sign-in, Stripe and the Ads tag are the only external
origins, and none of them serve these). A `<script src="https://cdn…">` for any of these
would be blocked outright. Self-hosting is the requirement, not a preference.

## Why these files are not linted

`eslint.config.js` matches files by module marker (`import`/`export`). These are minified
UMD bundles with neither, so they match no block and are intentionally left unlinted. Do
not add them to a lint block — see the comment at the top of that config.

## Contents

| File | Library | Version | Licence | Loaded by |
|------|---------|---------|---------|-----------|
| `heic2any.min.js` | [heic2any](https://github.com/alexcorvi/heic2any) (bundles libheif) | — | MIT | `public/scripts/heic-convert.js` |
| `pdf.min.js` | [pdf.js](https://github.com/mozilla/pdf.js) `legacy/build/pdf.min.js` | pdfjs-dist **3.11.174** | Apache-2.0 | `public/scripts/pdf-page-to-image.js` |
| `pdf.worker.min.js` | pdf.js worker, `legacy/build/pdf.worker.min.js` | pdfjs-dist **3.11.174** | Apache-2.0 | loaded by `pdf.min.js` via `GlobalWorkerOptions.workerSrc` |

Both pdf.js files come from the **`legacy/`** build, which is the UMD one — it sets
`window.pdfjsLib` and can be loaded with a plain `<script>` tag. The default (non-legacy)
build in v3+ is ESM-only and would need a different loader.

**The two pdf.js files are a matched pair.** The worker refuses to run against a library
of a different version, so upgrade or replace them together, never one at a time.

## Refreshing a bundle

```sh
npm pack pdfjs-dist@<version>                     # tarball only; do NOT npm install it
tar -xzf pdfjs-dist-<version>.tgz \
  package/legacy/build/pdf.min.js \
  package/legacy/build/pdf.worker.min.js
cp package/legacy/build/pdf.min.js        public/scripts/vendor/pdf.min.js
cp package/legacy/build/pdf.worker.min.js public/scripts/vendor/pdf.worker.min.js
```

Then update the version in the table above, and re-check the two things a version bump
can silently break:

1. **The worker still loads.** `worker-src 'self'` must still cover it. A blocked worker
   makes PDFs *hang* rather than error, so it does not show up as a failed request.
2. **`window.pdfjsLib` still exists** after the script loads — `pdf-page-to-image.js`
   rejects with "pdf.js failed to initialize" if the global name ever changes.

`test/frontend/pdf-page-to-image.test.js` covers the pure decision helpers, but it does
**not** load these bundles. A version bump needs a real browser check: upload a
floor-plan PDF in the AI Designer and confirm a rasterized page comes back.
