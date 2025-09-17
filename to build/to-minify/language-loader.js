(() => {
    'use strict';
    
    // Language system configuration
    const LANGUAGE_CONFIG = {
      defaultLanguage: 'english',
      languagePath: 'languages/',
      fallbackText: 'Loading...'
    };
    
    // Global language data storage
    let currentLanguageData = null;
    let isLanguageLoaded = false;
    
    // Language loading functions
    async function loadLanguage(languageCode = LANGUAGE_CONFIG.defaultLanguage) {
      try {
        const response = await fetch(`${LANGUAGE_CONFIG.languagePath}${languageCode}.json`);
        if (!response.ok) {
          throw new Error(`Failed to load language file: ${response.status}`);
        }
        currentLanguageData = await response.json();
        isLanguageLoaded = true;
        return currentLanguageData;
      } catch (error) {
        console.error('Error loading language:', error);
        // Return a minimal fallback structure
        return {
          meta: { title: 'Stagify.ai', description: 'AI Home Staging Tool' },
          navigation: { home: 'Home', whyUs: 'Why Us?', faq: 'FAQ', contactUs: 'Contact Us' },
          hero: { catchphrase: 'Upload. Stage. Imagine.' },
          errors: { processingFailed: 'Processing failed' }
        };
      }
    }
    
    // Get text from language data using dot notation path
    function getText(path, fallback = LANGUAGE_CONFIG.fallbackText) {
      if (!currentLanguageData) return fallback;
      
      const keys = path.split('.');
      let current = currentLanguageData;
      
      for (const key of keys) {
        if (current && typeof current === 'object' && key in current) {
          current = current[key];
        } else {
          return fallback;
        }
      }
      
      // Return the value as-is (could be string, array, or object)
      return current !== undefined ? current : fallback;
    }
    
    // Apply text to elements with data-lang attributes
    function applyLanguageToElements() {
      if (!isLanguageLoaded) return;
      
      // Apply to elements with data-lang attribute
      const elements = document.querySelectorAll('[data-lang]');
      elements.forEach(element => {
        const langPath = element.getAttribute('data-lang');
        const text = getText(langPath);
        
        if (text !== LANGUAGE_CONFIG.fallbackText) {
          // Handle different element types
          if (element.tagName === 'INPUT' && element.type === 'text') {
            element.placeholder = text;
          } else if (element.tagName === 'TEXTAREA') {
            element.placeholder = text;
          } else {
            element.textContent = text;
          }
        }
      });
      
      // Apply to elements with data-lang-html attribute (for HTML content)
      const htmlElements = document.querySelectorAll('[data-lang-html]');
      htmlElements.forEach(element => {
        const langPath = element.getAttribute('data-lang-html');
        const text = getText(langPath);
        
        if (text !== LANGUAGE_CONFIG.fallbackText) {
          element.innerHTML = text;
        }
      });
      
      // Apply to elements with data-lang-attr attribute (for setting attributes)
      const attrElements = document.querySelectorAll('[data-lang-attr]');
      attrElements.forEach(element => {
        const config = element.getAttribute('data-lang-attr');
        const [langPath, attribute] = config.split('|');
        const text = getText(langPath);
        
        if (text !== LANGUAGE_CONFIG.fallbackText) {
          element.setAttribute(attribute, text);
        }
      });
      
      // Update page title and meta description
      updatePageMeta();
      
      // Update structured data
      updateStructuredData();
      
      // Add language-loaded class to body to show content
      document.body.classList.add('language-loaded');
    }
    
    // Update page meta information
    function updatePageMeta() {
      if (!isLanguageLoaded) return;
      
      // Update title
      const title = getText('meta.title');
      if (title !== LANGUAGE_CONFIG.fallbackText) {
        document.title = title;
      }
      
      // Update meta description
      const description = getText('meta.description');
      if (description !== LANGUAGE_CONFIG.fallbackText) {
        const metaDesc = document.querySelector('meta[name="description"]');
        if (metaDesc) {
          metaDesc.setAttribute('content', description);
        }
      }
      
      // Update meta keywords
      const keywords = getText('meta.keywords');
      if (keywords !== LANGUAGE_CONFIG.fallbackText) {
        const metaKeywords = document.querySelector('meta[name="keywords"]');
        if (metaKeywords) {
          metaKeywords.setAttribute('content', keywords);
        }
      }
    }
    
    // Update structured data (JSON-LD)
    function updateStructuredData() {
      if (!isLanguageLoaded) return;
      
      const structuredDataScript = document.querySelector('script[type="application/ld+json"]');
      if (structuredDataScript) {
        try {
          const structuredData = JSON.parse(structuredDataScript.textContent);
          
          // Update structured data with language content
          const name = getText('meta.title');
          const description = getText('meta.description');
          const keywords = getText('meta.keywords');
          
          if (name !== LANGUAGE_CONFIG.fallbackText) {
            structuredData.name = name;
          }
          if (description !== LANGUAGE_CONFIG.fallbackText) {
            structuredData.description = description;
          }
          if (keywords !== LANGUAGE_CONFIG.fallbackText) {
            structuredData.keywords = keywords;
          }
          
          structuredDataScript.textContent = JSON.stringify(structuredData);
        } catch (error) {
          console.error('Error updating structured data:', error);
        }
      }
    }
    
    // Initialize language system
    async function initLanguageSystem() {
      // Load saved language preference or default to English
      const savedLanguage = localStorage.getItem('selectedLanguage') || LANGUAGE_CONFIG.defaultLanguage;
      await loadLanguage(savedLanguage);
      
      // Apply language to elements
      applyLanguageToElements();
      
      // Set up language selector
      setupLanguageSelector();
      
      // Set up observer for dynamically added elements
      const observer = new MutationObserver((mutations) => {
        let shouldReapply = false;
        mutations.forEach((mutation) => {
          if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
            mutation.addedNodes.forEach((node) => {
              if (node.nodeType === Node.ELEMENT_NODE) {
                if (node.hasAttribute && (node.hasAttribute('data-lang') || node.hasAttribute('data-lang-html') || node.hasAttribute('data-lang-attr'))) {
                  shouldReapply = true;
                }
                // Check child elements
                if (node.querySelectorAll) {
                  const langElements = node.querySelectorAll('[data-lang], [data-lang-html], [data-lang-attr]');
                  if (langElements.length > 0) {
                    shouldReapply = true;
                  }
                }
              }
            });
          }
        });
        
        if (shouldReapply) {
          applyLanguageToElements();
        }
      });
      
      // Start observing
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    }
    
    // Set up language selector functionality
    function setupLanguageSelector() {
      const languageSelect = document.getElementById('language-select');
      if (!languageSelect) return;
      
      // Load saved language preference or default to English
      const savedLanguage = localStorage.getItem('selectedLanguage') || 'english';
      languageSelect.value = savedLanguage;
      
      // Update flag display
      updateFlagDisplay(languageSelect);
      
      // Add event listener for language changes
      languageSelect.addEventListener('change', async (e) => {
        const selectedLanguage = e.target.value;
        
        // Save preference
        localStorage.setItem('selectedLanguage', selectedLanguage);
        
        // Update flag display
        updateFlagDisplay(e.target);
        
        // Load new language
        await loadLanguage(selectedLanguage);
        
        // Reapply language to elements
        applyLanguageToElements();
      });
    }
    
    // Update flag display based on selected option
    function updateFlagDisplay(selectElement) {
      if (selectElement.value === 'spanish') {
        selectElement.classList.add('spanish');
      } else {
        selectElement.classList.remove('spanish');
      }
    }
    
    // Public API
    window.LanguageSystem = {
      loadLanguage,
      getText,
      applyLanguageToElements,
      isLoaded: () => isLanguageLoaded,
      getCurrentLanguage: () => currentLanguageData
    };
    
    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initLanguageSystem);
    } else {
      initLanguageSystem();
    }
    
  })();
  