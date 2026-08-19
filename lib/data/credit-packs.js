// The credit packs a customer can buy, and the mapping to Stripe prices.
//
// WHY THE TABLE LIVES HERE AND NOT IN STRIPE. The webhook must be able to answer "how
// many credits does this payment buy?" from OUR data, keyed by an id we put in the
// session metadata — and then VERIFY that answer against the amount Stripe says was
// actually paid. Reading the credit count out of the session's own metadata alone
// would mean a caller who could influence metadata could mint credits; reading it out
// of the Stripe price would mean a dashboard edit silently changes what we grant.
// The table is the claim, `amount_total` is the proof, and both have to agree.
//
// THE UNIT IS A WHOLE IMAGE. Credits are integers all the way down (see
// lib/data/api-billing.js). Packs differ in $/credit; the unit never does, so nothing
// downstream ever rounds.
//
// THE PRICE CURVE. $0.150 / $0.140 / $0.130 / $0.120 an image as the packs get bigger.
// The SMALLEST is deliberately the same headline number as the Enterprise
// per-generation rate on public/enterprise.html, so no pack undercuts the figure the
// marketing pages quote.
//
// Those two $0.15s are not the same unit by default: Enterprise meters per model
// ATTEMPT (initial + quality-gate retries — see lib/staging/exterior-handler.js) while
// a credit buys one DELIVERED image. What makes them comparable is that the API renders
// with `skipQualityReview`, so on this path one credit is one attempt is one image.
// Turn that off and this price stops being honest.

/**
 * The packs, cheapest first. `priceId` is filled in from config at construction —
 * the ids differ between Stripe test and live mode, so they cannot be literals here.
 * @typedef {{ id: string, credits: number, amountCents: number, currency: string, priceId: string }} CreditPack
 */

/** The catalogue, without the environment-specific price ids. */
const PACKS = [
  { id: 'api_20', credits: 20, amountCents: 300, currency: 'usd' },
  { id: 'api_50', credits: 50, amountCents: 700, currency: 'usd' },
  { id: 'api_100', credits: 100, amountCents: 1300, currency: 'usd' },
  { id: 'api_500', credits: 500, amountCents: 6000, currency: 'usd' },
];

/**
 * Build the pack table bound to this environment's Stripe price ids.
 * @param {{ api_20?: string, api_50?: string, api_100?: string, api_500?: string }} priceIds - Stripe price ids by pack id.
 * @returns {{ list: () => CreditPack[], resolvePackById: (id: string) => CreditPack | null, resolvePackByPriceId: (priceId: string) => CreditPack | null, configured: () => boolean }}
 */
export function createCreditPacks(priceIds = {}) {
  const packs = PACKS.map((p) => ({ ...p, priceId: String(priceIds[p.id] || '') }));

  /**
   * Packs that can actually be sold — one without a configured price id would send a
   * customer to a Stripe session that cannot be created.
   * @returns {CreditPack[]} The sellable packs.
   */
  function list() {
    return packs.filter((p) => p.priceId);
  }

  /**
   * @param {string} id - A pack id from session metadata.
   * @returns {CreditPack | null} The pack, or null when unknown.
   */
  function resolvePackById(id) {
    return packs.find((p) => p.id === id) ?? null;
  }

  /**
   * @param {string} priceId - A Stripe price id.
   * @returns {CreditPack | null} The pack, or null when unknown.
   */
  function resolvePackByPriceId(priceId) {
    if (!priceId) return null;
    return packs.find((p) => p.priceId && p.priceId === priceId) ?? null;
  }

  /** @returns {boolean} Whether any pack can be sold at all. */
  function configured() {
    return list().length > 0;
  }

  return { list, resolvePackById, resolvePackByPriceId, configured };
}

/** The raw catalogue, for tests and for documentation generation. */
export const CREDIT_PACKS = PACKS;
