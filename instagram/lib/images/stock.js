// Free-license stock photography, for the "before" room.
//
// Pexels and Unsplash only, both by API, both with keys that cost nothing. This is not a
// convenience choice. Reposting a photo found by web search on a commercial account is a
// takedown or a demand letter waiting to happen, and staging it first does not change that,
// because the staged render is a derivative work of someone else's photograph.
//
// Two rules enforced in code rather than by discipline:
//   1. A candidate missing photographer or source URL is DROPPED, never defaulted. A record
//      with "photographer: unknown" is indistinguishable from a stolen photo six months on.
//   2. Image bytes are downloaded only from the hosts in config.stock.allowedHosts. If a
//      future source is added, that list is the single place it becomes possible.

const PEXELS_SEARCH = 'https://api.pexels.com/v1/search';
const UNSPLASH_SEARCH = 'https://api.unsplash.com/search/photos';

/**
 * @param {{ config: object, fetchImpl?: typeof fetch,
 *           pexelsKey?: string, unsplashKey?: string }} options
 */
export function createStockSource({
  config,
  fetchImpl = fetch,
  pexelsKey = process.env.PEXELS_API_KEY,
  unsplashKey = process.env.UNSPLASH_ACCESS_KEY,
} = {}) {
  const allowedHosts = new Set(config.stock.allowedHosts);

  const available = {
    pexels: Boolean(pexelsKey && pexelsKey.trim()),
    unsplash: Boolean(unsplashKey && unsplashKey.trim()),
  };

  async function getJson(url, headers) {
    const res = await fetchImpl(url, { headers });
    if (!res.ok) {
      throw new Error(`Stock search failed: ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    }
    return res.json();
  }

  async function searchPexels(query, { orientation, perPage }) {
    if (!available.pexels) return [];
    const url = `${PEXELS_SEARCH}?query=${encodeURIComponent(query)}&orientation=${orientation}&per_page=${perPage}`;
    const data = await getJson(url, { Authorization: pexelsKey.trim() });
    return (data.photos ?? [])
      .filter((p) => p.photographer && p.photographer_url && p.url && p.src?.original)
      .map((p) => ({
        provider: 'pexels',
        id: String(p.id),
        width: p.width,
        height: p.height,
        downloadUrl: p.src.original,
        description: p.alt ?? '',
        license: {
          type: 'pexels',
          sourceUrl: p.url,
          photographer: p.photographer,
          photographerUrl: p.photographer_url,
          licenseName: 'Pexels License',
          licenseUrl: 'https://www.pexels.com/license/',
          attributionRequired: false,
          attributionText: `Photo by ${p.photographer} on Pexels`,
        },
      }));
  }

  async function searchUnsplash(query, { orientation, perPage }) {
    if (!available.unsplash) return [];
    const url = `${UNSPLASH_SEARCH}?query=${encodeURIComponent(query)}&orientation=${orientation}&per_page=${perPage}`;
    const data = await getJson(url, { Authorization: `Client-ID ${unsplashKey.trim()}` });
    return (data.results ?? [])
      .filter((p) => p.user?.name && p.user?.links?.html && p.links?.html && p.urls?.raw)
      .map((p) => ({
        provider: 'unsplash',
        id: p.id,
        width: p.width,
        height: p.height,
        downloadUrl: p.urls.raw,
        // Unsplash's API terms require pinging this endpoint when an image is actually used.
        downloadLocation: p.links.download_location ?? null,
        description: p.alt_description ?? '',
        license: {
          type: 'unsplash',
          sourceUrl: p.links.html,
          photographer: p.user.name,
          photographerUrl: p.user.links.html,
          licenseName: 'Unsplash License',
          licenseUrl: 'https://unsplash.com/license',
          attributionRequired: false,
          attributionText: `Photo by ${p.user.name} on Unsplash`,
        },
      }));
  }

  return {
    available,

    /**
     * @param {string} query
     * @param {{ orientation?: 'portrait'|'landscape'|'squarish', perPage?: number }} opts
     * @returns {Promise<object[]>} candidates from every configured provider
     */
    async search(query, { orientation = 'portrait', perPage = 15 } = {}) {
      const results = await Promise.allSettled([
        searchPexels(query, { orientation, perPage }),
        searchUnsplash(query, { orientation, perPage }),
      ]);
      // One provider being down or rate limited should not lose the other's results.
      return results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    },

    /**
     * @param {object} candidate one entry from search()
     * @returns {Promise<{ buffer: Buffer, license: object, provider: string, sourceId: string }>}
     */
    async download(candidate) {
      const host = new URL(candidate.downloadUrl).host;
      if (!allowedHosts.has(host)) {
        throw new Error(
          `Refusing to download image bytes from ${host}. ` +
          `Only ${[...allowedHosts].join(', ')} are allowed. See config.json stock.allowedHosts.`,
        );
      }

      if (candidate.provider === 'unsplash' && candidate.downloadLocation && available.unsplash) {
        // Required by the Unsplash API terms whenever an image is actually used. Best
        // effort: a failure here must not lose a post, but skipping it silently would put
        // the account out of compliance.
        try {
          await fetchImpl(candidate.downloadLocation, {
            headers: { Authorization: `Client-ID ${unsplashKey.trim()}` },
          });
        } catch { /* the download itself is what matters */ }
      }

      const res = await fetchImpl(candidate.downloadUrl);
      if (!res.ok) throw new Error(`Could not download ${candidate.provider} photo: ${res.status}`);

      return {
        buffer: Buffer.from(await res.arrayBuffer()),
        license: { ...candidate.license, retrievedAt: new Date().toISOString() },
        provider: candidate.provider,
        sourceId: candidate.id,
      };
    },
  };
}
