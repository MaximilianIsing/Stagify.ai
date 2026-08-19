// Language loader — the site-wide i18n runtime. Fetches languages/<lang>.json,
// applies it to [data-lang] / [data-lang-html] / [data-lang-attr] nodes, keeps the
// <title> and JSON-LD structured data in sync, and re-applies to nodes injected
// later via a MutationObserver. Exposes window.LanguageSystem for the rest of the
// app (carousel, mask editors, etc.). Loaded as <script type="module">, runs on every page.

import { urlLanguage, hrefForLanguage, localizeLinks } from './i18n-routing.js';
import { LANGUAGES } from './locale-data.js';

(() => {
  'use strict';

  const config = {
    defaultLanguage: 'english',
    languagePath: 'languages/',
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
        navigation: { home: 'Home', whyUs: 'Why Us?', faq: 'FAQ', contactUs: 'Contact' },
        hero: { eyebrow: 'Free virtual staging' },
        errors: { processingFailed: 'Processing failed' },
      };
    }
  }

  // Resolve a dot-path key (e.g. "hero.catchphrase") against the loaded
  // translations, returning `fallback` if the pack has not loaded yet or any
  // segment of the path is missing.
  //
  // A miss is `undefined` — a value no JSON pack can hold — and NOT a sentinel
  // string. This used to return the literal 'Loading...', which six call sites
  // then compared against to detect a miss, and that cost twice over:
  //
  //   1. It reserved a translation. Any string whose real text was "Loading..."
  //      would have been thrown away as a miss. (No pack contains one today, so
  //      this half was latent.)
  //   2. It broke every `getText(key) || 'English default'` call — about twenty of
  //      them. The sentinel is truthy, so `||` never fired and the page rendered
  //      the literal "Loading..." instead of the default. That happened on any
  //      missing key, and to *every* key during the window before the pack loads.
  //
  // Callers that want a specific miss value still pass one; `undefined` only
  // applies when they don't.
  function getText(key, fallback = undefined) {
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
      if (value !== undefined) {
        if (el.tagName === 'INPUT' && /** @type {HTMLInputElement} */ (el).type === 'text')
          /** @type {HTMLInputElement} */ (el).placeholder = value;
        else if (el.tagName === 'TEXTAREA') /** @type {HTMLTextAreaElement} */ (el).placeholder = value;
        else el.textContent = value;
      }
    });

    // Raw HTML content.
    document.querySelectorAll('[data-lang-html]').forEach((el) => {
      const value = getText(el.getAttribute('data-lang-html'));
      if (value !== undefined) el.innerHTML = value;
    });

    // Attribute values, encoded as "key|attribute".
    document.querySelectorAll('[data-lang-attr]').forEach((el) => {
      const [key, attr] = el.getAttribute('data-lang-attr').split('|');
      const value = getText(key);
      if (value !== undefined) el.setAttribute(attr, value);
    });

    updateTitle();
    updateStructuredData();
    // Applying [data-lang-html] resets any links inside translated rich text to
    // their raw JSON form (bare "#…" anchors, "terms.html", …). On a localized URL
    // that would break under <base href="/">, so re-prefix them to this locale.
    localizeLinks();
    document.body.classList.add('language-loaded');
    window.dispatchEvent(new Event('languagechange'));
  }

  function updateTitle() {
    if (!loaded) return;
    const titleEl = document.querySelector('title[data-lang]');
    if (titleEl) {
      const value = getText(titleEl.getAttribute('data-lang'));
      if (value !== undefined) document.title = value;
    }
  }

  function updateStructuredData() {
    if (!loaded) return;
    // The block the page marked as describing itself. Mirrors applyStructuredData() in
    // lib/i18n/render-page.js: this used to be the FIRST ld+json block, which on
    // guides/enterprise/stagify-plus is the breadcrumb trail — so a language switch
    // localized the trail (which has no name or description of its own) and left the
    // block describing the page in English. Unmarked pages are left alone.
    const ldEl = document.querySelector('script[type="application/ld+json"][data-lang-jsonld]');
    if (!ldEl) return;
    try {
      const data = JSON.parse(ldEl.textContent);
      const titleEl = document.querySelector('title[data-lang]');
      const descEl = document.querySelector('meta[name="description"][data-lang-attr]');
      const name = getText(titleEl ? titleEl.getAttribute('data-lang') : 'meta.title');
      const description = getText(
        descEl ? descEl.getAttribute('data-lang-attr').split('|')[0] : 'meta.description'
      );
      // Opt-in per page, and it must be the key this page authored: hardcoding
      // 'meta.keywords' here stamped the HOMEPAGE keyword list onto every studio's
      // JSON-LD on a language switch. Mirrors applyStructuredData() in
      // lib/i18n/render-page.js — no fallback, so a block without the attribute
      // keeps its authored keywords.
      const kwKey = ldEl.getAttribute('data-lang-keywords');
      const keywords = kwKey ? getText(kwKey) : undefined;
      if (name !== undefined) data.name = name;
      if (description !== undefined) data.description = description;
      if (keywords !== undefined) data.keywords = keywords;
      ldEl.textContent = JSON.stringify(data);
    } catch (err) {
      console.error('Error updating structured data:', err);
    }
  }

  async function init() {
    // A localized URL (/es, /fr/…) wins over the stored preference, so the page
    // renders in its URL language even if the visitor's saved choice differs.
    const saved = urlLanguage() || localStorage.getItem('selectedLanguage') || config.defaultLanguage;
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
      if (needsApply) {
        applyLanguageToElements();
        // Drain the records our own pass just queued, or this observer feeds itself.
        // Applying [data-lang-html] writes innerHTML, which is a childList mutation on
        // the very subtree being watched — so the moment a translated value contains a
        // data-lang, the check above would see our own output as new work and re-apply
        // forever, hanging the tab. Nothing nests one today (all 9,680 values across the
        // 11 packs were checked), which is the ONLY reason this has never fired; it is
        // not a property a translator can be expected to preserve.
        //
        // takeRecords() empties the queue synchronously, so those records never reach
        // the callback. Preferred over disconnect()/observe() because it cannot leave
        // the observer switched off if the pass throws part-way.
        observer.takeRecords();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function setupLanguageSelector() {
    const select = /** @type {HTMLSelectElement | null} */ (document.getElementById('language-select'));
    if (!select) return;
    const current = localStorage.getItem('selectedLanguage') || 'english';
    select.value = current;
    updateSelectorFlag(select);
    // Each language now has its own URL, so switching navigates to the localized
    // URL of the current page (a full load that the server renders in-language)
    // instead of swapping strings in place. This keeps the URL, canonical, and
    // hreflang consistent with what the visitor sees.
    //
    // EXCEPT on a page that has no localized URL. hrefForLanguage() sends those to the
    // locale HOME (i18n-routing.js:59), which is right for a link but wrong for a
    // switcher: the visitor asked to read THIS page in another language and would be
    // silently moved off it. Such a page opts out with [data-lang-inplace] and gets the
    // pack swapped underneath it instead. Two pages do this — the gallery and the API
    // dashboard, both noindex and behind a session; every other page carrying a switcher
    // is in LOCALIZED_PAGES, so none of them change behaviour.
    const inPlace = !!document.querySelector('[data-lang-inplace]');
    select.addEventListener('change', (e) => {
      const lang = /** @type {HTMLSelectElement} */ (e.target).value;
      try { localStorage.setItem('selectedLanguage', lang); } catch (err) { /* ignore */ }
      if (!inPlace) {
        window.location.assign(hrefForLanguage(lang));
        return;
      }
      updateSelectorFlag(select);
      // applyLanguageToElements() fires "languagechange", which is how the custom
      // switcher re-syncs and how a page repaints strings its own JS owns.
      void loadLanguage(lang).then(applyLanguageToElements);
    });
  }

  // The native selector shows its flag icon via a language-specific class. The
  // class list is derived from the generated locale set rather than hard-coded:
  // this used to name only spanish/chinese/korean, so it had already fallen eight
  // languages behind and could not clear a class it did not know about. Languages
  // without a matching CSS rule simply get the default styling, as before.
  const FLAG_CLASSES = LANGUAGES.map((l) => l.lang);
  function updateSelectorFlag(select) {
    select.classList.remove(...FLAG_CLASSES);
    if (FLAG_CLASSES.includes(select.value)) select.classList.add(select.value);
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
