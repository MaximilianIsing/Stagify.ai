// Iridescence Background Effect - React Bits Style
class IridescenceBackground {
  constructor(options = {}) {
    this.color = options.color || [1, 1, 1];
    this.speed = options.speed || 1.0;
    this.amplitude = options.amplitude || 0.1;
    this.mouseReact = options.mouseReact !== false;
    this.mousePos = { x: 0.5, y: 0.5 };
    this.canvas = null;
    this.gl = null;
    this.program = null;
    this.animateId = null;
    this.animationStartTime = 0;
    this.realStartTime = 0;
    
    this.init();
  }

  init() {
    // Create canvas element
    this.canvas = document.createElement('canvas');
    this.canvas.style.position = 'fixed';
    this.canvas.style.top = '0';
    this.canvas.style.left = '0';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.zIndex = '-1';
    this.canvas.style.pointerEvents = 'none';
    
    // Get WebGL context
    this.gl = this.canvas.getContext('webgl') || this.canvas.getContext('experimental-webgl');
    if (!this.gl) {
      console.error('WebGL not supported');
      return;
    }
    
    this.gl.clearColor(1, 1, 1, 1);
    
    // Setup shaders and program
    this.setupShaders();
    this.setupBuffers();
    this.setupUniforms();
    
    // Add to body
    document.body.appendChild(this.canvas);
    
    // Create white overlay layer
    this.createWhiteOverlay();
    
    // Setup event listeners
    this.setupEventListeners();
    
    // Add page unload listener to store time
    this.addUnloadListener();
    
    // Start animation
    this.animate();
  }

  createWhiteOverlay() {
    // Create a white overlay div
    this.whiteOverlay = document.createElement('div');
    this.whiteOverlay.style.position = 'fixed';
    this.whiteOverlay.style.top = '0';
    this.whiteOverlay.style.left = '0';
    this.whiteOverlay.style.width = '100%';
    this.whiteOverlay.style.height = '100%';
    this.whiteOverlay.style.backgroundColor = 'rgba(255, 255, 255, 0.6)';
    this.whiteOverlay.style.zIndex = '-1';
    this.whiteOverlay.style.pointerEvents = 'none';
    
    // Add after the canvas
    document.body.appendChild(this.whiteOverlay);
  }

  setupShaders() {
    const vertexShaderSource = `
      attribute vec2 uv;
      attribute vec2 position;
      
      varying vec2 vUv;
      
      void main() {
        vUv = uv;
        gl_Position = vec4(position, 0, 1);
      }
    `;
    
    const fragmentShaderSource = `
      precision highp float;
      
      uniform float uTime;
      uniform vec3 uColor;
      uniform vec3 uResolution;
      uniform vec2 uMouse;
      uniform float uAmplitude;
      uniform float uSpeed;
      
      varying vec2 vUv;
      
      void main() {
        float mr = min(uResolution.x, uResolution.y);
        vec2 uv = (vUv.xy * 2.0 - 1.0) * uResolution.xy / mr;
        
        uv += (uMouse - vec2(0.5)) * uAmplitude;
        
        float d = -uTime * 0.5 * uSpeed;
        float a = 0.0;
        for (float i = 0.0; i < 8.0; ++i) {
          a += cos(i - d - a * uv.x);
          d += sin(uv.y * i + a);
        }
        d += uTime * 0.5 * uSpeed;
        vec3 col = vec3(cos(uv * vec2(d, a)) * 0.6 + 0.4, cos(a + d) * 0.5 + 0.5);
        col = cos(col * cos(vec3(d, a, 2.5)) * 0.5 + 0.5) * uColor;
        gl_FragColor = vec4(col, 1.0);
      }
    `;
    
    const vertexShader = this.createShader(this.gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = this.createShader(this.gl.FRAGMENT_SHADER, fragmentShaderSource);
    
    this.program = this.gl.createProgram();
    this.gl.attachShader(this.program, vertexShader);
    this.gl.attachShader(this.program, fragmentShader);
    this.gl.linkProgram(this.program);
    
    if (!this.gl.getProgramParameter(this.program, this.gl.LINK_STATUS)) {
      console.error('Program linking failed:', this.gl.getProgramInfoLog(this.program));
    }
  }

  createShader(type, source) {
    const shader = this.gl.createShader(type);
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);
    
    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      console.error('Shader compilation failed:', this.gl.getShaderInfoLog(shader));
      this.gl.deleteShader(shader);
      return null;
    }
    
    return shader;
  }

  setupBuffers() {
    // Create a full-screen triangle
    const vertices = new Float32Array([
      -1, -1,
       3, -1,
      -1,  3
    ]);
    
    const uvs = new Float32Array([
      0, 0,
      2, 0,
      0, 2
    ]);
    
    this.positionBuffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, vertices, this.gl.STATIC_DRAW);
    
    this.uvBuffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.uvBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, uvs, this.gl.STATIC_DRAW);
  }

  setupUniforms() {
    this.uniforms = {
      uTime: this.gl.getUniformLocation(this.program, 'uTime'),
      uColor: this.gl.getUniformLocation(this.program, 'uColor'),
      uResolution: this.gl.getUniformLocation(this.program, 'uResolution'),
      uMouse: this.gl.getUniformLocation(this.program, 'uMouse'),
      uAmplitude: this.gl.getUniformLocation(this.program, 'uAmplitude'),
      uSpeed: this.gl.getUniformLocation(this.program, 'uSpeed')
    };
    
    this.attribs = {
      position: this.gl.getAttribLocation(this.program, 'position'),
      uv: this.gl.getAttribLocation(this.program, 'uv')
    };
  }

  setupEventListeners() {
    this.resize();
    window.addEventListener('resize', () => this.resize());
    
    if (this.mouseReact) {
      document.addEventListener('mousemove', (e) => this.handleMouseMove(e));
    }
  }

  addUnloadListener() {
    // Store time when page is being unloaded
    const handleUnload = () => {
      if (this.animationStartTime !== undefined && this.realStartTime !== undefined) {
        const elapsedRealTime = performance.now() - this.realStartTime;
        const finalAnimationTime = this.animationStartTime + elapsedRealTime;
        localStorage.setItem('iridescence-animation-time', finalAnimationTime.toString());
      }
    };
    
    window.addEventListener('beforeunload', handleUnload);
    window.addEventListener('pagehide', handleUnload);
    
    // Store the cleanup function
    this.unloadHandler = handleUnload;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const width = window.innerWidth;
    const height = window.innerHeight;
    
    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;
    this.canvas.style.width = width + 'px';
    this.canvas.style.height = height + 'px';
    
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  handleMouseMove(e) {
    this.mousePos.x = e.clientX / window.innerWidth;
    this.mousePos.y = 1.0 - (e.clientY / window.innerHeight);
  }

  animate() {
    // Get the stored animation time or start fresh
    const storedAnimationTime = localStorage.getItem('iridescence-animation-time');
    const currentRealTime = performance.now();
    
    if (storedAnimationTime) {
      // Use the stored animation time as our starting point
      this.animationStartTime = parseFloat(storedAnimationTime);
      this.realStartTime = currentRealTime;
    } else {
      // First time - start from 0
      this.animationStartTime = 0;
      this.realStartTime = currentRealTime;
      localStorage.setItem('iridescence-animation-time', '0');
    }
    
    const update = (t) => {
      this.animateId = requestAnimationFrame(update);
      
      // Calculate animation time: stored time + elapsed real time
      const elapsedRealTime = t - this.realStartTime;
      const animationTime = this.animationStartTime + elapsedRealTime;
      
      // Store the current animation time every frame
      localStorage.setItem('iridescence-animation-time', animationTime.toString());
      
      this.render(animationTime);
    };
    
    this.animateId = requestAnimationFrame(update);
  }

  render(t) {
    if (!this.program) return;
    
    this.gl.useProgram(this.program);
    
    // Set uniforms
    this.gl.uniform1f(this.uniforms.uTime, t * 0.001);
    this.gl.uniform3fv(this.uniforms.uColor, this.color);
    this.gl.uniform3f(this.uniforms.uResolution, this.canvas.width, this.canvas.height, this.canvas.width / this.canvas.height);
    this.gl.uniform2f(this.uniforms.uMouse, this.mousePos.x, this.mousePos.y);
    this.gl.uniform1f(this.uniforms.uAmplitude, this.amplitude);
    this.gl.uniform1f(this.uniforms.uSpeed, this.speed);
    
    // Set attributes
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.positionBuffer);
    this.gl.enableVertexAttribArray(this.attribs.position);
    this.gl.vertexAttribPointer(this.attribs.position, 2, this.gl.FLOAT, false, 0, 0);
    
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.uvBuffer);
    this.gl.enableVertexAttribArray(this.attribs.uv);
    this.gl.vertexAttribPointer(this.attribs.uv, 2, this.gl.FLOAT, false, 0, 0);
    
    // Draw
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  destroy() {
    if (this.animateId) {
      cancelAnimationFrame(this.animateId);
    }
    
    window.removeEventListener('resize', () => this.resize());
    if (this.mouseReact) {
      document.removeEventListener('mousemove', (e) => this.handleMouseMove(e));
    }
    
    // Remove unload listeners
    if (this.unloadHandler) {
      window.removeEventListener('beforeunload', this.unloadHandler);
      window.removeEventListener('pagehide', this.unloadHandler);
    }
    
    // Store the final animation time before destroying
    if (this.animationStartTime !== undefined && this.realStartTime !== undefined) {
      const elapsedRealTime = performance.now() - this.realStartTime;
      const finalAnimationTime = this.animationStartTime + elapsedRealTime;
      localStorage.setItem('iridescence-animation-time', finalAnimationTime.toString());
    }
    
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
    
    if (this.whiteOverlay && this.whiteOverlay.parentNode) {
      this.whiteOverlay.parentNode.removeChild(this.whiteOverlay);
    }
    
    if (this.gl && this.gl.getExtension('WEBGL_lose_context')) {
      this.gl.getExtension('WEBGL_lose_context').loseContext();
    }
  }
}

// Initialize the iridescence background when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  // Remove any existing iridescence background
  const existingCanvas = document.querySelector('canvas[style*="z-index: -1"]');
  if (existingCanvas) {
    existingCanvas.remove();
  }
  
  // Remove any existing white overlay
  const existingOverlay = document.querySelector('div[style*="rgba(255, 255, 255, 0.8)"]');
  if (existingOverlay) {
    existingOverlay.remove();
  }
  
  // Clean up old localStorage keys
  localStorage.removeItem('iridescence-time');
  localStorage.removeItem('iridescence-last-update');
  
  // Create new iridescence background
  window.iridescenceBackground = new IridescenceBackground({
    color: [0.2, 0.5, 1.0], // Blue color (RGB values 0-1)
    speed: 0.45,
    amplitude: 0.1,
    mouseReact: false // Disabled mouse interaction
  });
});

// Export for potential use
window.IridescenceBackground = IridescenceBackground;
