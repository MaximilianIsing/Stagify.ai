import fs from 'fs';
import path from 'path';

function getStorePath(baseDir) {
  const logDir =
    process.env.RENDER && fs.existsSync('/data') ? '/data' : path.join(baseDir, 'data');
  if (!fs.existsSync(logDir)) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
    } catch {
      return path.join(baseDir, 'enterprise-domains.json');
    }
  }
  return path.join(logDir, 'enterprise-domains.json');
}

function loadStore(filePath) {
  try {
    if (!fs.existsSync(filePath)) return { domains: [] };
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return { domains: [] };
    const data = JSON.parse(raw);
    if (!Array.isArray(data.domains)) data.domains = [];
    return data;
  } catch {
    return { domains: [] };
  }
}

function saveStore(filePath, store) {
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), 'utf8');
}

export function createEnterpriseStore(baseDir) {
  const filePath = getStorePath(baseDir);

  function read() {
    return loadStore(filePath);
  }

  function write(store) {
    saveStore(filePath, store);
  }

  function isActiveDomain(domain) {
    if (!domain) return false;
    const d = String(domain).trim().toLowerCase();
    const store = read();
    return store.domains.some(
      (e) => e.domain === d && (e.status === 'active' || e.status === 'trialing'),
    );
  }

  function getDomainEntry(domain) {
    const d = String(domain).trim().toLowerCase();
    const store = read();
    return store.domains.find((e) => e.domain === d) || null;
  }

  function getEntryByStripeCustomerId(customerId) {
    if (!customerId) return null;
    const store = read();
    return store.domains.find((e) => e.stripeCustomerId === customerId) || null;
  }

  function getEntryByStripeSubscriptionId(subId) {
    if (!subId) return null;
    const store = read();
    return store.domains.find((e) => e.stripeSubscriptionId === subId) || null;
  }

  /**
   * Activate an enterprise domain after Stripe checkout completes.
   */
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
    const store = read();
    let entry = store.domains.find((e) => e.domain === d);
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
      store.domains.push(entry);
    }
    write(store);
    return { ok: true, domain: d };
  }

  /**
   * Sync enterprise domain status with Stripe subscription state.
   */
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
    const store = read();
    let entry = store.domains.find((e) => e.stripeSubscriptionId === subId);
    if (!entry && customerId) {
      entry = store.domains.find((e) => e.stripeCustomerId === customerId);
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
    write(store);
    return { ok: true, domain: entry.domain, status: entry.status };
  }

  function getAllDomains() {
    return read().domains;
  }

  return {
    isActiveDomain,
    getDomainEntry,
    getEntryByStripeCustomerId,
    getEntryByStripeSubscriptionId,
    activateDomain,
    applySubscriptionState,
    getAllDomains,
    getStoreFilePath: () => filePath,
  };
}
