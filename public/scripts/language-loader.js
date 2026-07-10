// Language loader — the site-wide i18n runtime. Fetches languages/<lang>.json,
// applies it to [data-lang] / [data-lang-html] / [data-lang-attr] nodes, keeps the
// <title> and JSON-LD structured data in sync, and re-applies to nodes injected
// later via a MutationObserver. Exposes window.LanguageSystem for the rest of the
// app (carousel, mask editors, etc.). Classic <script defer>, runs on every page.

(() => {
  'use strict';

  const config = {
    defaultLanguage: 'english',
    languagePath: 'languages/',
    fallbackText: 'Loading...',
  };

  let translations = null;
  let loaded = false;

  async function loadLanguage(lang = config.defaultLanguage) {
    try {
      const res = await fetch(`${config.languagePath}${lang}.json`);
      if (!res.ok) throw Error(`Failed to load language file: ${res.status}`);
      translations = await res.json();
      loaded = true;
      return translations;
    } catch (err) {
      console.error('Error loading language:', err);
      // Minimal built-in fallback so the page is never left showing raw keys.
      return {
        meta: { title: 'Stagify.ai', description: 'AI Home Staging Tool' },
        navigation: { home: 'Home', whyUs: 'Why Us?', faq: 'FAQ', contactUs: 'Contact Us' },
        hero: { catchphrase: 'Upload. Stage. Imagine.' },
        errors: { processingFailed: 'Processing failed' },
      };
    }
  }

  // Resolve a dot-path key (e.g. "hero.catchphrase") against the loaded
  // translations, returning `fallback` if any segment is missing.
  function getText(key, fallback = config.fallbackText) {
    if (!translations) return fallback;
    const parts = key.split('.');
    let current = translations;
    for (const part of parts) {
      if (!current || typeof current !== 'object' || !(part in current)) return fallback;
      current = current[part];
    }
    return current !== undefined ? current : fallback;
  }

  function applyLanguageToElements() {
    if (!loaded) return;

    // Text content (or placeholder for text inputs / textareas).
    document.querySelectorAll('[data-lang]').forEach((el) => {
      const value = getText(el.getAttribute('data-lang'));
      if (value !== config.fallbackText) {
        if (el.tagName === 'INPUT' && /** @type {HTMLInputElement} */ (el).type === 'text')
          /** @type {HTMLInputElement} */ (el).placeholder = value;
        else if (el.tagName === 'TEXTAREA') /** @type {HTMLTextAreaElement} */ (el).placeholder = value;
        else el.textContent = value;
      }
    });

    // Raw HTML content.
    document.querySelectorAll('[data-lang-html]').forEach((el) => {
      const value = getText(el.getAttribute('data-lang-html'));
      if (value !== config.fallbackText) el.innerHTML = value;
    });

    // Attribute values, encoded as "key|attribute".
    document.querySelectorAll('[data-lang-attr]').forEach((el) => {
      const [key, attr] = el.getAttribute('data-lang-attr').split('|');
      const value = getText(key);
      if (value !== config.fallbackText) el.setAttribute(attr, value);
    });

    updateTitle();
    updateStructuredData();
    document.body.classList.add('language-loaded');
    window.dispatchEvent(new Event('languagechange'));
  }

  function updateTitle() {
    if (!loaded) return;
    const titleEl = document.querySelector('title[data-lang]');
    if (titleEl) {
      const value = getText(titleEl.getAttribute('data-lang'));
      if (value !== config.fallbackText) document.title = value;
    }
  }

  function updateStructuredData() {
    if (!loaded) return;
    const ldEl = document.querySelector('script[type="application/ld+json"]');
    if (!ldEl) return;
    try {
      const data = JSON.parse(ldEl.textContent);
      const titleEl = document.querySelector('title[data-lang]');
      const descEl = document.querySelector('meta[name="description"][data-lang-attr]');
      const name = getText(titleEl ? titleEl.getAttribute('data-lang') : 'meta.title');
      const description = getText(
        descEl ? descEl.getAttribute('data-lang-attr').split('|')[0] : 'meta.description'
      );
      const keywords = getText('meta.keywords');
      if (name !== config.fallbackText) data.name = name;
      if (description !== config.fallbackText) data.description = description;
      if (keywords !== config.fallbackText) data.keywords = keywords;
      ldEl.textContent = JSON.stringify(data);
    } catch (err) {
      console.error('Error updating structured data:', err);
    }
  }

  async function init() {
    const saved = localStorage.getItem('selectedLanguage') || config.defaultLanguage;
    await loadLanguage(saved);
    applyLanguageToElements();
    setupLanguageSelector();

    // Re-apply translations to nodes added to the DOM after initial load.
    const observer = new MutationObserver((mutations) => {
      let needsApply = false;
      mutations.forEach((mutation) => {
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            const el = /** @type {Element} */ (node);
            if (
              el.hasAttribute &&
              (el.hasAttribute('data-lang') ||
                el.hasAttribute('data-lang-html') ||
                el.hasAttribute('data-lang-attr'))
            ) {
              needsApply = true;
            }
            if (el.querySelectorAll) {
              const found = el.querySelectorAll('[data-lang], [data-lang-html], [data-lang-attr]');
              if (found.length > 0) needsApply = true;
            }
          });
        }
      });
      if (needsApply) applyLanguageToElements();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function setupLanguageSelector() {
    const select = /** @type {HTMLSelectElement | null} */ (document.getElementById('language-select'));
    if (!select) return;
    const current = localStorage.getItem('selectedLanguage') || 'english';
    select.value = current;
    updateSelectorFlag(select);
    select.addEventListener('change', async (e) => {
      const lang = /** @type {HTMLSelectElement} */ (e.target).value;
      localStorage.setItem('selectedLanguage', lang);
      updateSelectorFlag(/** @type {HTMLSelectElement} */ (e.target));
      await loadLanguage(lang);
      applyLanguageToElements();
    });
  }

  // The selector shows a flag icon via a language-specific class.
  function updateSelectorFlag(select) {
    select.classList.remove('spanish', 'chinese', 'korean');
    if (select.value === 'spanish') select.classList.add('spanish');
    else if (select.value === 'chinese') select.classList.add('chinese');
    else if (select.value === 'korean') select.classList.add('korean');
  }

  window.LanguageSystem = {
    loadLanguage,
    getText,
    applyLanguageToElements,
    isLoaded: () => loaded,
    getCurrentLanguage: () => translations,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

// Loaded as <script type="module"> on every page; this empty export marks the file
// as an ES module so it is covered by `eslint .` (see eslint.config.js). The IIFE
// above still assigns window.LanguageSystem, so all consumers are unaffected.
export {};
