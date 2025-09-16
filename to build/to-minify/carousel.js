class Carousel {
  constructor(container, options = {}) {
    this.container = container;
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
      ...options
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
    this.updateSlidePosition(); // Apply initial position with mobile offset
    this.startAutoplay();
  }

  createCarousel() {
    const containerPadding = 16;
    const itemWidth = this.options.baseWidth - containerPadding * 2;
    const trackItemOffset = itemWidth + this.options.gap;

    this.container.innerHTML = `
      <div class="carousel-track" style="width: ${itemWidth}px; gap: ${this.options.gap}px;">
        ${this.options.items.map((item, index) => `
          <div class="carousel-item" style="width: ${itemWidth}px; height: 100%;">
            <div class="carousel-item-image">
              ${item.image || '<div class="carousel-image-placeholder"></div>'}
            </div>
            <div class="carousel-item-overlay">
              <div class="carousel-item-title">${item.title}</div>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="carousel-indicators-container">
        <div class="carousel-indicators">
          ${this.options.items.map((_, index) => `
            <div class="carousel-indicator ${index === 0 ? 'active' : 'inactive'}" data-index="${index}"></div>
          `).join('')}
        </div>
      </div>
      <div class="carousel-note" data-lang="hero.carouselNote">Example preview — upload your photo to stage</div>
    `;

    this.track = this.container.querySelector('.carousel-track');
    this.items = this.container.querySelectorAll('.carousel-item');
    this.indicators = this.container.querySelectorAll('.carousel-indicator');
    this.itemWidth = itemWidth;
    this.trackItemOffset = trackItemOffset;
    
    // Apply language to the dynamically created carousel note
    if (window.LanguageSystem && window.LanguageSystem.isLoaded()) {
      window.LanguageSystem.applyLanguageToElements();
    }
  }

  setupEventListeners() {
    // Drag functionality
    this.track.addEventListener('mousedown', this.handleDragStart.bind(this));
    this.track.addEventListener('mousemove', this.handleDragMove.bind(this));
    this.track.addEventListener('mouseup', this.handleDragEnd.bind(this));
    this.track.addEventListener('mouseleave', this.handleDragEnd.bind(this));

    // Touch events
    this.track.addEventListener('touchstart', this.handleTouchStart.bind(this));
    this.track.addEventListener('touchmove', this.handleTouchMove.bind(this));
    this.track.addEventListener('touchend', this.handleTouchEnd.bind(this));

    // Hover events
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

    // Indicator clicks
    this.indicators.forEach((indicator, index) => {
      indicator.addEventListener('click', () => {
        this.goToSlide(index);
      });
    });

    // Prevent default drag behavior
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
    const deltaX = e.clientX - this.dragStartX;
    const currentTransform = -this.currentIndex * this.trackItemOffset;
    const mobileOffset = window.innerWidth <= 768 ? 6 : 0;
    this.track.style.transform = `translateX(${currentTransform + deltaX + mobileOffset}px)`;
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
    const deltaX = e.touches[0].clientX - this.dragStartX;
    const currentTransform = -this.currentIndex * this.trackItemOffset;
    const mobileOffset = window.innerWidth <= 768 ? 6 : 0;
    this.track.style.transform = `translateX(${currentTransform + deltaX + mobileOffset}px)`;
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
    const offset = this.dragStartX - this.dragEndX;
    const velocity = Math.abs(offset);
    
    if (offset > this.options.dragBuffer || velocity > this.options.velocityThreshold) {
      this.nextSlide();
    } else if (offset < -this.options.dragBuffer || velocity > this.options.velocityThreshold) {
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
    const translateX = -this.currentIndex * this.trackItemOffset;
    const mobileOffset = window.innerWidth <= 768 ? 6 : 0;
    this.track.style.transform = `translateX(${translateX + mobileOffset}px)`;
  }

  updateIndicators() {
    this.indicators.forEach((indicator, index) => {
      indicator.classList.toggle('active', index === this.currentIndex);
      indicator.classList.toggle('inactive', index !== this.currentIndex);
    });
  }

  startAutoplay() {
    if (!this.options.autoplay || this.isHovered) return;
    this.stopAutoplay();
    this.autoplayTimer = setInterval(() => {
      this.nextSlide();
    }, this.options.autoplayDelay);
  }

  stopAutoplay() {
    if (this.autoplayTimer) {
      clearInterval(this.autoplayTimer);
      this.autoplayTimer = null;
    }
  }

  destroy() {
    this.stopAutoplay();
    // Remove event listeners and clean up
  }
}

// Initialize carousel for staging examples
document.addEventListener('DOMContentLoaded', () => {
  const carouselContainer = document.querySelector('.carousel-container');
  if (carouselContainer) {
    const stagingItems = [
      {
        title: 'Original',
        description: 'The original empty room before staging',
        image: '<img src="media-webp/example/Original.webp" alt="Original staging" style="width: 100%; height: 100%; object-fit: cover;" fetchpriority="high">'
      },
      {
        title: 'Modern',
        description: 'Clean lines and contemporary furniture',
        image: '<img src="media-webp/example/Modern.webp" alt="Modern staging" style="width: 100%; height: 100%; object-fit: cover;">'
      },
      {
        title: 'Scandinavian',
        description: 'Minimalist design with natural materials',
        image: '<img src="media-webp/example/Scandinavian.webp" alt="Scandinavian staging" style="width: 100%; height: 100%; object-fit: cover;">'
      },
      {
        title: 'Luxury',
        description: 'High-end finishes and elegant furnishings',
        image: '<img src="media-webp/example/Luxury.webp" alt="Luxury staging" style="width: 100%; height: 100%; object-fit: cover;">'
      },
      {
        title: 'Coastal',
        description: 'Beach-inspired colors and relaxed vibes',
        image: '<img src="media-webp/example/Coastal.webp" alt="Coastal staging" style="width: 100%; height: 100%; object-fit: cover;">'
      },
      {
        title: 'Midcentury',
        description: 'Retro design with bold colors and shapes',
        image: '<img src="media-webp/example/Midcentury.webp" alt="Midcentury staging" style="width: 100%; height: 100%; object-fit: cover;">'
      },
      {
        title: 'Farmhouse',
        description: 'Rustic charm with vintage elements',
        image: '<img src="media-webp/example/Farmhouse.webp" alt="Farmhouse staging" style="width: 100%; height: 100%; object-fit: cover;">'
      }
    ];

    new Carousel(carouselContainer, {
      items: stagingItems,
      baseWidth: carouselContainer.offsetWidth || 400,
      autoplay: true,
      autoplayDelay: 3000,
      pauseOnHover: true,
      loop: true,
      round: false,
      gap: 21
    });
  }
});
