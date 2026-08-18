// Tier: service unit (stubbed model client) — lib/services/admin-brief.js.
//
// WHY THIS EXISTS. This is the ONLY path in the admin console that sends anything
// to a third party, and the console's whole job is displaying user data: emails,
// IP addresses, prompts, bug reports. So the assertion that carries this file is
// not "the prompt reads well" but **nothing identifying a person can leave the
// box**, enforced twice over:
//
//   - an ALLOWLIST projection (only title/severity/area/evidence survive), so a
//     field a future rule parks on a finding cannot ride along by default, and
//   - a scrub of what does survive, so a rule that puts an address INSIDE a title
//     still cannot leak it.
//
// The second is deliberate belt-and-braces. The client is supposed to send counts
// rather than names — findings-accounts.js keeps its at-risk list in the browser —
// but "supposed to" is a convention in a different file, and conventions are what
// a future edit breaks silently.
//
// The other theme is the fail-open contract. `generateBrief` must never throw and
// never reject: the Signals tab's findings are computed client-side and have to
// render whether or not a model answered, so every failure mode below resolves to
// `{ summary: null }` with a reason the operator can read.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAdminBrief, sanitizeFindings, scrub, buildPrompt } from '../../lib/services/admin-brief.js';

/** A stub OpenAI client that records what it was asked and answers with `reply`. */
function fakeOpenAI(reply, { throws } = {}) {
  const calls = [];
  return {
    calls,
    chat: {
      completions: {
        create: async (args) => {
          calls.push(args);
          if (throws) throw new Error(throws);
          return { choices: [{ message: { content: reply } }] };
        },
      },
    },
  };
}

/** Everything the client would actually send, as one string. */
function outboundText(client) {
  return JSON.stringify(client.calls);
}

// ── The redaction boundary ──────────────────────────────────────────────────

test('scrub removes emails and IP addresses', () => {
  assert.equal(scrub('contact dana@example.com about it'), 'contact [account] about it');
  assert.equal(scrub('from 203.0.113.42 repeatedly'), 'from [ip] repeatedly');
  assert.equal(scrub('via 2001:0db8:85a3:0000:0000:8a2e:0370:7334'), 'via [ip]');
});

test('scrub strips the email BEFORE the IPv6 pattern can chew a hole in it', () => {
  // Order dependence worth pinning: an IPv6-shaped run can match inside an
  // address-like string. Scrubbing IPs first would leave a half-eaten address
  // behind, which is worse than either rule alone — it still identifies someone
  // and no longer looks like something that needed removing.
  const out = scrub('a:b:c:d:e:f@example.com filed it');
  assert.ok(!out.includes('example.com'), `an address survived: ${out}`);
  assert.ok(!out.includes('a:b:c:d:e:f'), `a fragment survived: ${out}`);
});

test('sanitizeFindings drops every field it was not told to keep', () => {
  // The allowlist posture, same as lib/data/auth-redaction.js. A rule that parks
  // a debugging payload on a finding must not have it forwarded by default.
  const [clean] = sanitizeFindings([{
    title: 'Kitchen renders fail more often',
    severity: 'critical',
    area: 'Reliability',
    evidence: [{ label: 'sample', value: 210 }],
    // None of these may survive.
    accounts: ['dana@example.com', 'marcus@example.com'],
    rawRows: [['2026-08-01', 'kitchen', 'dana@example.com']],
    action: 'Check ROOM_TYPE_CONSTRAINTS',
    id: 'reliability.segment',
  }]);

  assert.deepEqual(Object.keys(clean).sort(), ['area', 'evidence', 'severity', 'title']);
  assert.ok(!JSON.stringify(clean).includes('@'), 'no address may survive the projection');
});

test('an address hidden inside a title is scrubbed, not forwarded', () => {
  const [clean] = sanitizeFindings([{ title: 'dana@example.com has not rendered in 34 days', severity: 'warning' }]);
  assert.equal(clean.title, '[account] has not rendered in 34 days');
});

test('nothing resembling a person reaches the model, end to end', async () => {
  // The assertion this whole file exists for, made against the REAL outbound
  // payload rather than an intermediate shape.
  const client = fakeOpenAI('Two things need attention.');
  const brief = createAdminBrief({ openai: client });

  await brief.generateBrief([
    {
      title: 'dana@example.com is paying and has not rendered in 34 days',
      severity: 'warning',
      area: 'Revenue',
      evidence: [{ label: 'account', value: 'marcus@example.com' }, { label: 'from', value: '203.0.113.42' }],
      accounts: [{ email: 'priya@example.com', id: 'u_9' }],
    },
  ]);

  const sent = outboundText(client);
  assert.ok(!sent.includes('@example.com'), `an address reached the model: ${sent}`);
  assert.ok(!sent.includes('203.0.113.42'), 'an IP reached the model');
  assert.ok(!sent.includes('u_9'), 'an account id reached the model');
  assert.ok(sent.includes('34 days'), 'the finding itself must still survive the scrub');
});

test('the payload is capped so a malformed client cannot inflate a call', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({ title: `finding ${i}`, severity: 'warning' }));
  assert.equal(sanitizeFindings(many).length, 40);

  const [long] = sanitizeFindings([{ title: 'x'.repeat(5000), severity: 'warning' }]);
  assert.ok(long.title.length <= 240, `title was not clamped: ${long.title.length}`);

  const [wide] = sanitizeFindings([{
    title: 'ok', evidence: Array.from({ length: 50 }, (_, i) => ({ label: 'l', value: i })),
  }]);
  assert.ok(wide.evidence.length <= 6, `evidence was not clamped: ${wide.evidence.length}`);
});

test('sanitizeFindings tolerates junk instead of throwing', () => {
  // The body arrives from a browser; it is validated as an array by the route and
  // nothing more. A null entry must not take the whole brief down.
  assert.deepEqual(sanitizeFindings(null), []);
  assert.deepEqual(sanitizeFindings('nope'), []);
  assert.deepEqual(sanitizeFindings([null, undefined, 42, { noTitle: true }]), []);
});

// ── The prompt ──────────────────────────────────────────────────────────────

test('the prompt instructs the model to restate rather than compute', async () => {
  // The failure mode this guards is the dangerous one: a model asked to "analyse"
  // returns a percentage that appears nowhere on the page, and an operator cannot
  // tell it from the twenty real numbers beside it.
  const client = fakeOpenAI('fine');
  await createAdminBrief({ openai: client }).generateBrief([{ title: 'a', severity: 'warning' }]);

  const [args] = client.calls;
  const system = args.messages.find((m) => m.role === 'system').content;
  assert.match(system, /ONLY numbers that appear in the input/i);
  assert.match(system, /Never (compute|invent)/i);
  assert.equal(args.temperature, 0, 'a written brief over fixed numbers must be deterministic');
  assert.ok(args.max_tokens > 0 && args.max_tokens <= 400, 'the completion must be bounded');
});

test('the model id comes from the config allow-list, never a literal or the client', async () => {
  const client = fakeOpenAI('fine');
  await createAdminBrief({ openai: client }).generateBrief([{ title: 'a', model: 'gpt-4-turbo-please' }]);
  assert.equal(client.calls[0].model, 'gpt-4o-mini');
});

test('buildPrompt lays out severity, area and evidence for each finding', () => {
  const text = buildPrompt(sanitizeFindings([
    { title: 'Kitchens failing', severity: 'critical', area: 'Reliability', evidence: [{ label: 'n', value: 210 }] },
  ]));
  assert.match(text, /\[critical\]/);
  assert.match(text, /Reliability: Kitchens failing/);
  assert.match(text, /n: 210/);
});

// ── Fail-open ───────────────────────────────────────────────────────────────

test('no client configured resolves to a null summary with a reason', async () => {
  const out = await createAdminBrief({ openai: null }).generateBrief([{ title: 'a' }]);
  assert.deepEqual(out, { summary: null, reason: 'unavailable' });
});

test('no findings is its own reason, checked before the client', async () => {
  // Ordering matters for cost: an empty list must not bill a model call just
  // because a key happens to be configured.
  const client = fakeOpenAI('should not run');
  const out = await createAdminBrief({ openai: client }).generateBrief([]);
  assert.deepEqual(out, { summary: null, reason: 'no-findings' });
  assert.equal(client.calls.length, 0);
});

test('a thrown model error resolves rather than rejecting', async () => {
  const client = fakeOpenAI(null, { throws: 'connect ECONNREFUSED' });
  const out = await createAdminBrief({ openai: client }).generateBrief([{ title: 'a' }]);
  assert.deepEqual(out, { summary: null, reason: 'error' });
});

test('the underlying error message is not handed back to the caller', async () => {
  // It can carry request details; the operator gets a reason code and the message
  // stays in the server log.
  const client = fakeOpenAI(null, { throws: 'Incorrect API key sk-proj-abc123' });
  const out = await createAdminBrief({ openai: client }).generateBrief([{ title: 'a' }]);
  assert.ok(!JSON.stringify(out).includes('sk-proj'), 'a key fragment reached the response');
});

test('an empty completion is a failure, not a brief', async () => {
  // Returning '' would render an empty panel that reads as "nothing to report",
  // which is a claim, not an absence.
  for (const reply of ['', '   ', null]) {
    const out = await createAdminBrief({ openai: fakeOpenAI(reply) }).generateBrief([{ title: 'a' }]);
    assert.deepEqual(out, { summary: null, reason: 'empty' }, `reply ${JSON.stringify(reply)}`);
  }
});

test('a successful brief carries the text and the model that wrote it', async () => {
  const out = await createAdminBrief({ openai: fakeOpenAI('  Volume is up.  ') }).generateBrief([{ title: 'a' }]);
  assert.equal(out.summary, 'Volume is up.');
  assert.equal(out.model, 'gpt-4o-mini');
});
