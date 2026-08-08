// StarBorder — wraps an element in an animated glowing gradient border by
// replacing it with a container that holds two radial-gradient layers plus the
// original content. Used on the homepage stat pills (.stat-pill).
// Defines the global `StarBorder` (for classic consumers); self-initialises on load.

class StarBorder {
  constructor(element, options = {}) {
    this.element = element;
    this.options = {
      color: options.color || '#2563eb',
      speed: options.speed || '6s',
      ...options,
    };
    this.init();
  }

  init() {
    this.container = document.createElement('div');
    this.container.className = 'star-border-container';
    // The transparent band the glow rings show through is `--star-pill-ring` in
    // index.css, not an inline style here. It has to equal the MARGIN on the
    // pre-swap `.stat-pill` in that same file — this element replaces that one, so
    // any difference between the two is a jump the user watches happen. One token,
    // one file, both sides; see the note above `.hero-stats` there.

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

function mountStarBorders() {
  const pills = document.querySelectorAll('.stat-pill');
  pills.forEach((pill) => {
    new StarBorder(pill, { color: '#70a7ff', speed: '6s' });
  });
}

// Guarded rather than a bare DOMContentLoaded listener: index-deferred.js injects this
// file after `load`, when that event has already fired. Without the guard the glow ring
// would simply never mount — silently, since index.css carries fallback styling for
// exactly this case and the pills still look fine. That last part is true only because
// test/frontend/hero-stat-pill-swap.test.js pins `.stat-pill` to the `.inner-content`
// box this file swaps it for; before that guard the "fallback" was a different colour
// and 14px shorter, so the mount was a visible jump rather than a no-op plus a glow.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountStarBorders);
} else {
  mountStarBorders();
}

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
