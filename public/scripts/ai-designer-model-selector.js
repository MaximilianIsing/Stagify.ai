      // Model selector dropdown functionality
      (function initModelSelector() {
        const modelSelector = document.querySelector('.model-selector');
        const modelSelectorBtn = document.getElementById('model-selector-btn');
        const modelDropdown = document.getElementById('model-dropdown');
        const modelOptions = document.querySelectorAll('.model-option');
        
        // Get saved model key from localStorage or default to "fast"
        function getSelectedModelKey() {
          return localStorage.getItem('selectedModel') || 'fast';
        }
        
        // Save model key to localStorage
        function setSelectedModelKey(modelKey) {
          localStorage.setItem('selectedModel', modelKey);
        }
        
        // Map model key to API model name
        function getModelApiName(modelKey) {
          const modelMap = {
            'fast': 'gpt-4o-mini',
            'pro': 'gpt-5-mini'
          };
          return modelMap[modelKey] || 'gpt-4o-mini';
        }
        
        // Get translated text for model
        function getModelText(modelKey) {
          if (window.LanguageSystem && window.LanguageSystem.isLoaded()) {
            const translationKey = modelKey === 'fast' ? 'pdf.modelSelector.fast' : 'pdf.modelSelector.pro';
            return window.LanguageSystem.getText(translationKey) || (modelKey === 'fast' ? 'Fast' : 'Stagify+');
          }
          return modelKey === 'fast' ? 'Fast' : 'Stagify+';
        }
        
        // Update the displayed model text
        function updateModelDisplay() {
          const savedModelKey = getSelectedModelKey();
          const modelText = modelSelectorBtn?.querySelector('.model-selector-text');
          if (modelText) {
            modelText.textContent = getModelText(savedModelKey);
          }
          const sendControls = document.querySelector('.send-controls');
          if (sendControls) {
            sendControls.classList.toggle('send-controls--pro', savedModelKey === 'pro');
          }
        }
        
        // Initialize display from localStorage
        // Wait for language system to be ready
        function waitForLanguageSystem() {
          if (window.LanguageSystem && window.LanguageSystem.isLoaded()) {
            updateModelDisplay();
          } else {
            // Try again after a short delay
            setTimeout(waitForLanguageSystem, 100);
          }
        }
        waitForLanguageSystem();
        
        // Update display when language changes
        // Method 1: Hook into applyLanguageToElements
        if (window.LanguageSystem) {
          const originalApplyLanguage = window.LanguageSystem.applyLanguageToElements;
          if (originalApplyLanguage) {
            window.LanguageSystem.applyLanguageToElements = function() {
              originalApplyLanguage.call(this);
              // Small delay to ensure translations are applied first
              setTimeout(updateModelDisplay, 50);
              // Update mask editor translations when language changes
              setTimeout(updateMaskEditorTranslations, 50);
            };
          }
        }
        
        // Method 2: Listen to language selector change event
        const languageSelect = document.getElementById('language-select');
        if (languageSelect) {
          languageSelect.addEventListener('change', () => {
            // Wait for language system to update translations
            setTimeout(updateModelDisplay, 200);
            setTimeout(updateMaskEditorTranslations, 200);
          });
        }
        
        // Method 3: Watch for language-loaded class on body
        const bodyObserver = new MutationObserver((mutations) => {
          mutations.forEach((mutation) => {
            if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
              if (document.body.classList.contains('language-loaded')) {
                updateModelDisplay();
                updateMaskEditorTranslations();
              }
            }
          });
        });
        bodyObserver.observe(document.body, {
          attributes: true,
          attributeFilter: ['class']
        });
        
        // Method 4: Poll for language changes (fallback)
        let lastLanguage = localStorage.getItem('selectedLanguage') || 'english';
        setInterval(() => {
          const currentLanguage = localStorage.getItem('selectedLanguage') || 'english';
          if (currentLanguage !== lastLanguage) {
            lastLanguage = currentLanguage;
            setTimeout(updateModelDisplay, 200);
          }
        }, 500);
        
        // Expose getModelApiName for use in fetch calls
        window.getSelectedModelApiName = function() {
          return getModelApiName(getSelectedModelKey());
        };
        
        if (modelSelectorBtn && modelDropdown) {
          // Toggle dropdown on button click
          modelSelectorBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            modelSelector.classList.toggle('open');
          });
          
          // Close dropdown when clicking outside
          document.addEventListener('click', (e) => {
            if (!modelSelector.contains(e.target)) {
              modelSelector.classList.remove('open');
            }
          });
          
          // Handle model option selection
          modelOptions.forEach(option => {
            option.addEventListener('click', (e) => {
              e.stopPropagation();
              const modelKey = option.getAttribute('data-model');
              if (modelKey) {
                setSelectedModelKey(modelKey);
                updateModelDisplay();
                modelSelector.classList.remove('open');
              }
            });
          });
        }
      })();
      
      // Initialize message tag selector
      (function initMessageTagSelector() {
        const messageTagSelector = document.querySelector('.message-tag-selector');
        const messageTagBtn = document.getElementById('message-tag-btn');
        const messageTagDropdown = document.getElementById('message-tag-dropdown');
        const messageTagOptions = document.querySelectorAll('.message-tag-option');
        
        // Get translated text for tag
        function getTagText(tagValue) {
          if (window.LanguageSystem && window.LanguageSystem.isLoaded()) {
            const translationKey = `pdf.messageTag.${tagValue === 'cad-stage' ? 'cadStage' : tagValue}`;
            return window.LanguageSystem.getText(translationKey) || getTagTextFallback(tagValue);
          }
          return getTagTextFallback(tagValue);
        }
        
        // Fallback text if language system not available
        function getTagTextFallback(tagValue) {
          const fallbackMap = {
            'auto': 'Auto',
            'generate': 'Generate',
            'stage': 'Stage/Modify',
            'cad-stage': 'Stage (Floor Plan)',
            'describe': 'Describe/Recall'
          };
          return fallbackMap[tagValue] || 'Auto';
        }
        
        // Update the displayed tag text
        function updateTagDisplay(tagValue) {
          const tagText = messageTagBtn?.querySelector('.message-tag-text');
          if (tagText) {
            tagText.textContent = getTagText(tagValue);
            messageTagBtn.setAttribute('data-tag', tagValue);
          }
        }
        
        // Initialize with 'auto'
        updateTagDisplay('auto');
        
        // Update display when language changes
        if (window.LanguageSystem) {
          const originalApplyLanguage = window.LanguageSystem.applyLanguageToElements;
          if (originalApplyLanguage) {
            window.LanguageSystem.applyLanguageToElements = function() {
              originalApplyLanguage.call(this);
              // Update tag display after language is applied
              const currentTag = messageTagBtn?.getAttribute('data-tag') || 'auto';
              setTimeout(() => updateTagDisplay(currentTag), 50);
            };
          }
        }
        
        // Listen to language selector change
        const languageSelect = document.getElementById('language-select');
        if (languageSelect) {
          languageSelect.addEventListener('change', () => {
            setTimeout(() => {
              const currentTag = messageTagBtn?.getAttribute('data-tag') || 'auto';
              updateTagDisplay(currentTag);
            }, 200);
          });
        }
        
        if (messageTagBtn && messageTagDropdown) {
          // Toggle dropdown on button click
          messageTagBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            messageTagSelector.classList.toggle('open');
          });
          
          // Close dropdown when clicking outside
          document.addEventListener('click', (e) => {
            if (!messageTagSelector.contains(e.target)) {
              messageTagSelector.classList.remove('open');
            }
          });
          
          // Handle tag option selection
          messageTagOptions.forEach(option => {
            option.addEventListener('click', (e) => {
              e.stopPropagation();
              const tagValue = option.getAttribute('data-tag');
              if (tagValue) {
                updateTagDisplay(tagValue);
                messageTagSelector.classList.remove('open');
              }
            });
          });
        }
      })();
      
      // Initialize bug report popup
      (function initBugReport() {
        const bugReportBtn = document.getElementById('bug-report-btn');
        const bugReportPopup = document.getElementById('bug-report-popup');
        const bugReportClose = document.getElementById('bug-report-popup-close');
        const bugReportCancel = document.getElementById('bug-report-cancel');
        const bugReportForm = document.getElementById('bug-report-form');
        const bugReportSubmit = document.getElementById('bug-report-submit');
        
        function openBugReport() {
          bugReportPopup.classList.add('active');
          document.body.style.overflow = 'hidden';
        }
        
        function closeBugReport() {
          bugReportPopup.classList.remove('active');
          document.body.style.overflow = '';
          bugReportForm.reset();
        }
        
        if (bugReportBtn) {
          bugReportBtn.addEventListener('click', openBugReport);
        }
        
        if (bugReportClose) {
          bugReportClose.addEventListener('click', closeBugReport);
        }
        
        if (bugReportCancel) {
          bugReportCancel.addEventListener('click', closeBugReport);
        }
        
        // Close when clicking outside
        if (bugReportPopup) {
          bugReportPopup.addEventListener('click', function(e) {
            if (e.target === bugReportPopup) {
              closeBugReport();
            }
          });
        }
        
        // Handle form submission
        if (bugReportForm) {
          bugReportForm.addEventListener('submit', async function(e) {
            e.preventDefault();
            
            const description = document.getElementById('bug-report-description').value.trim();
            const steps = document.getElementById('bug-report-steps').value.trim();
            const email = document.getElementById('bug-report-email').value.trim();
            
            if (!description) {
              showToast(lang('pdf.bug.needDescription', 'Please provide a bug description.'), 'error');
              return;
            }
            
            // Disable submit button
            bugReportSubmit.disabled = true;
            bugReportSubmit.textContent = 'Submitting...';
            
            try {
              const response = await fetch('/api/bug-report', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                  description,
                  steps,
                  email,
                  userId: localStorage.getItem('userId') || 'unknown',
                  userAgent: navigator.userAgent,
                  url: window.location.href,
                  timestamp: new Date().toISOString(),
                  conversationHistory: conversationHistory
                })
              });
              
              const data = await response.json();
              
              if (response.ok) {
                showToast(lang('pdf.bug.success', "Thank you for reporting this bug! We'll look into it."), 'success');
                closeBugReport();
              } else {
                throw new Error(data.error || 'Failed to submit bug report');
              }
            } catch (error) {
              console.error('Error submitting bug report:', error);
              showToast(lang('pdf.bug.failed', 'Failed to submit bug report. Please try again later.'), 'error');
            } finally {
              bugReportSubmit.disabled = false;
              bugReportSubmit.textContent = 'Submit';
            }
          });
        }
        
        // Close with Escape key
        document.addEventListener('keydown', function(e) {
          if (e.key === 'Escape' && bugReportPopup.classList.contains('active')) {
            closeBugReport();
          }
        });
      })();
      
      // Initialize modal event listeners (run immediately since script is at end of body)
      (function initImageModal() {
        const modal = document.getElementById('image-modal');
        const closeBtn = document.getElementById('image-modal-close');
        
        if (modal) {
          // Close modal when clicking outside the image
          modal.addEventListener('click', function(e) {
            if (e.target === modal) {
              closeImageModal();
            }
          });
          
          // Close modal with Escape key
          document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && modal.classList.contains('active')) {
              closeImageModal();
            }
          });
        }
        
        if (closeBtn) {
          closeBtn.addEventListener('click', closeImageModal);
        }
      })();
