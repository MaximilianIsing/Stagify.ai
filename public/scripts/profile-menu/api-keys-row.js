// The "API keys" row in the account menu — and the rule that keeps it out of the way
// of everyone who does not use the API.
//
// WHY IT IS IN THIS MENU AT ALL. The developer dashboard deliberately gets no top-level
// nav tab: the API is a minority surface and a permanent nav button would cost every
// visitor attention for something almost none of them want. The account menu is where
// per-account things already live, and it costs zero layout.
//
// Note the mirror-image reasoning one file over: profile-menu.js explains that the
// GALLERY is deliberately NOT listed here BECAUSE it has a top-level tab, and a menu
// row one step from that tab is noise. The same rule puts this row in: no tab, so the
// menu is the only place it can live.
//
// WHY IT IS GATED ON USE RATHER THAN SHOWN TO EVERYONE. A row saying "API keys" in the
// account menu of a person who will never write code is an advertisement, not
// navigation. It appears once an account actually has an API presence — a live key or
// a credit balance — and until then the only way in is developers.html, which is where
// somebody looking for an API is already going to be. That is the same instinct behind
// the collapsed Stagify+ rail: reach the interested without taxing the rest.

/**
 * Whether the account menu should carry the API row.
 *
 * Pure, so the rule is unit-testable without a DOM or a network. `null` means "not
 * asked yet" and reads as NO: the row appearing a moment late is invisible, where a row
 * that flashes in and out on every menu open is not.
 * @param {{ keyCount?: number, balance?: number, lifetimePurchased?: number } | null} summary - The /api/api-credits payload, or null when unfetched.
 * @returns {boolean} Whether to render the row.
 */
export function apiRowVisible(summary) {
  if (!summary) return false;
  return (
    Number(summary.keyCount) > 0 ||
    Number(summary.balance) > 0 ||
    Number(summary.lifetimePurchased) > 0
  );
}

/**
 * Build the row's markup.
 *
 * NO LONGER MOUNTED. `stagifyApiRowHtml` below now points every signed-in visitor at
 * api-keys.html, so this gated row would be a second entry to the same page under a
 * different name. profile-menu.js stopped rendering it (and stopped fetching the summary
 * that decided whether to), which leaves this, `apiRowVisible` and `createApiSummary`
 * exported but with no caller outside their own tests. They are kept rather than deleted
 * only because the API dashboard is being built in parallel right now and may want the
 * use-gating back; if it does not, this whole group should go together.
 *
 * `desktop-only` because the dashboard is a PC-only page: it is a two-column inspector,
 * and `scripts/api-keys-gate.js` answers a phone-sized viewport by sending it to the
 * home page. Hiding the row is HALF of that rule — the gate is the other half, and
 * neither is sufficient alone (a bookmark bypasses this; the nav would otherwise
 * advertise a page that answers a tap by undoing it). The class and the gate share the
 * 768px breakpoint, and test/frontend/desktop-only-gates.test.js fails if they drift.
 * @param {(key: string, fallback: string) => string} lang - Translator from dom-utils.
 * @param {(s: string) => string} esc - HTML escaper from dom-utils.
 * @returns {string} The row HTML.
 */
export function apiKeysRowHtml(lang, esc) {
  return (
    '<a href="api-keys.html" class="profile-menu__link desktop-only">' +
    esc(lang('profile.apiKeys', 'API keys & credits')) +
    '</a>'
  );
}

/**
 * The Stagify API row — the account menu's ONE API entry, and it goes to the dashboard.
 *
 * It used to point at developers.html and be the ungated counterpart to the row above:
 * the docs were how somebody FOUND the API, and the dashboard row appeared only once they
 * had a key. That split is gone. This row now goes to api-keys.html for everyone signed
 * in, and `apiKeysRowHtml` above is no longer mounted (see the note on it). The docs are
 * still reachable from the footer's Developers link, which is where a section-of-the-site
 * link belongs anyway.
 *
 * `desktop-only`, and this is NOT inherited styling — it is half of a rule. api-keys.html
 * loads scripts/api-keys-gate.js, which answers a phone-sized viewport by sending it to
 * the home page, so an unhidden row here would advertise a page that undoes the tap. The
 * class and the gate share the 768px breakpoint and
 * test/frontend/desktop-only-gates.test.js fails if they drift. Note the row was ALREADY
 * wrong on this point before the repoint — it pointed at developers.html, which gates
 * phones the same way, and carried no class; nothing caught it because the sweep only
 * looks at rows that already have one.
 *
 * The label is a PRODUCT NAME, so it is identical in all eleven packs — the same rule
 * navigation.brand and navigation.plusBadge follow.
 *
 * Sits between "Report an issue" and "Sign out" — the last thing in the menu that goes
 * somewhere, directly above the one action that ends the session.
 * @param {(key: string, fallback: string) => string} lang - Translator from dom-utils.
 * @param {(s: string) => string} esc - HTML escaper from dom-utils.
 * @returns {string} The row HTML.
 */
export function stagifyApiRowHtml(lang, esc) {
  return (
    '<a href="api-keys.html" class="profile-menu__link desktop-only">' +
    esc(lang('profile.stagifyApi', 'Stagify API')) +
    '</a>'
  );
}

/**
 * Fetch the account's API summary once and remember it.
 *
 * Cached for the life of the page: this fires from the menu's open handler, which a
 * user can hit repeatedly, and the answer does not change while they are looking at a
 * dropdown. A failure caches `null` and is never retried — the row is a convenience,
 * and a menu that re-requests on every open because the network is flaky is worse than
 * a missing shortcut.
 * @param {{ getToken: () => string | null }} auth - The auth global.
 * @param {typeof fetch} [fetchImpl] - Injectable for tests.
 * @returns {{ read: () => any, load: () => Promise<any> }} The cache.
 */
export function createApiSummary(auth, fetchImpl) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  let summary = null;
  let started = false;

  /** @returns {any} The cached summary, or null. */
  function read() {
    return summary;
  }

  /** @returns {Promise<any>} The summary, fetching at most once per page. */
  async function load() {
    if (started) return summary;
    started = true;
    const token = auth && typeof auth.getToken === 'function' ? auth.getToken() : null;
    if (!token) return null;
    try {
      const res = await doFetch('/api/api-credits', {
        headers: { Authorization: 'Bearer ' + token },
      });
      if (!res.ok) return null;
      summary = await res.json();
      return summary;
    } catch {
      // Offline, or the endpoint is unreachable. Stay quiet — see above.
      return null;
    }
  }

  return { read, load };
}
