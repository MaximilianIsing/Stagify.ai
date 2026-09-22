// The admin console's analyst: one turn of a tool-calling conversation over the
// dashboard's own data.
//
// HOW THIS DIFFERS FROM admin-brief.js, WHICH IT SITS BESIDE
//
// The brief is a presentation layer. It is handed findings that are already
// computed and already checked, and it is told — in as many words, at temperature
// 0 — to restate them and never to derive a number. That is right for a paragraph
// that appears unbidden above a list of cards, because a fabricated percentage in
// an operator console gets acted on and there is no way to tell it from the twenty
// real ones beside it.
//
// This is the opposite instrument. Computing IS the job here: the operator is
// asking a question nobody pre-aggregated, and an answer that restates the
// dashboard is exactly the answer they already have. The safeguard is therefore
// not "never compute" but "never compute WITHOUT A TOOL" — every number in an
// answer has to have come back from a tool call, and the system prompt spends most
// of its length on that one rule and on the caveats that make a number honest.
//
// THREE THINGS THIS MODULE DOES NOT DO
//
// 1. **It does not execute tools.** It returns the model's tool calls to the
//    browser, which runs them against `ctx.data` using the same aggregators the
//    charts use, and posts the results back on the next turn. So the loop is in
//    the browser and this function stays a pure single-shot — which is also why it
//    needs no session store.
// 2. **It does not accept tool definitions from the client.** They come from
//    lib/services/admin-analyst-tools.js. A description is an instruction to the
//    model, and an endpoint that let the caller supply one would let the caller
//    rewrite the prompt.
// 3. **It does not trust the transcript it is handed.** `sanitizeMessages` rebuilds
//    every message from an allowlist and scrubs anything address-shaped, the same
//    posture as admin-brief.js#sanitizeFindings. The browser is supposed to send
//    pseudonymised tool results; "supposed to" is not a guarantee that survives a
//    future edit to a file in public/, and this is the second path in the console
//    that reaches a third party.
//
// It fails open, like everything else on this tab: no key, a timeout, a refusal
// and an empty completion all return a reason code and leave the dashboard intact.

import { ANALYST_MODEL, ANALYST_MAX_OUTPUT_TOKENS, ANALYST_REASONING_EFFORT } from '../config/model-config.js';
import { toolsForModel, ANALYST_TOOL_NAMES } from './admin-analyst-tools.js';
import { scrub } from './admin-brief.js';
import { logger } from '../logger.js';

/** Hard caps, so a malformed or hostile client cannot inflate one call. */
const MAX_MESSAGES = 40;
const MAX_CONTENT = 8000;
// Tool results get their own, larger cap. They are machine-written JSON, not
// prose: clamping them at the 8000 that suits a typed question hands the model a
// document cut mid-token, which is worse than a smaller honest one. The browser
// already bounds every payload it builds, so this is a backstop.
const MAX_TOOL_CONTENT = 16000;
const TRUNCATION_MARKER = ' …[truncated: result too large]';
const MAX_TOOL_CALLS = 8;
/** Ceiling for the one retry after a truncated turn; matches model-config's clamp. */
const MAX_RETRY_TOKENS = 32000;

/** Roles a client may send. `system` is deliberately absent — we supply that. */
const CLIENT_ROLES = new Set(['user', 'assistant', 'tool']);

const SYSTEM_PROMPT = [
  'You are the analyst for Stagify, an AI virtual-staging web app. You are talking to the person who runs it,',
  'inside their own admin console. They are technical, they already have the charts, and they are asking you',
  'because the chart did not answer the question.',
  '',
  'HOW YOU ANSWER',
  '- Call tools. Every number in your answer must have come back from a tool call in this conversation.',
  '  Never estimate, never carry a number over from general knowledge, and never round a figure into a',
  '  different one. If no tool can answer, say exactly that and say what would have to be logged.',
  '- Chain tool calls without asking permission. A real answer usually takes three or four: establish the',
  '  shape, then split it by a dimension, then check whether the split is big enough to mean anything.',
  '- Lead with the answer in one sentence. Then the evidence. Then, only if it is genuinely open, what you',
  '  would look at next.',
  '',
  'WHAT MAKES AN ANSWER HONEST HERE',
  '- Always give the denominator beside a rate. "8% of renders" is not a finding; "8% of 1,240 renders" is.',
  '- Never call a difference real on fewer than five affected events, however large the ratio looks. One',
  '  failed render out of fifty is one failed render. The rules engine uses the same floor and it exists',
  '  because a ratio computed on a single event is noise wearing a percentage sign.',
  '- A tool result may carry a `caveats` array. Those are not boilerplate: they are the places where absent',
  '  data would otherwise read as zero. Repeat any caveat that bears on your answer, in your own words.',
  '- Distinguish "no data" from "zero". If a tool returns null for a rate, the rate was not measurable —',
  '  it is not 0%, and it is not 100%.',
  '- If the data genuinely does not settle the question, say so plainly. That is a useful answer. A',
  '  confident story built on forty renders is not.',
  '',
  'ACCOUNTS',
  'Accounts appear as opaque handles like acct_4f1a2b. Use the handle verbatim in your answer; the console',
  'renders the real address in its place. You will never see an email, an IP or a customer prompt, and you',
  'should not ask for one — the handle is enough to act on.',
  '',
  'STYLE',
  'Plain prose and short paragraphs. A small markdown table when you are genuinely comparing rows, never as',
  'decoration. Bullet lists are fine for three or more parallel items. No headings, no preamble, no restating',
  'the question, no offers to help further.',
].join('\n');

/**
 * The system prompt, dated.
 *
 * Every tool payload is full of absolute dates — bucket keys, cohort months,
 * signup timestamps — and nothing else in the conversation says what "now" is. A
 * model left to infer it from its own training anchors "the last week" to the
 * wrong year and then reasons confidently from there, which is the one class of
 * mistake this prompt otherwise spends its whole length preventing.
 *
 * @returns {string}
 */
function systemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return `${SYSTEM_PROMPT}\n\nTODAY\nToday is ${today}. Every window a tool reports is counted back from now, and `
    + 'dates in a payload are absolute — read them against today\'s date, never against anything you remember.';
}

/**
 * Rebuild the transcript from an allowlist.
 *
 * Positional integrity matters more than it looks: a `tool` message is only valid
 * immediately after an assistant turn that requested that `tool_call_id`, so the
 * ids are preserved verbatim (they are ours, not the operator's) while everything
 * a human or a tool wrote is scrubbed and clamped.
 *
 * @param {any[]} messages
 * @returns {Array<object>}
 */
export function sanitizeMessages(messages) {
  const list = Array.isArray(messages) ? messages.slice(-MAX_MESSAGES) : [];
  /** @type {Array<object>} */
  const out = [];

  for (const m of list) {
    if (!m || typeof m !== 'object' || !CLIENT_ROLES.has(m.role)) continue;

    if (m.role === 'tool') {
      if (!m.tool_call_id) continue;
      out.push({
        role: 'tool',
        tool_call_id: String(m.tool_call_id).slice(0, 64),
        content: scrubToolContent(m.content),
      });
      continue;
    }

    // An assistant turn that requested tools has to be replayed with those
    // requests intact, or the `tool` messages that follow it reference nothing.
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls.slice(0, MAX_TOOL_CALLS) : [];
    if (m.role === 'assistant' && calls.length) {
      const known = calls
        .filter((c) => c && c.function && ANALYST_TOOL_NAMES.includes(c.function.name))
        .map((c) => ({
          id: String(c.id).slice(0, 64),
          type: 'function',
          function: {
            name: String(c.function.name),
            arguments: scrub(c.function.arguments, 2000),
          },
        }));
      // Every call filtered out leaves `tool_calls: []`, which the API rejects
      // outright — so the whole turn goes rather than a turn that cannot be sent.
      // The prune below then removes the `tool` replies it orphaned.
      if (known.length) out.push({ role: 'assistant', content: m.content ? scrub(m.content, MAX_CONTENT) : null, tool_calls: known });
      continue;
    }

    const content = scrub(m.content, MAX_CONTENT);
    if (content) out.push({ role: m.role, content });
  }

  return pruneOrphanToolMessages(out);
}

/**
 * Scrub a tool result at the larger cap, marking it when the cap actually bit.
 *
 * A silent slice through JSON is invisible to the model, which then reads a
 * malformed document as though it were the whole answer. The marker is something
 * it can act on: the prompt already tells it what to do with incomplete evidence.
 *
 * @param {unknown} value
 * @returns {string}
 */
function scrubToolContent(value) {
  const text = scrub(value, MAX_TOOL_CONTENT);
  return text.length < MAX_TOOL_CONTENT ? text : text + TRUNCATION_MARKER;
}

/**
 * Drop `tool` messages whose requesting assistant turn is not in the transcript.
 *
 * Two things orphan one: the `slice(-MAX_MESSAGES)` above can cut between an
 * assistant turn and its replies, and the filter above can drop an assistant turn
 * whose calls were all unknown. Either way the API 400s on the dangling reply, and
 * the operator sees a generic failure for what is really our own bookkeeping.
 *
 * @param {Array<object>} messages
 * @returns {Array<object>}
 */
function pruneOrphanToolMessages(messages) {
  const requested = new Set();
  const kept = [];

  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const c of m.tool_calls) requested.add(c.id);
    }
    if (m.role === 'tool' && !requested.has(m.tool_call_id)) continue;
    kept.push(m);
  }

  return kept;
}

/**
 * Build one request body.
 *
 * Factored out because the retry has to send the same thing with a different
 * budget: a retry that differed in any other way would not be a retry.
 *
 * @param {Array<object>} clean - Sanitized transcript.
 * @param {{maxTokens: number, effort: string|null}} budget
 * @returns {object} The body for `chat.completions.create`.
 */
function buildRequest(clean, { maxTokens, effort }) {
  return {
    // Server-side constant, never a literal and never client-supplied. It is
    // deliberately NOT in model-config's ALLOWED_MODELS: that set guards ids
    // that arrive from a browser on the studio routes, and nothing here reads
    // one, so adding it would widen that guard for no reason.
    model: ANALYST_MODEL,
    messages: [{ role: 'system', content: systemPrompt() }, ...clean],
    tools: toolsForModel(),
    tool_choice: 'auto',
    max_completion_tokens: maxTokens,
    // Omitted entirely, not sent as undefined, when ADMIN_ANALYST_MODEL points at
    // a model that has no such parameter.
    ...(effort ? { reasoning_effort: effort } : {}),
  };
}

/**
 * Read one completion into either a result or a reason to try again.
 *
 * @param {any} completion
 * @returns {{result: object|null, finishReason: string|null}} `result` is null
 *   when the turn produced neither an answer nor a usable tool call.
 */
function readChoice(completion) {
  const choice = (completion && completion.choices && completion.choices[0]) || null;
  const finishReason = (choice && choice.finish_reason) || null;
  const msg = (choice && choice.message) || null;
  if (!msg) return { result: null, finishReason };

  const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls.slice(0, MAX_TOOL_CALLS) : [];
  if (calls.length) {
    // Unknown names are dropped rather than forwarded: the browser would answer
    // "no such tool" and burn a whole round-trip saying so.
    const known = calls.filter((c) => c && c.function && ANALYST_TOOL_NAMES.includes(c.function.name));
    if (known.length) {
      return {
        finishReason,
        result: {
          message: msg.content ? String(msg.content) : null,
          toolCalls: known.map((c) => ({
            id: c.id,
            name: c.function.name,
            arguments: String(c.function.arguments || '{}'),
          })),
          model: ANALYST_MODEL,
        },
      };
    }
  }

  const text = String((msg.content) || '').trim();
  // An empty completion is a failure, not an answer. Returning '' would render
  // a blank bubble that reads as "nothing to say".
  if (!text) return { result: null, finishReason };
  return { result: { message: text, model: ANALYST_MODEL }, finishReason };
}

/**
 * Record why a turn came back with nothing in it.
 *
 * Codes and counts only. The premise of this whole module is that the transcript
 * is hostile and belongs to the operator; a log file is the second place it must
 * not end up.
 *
 * @param {any} completion
 * @param {string|null} finishReason
 * @param {{maxTokens: number, effort: string|null}} budget
 */
function logEmptyTurn(completion, finishReason, budget) {
  logger.warn('[admin] analyst turn empty:', { finishReason, model: ANALYST_MODEL });
  if (!logger.debugEnabled) return;
  const usage = (completion && completion.usage) || {};
  const details = usage.completion_tokens_details || {};
  logger.debug('[admin] analyst usage:', {
    finishReason,
    promptTokens: usage.prompt_tokens ?? null,
    completionTokens: usage.completion_tokens ?? null,
    reasoningTokens: details.reasoning_tokens ?? null,
    maxCompletionTokens: budget.maxTokens,
    reasoningEffort: budget.effort,
  });
}

/**
 * Build the analyst.
 *
 * @param {{ openai: { chat: { completions: { create: Function } } } | null }} deps
 *   The shared OpenAI client from lib/services/ai-clients.js. Null when `GPT_KEY`
 *   is unset, which is a supported state rather than an error.
 */
export function createAdminAnalyst({ openai }) {
  /**
   * Run one turn.
   *
   * Never throws and never rejects. Returns either a finished `message`, or the
   * `toolCalls` the browser must execute and send back — never both meaningfully
   * populated, because that is how the model's own protocol works.
   *
   * @param {{messages: any[]}} req
   * @returns {Promise<{message: string|null, toolCalls?: any[], reason?: string, model?: string}>}
   */
  async function ask({ messages }) {
    const clean = sanitizeMessages(messages);
    if (!clean.length) return { message: null, reason: 'no-messages' };
    if (!openai) return { message: null, reason: 'unavailable' };

    try {
      const budget = { maxTokens: ANALYST_MAX_OUTPUT_TOKENS, effort: ANALYST_REASONING_EFFORT };
      const completion = await openai.chat.completions.create(buildRequest(clean, budget));
      const { result, finishReason } = readChoice(completion);
      if (result) return result;

      logEmptyTurn(completion, finishReason, budget);

      // `length` with nothing to show for it means the budget ran out before the
      // model said anything — a config problem, not a question it could not
      // answer. Retry once, wider and shallower, rather than making the operator
      // resend the request that just failed.
      if (finishReason !== 'length') return { message: null, reason: 'empty' };

      const wider = {
        maxTokens: Math.min(ANALYST_MAX_OUTPUT_TOKENS * 2, MAX_RETRY_TOKENS),
        effort: budget.effort ? 'minimal' : null,
      };
      logger.debug('[admin] analyst retrying after truncation:', wider);
      const second = await openai.chat.completions.create(buildRequest(clean, wider));
      const retry = readChoice(second);
      if (retry.result) return retry.result;

      logEmptyTurn(second, retry.finishReason, wider);
      // Still nothing at double the budget: say which failure this is, so the
      // drawer can tell the operator to narrow the question instead of repeating it.
      return { message: null, reason: retry.finishReason === 'length' ? 'truncated' : 'empty' };
    } catch (error) {
      // Logged, not surfaced: the operator gets a reason code and the message —
      // which can carry request details — stays server-side.
      logger.warn('[admin] analyst turn failed:', error && error.message);
      return { message: null, reason: 'error' };
    }
  }

  return { ask };
}
