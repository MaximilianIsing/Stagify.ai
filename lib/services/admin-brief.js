// The written brief at the top of the admin console's Signals tab.
//
// WHAT THIS IS, AND — MORE IMPORTANTLY — WHAT IT IS NOT.
//
// The Signals tab's findings are produced by a deterministic rules engine in the
// browser (public/scripts/admin/findings*.js). Those findings ARE the product:
// they are unit-tested, they carry their own sample sizes and confidence, and
// they render identically on every refresh with no key and no network.
//
// This module writes two to four sentences of connective prose ON TOP of them.
// It is a presentation layer over numbers that have already been computed and
// already been checked. That framing decides every design choice below:
//
//   1. **The model never sees data, only conclusions.** The request body is the
//      finished findings — title, severity, area, and numeric evidence pairs.
//      No CSV rows, no user records, no prompts.
//   2. **It is told to restate, not to compute.** A model asked to "analyse the
//      numbers" will produce a percentage that appears nowhere on the page, and
//      an operator has no way to tell that one from the twenty real ones beside
//      it. So the instruction is explicit and the temperature is 0.
//   3. **It fails open.** No key, a timeout, a refusal, an empty completion —
//      all of them return `{ summary: null }` and the tab renders its findings
//      exactly as if this file did not exist. This function never throws; the
//      same posture lib/chat/chat-request-prep.js takes with `routingError`.
//
// The redaction in `sanitizeFindings` is defence in depth, not the primary
// control: the client is supposed to send counts rather than names (the at-risk
// accounts rule keeps its list in the browser). But "supposed to" is not a
// guarantee that survives a future edit to a file in public/, and this is the
// one path in the admin console that sends anything to a third party.

import { FAST_MODEL } from '../config/model-config.js';
import { logger } from '../logger.js';

/** Hard caps on what may reach the model, so a malformed client cannot inflate a call. */
const MAX_FINDINGS = 40;
const MAX_TEXT = 240;
const MAX_EVIDENCE = 6;
const MAX_OUTPUT_TOKENS = 350;

/** Anything shaped like an email address, replaced wholesale. */
const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
/** IPv4 and the common IPv6 forms. Coarse on purpose — a false positive costs nothing here. */
const IPV4_RE = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g;
const IPV6_RE = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi;

/**
 * Strip anything that identifies a person from one string, and clamp it.
 *
 * Order matters: emails are removed before IPs, because an IPv6 pattern can
 * match inside a domain-ish string and would otherwise chew a hole in an address
 * that the email rule was about to remove whole.
 *
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function scrub(value, max = MAX_TEXT) {
  return String(value == null ? '' : value)
    .replace(EMAIL_RE, '[account]')
    .replace(IPV6_RE, '[ip]')
    .replace(IPV4_RE, '[ip]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Project the client's findings down to the fixed, scrubbed shape the prompt is
 * built from.
 *
 * Everything not named here is dropped rather than passed through — the same
 * allowlist posture as lib/data/auth-redaction.js, and for the same reason: a
 * field a future rule parks on a finding must not reach a third party just
 * because nobody remembered to exclude it.
 *
 * @param {any[]} findings
 * @returns {Array<{title: string, severity: string, area: string, evidence: string[]}>}
 */
export function sanitizeFindings(findings) {
  return (Array.isArray(findings) ? findings : [])
    .slice(0, MAX_FINDINGS)
    .filter((f) => f && typeof f === 'object')
    .map((f) => ({
      title: scrub(f.title),
      severity: scrub(f.severity, 24),
      area: scrub(f.area, 40),
      evidence: (Array.isArray(f.evidence) ? f.evidence : [])
        .slice(0, MAX_EVIDENCE)
        .map((e) => (e && typeof e === 'object'
          ? scrub(`${e.label}: ${e.value}`, 120)
          : scrub(e, 120)))
        .filter(Boolean),
    }))
    .filter((f) => f.title);
}

const SYSTEM_PROMPT = [
  'You write a short operations brief for the person who runs a virtual-staging web app.',
  'You are given findings that have ALREADY been computed and verified by a deterministic rules engine.',
  '',
  'Rules, all of them absolute:',
  '- Use ONLY numbers that appear in the input. Never compute, derive, estimate or round a new one.',
  '- Never invent a finding, a cause, or a recommendation that is not implied by the input.',
  '- Do not speculate about why something happened unless the input says why.',
  '- If the input is thin, say so plainly in one sentence. Do not pad.',
  '',
  'Write 2 to 4 sentences of plain prose. No headings, no bullet points, no markdown, no preamble.',
  'Lead with whatever matters most. Say what it means for the business, not what the metric is called.',
].join('\n');

/**
 * Build the user message. Kept separate from the call so the suite can assert on
 * exactly what would be sent without stubbing a network client.
 * @param {ReturnType<typeof sanitizeFindings>} clean
 * @returns {string}
 */
export function buildPrompt(clean) {
  const lines = clean.map((f) => {
    const evidence = f.evidence.length ? ` (${f.evidence.join('; ')})` : '';
    return `- [${f.severity || 'unknown'}] ${f.area ? f.area + ': ' : ''}${f.title}${evidence}`;
  });
  return `Findings, most severe first:\n${lines.join('\n')}`;
}

/**
 * Build the brief generator.
 *
 * @param {{ openai: { chat: { completions: { create: Function } } } | null }} deps
 *   The shared OpenAI client from lib/services/ai-clients.js. Null when `GPT_KEY`
 *   is unset, which is a supported state, not an error.
 */
export function createAdminBrief({ openai }) {
  /**
   * Write the brief, or explain why there isn't one.
   *
   * Never throws and never rejects. `reason` is for the operator, so the tab can
   * say "no key configured" rather than showing an empty box that looks broken.
   *
   * @param {any[]} findings The finished findings from the browser's rules engine.
   * @returns {Promise<{summary: string|null, reason?: string, model?: string}>}
   */
  async function generateBrief(findings) {
    const clean = sanitizeFindings(findings);
    if (!clean.length) return { summary: null, reason: 'no-findings' };
    if (!openai) return { summary: null, reason: 'unavailable' };

    try {
      const completion = await openai.chat.completions.create({
        // FAST_MODEL via the config module, never a literal and never anything
        // client-supplied — the allow-list rule in lib/config/model-config.js.
        model: FAST_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildPrompt(clean) },
        ],
        temperature: 0,
        max_tokens: MAX_OUTPUT_TOKENS,
      });

      const text = String(
        (completion && completion.choices && completion.choices[0]
          && completion.choices[0].message && completion.choices[0].message.content) || '',
      ).trim();

      // An empty completion is a failure, not a brief. Returning '' would render
      // an empty panel that reads as "nothing to report".
      if (!text) return { summary: null, reason: 'empty' };
      return { summary: text, model: FAST_MODEL };
    } catch (error) {
      // Logged, not surfaced: the operator gets a reason code, and the message
      // (which can carry request details) stays server-side.
      logger.warn('[admin] brief generation failed:', error && error.message);
      return { summary: null, reason: 'error' };
    }
  }

  return { generateBrief };
}
