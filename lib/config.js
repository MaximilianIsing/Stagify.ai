// Config/secret readers extracted from server.js. Factory injects module-scope
// deps (currently just __dirname) so the reader functions keep their exact
// behavior when resolving stripe_*.txt secret files and env vars.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export function createConfig(deps) {
  const { __dirname } = deps;

  function stripeSecretSearchDirs() {
    const dirs = [];
    const envDir = process.env.STRIPE_SECRETS_DIR;
    if (envDir && String(envDir).trim()) {
      dirs.push(path.resolve(String(envDir).trim()));
    }
    dirs.push(__dirname);
    dirs.push(process.cwd());
    dirs.push('/etc/secrets');
    const seen = new Set();
    return dirs.filter((p) => {
      const n = path.resolve(p);
      if (seen.has(n)) return false;
      seen.add(n);
      return true;
    });
  }

  function readFirstStripeFile(name, validate) {
    for (const dir of stripeSecretSearchDirs()) {
      const filePath = path.join(dir, name);
      try {
        if (!fs.existsSync(filePath)) continue;
        const raw = fs.readFileSync(filePath, 'utf8').trim().replace(/^\uFEFF/, '');
        const v = validate(raw);
        if (v) return v;
      } catch (e) {
        console.warn(`[stripe] Could not read ${name} in ${dir}:`, e.message);
      }
    }
    return null;
  }

  function readStripeSecretKey() {
    const fromFile = readFirstStripeFile('stripe_secret_key.txt', (raw) => {
      if (raw.startsWith('sk_')) return raw;
      if (raw) console.warn('[stripe] stripe_secret_key.txt must start with sk_ — ignored');
      return null;
    });
    if (fromFile) return fromFile;
    const fromEnv = process.env.STRIPE_SECRET_KEY;
    if (fromEnv && String(fromEnv).trim().startsWith('sk_')) {
      return String(fromEnv).trim();
    }
    return '';
  }

  function readStripeWebhookSecret() {
    const fromFile = readFirstStripeFile('stripe_webhook_secret.txt', (raw) => {
      if (raw.startsWith('whsec_')) return raw;
      if (raw) console.warn('[stripe] stripe_webhook_secret.txt must start with whsec_ — ignored');
      return null;
    });
    if (fromFile) return fromFile;
    const fromEnv = process.env.STRIPE_WEBHOOK_SECRET;
    if (fromEnv && String(fromEnv).trim()) {
      return String(fromEnv).trim();
    }
    return '';
  }

  function readStripePublishableKey() {
    const fromFile = readFirstStripeFile('stripe_publishable.txt', (raw) => {
      if (raw.startsWith('pk_')) return raw;
      if (raw) console.warn('[stripe] stripe_publishable.txt must start with pk_ — ignored');
      return null;
    });
    if (fromFile) return fromFile;
    const fromEnv = process.env.STRIPE_PUBLISHABLE_KEY;
    if (fromEnv && String(fromEnv).trim().startsWith('pk_')) return String(fromEnv).trim();
    return '';
  }

  function readEnterprisePriceId() {
    const fromFile = readFirstStripeFile('priceid.txt', (raw) => {
      const cleaned = raw.replace(/^["'\s]*"?id"?\s*:\s*"?/i, '').replace(/["'\s]+$/g, '').trim();
      if (cleaned.startsWith('price_')) return cleaned;
      if (raw.startsWith('price_')) return raw;
      if (raw) console.warn('[stripe] priceid.txt must contain a price_ id — ignored');
      return null;
    });
    if (fromFile) return fromFile;
    const fromEnv = process.env.ENTERPRISE_PRICE_ID;
    if (fromEnv && String(fromEnv).trim().startsWith('price_')) return String(fromEnv).trim();
    return '';
  }

  function readGoogleClientId() {
    const fromFile = readFirstStripeFile('googleclientID.txt', (raw) => {
      const s = String(raw).trim();
      if (!s) return null;
      if (s.includes('.apps.googleusercontent.com')) return s;
      if (/^[0-9a-zA-Z._-]{20,}$/.test(s)) return s;
      if (raw) console.warn('[google] googleclientID.txt does not look like a Google OAuth client id — ignored');
      return null;
    });
    if (fromFile) return fromFile;
    const fromEnv = process.env.GOOGLE_CLIENT_ID;
    if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
    return '';
  }

  /** Optional. Sign-In With Google (ID token) only needs the client id; secret is for other OAuth flows. */
  function readGoogleClientSecret() {
    const fromFile = readFirstStripeFile('googlesecret.txt', (raw) => {
      const s = String(raw).trim();
      return s || null;
    });
    if (fromFile) return fromFile;
    const fromEnv = process.env.GOOGLE_CLIENT_SECRET;
    if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
    return '';
  }

  function readEndpointAccessKey() {
    const fromFile = readFirstStripeFile('endpointkey.txt', (raw) => {
      const s = String(raw).trim();
      return s || null;
    });
    if (fromFile) return fromFile;
    const fromEnv = process.env.endpoint_key;
    if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
    return '';
  }

  function endpointKeyMatches(received, expected) {
    if (!received || !expected || typeof received !== 'string' || typeof expected !== 'string') {
      return false;
    }
    const a = crypto.createHash('sha256').update(received, 'utf8').digest();
    const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
    return crypto.timingSafeEqual(a, b);
  }

  function readEnterpriseMeterEventName() {
    const fromFile = readFirstStripeFile('enterprise_meter_event.txt', (raw) => {
      const s = String(raw).trim();
      return s || null;
    });
    if (fromFile) return fromFile;
    const fromEnv = process.env.ENTERPRISE_METER_EVENT_NAME;
    if (fromEnv && String(fromEnv).trim()) return String(fromEnv).trim();
    return 'user_generation';
  }

  return {
    stripeSecretSearchDirs,
    readFirstStripeFile,
    readStripeSecretKey,
    readStripeWebhookSecret,
    readStripePublishableKey,
    readEnterprisePriceId,
    readGoogleClientId,
    readGoogleClientSecret,
    readEndpointAccessKey,
    readEnterpriseMeterEventName,
    endpointKeyMatches,
  };
}
