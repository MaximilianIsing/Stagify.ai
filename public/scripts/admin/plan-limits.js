// Plan limits the admin console reasons about.
//
// FREE_DAILY_LIMIT is a copy of the one in lib/data/auth-store.js: the browser
// cannot import it and /authstore does not send it. A leaf module (no imports) so
// tests can load it without pulling in the findings rule graph, and
// test/frontend/admin/free-daily-limit-drift.test.js fails if the two diverge.

/** The free plan's daily render cap. */
export const FREE_DAILY_LIMIT = 100;
