// The analyst drawer: a conversation about the dashboard's own data, reachable
// from every tab.
//
// WHY A DRAWER RATHER THAN A TAB. The question an operator wants to ask is almost
// always about the thing they are currently looking at. A tab makes them leave it,
// re-describe it, and lose their place; a slide-over keeps the panel underneath and
// lets the drawer be told which tab is open, so "why is this happening" has a
// referent without anybody typing one.
//
// WHERE THE LOOP LIVES. Here. The server (routes/admin-analyst.js) is a single
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
import { createIdentityMap } from './analyst-identity.js';
import { createAnalystTools } from './analyst-tools.js';

/**
 * How many model round-trips one question may take.
 *
 * Six is enough for the shape a real answer has — establish the trend, split it by
 * a dimension, check the split is big enough to mean anything, then read the
 * findings — and small enough that a model looping on a tool that keeps returning
 * nothing stops on its own rather than on the operator noticing.
 */
const MAX_ROUNDS = 6;

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

  /** The visible conversation. The transcript posted to the server is derived from it. */
  function state() {
    if (!ctx.analyst) ctx.analyst = { open: false, busy: false, turns: [], messages: [], error: null };
    return ctx.analyst;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  /**
   * One block of model prose, with account handles resolved.
   *
   * Paragraphs are split on blank lines and each run of text is appended as a text
   * node — no markdown parser, no innerHTML. A handle becomes a `<span>` carrying
   * the real address so it can be styled and copied, and its `title` records that
   * the model never saw it.
   */
  function prose(text) {
    const wrap = el('div', { className: 'adm-an-prose' });
    String(text || '').split(/\n{2,}/).forEach((para) => {
      if (!para.trim()) return;
      const p = el('p', { className: 'adm-an-para' });
      identity.segment(para).forEach((seg) => {
        if (!seg.account) { p.appendChild(document.createTextNode(seg.text)); return; }
        p.appendChild(el('span', {
          className: 'adm-an-acct',
          textContent: seg.text,
          title: 'Resolved in your browser — the model saw an opaque handle, not this address.',
        }));
      });
      wrap.appendChild(p);
    });
    return wrap;
  }

  /** The "ran N queries" line under an answer. Names the tools, never their output. */
  function toolTrace(names) {
    if (!names.length) return null;
    const wrap = el('div', { className: 'adm-an-trace' });
    wrap.appendChild(el('span', { className: 'adm-an-trace-label', textContent: `${names.length} quer${names.length === 1 ? 'y' : 'ies'}` }));
    names.forEach((n) => wrap.appendChild(el('code', { className: 'adm-an-tool', textContent: n })));
    return wrap;
  }

  function turnNode(turn) {
    if (turn.role === 'user') {
      return el('div', { className: 'adm-an-turn adm-an-turn--user' }, [
        el('p', { className: 'adm-an-para', textContent: turn.text }),
      ]);
    }
    const node = el('div', { className: 'adm-an-turn adm-an-turn--answer' }, [prose(turn.text)]);
    const trace = toolTrace(turn.tools || []);
    if (trace) node.appendChild(trace);
    return node;
  }

  function renderTranscript() {
    const host = qs('#adm-an-log');
    if (!host) return;
    const s = state();
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
      host.appendChild(el('div', { className: 'adm-an-turn adm-an-turn--answer' }, [
        el('p', { className: 'adm-an-thinking', textContent: s.busyNote || 'Thinking…' }),
      ]));
    }
    if (s.error) host.appendChild(el('p', { className: 'adm-an-error', textContent: s.error }));

    host.scrollTop = host.scrollHeight;
  }

  // ── The loop ──────────────────────────────────────────────────────────────

  /** Why there is no answer, in words rather than a code. */
  function reasonText(reason) {
    if (reason === 'unavailable') {
      return 'No model is configured on this deployment, so the analyst cannot run. Every finding on the Signals '
        + 'tab is computed in your browser and is unaffected.';
    }
    if (reason === 'no-messages') return 'There was nothing to send.';
    if (reason === 'empty') return 'The model returned nothing. Try asking again, or more specifically.';
    return 'The analyst could not answer that. The dashboard itself is unaffected.';
  }

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
    s.turns.push({ role: 'user', text: question });
    s.messages.push({ role: 'user', content: question });
    s.busy = true;
    s.busyNote = 'Thinking…';
    renderTranscript();

    /** Tool names used across this question, for the trace line under the answer. */
    const used = [];

    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const res = await apiSend('/api/admin/analyst', 'POST', { messages: s.messages });

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
      s.error = (error && error.status === 401)
        ? 'Your admin session expired. Sign in again.'
        : reasonText('error');
    } finally {
      s.busy = false;
      s.busyNote = '';
      renderTranscript();
    }
  }

  // ── The drawer ────────────────────────────────────────────────────────────

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

    if (launcher) launcher.addEventListener('click', () => setOpen(!state().open));
    if (closeBtn) closeBtn.addEventListener('click', () => setOpen(false));

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
    ctx.analyst = null;
    identity.reset();
    if (qs('#adm-an-log')) renderTranscript();
  }

  return { init, setOpen, askAbout, reset, submit };
}
