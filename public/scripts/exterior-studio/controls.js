// Stagify.ai — the Exterior Studio's opt-in control panel.
//
// EVERY CHANGE IS OPT-IN, and that is the whole design. The first build put a
// "Time of day" and a "Sky" dropdown at the top of the panel, each defaulting to "Keep as
// photographed". Functionally that was already a no-op — but it read as a form to fill
// in, so someone who only wanted the bin bags gone still had to look at, understand and
// decide against two controls about the weather.
//
// Now each row is a checkbox that starts OFF and reveals its own sub-control when ticked.
// The wire format is unchanged: an unticked preset still sends 'keep', which the prompt
// builder maps to silence. So "off" and "keep as photographed" are the same statement to
// the server, made once instead of twice.

/** Wire value meaning "do not touch this", for a preset whose toggle is off. */
export const KEEP = 'keep';

/**
 * One enhancement request, exactly as POST /api/enhance-exterior wants its fields named.
 *
 * The mirror of `ExteriorOptions` in lib/staging/exterior-prompts.js — same keys, one per
 * side of the wire. Named here rather than repeated inline so enhance.js can refer to it
 * and the two islands cannot drift into disagreeing about what a request is.
 *
 * @typedef {object} ExteriorRequest
 * @property {string} timeOfDay - A TIME_OF_DAY_PRESETS key, or `'keep'` when the row is off.
 * @property {string} sky - A SKY_PRESETS key, or `'keep'` when the row is off.
 * @property {boolean} removeVehicles - Clear parked cars, vans, trailers and bikes.
 * @property {boolean} removeClutter - Clear bins, hoses, toys, tools and signage.
 * @property {boolean} removePeople - Clear people, their pets, and photographer reflections.
 * @property {boolean} removeSnow - Clear lying snow and ice, keeping the season otherwise.
 * @property {boolean} removeWetWeather - Dry off rain, puddles and wet surfaces.
 * @property {boolean} removeLeaves - Clear fallen leaves and garden debris, keeping the season otherwise.
 * @property {string} additionalPrompt - The free-text box, unclamped here; the server clamps.
 */

/**
 * Wire up the opt-in rows and report when the selection changes.
 *
 * @param {{ root: HTMLElement, onChange?: (() => void) | null }} deps - The container holding the rows, and a callback fired whenever the request changes.
 * @returns {{ read: () => ExteriorRequest, hasRequest: () => boolean }} Readers for the current request.
 */
export function createControls({ root, onChange = null }) {
  const $ = (/** @type {string} */ id) => /** @type {any} */ (root.querySelector(`#${id}`));

  const useTime = $('ex-use-time');
  const useSky = $('ex-use-sky');
  const time = $('ex-time');
  const sky = $('ex-sky');
  const notes = $('ex-notes');

  /**
   * The removal rows: element id → the field name the handler reads.
   *
   * One list rather than a const per row, because every one of these has to appear in
   * three places that never meet — here, the FormData in enhance.js, and hasRequest()
   * below — and the row that gets missed is always the third. `read()` builds its flags
   * from this, `hasRequest()` scans them, and
   * test/frontend/exterior-studio/controls.test.js pins the list against the checkbox
   * names in the real markup, so a row added to the page and forgotten here fails the
   * build instead of shipping a tickbox that quietly does nothing.
   * @type {Record<string, string>}
   */
  const REMOVAL_IDS = {
    'ex-vehicles': 'removeVehicles',
    'ex-clutter': 'removeClutter',
    'ex-people': 'removePeople',
    'ex-snow': 'removeSnow',
    'ex-wet': 'removeWetWeather',
    'ex-leaves': 'removeLeaves',
  };

  /** @type {Array<[string, any]>} Field name → its checkbox, resolved once. */
  const removals = Object.entries(REMOVAL_IDS).map(([id, name]) => [name, $(id)]);

  /**
   * Show or hide a row's sub-control to match its checkbox.
   *
   * Driven off `data-ex-reveals` rather than a hardcoded pair list, so a third revealing
   * row is markup only. Idempotent — it is called on every change and on first paint.
   * @returns {void}
   */
  function syncReveals() {
    for (const box of root.querySelectorAll('[data-ex-reveals]')) {
      const body = root.querySelector(`#${box.getAttribute('data-ex-reveals')}`);
      if (body) /** @type {HTMLElement} */ (body).hidden = !(/** @type {HTMLInputElement} */ (box).checked);
    }
  }

  /**
   * The request as the server wants it.
   *
   * An unticked preset resolves to 'keep' — the toggle is the only place "don't change
   * this" is expressed, so the select's current value is ignored entirely when its row is
   * off. Reading the select regardless would send `goldenHour` for a row the user
   * deliberately left alone.
   * @returns {ExteriorRequest} The request.
   */
  function read() {
    /** @type {any} */
    const request = {
      timeOfDay: useTime?.checked ? (time?.value || KEEP) : KEEP,
      sky: useSky?.checked ? (sky?.value || KEEP) : KEEP,
      additionalPrompt: notes?.value || '',
    };
    for (const [name, box] of removals) request[name] = !!box?.checked;
    return request;
  }

  /**
   * Has the visitor actually asked for anything?
   *
   * Gates the submit button. Without it, a request with nothing selected falls through to
   * the server's generic correction pass — which is a real render, really billed, for an
   * edit nobody asked for and probably will not notice.
   * @returns {boolean} True when at least one change is requested.
   */
  function hasRequest() {
    const r = read();
    return r.timeOfDay !== KEEP
      || r.sky !== KEEP
      || removals.some(([, box]) => !!box?.checked)
      || r.additionalPrompt.trim().length > 0;
  }

  root.addEventListener('change', () => { syncReveals(); if (onChange) onChange(); });
  // `change` on a textarea only fires on blur, so the submit button would stay disabled
  // while someone typed the only thing they wanted.
  notes?.addEventListener('input', () => { if (onChange) onChange(); });

  syncReveals();
  return { read, hasRequest };
}
