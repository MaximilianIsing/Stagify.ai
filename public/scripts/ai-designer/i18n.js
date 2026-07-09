// i18n helpers for the AI Designer chat UI (plain exports, not a factory).
//
// Thin wrappers over the classic window.LanguageSystem loader, lifted verbatim
// from the entry (scripts/ai-designer-app.js). `lang` guards its access with
// try/catch; `getPdfAlt` reads window.LanguageSystem bare, so node tests must
// shim globalThis.window first (see test/ai-designer-i18n.test.js).

      // Small translation helper with a safe fallback. getText() returns the
      // placeholder "Loading..." (or echoes the key) for keys that aren't in the
      // language files yet, so we ignore those and use the English fallback.
      export function lang(key, fallback) {
        try {
          if (window.LanguageSystem && window.LanguageSystem.isLoaded && window.LanguageSystem.isLoaded()) {
            const v = window.LanguageSystem.getText(key);
            if (v && v !== key && v !== 'Loading...') return v;
          }
        } catch (e) {}
        return fallback;
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
            thumbnailSelected: '{label} — selected as base image for your next message',
            thumbnailOption: '{label} — image {index} in conversation',
          };
          text = fallbacks[key] || '';
        }
        Object.entries(replacements).forEach(([k, v]) => {
          text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), v == null ? '' : String(v));
        });
        return text;
      }
