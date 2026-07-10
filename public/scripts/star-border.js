// StarBorder — wraps an element in an animated glowing gradient border by
// replacing it with a container that holds two radial-gradient layers plus the
// original content. Used on the homepage stat pills (.stat-pill).
// Classic <script> (defines the global `StarBorder`); self-initialises on load.

class StarBorder {
  constructor(element, options = {}) {
    this.element = element;
    this.options = {
      color: options.color || '#2563eb',
      speed: options.speed || '6s',
      thickness: options.thickness || 1,
      ...options,
    };
    this.init();
  }

  init() {
    this.container = document.createElement('div');
    this.container.className = 'star-border-container';
    this.container.style.padding = `${this.options.thickness}px 0`;

    this.gradientBottom = document.createElement('div');
    this.gradientBottom.className = 'border-gradient-bottom';
    this.gradientBottom.style.background = `radial-gradient(circle, ${this.options.color}, transparent 10%)`;
    this.gradientBottom.style.animationDuration = this.options.speed;

    this.gradientTop = document.createElement('div');
    this.gradientTop.className = 'border-gradient-top';
    this.gradientTop.style.background = `radial-gradient(circle, ${this.options.color}, transparent 10%)`;
    this.gradientTop.style.animationDuration = this.options.speed;

    this.innerContent = document.createElement('div');
    this.innerContent.className = 'inner-content';

    // Move the original element's children into the inner wrapper.
    while (this.element.firstChild) {
      this.innerContent.appendChild(this.element.firstChild);
    }

    this.container.appendChild(this.gradientBottom);
    this.container.appendChild(this.gradientTop);
    this.container.appendChild(this.innerContent);
    this.element.parentNode.replaceChild(this.container, this.element);
  }

  destroy() {
    if (this.container && this.container.parentNode) {
      this.container.parentNode.replaceChild(this.element, this.container);
    }
  }
}

document.addEventListener('DOMContentLoaded', function () {
  const pills = document.querySelectorAll('.stat-pill');
  pills.forEach((pill) => {
    new StarBorder(pill, { color: '#70a7ff', speed: '6s', thickness: 5 });
  });
});
