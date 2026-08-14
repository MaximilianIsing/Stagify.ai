// i18n helpers for the AI Designer chat UI (plain exports, not a factory).
//
// Thin wrappers over the classic window.LanguageSystem loader, lifted verbatim
// from the entry (scripts/ai-designer-app.js). `lang` guards its access with
// try/catch; `getPdfAlt` reads window.LanguageSystem bare, so node tests must
// shim globalThis.window first (see test/frontend/ai-designer/ai-designer-i18n.test.js).

      // Small translation helper with a safe fallback: getText() returns undefined
      // for a key that isn't in the language files yet, so we use the English one.
      // It used to return the string 'Loading...' and this checked for that, plus for
      // the key itself — neither of which getText can produce any more, and both of
      // which would have discarded a real translation that happened to equal them.
      export function lang(key, fallback) {
        try {
          if (window.LanguageSystem && window.LanguageSystem.isLoaded && window.LanguageSystem.isLoaded()) {
            const v = window.LanguageSystem.getText(key);
            if (v) return v;
          }
        } catch (e) {}
        return fallback;
      }

      /**
       * The language the "Virtually staged" badge is rendered in, when the Designer
       * decides a render should carry one.
       *
       * Sent on every turn as plain request context, NOT as a control — this page
       * deliberately has no disclosure UI, because the request is already in words. It
       * rides the request rather than the routing decision for the same reason as on the
       * four checkbox surfaces: the badge follows the SITE language, which is the
       * browser's to know and not something the model should be picking. The server
       * validates it against the real locale list and falls back to English, so an unset
       * value is safe. Reads the same key the shared stamp option does.
       * @returns {string} The current site language name.
       */
      export function stampLang() {
        return localStorage.getItem('selectedLanguage') || 'english';
      }

      export function getPdfAlt(key, replacements = {}) {
        let text = (window.LanguageSystem && window.LanguageSystem.isLoaded())
          ? window.LanguageSystem.getText('pdf.alt.' + key)
          : '';
        if (!text) {
          const fallbacks = {
            uploadFile: 'Attach a file to your message',
            reloadChat: 'Start a new chat conversation',
            sendMessage: 'Send message',
            reportBug: 'Report a bug',
            userAvatar: 'Your avatar',
            assistantAvatar: 'Stagify AI Designer',
            uploadPreview: 'Preview of uploaded file: {filename}',
            stagedRoom: 'AI-staged room{suffix}',
            generatedImage: 'AI-generated design image{suffix}',
            cadRender: '3D render from floor plan{suffix}',
            recalledImage: 'Previously shared image from this conversation',
            requestedImage: 'Image requested from conversation history',
            editedImage: 'Mask-edited design image{suffix}',
            originalCarouselImage: 'Original image before mask edits',
            enlargedImage: 'Full-size view of design image',
            thumbnailSelected: '{label}, selected as base image for your next message',
            thumbnailOption: '{label}, image {index} in conversation',
          };
          text = fallbacks[key] || '';
        }
        Object.entries(replacements).forEach(([k, v]) => {
          text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), v == null ? '' : String(v));
        });
        return text;
      }
