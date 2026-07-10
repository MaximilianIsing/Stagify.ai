// Image viewer island for the AI Designer chat.
//
// The enlarge modal, image downloads, the AI-image container (image + download
// + mask buttons) and the masked-image carousel. Lifted verbatim from the entry
// (scripts/ai-designer-app.js) as a factory. `openMaskEditor` is injected as a
// late-bound arrow because the mask-editor island is created after this one;
// downloadImage stays module-internal (only createAIImageWithDownload calls it).
//
// deps: { openMaskEditor }  ->  returns { openImageModal, closeImageModal,
//         createAIImageWithDownload, createOrUpdateMaskedImageCarousel }
// Window globals (LanguageSystem, StagifyAuth, URL) are referenced directly.
import { imageCountSuffix, slugifyName } from './format.js';
import { getPdfAlt } from './i18n.js';

export function createImageViewer(deps) {
  const {
    openMaskEditor,
  } = deps;

      // Image modal functions
      function openImageModal(imageSrc, altText) {
        const modal = document.getElementById('image-modal');
        const modalImg = /** @type {HTMLImageElement} */ (document.getElementById('image-modal-img'));
        if (modal && modalImg) {
          modalImg.src = imageSrc;
          modalImg.alt = altText || getPdfAlt('enlargedImage');
          modal.classList.add('active');
          document.body.style.overflow = 'hidden'; // Prevent background scrolling
        }
      }

      function closeImageModal() {
        const modal = document.getElementById('image-modal');
        if (modal) {
          modal.classList.remove('active');
          document.body.style.overflow = ''; // Restore scrolling
        }
      }

      // Download image function
      function downloadImage(imageSrc, filename = 'image') {
        // Convert base64 data URL to blob
        fetch(imageSrc)
          .then(res => res.blob())
          .then(blob => {
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename || 'image.png';
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
          })
          .catch(error => {
            console.error('Error downloading image:', error);
            // Fallback: try direct download for data URLs
            try {
              const a = document.createElement('a');
              a.href = imageSrc;
              a.download = filename || 'image.png';
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
            } catch (e) {
              console.error('Fallback download also failed:', e);
            }
          });
      }

      // Turn an arbitrary label (e.g. a room/source name) into a safe filename part.
      // Helper function to create AI image with download button. `baseName` is an
      // optional room/source label so downloads are named e.g.
      // "123-main-living-staged-room-1.png" instead of "image.png".
      function createAIImageWithDownload(imageSrc, altText, imageType = 'image', baseName) {
        const container = document.createElement('div');
        container.className = 'ai-image-container';

        const img = document.createElement('img');
        img.src = imageSrc;
        img.alt = altText;
        img.className = 'ai-generated-image';
        img.addEventListener('click', () => openImageModal(imageSrc, altText));

        // Compute a stable, descriptive filename once and reuse it for both the
        // per-image download button and the "Download all" action.
        const extension = imageSrc.includes('data:image/png') ? 'png' :
                        imageSrc.includes('data:image/jpeg') || imageSrc.includes('data:image/jpg') ? 'jpg' :
                        imageSrc.includes('data:image/webp') ? 'webp' : 'png';
        const stem = baseName
          ? `${slugifyName(baseName)}-${imageType}`
          : `${imageType}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5)}`;
        const filename = `${stem}.${extension}`;

        const downloadBtn = document.createElement('button');
        downloadBtn.className = 'ai-image-download-btn';
        const downloadLabel = (window.LanguageSystem && window.LanguageSystem.isLoaded())
          ? window.LanguageSystem.getText('modal.staging.downloadIcon')
          : 'Download image';
        downloadBtn.title = downloadLabel;
        downloadBtn.setAttribute('aria-label', downloadLabel);

        const downloadIcon = document.createElement('img');
        downloadIcon.src = 'media-webp/download.webp';
        downloadIcon.alt = '';
        downloadIcon.setAttribute('aria-hidden', 'true');
        downloadBtn.appendChild(downloadIcon);
        downloadBtn.addEventListener('click', (e) => {
          e.stopPropagation(); // Prevent opening modal when clicking download
          downloadImage(imageSrc, filename);
        });

        container.appendChild(img);
        container.appendChild(downloadBtn);

        if (window.StagifyAuth && window.StagifyAuth.user && window.StagifyAuth.user.plan === 'pro') {
          const maskBtn = document.createElement('button');
          maskBtn.className = 'ai-image-mask-btn';
          const maskLabel = (window.LanguageSystem && window.LanguageSystem.isLoaded())
            ? window.LanguageSystem.getText('modal.staging.editWithMask')
            : 'Edit selected area with mask tool';
          maskBtn.title = maskLabel;
          maskBtn.setAttribute('aria-label', maskLabel);

          const maskIcon = document.createElement('img');
          maskIcon.src = 'media-webp/Mask.webp';
          maskIcon.alt = '';
          maskIcon.setAttribute('aria-hidden', 'true');
          maskBtn.appendChild(maskIcon);

          maskBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openMaskEditor(imageSrc, imageType);
          });
          container.appendChild(maskBtn);
        }

        return container;
      }

      // Create or update masked image carousel - Simple, clean implementation
      function createOrUpdateMaskedImageCarousel(originalSrc, maskedVersions, originalContainer) {
        // Check if carousel already exists
        let carousel = originalContainer && originalContainer.classList.contains('masked-image-carousel')
          ? originalContainer
          : null;

        // If carousel exists, append new items instead of recreating
        if (carousel) {
          const track = carousel.querySelector('.masked-image-carousel-track');

          if (track) {
            // Get current number of items (original + existing masked versions)
            const currentItemCount = track.querySelectorAll('.masked-image-carousel-item').length;
            const newMaskedVersions = maskedVersions.slice(currentItemCount - 1); // Get only new versions

            // Add new masked versions
            newMaskedVersions.forEach((maskedImage, index) => {
              // Ensure maskedImage is actually a URL string, not undefined or the original
              if (!maskedImage) {
                console.error('Invalid masked image URL:', maskedImage, 'for index', index);
                return; // Skip invalid entries
              }
              const maskedItem = document.createElement('div');
              maskedItem.className = 'masked-image-carousel-item';
              const maskedImageContainer = createAIImageWithDownload(
                maskedImage,
                getPdfAlt('editedImage', { suffix: imageCountSuffix(currentItemCount + index, maskedVersions.length) }),
                'masked-edit'
              );
              maskedItem.appendChild(maskedImageContainer);
              track.appendChild(maskedItem);

              // Add next button to the new image container
              const nextBtn = document.createElement('button');
              nextBtn.className = 'masked-image-carousel-nav next';
              nextBtn.innerHTML = '›';
              nextBtn.setAttribute('aria-label', 'Next image');
              maskedImageContainer.appendChild(nextBtn);

              // Add click handler - use carousel's updateCarousel function
              nextBtn.addEventListener('click', () => {
                if (carousel._updateCarousel && carousel._getCurrentIndex && carousel._setCurrentIndex) {
                  let currentIdx = carousel._getCurrentIndex();
                  const items = track.querySelectorAll('.masked-image-carousel-item');
                  const totalItemsCount = items.length;

                  if (currentIdx < totalItemsCount - 1) {
                    currentIdx++;
                    carousel._setCurrentIndex(currentIdx);
                    carousel._updateCarousel();
                  }
                }
              });
            });

            // Update dots in all image containers to include new items
            const totalItems = 1 + maskedVersions.length;
            const allImageContainers = track.querySelectorAll('.ai-image-container');
            allImageContainers.forEach((container) => {
              let containerDots = container.querySelector('.masked-image-carousel-dots');
              if (!containerDots) {
                containerDots = document.createElement('div');
                containerDots.className = 'masked-image-carousel-dots';
                container.appendChild(containerDots);
              }

              const currentDotCount = containerDots.querySelectorAll('.masked-image-carousel-dot').length;
              for (let i = currentDotCount; i < totalItems; i++) {
                const dot = document.createElement('button');
                dot.className = 'masked-image-carousel-dot';
                dot.setAttribute('aria-label', `Go to image ${i + 1}`);
                containerDots.appendChild(dot);

                // Add click handler - use carousel's updateCarousel function
                dot.addEventListener('click', () => {
                  if (carousel._setCurrentIndex && carousel._updateCarousel) {
                    carousel._setCurrentIndex(i);
                    carousel._updateCarousel();
                  }
                });
              }
            });

            // Move to the most recent image (last item) and update arrow states
            const newTotalItems = track.querySelectorAll('.masked-image-carousel-item').length;
            const newCurrentIndex = newTotalItems - 1;

            // Update carousel state and move to new item
            if (carousel._setCurrentIndex && carousel._updateCarousel) {
              carousel._setCurrentIndex(newCurrentIndex);
            } else {
              // Fallback: directly update if functions not available
              if (track) {
                track.style.transform = `translateX(-${newCurrentIndex * 100}%)`;

                // Update dots in all containers
                const allItems = track.querySelectorAll('.masked-image-carousel-item');
                allItems.forEach((item) => {
                  const itemDots = item.querySelector('.masked-image-carousel-dots');
                  if (itemDots) {
                    itemDots.querySelectorAll('.masked-image-carousel-dot').forEach((dot, idx) => {
                      dot.classList.toggle('active', idx === newCurrentIndex);
                    });
                  }
                });

                // Update nav buttons
                const prevBtn = carousel.querySelector('.masked-image-carousel-nav.prev');
                if (prevBtn) prevBtn.disabled = newCurrentIndex === 0;
                track.querySelectorAll('.masked-image-carousel-nav.next').forEach((btn) => {
                  btn.disabled = newCurrentIndex === newTotalItems - 1;
                });
              }
            }

            return carousel; // Return existing carousel with new items added
          }
        }

        // Create new carousel if it doesn't exist
        if (!carousel) {
          carousel = document.createElement('div');
          carousel.className = 'masked-image-carousel';
        } else {
          carousel.innerHTML = '';
        }

        // Create viewport (only as wide as image)
        const viewport = document.createElement('div');
        viewport.className = 'masked-image-carousel-viewport';

        const track = document.createElement('div');
        track.className = 'masked-image-carousel-track';

        // Add navigation arrows (will be positioned relative to visible image)
        const prevBtn = document.createElement('button');
        prevBtn.className = 'masked-image-carousel-nav prev';
        prevBtn.innerHTML = '‹';
        prevBtn.setAttribute('aria-label', 'Previous image');

        const nextBtn = document.createElement('button');
        nextBtn.className = 'masked-image-carousel-nav next';
        nextBtn.innerHTML = '›';
        nextBtn.setAttribute('aria-label', 'Next image');

        // Add original image as first item
        const originalItem = document.createElement('div');
        originalItem.className = 'masked-image-carousel-item';
        const originalImageContainer = createAIImageWithDownload(originalSrc, getPdfAlt('originalCarouselImage'), 'original');
        originalItem.appendChild(originalImageContainer);
        track.appendChild(originalItem);

        // Add all masked versions
        maskedVersions.forEach((maskedImage, index) => {
          const maskedItem = document.createElement('div');
          maskedItem.className = 'masked-image-carousel-item';
          // Ensure maskedImage is actually a URL string
          if (!maskedImage) {
            console.error('Invalid masked image URL (undefined) for index', index);
            return; // Skip invalid entries
          }
          if (maskedImage === originalSrc) {
            console.warn('Masked image is same as original for index', index, '- this might be an issue');
          }
          console.log('Adding masked version', index + 1, ':', maskedImage.substring(0, 50) + '...');
          const maskedImageContainer = createAIImageWithDownload(
            maskedImage,
            getPdfAlt('editedImage', { suffix: imageCountSuffix(index, maskedVersions.length) }),
            'masked-edit'
          );
          maskedItem.appendChild(maskedImageContainer);
          track.appendChild(maskedItem);
        });

        viewport.appendChild(track);
        viewport.appendChild(prevBtn);
        carousel.appendChild(viewport);

        // Add next button and dots to each image container (positioned inside the image)
        const allImageContainers = track.querySelectorAll('.ai-image-container');
        const totalItems = 1 + maskedVersions.length; // Original + masked versions

        allImageContainers.forEach((container) => {
          // Add next button
          const nextBtnClone = nextBtn.cloneNode(true);
          container.appendChild(nextBtnClone);

          // Add click handler to each clone
          nextBtnClone.addEventListener('click', () => {
            if (currentIndex < totalItemsCount - 1) {
              currentIndex++;
              updateCarousel();
            }
          });

          // Add dots indicator
          const dots = document.createElement('div');
          dots.className = 'masked-image-carousel-dots';

          for (let i = 0; i < totalItems; i++) {
            const dot = document.createElement('button');
            dot.className = 'masked-image-carousel-dot';
            if (i === 0) dot.classList.add('active');
            dot.setAttribute('aria-label', `Go to image ${i + 1}`);
            dots.appendChild(dot);
          }

          container.appendChild(dots);
        });

        // Carousel functionality
        let currentIndex = 0;
        let items = track.querySelectorAll('.masked-image-carousel-item');
        let totalItemsCount = items.length;

        function updateCarousel() {
          // Refresh items count in case new items were added
          items = track.querySelectorAll('.masked-image-carousel-item');
          totalItemsCount = items.length;

          // Move track to show current item
          track.style.transform = `translateX(-${currentIndex * 100}%)`;

          // Update dots in all image containers
          items.forEach((item) => {
            const itemDots = item.querySelector('.masked-image-carousel-dots');
            if (itemDots) {
              itemDots.querySelectorAll('.masked-image-carousel-dot').forEach((dot, index) => {
                dot.classList.toggle('active', index === currentIndex);
              });
            }
          });

          // Update nav buttons
          prevBtn.disabled = currentIndex === 0;

          // Update all next buttons (they're inside each image container)
          const allNextButtons = track.querySelectorAll('.masked-image-carousel-nav.next');
          allNextButtons.forEach((btn) => {
            /** @type {HTMLButtonElement} */ (btn).disabled = currentIndex === totalItemsCount - 1;
          });
        }

        // Store updateCarousel function on carousel for access when appending
        carousel._updateCarousel = updateCarousel;
        carousel._getCurrentIndex = () => currentIndex;
        carousel._setCurrentIndex = (idx) => {
          currentIndex = idx;
          updateCarousel();
        };

        // Navigation handlers
        prevBtn.addEventListener('click', () => {
          if (currentIndex > 0) {
            currentIndex--;
            updateCarousel();
          }
        });

        // Next button click is handled by the clones inside image containers

        // Dot navigation - attach to dots in all image containers
        items.forEach((item) => {
          const itemDots = item.querySelector('.masked-image-carousel-dots');
          if (itemDots) {
            itemDots.querySelectorAll('.masked-image-carousel-dot').forEach((dot, index) => {
              dot.addEventListener('click', () => {
                currentIndex = index;
                updateCarousel();
              });
            });
          }
        });

        // Touch/swipe support
        let touchStartX = 0;
        let touchEndX = 0;

        viewport.addEventListener('touchstart', (e) => {
          touchStartX = e.changedTouches[0].screenX;
        });

        viewport.addEventListener('touchend', (e) => {
          touchEndX = e.changedTouches[0].screenX;
          const diff = touchStartX - touchEndX;
          const swipeThreshold = 50;

          if (Math.abs(diff) > swipeThreshold) {
            if (diff > 0 && currentIndex < totalItemsCount - 1) {
              currentIndex++;
              updateCarousel();
            } else if (diff < 0 && currentIndex > 0) {
              currentIndex--;
              updateCarousel();
            }
          }
        });

        // Initialize - if there are masked versions, start at the most recent (last) one
        if (maskedVersions.length > 0) {
          currentIndex = maskedVersions.length; // Last item (original is index 0, so last masked version is at length)
        }
        updateCarousel();

        return carousel;
      }

  return {
    openImageModal,
    closeImageModal,
    createAIImageWithDownload,
    createOrUpdateMaskedImageCarousel,
  };
}
