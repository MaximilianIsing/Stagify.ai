// Stagify.ai — the Exterior Studio's one network call.
//
// POST /api/enhance-exterior, multipart, one photo in and one photo out. Deliberately
// simpler than app/staging-pipeline.js's equivalent: there is no concurrent
// validate-and-abort race here because the upload gate runs server-side INSIDE the
// handler, before the model is touched (see lib/staging/exterior-handler.js). One
// request, one answer.

import { unstageableMessage } from '../unstageable-message.js';

/**
 * How long to wait for a render.
 *
 * The same 180s the staging pipeline allows: a quality-gate retry can run the model up to
 * three times, and a request killed at 60s would abandon renders the user has already
 * been billed for.
 */
export const ENHANCE_TIMEOUT_MS = 180000;

/** Shape of a rejection the caller can show verbatim. */
export class EnhanceError extends Error {
  /**
   * @param {string} message - The sentence to show the user.
   * @param {string} [code] - Stable machine code, when the server sent one.
   */
  constructor(message, code) {
    super(message);
    this.name = 'EnhanceError';
    this.code = code || '';
  }
}

/**
 * The "Label as virtually staged" fields, exactly as every server-side surface names them.
 *
 * Listed here so the FormData below and the drift guard in enhance.test.js read from one
 * place, and so the badge is visibly NOT one of the removal rows: those describe an edit to
 * the property, these describe the file that comes back.
 */
export const BADGE_FIELDS = ['labelVirtuallyStaged', 'stampLang', 'stampStyle', 'stampScale'];

/**
 * Send one exterior photo for enhancement.
 *
 * @param {{ file: File, options: import('./controls.js').ExteriorRequest, badge?: Record<string, unknown> | null, token: string | null, fetchImpl?: typeof fetch, timeoutMs?: number, tx?: (key: string, fallback: string) => string }} arg - The photo, the chosen options, the disclosure-badge fields, the auth token, and test seams.
 * @returns {Promise<{ image: string, gallery?: unknown, user?: unknown }>} The enhanced image as a data URL, plus whatever else the server returned.
 */
export async function enhanceExterior({ file, options, badge = null, token, fetchImpl, timeoutMs = ENHANCE_TIMEOUT_MS, tx }) {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  const say = tx || ((_key, fallback) => fallback);

  const form = new FormData();
  form.append('image', file);
  form.append('timeOfDay', options.timeOfDay);
  form.append('sky', options.sky);
  // Multipart has no booleans. 'true'/'false' rather than omitting the field when off:
  // the handler reads 'on' and 'true' as enabled and everything else as disabled, so an
  // explicit 'false' says what it means and survives someone changing that default.
  //
  // Listed rather than looped over Object.keys(options) so the wire format stays a
  // deliberate statement: `options` also carries the two presets and the free text, and a
  // blanket loop would post whatever a future field happened to be called.
  // test/frontend/exterior-studio/enhance.test.js checks this list against the checkbox
  // names in the real markup, so a removal added to the page but not sent from here fails
  // the build rather than becoming a tickbox with no effect.
  for (const name of ['removeVehicles', 'removeClutter', 'removePeople', 'removeSnow', 'removeWetWeather', 'removeLeaves']) {
    form.append(name, String(!!(/** @type {any} */ (options)[name])));
  }
  form.append('additionalPrompt', options.additionalPrompt || '');

  // The disclosure badge. Sent only when the caller supplied it, so a page that never wired
  // the control posts nothing rather than an explicit "no label" — and every field is sent
  // together, because a style with no flag would configure an option that is off.
  if (badge) {
    for (const name of BADGE_FIELDS) form.append(name, String(badge[name]));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await doFetch('/api/enhance-exterior', {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
      signal: controller.signal,
    });
  } catch (err) {
    // An abort and a dropped connection are the same story to the user: nothing came
    // back, their upload is still on screen, try again.
    throw new EnhanceError(
      say('exteriorStudio.errors.network', 'The connection dropped before the photo came back. Your upload is still here. Try again.'),
      'NETWORK',
    );
  } finally {
    clearTimeout(timer);
  }

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    // 422 with a code is the upload gate: the photo is not an exterior. That copy is
    // already localized by category through the shared helper, so it is shown verbatim
    // rather than replaced with a generic failure.
    if (res.status === 422 && body && body.code && body.code !== 'NO_IMAGE_GENERATED') {
      // The localizer reaches into the loaded language pack, so a malformed or
      // half-loaded pack can throw. Contain it: the caller prints `err.message`, and the
      // one thing worse than an untranslated rejection is a stack fragment in a toast.
      let message;
      try {
        message = unstageableMessage(body);
      } catch {
        message = body.reason || say('exteriorStudio.errors.generic', 'That photo could not be enhanced. Please try another shot of the property exterior.');
      }
      throw new EnhanceError(message, body.code);
    }
    throw new EnhanceError(
      (body && body.error)
        || say('exteriorStudio.errors.generic', 'That photo could not be enhanced. Please try another shot of the property exterior.'),
      (body && body.code) || String(res.status),
    );
  }

  if (!body || !body.image) {
    throw new EnhanceError(
      say('exteriorStudio.errors.generic', 'That photo could not be enhanced. Please try another shot of the property exterior.'),
      'NO_IMAGE',
    );
  }
  return body;
}
