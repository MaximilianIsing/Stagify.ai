// Shared JSDoc/TS shapes for the admin console (scripts/admin/admin.js and its
// panels under scripts/admin/).
//
// Type-check only — never shipped to the browser. Reference from .js with e.g.
//   /** @param {import('./types.js').AdminUser} u */
// (the `.js` specifier is deliberate: TS resolves it to this .d.ts, and no such
// runtime file exists to import.)
//
// PERMISSIVE by design, same stance as the studios' types.d.ts: these describe the
// fields the console reads, not every field the server sends. The server routes
// under routes/admin/ are the authority.

/**
 * Authenticated mutating request (holds the session token). Resolves with the
 * parsed JSON body — `any`, because each endpoint returns its own payload — and
 * rejects with an Error carrying the server's `code` and the HTTP `status`.
 */
export type ApiSend = (url: string, method: string, body?: any, isForm?: boolean) => Promise<any>;

/**
 * One account as `GET /authstore` serves it: the allowlisted, credential-free
 * projection in lib/data/auth-redaction.js (ADMIN_VISIBLE_USER_KEYS). Every field
 * but `id`/`email` can be absent; the grant/danger panels also patch `plan` and
 * the grant fields in place after a successful action.
 */
export interface AdminUser {
  id: string;
  email: string;
  plan?: string;
  createdAt?: string | null;
  usageDay?: string;
  usageCount?: number;
  googleSub?: string | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  proPassGrantedAt?: string | null;
  proGrantedAt?: string | null;
  proGrantExpiresAt?: string | null;
  lifetimeStaged?: number;
  lastStagedAt?: string | null;
  trialLifecycle?: { startAt: string | null; sent: Record<string, string | null> };
}

/** One enterprise domain, as `GET /enterprise-domains` serves it (rowToEntry in lib/data/enterprise-store.js). */
export interface AdminEnterpriseDomain {
  domain: string;
  companyName?: string;
  contactEmail?: string;
  contactPhone?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  status?: string | null;
  usageCount?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/** One hosted image (lib/types/image.d.ts HostedImageEntry, with the served `path`). */
export interface AdminHostedImage {
  id: string;
  file?: string;
  mime?: string;
  originalName?: string;
  size?: number;
  uploadedAt?: string;
  path?: string;
}

/**
 * The console's loaded feeds. CSV feeds are parsed rows (header included; strip
 * with analytics.js `stripHeader`); the JSON feeds are the server's payloads.
 * `metrics` is the in-process snapshot from `GET /api/admin/metrics`, read
 * untyped by the rules engine.
 */
export interface AdminData {
  users: AdminUser[];
  promptRows: string[][];
  chatRows: string[][];
  bugRows: string[][];
  maskRows: string[][];
  contactRows: string[][];
  emailOpenRows: string[][];
  rejectionRows: string[][];
  enterprise: AdminEnterpriseDomain[];
  hostedImages: AdminHostedImage[];
  metrics: Record<string, any> | null;
}

/** Shared, mutable app state handed to every island by reference. */
export interface AdminCtx {
  data: AdminData;
  userFilter: string;
  userSortCol: string;
  userSortDir: string;
}

/** Effective-plan resolver (folds in enterprise domains): 'pro' | 'enterprise' | the stored plan | 'free'. */
export type EffectivePlan = (u: AdminUser | null | undefined) => string;

/** One uptime window in the status snapshot (`windows['24h']` etc.). */
export interface AdminStatusWindow {
  uptimePct?: number | null;
  /** Fraction of the window that was actually monitored, 0..1. */
  coverage?: number;
  downMs?: number;
  incidents?: number;
}

/** One bar of an uptime strip. */
export interface AdminStatusBucket {
  start: number;
  state: string;
  uptimePct: number | null;
  downMs?: number;
}

/** One subsystem check (lib/health/service-health.js), with the admin-only detail. */
export interface AdminStatusComponent {
  id: string;
  state?: string;
  reasonCode?: string;
  detail?: string;
  latencyMs?: number | null;
  core?: boolean;
}

/**
 * One row of the merged incident feed (mergeFeeds in lib/data/uptime-monitor.js).
 * Heartbeat-detected rows are always closed; a hand-posted one is ongoing exactly
 * while its `end` is null, and only it carries an `id` (the resolve/delete key).
 */
export type AdminIncident = AdminIncidentBase & (
  | { source: 'auto'; end: number; ongoing: false }
  | { source: 'manual'; id: string; end: number; ongoing: false }
  | { source: 'manual'; id: string; end: null; ongoing: true }
);

interface AdminIncidentBase {
  start: number;
  durationMs: number;
  cause?: string;
  affectsUptime: boolean;
}

/** `GET /api/admin/status`: the monitor's admin snapshot plus the component section. */
export interface AdminStatusSnapshot {
  currentState?: string;
  lastBeat?: number | null;
  lastCheckedMsAgo?: number | null;
  monitoringSince?: number | null;
  bootCount?: number;
  intervalMs?: number;
  totalIncidents?: number;
  config?: { intervalMs?: number; gapThresholdMs?: number; retentionDays?: number };
  windows?: Record<string, AdminStatusWindow>;
  buckets?: Record<string, AdminStatusBucket[]>;
  incidents?: AdminIncident[];
  components?: AdminStatusComponent[];
  componentsSummary?: { worst?: string };
  componentsCheckedAt?: number | null;
  componentsStale?: boolean;
  overall?: string;
}

/** The per-account activity lookups built by analytics-users.js `buildActivityIndex`. */
export type ActivityIndex = ReturnType<typeof import('./analytics-users.js').buildActivityIndex>;

/**
 * The bag every Signals rule's `run` receives (findings.js `runFindings`, after
 * its defaults are applied): header-stripped tables plus the account list.
 * `metrics` is null when GET /api/admin/metrics is unavailable, and
 * `rejectionRows` may be empty on a fresh install; rules must cope with both.
 */
export interface RuleInput {
  now: number;
  promptRows: string[][];
  users: AdminUser[];
  enterprise: AdminEnterpriseDomain[];
  metrics: Record<string, any> | null;
  contactRows?: string[][];
  rejectionRows?: string[][];
  index?: ActivityIndex;
  effectivePlan?: EffectivePlan;
}

/** One tool call the analyst endpoint asks the browser to run (lib/services/admin-analyst.js). */
export interface AnalystToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** `POST /api/admin/analyst`: a prose answer, or tool calls to run and send back. */
export interface AnalystResponse {
  message: string | null;
  toolCalls?: AnalystToolCall[];
  reason?: string;
}

/** One message of the transcript posted back to the server, in the Chat Completions wire shape. */
export interface AnalystMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
}

/** One rendered turn in the drawer. */
export type AnalystTurn =
  | { role: 'user'; text: string }
  | { role: 'answer'; text: string; tools: string[] };

/** The analyst drawer's conversation, kept on `ctx.analyst` and dropped on sign-out. */
export interface AnalystState {
  open: boolean;
  busy: boolean;
  busyNote?: string;
  turns: AnalystTurn[];
  messages: AnalystMessage[];
  error: string | null;
  /** Bumped per question; a stale await compares against it to know it was abandoned. */
  run: number;
  lastQuestion: string;
}

/** One campaign link with its numbers, as `GET /api/admin/referrals` serves it (statsFor in lib/data/referral-links.js). */
export interface ReferralLinkStats {
  slug: string;
  path: string;
  label: string;
  note: string;
  active: boolean;
  createdAt: number;
  deactivatedAt: number | null;
  clicks: number;
  botHits: number;
  windowClicks: number;
  windowDays: number;
  last7: number;
  firstClickAt: number | null;
  lastClickAt: number | null;
  series: Array<{ date: string; value: number }>;
  referrers: Array<{ source: string; value: number }>;
}

/** Resolved location for an IP; null until the geo pass has looked it up. */
export type AccessGeo = { city: string; region: string; country: string; countryCode: string } | null;

/** One row of the access feed (summary() in lib/data/admin-access.js). A collapsed burst has `hits` > 1. */
export interface AccessEvent {
  id: number;
  ts: number;
  lastTs: number;
  hits: number;
  ip: string;
  outcome: string;
  reason: string;
  path: string;
  ua: string;
  browser: string;
  os: string;
  isBot: boolean;
  geo: AccessGeo;
}

/** One IP rolled up across its events. */
export interface AccessVisitor {
  ip: string;
  geo: AccessGeo;
  events: number;
  opens: number;
  signins: number;
  denied: number;
  isBot: boolean;
  firstSeen: number;
  lastSeen: number;
  devices: Array<{ browser: string; os: string; hits: number; lastSeen: number }>;
}

/** `GET /api/admin/access-log`. `configured: false` means recording is switched off. */
export interface AccessLog {
  configured?: boolean;
  rows: AccessEvent[];
  summary: {
    opens: number;
    signins: number;
    denied: number;
    distinctIps: number;
    deniedIps: number;
    visitors: AccessVisitor[];
  };
}

/** One article with its reads, as the Blog tab's stats endpoint serves it (BlogPostViews in lib/data/blog-views.js). */
export interface BlogPostStats {
  slug: string;
  title: string;
  path: string;
  publishedAt: string | null;
  retired: boolean;
  views: number;
  botHits: number;
  windowViews: number;
  windowDays: number;
  last7: number;
  firstViewAt: number | null;
  lastViewAt: number | null;
  series: Array<{ date: string; value: number }>;
  referrers: Array<{ source: string; value: number }>;
}

/** The Blog tab's payload: per-article stats plus the blog-wide totals. `configured: false` means views are not being counted. */
export interface BlogStats {
  configured?: boolean;
  days: number;
  totals: {
    posts: number;
    views: number;
    botHits: number;
    windowViews: number;
    unread: number;
    series: Array<{ date: string; value: number }>;
  };
  posts: BlogPostStats[];
}

/** One account row of `GET /api/admin/api-usage` (lib/analytics/api-usage.js). `email` is '' once the account is gone. */
export interface ApiUsageAccount {
  userId: string;
  email: string;
  plan: string;
  delivered: number;
  refunded: number;
  inFlight: number;
  creditsSpent: number;
  delivered7d: number;
  keysUsed: number;
  lastRequestAt: number | null;
}

/** One zero-filled UTC day of API traffic. `day` is the bucket's start, epoch ms. */
export interface ApiUsageBucket {
  day: number;
  delivered: number;
  refunded: number;
}

/** One render in the user-detail strip (shapeAdminRender in routes/admin/renders.js). URLs are '' once evicted. */
export interface AdminRenderEntry {
  id: string;
  createdAt: number;
  status: string;
  evicted: boolean;
  evictedAt: number | null;
  width: number | null;
  height: number | null;
  roomType: string;
  furnitureStyle: string;
  additionalPrompt: string;
  removeFurniture: boolean;
  model: string;
  variation: number;
  batchId: string;
  name: string;
  source: string;
  sourceName: string;
  bytes: number;
  urls: { after: string; before: string; thumb: string };
}
