// fal.ai, for generating the empty "before" room when stock has nothing that fits.
//
// Raw fetch, no SDK. Node 22 has global fetch, and fal's queue API is a POST plus a poll,
// so an SDK would buy nothing and cost something real: scripts/build.sh runs `npm ci` on
// every Render deploy, so a dependency for a tool that never runs in production is pure
// deploy weight and audit surface.
//
// Follows the null-client contract from lib/services/ai-clients.js: a missing or empty key
// yields null rather than a client that 400s on every call, so `if (!fal)` is the single
// spelling of "this source is disabled" and every call site degrades to Gemini.

const DEFAULT_ENDPOINT = 'https://queue.fal.run';
const POLL_MS = 1500;
const TIMEOUT_MS = 120_000;

/**
 * @param {{ apiKey?: string, endpoint?: string, fetchImpl?: typeof fetch }} options
 * @returns {{ generate: Function, endpoint: string } | null} null when no key is configured
 */
export function createFalClient({
  // FAL_AI_API_KEY is the primary name, matching GOOGLE_AI_API_KEY in the repo's .env.
  // FAL_KEY is accepted as a fallback because that is fal's own documented variable name.
  apiKey = process.env.FAL_AI_API_KEY || process.env.FAL_KEY,
  endpoint = DEFAULT_ENDPOINT,
  fetchImpl = fetch,
} = {}) {
  if (!apiKey || !apiKey.trim()) return null;

  const headers = {
    Authorization: `Key ${apiKey.trim()}`,
    'Content-Type': 'application/json',
  };

  async function json(url, init) {
    const res = await fetchImpl(url, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`fal ${init?.method ?? 'GET'} ${url} failed: ${res.status} ${body.slice(0, 300)}`);
    }
    return res.json();
  }

  return {
    endpoint,

    /**
     * Submit a job, poll until it finishes, download the first image.
     * @param {string} model e.g. 'fal-ai/flux/dev'
     * @param {object} input model-specific payload, typically { prompt, image_size, num_images }
     * @param {{ timeoutMs?: number, pollMs?: number, signal?: AbortSignal }} opts
     * @returns {Promise<{ buffer: Buffer, mime: string, model: string, input: object, meta: object }>}
     */
    async generate(model, input, { timeoutMs = TIMEOUT_MS, pollMs = POLL_MS } = {}) {
      const submitted = await json(`${endpoint}/${model}`, {
        method: 'POST',
        body: JSON.stringify(input),
      });

      const statusUrl = submitted.status_url;
      const responseUrl = submitted.response_url;
      if (!statusUrl || !responseUrl) {
        throw new Error(`fal did not return a queue handle for ${model}.`);
      }

      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const status = await json(statusUrl);
        if (status.status === 'COMPLETED') break;
        if (status.status === 'FAILED' || status.error) {
          throw new Error(`fal job failed for ${model}: ${JSON.stringify(status.error ?? status).slice(0, 300)}`);
        }
        if (Date.now() > deadline) {
          throw new Error(`fal job timed out after ${timeoutMs} ms for ${model}. Falling back.`);
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }

      const result = await json(responseUrl);
      const image = result?.images?.[0];
      if (!image?.url) {
        throw new Error(`fal returned no image for ${model}: ${JSON.stringify(result).slice(0, 300)}`);
      }

      const bytes = await fetchImpl(image.url);
      if (!bytes.ok) throw new Error(`Could not download the fal result: ${bytes.status}`);
      const buffer = Buffer.from(await bytes.arrayBuffer());

      return {
        buffer,
        mime: image.content_type ?? 'image/jpeg',
        model,
        input,
        meta: { width: image.width, height: image.height, requestId: submitted.request_id },
      };
    },
  };
}
