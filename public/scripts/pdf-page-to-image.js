/*
 * Stagify PDF floor-plan support.
 *
 * Floor plans arrive as PDFs far more often than as images — it is how every CAD tool
 * exports, and it is what the homepage, the AI Designer's welcome message, and all 11
 * language packs have always promised ("turn CAD floor-plan PDFs into 3D room renders").
 *
 * The pipeline could never honor that. lib/chat/chat-upload-prep.js accepts
 * application/pdf and then reduces it to the literal string "[File: plan.pdf, Type:
 * application/pdf - Content cannot be directly read]" — it never becomes an image, never
 * gets a CAD: True annotation, and can never reach blueprintTo3D. There is no PDF→raster
 * step on the server and no PDF library in package.json.
 *
 * So we rasterize in the BROWSER, exactly the way scripts/heic-convert.js already handles
 * the other format the pipeline cannot read: lazily load a SELF-HOSTED vendor bundle the
 * first time someone actually picks a PDF (JPEG/PNG uploads pay nothing), show a small
 * progress toast, and hand a normal image File to the unchanged upload path. Self-hosting
 * is not optional — the site's CSP blocks external script hosts.
 *
 * Page 1 only, deliberately: a floor-plan PDF is one drawing, and a multi-page document
 * is not something this feature can act on anyway. The page is rendered at a scale that
 * targets TARGET_LONG_EDGE so the model gets legible dimension text off the drawing
 * without producing a 40 MB canvas from an architectural E-size sheet.
 *
 * Public API (window.StagifyPdf):
 *   isPdf(file)             -> boolean
 *   toDisplayableFile(file) -> Promise<File>  (non-PDF files pass through as-is)
 */
const PDF_EXT = /\.pdf$/i;
const PDF_TYPES = ['application/pdf', 'application/x-pdf'];

// Long edge of the rasterized page, in px. Big enough that dimension annotations and
// room labels survive for the vision model to read; small enough to stay well under the
// 25 MB per-file upload cap once PNG-encoded.
const TARGET_LONG_EDGE = 2000;
// Never scale a page up past this. A tiny PDF page is tiny because it holds little
// detail; enlarging it invents none and only costs bytes.
const MAX_SCALE = 4;

// isPdf / sniffPdf are pure and live at module scope so they can be unit-tested directly
// (test/frontend/pdf-page-to-image.test.js). The IIFE below uses them, and the browser
// API is unchanged (window.StagifyPdf).

/**
 * True if `file` looks like a PDF by MIME type, or by a .pdf extension when the browser
 * reports an empty/generic type. Pure over { type, name }.
 * @param {{ type?: string, name?: string } | null | undefined} file
 * @returns {boolean}
 */
export function isPdf(file) {
  if (!file) return false;
  var type = (file.type || '').toLowerCase();
  if (PDF_TYPES.indexOf(type) !== -1) return true;
  if ((type === '' || type === 'application/octet-stream') && PDF_EXT.test(file.name || '')) return true;
  return false;
}

/**
 * Identify a PDF by its real leading bytes rather than its name. Content wins because
 * files often lie about their extension — the same reasoning as heic-convert.js's sniff().
 * A file named .pdf that is really a PNG must not be sent to the PDF renderer.
 * @param {Uint8Array | null | undefined} bytes - The file's first few bytes.
 * @returns {boolean} True when the bytes begin with the %PDF- signature.
 */
export function sniffPdf(bytes) {
  if (!bytes || bytes.length < 5) return false;
  // %PDF-
  return bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2D;
}

/**
 * The scale to render at so the page's long edge lands near TARGET_LONG_EDGE, clamped so
 * a small page is never blown up past MAX_SCALE. Pure, so the clamping is testable
 * without a PDF.
 * @param {number} width - The page's natural width at scale 1.
 * @param {number} height - The page's natural height at scale 1.
 * @returns {number} The render scale.
 */
export function scaleForPage(width, height) {
  var longEdge = Math.max(width || 0, height || 0);
  if (!longEdge) return 1;
  return Math.min(MAX_SCALE, Math.max(1, TARGET_LONG_EDGE / longEdge));
}

(function () {
  'use strict';

  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  var loaderPromise = null;
  function loadLibrary() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (loaderPromise) return loaderPromise;
    loaderPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'scripts/vendor/pdf.min.js';
      s.async = true;
      s.onload = function () {
        if (window.pdfjsLib) {
          // The worker is vendored beside the library. Without this pdf.js reaches for a
          // CDN and the CSP kills it — which would look like "PDFs just hang".
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'scripts/vendor/pdf.worker.min.js';
          resolve(window.pdfjsLib);
        } else {
          reject(new Error('pdf.js failed to initialize'));
        }
      };
      s.onerror = function () {
        loaderPromise = null; // allow a retry on the next attempt
        reject(new Error('Failed to load the PDF reader'));
      };
      document.head.appendChild(s);
    });
    return loaderPromise;
  }

  // A minimal, self-contained toast so every call site gets user feedback for free.
  // Reuses heic-convert.js's keyframe when that module is also on the page (both inject
  // the same id), so the two never fight over one <style>.
  var toastEl = null;
  var toastCount = 0;
  function showToast() {
    toastCount++;
    if (toastEl) return;
    toastEl = document.createElement('div');
    toastEl.setAttribute('role', 'status');
    toastEl.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:24px', 'transform:translateX(-50%)',
      'z-index:2147483647', 'display:flex', 'align-items:center', 'gap:10px',
      'padding:12px 18px', 'border-radius:10px', 'background:rgba(17,24,39,.92)',
      'color:#fff', 'font-size:14px', 'font-weight:600',
      'font-family:inherit', 'box-shadow:0 8px 28px rgba(0,0,0,.28)',
      'pointer-events:none'
    ].join(';');
    var spin = document.createElement('span');
    spin.style.cssText = [
      'width:16px', 'height:16px', 'border-radius:50%',
      'border:2px solid rgba(255,255,255,.35)', 'border-top-color:#fff',
      'animation:stagify-heic-spin .8s linear infinite', 'flex:0 0 auto'
    ].join(';');
    if (!document.getElementById('stagify-heic-spin-style')) {
      var st = document.createElement('style');
      st.id = 'stagify-heic-spin-style';
      st.textContent = '@keyframes stagify-heic-spin{to{transform:rotate(360deg)}}';
      document.head.appendChild(st);
    }
    var label = document.createElement('span');
    label.textContent = 'Reading floor plan…';
    toastEl.appendChild(spin);
    toastEl.appendChild(label);
    document.body.appendChild(toastEl);
  }
  function hideToast() {
    toastCount = Math.max(0, toastCount - 1);
    if (toastCount === 0 && toastEl) {
      toastEl.remove();
      toastEl = null;
    }
  }

  function readHeader(file) {
    if (file.slice && file.slice(0, 8).arrayBuffer) {
      return file.slice(0, 8).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
    }
    return Promise.resolve(null);
  }

  function canvasToPngFile(canvas, baseName) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) {
          reject(new Error('Could not encode the floor plan page'));
          return;
        }
        resolve(new File([blob], baseName + '.png', { type: 'image/png' }));
      }, 'image/png');
    });
  }

  function renderFirstPage(file) {
    showToast();
    return loadLibrary()
      .then(function (pdfjsLib) {
        return file.arrayBuffer().then(function (buf) {
          return pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
        });
      })
      .then(function (doc) {
        // Page 1 only — a floor plan is one drawing.
        return doc.getPage(1).then(function (page) {
          var base = page.getViewport({ scale: 1 });
          var viewport = page.getViewport({ scale: scaleForPage(base.width, base.height) });
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.floor(viewport.width));
          canvas.height = Math.max(1, Math.floor(viewport.height));
          var ctx = canvas.getContext('2d');
          // PDF pages are transparent; a plan rasterized onto transparency reads as a
          // black drawing on black once flattened into a JPEG downstream.
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          return page.render({ canvasContext: ctx, viewport: viewport }).promise.then(function () {
            var baseName = (file.name || 'floor-plan').replace(PDF_EXT, '');
            return canvasToPngFile(canvas, baseName);
          }).finally(function () {
            // Free the backing store rather than waiting on GC — an E-size sheet at
            // 2000px is tens of MB of pixels.
            canvas.width = 0;
            canvas.height = 0;
          });
        }).finally(function () {
          if (doc && typeof doc.destroy === 'function') doc.destroy();
        });
      })
      .finally(hideToast);
  }

  /**
   * Return a File the pipeline can actually read. Only trips for files that look like a
   * PDF by type/extension; a genuine PDF becomes a PNG of page 1, while a mislabeled file
   * (a real image with a .pdf name) is passed straight through for the normal image path
   * to sort out — the same posture heic-convert.js takes.
   */
  function toDisplayableFile(file) {
    if (!isPdf(file)) return Promise.resolve(file);
    return readHeader(file).then(function (bytes) {
      // A null header (no File.slice, e.g. a synthetic file) is not evidence of anything,
      // so fall through and let pdf.js decide; only a positive non-PDF sniff opts out.
      if (bytes && !sniffPdf(bytes)) return file;
      return renderFirstPage(file);
    });
  }

  window.StagifyPdf = { isPdf: isPdf, toDisplayableFile: toDisplayableFile };
})();
