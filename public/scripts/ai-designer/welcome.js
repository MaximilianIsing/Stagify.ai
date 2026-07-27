// Networking half of the AI Designer's opening greeting, split out of
// ai-designer-app.js so the REQUEST SHAPE is unit-testable.
//
// Why this exists as its own module: /api/welcome-message is pro-gated, and the
// entry file used to send the session token as `?authToken=`. The server
// deliberately never reads a token from req.query — a token in a URL leaks via
// access logs, browser history, and Referer headers (see the comment in
// lib/services/auth-helpers.js, and the test that pins it in
// test/services/auth-helpers.test.js). So the call always 401'd, the caller's
// `data.message || defaultWelcomeMessage()` quietly swallowed it, and the whole
// personalized-greeting feature never ran in production for anyone.
//
// The server side of that invariant was already covered; the client side was not,
// because the fetch lived inside a DOM closure no test could reach. Extracting
// just the fetch (the DOM work stays in the entry file) makes the header
// assertable, so a regression to a query param fails the suite instead of
// silently degrading to the static greeting again.

/**
 * Fetch the personalized welcome greeting for the signed-in Pro user.
 *
 * Sends the session token as `Authorization: Bearer` — never as a query param.
 * Resolves to `null` for every non-greeting outcome (no session, a non-OK status,
 * or a response with no `message`), leaving the caller to fall back to its static
 * greeting. Rejects only if the transport itself fails or the body is not JSON.
 *
 * @param {string|null|undefined} token - The session token, or a falsy value when signed out.
 * @param {{ fetchImpl?: typeof fetch, warn?: (message: string) => void }} [options] - Injectable fetch (for tests) and a warning sink for non-OK responses.
 * @returns {Promise<string|null>} The greeting text, or null when there is none to show.
 */
export async function fetchWelcomeMessage(token, options = {}) {
  const { fetchImpl = fetch, warn } = options;

  const response = await fetchImpl('/api/welcome-message', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

  if (!response.ok) {
    // A non-OK status is expected and unremarkable when signed out. WITH a token it
    // means the gate rejected a session we believe is valid — the exact condition
    // that hid the original bug, so surface it rather than failing silently.
    if (token && warn) {
      warn(`Welcome message unavailable (HTTP ${response.status}); using the default greeting.`);
    }
    return null;
  }

  const data = await response.json();
  return (data && data.message) || null;
}
