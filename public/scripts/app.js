(() => {
  // AD CONTROL VARIABLE - Set to false to hide all ads
  const SHOW_ADS = false; // Change this to false to disable all advertisements
  
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

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
  // Hero tabs switching image
  const styleToImg = {
    original: 'media-webp/example/Original.webp',
    modern: 'media-webp/example/Modern.webp',
    scandinavian: 'media-webp/example/Scandinavian.webp',
    luxury: 'media-webp/example/Luxury.webp',
    coastal: 'media-webp/example/Coastal.webp',
    midcentury: 'media-webp/example/Midcentury.webp',
    farmhouse: 'media-webp/example/Farmhouse.webp'
  };
  $$('.hero-tabs .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      $$('.hero-tabs .chip').forEach(c => c.classList.remove('selected'));
      chip.classList.add('selected');
      const style = chip.dataset.heroStyle;
      const img = $('#hero-stage-img');
      img.className = 'hero-stage-img filtered ' + style;
      if (style && styleToImg[style]) {
        // Lazy load all images except the original
        if (style === 'original') {
          img.src = styleToImg[style];
        } else {
          img.loading = 'lazy';
          img.src = styleToImg[style];
        }
        const label = style.charAt(0).toUpperCase() + style.slice(1);
        img.alt = label + ' staged apartment example';
      }
    });
  });
  

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
  const roomTypeSelect = createCustomSelect('#room-type-select');
  const furnitureStyleSelect = createCustomSelect('#furniture-style-select');
  const progressContainer = $('#progress');
  const progressBar = $('#progress-bar');
  const progressText = $('#progress-text');
  const loadingMessage = $('#loading-message');
  const loadingAdContainer = $('#loading-ad-container');
  const yearElement = $('#year');

  // Initialize year
  if (yearElement) {
    yearElement.textContent = new Date().getFullYear();
  }

  // Only run modal functionality if we're on the home page (elements exist)
  if (modal && stageDropzone && stageFileInput) {
    
    // Upload button event listeners
    [heroUpload, navUpload, pricingUpload].forEach(btn => {
      if (btn) {
        btn.addEventListener('click', openModal);
      }
    });

    // Sample image click handlers
    $$('.thumb').forEach(thumb => {
      thumb.addEventListener('click', () => {
        openModal();
        const src = thumb.getAttribute('data-src');
        if (src) {
          stagePreview.src = src;
          stagePreview.classList.remove('hidden');
          $('.stage-dz-inner').classList.add('hidden');
        }
      });
    });

    // Drag and drop handlers
    ['dragenter', 'dragover'].forEach(eventName => {
      stageDropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        stageDropzone.style.borderColor = '#000';
      });
    });

    ['dragleave', 'drop'].forEach(eventName => {
      stageDropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        stageDropzone.style.borderColor = '#e8e8e8';
      });
    });

    // Dropzone click handler
    stageDropzone.addEventListener('click', () => {
      stageFileInput.click();
    });

    // Dropzone keyboard handler
    stageDropzone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        stageFileInput.click();
      }
    });

    // File drop handler
    stageDropzone.addEventListener('drop', (e) => {
      const file = e.dataTransfer.files?.[0];
      if (file) {
        handleFileUpload(file);
      }
    });

    // File input change handler
    stageFileInput.addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (file) {
        handleFileUpload(file);
      }
    });
  }

  let currentFile = null;
  let isProcessing = false;

  function handleFileUpload(file) {
    // Validate file type
    if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) {
      alert('Please upload a PNG, JPG, JPEG, WebP, or GIF image file.');
      return;
    }

    // Validate file size (100MB limit)
    if (file.size > 100 * 1024 * 1024) {
      alert('File is too large. Please upload an image smaller than 100MB.');
      return;
    }

    currentFile = file;
    isProcessing = false;

    // Create preview
    const reader = new FileReader();
    reader.onload = () => {
      stagePreview.src = reader.result;
      stageDropzone.classList.add('hidden');
      imageViewerContainer.classList.remove('hidden');
      processingPlaceholder.style.display = 'none';
      canvas1.classList.add('hidden');
      showBeforeAfterToggle();
    };
    reader.readAsDataURL(file);
  }

  async function processImage(file) {
    // Show progress UI
    progressContainer.classList.remove('hidden');
    progressBar.style.width = '0%';
    progressText.textContent = 'Uploading image…';
    loadingMessage.classList.remove('hidden');
    loadingMessage.textContent = 'Preparing AI model';
    showBeforeAfterToggle();

    // Progress messages for better UX
    const progressMessages = [
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
    let isProcessingActive = false;
    let progress = 0;

    // Initial progress animation
    const initialProgressInterval = setInterval(() => {
      if (progress < 15) {
        progress += 3 * Math.random();
        progressBar.style.width = Math.min(progress, 15) + '%';
      }
    }, 200);

    try {
      // Prepare form data
      const formData = new FormData();
      formData.append('image', file);
      formData.append('roomType', roomTypeSelect?.value || 'Living room');
      formData.append('furnitureStyle', furnitureStyleSelect?.value || 'standard');
      formData.append('additionalPrompt', additionalPrompt?.value || '');

      // Add remove furniture option
      const removeFurnitureCheckbox = document.getElementById('remove-furniture');
      formData.append('removeFurniture', removeFurnitureCheckbox?.checked || false);

      // Add user tracking data
      const userRole = localStorage.getItem('userRole') || 'unknown';
      const userReferralSource = localStorage.getItem('userReferralSource') || '';
      const userEmail = localStorage.getItem('userEmail') || '';
      formData.append('userRole', userRole);
      formData.append('userReferralSource', userReferralSource);
      formData.append('userEmail', userEmail);

      // Add a small delay for better UX
      await new Promise(resolve => setTimeout(resolve, 800));

      clearInterval(initialProgressInterval);
      progress = 25;
      progressBar.style.width = '25%';
      progressText.textContent = 'Preparing AI model…';

      // Start processing animation
      setTimeout(() => {
        isProcessingActive = true;
        progressText.textContent = 'AI is staging your room…';
        
        // Random progress messages
        messageInterval = setInterval(() => {
          if (isProcessingActive) {
            const randomMessage = progressMessages[Math.floor(Math.random() * progressMessages.length)];
            loadingMessage.textContent = randomMessage;
          }
        }, 2000);
        
        // Set initial message
        const initialMessage = progressMessages[Math.floor(Math.random() * progressMessages.length)];
        loadingMessage.textContent = initialMessage;
      }, 1000);

      // Progress animation during processing
      const processingProgressInterval = setInterval(() => {
        if (progress < 70) {
          progress += 2 * Math.random();
          progressBar.style.width = Math.min(progress, 70) + '%';
        }
      }, 300);

      // Send request to server
      const response = await fetch('/api/process-image', {
        method: 'POST',
        body: formData
      });

      clearInterval(processingProgressInterval);
      progress = 75;
      progressBar.style.width = '75%';
      progressText.textContent = 'AI is staging your room…';

      if (!response.ok) {
        const errorData = await response.json();
        
        if (errorData.code === 'FILE_TOO_LARGE') {
          throw new Error('File is too large. Please upload an image smaller than 100MB.');
        }
        
        if (response.status === 500) {
          throw new Error('Bad prompt inputted');
        }
        
        throw new Error(errorData.message || errorData.error || 'Processing failed');
      }

      // Final progress animation
      const finalProgressInterval = setInterval(() => {
        if (progress < 95) {
          progress += 3 * Math.random();
          progressBar.style.width = Math.min(progress, 95) + '%';
        }
      }, 150);

      const result = await response.json();

      clearInterval(finalProgressInterval);
      clearInterval(messageInterval);
      isProcessingActive = false;
      loadingMessage.classList.add('hidden');

      if (processingPlaceholder && !isProcessing) {
        processingPlaceholder.style.display = 'flex';
      }

      progressBar.style.width = '100%';
      progressText.textContent = 'Complete!';

      if (result.success && result.image) {
        return result.image;
      } else {
        throw new Error('No image data received');
      }

    } catch (error) {
      clearInterval(initialProgressInterval);
      clearInterval(messageInterval);
      isProcessingActive = false;
      loadingMessage.classList.add('hidden');

      if (processingPlaceholder && !isProcessing) {
        processingPlaceholder.style.display = 'flex';
      }

      progressText.textContent = 'Error: ' + error.message;
      progressBar.style.width = '0%';

      setTimeout(() => {
        progressContainer.classList.add('hidden');
      }, 3000);

      throw error;
    }
  }

  function getSelectedFurnitureStyle() {
    const style = furnitureStyleSelect?.value || 'standard';
    return style;
  }

  function showBeforeAfterToggle() {
    stagePreview.classList.remove('hidden');
    canvas1.classList.add('hidden');
    toggleBeforeBtn.classList.add('active');
    toggleAfterBtn.classList.remove('active');
    
    if (stagePreview.src) {
      processingPlaceholder.style.display = 'none';
    }
  }

  function showAfterImage() {
    stagePreview.classList.add('hidden');
    canvas1.classList.remove('hidden');
    toggleBeforeBtn.classList.remove('active');
    toggleAfterBtn.classList.add('active');
    
    if (isProcessing) {
      processingPlaceholder.style.display = 'none';
    } else {
      processingPlaceholder.style.display = 'flex';
    }
  }

  async function handleProcessClick() {
    if (!currentFile) {
      alert('Please upload an image first');
      return;
    }

    processBtn.disabled = true;

    try {
      const imageData = await processImage(currentFile);
      
      // Create image element to draw on canvas
      const img = new Image();
      img.onload = () => {
        const ctx = canvas1.getContext('2d');
        const canvasWidth = img.width;
        const canvasHeight = img.height;
        
        canvas1.width = canvasWidth;
        canvas1.height = canvasHeight;
        ctx.drawImage(img, 0, 0, canvasWidth, canvasHeight);
        
        isProcessing = true;
        processingPlaceholder.style.display = 'none';
        showAfterImage();
        progressContainer.classList.add('hidden');
        processBtn.disabled = false;
      };
      img.src = imageData;
      
    } catch (error) {
      processBtn.disabled = false;
    }
  }

  function openModal() {
    modal.classList.remove('hidden');
  }

  function closeModal() {
    modal.classList.add('hidden');
  }

  // Custom select component
  function createCustomSelect(selector) {
    const select = document.querySelector(selector);
    if (!select) return { get value() { return ''; } };

    const trigger = select.querySelector('.select-trigger');
    const menu = select.querySelector('.select-menu');
    const value = select.querySelector('.select-value');
    const options = Array.from(select.querySelectorAll('.option'));

    function updateValue(newValue) {
      select.dataset.value = newValue;
      value.textContent = options.find(opt => opt.dataset.value === newValue)?.textContent || newValue;
      options.forEach(opt => opt.classList.toggle('selected', opt.dataset.value === newValue));
      menu.classList.add('hidden');
    }

    trigger.addEventListener('click', () => {
      menu.classList.toggle('hidden');
    });

    options.forEach(option => {
      option.addEventListener('click', () => {
        updateValue(option.dataset.value);
      });
    });

    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
      if (!select.contains(e.target)) {
        menu.classList.add('hidden');
      }
    });

    return {
      get value() {
        return select.dataset.value;
      },
      set value(newValue) {
        updateValue(newValue);
      }
    };
  }

  // Event listeners
  if (toggleBeforeBtn) {
    toggleBeforeBtn.addEventListener('click', showBeforeAfterToggle);
  }
  
  if (toggleAfterBtn) {
    toggleAfterBtn.addEventListener('click', showAfterImage);
  }
  
  if (processBtn) {
    processBtn.addEventListener('click', handleProcessClick);
  }
  
  if (modalBackdrop) {
    modalBackdrop.addEventListener('click', closeModal);
  }
  
  if (modalClose) {
    modalClose.addEventListener('click', closeModal);
  }
  
  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => {
      if (!canvas1.width) return;
      
      const link = document.createElement('a');
      link.download = 'stagify-result.png';
      link.href = canvas1.toDataURL('image/png');
      link.click();
    });
  }
  
  if (newUploadBtn) {
    newUploadBtn.addEventListener('click', () => {
      currentFile = null;
      isProcessing = false;
      stagePreview.src = '';
      stageDropzone.classList.remove('hidden');
      imageViewerContainer.classList.add('hidden');
      stageFileInput.value = '';
      progressContainer.classList.add('hidden');
      processingPlaceholder.style.display = 'flex';
      
      if (canvas1) {
        const ctx = canvas1.getContext('2d');
        ctx.clearRect(0, 0, canvas1.width, canvas1.height);
        canvas1.width = 0;
        canvas1.height = 0;
      }
    });
  }

})();

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', function() {
  initRolePopup();
  startBirdAnimations();
  init3DTiltEffect();
});

// Bird animation system
let birdInterval, cleanupInterval, activeBirds = [];
const MAX_BIRDS = 3;
const CLEANUP_INTERVAL = 30000; // 30 seconds

function startBirdAnimations() {
  cleanup();
  restoreBirdsFromStorage();
  
  birdInterval = setInterval(() => {
    if (activeBirds.length < MAX_BIRDS && Math.random() > 0.6) {
      createBird();
    }
  }, 4000);

  // Create first bird after 6 seconds
  setTimeout(() => {
    if (activeBirds.length < MAX_BIRDS) {
      createBird();
    }
  }, 6000);

  cleanupInterval = setInterval(cleanupExpiredBirds, CLEANUP_INTERVAL);
  window.addEventListener('beforeunload', saveBirdsToStorage);
}

function cleanup() {
  if (birdInterval) {
    clearInterval(birdInterval);
    birdInterval = null;
  }
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  window.removeEventListener('beforeunload', saveBirdsToStorage);
  
  const birds = document.querySelectorAll('.bird');
  birds.forEach(bird => bird.remove());
  activeBirds = [];
}

function createBird() {
  const birdId = 'bird_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  const birdElement = document.createElement('div');
  birdElement.className = 'bird';
  birdElement.id = birdId;
  
  const birdImg = document.createElement('img');
  birdImg.src = `media-webp/Bird.gif?t=${Math.random()}`;
  birdImg.alt = 'Flying bird';
  birdElement.appendChild(birdImg);
  
  // Random Y position (50px to 60% of viewport height)
  const yPosition = Math.random() * (0.6 * window.innerHeight) + 50;
  birdElement.style.setProperty('--bird-y', yPosition + 'px');
  
  // Random direction
  const direction = Math.random() > 0.5 ? 'left-to-right' : 'right-to-left';
  birdElement.classList.add(direction, 'single');
  
  document.body.appendChild(birdElement);
  
  // Store bird data
  const birdData = {
    id: birdId,
    y: yPosition,
    direction: direction,
    startTime: Date.now(),
    duration: 15000 // 15 seconds
  };
  activeBirds.push(birdData);
  
  // Remove bird after animation
  setTimeout(() => {
    if (birdElement.parentNode) {
      birdElement.parentNode.removeChild(birdElement);
    }
    activeBirds = activeBirds.filter(bird => bird.id !== birdId);
  }, 15000);
}

function saveBirdsToStorage() {
  try {
    const now = Date.now();
    const birdsToSave = activeBirds.filter(bird => {
      const elapsed = now - bird.startTime;
      return elapsed < bird.duration && elapsed >= 0;
    }).map(bird => ({
      ...bird,
      remainingTime: bird.duration - (now - bird.startTime)
    }));
    
    if (birdsToSave.length > 0) {
      sessionStorage.setItem('stagify_birds', JSON.stringify(birdsToSave));
    } else {
      sessionStorage.removeItem('stagify_birds');
    }
  } catch (error) {
    sessionStorage.removeItem('stagify_birds');
  }
}

function cleanupExpiredBirds() {
  const now = Date.now();
  
  // Filter out expired birds from activeBirds array
  activeBirds = activeBirds.filter(bird => {
    const elapsed = now - bird.startTime;
    return elapsed < bird.duration;
  });
  
  // Remove DOM elements for birds not in activeBirds array
  const birdElements = document.querySelectorAll('.bird');
  birdElements.forEach(birdElement => {
    const birdExists = activeBirds.some(bird => bird.id === birdElement.id);
    if (!birdExists) {
      birdElement.remove();
    }
  });
  
  // Clean up session storage
  try {
    const storedBirds = sessionStorage.getItem('stagify_birds');
    if (storedBirds) {
      const birds = JSON.parse(storedBirds);
      const validBirds = birds.filter(bird => 
        bird.remainingTime > 0 && 
        (now - (bird.startTime || 0)) < (bird.duration || 15000)
      );
      
      if (validBirds.length === 0) {
        sessionStorage.removeItem('stagify_birds');
      }
    }
  } catch (error) {
    sessionStorage.removeItem('stagify_birds');
  }
  
  return activeBirds.length;
}

function restoreBirdsFromStorage() {
  const storedBirds = sessionStorage.getItem('stagify_birds');
  if (storedBirds) {
    try {
      const birds = JSON.parse(storedBirds);
      let restoredCount = 0;
      
      birds.forEach(bird => {
        if (bird && bird.remainingTime > 1000 && bird.remainingTime <= 15000 && 
            restoredCount < MAX_BIRDS && activeBirds.length < MAX_BIRDS) {
          createRestoredBird(bird);
          restoredCount++;
        }
      });
      
      // Clear storage after restoration
      sessionStorage.removeItem('stagify_birds');
    } catch (error) {
      sessionStorage.removeItem('stagify_birds');
    }
  }
}

function createRestoredBird(birdData) {
  const birdElement = document.createElement('div');
  birdElement.className = 'bird';
  birdElement.id = birdData.id;
  
  const birdImg = document.createElement('img');
  birdImg.src = `media-webp/Bird.gif?t=${Math.random()}`;
  birdImg.alt = 'Flying bird';
  birdElement.appendChild(birdImg);
  
  birdElement.style.setProperty('--bird-y', birdData.y + 'px');
  birdElement.classList.add(birdData.direction, 'single');
  
  // Calculate animation delay based on remaining time
  const animationProgress = (birdData.duration - birdData.remainingTime) / birdData.duration;
  birdElement.style.animationDelay = -(15 * animationProgress) + 's';
  
  document.body.appendChild(birdElement);
  
  // Update bird data with corrected start time
  const correctedBirdData = {
    ...birdData,
    startTime: Date.now() - (birdData.duration - birdData.remainingTime)
  };
  activeBirds.push(correctedBirdData);
  
  // Remove bird after remaining time
  setTimeout(() => {
    if (birdElement.parentNode) {
      birdElement.parentNode.removeChild(birdElement);
    }
    activeBirds = activeBirds.filter(bird => bird.id !== birdData.id);
  }, birdData.remainingTime);
}

// 3D Tilt Effect
function init3DTiltEffect() {
  applyTiltEffect('.advantages');
  applyTiltEffect('.faq');
  
  // Apply to contact cards with staggered delay
  const contactCards = document.querySelectorAll('.contact-card');
  contactCards.forEach((card, index) => {
    applyTiltEffectToElement(card);
  });
}

function applyTiltEffect(selector) {
  const element = document.querySelector(selector);
  if (element) {
    applyTiltEffectToElement(element);
  }
}

function applyTiltEffectToElement(element) {
  let isMouseOver = false;
  
  element.addEventListener('mouseenter', function() {
    isMouseOver = true;
  });
  
  element.addEventListener('mouseleave', function() {
    isMouseOver = false;
    element.style.transform = 'rotateX(0deg) rotateY(0deg)';
  });
  
  element.addEventListener('mousemove', function(e) {
    if (!isMouseOver) return;
    
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    
    const mouseX = e.clientX - centerX;
    const mouseY = e.clientY - centerY;
    
    const rotateX = -(8 * (mouseY / (rect.height / 2)));
    const rotateY = 8 * (mouseX / (rect.width / 2));
    
    element.style.transform = `rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
  });
}

// User Information Popup System
function initRolePopup() {
  const userInfoCompleted = localStorage.getItem('userInfoCompleted');
  
  if (!userInfoCompleted) {
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
        const role = this.getAttribute('data-role');
        handleRoleSelection(role);
      });
    });
  }
  
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
        const referral = this.getAttribute('data-referral');
        handleReferralSelection(referral);
      });
    });
  }
  
  // Show email popup immediately (no delay)
  showEmailPopup();
}

function showEmailPopup() {
  const popup = document.getElementById('email-popup');
  if (popup) {
    popup.classList.remove('hidden');
    
    // Skip button
    const skipButton = document.getElementById('skip-email');
    if (skipButton) {
      skipButton.addEventListener('click', function() {
        handleEmailSubmission('');
      });
    }
    
    // Submit button
    const submitButton = document.getElementById('submit-email');
    if (submitButton) {
      submitButton.addEventListener('click', function() {
        const emailInput = document.getElementById('user-email');
        const email = emailInput ? emailInput.value.trim() : '';
        handleEmailSubmission(email);
      });
      
      // Email validation
      const emailInput = document.getElementById('user-email');
      if (emailInput) {
        emailInput.addEventListener('input', function() {
          const email = this.value.trim();
          const isValid = email.includes('@') && email.includes('.');
          submitButton.disabled = !isValid;
        });
        
        // Initially disable submit button
        submitButton.disabled = true;
      }
    }
    
    // Enter key handler
    const emailInput = document.getElementById('user-email');
    if (emailInput) {
      emailInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
          const email = this.value.trim();
          const isValid = email.includes('@') && email.includes('.');
          if (isValid) {
            handleEmailSubmission(email);
          }
        }
      });
    }
  }
}

function handleRoleSelection(role) {
  localStorage.setItem('userRole', role);
  localStorage.setItem('roleSelectedAt', new Date().toISOString());
  showReferralPopup();
}

function handleReferralSelection(referral) {
  localStorage.setItem('userReferralSource', referral);
  localStorage.setItem('referralSelectedAt', new Date().toISOString());
  showEmailPopup();
}

function handleEmailSubmission(email) {
  localStorage.setItem('userEmail', email);
  localStorage.setItem('emailSubmittedAt', new Date().toISOString());
  localStorage.setItem('userInfoCompleted', 'true');
  
  // Log contact information
  const userRole = localStorage.getItem('userRole') || '';
  const referralSource = localStorage.getItem('userReferralSource') || '';
  const userAgent = navigator.userAgent;
  
  fetch('/api/log-contact', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
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
      console.log('Contact logged successfully');
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
  
  // Customize experience based on role
  customizeExperienceForRole(userRole);
}

function customizeExperienceForRole(role) {
  document.body.setAttribute('data-user-role', role);
}