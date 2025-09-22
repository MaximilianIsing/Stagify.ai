(() => {
    
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  
    // Background video synchronization across page navigation
    const BACKGROUND_VIDEO_KEY = 'stagify_background_video_time';
    
    // Store video currentTime when navigating away
    const storeVideoTime = () => {
        const video = $('#background-video');
        if (video && !video.paused) {
            localStorage.setItem(BACKGROUND_VIDEO_KEY, video.currentTime.toString());
        }
    };
    
    // Listen for various navigation events
    window.addEventListener('beforeunload', storeVideoTime);
    window.addEventListener('pagehide', storeVideoTime);
    
    // Also store time periodically while video is playing
    let timeStoreInterval;
    document.addEventListener('DOMContentLoaded', () => {
        const video = $('#background-video');
        if (video) {
            video.addEventListener('play', () => {
                // Store time every 2 seconds while playing
                timeStoreInterval = setInterval(storeVideoTime, 2000);
            });
            
            video.addEventListener('pause', () => {
                if (timeStoreInterval) {
                    clearInterval(timeStoreInterval);
                }
            });
        }
    });
    
    // Restore video currentTime when page loads
    document.addEventListener('DOMContentLoaded', () => {
        const video = $('#background-video');
        if (video) {
            const storedTime = localStorage.getItem(BACKGROUND_VIDEO_KEY);
            
            // Handle smooth video loading transition
            video.addEventListener('loadeddata', () => {
                video.classList.add('loaded');
            });
            
            // Ensure video starts playing smoothly
            video.addEventListener('canplay', () => {
                video.play().catch(() => {
                    // Handle autoplay restrictions gracefully - fallback to solid background
                    video.style.display = 'none';
                    document.body.style.background = '#b2c4f6';
                });
            });
  
            // Handle mobile autoplay restrictions
            const attemptPlay = () => {
                if (video.paused) {
                    video.play().catch(() => {
                        // Still failed, keep trying on user interaction
                        // If this is the final attempt, hide video and show solid background
                        if (playAttempts >= maxAttempts - 1) {
                            video.style.display = 'none';
                            document.body.style.background = '#b2c4f6';
                        }
                    });
                }
            };
  
            // Try to play on various user interactions
            document.addEventListener('touchstart', attemptPlay, { once: true });
            document.addEventListener('click', attemptPlay, { once: true });
            document.addEventListener('scroll', attemptPlay, { once: true });
  
            // Also try periodically for mobile
            let playAttempts = 0;
            const maxAttempts = 1;
            const playInterval = setInterval(() => {
                if (video.paused && playAttempts < maxAttempts) {
                    attemptPlay();
                    playAttempts++;
                } else if (!video.paused || playAttempts >= maxAttempts) {
                    clearInterval(playInterval);
                    // If we've exhausted all attempts, hide video and show solid background
                    if (video.paused) {
                        video.style.display = 'none';
                        document.body.style.background = '#b2c4f6';
                    }
                }
            }, 1000);
            
            if (storedTime) {
                const targetTime = parseFloat(storedTime);
                
                const restoreTime = () => {
                    if (video.duration && targetTime < video.duration) {
                        video.currentTime = targetTime;
                    }
                };
                
                // Try to restore time when metadata is loaded
                video.addEventListener('loadedmetadata', restoreTime);
                
                // Fallback if metadata is already loaded
                if (video.readyState >= 1 && video.duration) {
                    restoreTime();
                }
                
                // Additional fallback after a short delay
                setTimeout(restoreTime, 100);
            }
        }
    });
  
    const canvas1 = $('#canvas1');
    const downloadBtn = $('#download-btn');
    const newUploadBtn = $('#new-upload');
    const imageViewerContainer = $('#image-viewer-container');
    const processingPlaceholder = $('#processing-placeholder');
    const toggleBeforeBtn = $('#toggle-before');
    const toggleAfterBtn = $('#toggle-after');
  
    const heroUpload = $('#hero-upload');
    const navUpload = $('#nav-upload');
    const pricingUpload = $('#pricing-upload');
    const trySample = $('#try-sample');
    // Carousel is now handled by carousel.js
    
  
    // Stage screen elements (only on home page)
    const stageSection = $('#stage');
    const modal = $('#stage-modal');
    const modalBackdrop = $('#modal-backdrop');
    const modalClose = $('#modal-close');
    const stageDropzone = $('#stage-dropzone');
    const stageFileInput = $('#stage-file-input');
    const stagePreview = $('#stage-preview');
    const processBtn = $('#process-btn');
    const additionalPrompt = $('#additional-prompt');
    // Custom selects
    const roomSelect = initCustomSelect('#room-type-select');
    const styleSelect = initCustomSelect('#furniture-style-select');
    const progress = $('#progress');
    const progressBar = $('#progress-bar');
    const progressText = $('#progress-text');
    const loadingMessage = $('#loading-message');
  
    const yearSpan = $('#year');
    if (yearSpan) yearSpan.textContent = new Date().getFullYear();
  
    function openFilePicker() {
      // Open the staging modal without auto-opening the file chooser.
      // Users can click the upload area (right side) to pick a file.
      openModal();
    }
  
    // Only run modal functionality if we're on the home page (elements exist)
    if (modal && stageDropzone && stageFileInput) {
      [heroUpload, navUpload, pricingUpload].forEach((btn) => {
        if (btn) btn.addEventListener('click', openFilePicker);
      });
  
      // Example thumbnails to load sample images
      $$('.thumb').forEach((btn) => {
        btn.addEventListener('click', () => {
          openModal();
          const src = btn.getAttribute('data-src');
          stagePreview.src = src;
          stagePreview.classList.remove('hidden');
          $('.stage-dz-inner').classList.add('hidden');
        });
      });
  
      // Drag and drop on stage screen
      ;['dragenter','dragover'].forEach(evt => {
        stageDropzone.addEventListener(evt, (e) => { e.preventDefault(); stageDropzone.style.borderColor = '#000'; });
      });
      ;['dragleave','drop'].forEach(evt => {
        stageDropzone.addEventListener(evt, (e) => { e.preventDefault(); stageDropzone.style.borderColor = '#e8e8e8'; });
      });
      stageDropzone.addEventListener('click', () => { stageFileInput.click(); });
      stageDropzone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); stageFileInput.click(); }
      });
      stageDropzone.addEventListener('drop', (e) => {
        const file = e.dataTransfer.files?.[0];
        if (file) handleStageFile(file);
      });
      stageFileInput.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (file) handleStageFile(file);
      });
    }
  
    let currentImageFile = null;
    let hasProcessedImage = false;
  
    function handleStageFile(file) {
      const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
      if (!allowedTypes.includes(file.type)) {
        alert(window.LanguageSystem?.getText('errors.fileType') || 'Please upload a PNG, JPG, JPEG, WebP, or GIF image file.');
        return;
      }
      
      // Check file size (100MB limit)
      const maxSize = 100 * 1024 * 1024; // 100MB in bytes
      if (file.size > maxSize) {
        alert(window.LanguageSystem?.getText('errors.fileTooLarge') || 'File is too large. Please upload an image smaller than 100MB.');
        return;
      }
      
      currentImageFile = file; // Store the file for processing
      hasProcessedImage = false; // Reset processing state for new image
      const reader = new FileReader();
      reader.onload = () => {
        stagePreview.src = reader.result;
        // Show image viewer, hide upload zone
        stageDropzone.classList.add('hidden');
        imageViewerContainer.classList.remove('hidden');
        // Hide placeholder and show the uploaded image
        processingPlaceholder.style.display = 'none';
        canvas1.classList.add('hidden');
        // Reset to "Before" view
        showBeforeView();
      };
      reader.readAsDataURL(file);
    }
  
      // Real AI processing pipeline with realistic progress
    async function processWithAI(imageFile) {
      progress.classList.remove('hidden');
      progressBar.style.width = '0%';
        progressText.textContent = window.LanguageSystem?.getText('modal.staging.progress.uploading') || 'Uploading image…';
      
      // Add blur effect to the before image
      stagePreview.classList.add('processing');
  
      // Show loading message and ad immediately
      loadingMessage.classList.remove('hidden');
      loadingMessage.textContent = window.LanguageSystem?.getText('modal.staging.progress.preparingAI') || 'Preparing AI model';
      
      // Show the before image (original uploaded image)
      showBeforeView();
  
      // Random loading messages that will be shown during AI processing
      const loadingMessages = window.LanguageSystem?.getText('modal.staging.progress.loadingMessages') || [
        'Finding the perfect furniture for you',
        'Staging your ideal room',
        'Selecting beautiful decor pieces',
        'Arranging furniture for maximum appeal',
        'Creating the perfect ambiance',
        'Enhancing your space with style',
        'Designing your dream interior',
        'Optimizing room layout and flow',
        'Adding finishing touches',
        'Bringing your vision to life'
      ];
      
      // Ensure loadingMessages is an array
      const messagesArray = Array.isArray(loadingMessages) ? loadingMessages : [
        'Finding the perfect furniture for you',
        'Staging your ideal room',
        'Selecting beautiful decor pieces',
        'Arranging furniture for maximum appeal',
        'Creating the perfect ambiance',
        'Enhancing your space with style',
        'Designing your dream interior',
        'Optimizing room layout and flow',
        'Adding finishing touches',
        'Bringing your vision to life'
      ];
  
      let messageInterval;
      let isProcessingPhase = false;
      
      // Start progress simulation
      let currentProgress = 0;
      const progressInterval = setInterval(() => {
        if (currentProgress < 15) {
          currentProgress += Math.random() * 3;
          progressBar.style.width = Math.min(currentProgress, 15) + '%';
        }
      }, 200);
      
      try {
        const formData = new FormData();
        formData.append('image', imageFile);
        formData.append('roomType', roomSelect?.value || 'Living room');
        formData.append('furnitureStyle', styleSelect?.value || 'standard');
        formData.append('additionalPrompt', additionalPrompt?.value || '');
        
        // Get checkbox value
        const removeFurnitureCheckbox = document.getElementById('remove-furniture');
        formData.append('removeFurniture', removeFurnitureCheckbox?.checked || false);
        
        // Get user data from localStorage
        const userRole = localStorage.getItem('userRole') || 'unknown';
        const userReferralSource = localStorage.getItem('userReferralSource') || '';
        const userEmail = localStorage.getItem('userEmail') || '';
        formData.append('userRole', userRole);
        formData.append('userReferralSource', userReferralSource);
        formData.append('userEmail', userEmail);
        
        // Simulate upload progress
        await new Promise(resolve => setTimeout(resolve, 800));
        clearInterval(progressInterval);
        currentProgress = 25;
        progressBar.style.width = '25%';
        progressText.textContent = window.LanguageSystem?.getText('modal.staging.progress.preparingAI') || 'Preparing AI model…';
        
        // Start dynamic message cycling after preparation
        setTimeout(() => {
          isProcessingPhase = true;
          progressText.textContent = window.LanguageSystem?.getText('modal.staging.progress.staging') || 'AI is staging your room…';
          
          // Start cycling through the loading messages
          messageInterval = setInterval(() => {
            if (isProcessingPhase) {
              const randomMessage = messagesArray[Math.floor(Math.random() * messagesArray.length)];
              loadingMessage.textContent = randomMessage;
            }
          }, 2000);
          
          // Set first AI message immediately
          const randomMessage = messagesArray[Math.floor(Math.random() * messagesArray.length)];
          loadingMessage.textContent = randomMessage;
        }, 1000);
        
        // Start AI processing simulation
        const aiProgressInterval = setInterval(() => {
          if (currentProgress < 70) {
            currentProgress += Math.random() * 2;
            progressBar.style.width = Math.min(currentProgress, 70) + '%';
          }
        }, 300);
        
        const response = await fetch('/api/process-image', {
          method: 'POST',
          body: formData
        });
        
        // Update progress during AI processing
        clearInterval(aiProgressInterval);
        currentProgress = 75;
        progressBar.style.width = '75%';
        progressText.textContent = window.LanguageSystem?.getText('modal.staging.progress.staging') || 'AI is staging your room…';
        
         if (!response.ok) {
           const errorData = await response.json();
           if (errorData.code === 'FILE_TOO_LARGE') {
             throw new Error(window.LanguageSystem?.getText('errors.fileTooLarge') || 'File is too large. Please upload an image smaller than 100MB.');
           }
           if (response.status === 500) {
             throw new Error(window.LanguageSystem?.getText('errors.badPrompt') || 'Bad prompt inputted');
           }
           throw new Error(errorData.message || errorData.error || window.LanguageSystem?.getText('errors.processingFailed') || 'Processing failed');
         }
        
        // Simulate final processing steps
        const finalProgressInterval = setInterval(() => {
          if (currentProgress < 95) {
            currentProgress += Math.random() * 3;
            progressBar.style.width = Math.min(currentProgress, 95) + '%';
          }
        }, 150);
        
        const result = await response.json();
        
        // Complete the progress
        clearInterval(finalProgressInterval);
        clearInterval(messageInterval);
        isProcessingPhase = false;
        loadingMessage.classList.add('hidden');
        
        // Remove blur effect on error
        stagePreview.classList.remove('processing');
        
        // Show processing placeholder again if needed
        if (processingPlaceholder && !hasProcessedImage) {
          processingPlaceholder.style.display = 'flex';
        }
        
        progressBar.style.width = '100%';
        progressText.textContent = window.LanguageSystem?.getText('modal.staging.progress.complete') || 'Complete!';
        
        if (result.success && result.image) {
          return result.image;
        } else {
          throw new Error(window.LanguageSystem?.getText('errors.noImageData') || 'No image data received');
        }
        
      } catch (error) {
        // Clear any running intervals
        clearInterval(progressInterval);
        clearInterval(messageInterval);
        isProcessingPhase = false;
        loadingMessage.classList.add('hidden');
        
        // Remove blur effect on error
        stagePreview.classList.remove('processing');
        
        // Show processing placeholder again if needed
        if (processingPlaceholder && !hasProcessedImage) {
          processingPlaceholder.style.display = 'flex';
        }
        
        progressText.textContent = (window.LanguageSystem?.getText('modal.staging.progress.error') || 'Error: ') + error.message;
        progressBar.style.width = '0%';
        setTimeout(() => {
          progress.classList.add('hidden');
        }, 3000);
        throw error;
      }
    }
  
    function getSelectedPreset() {
      const val = styleSelect?.value || 'standard';
      return val;
    }
  
    // Toggle between Before and After views
    function showBeforeView() {
      stagePreview.classList.remove('hidden');
      canvas1.classList.add('hidden');
      toggleBeforeBtn.classList.add('active');
      toggleAfterBtn.classList.remove('active');
      // Hide placeholder when showing the image
      if (stagePreview.src) {
        processingPlaceholder.style.display = 'none';
      }
    }
  
    function showAfterView() {
      stagePreview.classList.add('hidden');
      canvas1.classList.remove('hidden');
      toggleBeforeBtn.classList.remove('active');
      toggleAfterBtn.classList.add('active');
      // Show placeholder if no processing has been done yet
      if (!hasProcessedImage) {
        processingPlaceholder.style.display = 'flex';
      } else {
        processingPlaceholder.style.display = 'none';
      }
    }
  
    // Add toggle event listeners
    if (toggleBeforeBtn) toggleBeforeBtn.addEventListener('click', showBeforeView);
    if (toggleAfterBtn) toggleAfterBtn.addEventListener('click', () => {
      // Always allow switching to "After" view
      showAfterView();
    });
  
    async function stageImage() {
      if (!currentImageFile) {
        alert(window.LanguageSystem?.getText('errors.uploadFirst') || 'Please upload an image first');
        return;
      }
      
      processBtn.disabled = true;
      
      try {
        const processedImageData = await processWithAI(currentImageFile);
        
        // Display the processed image
        const img = new Image();
        img.onload = () => {
          const ctx1 = canvas1.getContext('2d');
          const w = img.width, h = img.height;
          ctx1.canvas.width = w;
          ctx1.canvas.height = h;
          ctx1.drawImage(img, 0, 0, w, h);
          
          // Mark that we have a processed image
          hasProcessedImage = true;
          
          // Remove blur effect from the before image
          stagePreview.classList.remove('processing');
          
          // Hide placeholder and show result
          processingPlaceholder.style.display = 'none';
          
          // Automatically switch to "After" view to show the result
          showAfterView();
          
          progress.classList.add('hidden');
          processBtn.disabled = false;
          
          // Refresh prompt count after successful processing
          loadPromptCount();
        };
        img.src = processedImageData;
        
       } catch (error) {
         processBtn.disabled = false;
         // Progress bar will show error message from processWithAI
       }
    }
  
    // Only add modal event listeners if elements exist
    if (processBtn) processBtn.addEventListener('click', stageImage);
    if (modalBackdrop) modalBackdrop.addEventListener('click', closeModal);
    if (modalClose) modalClose.addEventListener('click', closeModal);
  
    if (downloadBtn) downloadBtn.addEventListener('click', () => {
      if (!canvas1.width) return;
      const link = document.createElement('a');
      link.download = 'stagify-result.png';
      link.href = canvas1.toDataURL('image/png');
      link.click();
    });
  
    if (newUploadBtn) newUploadBtn.addEventListener('click', () => {
      currentImageFile = null;
      hasProcessedImage = false; // Reset processing state
      stagePreview.src = '';
      // Show upload zone, hide viewer
      stageDropzone.classList.remove('hidden');
      imageViewerContainer.classList.add('hidden');
      stageFileInput.value = '';
      progress.classList.add('hidden');
      // Reset placeholder to show state
      processingPlaceholder.style.display = 'flex';
      // Reset canvas
      if (canvas1) {
        const ctx = canvas1.getContext('2d');
        ctx.clearRect(0, 0, canvas1.width, canvas1.height);
        canvas1.width = 0;
        canvas1.height = 0;
      }
    });
  
    // Sample button removed from UI
  
    function openModal() {
      modal.classList.remove('hidden');
    }
    function closeModal() {
      modal.classList.add('hidden');
    }
  
    // Custom select component
    function initCustomSelect(rootSelector) {
      const root = document.querySelector(rootSelector);
      if (!root) return { get value() { return ''; } };
      const trigger = root.querySelector('.select-trigger');
      const menu = root.querySelector('.select-menu');
      const valueEl = root.querySelector('.select-value');
      const options = Array.from(root.querySelectorAll('.option'));
      function setValue(val) {
        root.dataset.value = val;
        valueEl.textContent = options.find(o => o.dataset.value === val)?.textContent || val;
        options.forEach(o => o.classList.toggle('selected', o.dataset.value === val));
        menu.classList.add('hidden');
      }
      trigger.addEventListener('click', () => {
        menu.classList.toggle('hidden');
      });
      options.forEach(o => {
        o.addEventListener('click', () => setValue(o.dataset.value));
      });
      document.addEventListener('click', (e) => {
        if (!root.contains(e.target)) menu.classList.add('hidden');
      });
      return {
        get value() { return root.dataset.value; },
        set(value) { setValue(value); }
      };
    }
  })();
  
  
  
  // Initialize on page load (all pages)
  document.addEventListener('DOMContentLoaded', function() {
    
    // Check if user is first-time visitor and show role popup
    initRolePopup();
    
    // Load and display prompt count
    loadPromptCount();
    
    // Load and display contact count
    loadContactCount();
    
    // Initialize 3D tilt effect for advantages section and contact cards
    init3DTiltEffect();
  });
  
  // Load and display prompt count from server
  function loadPromptCount() {
    fetch('/api/prompt-count')
      .then(response => response.json())
      .then(data => {
        // Find the specific stat pill for "Rooms Staged" by looking for the one with the roomsStaged data-lang attribute
        const roomsStagedPill = document.querySelector('.stat-pill-text[data-lang="hero.stats.roomsStaged"]');
        const statPillNumber = roomsStagedPill ? roomsStagedPill.parentElement.querySelector('.stat-pill-number') : null;
        
        if (statPillNumber && data.promptCount !== undefined) {
          // Format the number nicely
          const count = data.promptCount;
          statPillNumber.textContent = count.toString();

        }
      })
      .catch(error => {
        console.error('Error loading prompt count:', error);
        // Keep the default "1000+" if there's an error
      });
  }

  // Load and display contact count from server
  function loadContactCount() {
    fetch('/api/contact-count')
      .then(response => response.json())
      .then(data => {
        // Find the specific stat pill for "Users Served" by looking for the one with the usersServed data-lang attribute
        const usersServedPill = document.querySelector('.stat-pill-text[data-lang="hero.stats.usersServed"]');
        const statPillNumber = usersServedPill ? usersServedPill.parentElement.querySelector('.stat-pill-number') : null;
        
        if (statPillNumber && data.contactCount !== undefined) {
          // Format the number nicely
          const count = data.contactCount;
          statPillNumber.textContent = count.toString();
        }
      })
      .catch(error => {
        console.error('Error loading contact count:', error);
        // Keep the default "200+" if there's an error
      });
  }

  
  
  // 3D Tilt Effect for Advantages Section, Contact Cards, and FAQ
  function init3DTiltEffect() {
    // Apply to advantages section
    applyTiltEffect('.advantages');
    
    // Apply to FAQ section
    applyTiltEffect('.faq');
    
    // Apply to all contact cards
    const contactCards = document.querySelectorAll('.contact-card');
    contactCards.forEach((card, index) => {
      applyTiltEffectToElement(card);
    });
  }
  
  function applyTiltEffect(selector) {
    const element = document.querySelector(selector);
    if (!element) return;
    applyTiltEffectToElement(element);
  }
  
  function applyTiltEffectToElement(element) {
    let isHovering = false;
    
    element.addEventListener('mouseenter', function() {
      isHovering = true;
    });
    
    element.addEventListener('mouseleave', function() {
      isHovering = false;
      // Reset to neutral position
      element.style.transform = 'rotateX(0deg) rotateY(0deg)';
    });
    
    element.addEventListener('mousemove', function(e) {
      if (!isHovering) return;
      
      const rect = element.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      
      // Calculate mouse position relative to center
      const mouseX = e.clientX - centerX;
      const mouseY = e.clientY - centerY;
      
      // Calculate rotation values (max 8 degrees)
      const rotateY = (mouseX / (rect.width / 2)) * 8;
      const rotateX = -(mouseY / (rect.height / 2)) * 8;
      
      // Apply 3D transformation
      element.style.transform = `rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
    });
  }
  
  // User Information Popup System
  function initRolePopup() {
    // Check if user has already completed all questions
    const hasCompletedAll = localStorage.getItem('userInfoCompleted');
    
    if (!hasCompletedAll) {
      // Show role popup after a short delay for better UX
      setTimeout(() => {
        showRolePopup();
      }, 1000);
    }
  }
  
  function showRolePopup() {
    const popup = document.getElementById('role-popup');
    if (popup) {
      popup.classList.remove('hidden');
      
      // Add event listeners to role buttons
      const roleButtons = popup.querySelectorAll('[data-role]');
      roleButtons.forEach(button => {
        button.addEventListener('click', function() {
          const selectedRole = this.getAttribute('data-role');
          handleRoleSelection(selectedRole);
        });
      });
    }
  }
  
  function handleRoleSelection(role) {
    // Save the selected role to localStorage
    localStorage.setItem('userRole', role);
    localStorage.setItem('roleSelectedAt', new Date().toISOString());
    
    // Hide the role popup
    const rolePopup = document.getElementById('role-popup');
    if (rolePopup) rolePopup.classList.add('hidden');
    
    // Show referral popup immediately (no delay)
    showReferralPopup();
  }
  
  function showReferralPopup() {
    const popup = document.getElementById('referral-popup');
    if (popup) {
      popup.classList.remove('hidden');
      
      // Add event listeners to referral buttons
      const referralButtons = popup.querySelectorAll('[data-referral]');
      referralButtons.forEach(button => {
        button.addEventListener('click', function() {
          const selectedReferral = this.getAttribute('data-referral');
          handleReferralSelection(selectedReferral);
        });
      });
    }
  }
  
  function handleReferralSelection(referral) {
    // Save the selected referral source to localStorage
    localStorage.setItem('userReferralSource', referral);
    localStorage.setItem('referralSelectedAt', new Date().toISOString());
    
    // Hide the referral popup
    const referralPopup = document.getElementById('referral-popup');
    if (referralPopup) referralPopup.classList.add('hidden');
    
    // Show email popup immediately (no delay)
    showEmailPopup();
  }
  
  function showEmailPopup() {
    const popup = document.getElementById('email-popup');
    if (popup) {
      popup.classList.remove('hidden');
      
      // Add event listeners to skip button
      const skipButton = document.getElementById('skip-email');
      if (skipButton) {
        skipButton.addEventListener('click', function() {
          handleEmailSubmission('');
        });
      }
      
      // Add event listener to submit button
      const submitButton = document.getElementById('submit-email');
      if (submitButton) {
        submitButton.addEventListener('click', function() {
          const emailInput = document.getElementById('user-email');
          const email = emailInput ? emailInput.value.trim() : '';
          handleEmailSubmission(email);
        });
        
        // Update button state based on email input
        const emailInput = document.getElementById('user-email');
        if (emailInput) {
          emailInput.addEventListener('input', function() {
            const email = this.value.trim();
            const isValidEmail = email.includes('@') && email.includes('.');
            submitButton.disabled = !isValidEmail;
          });
          // Initial state
          submitButton.disabled = true;
        }
      }
      
      // Add event listener to email input (Enter key)
      const emailInput = document.getElementById('user-email');
      if (emailInput) {
        emailInput.addEventListener('keypress', function(e) {
          if (e.key === 'Enter') {
            const email = this.value.trim();
            const isValidEmail = email.includes('@') && email.includes('.');
            if (isValidEmail) {
              handleEmailSubmission(email);
            }
          }
        });
      }
    }
  }
  
  function handleEmailSubmission(email) {
    // Save the email to localStorage
    localStorage.setItem('userEmail', email);
    localStorage.setItem('emailSubmittedAt', new Date().toISOString());
    localStorage.setItem('userInfoCompleted', 'true');
    
    // Get all user information from localStorage
    const userRole = localStorage.getItem('userRole') || '';
    const referralSource = localStorage.getItem('userReferralSource') || '';
    const userAgent = navigator.userAgent;
    
    // Send contact information to server
    fetch('/api/log-contact', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        userRole: userRole,
        referralSource: referralSource,
        email: email,
        userAgent: userAgent
      })
    })
    .then(response => response.json())
    .then(data => {
      if (data.success) {
        loadContactCount();
      } else {
        console.error('Failed to log contact:', data.message);
      }
    })
    .catch(error => {
      console.error('Error logging contact:', error);
    });
    
    // Hide all popups
    const rolePopup = document.getElementById('role-popup');
    const referralPopup = document.getElementById('referral-popup');
    const emailPopup = document.getElementById('email-popup');
    
    if (rolePopup) rolePopup.classList.add('hidden');
    if (referralPopup) referralPopup.classList.add('hidden');
    if (emailPopup) emailPopup.classList.add('hidden');
    
    // Apply role-specific customizations
    customizeExperienceForRole(userRole);
  }
  
  function customizeExperienceForRole(role) {
    // Add role-specific customizations based on user selection
    document.body.setAttribute('data-user-role', role);
    
    // You can add different messaging, features, or styling based on role
    switch(role) {
      case 'seller':
        // Customize for sellers
        break;
      case 'agent':
        // Customize for agents
        break;
      case 'buyer':
        // Customize for buyers
        break;
      case 'other':
        // Default experience
        break;
    }
  }
  
  
  