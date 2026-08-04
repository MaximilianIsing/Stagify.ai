// Handing a finished render to the Masking Studio — the shared half of "Refine in Masking
// Studio".
//
// Two pages offer the button (the gallery's detail dialog and the staging studio's result
// panel) and a third consumes it (scripts/masking-studio-app.js), so the storage key and
// the payload shape live here rather than three times over. Getting them out of step would
// not throw — the studio would simply find nothing and open on an empty dropzone, which is
// the kind of silent nothing that takes an afternoon to trace.
//
// WHY sessionStorage AND NOT A QUERY PARAMETER
// A `?renderId=` would be shareable, bookmarkable and logged in every referrer — and it
// would survive a reload, so refreshing the studio would silently re-import a render the
// user had moved on from. sessionStorage is scoped to the tab, dies with it, and is read
// exactly once (the studio deletes the key before using it).
//
// WHY THE ID AND NOT THE IMAGE
// The obvious payload is the presigned URL the gallery already has. It cannot be used:
// drawing a cross-origin image onto a canvas taints it, and the studio's every export goes
// through toDataURL, which throws on a tainted canvas. The studio fetches the bytes from
// our own origin instead — see the handoff block in scripts/masking-studio-app.js.

/** The sessionStorage key. One definition, three files. */
export const HANDOFF_KEY = 'stagifyMaskingHandoff';

/**
 * Stage a render for the Masking Studio to pick up on its next load.
 *
 * Does NOT navigate — the caller decides where and how, because the two entry points differ
 * (the gallery is already on a localized path, the staging studio may not be).
 *
 * @param {{ renderId: string, sourceName?: string, storage?: Storage }} arg - `storage` is a
 *   test seam; production always uses sessionStorage.
 * @returns {boolean} False when there was nothing to hand off or storage refused — the
 *   caller should then not navigate, so the user is never dropped on an empty studio
 *   wondering where their photo went.
 */
export function sendToMaskingStudio({ renderId, sourceName = '', storage }) {
  const id = String(renderId || '').trim();
  if (!id) return false;
  try {
    const store = storage || sessionStorage;
    store.setItem(HANDOFF_KEY, JSON.stringify({ renderId: id, sourceName: String(sourceName || '') }));
    return true;
  } catch (e) {
    // Private-browsing modes and a full quota both land here. Refusing to navigate is the
    // honest failure: the button does nothing visible, rather than opening a studio that
    // has lost the photo it was asked to open.
    return false;
  }
}

/**
 * Take delivery of a handoff, if there is one — the studio side.
 *
 * Lives here beside `sendToMaskingStudio` because the two halves share the key and the
 * payload shape, and splitting them is how those drift.
 *
 * THE BYTES COME FROM OUR OWN ORIGIN, and that is not a preference:
 *
 *     drawing a cross-origin image onto a canvas TAINTS it, and toDataURL() on a tainted
 *     canvas throws SecurityError.
 *
 * The Masking Studio calls toDataURL for every mask-edit request and for its photo
 * thumbnail, so a tainted base canvas breaks the entire tool. That is why the payload is a
 * render ID and not the presigned storage URL the gallery already holds — and why this is a
 * `fetch` into a blob URL rather than an `<img src>`, which also could not carry the bearer
 * token. Dev and CI serve blobs same-origin (routes/object-local.js), so the tainted-canvas
 * version of this would have passed every test and failed only in production.
 *
 * @param {{
 *   loadImage: (src: string) => Promise<HTMLImageElement>,
 *   setBaseImage: (img: HTMLImageElement, opts?: any) => void,
 *   authToken: () => string,
 *   onError: () => void,
 *   storage?: Storage,
 *   fetchImpl?: typeof fetch,
 * }} deps - `onError` reports "there was a handoff and it failed", so the caller can say so;
 *   it is NOT called when there was simply nothing to take delivery of.
 * @returns {Promise<boolean>} True when a photo was loaded — the caller then skips its
 *   resume prompt, because the user asked for this render by name.
 */
export async function receiveHandoff({ loadImage, setBaseImage, authToken, onError, storage, fetchImpl }) {
  const doFetch = fetchImpl || ((...args) => fetch(...args));
  let raw;
  try {
    const store = storage || sessionStorage;
    raw = store.getItem(HANDOFF_KEY);
    // Read ONCE. A reload must land on the empty dropzone rather than silently re-importing
    // a render the user has since moved on from.
    store.removeItem(HANDOFF_KEY);
  } catch (e) { return false; }
  if (!raw) return false;

  let renderId;
  let sourceName;
  try {
    const parsed = JSON.parse(raw);
    renderId = String(parsed.renderId || '');
    sourceName = String(parsed.sourceName || '');
  } catch (e) { return false; }
  if (!renderId) return false;

  try {
    const token = authToken();
    const res = await doFetch(`/api/gallery/${encodeURIComponent(renderId)}/source`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res || !res.ok) throw new Error('handoff');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImage(url);
      // The id is what makes the studio's "Looks Good" REPLACE this render rather than add
      // a second entry for the same photo.
      setBaseImage(img, { sourceRenderId: renderId, sourceName });
    } finally {
      URL.revokeObjectURL(url);
    }
    return true;
  } catch (e) {
    // Falling through to the dropzone is the studio's normal empty state, so the worst case
    // is that the user picks the file themselves.
    onError();
    return false;
  }
}
