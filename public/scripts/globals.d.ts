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
    /** Opens the home page's staging screen. Published by app/staging-entry.js
     *  and called by the top-nav Staging dropdown when already on the home page;
     *  absent on every other page, which is how the dropdown knows to navigate. */
    __stagifyOpenStaging?: () => void;
    /** Same, for the standalone Basic Mask editor. */
    __stagifyOpenBasicMask?: () => void;
    /** Closes the fullscreen image modal (ai-designer image viewer). */
    closeImageModal?: (...args: any[]) => void;
    /** Returns the live AI Designer chat transcript (ai-designer-app.js), for the
     *  bug-report form in the classic ai-designer-model-selector.js. */
    getConversationHistory?: () => any[];
    /** Strips image bytes out of that transcript before it is posted
     *  (scripts/bug-report-history.js), bridged by ai-designer-app.js for the same
     *  classic form. Without it the report 413s on the 1MB JSON body limit. */
    summariseBugReportHistory?: (history: any) => any[];
    /** Toast notifier (scripts/toast.js), bridged for the bug-report form in the
     *  classic ai-designer-model-selector.js — without it that form gave no
     *  feedback at all, on success or on a missing description. */
    showToast?: (message: string, type?: string) => void;
    /** AI Designer string lookup (ai-designer/i18n.js), bridged for the same form. */
    lang?: (key: string, fallback?: string) => string;
    /** Re-localises the mask-editor dialog (ai-designer/mask-editor-i18n.js).
     *  Bridged because the classic script calls it from the language observer,
     *  which runs on EVERY page load. */
    updateMaskEditorTranslations?: () => void;
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

