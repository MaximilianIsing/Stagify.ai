// Getting the images OUT of the Listing Studio. Until this file existed there was no way
// to: no per-render download, no bulk download, no `link.download` anywhere in the feature.
//
// WHY THAT WAS FATAL RATHER THAN MERELY MISSING. Renders reach the page as authenticated
// `blob:` URLs (an <img src> cannot carry an Authorization header — see ../projects/api.js).
// So the only path out was right-click → Save, which writes a file named after the object
// URL's random UUID; and pasting the render's real URL into a tab 401s, because a navigation
// carries no bearer token. An agent who had just paid for 90 renders could not deliver one.
//
// The conventions here are lifted from ../app/download-menu.js, the mature stager's
// equivalent, so the two features name their files the same way:
//   - a `<a download>` element created, clicked and dropped — never a navigation;
//   - the filename slugged from human-meaningful parts, never the id alone.
//
// OWNERSHIP. `downloadObjectUrl` never revokes: the URL it is handed belongs to the grid's
// blob registry and is still on screen behind an <img>. Revoking it there is precisely the
// bug makeBlobRegistry was written to prevent. `downloadZip` owns the URL it creates and
// revokes it, because nothing else ever refers to it.

import { fetchBlobUrl, rendersZipPath } from './api.js';

/**
 * A filesystem-safe fragment of a human string.
 *
 * Lowercased, non-alphanumerics collapsed to single dashes, trimmed, and bounded — a room
 * label is operator-supplied and can be anything. Returns '' for input with nothing usable
 * in it, which lets the caller drop the segment rather than emit a bare dash.
 * @param {string|null|undefined} value
 * @param {number} [max=40]
 * @returns {string}
 */
export function slug(value, max = 40) {
  return String(value === null || value === undefined ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

/** Extension used when the render's storage key does not name one. */
export const DEFAULT_RENDER_EXT = 'jpg';

/**
 * The extension a render's bytes actually have, from its storage key.
 *
 * Read off the key rather than assumed, because the pipeline writes whatever the model
 * returned. Only a short alphanumeric tail is accepted, so a key with a dot in a directory
 * name cannot turn into a 30-character "extension".
 * @param {{ storageKey?: string|null }|null|undefined} render
 * @returns {string}
 */
export function renderExtension(render) {
  const key = render && render.storageKey ? String(render.storageKey) : '';
  const match = /\.([a-z0-9]{2,5})$/i.exec(key);
  return match ? match[1].toLowerCase() : DEFAULT_RENDER_EXT;
}

/**
 * The filename for one render: `<room>-<seq>-v<variation>.<ext>`.
 *
 * Every part is there for a reason an agent will hit within the hour: the room so a folder
 * of 90 files sorts into rooms, the frame `seq` so two shots of the same room stay apart,
 * and the variation so v1 does not overwrite v2 in the Downloads folder. A missing part is
 * skipped rather than rendered as "undefined".
 * @param {{ roomLabel?: string, seq?: number|null, variation?: number|null,
 *   render?: { storageKey?: string|null }|null }} parts
 * @returns {string}
 */
export function renderFilename(parts) {
  const room = slug(parts.roomLabel) || 'room';
  /** @type {string[]} */
  const bits = [room];
  const seq = parts.seq;
  if (typeof seq === 'number' && Number.isFinite(seq)) bits.push(String(seq));
  const variation = parts.variation;
  if (typeof variation === 'number' && Number.isFinite(variation)) bits.push(`v${variation}`);
  return `${bits.join('-')}.${renderExtension(parts.render || null)}`;
}

/**
 * The filename for the bulk zip: `<listing>-renders.zip`.
 * @param {{ title?: string, address?: string }|null|undefined} project
 * @returns {string}
 */
export function zipFilename(project) {
  const base =
    slug(project && project.title, 60) || slug(project && project.address, 60) || 'listing';
  return `${base}-renders.zip`;
}

/**
 * Save an object URL the caller already owns, under `filename`.
 *
 * DOES NOT REVOKE. The URL passed in is the one the grid's <img> is displaying; revoking it
 * would blank the frame the operator just downloaded. The anchor is detached and never
 * appended to the document — a synthetic click on a detached <a download> is honoured, and
 * appending it would flash a link into the layout.
 * @param {string} url - A `blob:` (or any) URL the caller keeps ownership of.
 * @param {string} filename
 * @returns {boolean} False when there was nothing to save.
 */
export function downloadObjectUrl(url, filename) {
  if (!url) return false;
  const link = /** @type {HTMLAnchorElement} */ (document.createElement('a'));
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.click();
  return true;
}

/**
 * Fetch a listing's renders zip with the bearer header and save it.
 *
 * The URL created here is single-use and owned here, so it is revoked once the click has
 * been dispatched. `revoke` is injectable purely so the ownership rule is testable without
 * a browser, the same reason makeBlobRegistry takes one.
 * @param {{ projectId: string, project?: { title?: string, address?: string }|null,
 *   fetchUrl?: (path: string) => Promise<string>,
 *   revoke?: (url: string) => void }} deps
 * @returns {Promise<string>} The filename saved.
 */
export async function downloadZip(deps) {
  const load = deps.fetchUrl || fetchBlobUrl;
  const revoke = deps.revoke || ((url) => URL.revokeObjectURL(url));
  const url = await load(rendersZipPath(deps.projectId));
  const filename = zipFilename(deps.project || null);
  try {
    downloadObjectUrl(url, filename);
  } finally {
    // The click is synchronous and the browser has taken its own reference by now, so
    // revoking immediately is safe — and skipping it would pin a whole listing's bytes
    // (hundreds of MB for a 90-render shoot) for the life of the tab.
    revoke(url);
  }
  return filename;
}
