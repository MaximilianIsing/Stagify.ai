import fs from 'fs';
import path from 'path';
import { resolveDataDir, getDb, closeDb } from './db.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS enterprise_domains (
  domain                      TEXT PRIMARY KEY,
  company_name                TEXT,
  contact_email               TEXT,
  contact_phone               TEXT,
  stripe_customer_id          TEXT,
  stripe_subscription_id      TEXT,
  stripe_subscription_item_id TEXT,
  status                      TEXT,
  usage_count                 INTEGER NOT NULL DEFAULT 0,
  created_at                  TEXT,
  updated_at                  TEXT,
  extra_json                  TEXT
);
CREATE INDEX IF NOT EXISTS idx_ent_customer     ON enterprise_domains(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_ent_subscription ON enterprise_domains(stripe_subscription_id);
`;

const KNOWN_KEYS = new Set([
  'domain', 'companyName', 'contactEmail', 'contactPhone', 'stripeCustomerId',
  'stripeSubscriptionId', 'stripeSubscriptionItemId', 'status', 'usageCount',
  'createdAt', 'updatedAt',
]);

function safeParse(s) {
  try {
    return JSON.parse(s) || {};
  } catch {
    return {};
  }
}

function rowToEntry(row) {
  if (!row) return null;
  const extra = row.extra_json ? safeParse(row.extra_json) : {};
  return {
    ...extra,
    domain: row.domain,
    companyName: row.company_name ?? '',
    contactEmail: row.contact_email ?? '',
    contactPhone: row.contact_phone ?? '',
    stripeCustomerId: row.stripe_customer_id ?? '',
    stripeSubscriptionId: row.stripe_subscription_id ?? '',
    stripeSubscriptionItemId: row.stripe_subscription_item_id ?? '',
    status: row.status,
    usageCount: row.usage_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function entryToParams(e) {
  const extra = {};
  for (const k of Object.keys(e)) {
    if (!KNOWN_KEYS.has(k)) extra[k] = e[k];
  }
  return {
    domain: e.domain,
    company_name: e.companyName ?? null,
    contact_email: e.contactEmail ?? null,
    contact_phone: e.contactPhone ?? null,
    stripe_customer_id: e.stripeCustomerId ?? null,
    stripe_subscription_id: e.stripeSubscriptionId ?? null,
    stripe_subscription_item_id: e.stripeSubscriptionItemId ?? null,
    status: e.status ?? null,
    usage_count: Number.isFinite(e.usageCount) ? e.usageCount : 0,
    created_at: e.createdAt ?? null,
    updated_at: e.updatedAt ?? null,
    extra_json: Object.keys(extra).length ? JSON.stringify(extra) : null,
  };
}

// Legacy JSON reader — used ONCE to import an existing enterprise-domains.json.
// Only ever READS the old file; it stays put as a rollback fallback.
function loadLegacyJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    const data = JSON.parse(raw);
    return { domains: Array.isArray(data.domains) ? data.domains : [] };
  } catch {
    return null;
  }
}

export function createEnterpriseStore(baseDir) {
  const dataDir = resolveDataDir(baseDir);
  const dbPath = path.join(dataDir, 'auth-store.db');
  const legacyJsonPath = path.join(dataDir, 'enterprise-domains.json');
  const db = getDb(baseDir);
  db.exec(SCHEMA);

  const q = {
    byDomain: db.prepare('SELECT * FROM enterprise_domains WHERE domain = ?'),
    byCustomer: db.prepare('SELECT * FROM enterprise_domains WHERE stripe_customer_id = ?'),
    bySubscription: db.prepare('SELECT * FROM enterprise_domains WHERE stripe_subscription_id = ?'),
    all: db.prepare('SELECT * FROM enterprise_domains'),
    count: db.prepare('SELECT COUNT(*) AS n FROM enterprise_domains'),
    upsert: db.prepare(`
      INSERT INTO enterprise_domains
        (domain, company_name, contact_email, contact_phone, stripe_customer_id,
         stripe_subscription_id, stripe_subscription_item_id, status, usage_count,
         created_at, updated_at, extra_json)
      VALUES
        (@domain, @company_name, @contact_email, @contact_phone, @stripe_customer_id,
         @stripe_subscription_id, @stripe_subscription_item_id, @status, @usage_count,
         @created_at, @updated_at, @extra_json)
      ON CONFLICT(domain) DO UPDATE SET
        company_name=excluded.company_name, contact_email=excluded.contact_email,
        contact_phone=excluded.contact_phone, stripe_customer_id=excluded.stripe_customer_id,
        stripe_subscription_id=excluded.stripe_subscription_id,
        stripe_subscription_item_id=excluded.stripe_subscription_item_id,
        status=excluded.status, usage_count=excluded.usage_count,
        created_at=excluded.created_at, updated_at=excluded.updated_at,
        extra_json=excluded.extra_json
    `),
    delAll: db.prepare('DELETE FROM enterprise_domains'),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
  };

  function upsertEntry(entry) {
    q.upsert.run(entryToParams(entry));
  }

  function getDomainEntry(domain) {
    const d = String(domain).trim().toLowerCase();
    return rowToEntry(q.byDomain.get(d));
  }

  function getAllDomains() {
    return q.all.all().map(rowToEntry);
  }

  function exportStore() {
    return { domains: getAllDomains() };
  }

  const importStore = db.transaction((store) => {
    q.delAll.run();
    for (const entry of store.domains || []) {
      if (entry && entry.domain) upsertEntry(entry);
    }
  });

  // One-time import from a legacy enterprise-domains.json (guarded so it never
  // re-runs and clobbers live SQLite data). The JSON is only read, never written.
  (function maybeImportLegacyJson() {
    if (q.getMeta.get('enterprise_imported_from_json')) return;
    if (q.count.get().n > 0) {
      q.setMeta.run('enterprise_imported_from_json', `skipped-nonempty@${Date.now()}`);
      return;
    }
    const legacy = loadLegacyJson(legacyJsonPath);
    if (legacy && legacy.domains.length > 0) {
      importStore(legacy);
      q.setMeta.run(
        'enterprise_imported_from_json',
        `imported ${legacy.domains.length} domains@${new Date().toISOString()}`
      );
    } else {
      q.setMeta.run('enterprise_imported_from_json', `nothing-to-import@${Date.now()}`);
    }
  })();

  function isActiveDomain(domain) {
    if (!domain) return false;
    const d = String(domain).trim().toLowerCase();
    const row = q.byDomain.get(d);
    return !!row && (row.status === 'active' || row.status === 'trialing');
  }

  function getEntryByStripeCustomerId(customerId) {
    if (!customerId) return null;
    return rowToEntry(q.byCustomer.get(customerId));
  }

  function getEntryByStripeSubscriptionId(subId) {
    if (!subId) return null;
    return rowToEntry(q.bySubscription.get(subId));
  }

  function activateDomain({
    domain,
    companyName,
    contactEmail,
    contactPhone,
    stripeCustomerId,
    stripeSubscriptionId,
    stripeSubscriptionItemId,
  }) {
    const d = String(domain).trim().toLowerCase();
    let entry = getDomainEntry(d);
    if (entry) {
      entry.status = 'active';
      entry.companyName = companyName || entry.companyName;
      entry.contactEmail = contactEmail || entry.contactEmail;
      entry.contactPhone = contactPhone || entry.contactPhone;
      if (stripeCustomerId) entry.stripeCustomerId = stripeCustomerId;
      if (stripeSubscriptionId) entry.stripeSubscriptionId = stripeSubscriptionId;
      if (stripeSubscriptionItemId) entry.stripeSubscriptionItemId = stripeSubscriptionItemId;
      entry.updatedAt = new Date().toISOString();
    } else {
      entry = {
        domain: d,
        companyName: companyName || '',
        contactEmail: contactEmail || '',
        contactPhone: contactPhone || '',
        stripeCustomerId: stripeCustomerId || '',
        stripeSubscriptionId: stripeSubscriptionId || '',
        stripeSubscriptionItemId: stripeSubscriptionItemId || '',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }
    upsertEntry(entry);
    return { ok: true, domain: d };
  }

  function applySubscriptionState(subscription) {
    if (!subscription || typeof subscription !== 'object') {
      return { ok: false, reason: 'bad_payload' };
    }
    const subId = subscription.id;
    const customerId =
      typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer?.id || null;
    const status = subscription.status;
    let entry = subId ? rowToEntry(q.bySubscription.get(subId)) : null;
    if (!entry && customerId) {
      entry = rowToEntry(q.byCustomer.get(customerId));
    }
    if (!entry) {
      return { ok: false, reason: 'no_enterprise_domain' };
    }
    const activeStatuses = ['active', 'trialing', 'past_due'];
    if (activeStatuses.includes(status)) {
      entry.status = status === 'trialing' ? 'trialing' : 'active';
      entry.stripeSubscriptionId = subId;
      if (customerId) entry.stripeCustomerId = customerId;
    } else {
      entry.status = 'cancelled';
    }
    entry.updatedAt = new Date().toISOString();
    upsertEntry(entry);
    return { ok: true, domain: entry.domain, status: entry.status };
  }

  function recordUsage(domain, quantity = 1) {
    const d = String(domain).trim().toLowerCase();
    const entry = getDomainEntry(d);
    if (!entry) return;
    entry.usageCount = (entry.usageCount || 0) + quantity;
    entry.updatedAt = new Date().toISOString();
    upsertEntry(entry);
  }

  return {
    isActiveDomain,
    getDomainEntry,
    getEntryByStripeCustomerId,
    getEntryByStripeSubscriptionId,
    activateDomain,
    applySubscriptionState,
    getAllDomains,
    recordUsage,
    /** Absolute path to the SQLite database file. */
    getStoreFilePath: () => dbPath,
    /** Live snapshot in the legacy JSON shape — for admin backup + rollback. */
    exportStore,
    /** Replace all state from a JSON-shaped object (migration / restore / tests). */
    importStore,
    /** Close the shared DB handle (tests). */
    close: () => closeDb(baseDir),
  };
}
