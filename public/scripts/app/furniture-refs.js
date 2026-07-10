// Furniture reference photos island for the main Stagify tool (scripts/app.js).
//
// Owns the pro "furniture reference photos" picker: the hidden file input, the
// row list + hover preview popover, the 5-photo cap, and drag-and-drop onto
// the add button. Lifted verbatim from the entry into a factory that owns its
// state; the entry reads the accumulated files via getFiles() and clears them
// via reset(). Stays a working no-op API on pages without the elements.
//
// deps: { getStagingAlt }
import { abbreviateFileName } from './helpers.js';

export const FURNITURE_LIMIT = 5;

export function createFurnitureRefs(deps) {
  const { getStagingAlt } = deps;

    const furnitureFileInput = /** @type {HTMLInputElement} */ (document.getElementById('stagify-furniture-file'));
    const furnitureList = document.getElementById('stagify-furniture-list');
    const furnitureAddBtn = document.getElementById('stagify-furniture-add-btn');
    let accumulatedFurnitureFiles = [];
    let furniturePreviewUrls = [];
    let furniturePreviewEl = null;
    const FURNITURE_NAME_MAX = 40;

    function getFurniturePreviewEl() {
      if (furniturePreviewEl) return furniturePreviewEl;
      furniturePreviewEl = document.createElement('div');
      furniturePreviewEl.id = 'furniture-image-preview';
      furniturePreviewEl.className = 'furniture-image-preview hidden';
      furniturePreviewEl.setAttribute('aria-hidden', 'true');
      var img = document.createElement('img');
      img.alt = '';
      furniturePreviewEl.appendChild(img);
      document.body.appendChild(furniturePreviewEl);
      return furniturePreviewEl;
    }

    function hideFurniturePreview() {
      var pop = getFurniturePreviewEl();
      pop.classList.add('hidden');
      pop.setAttribute('aria-hidden', 'true');
    }

    function showFurniturePreview(previewUrl, anchorEl, filename) {
      if (!previewUrl || !anchorEl) return;
      var pop = getFurniturePreviewEl();
      var img = pop.querySelector('img');
      img.src = previewUrl;
      img.alt = getStagingAlt('furnitureReferenceAlt', { filename: filename || 'furniture photo' });
      pop.classList.remove('hidden');
      pop.setAttribute('aria-hidden', 'false');
      var rect = anchorEl.getBoundingClientRect();
      var popW = 280;
      var popH = 280;
      var left = rect.right + 10;
      var top = rect.top + rect.height / 2 - popH / 2;
      if (left + popW > window.innerWidth - 8) {
        left = rect.left - popW - 10;
      }
      if (left < 8) left = 8;
      if (top < 8) top = 8;
      if (top + popH > window.innerHeight - 8) {
        top = window.innerHeight - popH - 8;
      }
      pop.style.left = left + 'px';
      pop.style.top = top + 'px';
    }

    function revokeFurniturePreviewUrls() {
      furniturePreviewUrls.forEach(function (u) {
        if (u) URL.revokeObjectURL(u);
      });
      furniturePreviewUrls = [];
      hideFurniturePreview();
    }

    function syncFurniturePreviewUrls() {
      revokeFurniturePreviewUrls();
      furniturePreviewUrls = accumulatedFurnitureFiles.map(function (f) {
        return URL.createObjectURL(f);
      });
    }

    function updateFurnitureAddBtn() {
      if (!furnitureAddBtn) return;
      if (accumulatedFurnitureFiles.length >= FURNITURE_LIMIT) {
        furnitureAddBtn.classList.add('hidden');
      } else {
        furnitureAddBtn.classList.remove('hidden');
      }
    }

    function renderFurnitureList() {
      if (!furnitureList) return;
      hideFurniturePreview();
      furnitureList.innerHTML = '';
      syncFurniturePreviewUrls();
      if (!accumulatedFurnitureFiles.length) {
        furnitureList.style.display = 'none';
        updateFurnitureAddBtn();
        return;
      }
      furnitureList.style.display = 'block';
      accumulatedFurnitureFiles.forEach(function (f, idx) {
        var row = document.createElement('div');
        row.className = 'furniture-file-row';
        var name = document.createElement('span');
        var fullName = f.name || '';
        name.textContent = abbreviateFileName(fullName, FURNITURE_NAME_MAX);
        if (fullName.length > FURNITURE_NAME_MAX) name.title = fullName;

        var previewBtn = document.createElement('button');
        previewBtn.type = 'button';
        previewBtn.className = 'furniture-preview-btn';
        previewBtn.setAttribute('aria-label', 'Preview ' + fullName);
        previewBtn.textContent = '?';
        var previewUrl = furniturePreviewUrls[idx];
        previewBtn.addEventListener('mouseenter', function () {
          showFurniturePreview(previewUrl, previewBtn, fullName);
        });
        previewBtn.addEventListener('mouseleave', hideFurniturePreview);
        previewBtn.addEventListener('focus', function () {
          showFurniturePreview(previewUrl, previewBtn, fullName);
        });
        previewBtn.addEventListener('blur', hideFurniturePreview);

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'furniture-file-remove';
        btn.title = 'Remove';
        btn.textContent = '\u2715';
        btn.addEventListener('click', function () {
          accumulatedFurnitureFiles.splice(idx, 1);
          syncFurnitureInput();
          renderFurnitureList();
        });
        row.appendChild(name);
        row.appendChild(previewBtn);
        row.appendChild(btn);
        furnitureList.appendChild(row);
      });
      updateFurnitureAddBtn();
    }

    function syncFurnitureInput() {
      if (!furnitureFileInput) return;
      var dt = new DataTransfer();
      accumulatedFurnitureFiles.forEach(function (f) { dt.items.add(f); });
      furnitureFileInput.files = dt.files;
    }

    function openFurniturePicker() {
      if (!furnitureFileInput || accumulatedFurnitureFiles.length >= FURNITURE_LIMIT) return;
      furnitureFileInput.click();
    }

    var FURNITURE_ACCEPT = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

    // Add files from either the file picker or a drag-and-drop, keeping the
    // accept filter (the OS picker honors `accept`, but dropped files don't) and
    // the 5-photo cap in one place.
    async function addFurnitureFiles(fileList) {
      // Convert any HEIC/HEIF picks to JPEG up front so they pass the filter and
      // render like any other reference photo.
      var raw = Array.from(fileList || []);
      if (window.StagifyHeic) {
        try {
          raw = await Promise.all(raw.map(function (f) {
            return window.StagifyHeic.isHeic(f) ? window.StagifyHeic.toDisplayableFile(f) : f;
          }));
        } catch (e) {
          alert(window.LanguageSystem?.getText('errors.heicConvert') || "We couldn't read that HEIC photo. Please try a JPG or PNG.");
          return;
        }
      }
      var incoming = raw.filter(function (f) {
        return f && (FURNITURE_ACCEPT.indexOf(f.type) !== -1 || /\.(jpe?g|png|webp)$/i.test(f.name || ''));
      });
      if (!incoming.length) return;
      incoming.forEach(function (f) {
        if (accumulatedFurnitureFiles.length < FURNITURE_LIMIT) {
          accumulatedFurnitureFiles.push(f);
        }
      });
      if (accumulatedFurnitureFiles.length > FURNITURE_LIMIT) {
        accumulatedFurnitureFiles = accumulatedFurnitureFiles.slice(0, FURNITURE_LIMIT);
      }
      syncFurnitureInput();
      renderFurnitureList();
    }

    if (furnitureAddBtn) {
      furnitureAddBtn.addEventListener('click', openFurniturePicker);
    }

    if (furnitureFileInput) {
      furnitureFileInput.addEventListener('change', () => {
        addFurnitureFiles(furnitureFileInput.files);
      });
    }

    // Drag-and-drop: drop image files onto the "+ Add photos" button (or the
    // list of already-added photos) to add reference photos, same as picking
    // them. Highlights the button while a valid drag is over it.
    (function wireFurnitureDrop() {
      var zones = [furnitureAddBtn, furnitureList].filter(Boolean);
      if (!zones.length) return;
      var dragDepth = 0;
      function atLimit() {
        return accumulatedFurnitureFiles.length >= FURNITURE_LIMIT;
      }
      function hasFiles(e) {
        var dt = e.dataTransfer;
        return !!dt && Array.prototype.indexOf.call(dt.types || [], 'Files') !== -1;
      }
      zones.forEach(function (zone) {
        zone.addEventListener('dragenter', function (e) {
          if (!hasFiles(e) || atLimit()) return;
          e.preventDefault();
          dragDepth++;
          if (furnitureAddBtn) furnitureAddBtn.classList.add('is-drag-over');
        });
        zone.addEventListener('dragover', function (e) {
          if (!hasFiles(e) || atLimit()) return;
          e.preventDefault();
          if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        });
        zone.addEventListener('dragleave', function () {
          dragDepth = Math.max(0, dragDepth - 1);
          if (dragDepth === 0 && furnitureAddBtn) furnitureAddBtn.classList.remove('is-drag-over');
        });
        zone.addEventListener('drop', function (e) {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth = 0;
          if (furnitureAddBtn) furnitureAddBtn.classList.remove('is-drag-over');
          if (e.dataTransfer) addFurnitureFiles(e.dataTransfer.files);
        });
      });
    })();

    function reset() {
      accumulatedFurnitureFiles = [];
      if (furnitureFileInput) furnitureFileInput.value = '';
      renderFurnitureList();
    }

    return {
      getFiles: () => accumulatedFurnitureFiles,
      reset,
    };
}
