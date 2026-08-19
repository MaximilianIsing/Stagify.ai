// "What did we actually make for this person?" — the render strip inside the
// expanded user row.
//
// Every other thing the drawer shows about an account is text: a prompt, a
// timestamp, a room type. The one question a bug report always raises is what the
// picture looked like, and until this shipped the console could not answer it at
// all. Kept out of renderers.js for the usual reason — that file is near its
// 650-line cap — and lazy, because a drawer is opened far more often than the
// renders inside it are looked at.
//
// ── Three states, and none of them may be confused with each other ──
// A render can be `ok` with bytes, `failed`, still `pending`, or EVICTED — reaped
// by the gallery cap, its row intact and its bytes gone. Those are four different
// answers to "why can't I see it", and painting any of them as a broken image
// tile would turn a working system into an apparent outage. Each gets a label.
//
// ── URLs are credentials ──
// The server mints short-lived presigned URLs, so this fetches on every expand
// rather than caching on ctx: a cached presigned URL outlives the revocation it is
// supposed to respect (lib/data/s3-presign.js). Nothing here draws to a canvas —
// presigned R2 URLs taint one, in production only, which is a trap that does not
// reproduce locally.

import { el, fmtDateTime, fmtBytes } from './helpers.js';

/** How many renders one expand pulls. Enough to see a pattern, small enough to paint. */
const PAGE = 24;

/**
 * Operator-facing names for the render sources.
 *
 * Deliberately NOT imported from public/scripts/render-name.js. That module answers a
 * customer-facing question — what to call a render on a card and on a public share page —
 * and it withholds a label for `interior` on purpose because the Room and Style rows say
 * it better. The console wants the opposite: every row named, including the plain interior
 * ones, because "which of our five surfaces produced this" is the question being asked.
 * An unrecognised id falls through to the raw value rather than going blank.
 */
const SOURCE_LABELS = {
  interior: 'Staging studio',
  exterior: 'Exterior Studio',
  designer: 'AI Designer',
  masking: 'Masking Studio',
  api: 'API',
};

/** Label and modifier class for each state a row can be in. */
function stateOf(entry) {
  if (entry.evicted) return { label: 'Reaped', cls: 'evicted', note: 'Row kept, bytes deleted by the gallery cap.' };
  if (entry.status === 'failed') return { label: 'Failed', cls: 'failed', note: 'This render never produced an image.' };
  if (entry.status === 'pending') return { label: 'Pending', cls: 'pending', note: 'Still running, or abandoned mid-render.' };
  return { label: '', cls: 'ok', note: '' };
}

/**
 * Build the section renderer.
 *
 * @param {object} deps
 * @param {(url: string, method: string, body?: any, isForm?: boolean) => Promise<any>} deps.apiSend Authenticated request helper.
 * @returns {(u: any) => HTMLElement} Renderer for one user's render strip.
 */
export function createRendersPanel({ apiSend }) {
  /**
   * @param {any} u User record from /authstore.
   * @returns {HTMLElement}
   */
  return function rendersSection(u) {
    const sec = el('div', { className: 'adm-detail-section' });
    const head = el('h3', { textContent: 'Renders' });
    sec.appendChild(head);

    const body = el('div', { className: 'adm-renders' });
    sec.appendChild(body);
    body.appendChild(el('p', { className: 'adm-detail-empty', textContent: 'Loading renders…' }));

    apiSend('/api/admin/renders?userId=' + encodeURIComponent(u.id) + '&limit=' + PAGE, 'GET')
      .then((j) => {
        body.innerHTML = '';

        // No object store configured is not an error and must not read as one:
        // the gallery is simply off on this deployment.
        if (j && j.enabled === false) {
          body.appendChild(el('p', {
            className: 'adm-detail-empty',
            textContent: 'Image storage is not configured on this deployment, so there is nothing to show.',
          }));
          return;
        }

        const entries = (j && j.entries) || [];
        const total = Number(j && j.total) || 0;
        if (!entries.length) {
          body.appendChild(el('p', { className: 'adm-detail-empty', textContent: 'No renders found.' }));
          return;
        }

        head.textContent = 'Renders (' + total + ' total)';

        const grid = el('div', { className: 'adm-renders-grid' });
        entries.forEach((entry) => grid.appendChild(card(entry)));
        body.appendChild(grid);

        if (total > entries.length) {
          body.appendChild(el('p', {
            className: 'adm-more',
            textContent: 'Showing the ' + entries.length + ' most recent of ' + total + '.',
          }));
        }
      })
      .catch((e) => {
        body.innerHTML = '';
        body.appendChild(el('p', {
          className: 'adm-detail-empty',
          textContent: 'Could not load renders: ' + (e && e.message ? e.message : 'error'),
        }));
      });

    return sec;
  };

  /** One render: its picture (or why there isn't one) and the parameters behind it. */
  function card(entry) {
    const state = stateOf(entry);
    const item = el('div', { className: 'adm-render-item adm-render-item--' + state.cls });

    const frame = el('div', { className: 'adm-render-frame' });
    if (entry.urls && entry.urls.thumb) {
      // Plain <img>, never a canvas — see the header note on tainting.
      const a = el('a', { href: entry.urls.after || entry.urls.thumb, target: '_blank', rel: 'noopener noreferrer' }, [
        el('img', {
          className: 'adm-render-thumb',
          src: entry.urls.thumb,
          alt: 'Render ' + entry.id,
          loading: 'lazy',
        }),
      ]);
      frame.appendChild(a);
    } else {
      // The reason there is no picture, in words. A grey box would be read as a
      // load failure whichever of the three states actually applies.
      frame.appendChild(el('div', { className: 'adm-render-placeholder', textContent: state.label || 'No image' }));
    }
    // The badge only rides on a card that HAS a picture. Without one the
    // placeholder already carries the word, and a tile reading "Failed" twice in
    // two adjacent boxes looks like a rendering bug rather than a state.
    if (state.label && entry.urls && entry.urls.thumb) {
      frame.appendChild(el('span', { className: 'adm-render-badge adm-render-badge--' + state.cls, textContent: state.label }));
    }
    item.appendChild(frame);

    const meta = el('div', { className: 'adm-render-meta' });
    const title = [entry.furnitureStyle, entry.roomType].filter(Boolean).join(' · ') || entry.name || 'Untitled';
    meta.appendChild(el('div', { className: 'adm-render-title', title, textContent: title }));
    meta.appendChild(el('div', { className: 'adm-render-sub', textContent: fmtDateTime(entry.createdAt) }));

    const facts = [
      // First, because on a support thread it is the first thing that changes the answer:
      // an integration's render and a colleague's render fail for different reasons.
      entry.source ? ['Made with', SOURCE_LABELS[entry.source] || entry.source] : null,
      entry.sourceName ? ['From', entry.sourceName] : null,
      entry.model ? ['Model', entry.model] : null,
      entry.width && entry.height ? ['Size', entry.width + '×' + entry.height] : null,
      entry.bytes ? ['Bytes', fmtBytes(entry.bytes)] : null,
      entry.removeFurniture ? ['Removed furniture', 'yes'] : null,
      entry.variation ? ['Variation', String(entry.variation)] : null,
      state.note ? ['State', state.note] : null,
    ].filter(Boolean);
    if (facts.length) {
      const dl = el('div', { className: 'adm-render-facts' });
      facts.forEach((f) => {
        const kv = el('div', { className: 'adm-render-kv' });
        kv.appendChild(el('strong', { textContent: f[0] + ': ' }));
        // textContent, never innerHTML: a prompt and a model name are both
        // user-influenced strings.
        kv.appendChild(document.createTextNode(f[1]));
        dl.appendChild(kv);
      });
      meta.appendChild(dl);
    }

    if (entry.additionalPrompt) {
      meta.appendChild(el('p', { className: 'adm-render-prompt', textContent: entry.additionalPrompt }));
    }

    item.appendChild(meta);
    return item;
  }
}
