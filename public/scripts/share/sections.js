// The non-photo blocks: the disclosure, the broker's note, the agent card, and the two
// states where there is nothing to show.
//
// THE DISCLOSURE IS NOT A FOOTER. Virtual staging carries a disclosure obligation for the
// broker, and the usual implementation — six grey words under a copyright line — satisfies
// a lawyer and nobody else. Here it sits directly above the photographs, in a bordered
// block, at the page's body size, marked `role="note"` so a screen reader announces it as
// an aside rather than reading it as part of the address. It is rendered VERBATIM from the
// manifest: the server owns the wording, this file owns nothing but where it goes.
//
// THE AGENT CARD'S LINKS ARE VALIDATED, NOT ESCAPED. `name`, `email` and `phone` are typed
// by an operator and land in `href` attributes, which is the one place on this page where
// "escape it" is the wrong answer — `javascript:alert(1)` survives escaping intact. So an
// address that does not look like an email, and a phone with no dialable characters left
// after stripping, are rendered as plain TEXT with no link at all. A broker with an odd
// phone format loses a tap target; nobody gets a scheme they did not ask for.

import { el } from './dom.js';

/**
 * Deliberately narrow. Not RFC 5322 — the job is to decide whether this string is safe and
 * sensible to put after `mailto:`, and every character that could change the meaning of the
 * URL (whitespace, quotes, angle brackets, `:` and `/`) is excluded rather than encoded.
 */
const EMAIL_SHAPE = /^[^\s@<>"'/\\:;,]+@[^\s@<>"'/\\:;,]+\.[a-z]{2,}$/i;

/** The characters a `tel:` URI may carry. Everything else is presentation. */
const TEL_ALLOWED = /[^0-9+*#]/g;

/**
 * Dialable characters a phone field must have before it becomes a `tel:` link.
 *
 * Stripping is enough for SAFETY — a `tel:` href can only ever hold `[0-9+*#]`, so
 * `javascript:alert(2)` reduces to a harmless `tel:2`. It is not enough for SENSE: that
 * still renders a tappable link that opens the buyer's dialler on "2". Six is shorter than
 * any published contact number in any country, so a real one always clears it and a stray
 * digit in a typo never does. Below it the value is shown as plain text, which is the same
 * thing an unparseable email gets.
 */
const TEL_MIN_DIGITS = 6;

/**
 * @param {Document} doc
 * @param {string} disclosure - Verbatim from the manifest.
 * @returns {any}
 */
export function buildDisclosure(doc, disclosure) {
  return el(doc, 'aside', {
    className: 'sh-disclosure',
    attrs: { role: 'note', 'aria-label': 'Virtual staging disclosure' },
    children: [
      el(doc, 'p', { className: 'sh-disclosure__label', text: 'Virtual staging disclosure' }),
      el(doc, 'p', { className: 'sh-disclosure__text', text: disclosure }),
    ],
  });
}

/**
 * The broker's free-text message. Returns null when there is nothing to say, so the caller
 * can append unconditionally.
 * @param {Document} doc
 * @param {string} note
 * @returns {any|null}
 */
export function buildNote(doc, note) {
  if (!note) return null;
  return el(doc, 'section', {
    className: 'sh-note',
    children: [el(doc, 'p', { className: 'sh-note__text', text: note })],
  });
}

/**
 * One contact row. Linked when the value is dialable/mailable, plain text otherwise.
 * @param {Document} doc
 * @param {string} label
 * @param {string} value
 * @param {string|null} href
 * @returns {any}
 */
function contactRow(doc, label, value, href) {
  const body = href
    ? el(doc, 'a', { className: 'sh-agent__link', text: value, attrs: { href, rel: 'nofollow' } })
    : el(doc, 'span', { className: 'sh-agent__plain', text: value });
  return el(doc, 'p', {
    className: 'sh-agent__row',
    children: [
      el(doc, 'span', { className: 'sh-agent__label', text: label }),
      body,
    ],
  });
}

/**
 * The contact card. Only rendered when at least one field is set (see `hasAgent`).
 * @param {Document} doc
 * @param {import('./model.js').ShareAgent} agent
 * @returns {any}
 */
export function buildAgentCard(doc, agent) {
  const rows = [];
  if (agent.email) {
    const safe = EMAIL_SHAPE.test(agent.email) ? `mailto:${agent.email}` : null;
    rows.push(contactRow(doc, 'Email', agent.email, safe));
  }
  if (agent.phone) {
    const dialable = agent.phone.replace(TEL_ALLOWED, '');
    const callable = dialable.replace(/[^0-9]/g, '').length >= TEL_MIN_DIGITS;
    rows.push(contactRow(doc, 'Phone', agent.phone, callable ? `tel:${dialable}` : null));
  }

  return el(doc, 'section', {
    className: 'sh-agent',
    attrs: { 'aria-labelledby': 'sh-agent-heading' },
    children: [
      el(doc, 'h2', {
        className: 'sh-agent__heading',
        id: 'sh-agent-heading',
        text: 'Questions about this home?',
      }),
      agent.name ? el(doc, 'p', { className: 'sh-agent__name', text: agent.name }) : null,
      ...rows,
    ],
  });
}

/**
 * A centred message block — the shape both "nothing here yet" and "link is gone" take.
 * @param {Document} doc
 * @param {{ className: string, heading: string, body: string }} content
 * @returns {any}
 */
export function buildMessage(doc, content) {
  return el(doc, 'section', {
    className: `sh-message ${content.className}`,
    attrs: { role: 'status' },
    children: [
      el(doc, 'p', { className: 'sh-message__heading', text: content.heading }),
      el(doc, 'p', { className: 'sh-message__body', text: content.body }),
    ],
  });
}

/**
 * The share exists and the token is good — there are simply no staged photos on it yet.
 * Distinct from the unavailable state on purpose: this one is temporary and the reader can
 * usefully come back.
 * @param {Document} doc
 * @returns {any}
 */
export function buildEmptyState(doc) {
  return buildMessage(doc, {
    className: 'sh-message--empty',
    heading: 'The photos are on their way',
    body: 'This listing has been shared, but its staged photographs are not ready yet. '
      + 'Check back shortly, or reply to whoever sent you this link.',
  });
}

/**
 * Every failure — revoked, expired, mistyped, never existed — renders THIS, with no reason
 * given. The server withholds the reason deliberately (a stranger with a guessed token
 * must learn nothing), so naming one here would be a guess presented as a fact.
 * @param {Document} doc
 * @returns {any}
 */
export function buildUnavailableState(doc) {
  return buildMessage(doc, {
    className: 'sh-message--gone',
    heading: 'This link is no longer available',
    body: 'The gallery it pointed to has been taken down or the link has changed. '
      + 'Ask whoever sent it to you for a current one.',
  });
}

/**
 * The small line under the title: how much there is to look at.
 * @param {Document} doc
 * @param {number} roomCount
 * @param {number} frameCount
 * @returns {any}
 */
export function buildSummary(doc, roomCount, frameCount) {
  const rooms = `${roomCount} ${roomCount === 1 ? 'room' : 'rooms'}`;
  const photos = `${frameCount} ${frameCount === 1 ? 'photo' : 'photos'}`;
  return el(doc, 'p', { className: 'sh-summary', text: `${rooms} · ${photos}` });
}
