(() => {
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
        img.src = styleToImg[style];
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
  // Custom selects
  const roomSelect = initCustomSelect('#room-type-select');
  const styleSelect = initCustomSelect('#furniture-style-select');
  const progress = $('#progress');
  const progressBar = $('#progress-bar');
  const progressText = $('#progress-text');
  const loadingMessage = $('#loading-message');
  const loadingAdContainer = $('#loading-ad-container');

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
      alert('Please upload a PNG, JPG, JPEG, WebP, or GIF image file.');
      return;
    }
    
    // Check file size (100MB limit)
    const maxSize = 100 * 1024 * 1024; // 100MB in bytes
    if (file.size > maxSize) {
      alert('File is too large. Please upload an image smaller than 100MB.');
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
    progressText.textContent = 'Uploading image…';

    // Show loading message and ad immediately
    loadingMessage.classList.remove('hidden');
    loadingMessage.textContent = 'Preparing AI model';
    
    // Show ad container in workspace and initialize AdSense
    if (loadingAdContainer) {
      loadingAdContainer.classList.remove('hidden');
      // Hide the processing placeholder while ad is showing
      if (processingPlaceholder) {
        processingPlaceholder.style.display = 'none';
      }
      // Initialize your AdSense ad
      try {
        (adsbygoogle = window.adsbygoogle || []).push({});
      } catch (e) {
        console.log('AdSense not loaded yet');
      }
    }

    // Random loading messages that will be shown during AI processing
    const loadingMessages = [
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
      
      // Get user role from localStorage
      const userRole = localStorage.getItem('userRole') || 'unknown';
      formData.append('userRole', userRole);
      
      // Simulate upload progress
      await new Promise(resolve => setTimeout(resolve, 800));
      clearInterval(progressInterval);
      currentProgress = 25;
      progressBar.style.width = '25%';
      progressText.textContent = 'Preparing AI model…';
      
      // Start dynamic message cycling after preparation
      setTimeout(() => {
        isProcessingPhase = true;
        progressText.textContent = 'AI is staging your room…';
        
        // Start cycling through the loading messages
        messageInterval = setInterval(() => {
          if (isProcessingPhase) {
            const randomMessage = loadingMessages[Math.floor(Math.random() * loadingMessages.length)];
            loadingMessage.textContent = randomMessage;
          }
        }, 2000);
        
        // Set first AI message immediately
        const randomMessage = loadingMessages[Math.floor(Math.random() * loadingMessages.length)];
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
      progressText.textContent = 'AI is staging your room…';
      
      if (!response.ok) {
        const errorData = await response.json();
        if (errorData.code === 'FILE_TOO_LARGE') {
          throw new Error('File is too large. Please upload an image smaller than 100MB.');
        }
        throw new Error(errorData.message || errorData.error || 'Processing failed');
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
      
      // Hide ad container when processing is complete
      if (loadingAdContainer) {
        loadingAdContainer.classList.add('hidden');
      }
      // Show processing placeholder again if needed
      if (processingPlaceholder && !hasProcessedImage) {
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
      // Clear any running intervals
      clearInterval(progressInterval);
      clearInterval(messageInterval);
      isProcessingPhase = false;
      loadingMessage.classList.add('hidden');
      
      // Hide ad container when processing is complete
      if (loadingAdContainer) {
        loadingAdContainer.classList.add('hidden');
      }
      // Show processing placeholder again if needed
      if (processingPlaceholder && !hasProcessedImage) {
        processingPlaceholder.style.display = 'flex';
      }
      
      progressText.textContent = 'Error: ' + error.message;
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
      alert('Please upload an image first');
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
        
        // Hide placeholder and show result
        processingPlaceholder.style.display = 'none';
        
        // Automatically switch to "After" view to show the result
        showAfterView();
        
        progress.classList.add('hidden');
        processBtn.disabled = false;
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
  
  // Start bird animations on all pages
  startBirdAnimations();
  
  // Initialize 3D tilt effect for advantages section and contact cards
  init3DTiltEffect();
});

// Bird Animation System with persistence
let birdInterval;
let cleanupInterval;
let activeBirds = [];
const MAX_BIRDS = 3; // Limit concurrent birds to prevent performance issues
const CLEANUP_INTERVAL = 30000; // Clean up every 30 seconds

function startBirdAnimations() {
  // Clean up any existing intervals/listeners first
  cleanup();
  
  // Restore any existing birds from previous page
  restoreBirdsFromStorage();
  
  // Create birds very rarely
  birdInterval = setInterval(() => {
    // Only create new birds if we haven't hit the limit
    if (activeBirds.length < MAX_BIRDS && Math.random() > 0.6) {
      createBird();
    }
  }, 4000); // Check every 8 seconds
  
  // Create initial bird after a longer delay
  setTimeout(() => {
    if (activeBirds.length < MAX_BIRDS) {
      createBird();
    }
  }, 6000);
  
  // Regular cleanup of expired birds and storage
  cleanupInterval = setInterval(cleanupExpiredBirds, CLEANUP_INTERVAL);
  
  // Save bird states before page unload
  window.addEventListener('beforeunload', saveBirdsToStorage);
}

function cleanup() {
  // Clear existing intervals
  if (birdInterval) {
    clearInterval(birdInterval);
    birdInterval = null;
  }
  
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  
  // Remove existing event listeners
  window.removeEventListener('beforeunload', saveBirdsToStorage);
  
  // Clear any birds that might be left over
  const existingBirds = document.querySelectorAll('.bird');
  existingBirds.forEach(bird => bird.remove());
  
  // Reset active birds array
  activeBirds = [];
}

function createBird() {
  const birdId = 'bird_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  const bird = document.createElement('div');
  bird.className = 'bird';
  bird.id = birdId;
  
  // Create bird image
  const birdImg = document.createElement('img');
  // Add random parameter to force different GIF start times
  const randomParam = Math.random();
  birdImg.src = `media-webp/Bird.gif?t=${randomParam}`;
  birdImg.alt = 'Flying bird';
  
  bird.appendChild(birdImg);
  
  // Random bird properties
  const birdY = Math.random() * (window.innerHeight * 0.6) + 50; // Between 50px and 60% of viewport height
  bird.style.setProperty('--bird-y', birdY + 'px');
  
  // Random direction for individual birds
  const direction = Math.random() > 0.5 ? 'left-to-right' : 'right-to-left';
  bird.classList.add(direction, 'single');
  
  document.body.appendChild(bird);
  
  // Store bird info
  const birdInfo = {
    id: birdId,
    y: birdY,
    direction: direction,
    startTime: Date.now(),
    duration: 15000
  };
  
  activeBirds.push(birdInfo);
  
  // Remove bird after animation completes
  setTimeout(() => {
    if (bird.parentNode) {
      bird.parentNode.removeChild(bird);
    }
    // Remove from active birds array
    activeBirds = activeBirds.filter(b => b.id !== birdId);
  }, 15000);
}

function saveBirdsToStorage() {
  try {
    const currentTime = Date.now();
    const validBirds = activeBirds.filter(bird => {
      const elapsed = currentTime - bird.startTime;
      return elapsed < bird.duration && elapsed >= 0; // Only save birds that haven't finished their animation
    }).map(bird => ({
      ...bird,
      remainingTime: bird.duration - (currentTime - bird.startTime)
    }));
    
    // Only save if there are valid birds, otherwise clear storage
    if (validBirds.length > 0) {
      sessionStorage.setItem('stagify_birds', JSON.stringify(validBirds));
    } else {
      sessionStorage.removeItem('stagify_birds');
    }
  } catch (e) {
    // Handle sessionStorage quota exceeded or other errors
    sessionStorage.removeItem('stagify_birds');
  }
}

function cleanupExpiredBirds() {
  const currentTime = Date.now();
  const initialCount = activeBirds.length;
  
  // Remove expired birds from tracking
  activeBirds = activeBirds.filter(bird => {
    const elapsed = currentTime - bird.startTime;
    return elapsed < bird.duration;
  });
  
  // Clean up any orphaned bird elements
  const birdElements = document.querySelectorAll('.bird');
  birdElements.forEach(element => {
    const isTracked = activeBirds.some(bird => bird.id === element.id);
    if (!isTracked) {
      element.remove();
    }
  });
  
  // Clear old sessionStorage entries
  try {
    const stored = sessionStorage.getItem('stagify_birds');
    if (stored) {
      const birds = JSON.parse(stored);
      const validStored = birds.filter(bird => 
        bird.remainingTime > 0 && 
        (currentTime - (bird.startTime || 0)) < (bird.duration || 15000)
      );
      
      if (validStored.length === 0) {
        sessionStorage.removeItem('stagify_birds');
      }
    }
  } catch (e) {
    sessionStorage.removeItem('stagify_birds');
  }
  
  if (initialCount !== activeBirds.length) {
    // Cleanup completed
  }
}

function restoreBirdsFromStorage() {
  const savedBirds = sessionStorage.getItem('stagify_birds');
  if (!savedBirds) return;
  
  try {
    const birds = JSON.parse(savedBirds);
    let restoredCount = 0;
    
    // Validate and restore birds
    birds.forEach(birdInfo => {
      // Only restore valid birds with sufficient time left and within limits
      if (birdInfo && 
          birdInfo.remainingTime > 1000 && 
          birdInfo.remainingTime <= 15000 &&
          restoredCount < MAX_BIRDS &&
          activeBirds.length < MAX_BIRDS) {
        createRestoredBird(birdInfo);
        restoredCount++;
      }
    });
    
    // Clear the storage after restoring
    sessionStorage.removeItem('stagify_birds');
    
  } catch (e) {
    sessionStorage.removeItem('stagify_birds');
  }
}

function createRestoredBird(birdInfo) {
  const bird = document.createElement('div');
  bird.className = 'bird';
  bird.id = birdInfo.id;
  
  // Create bird image
  const birdImg = document.createElement('img');
  const randomParam = Math.random();
  birdImg.src = `media-webp/Bird.gif?t=${randomParam}`;
  birdImg.alt = 'Flying bird';
  
  bird.appendChild(birdImg);
  
  // Restore bird properties
  bird.style.setProperty('--bird-y', birdInfo.y + 'px');
  bird.classList.add(birdInfo.direction, 'single');
  
  // Calculate how far through the animation the bird should be
  const progress = (birdInfo.duration - birdInfo.remainingTime) / birdInfo.duration;
  const animationDelay = -progress * 15; // Negative delay to start partway through
  bird.style.animationDelay = animationDelay + 's';
  
  document.body.appendChild(bird);
  
  // Add to active birds with updated info
  const updatedBirdInfo = {
    ...birdInfo,
    startTime: Date.now() - (birdInfo.duration - birdInfo.remainingTime)
  };
  activeBirds.push(updatedBirdInfo);
  
  // Remove bird after remaining time
  setTimeout(() => {
    if (bird.parentNode) {
      bird.parentNode.removeChild(bird);
    }
    activeBirds = activeBirds.filter(b => b.id !== birdInfo.id);
  }, birdInfo.remainingTime);
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

// Role Selection Popup System
function initRolePopup() {
  // Check if user has already selected a role
  const hasSelectedRole = localStorage.getItem('userRole');
  
  if (!hasSelectedRole) {
    // Show popup after a short delay for better UX
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
  
  // Hide the popup
  const popup = document.getElementById('role-popup');
  if (popup) {
    popup.classList.add('hidden');
  }
  // You can add role-specific customizations here
  customizeExperienceForRole(role);
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


