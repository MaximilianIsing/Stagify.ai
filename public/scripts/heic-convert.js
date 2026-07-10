/*
 * Stagify HEIC support.
 *
 * Browsers other than Safari cannot decode HEIC/HEIF images, but our upload
 * flows show an instant preview and paint on a <canvas>, both of which need a
 * browser-decodable image. So when a user picks a HEIC file we convert it to a
 * JPEG in the browser first, then hand the JPEG to the normal pipeline.
 *
 * The converter (heic2any / libheif, ~1.3 MB) is loaded lazily — only the first
 * time someone actually selects a HEIC file — so JPEG/PNG uploads pay nothing.
 *
 * Public API (window.StagifyHeic):
 *   isHeic(file)            -> boolean
 *   toDisplayableFile(file) -> Promise<File>  (non-HEIC files pass through as-is)
 */
(function () {
  'use strict';

  var HEIC_EXT = /\.(heic|heif)$/i;
  var HEIC_TYPES = ['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence'];

  function isHeic(file) {
    if (!file) return false;
    var type = (file.type || '').toLowerCase();
    if (HEIC_TYPES.indexOf(type) !== -1) return true;
    // Some browsers report an empty or generic type for .heic files; fall back
    // to the filename extension in that case.
    if ((type === '' || type === 'application/octet-stream') && HEIC_EXT.test(file.name || '')) return true;
    return false;
  }

  var loaderPromise = null;
  function loadLibrary() {
    if (window.heic2any) return Promise.resolve(window.heic2any);
    if (loaderPromise) return loaderPromise;
    loaderPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'scripts/vendor/heic2any.min.js';
      s.async = true;
      s.onload = function () {
        if (window.heic2any) resolve(window.heic2any);
        else reject(new Error('heic2any failed to initialize'));
      };
      s.onerror = function () {
        loaderPromise = null; // allow a retry on the next attempt
        reject(new Error('Failed to load the HEIC converter'));
      };
      document.head.appendChild(s);
    });
    return loaderPromise;
  }

  // A minimal, self-contained "converting" toast so every call site gets user
  // feedback for free (HEIC decode can take a second or two on large photos).
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
    label.textContent = 'Converting photo…';
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

  var MIME_BY_KIND = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' };
  var EXT_BY_KIND = { jpeg: '.jpg', png: '.png', webp: '.webp', gif: '.gif', avif: '.avif' };

  // Identify a file by its real bytes, not its name/extension. Returns one of
  // 'heic' | 'jpeg' | 'png' | 'webp' | 'gif' | 'avif' | null. Files often lie
  // about their extension (e.g. a JPEG saved as ".heic"), so content wins.
  function sniff(bytes) {
    if (!bytes || bytes.length < 12) return null;
    var ascii = function (i, n) {
      var s = '';
      for (var j = i; j < i + n && j < bytes.length; j++) s += String.fromCharCode(bytes[j]);
      return s;
    };
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'jpeg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'png';
    if (ascii(0, 3) === 'GIF') return 'gif';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp';
    if (ascii(4, 4) === 'ftyp') {
      // Major brand + the compatible-brand list that follows it.
      var head = ascii(8, bytes.length - 8).toLowerCase();
      if (/avif|avis/.test(head)) return 'avif';               // AV1 — browsers decode natively
      if (/heic|heix|heim|heis|hevc|hevx|mif1|msf1/.test(head)) return 'heic';
      return 'heic'; // some other ISO-BMFF image; let the converter try
    }
    return null;
  }

  function readHeader(file) {
    if (file.slice && file.slice(0, 32).arrayBuffer) {
      return file.slice(0, 32).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
    }
    return Promise.resolve(null);
  }

  function convertHeic(file, quality) {
    showToast();
    return loadLibrary()
      .then(function (convert) {
        return convert({ blob: file, toType: 'image/jpeg', quality: quality });
      })
      .then(function (result) {
        var blob = Array.isArray(result) ? result[0] : result;
        var baseName = (file.name || 'photo').replace(HEIC_EXT, '');
        return new File([blob], baseName + '.jpg', {
          type: 'image/jpeg',
          lastModified: (file.lastModified || 0) || undefined
        });
      })
      .finally(hideToast);
  }

  // Return a File the browser can decode. Only trips for files that look like
  // HEIC by type/extension; genuine HEIC is converted, while a mislabeled file
  // (real JPEG/PNG/etc. with a .heic name) is simply re-tagged so it passes
  // validation and preview without a pointless conversion.
  function toDisplayableFile(file, opts) {
    if (!isHeic(file)) return Promise.resolve(file);
    var quality = (opts && typeof opts.quality === 'number') ? opts.quality : 0.92;
    return readHeader(file).then(function (bytes) {
      var kind = sniff(bytes);
      if (kind && kind !== 'heic') {
        // Already a decodable image — just correct the MIME/extension.
        var mime = MIME_BY_KIND[kind];
        var alreadyOk = (file.type || '').toLowerCase() === mime && !HEIC_EXT.test(file.name || '');
        if (alreadyOk) return file;
        var base = (file.name || 'photo').replace(/\.[^.]+$/, '');
        return new File([file], base + EXT_BY_KIND[kind], {
          type: mime,
          lastModified: (file.lastModified || 0) || undefined
        });
      }
      // Genuine HEIC (or an unknown ISO-BMFF image) — convert it.
      return convertHeic(file, quality);
    });
  }

  window.StagifyHeic = { isHeic: isHeic, toDisplayableFile: toDisplayableFile };
})();

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
