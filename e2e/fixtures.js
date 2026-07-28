// Shared helpers for the studio e2e smoke tests. Not a spec (no .spec suffix), so
// Playwright imports it but never runs it as a test.
import { expect } from '@playwright/test';
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

// The Google Ads tag (public/scripts/gtag.js) sits in the <head> of every public
// page — both studios and the home page. In tests we abort its outbound requests
// so the suite stays hermetic and deterministic (the whole point of this e2e
// setup): no real gtag.js/googleadservices/doubleclick fetches, no ad beacons, no
// dependence on external network reachability. Blocking the googletagmanager entry
// point alone would suffice (the library is what pulls the rest), but the ad hosts
// are listed too so a stray direct call can't slip out either. An aborted request
// logs a "Failed to load resource" console message, which index.spec already
// ignores. Called by seedProSession (studios) and directly by index.spec (home).
export async function stubAnalytics(page) {
  await page.route(/googletagmanager\.com|googleadservices\.com|doubleclick\.net/, (route) =>
    route.abort(),
  );
}

// The staging banner (mounted client-side from /api/auth/config when the server runs
// with IS_STAGING) is a max-z-index sticky bar that overlays the page and intercepts
// pointer events. Neutralise it regardless of the server's env so clicks and the
// mask-paint drag reach what they aim at.
export async function hideStagingBanner(page) {
  await page.addInitScript(() => {
    try {
      const s = document.createElement('style');
      s.textContent = '#stagify-staging-banner{display:none !important}';
      document.documentElement.appendChild(s);
    } catch { /* ignore */ }
  });
}

// Seed the render-blocking auth gate (a token must be in localStorage at first paint)
// and mock GET /api/auth/me → Pro, so neither studio redirects to the upsell page.
export async function seedProSession(page, { msHelpSeen = false } = {}) {
  await stubAnalytics(page);
  await hideStagingBanner(page);

  await page.addInitScript((flags) => {
    try {
      localStorage.setItem('stagifyAuthToken', 'e2e-token');
      if (flags.msHelpSeen) localStorage.setItem('msHelpSeen', '1'); // suppress first-visit help dialog
    } catch { /* ignore private-mode storage errors */ }
  }, { msHelpSeen });

  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PRO_ME) }),
  );
}

/**
 * Wait until `scripts/app.js` has finished evaluating.
 *
 * The home page's upload buttons are wired inside that module body, so a click
 * that lands before it runs is silently a no-op (Playwright does not retry a
 * click that hit nothing). `__stagifyUpdateHeroFreeGensLine` is assigned at the
 * END of the same body — after the button wiring — so it is a readiness signal
 * for "the entry flow is live", not merely "the DOM parsed".
 */
export function waitForHomeReady(page) {
  return page.waitForFunction(() => typeof window.__stagifyUpdateHeroFreeGensLine === 'function');
}

/**
 * Open the stage dialog the way a user does: click the hero upload button.
 *
 * Every spec used to lift `.hidden` off `#stage-modal` by hand, which skipped the
 * one gate that decides whether the dialog may open at all (`openFilePicker()` —
 * signed in → open, signed out → auth modal). Driving the button instead means
 * the specs below cover the real entry point; `stage-signin-entry.spec.js` covers
 * the signed-out half of that same gate.
 *
 * Requires a session (seedProSession) — without one this opens the auth modal.
 */
export async function openStageModalViaUI(page, path = '/index.html') {
  await page.goto(path);
  await waitForHomeReady(page);
  const modal = page.locator('#stage-modal');
  // Pre-condition: it really was closed, so "not hidden" below means the click
  // opened it rather than it having been open all along.
  await expect(modal).toHaveClass(/hidden/);
  await page.locator('#hero-upload').click();
  await expect(modal).not.toHaveClass(/hidden/);
  return modal;
}

/**
 * The signed-out counterpart of seedProSession: no token in localStorage, but every
 * endpoint the auth modal talks to is mocked, so a spec can drive a real sign-in.
 *
 * `/api/auth/config` is stubbed with an empty client id so Google Identity Services
 * is never fetched from accounts.google.com (the suite stays hermetic).
 *
 * @param {import('@playwright/test').Page} page
 * @param {{token?: string, me?: object}} [opts]
 */
export async function stubAnonymousAuth(page, { token = 'e2e-token', me = PRO_ME } = {}) {
  await stubAnalytics(page);
  await hideStagingBanner(page);

  await page.route('**/api/auth/config', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ googleClientId: '', isStaging: false }),
    }),
  );
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(me) }),
  );
  return { token };
}
