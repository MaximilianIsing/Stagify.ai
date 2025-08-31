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
    original: 'https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?q=80&w=1600&auto=format&fit=crop',
    modern: 'https://images.unsplash.com/photo-1524758631624-e2822e304c36?q=80&w=1600&auto=format&fit=crop',
    scandinavian: 'https://images.unsplash.com/photo-1505691938895-1758d7feb511?q=80&w=1600&auto=format&fit=crop',
    luxury: 'https://images.unsplash.com/photo-1505692794403-34d4982f88aa?q=80&w=1600&auto=format&fit=crop'
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
  

  // Stage screen elements
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

  processBtn?.addEventListener('click', stageImage);
  modalBackdrop?.addEventListener('click', closeModal);
  modalClose?.addEventListener('click', closeModal);

  downloadBtn?.addEventListener('click', () => {
    if (!canvas1.width) return;
    const link = document.createElement('a');
    link.download = 'stagedly-result.png';
    link.href = canvas1.toDataURL('image/png');
    link.click();
  });

  newUploadBtn?.addEventListener('click', () => {
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


