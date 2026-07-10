// Ambient declarations for the browser globals that the classic (non-module)
// `public/scripts/*.js` files hang off `window`. The ES-module frontend reads
// them but never imports them (there is no build step / bundler), so to the
// type-checker they are untyped `Window` properties → a flood of TS2339. Declare
// them here once so the module files can reference them cleanly.
//
// Types are deliberately loose (mostly `any`) — this mirrors the backend's
// "loose for the initial rollout" stance in tsconfig.json. Tighten a member the
// day its provider script is itself typed.
//
// This file is type-check input only; it is never shipped to the browser.

export {}; // make this a module so `declare global` augments rather than replaces

declare global {
  interface Window {
    /** Auth helper surface installed by auth.js. */
    StagifyAuth?: any;
    /** HEIC→JPEG conversion helper installed by heic-convert.js. */
    StagifyHeic?: any;
    /** Profile-menu controller installed by profile-menu.js. */
    StagifyProfileMenu?: any;
    /** Hero free-generation stats controller installed by app/hero-stats.js. */
    StagifyHeroStats?: any;
    /** Returns the API name of the currently selected model (ai-designer-model-selector.js). */
    getSelectedModelApiName?: () => string;
    /** Refreshes the hero "free generations left" line (app/hero-stats.js). */
    __stagifyUpdateHeroFreeGensLine?: (...args: any[]) => void;
    /** Opens the auth modal in the staging flow (app.js). */
    __stagifyOpenAuthForStaging?: (...args: any[]) => void;
    /** Closes the fullscreen image modal (ai-designer image viewer). */
    closeImageModal?: (...args: any[]) => void;
    /** Home hero text-animation controller installed by home-text-animate.js. */
    HomeTextAnimate?: any;

    // ── Cross-page hand-off flags (set on one page, read after auth/redirect) ──
    /** A staging action deferred until the user finishes signing in. */
    __stagifyPendingStaging?: any;
    /** A Stagify Plus redirect deferred until the user finishes signing in. */
    __stagifyPendingPlusRedirect?: any;

    // ── Third-party globals loaded via <script>, with no bundled types ──
    /** heic2any bundle (vendor/heic2any.min.js) — HEIC/HEIF → Blob converter. */
    heic2any?: (options: any) => Promise<Blob | Blob[]>;
    /** Demo walkthrough data injected by demo-data.js. */
    STAGIFY_DEMOS?: any;
  }

  // Declared as ambient `var`s (not just Window members) because the code reads
  // them both as `window.X` AND as bare `X`; a global var satisfies both, while a
  // Window-interface member would only cover `window.X`.
  /** i18n runtime installed by the classic language-loader.js / language scripts. */
  var LanguageSystem: any;
  /** Supademo embedded-player global (third-party <script>). */
  var SupademoPlayer: any;
  /** Google Identity Services — `google.accounts.id …` (third-party <script>). */
  var google: any;
}

