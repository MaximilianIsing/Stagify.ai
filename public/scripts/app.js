(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const results = $('#results');
  const canvas1 = $('#canvas1');
  const downloadBtn = $('#download-btn');
  const newUploadBtn = $('#new-upload');

  const heroUpload = $('#hero-upload');
  const navUpload = $('#nav-upload');
  const pricingUpload = $('#pricing-upload');
  const trySample = $('#try-sample');
  // Hero tabs switching image
  const styleToImg = {
    original: 'media/example/Original.png',
    modern: 'media/example/Modern.png',
    scandinavian: 'media/example/Scandinavian.png',
    luxury: 'media/example/Luxury.png',
    coastal: 'media/example/Coastal.png',
    midcentury: 'media/example/Midcentury.png',
    farmhouse: 'media/example/Farmhouse.png'
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
  const toolRemove = $('#tool-remove');
  const toolAdd = $('#tool-add');
  // Custom selects
  const roomSelect = initCustomSelect('#room-type-select');
  const styleSelect = initCustomSelect('#furniture-style-select');
  const progress = $('#progress');
  const progressBar = $('#progress-bar');
  const progressText = $('#progress-text');

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

  function handleStageFile(file) {
    if (!file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      stagePreview.src = reader.result;
      stagePreview.classList.remove('hidden');
      $('.stage-dz-inner').classList.add('hidden');
      results.classList.add('hidden');
    };
    reader.readAsDataURL(file);
  }

  // Simple mock processing pipeline
  async function mockProcess() {
    progress.classList.remove('hidden');
    progressBar.style.width = '0%';
    progressText.textContent = 'Uploading image…';
    await sleep(400);
    progressBar.style.width = '20%';
    progressText.textContent = 'Preparing model…';
    await sleep(500);
    progressBar.style.width = '45%';
    progressText.textContent = 'Detecting room layout…';
    await sleep(800);
    progressBar.style.width = '70%';
    progressText.textContent = 'Adding furniture (' + getSelectedPreset() + ')…';
    await sleep(900);
    progressBar.style.width = '100%';
    progressText.textContent = 'Finalizing…';
    await sleep(300);
  }

  function getSelectedPreset() {
    const val = styleSelect?.value || 'standard';
    return val;
  }

  function applyPresetToCanvas(ctx, img, preset) {
    const w = img.width, h = img.height;
    ctx.canvas.width = w; ctx.canvas.height = h;
    ctx.drawImage(img, 0, 0, w, h);
    // Stylize to imply different furniture styles (visual hint only)
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;
    const adjust = {
      original: { c: 1.0, b: 1.0, s: 1.0 },
      modern: { c: 1.1, b: 1.05, s: 1.0 },
      midcentury: { c: 1.08, b: 1.02, s: 1.0 },
      scandinavian: { c: 0.98, b: 1.06, s: 0.92 },
      luxury: { c: 1.18, b: 1.02, s: 1.0 },
      coastal: { c: 1.02, b: 1.08, s: 1.05 },
      farmhouse: { c: 1.04, b: 1.03, s: 0.98 }
    }[preset] || { c: 1.0, b: 1.0, s: 1.0 };

    // Very lightweight brightness/contrast-ish tweak
    const contrast = adjust.c, brightness = adjust.b;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = clamp((data[i] - 128) * contrast + 128 * brightness);
      data[i+1] = clamp((data[i+1] - 128) * contrast + 128 * brightness);
      data[i+2] = clamp((data[i+2] - 128) * contrast + 128 * brightness);
    }
    ctx.putImageData(imageData, 0, 0);
  }

  function clamp(v) { return Math.max(0, Math.min(255, v)); }

  function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

  async function stageImage() {
    if (!stagePreview.src) return;
    processBtn.disabled = true;
    await mockProcess();

    const img = new Image();
    img.onload = () => {
      const preset = getSelectedPreset();
      const ctx1 = canvas1.getContext('2d');
      applyPresetToCanvas(ctx1, img, preset);

      results.classList.remove('hidden');
      progress.classList.add('hidden');
      processBtn.disabled = false;
    };
    img.src = stagePreview.src;
    processBtn.disabled = false;
  }

  // Only add modal event listeners if elements exist
  if (processBtn) processBtn.addEventListener('click', stageImage);
  if (modalBackdrop) modalBackdrop.addEventListener('click', closeModal);
  if (modalClose) modalClose.addEventListener('click', closeModal);

  if (downloadBtn) downloadBtn.addEventListener('click', () => {
    if (!canvas1.width) return;
    const link = document.createElement('a');
    link.download = 'stagedly-result.png';
    link.href = canvas1.toDataURL('image/png');
    link.click();
  });

  if (newUploadBtn) newUploadBtn.addEventListener('click', () => {
    stagePreview.src = '';
    stagePreview.classList.add('hidden');
    $('.stage-dz-inner').classList.remove('hidden');
    results.classList.add('hidden');
    stageFileInput.value = '';
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

// City Skyline Generator
function generateCitySkyline() {
  
  // Remove existing skyline if it exists
  const existingSkyline = document.querySelector('.city-skyline');
  if (existingSkyline) {
    existingSkyline.remove();
  }

  // Create skyline container
  const skyline = document.createElement('div');
  skyline.className = 'city-skyline';
  
  // Add skyline as background layer
  document.body.appendChild(skyline);

  const containerWidth = window.innerWidth;
  const containerHeight = 500;
  let currentX = 0;

  // Generate buildings
  let buildingCount = 0;
  while (currentX < containerWidth) {
    const building = createBuilding(currentX, containerWidth - currentX, buildingCount);
    skyline.appendChild(building);
    currentX += building.offsetWidth + seededRandom(buildingCount * 0.2) * 20; // Consistent spacing between buildings
    buildingCount++;
  }
  

  // Add windows to buildings
  addWindowsToBuildings();
}

// Session-based seeded random number generator for consistent skyline
let sessionSeed;

// Get or create session seed that persists across page navigation
if (sessionStorage.getItem('skylineSeed')) {
  sessionSeed = parseFloat(sessionStorage.getItem('skylineSeed'));
} else {
  sessionSeed = Math.random() * 1000;
  sessionStorage.setItem('skylineSeed', sessionSeed.toString());
}

function seededRandom(seed) {
  const x = Math.sin(seed + sessionSeed) * 10000;
  return x - Math.floor(x);
}

function createBuilding(x, maxWidth, buildingIndex) {
  const building = document.createElement('div');
  building.className = 'building';
  
  // Use building index as seed for consistent randomization
  const seed = buildingIndex * 0.1;
  
  // NYC-style building dimensions with consistent variety
  const width = seededRandom(seed) * 60 + 30; // 30-90px wide (narrower for NYC feel)
  
  // Create varied heights like NYC skyline
  let height;
  const heightType = seededRandom(seed + 1);
  if (heightType < 0.1) {
    // 10% chance for very tall buildings (like Empire State)
    height = seededRandom(seed + 2) * 200 + 300; // 300-500px
  } else if (heightType < 0.3) {
    // 20% chance for tall buildings
    height = seededRandom(seed + 3) * 150 + 200; // 200-350px
  } else if (heightType < 0.6) {
    // 30% chance for medium buildings
    height = seededRandom(seed + 4) * 100 + 120; // 120-220px
  } else {
    // 40% chance for shorter buildings
    height = seededRandom(seed + 5) * 80 + 60; // 60-140px
  }
  
  building.style.left = x + 'px';
  building.style.width = width + 'px';
  building.style.height = height + 'px';
  
  return building;
}

function addWindowsToBuildings() {
  const buildings = document.querySelectorAll('.building');
  
  buildings.forEach((building, index) => {
    const buildingRect = building.getBoundingClientRect();
    const buildingWidth = buildingRect.width;
    const buildingHeight = buildingRect.height;
    
    // NYC-style window patterns
    const buildingHeightPx = building.offsetHeight;
    
    if (buildingHeightPx > 300) {
      // Very tall buildings - dense window grid
      addDenseWindows(building, buildingWidth, buildingHeightPx, index);
    } else if (buildingHeightPx > 200) {
      // Tall buildings - regular window grid
      addRegularWindows(building, buildingWidth, buildingHeightPx, index);
    } else {
      // Shorter buildings - sparse windows
      addSparseWindows(building, buildingWidth, buildingHeightPx, index);
    }
  });
}

function addDenseWindows(building, width, height, buildingIndex) {
  const windowSize = 3;
  const windowSpacing = 6;
  const columns = Math.floor(width / windowSpacing);
  const rows = Math.floor(height / windowSpacing);
  
  for (let row = 2; row < rows - 2; row++) {
    for (let col = 1; col < columns - 1; col++) {
      const windowSeed = buildingIndex * 100 + row * 10 + col;
      if (seededRandom(windowSeed) > 0.2) { // 80% chance of window
        addWindow(building, col * windowSpacing, row * windowSpacing, windowSize, windowSeed);
      }
    }
  }
}

function addRegularWindows(building, width, height, buildingIndex) {
  const windowSize = 4;
  const windowSpacing = 8;
  const columns = Math.floor(width / windowSpacing);
  const rows = Math.floor(height / windowSpacing);
  
  for (let row = 1; row < rows - 1; row++) {
    for (let col = 1; col < columns - 1; col++) {
      const windowSeed = buildingIndex * 100 + row * 10 + col;
      if (seededRandom(windowSeed) > 0.3) { // 70% chance of window
        addWindow(building, col * windowSpacing, row * windowSpacing, windowSize, windowSeed);
      }
    }
  }
}

function addSparseWindows(building, width, height, buildingIndex) {
  const windowSize = 4;
  const windowSpacing = 10;
  const columns = Math.floor(width / windowSpacing);
  const rows = Math.floor(height / windowSpacing);
  
  for (let row = 1; row < rows - 1; row++) {
    for (let col = 1; col < columns - 1; col++) {
      const windowSeed = buildingIndex * 100 + row * 10 + col;
      if (seededRandom(windowSeed) > 0.5) { // 50% chance of window
        addWindow(building, col * windowSpacing, row * windowSpacing, windowSize, windowSeed);
      }
    }
  }
}

function addWindow(building, x, y, size, windowSeed) {
  const window = document.createElement('div');
  window.className = 'window';
  
  window.style.left = x + 'px';
  window.style.top = y + 'px';
  window.style.width = size + 'px';
  window.style.height = size + 'px';
  
  // More realistic lighting patterns with consistent randomization
  const lightingChance = seededRandom(windowSeed + 1000);
  const lightingType = seededRandom(windowSeed + 2000);
  
  if (lightingChance < 0.25) {
    // 25% chance of lit windows with different types
    if (lightingType < 0.4) {
      window.classList.add('lit'); // Standard yellow
    } else if (lightingType < 0.7) {
      window.classList.add('bright'); // Bright white
    } else if (lightingType < 0.85) {
      window.classList.add('warm'); // Warm orange
    } else {
      window.classList.add('cool'); // Cool blue
    }
  }
  
  building.appendChild(window);
}

// Generate skyline on page load (all pages)
document.addEventListener('DOMContentLoaded', function() {
  console.log('DOM loaded, generating skyline and birds on:', window.location.pathname);
  
  generateCitySkyline();
  
  // Regenerate on window resize
  window.addEventListener('resize', function() {
    generateCitySkyline();
  });
  
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
  birdImg.src = `media/Bird.gif?t=${randomParam}`;
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
    console.warn('Could not save birds to storage:', e);
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
    console.log(`Cleaned up ${initialCount - activeBirds.length} expired birds`);
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
    
    if (restoredCount > 0) {
      console.log(`Restored ${restoredCount} birds from previous page`);
    }
  } catch (e) {
    console.warn('Error restoring birds:', e);
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
  birdImg.src = `media/Bird.gif?t=${randomParam}`;
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


