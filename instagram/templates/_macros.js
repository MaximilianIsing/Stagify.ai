// Shared chrome for every template: the document shell, the logo lockup, the label pills,
// the CTA and the disclosure. Defined once so ten layouts cannot drift into ten slightly
// different logo treatments.
//
// escapeHtml is imported from public/scripts/escape-html.js rather than re-implemented.
// It is a pure function with no browser dependencies, and the repo's rule is that there is
// exactly ONE escaper.
import { escapeHtml } from '../../public/scripts/escape-html.js';

export { escapeHtml };

/**
 * Wrap a path for use inside a CSS `url()`.
 *
 * Deliberately a validator rather than an escaper. escapeHtml is wrong here: it would turn
 * `&` into `&amp;` and quietly break the URL, because CSS is not HTML. Every image a
 * template paints is a local path this tool produced, so anything exotic is a bug worth
 * throwing on rather than sanitising past.
 * @param {string} url
 */
export function cssUrl(url) {
  if (typeof url !== 'string' || !url) {
    throw new Error('cssUrl: expected a non-empty path');
  }
  if (/["'()\\\s]/.test(url)) {
    throw new Error(`cssUrl: refusing to interpolate a path with quotes, parens or spaces: ${url}`);
  }
  // SINGLE quotes, deliberately. These land in a `style="..."` attribute, so a double
  // quote here closes the attribute early: the browser then sees `background-image: url(`
  // and silently paints nothing. No request is made, so there is no 404 to notice either.
  // That exact bug shipped a poster with two invisible photos on the first run.
  return `url('${url}')`;
}

/** Logical CSS pixel frames. The renderer's deviceScaleFactor turns these into real pixels. */
export const FRAME = Object.freeze({
  single: { width: 1080, height: 1350 },
  carousel: { width: 1080, height: 1350 },
  story: { width: 1080, height: 1920 },
  reel: { width: 1080, height: 1920 },
});

export const LOGO_MARK = '/public/media-webp/logo/Logo180x180.webp';

/**
 * The full document. Every template returns one of these.
 * @param {{ brandCss: string, css: string, body: string, width: number, height: number, title?: string }} o
 */
export function page({ brandCss, css, body, width, height, title = 'Stagify post' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
${brandCss}

*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
html, body {
  width: ${width}px;
  height: ${height}px;
  overflow: hidden;
}
body {
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  text-rendering: geometricPrecision;
  background: var(--brand-deep);
  color: #fff;
}
.frame {
  position: relative;
  width: ${width}px;
  height: ${height}px;
  overflow: hidden;
  isolation: isolate;
}

/* Shared chrome ------------------------------------------------------------ */
.pill {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  border-radius: 999px;
  font-weight: 700;
  white-space: nowrap;
}
.pill--label {
  padding: 14px 30px;
  font-size: 25px;
  letter-spacing: .16em;
  text-transform: uppercase;
}
.pill--before { background: rgba(31, 41, 55, .78); color: #fff; backdrop-filter: blur(6px); }
.pill--after  { background: var(--brand); color: #fff; box-shadow: 0 10px 28px rgba(30, 58, 138, .45); }

.lockup {
  display: inline-flex;
  align-items: center;
  gap: 14px;
  padding: 12px 26px 12px 14px;
  border-radius: 999px;
  background: #fff;
  box-shadow: 0 10px 30px rgba(30, 58, 138, .22);
}
.lockup img { display: block; width: 46px; height: 46px; border-radius: 12px; }
.lockup span { font-size: 30px; font-weight: 700; letter-spacing: -.01em; color: var(--brand-deep); }
.lockup span i { font-style: normal; color: var(--brand); }
.lockup--bare { background: none; box-shadow: none; padding: 0; }
.lockup--bare span { color: #fff; }
.lockup--bare span i { color: var(--brand-pale); }

.eyebrow {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: .3em;
  text-transform: uppercase;
  color: var(--brand-pale);
}

.cta {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  padding: 20px 38px;
  border-radius: 999px;
  background: linear-gradient(180deg, var(--brand) 0%, var(--brand-strong) 100%);
  color: #fff;
  font-size: 27px;
  font-weight: 700;
  letter-spacing: -.01em;
  box-shadow: 0 12px 30px rgba(37, 99, 235, .5);
}
.cta--light {
  background: #fff;
  color: var(--brand-strong);
  box-shadow: 0 12px 30px rgba(30, 58, 138, .28);
}

.disclosure {
  font-size: 21px;
  font-weight: 400;
  line-height: 1.3;
  color: rgba(255, 255, 255, .72);
}
.disclosure--dark { color: rgba(31, 41, 55, .6); }

/* The footer row reserves the CTA's height whether or not this slide carries one.
 *
 * Rule 15 puts the call to action on the last slide of a carousel and nowhere else, so
 * every earlier slide used to render a footer only as tall as the disclosure line, about
 * 42px shorter. The stack above it is flex, so the photo card absorbed the difference and
 * grew on every slide except the last. That is invisible in a layout whose slides show
 * different pictures, and it is glaring in one whose slides show the SAME picture: the
 * card changes aspect between slides, background-size:cover crops a different window, and
 * the photograph appears to zoom by about six per cent as the viewer swipes. A post whose
 * argument is that two frames differ in exactly one place cannot afford to introduce a
 * second difference in the chrome.
 *
 * A FIXED height, not a minimum. 72px is the CTA pill's own height (27px of type on a 1.2
 * line box plus 20px of padding top and bottom), but a min-height still lets the row settle
 * a fraction differently with and without the pill in it, and the flex stack above passes
 * that on to the photo card. One pixel of card is one pixel of image scale, which an image
 * reviewer duly measured as a uniform 1px shift between two slides whose whole point was
 * that nothing moved. Pinning the height makes the slides identical by construction. */
.field-footer { height: 72px; }

/* Fields. The brand paints on three grounds and no others: the deep blue, the pale wash,
 * and a photo. Anything else stops reading as Stagify. */
.field--deep { background: var(--brand-deep); color: #fff; }
.field--wash { background: var(--brand-wash); color: var(--text-heading); }
.field--gradient {
  background: linear-gradient(135deg, var(--brand-deep) 0%, var(--brand) 55%, var(--brand-soft) 100%);
  color: #fff;
}

/* Photo card. Radius and the blue-tinted shadow are the two things that make a rectangle
 * look like it belongs to this site rather than any other blue SaaS. */
.card {
  position: relative;
  overflow: hidden;
  border-radius: 20px;
  background: var(--brand-strong);
  box-shadow: 0 18px 48px rgba(30, 58, 138, .24);
  /* Everything inside a card is absolutely positioned, so the card has no intrinsic
   * height. Dropped into a sized flex or grid parent without this it collapses to zero and
   * the poster shows a coloured void where the photo should be, which renders and validates
   * perfectly happily. It has caught out both style-grid and stat-card, so the default
   * lives here rather than being remembered in each template. */
  height: 100%;
}
.card__photo {
  position: absolute;
  inset: 0;
  background-position: center;
  background-size: cover;
  background-repeat: no-repeat;
}
.card__scrim {
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(15, 23, 42, 0) 45%, rgba(15, 23, 42, .82) 100%);
}
.card__label {
  position: absolute;
  left: 22px;
  bottom: 22px;
  right: 22px;
}
.card__caption {
  margin-top: 12px;
  font-size: 26px;
  font-weight: 700;
  line-height: 1.2;
  color: #fff;
}
.card__pill {
  display: inline-block;
  padding: 9px 20px;
  border-radius: 999px;
  background: var(--brand);
  color: #fff;
  font-size: 19px;
  font-weight: 700;
  letter-spacing: .12em;
  text-transform: uppercase;
}
.card__pill--light { background: rgba(255, 255, 255, .92); color: var(--brand-deep); }

/* The white caption capsule that floats over or under a photo. Used on 07-27. */
.capsule {
  display: inline-block;
  padding: 18px 34px;
  border-radius: 999px;
  background: #fff;
  color: var(--brand-deep);
  font-size: 26px;
  font-weight: 700;
  box-shadow: 0 12px 34px rgba(30, 58, 138, .22);
}

/* Type-first layouts: one number doing all the work. */
.numeral {
  font-size: 300px;
  font-weight: 700;
  line-height: .86;
  letter-spacing: -.05em;
  color: #fff;
}
.numeral--brand { color: var(--brand-soft); }

.stack { display: flex; flex-direction: column; }
.row { display: flex; align-items: center; }
.between { display: flex; align-items: center; justify-content: space-between; }
.grow { flex: 1 1 auto; min-height: 0; min-width: 0; }

${css}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

/** The logo mark plus wordmark. `bare` drops the white pill for use on a light field. */
export function lockup({ bare = false } = {}) {
  return `<div class="lockup${bare ? ' lockup--bare' : ''}">
  <img src="${LOGO_MARK}" alt="">
  <span>Stagify<i>.ai</i></span>
</div>`;
}

export function labelPill(text, kind) {
  return `<span class="pill pill--label pill--${kind}">${escapeHtml(text)}</span>`;
}

export function eyebrow(text) {
  return `<div class="eyebrow">${escapeHtml(text)}</div>`;
}

export function cta(text, { light = false } = {}) {
  return `<span class="cta${light ? ' cta--light' : ''}">${escapeHtml(text)}</span>`;
}

export function disclosure(text, { dark = false } = {}) {
  return `<div class="disclosure${dark ? ' disclosure--dark' : ''}">${escapeHtml(text)}</div>`;
}

/**
 * A two-tone headline: the lead clause in white, the accent clause in the brand's pale
 * blue. Both existing posts use this shape, so it is chrome rather than per-template CSS.
 * @param {{ lead: string, accent?: string }} h
 */
export function headline({ lead, accent }) {
  const parts = [`<span class="hl-lead">${escapeHtml(lead)}</span>`];
  if (accent) parts.push(`<span class="hl-accent">${escapeHtml(accent)}</span>`);
  return `<h1 class="hl">${parts.join(' ')}</h1>`;
}

/**
 * A photo card with an optional style pill and caption.
 * @param {{ image: string, pill?: string, caption?: string, lightPill?: boolean, className?: string }} o
 */
export function photoCard({ image, pill, caption, lightPill = false, className = '', style = '' }) {
  const label = pill || caption
    ? `<div class="card__scrim"></div>
  <div class="card__label">
    ${pill ? `<span class="card__pill${lightPill ? ' card__pill--light' : ''}">${escapeHtml(pill)}</span>` : ''}
    ${caption ? `<div class="card__caption">${escapeHtml(caption)}</div>` : ''}
  </div>`
    : '';
  // `style` is template-authored layout (a grid span), never user data, so it is
  // interpolated raw. The image path still goes through cssUrl, which validates it.
  return `<div class="card ${className}"${style ? ` style="${style}"` : ''}>
  <div class="card__photo" style="background-image: ${cssUrl(image)};"></div>
  ${label}
</div>`;
}

export function capsule(text) {
  return `<span class="capsule">${escapeHtml(text)}</span>`;
}

/**
 * The header every field-based layout shares: logo left, letterspaced eyebrow right.
 * Lifted from 07-26 and 07-27, which both use exactly this.
 */
export function fieldHeader(eyebrowText = 'AI VIRTUAL STAGING') {
  return `<div class="between">
  ${lockup({ bare: true })}
  ${eyebrow(eyebrowText)}
</div>`;
}

/** The footer those same posts share: a claim on the left, a CTA pill on the right. */
export function fieldFooter({ note, action, light = true }) {
  return `<div class="between field-footer">
  ${disclosure(note ?? 'Virtually staged with Stagify.ai')}
  ${action ? cta(action, { light }) : ''}
</div>`;
}
