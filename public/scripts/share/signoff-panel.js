// One sign-off panel: the two buttons, the note form, and the answer once it is recorded.
// The same widget is mounted per room and once for the whole listing; the only difference
// is what it calls the thing being answered.
//
// OPTIMISTIC, BUT HONEST. Tapping "Looks great" paints the answer immediately — a seller
// on a train should not watch a spinner to find out whether a button worked. The price of
// that is that the page can be wrong, so every optimistic write snapshots the state it
// replaced and puts it back on failure. What must survive the rollback is not the layout,
// it is THE TYPED NOTE: somebody has written three sentences about the sofa, and losing
// them to a flaky connection is the one failure they will not repeat. So `draft` lives in
// this closure, not in the textarea, and the re-render puts it back.
//
// THE STATUS LINE IS BUILT ONCE AND NEVER REPLACED. It is the panel's live region, and a
// live region that is created (or unhidden) at the same moment its text changes is a live
// region screen readers do not reliably announce. So the element is in the DOM from the
// first paint, empty, and only its text ever changes — while the BODY above it is rebuilt
// freely on every state change.
//
// EVERY CONTROL IS A REAL <button>. Not a styled <div>: this page is read on phones by
// people who did not choose the software, and the whole point of the reply path is that it
// is reachable — by thumb (44px minimum, enforced in share.css) and by keyboard.

import { clear, el } from './dom.js';
import { NOTE_LIMIT, clampNote } from './feedback-model.js';

/**
 * @typedef {import('./feedback-model.js').Allowance} Allowance
 * @typedef {import('./feedback-model.js').Verdict} Verdict
 */

/**
 * @typedef {object} PanelAnswer
 * @property {Verdict} verdict
 * @property {string} note
 */

/**
 * @typedef {object} PanelOptions
 * @property {string|null} roomKey - null for the whole-listing panel.
 * @property {string} slug - Unique id fragment, so two panels never share a heading id.
 * @property {string} label - What this panel is answering about, in a sentence
 *   ("Living room", "this listing").
 * @property {string} heading - The visible heading.
 * @property {string} headingTag - `h2` for the listing panel, `h3` inside a room section,
 *   so the document outline stays in order.
 * @property {string} [className] - Extra class on the section.
 * @property {any} [lead] - Optional element placed under the heading and kept across
 *   re-renders. The listing panel puts the shared "Your name" field here.
 */

/**
 * @typedef {object} PanelDeps
 * @property {(payload: { roomKey: string|null, verdict: Verdict, note: string }) => Promise<import('./feedback-api.js').SendResult>} send
 * @property {(allowance: Allowance) => void} onAllowance - Called after every accepted
 *   write, and after a 409, so the controller can lock every other panel at once.
 */

/**
 * @typedef {object} SignOffPanel
 * @property {any} node
 * @property {(answer: PanelAnswer|null) => void} setAnswer
 * @property {(full: boolean) => void} setFull
 * @property {() => PanelAnswer|null} getAnswer
 */

const SENDING = 'Sending…';
const FAILED = 'That did not send. Nothing was lost — your note is still here, so please try again.';
const NEED_NOTE = 'Add a short note so the agent knows what to change.';
const FULL_TEXT = 'We already have your notes from this link. Thank you — the agent can see them.';
// A refusal that is NOT a mistake and NOT permanent, so it says neither "that failed" nor
// "try again": the rate limiter's window is minutes long, and FAILED's advice to retry is
// wrong for the whole of it. The note is kept in the field exactly as FAILED keeps it, so
// the wait costs the seller nothing but time.
const THROTTLED_TEXT = 'That was a lot of notes at once — please wait a few minutes, then send this one. Your note is safe here.';

/**
 * Build one panel.
 *
 * @param {Document} doc
 * @param {PanelOptions} options
 * @param {PanelDeps} deps
 * @returns {SignOffPanel}
 */
export function buildSignOffPanel(doc, options, deps) {
  /** @type {PanelAnswer|null} */
  let answer = null;
  let asking = false;
  let draft = '';
  let busy = false;
  let full = false;
  /** @type {any} */
  let noteField = null;

  const headingId = `sh-signoff-${options.slug}`;
  const noteId = `sh-signoff-note-${options.slug}`;
  const counterId = `sh-signoff-count-${options.slug}`;

  const status = el(doc, 'p', {
    className: 'sh-signoff__status',
    attrs: { role: 'status', 'aria-live': 'polite' },
  });
  const body = el(doc, 'div', { className: 'sh-signoff__body' });

  const node = el(doc, 'section', {
    className: options.className ? `sh-signoff ${options.className}` : 'sh-signoff',
    attrs: {
      'aria-labelledby': headingId,
      // OPTING THE PANEL OUT OF THE PAGE'S LIVE REGION. `#sh-body` is `aria-live="polite"`
      // so the gallery announces itself when it lands, and aria-live is INHERITED by
      // descendants — which would make every button press here re-announce the whole
      // rebuilt panel, on top of the one sentence the status line already says. `off` on
      // the section scopes the inheritance out, and the status line below re-declares
      // `polite` for itself, which is the only part that should ever speak.
      'aria-live': 'off',
    },
    children: [
      el(doc, options.headingTag, {
        className: 'sh-signoff__heading',
        id: headingId,
        text: options.heading,
      }),
      options.lead || null,
      body,
      status,
    ],
  });

  /**
   * Write the live region. `tone` only drives colour — the text says everything, because a
   * red line that reads the same as a green one tells a screen-reader user nothing.
   * @param {string} message
   * @param {string} [tone] - 'error' or omitted.
   */
  function say(message, tone) {
    status.textContent = message;
    if (tone) status.setAttribute('data-tone', tone);
    else status.removeAttribute('data-tone');
  }

  /** @param {any} field */
  function focusField(field) {
    if (field && typeof field.focus === 'function') field.focus();
  }

  // ── the four bodies ────────────────────────────────────────────────────────

  /** The starting state: two answers, one tap each. */
  function choices() {
    return el(doc, 'div', {
      className: 'sh-signoff__choices',
      children: [
        el(doc, 'button', {
          className: 'sh-signoff__btn sh-signoff__btn--yes',
          text: 'Looks great',
          attrs: {
            type: 'button',
            disabled: busy,
            'aria-label': `Looks great — approve ${options.label}`,
          },
          on: { click: () => submit('approved', '') },
        }),
        el(doc, 'button', {
          className: 'sh-signoff__btn sh-signoff__btn--change',
          text: 'Ask for a change',
          attrs: {
            type: 'button',
            disabled: busy,
            'aria-label': `Ask for a change to ${options.label}`,
          },
          on: {
            click: () => {
              asking = true;
              say('');
              render();
              focusField(noteField);
            },
          },
        }),
      ],
    });
  }

  /** The note form. The counter is bound with aria-describedby, not merely printed. */
  function noteForm() {
    const counter = el(doc, 'p', {
      className: 'sh-signoff__counter',
      id: counterId,
      text: `${draft.length} of ${NOTE_LIMIT} characters`,
    });

    noteField = el(doc, 'textarea', {
      className: 'sh-signoff__field',
      id: noteId,
      attrs: {
        rows: '3',
        // The server clamps at the same number. `maxlength` is what makes that clamp
        // visible instead of silent: text that would be cut simply cannot be typed.
        maxlength: String(NOTE_LIMIT),
        'aria-describedby': counterId,
        placeholder: 'For example: the sofa feels too large for the room.',
      },
      on: {
        input: () => {
          draft = clampNote(noteField && noteField.value);
          counter.textContent = `${draft.length} of ${NOTE_LIMIT} characters`;
        },
      },
    });
    // Assigned rather than passed as `text`: a textarea's *content* is its default value,
    // and re-rendering with a stale default is how a restored draft goes missing.
    noteField.value = draft;

    return el(doc, 'div', {
      className: 'sh-signoff__form',
      children: [
        el(doc, 'label', {
          className: 'sh-signoff__label',
          text: `What would you like changed about ${options.label}?`,
          attrs: { for: noteId },
        }),
        noteField,
        counter,
        el(doc, 'div', {
          className: 'sh-signoff__actions',
          children: [
            el(doc, 'button', {
              className: 'sh-signoff__btn sh-signoff__btn--yes',
              text: 'Send this note',
              attrs: { type: 'button', disabled: busy },
              on: { click: sendNote },
            }),
            el(doc, 'button', {
              className: 'sh-signoff__btn sh-signoff__btn--quiet',
              text: 'Cancel',
              attrs: { type: 'button', disabled: busy },
              on: {
                click: () => {
                  asking = false;
                  say('');
                  render();
                },
              },
            }),
          ],
        }),
      ],
    });
  }

  /** What is on record. Shown from the boot fetch too, so a returning viewer sees it. */
  function answered() {
    const recorded = /** @type {PanelAnswer} */ (answer);
    const children = [
      el(doc, 'p', {
        className: 'sh-signoff__verdict',
        attrs: { 'data-verdict': recorded.verdict },
        text: recorded.verdict === 'approved'
          ? 'You said this looks great.'
          : 'You asked for a change:',
      }),
    ];
    if (recorded.note) {
      children.push(el(doc, 'p', { className: 'sh-signoff__quote', text: recorded.note }));
    }
    if (full) {
      children.push(el(doc, 'p', { className: 'sh-signoff__full', text: FULL_TEXT }));
    } else {
      children.push(el(doc, 'button', {
        className: 'sh-signoff__btn sh-signoff__btn--quiet',
        text: 'Change your answer',
        attrs: { type: 'button', disabled: busy, 'aria-label': `Change your answer about ${options.label}` },
        on: {
          click: () => {
            answer = null;
            asking = false;
            say('');
            render();
          },
        },
      }));
    }
    return el(doc, 'div', { className: 'sh-signoff__answer', children });
  }

  /** The ceiling, with nothing on record for this slot: calm, and no controls at all. */
  function exhausted() {
    return el(doc, 'p', { className: 'sh-signoff__full', text: FULL_TEXT });
  }

  function render() {
    clear(body);
    noteField = null;
    if (answer) body.appendChild(answered());
    else if (full) body.appendChild(exhausted());
    else if (asking) body.appendChild(noteForm());
    else body.appendChild(choices());
  }

  // ── writing ────────────────────────────────────────────────────────────────

  /** Validate, then submit. The note is required here and only here. */
  function sendNote() {
    if (busy) return;
    draft = clampNote(noteField && noteField.value);
    if (!draft) {
      // Deliberately NOT a re-render: the caret, the scroll position and the field itself
      // all survive, and the only thing that changes is the sentence under the form.
      say(NEED_NOTE, 'error');
      focusField(noteField);
      return;
    }
    void submit('changes', draft);
  }

  /**
   * Paint the answer, send it, and put the old state back if the send failed.
   * @param {Verdict} verdict
   * @param {string} note
   */
  async function submit(verdict, note) {
    if (busy) return;
    const before = { answer, asking, draft };

    busy = true;
    answer = { verdict, note };
    asking = false;
    render();
    say(SENDING);

    const result = await deps.send({ roomKey: options.roomKey, verdict, note });
    busy = false;

    // `=== true`, not `if (result.ok)`. tsconfig.frontend.json runs with strictNullChecks
    // off for the rollout, and under that flag TypeScript does NOT narrow a discriminated
    // union by the truthiness of a boolean-literal discriminant — only by an equality
    // comparison. The plain form type-checks and then silently offers the wrong members.
    if (result.ok === true) {
      // The server's echo wins when there is one: it is the authority on what was stored.
      if (result.feedback) answer = { verdict: result.feedback.verdict, note: result.feedback.note };
      draft = '';
      say(verdict === 'approved'
        ? `Saved. ${capitalize(options.label)} is marked as looking great.`
        : `Saved. Your note about ${options.label} was sent.`);
      render();
      deps.onAllowance(result.allowance);
      return;
    }

    answer = before.answer;
    asking = before.asking;
    draft = before.draft;

    if (result.code === 'FULL') {
      // Not an error. The controller locks every panel, which repaints this one too.
      say('');
      render();
      deps.onAllowance(result.allowance);
      return;
    }

    say(result.code === 'THROTTLED' ? THROTTLED_TEXT : FAILED, 'error');
    render();
    focusField(noteField);
  }

  /**
   * @param {string} value
   * @returns {string}
   */
  function capitalize(value) {
    return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
  }

  render();

  return {
    node,

    setAnswer(next) {
      answer = next ? { verdict: next.verdict, note: clampNote(next.note) } : null;
      asking = false;
      render();
    },

    setFull(next) {
      full = next === true;
      if (full) asking = false;
      render();
    },

    getAnswer: () => (answer ? { verdict: answer.verdict, note: answer.note } : null),
  };
}
