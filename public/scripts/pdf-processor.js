// PDF Processor for Stagify.ai
// Handles PDF upload, processing, and download using the Stagify Project Imagination server
// Uses local proxy endpoints to avoid CORS issues

const SERVER_URL = "/api/process-pdf";
const HEALTH_URL = "/api/pdf-health";

// DOM elements
let pdfDropzone, pdfFileInput, pdfOptions, processPdfBtn;
let pdfProgress, pdfProgressBar, pdfProgressText;
let pdfStatus, pdfStatusMessage;
let pdfResult, downloadPdfBtn, newPdfUploadBtn;
let skipPagesInput, concurrencyInput, dpiInput;
let currentPdfFile = null;
let processedPdfBlob = null;

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
  initializeElements();
  setupEventListeners();
});

function initializeElements() {
  pdfDropzone = document.getElementById('pdf-dropzone');
  pdfFileInput = document.getElementById('pdf-file-input');
  pdfOptions = document.getElementById('pdf-options');
  processPdfBtn = document.getElementById('process-pdf-btn');
  pdfProgress = document.getElementById('pdf-progress');
  pdfProgressBar = document.getElementById('pdf-progress-bar');
  pdfProgressText = document.getElementById('pdf-progress-text');
  pdfStatus = document.getElementById('pdf-status');
  pdfStatusMessage = document.getElementById('pdf-status-message');
  pdfResult = document.getElementById('pdf-result');
  downloadPdfBtn = document.getElementById('download-pdf-btn');
  newPdfUploadBtn = document.getElementById('new-pdf-upload');
  skipPagesInput = document.getElementById('skip-pages');
  concurrencyInput = document.getElementById('concurrency');
  dpiInput = document.getElementById('dpi');
}

function setupEventListeners() {
  // File input change
  if (pdfFileInput) {
    pdfFileInput.addEventListener('change', handleFileSelect);
  }

  // Dropzone click
  if (pdfDropzone) {
    pdfDropzone.addEventListener('click', () => {
      if (pdfFileInput) pdfFileInput.click();
    });

    pdfDropzone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (pdfFileInput) pdfFileInput.click();
      }
    });

    // Drag and drop
    ['dragenter', 'dragover'].forEach(eventName => {
      pdfDropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        pdfDropzone.style.borderColor = '#2563eb';
      });
    });

    ['dragleave', 'drop'].forEach(eventName => {
      pdfDropzone.addEventListener(eventName, (e) => {
        e.preventDefault();
        pdfDropzone.style.borderColor = '#e5e7eb';
      });
    });

    pdfDropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (file) handleFile(file);
    });
  }

  // Process button
  if (processPdfBtn) {
    processPdfBtn.addEventListener('click', processPDF);
  }

  // Download button
  if (downloadPdfBtn) {
    downloadPdfBtn.addEventListener('click', downloadProcessedPDF);
  }

  // New upload button
  if (newPdfUploadBtn) {
    newPdfUploadBtn.addEventListener('click', resetUpload);
  }
}

function handleFileSelect(e) {
  const file = e.target.files?.[0];
  if (file) handleFile(file);
}

function handleFile(file) {
  // Validate file type
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    showError(getText('pdf.errors.invalidFileType') || 'Please upload a PDF file.');
    return;
  }

  // Validate file size (100MB limit)
  if (file.size > 100 * 1024 * 1024) {
    showError(getText('pdf.errors.fileTooLarge') || 'File is too large. Please upload a PDF smaller than 100MB.');
    return;
  }

  currentPdfFile = file;
  processedPdfBlob = null;

  // Update UI
  if (pdfDropzone) {
    pdfDropzone.classList.add('hidden');
  }

  if (pdfOptions) {
    pdfOptions.classList.remove('hidden');
  }

  if (pdfResult) {
    pdfResult.classList.add('hidden');
  }

  if (pdfStatus) {
    pdfStatus.classList.add('hidden');
  }

  // Show file name
  showStatus(getText('pdf.status.fileReady') || `File ready: ${file.name}`, 'success');
}

async function processPDF() {
  if (!currentPdfFile) {
    showError(getText('pdf.errors.noFile') || 'Please upload a PDF file first.');
    return;
  }

  // Disable process button
  if (processPdfBtn) {
    processPdfBtn.disabled = true;
  }

  // Show progress
  if (pdfProgress) {
    pdfProgress.classList.remove('hidden');
  }

  // Hide result and status
  if (pdfResult) {
    pdfResult.classList.add('hidden');
  }
  if (pdfStatus) {
    pdfStatus.classList.add('hidden');
  }

  // Reset progress
  updateProgress(0, getText('pdf.progress.uploading') || 'Uploading PDF…');

  try {
    // Build query parameters
    const params = new URLSearchParams();
    const skip = skipPagesInput?.value || '4';
    const concurrency = concurrencyInput?.value || '2';
    const dpi = dpiInput?.value || '110';

    params.append('skip', skip);
    params.append('concurrency', concurrency);
    params.append('dpi', dpi);

    const url = `${SERVER_URL}?${params.toString()}`;

    // Create form data
    const formData = new FormData();
    formData.append('pdf', currentPdfFile);

    // Simulate progress updates
    const progressInterval = simulateProgress();

    // Upload and process
    updateProgress(10, getText('pdf.progress.uploading') || 'Uploading PDF…');
    
    const response = await fetch(url, {
      method: 'POST',
      body: formData,
    });

    clearInterval(progressInterval);

    // Check content type to determine if it's an error or PDF
    const contentType = response.headers.get('content-type') || '';
    
    if (!response.ok) {
      // Try to parse as JSON error
      const errorData = await response.json().catch(() => ({ 
        error: `Server error: ${response.status}` 
      }));
      throw new Error(errorData.message || errorData.error || `Server error: ${response.status}`);
    }

    // Check if response is JSON (error) or PDF
    if (contentType.includes('application/json')) {
      const errorData = await response.json();
      throw new Error(errorData.message || errorData.error || 'Processing failed');
    }

    updateProgress(90, getText('pdf.progress.processing') || 'Processing PDF…');

    // Get the PDF blob (response is already a PDF from the proxy)
    const pdfBlob = await response.blob();
    processedPdfBlob = pdfBlob;

    updateProgress(100, getText('pdf.progress.complete') || 'Complete!');

    // Show success
    setTimeout(() => {
      if (pdfProgress) {
        pdfProgress.classList.add('hidden');
      }
      if (pdfResult) {
        pdfResult.classList.remove('hidden');
      }
      if (processPdfBtn) {
        processPdfBtn.disabled = false;
      }
    }, 500);

  } catch (error) {
    console.error('Error processing PDF:', error);
    showError(error.message || getText('pdf.errors.processingFailed') || 'Processing failed. Please try again.');
    
    if (pdfProgress) {
      pdfProgress.classList.add('hidden');
    }
    if (processPdfBtn) {
      processPdfBtn.disabled = false;
    }
  }
}

function simulateProgress() {
  let progress = 10;
  return setInterval(() => {
    if (progress < 85) {
      progress += Math.random() * 5;
      progress = Math.min(progress, 85);
      updateProgress(progress, getText('pdf.progress.processing') || 'Processing PDF…');
    }
  }, 2000);
}

function updateProgress(percentage, text) {
  if (pdfProgressBar) {
    pdfProgressBar.style.width = `${percentage}%`;
  }
  if (pdfProgressText) {
    pdfProgressText.textContent = text || '';
  }
}

function downloadProcessedPDF() {
  if (!processedPdfBlob) {
    showError(getText('pdf.errors.noProcessedFile') || 'No processed PDF available.');
    return;
  }

  // Create download link
  const url = window.URL.createObjectURL(processedPdfBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `processed-${currentPdfFile?.name || 'floorplan.pdf'}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.URL.revokeObjectURL(url);
}

function resetUpload() {
  currentPdfFile = null;
  processedPdfBlob = null;

  if (pdfFileInput) {
    pdfFileInput.value = '';
  }

  if (pdfDropzone) {
    pdfDropzone.classList.remove('hidden');
  }

  if (pdfOptions) {
    pdfOptions.classList.add('hidden');
  }

  if (pdfResult) {
    pdfResult.classList.add('hidden');
  }

  if (pdfStatus) {
    pdfStatus.classList.add('hidden');
  }

  if (pdfProgress) {
    pdfProgress.classList.add('hidden');
  }
}

function showError(message) {
  showStatus(message, 'error');
}

function showStatus(message, type = 'info') {
  if (!pdfStatus || !pdfStatusMessage) return;

  pdfStatus.classList.remove('hidden');
  pdfStatusMessage.textContent = message;
  pdfStatusMessage.className = `pdf-status-message ${type}`;
}

function getText(key) {
  // Try to get text from language system
  if (window.LanguageSystem && window.LanguageSystem.getText) {
    return window.LanguageSystem.getText(key);
  }
  return null;
}

// Check server health on load
async function checkServerHealth() {
  try {
    const response = await fetch(HEALTH_URL);
    const data = await response.json();
    console.log('Server status:', data);
    return data.status === 'ok' || data.status === 'healthy';
  } catch (error) {
    console.error('Server health check failed:', error);
    return false;
  }
}

// Check server health when page loads
document.addEventListener('DOMContentLoaded', () => {
  checkServerHealth().then(isHealthy => {
    if (!isHealthy) {
      console.warn('PDF processing server may be unavailable');
    }
  });
});

