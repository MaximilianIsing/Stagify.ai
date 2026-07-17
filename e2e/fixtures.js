// Shared helpers for the studio e2e smoke tests. Not a spec (no .spec suffix), so
// Playwright imports it but never runs it as a test.
import sharp from 'sharp';

// The /api/auth/me payload for a signed-in Pro user — shape from
// lib/data/auth-store.js publicUser(). plan:'pro' is mandatory or both studios redirect.
export const PRO_ME = {
  user: {
    id: 'u_e2e',
    email: 'e2e@example.com',
    plan: 'pro',
    dailyGenerationsUsed: 0,
    dailyGenerationLimit: null,
    canManageSubscription: false,
  },
};

// A genuinely-decodable 1x1 PNG data URL. The masking client calls loadImage() on the
// mocked editedImage and the AI-designer renders it as an <img src>, so it must decode.
export const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// A real solid-colour room PNG for the file upload (sharp runs in the Node test process).
export function roomPngBuffer(w = 480, h = 320) {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 205, g: 193, b: 176 } } })
    .png()
    .toBuffer();
}

// A canned "AI output" that matches the room colour everywhere EXCEPT a dark
// object block that overlaps the painted mask and overhangs it to the right —
// exactly the "the edit spilled past the highlight" case the refine step's
// Snap-to-object detector looks for. Returned as a data URL (the client calls
// loadImage() on the mocked editedImage). Same dimensions as roomPngBuffer so
// it maps 1:1 onto the studio's working canvas.
export async function spilloverEditedDataUrl() {
  const W = 480, H = 320;
  const object = await sharp({
    create: { width: 150, height: 70, channels: 3, background: { r: 35, g: 35, b: 40 } },
  }).png().toBuffer();
  const buf = await sharp({
    create: { width: W, height: H, channels: 3, background: { r: 205, g: 193, b: 176 } },
  }).composite([{ input: object, left: 215, top: 150 }]).png().toBuffer();
  return 'data:image/png;base64,' + buf.toString('base64');
}

// Seed the render-blocking auth gate (a token must be in localStorage at first paint)
// and mock GET /api/auth/me → Pro, so neither studio redirects to the upsell page.
export async function seedProSession(page, { msHelpSeen = false } = {}) {
  await page.addInitScript((flags) => {
    try {
      localStorage.setItem('stagifyAuthToken', 'e2e-token');
      if (flags.msHelpSeen) localStorage.setItem('msHelpSeen', '1'); // suppress first-visit help dialog
    } catch { /* ignore private-mode storage errors */ }
    // The staging banner (mounted client-side from /api/auth/config when the server
    // runs with IS_STAGING) is a max-z-index sticky bar that overlays the studio and
    // intercepts pointer events. Neutralise it regardless of the server's env so the
    // mask-paint drag reaches #ms-stack.
    try {
      const s = document.createElement('style');
      s.textContent = '#stagify-staging-banner{display:none !important}';
      document.documentElement.appendChild(s);
    } catch { /* ignore */ }
  }, { msHelpSeen });

  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PRO_ME) }),
  );
}
