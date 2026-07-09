// Before/After version carousel island for the main Stagify tool (scripts/app.js).
//
// Owns the before/after version arrays (uploaded photo + masked edits vs the
// staged results + masked refinements), the Before/After view toggle, and the
// version carousel arrows/dots, lifted verbatim from the entry. The entry
// mutates the arrays only through the returned getters/setters/push helpers;
// reads of entry-owned flags flow through injected callbacks.
//
// deps: { canvas1, stagePreview, toggleBeforeBtn, toggleAfterBtn,
//         processingPlaceholder, imageViewerContainer, carouselPrev,
//         carouselNext, carouselDots, maxVersions, getHasProcessedImage,
//         updateMaskButtonVisibility, updateEmptyRoomButtonVisibility,
//         updateStagedCanvasAria, getStagingAlt }

export function createVersionCarousel(deps) {
  const {
    canvas1,
    stagePreview,
    toggleBeforeBtn,
    toggleAfterBtn,
    processingPlaceholder,
    imageViewerContainer,
    carouselPrev,
    carouselNext,
    carouselDots,
    maxVersions,
    getHasProcessedImage,
    updateMaskButtonVisibility,
    updateEmptyRoomButtonVisibility,
    updateStagedCanvasAria,
    getStagingAlt,
  } = deps;

    let beforeVersions = [];
    let beforeIndex = 0;
    let afterVersions = [];
    let afterIndex = 0;

    function activeViewIsAfter() {
      return toggleAfterBtn && toggleAfterBtn.classList.contains('active');
    }

    function drawAfter(url, ariaSuffix) {
      return new Promise((resolve) => {
        const im = new Image();
        im.onload = () => {
          const ctx1 = canvas1.getContext('2d');
          ctx1.canvas.width = im.width;
          ctx1.canvas.height = im.height;
          ctx1.drawImage(im, 0, 0, im.width, im.height);
          updateStagedCanvasAria(ariaSuffix || '');
          resolve();
        };
        im.src = url;
      });
    }

    function showAfterVersion(i) {
      if (!afterVersions.length) return;
      afterIndex = Math.max(0, Math.min(i, afterVersions.length - 1));
      drawAfter(afterVersions[afterIndex], afterVersions.length > 1 ? ` (${afterIndex + 1})` : '');
      updateCarouselUI();
    }

    function showBeforeVersion(i) {
      if (!beforeVersions.length) return;
      beforeIndex = Math.max(0, Math.min(i, beforeVersions.length - 1));
      stagePreview.src = beforeVersions[beforeIndex];
      updateCarouselUI();
    }

    function carouselStep(delta) {
      if (activeViewIsAfter()) showAfterVersion(afterIndex + delta);
      else showBeforeVersion(beforeIndex + delta);
    }

    // Anchor the nav arrows + dots to the rendered image (not the viewer box),
    // so dots sit at the photo's bottom edge and arrows are centered on it.
    function positionCarousel() {
      const el = activeViewIsAfter() ? canvas1 : stagePreview;
      if (!el || !el.offsetHeight || !el.offsetWidth) return;
      const top = el.offsetTop;
      const left = el.offsetLeft;
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const midY = top + h / 2;
      if (carouselPrev && !carouselPrev.classList.contains('hidden')) {
        carouselPrev.style.top = midY + 'px';
        carouselPrev.style.left = (left + 12) + 'px';
        carouselPrev.style.right = 'auto';
      }
      if (carouselNext && !carouselNext.classList.contains('hidden')) {
        carouselNext.style.top = midY + 'px';
        carouselNext.style.left = (left + w - 12 - carouselNext.offsetWidth) + 'px';
        carouselNext.style.right = 'auto';
      }
      if (carouselDots && !carouselDots.classList.contains('hidden')) {
        carouselDots.style.left = (left + w / 2) + 'px';
        carouselDots.style.bottom = 'auto';
        carouselDots.style.top = (top + h - carouselDots.offsetHeight - 12) + 'px';
      }
    }

    window.addEventListener('resize', positionCarousel);
    if (stagePreview) stagePreview.addEventListener('load', positionCarousel);

    function updateCarouselUI() {
      if (!carouselDots) return;
      const isAfter = activeViewIsAfter();
      const list = isAfter ? afterVersions : beforeVersions;
      const idx = isAfter ? afterIndex : beforeIndex;
      const viewerOpen = imageViewerContainer && !imageViewerContainer.classList.contains('hidden');
      const show = viewerOpen && list.length > 1 && (!isAfter || getHasProcessedImage());
      [carouselPrev, carouselNext, carouselDots].forEach((el) => {
        if (el) el.classList.toggle('hidden', !show);
      });
      if (!show) return;
      if (carouselPrev) carouselPrev.disabled = idx <= 0;
      if (carouselNext) carouselNext.disabled = idx >= list.length - 1;
      carouselDots.innerHTML = '';
      list.forEach((_, i) => {
        const d = document.createElement('button');
        d.type = 'button';
        d.className = 'stage-carousel-dot' + (i === idx ? ' active' : '');
        d.setAttribute('role', 'tab');
        d.setAttribute('aria-selected', i === idx ? 'true' : 'false');
        d.setAttribute('aria-label', (getStagingAlt('versionLabel', { index: i + 1 }) || ('Version ' + (i + 1))));
        d.addEventListener('click', () => {
          if (isAfter) showAfterVersion(i);
          else showBeforeVersion(i);
        });
        carouselDots.appendChild(d);
      });
      positionCarousel();
      requestAnimationFrame(positionCarousel);
    }

    if (carouselPrev) carouselPrev.addEventListener('click', () => carouselStep(-1));
    if (carouselNext) carouselNext.addEventListener('click', () => carouselStep(1));

    function showBeforeView() {
      stagePreview.classList.remove('hidden');
      canvas1.classList.add('hidden');
      toggleBeforeBtn.classList.add('active');
      toggleAfterBtn.classList.remove('active');
      // Hide placeholder when showing the image
      if (stagePreview.src) {
        processingPlaceholder.style.display = 'none';
      }
      updateMaskButtonVisibility();
      updateEmptyRoomButtonVisibility();
      updateCarouselUI();
    }

    function showAfterView() {
      stagePreview.classList.add('hidden');
      canvas1.classList.remove('hidden');
      toggleBeforeBtn.classList.remove('active');
      toggleAfterBtn.classList.add('active');
      // Show placeholder if no processing has been done yet
      if (!getHasProcessedImage()) {
        processingPlaceholder.style.display = 'flex';
      } else {
        processingPlaceholder.style.display = 'none';
      }
      updateMaskButtonVisibility();
      updateEmptyRoomButtonVisibility();
      updateCarouselUI();
    }

    // Add toggle event listeners
    if (toggleBeforeBtn) toggleBeforeBtn.addEventListener('click', showBeforeView);
    if (toggleAfterBtn) toggleAfterBtn.addEventListener('click', () => {
      // Always allow switching to "After" view
      showAfterView();
    });

    return {
      activeViewIsAfter,
      drawAfter,
      showBeforeVersion,
      showBeforeView,
      showAfterView,
      updateCarouselUI,
      getBeforeVersions: () => beforeVersions,
      setBeforeVersions(list) { beforeVersions = list; beforeIndex = 0; },
      pushBeforeVersion(url) {
        beforeVersions.push(url);
        if (beforeVersions.length > maxVersions) beforeVersions = beforeVersions.slice(-maxVersions);
        return beforeVersions;
      },
      getBeforeIndex: () => beforeIndex,
      getAfterVersions: () => afterVersions,
      setAfterVersions(list) { afterVersions = list; afterIndex = 0; },
      pushAfterVersion(url) {
        afterVersions.push(url);
        if (afterVersions.length > maxVersions) afterVersions = afterVersions.slice(-maxVersions);
        return afterVersions;
      },
      setAfterIndex(i) { afterIndex = i; },
    };
}
