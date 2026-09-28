// The analyst drawer: a conversation about the dashboard's own data, reachable
// from every tab.
//
// WHY A DRAWER RATHER THAN A TAB. The question an operator wants to ask is almost
// always about the thing they are currently looking at. A tab makes them leave it,
// re-describe it, and lose their place; a slide-over keeps that panel on screen
// beside the answer. Where a question has a specific referent, the Signals cards
// hand it over directly — `askAbout` opens the drawer with the finding already
// written into the composer, editable before it is sent.
//
// WHERE THE LOOP LIVES. Here. The server (routes/admin/analyst.js) is a single
// stateless turn: it is handed a transcript and answers with either a message or a
// set of tool calls. This file runs those calls against `ctx.data` via
// analyst-tools.js, appends the results, and posts again — up to MAX_ROUNDS, which
// is the only thing standing between a confused model and an unbounded bill.
//
// WHY EVERY BUBBLE IS BUILT WITH textContent. Two independent reasons, and either
// one alone would be sufficient. The operator's own text and the model's output are
// both untrusted strings, and the model's output additionally carries `acct_*`
// handles that are resolved to real email addresses on the way to the DOM
// (analyst-identity.js). An innerHTML path here would be both an injection sink and
// the one place a customer's address could be spliced into markup.

import { qs, el } from './helpers.js';
import { copyText } from '../clipboard.js';
import { createIdentityMap } from './analyst-identity.js';
import { createAnalystTools } from './analyst-tools.js';
import { renderAnswer } from './analyst-answer.js';

/**
 * How many model round-trips one question may take.
 *
 * Six is enough for the shape a real answer has — establish the trend, split it by
 * a dimension, check the split is big enough to mean anything, then read the
 * findings — and small enough that a model looping on a tool that keeps returning
 * nothing stops on its own rather than on the operator noticing.
 */
const MAX_ROUNDS = 6;

/**
 * How many messages of the transcript are posted.
 *
 * The route rejects a longer body outright, and a long session would otherwise
 * start failing for a reason that has nothing to do with the question. Trimming
 * naively is safe: the server prunes any tool reply the cut separates from the
 * assistant turn that requested it, so that rule lives in one place rather than
 * being mirrored (and drifting) here.
 */
const MAX_POSTED_MESSAGES = 40;

/**
 * Why there is no answer, in words rather than a code.
 *
 * At module scope, not inside the closure below, because it is pure and it is the
 * part of this file a test can actually pin.
 *
 * @param {string|undefined} reason
 * @returns {string}
 */
export function reasonText(reason) {
  if (reason === 'unavailable') {
    return 'No model is configured on this deployment, so the analyst cannot run. Every finding on the Signals '
      + 'tab is computed in your browser and is unaffected.';
  }
  if (reason === 'no-messages') return 'There was nothing to send.';
  if (reason === 'truncated') {
    return 'The model ran out of room before it finished answering. Ask for one thing at a time, or narrow the '
      + 'date range.';
  }
  if (reason === 'empty') return 'The model returned nothing. Try asking again, or more specifically.';
  return 'The analyst could not answer that. The dashboard itself is unaffected.';
}

/** Openers, shown on an empty drawer. Written as questions the tab cannot answer. */
const SUGGESTIONS = [
  'What changed in the last week, and is it real?',
  'Which room types or styles are actually failing, and how many renders is that?',
  'Which paying accounts should I email this week?',
  'Where are people dropping out before their first render?',
];

/**
 * @param {object} deps
 * @param {{data: any, analyst?: any}} deps.ctx Shared dashboard state.
 * @param {(url: string, method: string, body?: any, isForm?: boolean) => Promise<any>} deps.apiSend
 * @param {() => {findings: any[], failed: string[]}} deps.currentFindings The memoized rules-engine run.
 * @param {(u: any) => string} deps.effectivePlan
 */
export function createAnalyst({ ctx, apiSend, currentFindings, effectivePlan }) {
  const identity = createIdentityMap();
  const tools = createAnalystTools({ ctx, identity, currentFindings, effectivePlan });

  /**
   * The visible conversation. The transcript posted to the server is derived from it.
   *
   * `run` counts questions asked in this drawer. Stopping bumps it, and every
   * await in the loop below checks it before touching state — which is how a
   * six-round question is abandoned without an AbortController threaded through
   * the shared `apiSend`. The in-flight request still finishes at the server; what
   * stops is this conversation listening to it.
   */
  function state() {
    if (!ctx.analyst) {
      ctx.analyst = { open: false, busy: false, turns: [], messages: [], error: null, run: 0, lastQuestion: '' };
    }
    return ctx.analyst;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  /**
   * One block of model prose, with account handles resolved.
   *
   * The grammar lives in analyst-answer.js; what matters here is that it is given
   * `identity.segment`, so a handle becomes a `<span>` carrying the real address
   * while the model's text never touches innerHTML.
   */
  function prose(text) {
    return renderAnswer(text, identity.segment);
  }

  /**
   * The "ran N queries" line under an answer.
   *
   * Names the tools, never their output, and names each one once however often the
   * model called it — a trace reading `segment_breakdown segment_breakdown
   * segment_breakdown` says less than the count beside it already did.
   */
  function toolTrace(names) {
    if (!names.length) return null;
    const wrap = el('div', { className: 'adm-an-trace' });
    wrap.appendChild(el('span', { className: 'adm-an-trace-label', textContent: `${names.length} quer${names.length === 1 ? 'y' : 'ies'}` }));
    [...new Set(names)].forEach((n) => wrap.appendChild(el('code', { className: 'adm-an-tool', textContent: n })));
    return wrap;
  }

  /**
   * Copy one answer as the model wrote it.
   *
   * The raw text, not the rendered DOM: the operator pasting this into a ticket
   * wants the table markup back, and the handles are already resolved in `turn.text`
   * — this is the same address they are looking at, not a new disclosure.
   */
  function copyButton(text) {
    const btn = el('button', { type: 'button', className: 'adm-an-copy', textContent: 'Copy' });
    btn.addEventListener('click', () => {
      copyText(text).then((ok) => { btn.textContent = ok ? 'Copied' : 'Copy failed'; })
        .catch(() => { btn.textContent = 'Copy failed'; });
    });
    return btn;
  }

  function turnNode(turn) {
    if (turn.role === 'user') {
      return el('div', { className: 'adm-an-turn adm-an-turn--user' }, [
        el('p', { className: 'adm-an-para', textContent: turn.text }),
      ]);
    }
    const node = el('div', { className: 'adm-an-turn adm-an-turn--answer' }, [prose(turn.text)]);
    const foot = el('div', { className: 'adm-an-foot' });
    const trace = toolTrace(turn.tools || []);
    if (trace) foot.appendChild(trace);
    foot.appendChild(copyButton(turn.text));
    node.appendChild(foot);
    return node;
  }

  function renderTranscript() {
    const host = qs('#adm-an-log');
    if (!host) return;
    const s = state();
    // Measured before the rebuild, used after it. The fake DOM the island tests run
    // against has no geometry, so a missing number reads as "at the bottom" — the
    // behaviour this had before there was a choice.
    const atBottom = !Number.isFinite(host.scrollHeight) || !Number.isFinite(host.scrollTop)
      || host.scrollHeight - host.scrollTop - (host.clientHeight || 0) < 48;
    host.innerHTML = '';

    if (!s.turns.length && !s.busy) {
      host.appendChild(el('p', {
        className: 'adm-an-empty',
        textContent: 'Ask about anything on this dashboard. Every number in an answer comes back from a query run '
          + 'here in your browser — account names never leave it.',
      }));
      const list = el('div', { className: 'adm-an-suggestions' });
      SUGGESTIONS.forEach((q) => {
        const b = el('button', { type: 'button', className: 'adm-an-suggestion', textContent: q });
        b.addEventListener('click', () => submit(q));
        list.appendChild(b);
      });
      host.appendChild(list);
    }

    s.turns.forEach((t) => host.appendChild(turnNode(t)));

    if (s.busy) {
      const stop = el('button', { type: 'button', className: 'adm-an-stop', textContent: 'Stop' });
      stop.addEventListener('click', cancel);
      host.appendChild(el('div', { className: 'adm-an-turn adm-an-turn--answer' }, [
        el('p', { className: 'adm-an-thinking', textContent: s.busyNote || 'Thinking…' }),
        stop,
      ]));
    }

    if (s.error) {
      const box = el('div', { className: 'adm-an-error' }, [el('p', { className: 'adm-an-para', textContent: s.error })]);
      // Every failure here is worth one more attempt — a truncated answer, a
      // dropped connection, a model that said nothing. Making the operator retype
      // the question was the part that made a failure feel terminal.
      if (s.lastQuestion) {
        const again = el('button', { type: 'button', className: 'adm-an-retry', textContent: 'Try again' });
        again.addEventListener('click', () => retry());
        box.appendChild(again);
      }
      host.appendChild(box);
    }

    // Only follow the conversation when the operator is already at the bottom of
    // it. Yanking them down mid-sentence because a tool round finished is how a
    // long answer becomes unreadable.
    if (atBottom) host.scrollTop = host.scrollHeight;
  }

  // ── The loop ──────────────────────────────────────────────────────────────

  /**
   * Run one question to completion.
   *
   * Each iteration is one server turn. Tool calls are executed locally and pushed
   * back as `tool` messages; the loop ends on a prose answer, an error, or the
   * round cap — never on an unbounded model decision.
   */
  async function submit(text) {
    const question = String(text || '').trim();
    const s = state();
    if (!question || s.busy) return;

    s.error = null;
    s.lastQuestion = question;
    s.turns.push({ role: 'user', text: question });
    s.messages.push({ role: 'user', content: question });
    s.busy = true;
    s.busyNote = 'Thinking…';
    s.run += 1;
    const run = s.run;
    /** True once the operator has stopped this question, or asked another one. */
    const abandoned = () => s.run !== run;
    setInputBusy(true);
    renderTranscript();

    /** Tool names used across this question, for the trace line under the answer. */
    const used = [];

    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const res = await apiSend('/api/admin/analyst', 'POST', { messages: s.messages.slice(-MAX_POSTED_MESSAGES) });
        // Checked after every await: a stopped question must not append its answer
        // to a transcript the operator has since moved on from.
        if (abandoned()) return;

        if (res && Array.isArray(res.toolCalls) && res.toolCalls.length) {
          // Replay the assistant's request into the transcript verbatim — the tool
          // messages that follow are only valid against the ids it chose.
          s.messages.push({
            role: 'assistant',
            content: res.message || null,
            tool_calls: res.toolCalls.map((c) => ({
              id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments },
            })),
          });

          res.toolCalls.forEach((c) => {
            used.push(c.name);
            s.messages.push({ role: 'tool', tool_call_id: c.id, content: tools.run(c) });
          });

          s.busyNote = `Running ${res.toolCalls.map((c) => c.name).join(', ')}…`;
          renderTranscript();
          continue;
        }

        if (res && res.message) {
          s.messages.push({ role: 'assistant', content: res.message });
          s.turns.push({ role: 'answer', text: res.message, tools: used.slice() });
        } else {
          s.error = reasonText(res && res.reason);
        }
        break;
      }

      // Falling out of the loop with nothing said means the model kept calling tools.
      // Say so rather than leaving a question that silently never got answered.
      if (!s.error && s.turns[s.turns.length - 1].role === 'user') {
        s.error = `The analyst ran ${MAX_ROUNDS} rounds of queries without reaching an answer. `
          + 'Try narrowing the question.';
      }
    } catch (error) {
      if (abandoned()) return;
      s.error = (error && error.status === 401)
        ? 'Your admin session expired. Sign in again.'
        : reasonText('error');
    } finally {
      // A stopped question already handed the drawer back; unwinding here would
      // clear the busy state of whatever replaced it.
      if (!abandoned()) {
        s.busy = false;
        s.busyNote = '';
        setInputBusy(false);
        renderTranscript();
      }
    }
  }

  /**
   * Abandon the question in flight.
   *
   * The round loop notices at its next await and returns without touching state.
   * The request already sent still completes at the server — there is no way to
   * unsend it — so this is worded as stopping rather than cancelling.
   */
  function cancel() {
    const s = state();
    if (!s.busy) return;
    s.run += 1;
    s.busy = false;
    s.busyNote = '';
    s.error = 'Stopped.';
    setInputBusy(false);
    renderTranscript();
  }

  /** Ask the last question again, dropping the failed attempt from the transcript. */
  function retry() {
    const s = state();
    if (s.busy || !s.lastQuestion) return;
    const question = s.lastQuestion;

    // Rewind to before the failed attempt: its user message, and any tool round it
    // got through, are context the next attempt does not need and the 40-message
    // cap would rather not carry.
    const at = s.messages.map((m) => m.role).lastIndexOf('user');
    if (at >= 0) s.messages = s.messages.slice(0, at);
    if (s.turns.length && s.turns[s.turns.length - 1].role === 'user') s.turns.pop();

    s.error = null;
    return submit(question);
  }

  // ── The drawer ────────────────────────────────────────────────────────────

  /**
   * Reflect the busy state on the composer.
   *
   * Enter already did nothing while a question was in flight; what it did not do
   * was say so, which reads as a dropped keystroke rather than as a queue.
   */
  function setInputBusy(busy) {
    const input = /** @type {HTMLTextAreaElement|null} */ (qs('#adm-an-input'));
    const send = qs('#adm-an-form .adm-an-send');
    if (input) {
      input.disabled = busy;
      input.setAttribute('placeholder', busy ? 'Answering…' : 'Ask about renders, accounts, failures, growth…');
    }
    if (send) send.disabled = busy;
  }

  /** Start over: no transcript, no handles, nothing carried into the next question. */
  function clear() {
    const s = state();
    // Bumping the run abandons anything in flight, so a clear during a long
    // question cannot be followed by that question's answer appearing.
    s.run += 1;
    ctx.analyst = null;
    identity.reset();
    setInputBusy(false);
    renderTranscript();
  }

  function setOpen(open) {
    const s = state();
    s.open = open;
    const drawer = qs('#adm-analyst');
    const launcher = qs('#adm-an-open');
    if (!drawer) return;
    drawer.classList.toggle('adm-an--open', open);
    drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (launcher) launcher.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      renderTranscript();
      const input = /** @type {HTMLTextAreaElement|null} */ (qs('#adm-an-input'));
      if (input) input.focus();
    }
  }

  /**
   * Open the drawer with a question about one finding already typed.
   *
   * The finding is passed as text rather than as an id because the model has
   * `list_findings` and can look the rest up — and because a question the operator
   * can read and edit before sending beats one assembled invisibly.
   */
  function askAbout(finding) {
    setOpen(true);
    const input = /** @type {HTMLTextAreaElement|null} */ (qs('#adm-an-input'));
    if (!input) return;
    input.value = `About the finding "${finding.title}" (${finding.id}): is this worth acting on, and what is `
      + 'actually behind it?';
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  /** Wire the drawer once. Idempotent — `init` is called from the entry on boot. */
  function init() {
    const launcher = qs('#adm-an-open');
    const closeBtn = qs('#adm-an-close');
    const form = qs('#adm-an-form');
    const input = /** @type {HTMLTextAreaElement|null} */ (qs('#adm-an-input'));

    const clearBtn = qs('#adm-an-clear');

    if (launcher) launcher.addEventListener('click', () => setOpen(!state().open));
    if (closeBtn) closeBtn.addEventListener('click', () => setOpen(false));
    if (clearBtn) clearBtn.addEventListener('click', () => clear());

    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (!input) return;
        const text = input.value;
        input.value = '';
        submit(text);
      });
    }

    // Enter sends, Shift+Enter breaks a line. The drawer is a chat, and a textarea
    // that needed the mouse to send would be wrong in every other respect.
    if (input) {
      input.addEventListener('keydown', (e) => {
        const ev = /** @type {KeyboardEvent} */ (e);
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          const text = input.value;
          input.value = '';
          submit(text);
        }
      });
    }

    // Guarded because the admin islands are unit-tested against a STUB document
    // (the same reason charts.js never measures the DOM). Escape-to-close is a
    // convenience; a test harness without a document-level listener must not be
    // the thing that stops the whole console booting.
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('keydown', (e) => {
        if (/** @type {KeyboardEvent} */ (e).key === 'Escape' && state().open) setOpen(false);
      });
    }
  }

  /**
   * Drop the conversation and every account handle.
   *
   * Called on reload and on sign-out. The identity map MUST be cleared here: it is
   * the only structure in the console that holds addresses outside `ctx.data`, and
   * a sign-out that left it populated would keep the previous operator's account
   * list alive in a closure until the tab was closed.
   */
  function reset() {
    // The same work as the drawer's own Clear, which also abandons a question in
    // flight — a sign-out that let one land afterwards would paint the previous
    // operator's answer onto the login screen's console.
    clear();
  }

  return { init, setOpen, askAbout, reset, clear, cancel, retry, submit };
}
