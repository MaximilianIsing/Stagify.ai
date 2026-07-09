// Image thumbnail-strip island for the AI Designer chat.
//
// The base-image picker strip: one thumbnail per image in the conversation,
// with the selected one used as the base for the next edit. Owns
// selectedImageIndex as private state; the entry reads/writes the selection
// through the returned getter/setter. syncImageThumbnailStrip was lifted
// verbatim from the entry (scripts/ai-designer-app.js).
//
// deps: { collectImagesFromConversationHistory }  ->  returns
//   { syncImageThumbnailStrip, getSelectedImageIndex, setSelectedImageIndex }
import { getThumbnailLabel } from './image-history.js';
import { getPdfAlt } from './i18n.js';

export function createThumbnailStrip(deps) {
  const {
    collectImagesFromConversationHistory,
  } = deps;

      let selectedImageIndex = null;

      function syncImageThumbnailStrip(options) {
        const preferNewest = options && options.preferNewest === true;
        const strip = document.getElementById('image-thumbnail-strip');
        const scroll = document.getElementById('image-thumbnail-strip-scroll');
        if (!strip || !scroll) return;

        const images = collectImagesFromConversationHistory();
        if (images.length === 0) {
          strip.classList.remove('visible');
          scroll.innerHTML = '';
          selectedImageIndex = null;
          return;
        }

        strip.classList.add('visible');
        if (preferNewest || selectedImageIndex === null || selectedImageIndex >= images.length) {
          selectedImageIndex = 0;
        }

        scroll.innerHTML = '';
        images.forEach((img, index) => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'image-thumbnail-item' + (index === selectedImageIndex ? ' selected' : '');
          const label = getThumbnailLabel(img);
          btn.setAttribute('aria-label', getPdfAlt('thumbnailOption', { label, index: index + 1 }));
          btn.dataset.index = String(index);

          const preview = document.createElement('img');
          preview.className = 'image-thumbnail-preview';
          preview.src = img.url;
          preview.alt = index === selectedImageIndex
            ? getPdfAlt('thumbnailSelected', { label })
            : getPdfAlt('thumbnailOption', { label, index: index + 1 });
          preview.loading = 'lazy';

          const caption = document.createElement('span');
          caption.className = 'image-thumbnail-caption';
          caption.textContent = getThumbnailLabel(img);

          btn.appendChild(preview);
          btn.appendChild(caption);
          btn.addEventListener('click', () => {
            selectedImageIndex = index;
            syncImageThumbnailStrip();
          });

          scroll.appendChild(btn);
        });
      }

  return {
    syncImageThumbnailStrip,
    getSelectedImageIndex: () => selectedImageIndex,
    setSelectedImageIndex: (idx) => { selectedImageIndex = idx; },
  };
}
