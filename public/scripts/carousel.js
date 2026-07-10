// Carousel — the homepage hero "example styles" slider. Renders its own markup
// from an items array, supports mouse/touch drag, clickable indicators,
// pause-on-hover and autoplay. Defines the global `Carousel` (for classic consumers)
// and self-initialises against `.carousel-container` on load.

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
  }

  createCarousel() {
    const itemWidth = this.options.baseWidth - 32;
    const trackItemOffset = itemWidth + this.options.gap;

    this.container.innerHTML = `
      <div class="carousel-track" style="width: ${itemWidth}px; gap: ${this.options.gap}px;">
        ${this.options.items
          .map(
            (item) => `
          <div class="carousel-item" style="width: ${itemWidth}px; height: 100%;">
            <div class="carousel-item-image">
              ${item.image || '<div class="carousel-image-placeholder"></div>'}
            </div>
            <div class="carousel-item-overlay">
              <div class="carousel-item-title" data-lang="carouselItems.${item.key}">${item.title}</div>
            </div>
          </div>
        `
          )
          .join('')}
      </div>
      <div class="carousel-indicators-container">
        <div class="carousel-indicators">
          ${this.options.items
            .map(
              (item, index) => `
            <div class="carousel-indicator ${index === 0 ? 'active' : 'inactive'}" data-index="${index}"></div>
          `
            )
            .join('')}
        </div>
      </div>
      <div class="carousel-note" data-lang="hero.carouselNote">Example preview — upload your photo to stage</div>
    `;

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
    const base = -this.currentIndex * this.trackItemOffset;
    const nudge = window.innerWidth <= 768 ? 6 : 0;
    this.track.style.transform = `translateX(${base + nudge}px)`;
  }

  updateIndicators() {
    this.indicators.forEach((indicator, index) => {
      indicator.classList.toggle('active', index === this.currentIndex);
      indicator.classList.toggle('inactive', index !== this.currentIndex);
    });
  }

  startAutoplay() {
    if (this.options.autoplay && !this.isHovered) {
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

document.addEventListener('DOMContentLoaded', () => {
  const container = /** @type {HTMLElement} */ (document.querySelector('.carousel-container'));
  if (!container) return;

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
        '<img src="media-webp/example/Modern.webp" data-lang-attr="carouselItems.modernPhotoAlt|alt" alt="Example room with modern virtual staging style" style="width: 100%; height: 100%; object-fit: cover;">',
    },
    {
      key: 'scandinavian',
      title: 'Scandinavian',
      description: 'Minimalist design with natural materials',
      image:
        '<img src="media-webp/example/Scandinavian.webp" data-lang-attr="carouselItems.scandinavianPhotoAlt|alt" alt="Example room with Scandinavian virtual staging style" style="width: 100%; height: 100%; object-fit: cover;">',
    },
    {
      key: 'luxury',
      title: 'Luxury',
      description: 'High-end finishes and elegant furnishings',
      image:
        '<img src="media-webp/example/Luxury.webp" data-lang-attr="carouselItems.luxuryPhotoAlt|alt" alt="Example room with luxury virtual staging style" style="width: 100%; height: 100%; object-fit: cover;">',
    },
    {
      key: 'coastal',
      title: 'Coastal',
      description: 'Beach-inspired colors and relaxed vibes',
      image:
        '<img src="media-webp/example/Coastal.webp" data-lang-attr="carouselItems.coastalPhotoAlt|alt" alt="Example room with coastal virtual staging style" style="width: 100%; height: 100%; object-fit: cover;">',
    },
    {
      key: 'midcentury',
      title: 'Midcentury',
      description: 'Retro design with bold colors and shapes',
      image:
        '<img src="media-webp/example/Midcentury.webp" data-lang-attr="carouselItems.midcenturyPhotoAlt|alt" alt="Example room with mid-century virtual staging style" style="width: 100%; height: 100%; object-fit: cover;">',
    },
    {
      key: 'farmhouse',
      title: 'Farmhouse',
      description: 'Rustic charm with vintage elements',
      image:
        '<img src="media-webp/example/Farmhouse.webp" data-lang-attr="carouselItems.farmhousePhotoAlt|alt" alt="Example room with farmhouse virtual staging style" style="width: 100%; height: 100%; object-fit: cover;">',
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
});

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
