// Stable, opaque handles for accounts, so the analyst can talk about a specific
// person without a person ever leaving the browser.
//
// THE PROBLEM THIS SOLVES. The most valuable questions an operator asks are about
// individuals — who is about to churn, who should be emailed, who is quietly
// carrying half the render volume. Answering those means the model has to be able
// to refer to one account and have the operator know which one. The obvious way to
// do that is to send the email, and the console has spent its whole life not doing
// that: findings carry names only in an `accounts` array that the brief endpoint
// drops, and lib/services/admin-brief.js scrubs anything address-shaped as a
// backstop.
//
// So the model gets `acct_4f1a2b` and the operator gets jane@example.com, and the
// substitution happens here, on the way to the DOM. The handle is stable for the
// life of the page, which is what lets a follow-up question ("what did that first
// one do in March?") refer back to an account from three turns ago.
//
// WHY NOT A HASH OF THE EMAIL. A hash is a pseudonym with a preimage: anyone
// holding a list of candidate addresses can confirm membership by hashing them.
// These handles are minted from a counter and a per-page random salt, so they
// carry no information about the account at all and cannot be correlated across
// two sessions of the same dashboard.

/** Handle pattern, exported so the renderer and the leak tests agree on one regex. */
export const HANDLE_RE = /\bacct_[0-9a-f]{6}\b/g;

/**
 * Build a handle registry for one page load.
 *
 * Deliberately a factory rather than a module-level map: `reset()` on sign-out
 * has to actually forget, and a module singleton would keep the previous
 * operator's account list alive in a closure until the tab was closed.
 */
export function createIdentityMap() {
  /** @type {Map<string, string>} userId → handle */
  const toHandle = new Map();
  /** @type {Map<string, {id: string, email: string}>} handle → account */
  const toAccount = new Map();
  let counter = 0;

  /** Six hex digits that say nothing about the account they stand for. */
  function mint() {
    counter += 1;
    const noise = Math.floor(Math.random() * 0x1000000);
    // Counter in the high bits guarantees uniqueness; the noise makes the handle
    // uninformative about ordering or volume.
    return `acct_${(((counter * 0x9e3779b1) ^ noise) >>> 8).toString(16).padStart(6, '0').slice(-6)}`;
  }

  /**
   * The handle for an account, minted on first sight.
   * @param {{id?: string, email?: string}} account
   * @returns {string}
   */
  function handleFor(account) {
    const key = String((account && (account.id || account.email)) || '').trim();
    if (!key) return 'acct_unknown';
    const existing = toHandle.get(key);
    if (existing) return existing;

    let handle = mint();
    // Collisions are vanishingly unlikely and trivially survivable; looping beats
    // two accounts sharing a handle, which would silently merge them in an answer.
    while (toAccount.has(handle)) handle = mint();

    toHandle.set(key, handle);
    toAccount.set(handle, { id: String((account && account.id) || ''), email: String((account && account.email) || '') });
    return handle;
  }

  /**
   * The account behind a handle, or null if it was never minted here.
   * @param {string} handle
   */
  function accountFor(handle) {
    return toAccount.get(String(handle || '').trim()) || null;
  }

  /**
   * Split text into runs, marking which are handles.
   *
   * Returns segments rather than a substituted string on purpose: the caller
   * builds DOM with `textContent` per segment, so an email can never be spliced
   * into markup. The whole console follows that rule (see the conventions note in
   * docs/guides/admin-dashboard.md) and this is the one place most tempted to
   * break it, because a regex replace into innerHTML would be one line.
   *
   * @param {string} text
   * @returns {Array<{text: string, account: {id: string, email: string}|null}>}
   */
  function segment(text) {
    const source = String(text == null ? '' : text);
    /** @type {Array<{text: string, account: any}>} */
    const out = [];
    let last = 0;
    HANDLE_RE.lastIndex = 0;

    for (let m = HANDLE_RE.exec(source); m; m = HANDLE_RE.exec(source)) {
      const account = accountFor(m[0]);
      if (!account) continue; // A handle we never minted is just text.
      if (m.index > last) out.push({ text: source.slice(last, m.index), account: null });
      out.push({ text: account.email || account.id || m[0], account });
      last = m.index + m[0].length;
    }
    if (last < source.length) out.push({ text: source.slice(last), account: null });
    return out.length ? out : [{ text: source, account: null }];
  }

  /** Forget every account. Called on reload and on sign-out. */
  function reset() {
    toHandle.clear();
    toAccount.clear();
    counter = 0;
  }

  return { handleFor, accountFor, segment, reset };
}
