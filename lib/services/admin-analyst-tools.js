// The tool catalogue the admin analyst is offered: names, descriptions and JSON
// Schema. Declarations only — there is not a line of execution in this file.
//
// WHY THE SCHEMAS LIVE ON THE SERVER AND THE EXECUTORS LIVE IN THE BROWSER
//
// The console has no backend by design: it downloads the CSV/JSON exports and
// aggregates in the browser, and `public/scripts/admin/analytics*.js` are already
// the tested, single source of truth for every number the dashboard shows. Running
// the analyst's queries server-side would mean a SECOND implementation of that
// arithmetic, and the failure mode of two implementations is not an error — it is
// a chat that quietly disagrees with the chart directly above it.
//
// So the executors stay in the browser, beside the aggregators they call
// (public/scripts/admin/analyst-tools.js). What stays here is the half that must
// not be client-supplied: if the browser posted the tool definitions along with
// the messages, anyone who could reach the endpoint could rewrite the model's
// instructions by rewriting a description. The names and schemas are fixed here;
// the browser may only answer calls that this file made possible.
//
// The two halves are pinned against each other by
// test/frontend/admin/admin-analyst-tools.test.js, which asserts the name sets are
// identical. That test is the only thing standing between a renamed tool and a
// model that calls into a void, because nothing fails at runtime — the model just
// gets an error string back and apologises.
//
// EVERY TOOL RETURNS AGGREGATES. No tool returns an email address, an IP, a prompt
// or a chat message. Where a specific account is the answer, the executor emits an
// opaque `acct_xxxxxx` handle and the browser resolves it back to a real address
// only when painting the DOM. See public/scripts/admin/analyst-identity.js.

/** Windows any tool may be asked for, in days. Keeps the model from inventing one. */
const WINDOW_DAYS = { type: 'integer', minimum: 1, maximum: 365, description: 'Window size in days.' };

/** The prompt_logs.csv dimensions a segment may be cut by. Matches COL.PROMPT in analytics.js. */
const SEGMENT_FIELDS = ['roomType', 'furnitureStyle', 'model', 'errorCode', 'removeFurniture'];

/** The countable event streams the console holds. */
const METRICS = ['renders', 'failures', 'signups', 'chats', 'maskEdits', 'rejections'];

/**
 * The catalogue.
 *
 * Descriptions are written for the model, not for a person reading this file:
 * each one says what the tool answers and — where it matters — what it CANNOT
 * answer, because a tool whose limits are undocumented is a tool the model will
 * use to guess.
 *
 * @type {Array<{name: string, description: string, parameters: object}>}
 */
export const ANALYST_TOOLS = [
  {
    name: 'segment_breakdown',
    description:
      'Break renders down by one dimension (room type, style, model, error code) and return per-segment '
      + 'volume, failure count, failure rate and a 95% Wilson interval on that rate. Use this for any '
      + '"which X is worst / most common" question. The interval is what tells you whether a difference '
      + 'is real; a segment with very few failures has a wide one and should not be called out.',
    parameters: {
      type: 'object',
      properties: {
        field: { type: 'string', enum: SEGMENT_FIELDS, description: 'The dimension to group by.' },
        days: WINDOW_DAYS,
        limit: { type: 'integer', minimum: 1, maximum: 25, description: 'How many segments to return, busiest first.' },
      },
      required: ['field'],
    },
  },
  {
    name: 'time_series',
    description:
      'A daily (or auto-bucketed weekly/monthly) count of one metric over a window. Use it to see shape '
      + 'and timing — when something changed, not why. Buckets are zero-filled, so a quiet day is a 0 '
      + 'rather than a gap.',
    parameters: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: METRICS },
        days: WINDOW_DAYS,
      },
      required: ['metric'],
    },
  },
  {
    name: 'compare_windows',
    description:
      'Compare one metric between two adjacent windows — the last N days against the N days before them — '
      + 'returning both totals, the fold change and a least-squares trend over the recent window. Use this '
      + 'for "is it up or down", and prefer it over eyeballing a series.',
    parameters: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: METRICS },
        days: WINDOW_DAYS,
      },
      required: ['metric'],
    },
  },
  {
    name: 'render_outcomes',
    description:
      'Overall render health: total recorded outcomes, successes, failures, the success rate, duration '
      + 'percentiles (p50/p90/p95) and retry counts. Renders logged before outcome recording began are '
      + 'excluded rather than counted as successes, and the payload says how many that was.',
    parameters: { type: 'object', properties: { days: WINDOW_DAYS } },
  },
  {
    name: 'rejection_breakdown',
    description:
      'Requests refused BEFORE a render ran — unstageable photos, daily caps, rate limits, oversized '
      + 'files. These are deliberately not rows in the render log, so they are invisible to every other '
      + 'tool here; a drop in renders with a rise in refusals is a completely different story from a '
      + 'drop in demand.',
    parameters: {
      type: 'object',
      properties: {
        days: WINDOW_DAYS,
        kind: {
          type: 'string',
          enum: ['unstageable', 'daily_limit', 'rate_limit', 'api_concurrency', 'file_too_large'],
          description: 'Optional: drill into one refusal kind and return its top reason codes.',
        },
      },
    },
  },
  {
    name: 'funnel_and_retention',
    description:
      'The activation funnel (accounts to activated to repeat to power users), monthly cohort retention, '
      + 'paid conversion and median activation lag. Read the `caveats` field before quoting any of it: '
      + 'much of this is attributed through the render log and is a floor rather than a count.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'account_lookup',
    description:
      'Individual accounts, filtered and sorted — who is paying, who has gone quiet, who is hitting the '
      + 'daily cap, who signed up recently. Accounts are identified by an opaque handle such as '
      + 'acct_4f1a2b. That handle is all you get and all you need: refer to it directly in your answer '
      + 'and the console will show the operator the real address.',
    parameters: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['paying', 'at_risk', 'never_activated', 'comp_granted', 'recent_signups', 'top_users'],
        },
        days: WINDOW_DAYS,
        limit: { type: 'integer', minimum: 1, maximum: 25 },
      },
      required: ['filter'],
    },
  },
  {
    name: 'metrics_snapshot',
    description:
      'Server-side SQL aggregates that no CSV can produce: render counts attributed through the VALIDATED '
      + 'session (not the request body, so these are counts rather than floors), storage bytes, gallery '
      + 'share views, stuck Stripe events and the blob-reaper backlog. Use it whenever attribution '
      + 'accuracy matters, and say so when you do.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'list_findings',
    description:
      'What the deterministic rules engine concluded on this data load, including the checks it declined '
      + 'to run for want of data. These are already computed and already checked — prefer citing one over '
      + 'rederiving it, and if you disagree with one, say so and show the numbers.',
    parameters: { type: 'object', properties: {} },
  },
];

/** Tool names, for the drift test and for validating what the model asked for. */
export const ANALYST_TOOL_NAMES = ANALYST_TOOLS.map((t) => t.name);

/**
 * The catalogue in the shape the OpenAI chat-completions API wants.
 * Built here rather than stored in this shape so the declarations above stay
 * readable and provider-agnostic.
 * @returns {Array<object>}
 */
export function toolsForModel() {
  return ANALYST_TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}
