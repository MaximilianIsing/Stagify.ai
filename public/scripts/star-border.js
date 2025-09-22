// Star Border Effect for Pills
// Adapted from ReactBits star border animation

class StarBorder {
    constructor(element, options = {}) {
      this.element = element;
      this.options = {
        color: options.color || '#2563eb',
        speed: options.speed || '6s',
        thickness: options.thickness || 1,
        ...options
      };
      
      this.init();
    }
  
    init() {
      // Create the star border container
      this.container = document.createElement('div');
      this.container.className = 'star-border-container';
      this.container.style.padding = `${this.options.thickness}px 0`;
      
      // Create gradient elements
      this.gradientBottom = document.createElement('div');
      this.gradientBottom.className = 'border-gradient-bottom';
      this.gradientBottom.style.background = `radial-gradient(circle, ${this.options.color}, transparent 10%)`;
      this.gradientBottom.style.animationDuration = this.options.speed;
      
      this.gradientTop = document.createElement('div');
      this.gradientTop.className = 'border-gradient-top';
      this.gradientTop.style.background = `radial-gradient(circle, ${this.options.color}, transparent 10%)`;
      this.gradientTop.style.animationDuration = this.options.speed;
      
      // Create inner content wrapper
      this.innerContent = document.createElement('div');
      this.innerContent.className = 'inner-content';
      
      // Move the original pill content into the inner content
      while (this.element.firstChild) {
        this.innerContent.appendChild(this.element.firstChild);
      }
      
      // Assemble the structure
      this.container.appendChild(this.gradientBottom);
      this.container.appendChild(this.gradientTop);
      this.container.appendChild(this.innerContent);
      
      // Replace the original element with our container
      this.element.parentNode.replaceChild(this.container, this.element);
    }
  
    destroy() {
      if (this.container && this.container.parentNode) {
        this.container.parentNode.replaceChild(this.element, this.container);
      }
    }
  }
  
  // Initialize star border for all stat pills
  document.addEventListener('DOMContentLoaded', function() {
    const statPills = document.querySelectorAll('.stat-pill');
    
    statPills.forEach(pill => {
      new StarBorder(pill, {
        color: '#70a7ff',
        speed: '6s',
        thickness: 5
      });
    });
  });
  