// "Label as virtually staged" for the surfaces that composite in the BROWSER.
//
// WHY THESE SURFACES NEED THEIR OWN PATH TO THE BADGE
// The staging tool posts its photo and the server stamps the render before it comes back —
// one flag on the multipart body, and the same call covers the response, the download and
// the gallery master. Basic Mask and the Masking Studio cannot do that: both composite
// their result on a canvas in the browser, so the finished pixels exist nowhere else. The
// stamp is server-only (sharp plus pre-rendered badge masters, lib/image/stamp-disclosure.js),
// so a browser-built image has to make a trip to /api/stamp-image before it can be saved.
//
// It cannot be folded into /api/mask-edit either: that route returns the model's edit, which
// the client then composites back over the untouched original everywhere outside the painted
// mask — a badge stamped there is erased by the very next step.
//
// ONE INSTANCE PER SURFACE. Both studios live on their own page, but the Basic Mask dialog
// shares index.html with the staging modal's copy of these same controls, so every read is
// scoped to the container it was built with. An unscoped read hands one surface the style
// the user picked on the other, silently.
//
// NO CLICK-AWAY, AND NO ESCAPE-TO-DISMISS, on any surface. Both were built while the Basic
// Mask options were a floating panel, and pulled: the checkbox IS the option, so a dismissal
// routed through it turns the badge OFF — clicking Download with the panel open unticked the
// box and saved the photo unlabelled, with nothing on screen saying so. A dismissal that does
// NOT go through the checkbox is the other half of the trap: it leaves the option on with its
// controls hidden, which the user can neither see nor undo. The options are now an ordinary
// in-flow strip on both surfaces, so there is nothing to dismiss — they are simply visible
// while the option is on, and initStampStyleRow() owns that.
import { readStampOptions } from '../app/stamp-style-row.js';

/** Mime → file extension, for naming a download after whatever we actually got back. */
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/**
 * Read the extension a data URL's bytes deserve.
 *
 * The stamp always returns PNG, while the Masking Studio composites JPEG — so whether a
 * download is `.jpg` or `.png` depends on whether the badge was applied. Naming the file
 * after the bytes rather than after the surface is what keeps those in step.
 * @param {string} dataUrl - Any `data:<mime>;base64,…` URL.
 * @returns {string} A bare extension, defaulting to png.
 */
function extensionFor(dataUrl) {
  const mime = /^data:([^;]+)/.exec(String(dataUrl || ''))?.[1];
  return EXT[mime] || 'png';
}

/**
 * Bind the disclosure option to one surface's markup.
 *
 * @param {{ checkboxId: string, optsId: string }} ids - The checkbox that switches the badge
 *   on, and the `.stamp-opts` container holding the style swatches and size slider. Both are
 *   looked up per call rather than captured, so this may be built before the DOM they name.
 * @returns {{
 *   requested: () => boolean,
 *   badgeFields: () => { labelVirtuallyStaged: boolean, stampLang: string, stampStyle: string, stampScale: number },
 *   stampIfRequested: (dataUrl: string) => Promise<string>,
 *   downloadWithLabel: (dataUrl: string, basename: string) => Promise<void>,
 * }} The surface's stamp controls.
 */
export function createStampOption({ checkboxId, optsId }) {
  const checkbox = () => /** @type {HTMLInputElement | null} */ (document.getElementById(checkboxId));
  const panel = () => document.getElementById(optsId);

  /**
   * Has the user asked for the badge?
   * @returns {boolean} True when this surface's checkbox is ticked.
   */
  function requested() {
    return Boolean(checkbox()?.checked);
  }

  /**
   * The user's badge choice, in the shape the SERVER's own validators expect.
   *
   * Exists for the callers that hand their image to an endpoint which is already holding
   * the bytes — the Masking Studio's gallery save posts its composite anyway, so stamping
   * it there costs nothing, while routing it through /api/stamp-image would upload a
   * megabyte twice. Field names match /api/process-image's multipart fields so the server
   * side reads the same way wherever the badge is applied.
   * @returns {{ labelVirtuallyStaged: boolean, stampLang: string, stampStyle: string, stampScale: number }} Request fields.
   */
  function badgeFields() {
    const { style, scale } = readStampOptions(panel());
    return {
      labelVirtuallyStaged: requested(),
      // Which pre-rendered badge master to composite. Server-validated against
      // lib/i18n/locales.js with an English fallback, so a stale value is harmless.
      stampLang: localStorage.getItem('selectedLanguage') || 'english',
      stampStyle: style,
      stampScale: scale,
    };
  }

  /**
   * Return `dataUrl` with the disclosure badge burned in, or unchanged if the option is off.
   *
   * FAILS CLOSED, like every other path to this badge: any refusal from the server throws
   * rather than resolving to the unstamped image. The caller is about to write a file the
   * user believes carries a disclosure, and handing them one that does not is the exact
   * exposure the feature exists to prevent (lib/image/stamp-disclosure.js, at length).
   * @param {string} dataUrl - A finished composite, as a base64 image data URL.
   * @returns {Promise<string>} The image to save.
   * @throws {Error} When the option is on and the badge could not be applied.
   */
  async function stampIfRequested(dataUrl) {
    if (!requested()) return dataUrl;

    const fields = badgeFields();
    // Through StagifyAuth, exactly as scripts/mask/generate.js does for /api/mask-edit —
    // the same pro gate, and the token's storage is that module's business, not this one's.
    const token = window.StagifyAuth && window.StagifyAuth.getToken();
    const res = await fetch('/api/stamp-image', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      body: JSON.stringify({
        image: dataUrl,
        authToken: token || undefined,
        lang: fields.stampLang,
        style: fields.stampStyle,
        scale: fields.stampScale,
      }),
    });

    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.image) {
      // Prefer the server's sentence: the DISCLOSURE_STAMP_FAILED branch names the option
      // to untick, which is the only action that gets the user their file. A generic retry
      // message would send them back into the same wall.
      throw new Error(data?.error || 'Could not add the label to that image.');
    }
    return data.image;
  }

  /**
   * Save a finished composite to disk, with the badge on it if the option is ticked.
   *
   * The stamping and the anchor click are one function on purpose: they are a single
   * operation with a single failure mode, and splitting them is how a caller ends up with a
   * `catch` that still runs the download. Throws instead of saving anything when the badge
   * could not be applied.
   * @param {string} dataUrl - The finished composite.
   * @param {string} basename - Filename WITHOUT an extension; the bytes decide that.
   * @returns {Promise<void>} Resolves once the download has been triggered.
   */
  async function downloadWithLabel(dataUrl, basename) {
    const url = await stampIfRequested(dataUrl);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${basename}.${extensionFor(url)}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  return { requested, badgeFields, stampIfRequested, downloadWithLabel };
}
