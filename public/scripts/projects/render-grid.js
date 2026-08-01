// The Listing Studio's results surface: the room-grouped render grid, the per-room
// look-bible panel, and the lazy loading of image bytes behind both.
//
// THREE THINGS HERE ARE THE POINT, and each is a bug this codebase has actually shipped
// a version of:
//
//  1. BLOB URLS ARE OWNED, NOT LEAKED. Render bytes arrive over an authenticated fetch,
//     so they can only reach an <img> as an object URL — and an object URL pins its blob
//     until someone revokes it. `makeBlobRegistry` is that someone: it revokes on
//     REPLACE as well as on release, because the before/after toggle swaps the same
//     <img> between two sources and the naive version simply overwrote the URL it was
//     responsible for. A 90-render listing toggled through a session is tens of MB.
//  2. THE OBSERVER IS DISCONNECTED. Lazy loading means one IntersectionObserver over the
//     grid's images; redrawing the grid without disconnecting the previous one leaves it
//     holding every detached node it was watching. (The i18n observer drain was exactly
//     this bug.) `destroy()` disconnects and releases, and `draw()` calls it first.
//  3. A MISSING BIBLE IS SAID OUT LOUD. When a room's renders were produced without a
//     look bible, the banner says consistency was not enforced. The backend reports that
//     deliberately instead of quietly shipping unconditioned frames, so the UI does not
//     get to smooth it over. The decision itself is `needsConsistencyWarning` in
//     ./state.js, and it is unit-tested.
//
// Everything is assembled with createElement + textContent. There is no HTML-string sink
// in this file, so there is nothing to escape; if you ever add one, import `escapeHtml`
// from ../escape-html.js — do not hand-roll a second escaper (see that file's header).

import { photoImagePath, renderImagePath } from './api.js';
import { BIBLE_MISSING_CODE, roomLabel } from './state.js';
import { downloadObjectUrl, renderFilename } from './download.js';
import {
  UNCHECKED_SCORE_LABEL,
  formatScore,
  isLowScore,
  mismatchSentence,
  mismatchedSlots,
} from './scores.js';

/**
 * @typedef {import('./state.js').PjRoomGroup} PjRoomGroup
 * @typedef {import('./state.js').PjFrame} PjFrame
 * @typedef {import('./state.js').PjBible} PjBible
 * @typedef {import('./state.js').PjRender} PjRender
 */

/**
 * An owned set of object URLs, keyed by the path they were fetched from.
 * @typedef {object} PjBlobRegistry
 * @property {(key: string, url: string) => void} set
 * @property {(key: string) => string|null} get
 * @property {(key: string) => void} release
 * @property {(keys: Iterable<string>) => void} retain
 * @property {() => void} releaseAll
 * @property {() => number} count
 */

/**
 * A registry of object URLs that revokes what it replaces.
 *
 * `revoke` is injectable so the ownership rules are testable without a browser — the
 * replace-revokes-the-old-URL behaviour is the whole reason this exists and it is
 * invisible from the outside otherwise.
 *
 * @param {{ revoke?: (url: string) => void }} [opts]
 * @returns {PjBlobRegistry}
 */
export function makeBlobRegistry(opts = {}) {
  const revoke = opts.revoke || ((url) => URL.revokeObjectURL(url));
  /** @type {Map<string, string>} */
  const urls = new Map();

  return {
    set(key, url) {
      const previous = urls.get(key);
      // Same URL for the same key is a no-op: revoking it would kill the live <img>.
      if (previous === url) return;
      if (previous) revoke(previous);
      urls.set(key, url);
    },
    get(key) {
      const url = urls.get(key);
      return url === undefined ? null : url;
    },
    release(key) {
      const previous = urls.get(key);
      if (previous === undefined) return;
      revoke(previous);
      urls.delete(key);
    },
    // Keep only the URLs still on screen. This is what a redraw uses instead of
    // releaseAll: a room override or a poll tick redraws the whole tray/grid, and
    // dropping every URL there would re-download every visible photo each time.
    retain(keys) {
      const live = keys instanceof Set ? keys : new Set(keys);
      for (const key of [...urls.keys()]) {
        if (live.has(key)) continue;
        const url = urls.get(key);
        if (url !== undefined) revoke(url);
        urls.delete(key);
      }
    },
    releaseAll() {
      for (const url of urls.values()) revoke(url);
      urls.clear();
    },
    count() {
      return urls.size;
    },
  };
}

/** Copy for the banner on a room whose renders had no bible behind them. */
export const NO_BIBLE_WARNING = 'Consistency was not enforced for this room.';

/**
 * Copy for a room whose barred frames were failed with BIBLE_MISSING.
 * @param {number} count
 * @returns {string}
 */
export function bibleMissingNotice(count) {
  return `${count} frame(s) in this room could not be staged: the look bible never landed. Regenerate this room’s look to re-run them.`;
}

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Mount the results grid.
 *
 * @param {{
 *   root: HTMLElement,
 *   registry: PjBlobRegistry,
 *   getProjectId: () => string,
 *   loadImage: (path: string) => Promise<string>,
 *   onRegenerate: (roomKey: string, label: string) => void,
 *   onRetry: (renderId: string) => void,
 *   onDownloadError: (error: unknown) => void,
 * }} deps - The grid container, the object-URL owner, a getter for the open
 *   listing's id, an image-bytes loader (path → object URL), the callback for
 *   the per-room "Regenerate look" button, the callback for a failed frame's Retry, and
 *   the reporter for a download whose bytes could not be fetched.
 *
 *   `registry` is owned EXCLUSIVELY by the grid: `draw()` retains only the paths the
 *   new grid can show and revokes the rest, and `destroy()` releases everything. Give
 *   the photo tray its own registry — sharing one would revoke the tray's thumbnails
 *   out from under it on the next redraw.
 * @returns {{ draw: (groups: PjRoomGroup[]) => void, destroy: () => void }}
 */
export function mountRenderGrid(deps) {
  const { root, registry, getProjectId, loadImage, onRegenerate, onRetry, onDownloadError } = deps;

  /** @type {IntersectionObserver|null} */
  let observer = null;

  /** Every image path the current draw can ask for; drives registry.retain(). */
  /** @type {Set<string>} */
  let liveKeys = new Set();

  /**
   * Fetch an image's bytes and show them, or replace the frame with an explicit
   * unavailable state. A failure is never left as a broken <img>: the "before" pane
   * in particular may have no server route at all (see photoImagePath), and passing a
   * blank box off as the source photo would be a lie about what the operator is
   * comparing.
   * @param {HTMLImageElement} img
   * @param {string} path
   */
  function fill(img, path) {
    const cached = registry.get(path);
    if (cached) {
      img.src = cached;
      return;
    }
    img.classList.add('pj-shot--loading');
    loadImage(path)
      .then((url) => {
        registry.set(path, url);
        img.src = url;
        img.classList.remove('pj-shot--loading', 'pj-shot--failed');
      })
      .catch(() => {
        img.classList.remove('pj-shot--loading');
        img.removeAttribute('src');
        img.classList.add('pj-shot--failed');
        img.alt = 'Image unavailable';
      });
  }

  /**
   * Watch an image and load it when it scrolls into view. Without this a 90-render
   * listing fires 90 multi-megabyte fetches on open.
   * @param {HTMLImageElement} img
   */
  function lazyLoad(img) {
    if (!observer) {
      // No IntersectionObserver (very old browser): load eagerly rather than showing
      // an empty grid. Slower, never broken.
      fill(img, String(img.dataset.src || ''));
      return;
    }
    observer.observe(img);
  }

  /**
   * Save one render, reusing the object URL the grid is already holding for it.
   *
   * The registry's URL is used AS IS and is NOT revoked — it is what the <img> on screen is
   * displaying. Only a render nobody has scrolled to yet costs a fetch, and that fetch's
   * URL joins the registry like any other so a second download is free.
   * @param {PjRender} render
   * @param {PjFrame} frame
   * @param {string} projectId
   * @param {string} label - The room label, for the filename.
   */
  function saveRender(render, frame, projectId, label) {
    const path = renderImagePath(projectId, render.id);
    const name = renderFilename({
      roomLabel: label,
      seq: frame.photo.seq ?? null,
      variation: render.variation ?? null,
      render,
    });
    const cached = registry.get(path);
    if (cached) {
      downloadObjectUrl(cached, name);
      return;
    }
    loadImage(path)
      .then((url) => {
        registry.set(path, url);
        downloadObjectUrl(url, name);
      })
      .catch(onDownloadError);
  }

  /** @param {PjFrame} frame @param {string} projectId @param {string} label */
  function frameCard(frame, projectId, label) {
    const card = el('article', 'pj-frame');
    const head = el('header', 'pj-frame__head');
    head.appendChild(el('h4', 'pj-frame__title', frame.isHero ? 'Hero frame' : 'Frame'));
    if (frame.isHero) head.appendChild(el('span', 'pj-badge pj-badge--hero', 'Hero'));
    card.appendChild(head);

    const current = frame.renders[0] || null;
    const shot = /** @type {HTMLImageElement} */ (el('img', 'pj-shot'));
    shot.alt = current ? 'Staged render' : 'Source photo';
    shot.loading = 'lazy';
    shot.decoding = 'async';
    const afterPath = current ? renderImagePath(projectId, current.id) : '';
    const beforePath = photoImagePath(projectId, frame.photo.id);
    for (const render of frame.renders) liveKeys.add(renderImagePath(projectId, render.id));
    liveKeys.add(beforePath);
    shot.dataset.src = afterPath || beforePath;
    card.appendChild(shot);
    lazyLoad(shot);

    if (afterPath) {
      // Before/after against the SOURCE photo — the comparison an agent actually
      // wants to make. Both sides go through the same registry, so flipping back and
      // forth reuses the two URLs instead of accumulating one per click.
      const toggle = el('div', 'pj-compare');
      toggle.setAttribute('role', 'group');
      toggle.setAttribute('aria-label', 'Compare before and after');
      /** @type {HTMLButtonElement[]} */
      const buttons = [];
      for (const mode of ['Before', 'After']) {
        const button = /** @type {HTMLButtonElement} */ (el('button', 'pj-compare__btn', mode));
        button.type = 'button';
        const isAfter = mode === 'After';
        button.setAttribute('aria-pressed', isAfter ? 'true' : 'false');
        button.addEventListener('click', () => {
          for (const other of buttons) other.setAttribute('aria-pressed', 'false');
          button.setAttribute('aria-pressed', 'true');
          shot.alt = isAfter ? 'Staged render' : 'Source photo';
          fill(shot, isAfter ? afterPath : beforePath);
        });
        buttons.push(button);
        toggle.appendChild(button);
      }
      card.appendChild(toggle);
    }

    // Which render the card is "about" right now: renders[0] to begin with (which
    // sortRenders now guarantees is the best-status one, not merely variation 1), and
    // whichever variation the operator last picked after that. The download and the score
    // row both follow it, so they cannot describe one frame while the image shows another.
    let shown = current;

    const meta = el('dl', 'pj-scores');
    /** @param {PjRender|null} render */
    function drawScores(render) {
      meta.textContent = '';
      if (!render) {
        meta.appendChild(el('dt', undefined, 'Status'));
        meta.appendChild(el('dd', undefined, 'No renders yet'));
        return;
      }
      /** @type {Array<[string, string, number|null|undefined]>} */
      const rows = [
        ['Quality', formatScore(render.qualityScore), render.qualityScore],
        ['Consistency', formatScore(render.consistencyScore), render.consistencyScore],
        ['Status', String(render.status), undefined],
      ];
      for (const [label, value, score] of rows) {
        meta.appendChild(el('dt', undefined, label));
        const unchecked = value === UNCHECKED_SCORE_LABEL;
        // Three visually distinct states, because collapsing any two of them is how the
        // grid managed to make "we never checked" look like "checked and clean".
        const tone = unchecked ? ' pj-score--unchecked' : isLowScore(score) ? ' pj-score--low' : '';
        meta.appendChild(el('dd', `pj-score${tone}`, value));
      }
    }
    drawScores(shown);
    card.appendChild(meta);

    const drift = el('p', 'pj-frame__drift');
    /** @param {PjRender|null} render */
    function drawDrift(render) {
      const sentence = mismatchSentence(mismatchedSlots(render));
      drift.textContent = sentence;
      drift.classList.toggle('hidden', !sentence);
    }
    drawDrift(shown);
    card.appendChild(drift);

    const actions = el('div', 'pj-frame__actions');

    // C1: the way the images get out. Reuses the blob the <img> is already showing, and
    // names the file after the room, the frame and the variation — a blob URL's own UUID is
    // what right-click → Save produced before this existed.
    const save = /** @type {HTMLButtonElement} */ (el('button', 'pj-frame__save', 'Download'));
    save.type = 'button';
    save.addEventListener('click', () => {
      if (shown) saveRender(shown, frame, projectId, label);
    });
    save.disabled = !shown;

    const retry = /** @type {HTMLButtonElement} */ (el('button', 'pj-frame__retry', 'Retry'));
    retry.type = 'button';
    retry.addEventListener('click', () => {
      if (shown) onRetry(shown.id);
    });

    const error = el('p', 'pj-frame__error');
    /** @param {PjRender|null} render */
    function drawFailure(render) {
      const failed = !!render && render.status === 'failed';
      if (failed && render) {
        error.textContent =
          render.errorCode === BIBLE_MISSING_CODE
            ? 'This frame was never staged: its room’s look bible never landed.'
            : `This frame failed${render.errorCode ? ` (${render.errorCode})` : ''}.`;
      } else {
        error.textContent = '';
      }
      error.classList.toggle('hidden', !failed);
      // Retry only exists for a frame that actually failed. It keeps the render's bible, so
      // the retried frame still matches the room it belongs to.
      retry.classList.toggle('hidden', !failed);
      save.disabled = !render || render.status !== 'ok';
    }
    drawFailure(shown);
    actions.appendChild(save);
    actions.appendChild(retry);
    card.appendChild(actions);
    card.appendChild(error);

    if (frame.renders.length > 1) {
      const variants = el('ul', 'pj-variants');
      /** @type {HTMLButtonElement[]} */
      const pills = [];
      for (const render of frame.renders) {
        const item = el('li', 'pj-variants__item');
        const button = /** @type {HTMLButtonElement} */ (
          el('button', 'pj-variants__btn', `Variation ${render.variation ?? '?'} · ${render.status}`)
        );
        button.type = 'button';
        button.setAttribute('aria-pressed', render === shown ? 'true' : 'false');
        button.addEventListener('click', () => {
          shown = render;
          for (const other of pills) other.setAttribute('aria-pressed', 'false');
          button.setAttribute('aria-pressed', 'true');
          shot.alt = 'Staged render';
          fill(shot, renderImagePath(projectId, render.id));
          drawScores(render);
          drawDrift(render);
          drawFailure(render);
        });
        pills.push(button);
        item.appendChild(button);
        variants.appendChild(item);
      }
      card.appendChild(variants);
    }

    return card;
  }

  /** @param {PjBible|null} bible @param {string} roomKey @param {string} label */
  function biblePanel(bible, roomKey, label) {
    const panel = el('section', 'pj-bible');
    panel.appendChild(el('h4', 'pj-bible__title', 'Look bible'));

    if (!bible) {
      panel.appendChild(
        el('p', 'pj-bible__empty', 'No look bible for this room yet. Stage the listing to derive one.')
      );
    } else {
      const doc = bible.doc;
      const facts = el('dl', 'pj-bible__facts');
      // `palette` and `lighting` are Record<string, string> — a named slot ("walls",
      // "primary", "direction") mapped to its value. They are NOT strings: rendering
      // either one directly printed "[object Object]" into this panel, which is the one
      // place the feature shows the operator what it actually derived. Each entry gets
      // its own row now, which is both correct and more readable than a joined string.
      /**
       * @param {Record<string, string> | undefined} map
       * @param {string} prefix
       * @returns {Array<[string, string]>}
       */
      const rowsFor = (map, prefix) => {
        if (!map) return [];
        return Object.entries(map)
          .filter(([, value]) => value)
          .map(([slot, value]) => /** @type {[string, string]} */ ([`${prefix} · ${slot}`, String(value)]));
      };
      /** @type {Array<[string, string]>} */
      const rows = [
        ['Style', bible.furnitureStyle || '—'],
        ['Version', String(bible.version ?? 1)],
        ...rowsFor(doc && doc.palette, 'Palette'),
        ...rowsFor(doc && doc.lighting, 'Lighting'),
      ];
      for (const [term, value] of rows) {
        facts.appendChild(el('dt', undefined, term));
        facts.appendChild(el('dd', undefined, value));
      }
      panel.appendChild(facts);

      const pieces = doc && Array.isArray(doc.pieces) ? doc.pieces : [];
      if (pieces.length) {
        const list = el('ul', 'pj-pieces');
        for (const piece of pieces) {
          const item = el('li', piece.critical ? 'pj-pieces__item is-critical' : 'pj-pieces__item');
          item.appendChild(el('span', 'pj-pieces__slot', piece.slot || 'piece'));
          item.appendChild(el('span', 'pj-pieces__identity', piece.identity || '—'));
          if (piece.placement) item.appendChild(el('span', 'pj-pieces__placement', piece.placement));
          if (piece.critical) {
            const flag = el('span', 'pj-badge pj-badge--critical', 'Critical');
            flag.title = 'Every frame in this room must show this piece identically.';
            item.appendChild(flag);
          }
          list.appendChild(item);
        }
        panel.appendChild(list);
      }

      // `negatives` is `string[]` in the current shape, but a bible doc is stored as JSON
      // in the DB, so a legacy or hand-edited row can hold a bare string. Tolerated on
      // read rather than trusted to match the type — this is a boundary, not internal state.
      const rawNegatives = doc ? /** @type {string[] | string | undefined} */ (doc.negatives) : undefined;
      const negatives = Array.isArray(rawNegatives)
        ? rawNegatives.filter(Boolean).join(', ')
        : (typeof rawNegatives === 'string' ? rawNegatives : '');
      if (negatives) panel.appendChild(el('p', 'pj-bible__negatives', `Avoid: ${negatives}`));
    }

    const regenerate = /** @type {HTMLButtonElement} */ (
      el('button', 'btn btn-secondary pj-bible__regen', 'Regenerate look')
    );
    regenerate.type = 'button';
    regenerate.addEventListener('click', () => onRegenerate(roomKey, label));
    panel.appendChild(regenerate);
    panel.appendChild(
      el('p', 'pj-hint', 'Regenerating supersedes every existing render in this room.')
    );
    return panel;
  }

  /** @param {PjRoomGroup} group @param {string} projectId */
  function roomSection(group, projectId) {
    const label = roomLabel(group.roomKey, group.roomType);
    const section = el('section', 'pj-room');
    const head = el('header', 'pj-room__head');
    head.appendChild(el('h3', 'pj-room__title', label));
    head.appendChild(
      el('span', 'pj-room__count', `${group.frames.length} photo(s) · ${group.renderCount} render(s)`)
    );
    section.appendChild(head);

    if (group.bibleMissing) {
      const banner = el('p', 'pj-warning pj-warning--loud', NO_BIBLE_WARNING);
      banner.setAttribute('role', 'status');
      section.appendChild(banner);
    }

    // C4: the honest signal, said on the room it belongs to and with the fix attached. A
    // room whose bible extraction failed has its barred renders marked BIBLE_MISSING, and
    // the only thing that unsticks them is regenerating this room's look — so the button is
    // here, not only at the bottom of the panel.
    if (group.blockedCount > 0) {
      const blocked = el('div', 'pj-warning pj-warning--loud pj-room__blocked');
      blocked.setAttribute('role', 'status');
      blocked.appendChild(el('span', undefined, bibleMissingNotice(group.blockedCount)));
      const fix = /** @type {HTMLButtonElement} */ (
        el('button', 'btn btn-secondary pj-room__blocked-fix', 'Regenerate this room’s look')
      );
      fix.type = 'button';
      fix.addEventListener('click', () => onRegenerate(group.roomKey, label));
      blocked.appendChild(fix);
      section.appendChild(blocked);
    }

    const frames = el('div', 'pj-frames');
    for (const frame of group.frames) frames.appendChild(frameCard(frame, projectId, label));
    section.appendChild(frames);
    section.appendChild(biblePanel(group.bible, group.roomKey, label));
    return section;
  }

  /**
   * Replace the grid with `groups`.
   * @param {PjRoomGroup[]} groups
   */
  function draw(groups) {
    // Disconnect FIRST: the previous observer is watching nodes about to be detached,
    // and leaving it connected is how an observer ends up pinning a whole dead tree.
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    root.textContent = '';
    liveKeys = new Set();
    if (typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const img = /** @type {HTMLImageElement} */ (entry.target);
            if (observer) observer.unobserve(img);
            fill(img, String(img.dataset.src || ''));
          }
        },
        { rootMargin: '300px 0px' }
      );
    }

    const projectId = getProjectId();
    if (!groups.length) {
      root.appendChild(
        el('p', 'pj-empty', 'Nothing staged yet. Upload photos, then stage the listing.')
      );
    } else {
      for (const group of groups) root.appendChild(roomSection(group, projectId));
    }
    // Give back only what this draw can no longer show. releaseAll here would make
    // every poll tick re-download every visible render.
    registry.retain(liveKeys);
  }

  /** Detach the observer and give back every object URL the grid was holding. */
  function destroy() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    liveKeys = new Set();
    registry.releaseAll();
    root.textContent = '';
  }

  return { draw, destroy };
}
