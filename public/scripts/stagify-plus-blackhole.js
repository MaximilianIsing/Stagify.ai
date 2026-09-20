      // Black-hole subscribe button — REAL gravitational lensing. A WebGL canvas
      // (just above the background video, below all content) samples the live
      // background video as a texture and bends it around the button: radial
      // deflection + frame-dragging swirl + a dark event horizon, photon ring and
      // accretion shimmer. Because the displacement fades to zero with distance and
      // the canvas reaches ~600px past the button on every side, the warp extends
      // well beyond the card with no clip edge. PC only; off on touch/reduced-motion/
      // subscribed. The canvas only renders while the cursor is near the button.
      //
      // The canvas is a BAND inside <main>, the scroll container, not a fixed
      // full-viewport layer, and that is load-bearing. <main> scrolls (styles.css:
      // `body,main{overflow-y:auto}`), the window never does, and scrolling is applied
      // by the compositor — so a fixed canvas had to chase the button with a
      // getBoundingClientRect() read every frame and visibly trailed it whenever a
      // frame landed late. Inside the scroller, layout carries the canvas and the
      // button together: u_center is a same-frame rect DIFFERENCE, which is
      // scroll-invariant, so a late frame can no longer detach the hole. The price is
      // that the canvas is no longer viewport-aligned, so sampling the (still fixed)
      // background video needs u_view + u_origin; a stale u_origin merely shifts the
      // sampled background a few px inside a region that is a distortion of it anyway.
      (function () {
        var stage = document.getElementById('bh-stage');
        var btn = document.getElementById('stagify-plus-checkout-link');
        var canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('bh-canvas'));
        var video = /** @type {HTMLVideoElement} */ (document.getElementById('background-video'));
        // The scrollport the canvas lives in, and the content box used to clamp the
        // band so it never adds scrollable height past the end of the page.
        var scroller = /** @type {HTMLElement} */ (document.querySelector('main.sp-page'));
        var inner = /** @type {HTMLElement} */ (document.querySelector('.sp-page__inner'));
        if (!stage || !btn || !canvas || !scroller || !inner) return;
        var canHover = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
        var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        var isMobile = window.matchMedia && window.matchMedia('(max-width: 768px)').matches;
        if (!canHover || reduce || isMobile) { canvas.style.display = 'none'; return; }

        var MAX = 420;            // px from button center where the warp begins
        var BASE_RS = 70;         // event-horizon radius in CSS px
        var BAND_H = 1300;        // canvas height in CSS px — keep in sync with stagify-plus.css
        var target = 0, cur = 0, running = false, lastPointer = null, lastTop = -1;
        var dpr = Math.min(window.devicePixelRatio || 1, 2);
        var t0 = performance.now();

        var gl = null, prog = null, tex = null;
        var uRes, uVid, uView, uOrigin, uCenter, uRs, uAmt, uTime, uTex;

        var VERT = 'attribute vec2 a_pos; void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }';
        var FRAG = [
          'precision highp float;',
          'uniform vec2 u_res;',     // canvas device px (gl_FragCoord space)
          'uniform vec2 u_vid;',     // video intrinsic px
          'uniform vec2 u_view;',    // viewport device px — the fixed video's box
          'uniform vec2 u_origin;',  // canvas top-left in viewport device px (can be negative)
          'uniform vec2 u_center;',  // hole center, canvas device px, top-left origin
          'uniform float u_rs;',     // event-horizon radius, device px
          'uniform float u_amt;',
          'uniform float u_time;',
          'uniform sampler2D u_tex;',
          'const vec3 BG = vec3(0.698, 0.769, 0.965);', // #b2c4f6, matches page bg
          // object-fit:cover mapping from a top-left CANVAS pixel to video UV. The
          // video is position:fixed at 100%/100% of the viewport, so the canvas-local
          // coordinate has to be lifted into viewport space first — that is u_origin.
          'vec2 coverUV(vec2 fragTL){',
          '  vec2 p = fragTL + u_origin;',
          '  float s = max(u_view.x/u_vid.x, u_view.y/u_vid.y);',
          '  vec2 disp = u_vid * s;',
          '  vec2 off = (u_view - disp) * 0.5;',
          '  return (p - off) / disp;',
          '}',
          'vec3 bgAt(vec2 fragTL){',
          '  vec2 uv = clamp(coverUV(fragTL), 0.0, 1.0);',
          '  vec3 v = texture2D(u_tex, uv).rgb;',
          '  return mix(BG, v, 0.8);',  // replicate video opacity:0.8 over #b2c4f6
          '}',
          'void main(){',
          '  vec2 fragTL = vec2(gl_FragCoord.x, u_res.y - gl_FragCoord.y);',
          '  vec2 d = fragTL - u_center;',
          '  float r = length(d);',
          '  vec2 dir = d / max(r, 0.001);',
          '  float rs = u_rs;',
          '  float amt = clamp(u_amt, 0.0, 1.0);',
          // gravitational deflection (px): sample farther out near the hole so the
          // background appears pulled/curved inward — the lensing.
          // Localize the warp: full strength near the hole, fading to the real
          // background by ~6 radii so the canvas blends seamlessly (no flash/seam).
          '  float ff = 1.0 - smoothstep(rs*2.8, rs*7.5, r);',
          '  float bend = (rs*rs) / max(r, 1.0) * 4.4 * amt * ff;',
          '  vec2 tang = vec2(-dir.y, dir.x);',
          '  float swirl = (rs*rs) / max(r*r, 1.0) * 70.0 * amt * ff;',  // frame dragging
          '  vec2 sampleP = fragTL + dir * bend + tang * swirl;',
          '  vec3 col = bgAt(sampleP);',
          // darken toward the hole, then the pure-black event horizon
          '  float fall = smoothstep(rs*0.95, rs*3.2, r);',
          '  col *= mix(1.0, fall, amt);',
          '  float horizon = smoothstep(rs*0.92, rs*1.03, r);',
          '  col *= mix(1.0, horizon, amt);',
          // bright photon ring (Einstein ring) just outside the horizon
          '  float ring = exp(-pow((r - rs*1.16)/(rs*0.10), 2.0));',
          '  col += ring * vec3(0.6, 0.8, 1.0) * 2.7 * amt;',
          // soft outer halo so the ring blooms around the card edge
          '  float halo = exp(-pow((r - rs*1.42)/(rs*0.32), 2.0));',
          '  col += halo * vec3(0.32, 0.58, 1.0) * 1.0 * amt;',
          // swirling accretion disk that wraps beyond the card
          '  float ang = atan(d.y, d.x);',
          '  float disk = exp(-pow((r - rs*2.05)/(rs*0.85), 2.0));',
          '  float sw = 0.55 + 0.45*sin(ang*3.0 + u_time*1.9 - r*0.02);',
          '  col += disk * sw * vec3(0.34, 0.6, 1.0) * 1.5 * amt;',
          '  gl_FragColor = vec4(col, ff * smoothstep(0.0, 0.05, amt));',  // localized; fades into the real video
          '}'
        ].join('\n');

        function compile(type, src) {
          var s = gl.createShader(type);
          gl.shaderSource(s, src);
          gl.compileShader(s);
          if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.warn('[bh] shader compile failed:', gl.getShaderInfoLog(s));
            return null;
          }
          return s;
        }
        function initGL() {
          try {
            gl = /** @type {WebGLRenderingContext} */ (canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: true })
              || canvas.getContext('experimental-webgl'));
          } catch (e) { gl = null; }
          if (!gl) return false;
          var v = compile(gl.VERTEX_SHADER, VERT), f = compile(gl.FRAGMENT_SHADER, FRAG);
          if (!v || !f) return false;
          prog = gl.createProgram();
          gl.attachShader(prog, v); gl.attachShader(prog, f); gl.linkProgram(prog);
          if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            console.warn('[bh] program link failed:', gl.getProgramInfoLog(prog));
            return false;
          }
          gl.useProgram(prog);
          var buf = gl.createBuffer();
          gl.bindBuffer(gl.ARRAY_BUFFER, buf);
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
          var loc = gl.getAttribLocation(prog, 'a_pos');
          gl.enableVertexAttribArray(loc);
          gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
          uRes = gl.getUniformLocation(prog, 'u_res');
          uVid = gl.getUniformLocation(prog, 'u_vid');
          uView = gl.getUniformLocation(prog, 'u_view');
          uOrigin = gl.getUniformLocation(prog, 'u_origin');
          uCenter = gl.getUniformLocation(prog, 'u_center');
          uRs = gl.getUniformLocation(prog, 'u_rs');
          uAmt = gl.getUniformLocation(prog, 'u_amt');
          uTime = gl.getUniformLocation(prog, 'u_time');
          uTex = gl.getUniformLocation(prog, 'u_tex');
          // Video texture (NPOT → clamp + linear, no mipmaps). Seed 1x1 so it's
          // valid before the first frame is available.
          tex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([178, 196, 246, 255]));
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          resize();
          return true;
        }
        function resize() {
          if (!gl) return;
          // Size from the canvas, not the window — it is a band inside <main> now.
          // clientWidth is 0 while the element is display:none, which is the case for
          // the resize() inside initGL(); tick() flips it to block before the first
          // render(), so the first real frame sizes correctly.
          if (!canvas.clientWidth || !canvas.clientHeight) return;
          var w = Math.max(1, Math.round(canvas.clientWidth * dpr));
          var h = Math.max(1, Math.round(canvas.clientHeight * dpr));
          if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
          gl.viewport(0, 0, canvas.width, canvas.height);
        }
        // Centre the band on the CTA, in CONTENT space. That coordinate does not change
        // while scrolling, so the guard below means no style write and no layout
        // invalidation during a scroll — while a card that moves for other reasons (the
        // .sp-hint--pending removal after /api/auth/me, a language switch, a font load,
        // a resize) is picked up on the next frame without any observer.
        // The clamp is what stops a band hanging past the last content from adding
        // scrollable height; it only trims reach where the effect's alpha is already 0.
        function placeBand() {
          var sr = stage.getBoundingClientRect();
          var mr = scroller.getBoundingClientRect();
          var stageMid = (sr.top - mr.top) + scroller.scrollTop + sr.height / 2;
          var maxTop = Math.max(0, inner.offsetTop + inner.offsetHeight - BAND_H);
          var top = Math.min(maxTop, Math.max(0, Math.round(stageMid - BAND_H / 2)));
          if (top !== lastTop) { lastTop = top; canvas.style.top = top + 'px'; }
        }
        function vidReady() {
          return video && video.readyState >= 2 && video.videoWidth > 0;
        }
        function render(amt) {
          if (!gl) return;
          placeBand();
          resize();
          gl.useProgram(prog);
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, tex);
          if (vidReady()) {
            try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video); } catch (e) {}
          }
          // Both rects are read in the same frame and only their DIFFERENCE is used,
          // which is invariant under scrolling — the fix for the hole trailing the
          // button. u_origin is the one value that can be a frame stale, and it only
          // shifts the sampled background inside the lens.
          var rb = btn.getBoundingClientRect();
          var rc = canvas.getBoundingClientRect();
          gl.uniform2f(uRes, canvas.width, canvas.height);
          gl.uniform2f(uVid, vidReady() ? video.videoWidth : 16, vidReady() ? video.videoHeight : 9);
          gl.uniform2f(uView, window.innerWidth * dpr, window.innerHeight * dpr);
          gl.uniform2f(uOrigin, rc.left * dpr, rc.top * dpr);
          gl.uniform2f(uCenter, (rb.left + rb.width / 2 - rc.left) * dpr, (rb.top + rb.height / 2 - rc.top) * dpr);
          gl.uniform1f(uRs, BASE_RS * dpr);
          gl.uniform1f(uAmt, amt);
          gl.uniform1f(uTime, (performance.now() - t0) * 0.001);
          gl.uniform1i(uTex, 0);
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          gl.drawArrays(gl.TRIANGLES, 0, 3);
        }

        var hasGL = initGL();
        if (!hasGL) canvas.style.display = 'none';

        function tick() {
          cur += (target - cur) * 0.14;
          if (cur < 0.004 && target < 0.004) {
            cur = 0;
            stage.style.setProperty('--bh', '0');
            canvas.style.display = 'none';
            running = false;
            return;
          }
          stage.style.setProperty('--bh', cur.toFixed(3));
          if (hasGL) { canvas.style.display = 'block'; render(cur); }
          requestAnimationFrame(tick);
        }
        function ensure() { if (!running) { running = true; requestAnimationFrame(tick); } }

        function updateTarget() {
          if (!lastPointer || btn.classList.contains('sp-gradient-checkout-btn--subscribed')) { target = 0; return; }
          var r = btn.getBoundingClientRect();
          var dx = lastPointer.x - (r.left + r.width / 2);
          var dy = lastPointer.y - (r.top + r.height / 2);
          var dist = Math.sqrt(dx * dx + dy * dy);
          var pr = Math.max(0, 1 - dist / MAX);
          target = pr * pr; // ramp up sharply near the button
        }

        window.addEventListener('mousemove', function (e) {
          lastPointer = { x: e.clientX, y: e.clientY };
          updateTarget();
          ensure();
        }, { passive: true });
        document.addEventListener('mouseleave', function () { lastPointer = null; target = 0; ensure(); });
        // <main> is the scroller, so this never fires on window. lastPointer is in
        // client coordinates and stays valid as the page moves under a still cursor:
        // without this the effect held whatever intensity it had while the CTA scrolled
        // away, and a loop that had decayed to zero stayed asleep until the mouse moved.
        scroller.addEventListener('scroll', function () { updateTarget(); ensure(); }, { passive: true });
        window.addEventListener('resize', function () { if (hasGL && running) { resize(); render(cur); } });
      })();

// Loaded as <script type="module">; this empty export marks the file as an ES
// module so it is covered by `eslint .` (see the auto-discovery in eslint.config.js).
export {};
