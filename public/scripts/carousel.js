// Carousel — the homepage hero "example styles" slider. Renders its own markup
// from an items array, supports mouse/touch drag, clickable indicators,
// pause-on-hover and autoplay. Self-initialises against `.carousel-container` as soon as
// the module runs (see the note above the IIFE at the bottom — the timing is load-bearing
// for LCP). The class is module-scoped; nothing reads a `window.Carousel` global.

class Carousel {
  constructor(container, options = {}) {
    this.container = container;
    /** @type {{ baseWidth: number, autoplay: boolean, autoplayDelay: number, pauseOnHover: boolean, loop: boolean, round: boolean, dragBuffer: number, velocityThreshold: number, gap: number, items?: Array<{ key: string, title: string, image?: string }> }} */
    this.options = {
      baseWidth: 300,
      autoplay: true,
      autoplayDelay: 3000,
      pauseOnHover: true,
      loop: true,
      round: false,
      dragBuffer: 0,
      velocityThreshold: 500,
      gap: 16,
      ...options,
    };
    this.currentIndex = 0;
    this.isHovered = false;
    // Keyboard equivalent of isHovered. Pause-on-hover was the only way to stop
    // the autoplay, which is no mechanism at all for anyone not using a mouse —
    // and tabbing onto a dot while the slides keep moving under you is worse than
    // useless. See the focusin/focusout pair in setupEventListeners().
    this.isFocusWithin = false;
    this.isResetting = false;
    this.autoplayTimer = null;
    this.dragStartX = 0;
    this.dragEndX = 0;
    this.isDragging = false;
    this.init();
  }

  init() {
    this.createCarousel();
    this.setupEventListeners();
    this.updateSlidePosition();
    this.startAutoplay();
    this.scheduleImageHydration();
  }

  /**
   * Give a slide's <img> its real `src`, if it is still deferred.
   *
   * Slides 1..n ship with `data-src` instead of `src` (see the items array at the
   * bottom of this file) so that the seven example photos — 666 KB, six of which are
   * behind `.carousel-track { overflow:hidden }` and invisible at first paint — do not
   * contend with slide 0, which IS the page's LCP element.
   *
   * @param {number} index
   */
  promoteImage(index) {
    const item = this.items && this.items[index];
    if (!item) return;
    const img = /** @type {HTMLImageElement | null} */ (item.querySelector('img[data-src]'));
    if (!img) return;
    img.src = img.dataset.src || '';
    delete img.dataset.src;
  }

  /**
   * Load the deferred slides once the page has finished its own critical work.
   *
   * Deliberately NOT `loading="lazy"`: the track is an `overflow:hidden` box moved by a
   * transform, so the lazy heuristic is unreliable here and a slide could stay blank
   * forever. Autoplay advances every 3 s and `load` fires well before that, but
   * updateSlidePosition() promotes on demand anyway, so a slow connection degrades to a
   * late image rather than a missing one.
   */
  scheduleImageHydration() {
    // Slide 1 is warmed off slide 0's OWN load event rather than `load`, because
    // autoplay advances at 3 s (options.autoplayDelay) and on a throttled phone the
    // window `load` event can land after that. Chaining it to the LCP image guarantees
    // the fetch cannot start until the byte that matters is already off the wire.
    const first = this.items[0] && this.items[0].querySelector('img');
    if (first && /** @type {HTMLImageElement} */ (first).complete) this.promoteImage(1);
    else if (first) first.addEventListener('load', () => this.promoteImage(1), { once: true });

    const hydrate = () => {
      const idle = window.requestIdleCallback || ((/** @type {() => void} */ cb) => setTimeout(cb, 1));
      idle(() => {
        for (let i = 0; i < this.items.length; i++) this.promoteImage(i);
      });
    };
    if (document.readyState === 'complete') hydrate();
    else window.addEventListener('load', hydrate, { once: true });
  }

  /**
   * Markup for one slide. Extracted so the adopt path and the from-scratch path
   * below cannot drift apart — there is already one copy of slide 0 in index.html,
   * and a second divergent copy in here would be two too many.
   *
   * @param {{ key: string, title: string, image?: string }} item
   * @param {number} itemWidth
   */
  slideMarkup(item, itemWidth) {
    return `
          <div class="carousel-item" style="width: ${itemWidth}px; height: 100%;">
            <div class="carousel-item-image">
              ${item.image || '<div class="carousel-image-placeholder"></div>'}
            </div>
            <div class="carousel-item-overlay">
              <div class="carousel-item-title" data-lang="carouselItems.${item.key}">${item.title}</div>
            </div>
          </div>
        `;
  }

  /** The dot row. Same reasoning as slideMarkup(): one copy, used by both paths.
   *
   *  These are real <button>s. They used to be <div>s with a click listener and
   *  nothing else — no role, no tabindex, no name — so the only way to jump to a
   *  specific style was a mouse, and a screen reader saw seven empty boxes.
   *
   *  The label reuses the slide's OWN existing i18n key (`carouselItems.<key>`,
   *  the same one the visible title binds to), so the dots are translated in all
   *  11 packs without inventing a single new string. `aria-current` marks the
   *  active one — see updateIndicators(). */
  indicatorsMarkup() {
    return `
      <div class="carousel-indicators-container">
        <div class="carousel-indicators">
          ${this.options.items
            .map(
              (item, index) => `
            <button type="button" class="carousel-indicator ${index === 0 ? 'active' : 'inactive'}" data-index="${index}" data-lang-attr="carouselItems.${item.key}|aria-label" aria-label="${item.title}"${index === 0 ? ' aria-current="true"' : ''}></button>
          `
            )
            .join('')}
        </div>
      </div>
    `;
  }

  createCarousel() {
    const staticTrack = this.container.querySelector('.carousel-track');
    const staticSlide = staticTrack && staticTrack.querySelector('.carousel-item');

    // `baseWidth - 32` assumes the container's content box is its offsetWidth minus
    // 16px of padding a side. That is not true: .carousel-container also has a 1px
    // border, and the mobile media queries change the padding. Measured at 412px the
    // computed value is 14px narrower than the box the slide actually occupies.
    //
    // That did not matter while the whole carousel was built at once — nothing had
    // painted yet, so there was nothing to shift. It matters now: slide 0 ships in the
    // HTML at width:100% and is ALREADY PAINTED when this runs, so writing a different
    // pixel width onto it moves rendered content and books a layout shift against CLS.
    // So on the adopt path, measure the painted box instead of predicting it — setting
    // the element to the width it already has is a no-op by construction. Module
    // scripts run after the stylesheets, so this measurement is valid.
    const measured = staticSlide ? staticSlide.getBoundingClientRect().width : 0;
    const itemWidth = measured > 0 ? measured : this.options.baseWidth - 32;
    const trackItemOffset = itemWidth + this.options.gap;

    if (staticTrack && staticSlide) {
      // ADOPT PATH (the homepage). index.html ships slide 0 — track, item, and the
      // LCP <img> — so the image can paint without waiting for this file at all.
      // We therefore APPEND slides 1..n around it and must never re-create it:
      // replacing the node, even with an identical src, restarts the browser's LCP
      // candidate at the later time and silently undoes the whole optimisation.
      //
      // itemWidth here is the slide's MEASURED width (see above), so these three
      // writes set each element to the size it already renders at — a no-op in layout
      // terms, and therefore free of layout shift. Do not swap it back for a computed
      // value; that is a 14px shift on mobile.
      /** @type {HTMLElement} */ (staticTrack).style.width = `${itemWidth}px`;
      /** @type {HTMLElement} */ (staticTrack).style.gap = `${this.options.gap}px`;
      /** @type {HTMLElement} */ (staticSlide).style.width = `${itemWidth}px`;
      /** @type {HTMLElement} */ (staticSlide).style.height = '100%';

      staticTrack.insertAdjacentHTML(
        'beforeend',
        this.options.items
          .slice(1)
          .map((item) => this.slideMarkup(item, itemWidth))
          .join('')
      );
      // Between the track and the note, matching the from-scratch order below.
      staticTrack.insertAdjacentHTML('afterend', this.indicatorsMarkup());

      // Makes "did we adopt?" observable from outside, which is the only way to guard
      // it honestly. A source-scanning unit test cannot tell that this branch became
      // unreachable — stub the querySelector above to null and every string it greps
      // for is still present in now-dead code. e2e/index.spec.js asserts this attribute
      // in a real browser, where an unreachable branch simply never sets it.
      this.container.setAttribute('data-carousel-adopted', '');
    } else {
      // FROM-SCRATCH PATH — any consumer whose container is empty. Unchanged.
      this.container.innerHTML = `
      <div class="carousel-track" style="width: ${itemWidth}px; gap: ${this.options.gap}px;">
        ${this.options.items.map((item) => this.slideMarkup(item, itemWidth)).join('')}
      </div>
      ${this.indicatorsMarkup()}
      <div class="carousel-note" data-lang="hero.carouselNote">Example preview, upload your photo to stage.</div>
    `;
    }

    this.track = this.container.querySelector('.carousel-track');
    this.items = this.container.querySelectorAll('.carousel-item');
    this.indicators = this.container.querySelectorAll('.carousel-indicator');
    this.itemWidth = itemWidth;
    this.trackItemOffset = trackItemOffset;

    // Newly injected markup carries data-lang attributes — translate it if the
    // language system has already loaded.
    if (window.LanguageSystem && window.LanguageSystem.isLoaded()) {
      window.LanguageSystem.applyLanguageToElements();
    }
  }

  setupEventListeners() {
    this.track.addEventListener('mousedown', this.handleDragStart.bind(this));
    this.track.addEventListener('mousemove', this.handleDragMove.bind(this));
    this.track.addEventListener('mouseup', this.handleDragEnd.bind(this));
    this.track.addEventListener('mouseleave', this.handleDragEnd.bind(this));
    this.track.addEventListener('touchstart', this.handleTouchStart.bind(this));
    this.track.addEventListener('touchmove', this.handleTouchMove.bind(this));
    this.track.addEventListener('touchend', this.handleTouchEnd.bind(this));

    if (this.options.pauseOnHover) {
      this.container.addEventListener('mouseenter', () => {
        this.isHovered = true;
        this.stopAutoplay();
      });
      this.container.addEventListener('mouseleave', () => {
        this.isHovered = false;
        this.startAutoplay();
      });
    }

    // Keyboard focus pauses, exactly as hover does. focusin/focusout bubble, so
    // this covers the dots and the prev/next buttons without wiring each one.
    this.container.addEventListener('focusin', () => {
      this.isFocusWithin = true;
      this.stopAutoplay();
    });
    this.container.addEventListener('focusout', (e) => {
      if (this.container.contains(/** @type {Node} */ (e.relatedTarget))) return;
      this.isFocusWithin = false;
      this.startAutoplay();
    });

    this.indicators.forEach((indicator, index) => {
      indicator.addEventListener('click', () => {
        this.goToSlide(index);
      });
    });

    this.track.addEventListener('dragstart', (e) => e.preventDefault());
  }

  handleDragStart(e) {
    this.isDragging = true;
    this.dragStartX = e.clientX;
    this.stopAutoplay();
    this.track.style.transition = 'none';
  }

  handleDragMove(e) {
    if (!this.isDragging) return;
    e.preventDefault();
    const delta = e.clientX - this.dragStartX;
    const base = -this.currentIndex * this.trackItemOffset;
    const nudge = window.innerWidth <= 768 ? 6 : 0;
    this.track.style.transform = `translateX(${base + delta + nudge}px)`;
  }

  handleDragEnd(e) {
    if (!this.isDragging) return;
    this.isDragging = false;
    this.dragEndX = e.clientX;
    this.track.style.transition = '';
    this.handleDrag();
    this.startAutoplay();
  }

  handleTouchStart(e) {
    this.isDragging = true;
    this.dragStartX = e.touches[0].clientX;
    this.stopAutoplay();
    this.track.style.transition = 'none';
  }

  handleTouchMove(e) {
    if (!this.isDragging) return;
    const delta = e.touches[0].clientX - this.dragStartX;
    const base = -this.currentIndex * this.trackItemOffset;
    const nudge = window.innerWidth <= 768 ? 6 : 0;
    this.track.style.transform = `translateX(${base + delta + nudge}px)`;
  }

  handleTouchEnd(e) {
    if (!this.isDragging) return;
    this.isDragging = false;
    this.dragEndX = e.changedTouches[0].clientX;
    this.track.style.transition = '';
    this.handleDrag();
    this.startAutoplay();
  }

  handleDrag() {
    const dragDistance = this.dragStartX - this.dragEndX;
    if (dragDistance > this.options.dragBuffer || dragDistance > this.options.velocityThreshold) {
      this.nextSlide();
    } else if (dragDistance < -this.options.dragBuffer || dragDistance < -this.options.velocityThreshold) {
      this.prevSlide();
    } else {
      this.updateSlidePosition();
    }
  }

  goToSlide(index) {
    this.currentIndex = index;
    this.updateSlidePosition();
    this.updateIndicators();
    this.stopAutoplay();
    this.startAutoplay();
  }

  nextSlide() {
    if (this.options.loop) {
      this.currentIndex = (this.currentIndex + 1) % this.options.items.length;
    } else {
      this.currentIndex = Math.min(this.currentIndex + 1, this.options.items.length - 1);
    }
    this.updateSlidePosition();
    this.updateIndicators();
  }

  prevSlide() {
    if (this.options.loop) {
      this.currentIndex = (this.currentIndex - 1 + this.options.items.length) % this.options.items.length;
    } else {
      this.currentIndex = Math.max(this.currentIndex - 1, 0);
    }
    this.updateSlidePosition();
    this.updateIndicators();
  }

  updateSlidePosition() {
    // Only the slide being shown, never the one after it. This also runs once from
    // init(), where currentIndex is 0 — and slide 0 is the LCP image, which already has
    // a real `src`, so this is a no-op there. Prefetching the *next* slide here would
    // pull 96 KB into the LCP window, which is the thing this whole file is avoiding;
    // bulk loading is scheduleImageHydration()'s job, after `load`.
    this.promoteImage(this.currentIndex);
    const base = -this.currentIndex * this.trackItemOffset;
    const nudge = window.innerWidth <= 768 ? 6 : 0;
    this.track.style.transform = `translateX(${base + nudge}px)`;
  }

  updateIndicators() {
    this.indicators.forEach((indicator, index) => {
      const isCurrent = index === this.currentIndex;
      indicator.classList.toggle('active', isCurrent);
      indicator.classList.toggle('inactive', !isCurrent);
      // The class pair is purely visual; aria-current is the only part a screen
      // reader gets. Removing rather than setting "false" keeps it out of the
      // accessibility tree entirely for the six inactive dots.
      if (isCurrent) indicator.setAttribute('aria-current', 'true');
      else indicator.removeAttribute('aria-current');
    });
  }

  /* Autoplay respects prefers-reduced-motion. This is the largest motion source on
     the page — a full-width hero image swapping every 3s — and it was the only
     animation on the homepage with no reduced-motion check at all (carousel.css
     has no such block either). Read live rather than cached at construction so a
     mid-session OS change is honoured on the next start/stop. */
  prefersReducedMotion() {
    return !!(
      window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  startAutoplay() {
    if (this.prefersReducedMotion()) return;
    if (this.options.autoplay && !this.isHovered && !this.isFocusWithin) {
      this.stopAutoplay();
      this.autoplayTimer = setInterval(() => {
        this.nextSlide();
      }, this.options.autoplayDelay);
    }
  }

  stopAutoplay() {
    if (this.autoplayTimer) {
      clearInterval(this.autoplayTimer);
      this.autoplayTimer = null;
    }
  }

  destroy() {
    this.stopAutoplay();
  }
}

// Runs immediately, NOT on DOMContentLoaded. The <img> this injects is the page's LCP
// element, and DOMContentLoaded waits for all ~58 module files to download AND execute —
// which was pinning the LCP paint. Module scripts run after the document is parsed, so
// `.carousel-container` (static markup in index.html) is already present, and the
// render-blocking stylesheets are all above the script tags, so offsetWidth is valid.
// The one external dependency, window.LanguageSystem, is guarded in createCarousel().
(() => {
  const container = /** @type {HTMLElement} */ (document.querySelector('.carousel-container'));
  if (!container) return;

  // Slide 0 keeps a real `src` — it is the LCP element, and this URL matches the
  // <link rel="preload" as="image"> in index.html byte-for-byte so the preload is
  // reused rather than refetched. Every OTHER slide carries `data-src`: they sit
  // inside `overflow:hidden` and are invisible at first paint, but as plain `src`
  // they still queued 592 KB against the LCP image on a throttled phone.
  // Carousel.promoteImage() swaps them in after `load`.
  const items = [
    {
      key: 'original',
      title: 'Original',
      description: 'The original empty room before staging',
      image:
        '<img src="media-webp/example/Original.webp" data-lang-attr="carouselItems.originalPhotoAlt|alt" alt="Example empty room before virtual staging" style="width: 100%; height: 100%; object-fit: cover;" fetchpriority="high">',
    },
    {
      key: 'modern',
      title: 'Modern',
      description: 'Clean lines and contemporary furniture',
      image:
        '<img data-src="media-webp/example/Modern.webp" fetchpriority="low" decoding="async" data-lang-attr="carouselItems.modernPhotoAlt|alt" alt="Example room with modern virtual staging style" style="width: 100%; height: 100%; object-fit: cover;">',
    },
    {
      key: 'scandinavian',
      title: 'Scandinavian',
      description: 'Minimalist design with natural materials',
      image:
        '<img data-src="media-webp/example/Scandinavian.webp" fetchpriority="low" decoding="async" data-lang-attr="carouselItems.scandinavianPhotoAlt|alt" alt="Example room with Scandinavian virtual staging style" style="width: 100%; height: 100%; object-fit: cover;">',
    },
    {
      key: 'luxury',
      title: 'Luxury',
      description: 'High-end finishes and elegant furnishings',
      image:
        '<img data-src="media-webp/example/Luxury.webp" fetchpriority="low" decoding="async" data-lang-attr="carouselItems.luxuryPhotoAlt|alt" alt="Example room with luxury virtual staging style" style="width: 100%; height: 100%; object-fit: cover;">',
    },
    {
      key: 'coastal',
      title: 'Coastal',
      description: 'Beach-inspired colors and relaxed vibes',
      image:
        '<img data-src="media-webp/example/Coastal.webp" fetchpriority="low" decoding="async" data-lang-attr="carouselItems.coastalPhotoAlt|alt" alt="Example room with coastal virtual staging style" style="width: 100%; height: 100%; object-fit: cover;">',
    },
    {
      key: 'midcentury',
      title: 'Midcentury',
      description: 'Retro design with bold colors and shapes',
      image:
        '<img data-src="media-webp/example/Midcentury.webp" fetchpriority="low" decoding="async" data-lang-attr="carouselItems.midcenturyPhotoAlt|alt" alt="Example room with mid-century virtual staging style" style="width: 100%; height: 100%; object-fit: cover;">',
    },
    {
      key: 'farmhouse',
      title: 'Farmhouse',
      description: 'Rustic charm with vintage elements',
      image:
        '<img data-src="media-webp/example/Farmhouse.webp" fetchpriority="low" decoding="async" data-lang-attr="carouselItems.farmhousePhotoAlt|alt" alt="Example room with farmhouse virtual staging style" style="width: 100%; height: 100%; object-fit: cover;">',
    },
  ];

  new Carousel(container, {
    items,
    baseWidth: container.offsetWidth || 400,
    autoplay: true,
    autoplayDelay: 3000,
    pauseOnHover: true,
    loop: true,
    round: false,
    gap: 21,
  });
})();

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
