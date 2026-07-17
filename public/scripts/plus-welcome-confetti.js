// One-shot celebratory confetti for the Stagify+ welcome page. Pure canvas, no
// dependencies. On load it fires an even, full-width burst from the bottom edge
// (plus a small pop from the badge), then the pieces flutter down slowly (a
// paper-like ~3.75px/frame terminal fall) with a soft side-to-side sway before
// fading out. The canvas then clears and removes itself. Skipped for reduced-motion.

const COLORS = ['#2563eb', '#60a5fa', '#1d4ed8', '#7eb3fc', '#fbbf24', '#f472b6', '#34d399', '#ffffff'];
const TAU = Math.PI * 2;

function launch() {
  const media = window.matchMedia;
  if (media && media('(prefers-reduced-motion: reduce)').matches) return;

  const canvas = /** @type {HTMLCanvasElement | null} */ (document.getElementById('pw-confetti'));
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  let width = 0;
  let height = 0;
  let dpr = 1;
  const resize = () => {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener('resize', resize);

  const rand = (a, b) => a + Math.random() * (b - a);
  const pieces = [];

  // Push one piece launched from (x,y) at `angle` (radians) with `speed`, plus a
  // small random start delay so a burst fans out over a few frames rather than
  // popping all at once.
  const spawn = (x, y, angle, speed, delaySpread) => {
    pieces.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: rand(7, 13),
      ribbon: Math.random() < 0.28,
      shape: Math.floor(Math.random() * 3),
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      rot: Math.random() * TAU,
      vrot: (Math.random() - 0.5) * 0.12,
      sway: Math.random() * TAU,
      vsway: rand(0.02, 0.05),
      swayAmp: rand(0.8, 2),
      tumble: Math.random() * TAU,
      vtumble: rand(0.02, 0.05),
      delay: Math.floor(Math.random() * delaySpread),
      life: 0,
      maxLife: rand(200, 300),
    });
  };

  // Even, full-width burst from the bottom edge: launch x is spread uniformly
  // corner-to-corner (no weak corners, no clumping), and varied speeds fill the
  // height as pieces rise and drift back down.
  const WALL = 108;
  for (let i = 0; i < WALL; i += 1) {
    const x = rand(0.02, 0.98) * width;
    const y = height * rand(0.99, 1.05);
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * (Math.PI * 0.5);
    spawn(x, y, angle, rand(14, 26), 10);
  }
  // A small all-directions pop out of the badge as a central accent.
  const POP = 30;
  for (let i = 0; i < POP; i += 1) {
    spawn(width * 0.5, height * 0.34, Math.random() * TAU, rand(4, 12), 6);
  }

  const GRAVITY = 0.15;
  const DRAG_X = 0.985; // keep horizontal drift alive so pieces disperse
  const DRAG_Y = 0.96;  // terminal fall ≈ GRAVITY / (1 - DRAG_Y) ≈ 3.75px/frame — slow, paper-like
  let frame = 0;

  const tick = () => {
    frame += 1;
    ctx.clearRect(0, 0, width, height);
    let alive = 0;
    for (const p of pieces) {
      if (p.delay > 0) {
        p.delay -= 1;
        alive += 1;
        continue; // not launched yet
      }
      p.life += 1;
      p.vx *= DRAG_X;
      p.vy = p.vy * DRAG_Y + GRAVITY;
      p.sway += p.vsway;
      p.x += p.vx + Math.sin(p.sway) * p.swayAmp; // gentle lateral flutter
      p.y += p.vy;
      p.rot += p.vrot;
      p.tumble += p.vtumble;

      const remaining = p.maxLife - p.life;
      if (remaining <= 0 || p.y > height + 40) continue;
      alive += 1;

      const alpha = Math.min(1, p.life / 8, remaining / 70);      // ease in, ease out
      const sy = 0.45 + 0.55 * (0.5 + 0.5 * Math.cos(p.tumble));  // soft foreshorten, never collapses
      ctx.save();
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.scale(1, sy);
      ctx.fillStyle = p.color;
      if (p.ribbon) {
        ctx.fillRect(-p.size * 0.3, -p.size, p.size * 0.6, p.size * 2); // streamer
      } else if (p.shape === 0) {
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size); // square
      } else if (p.shape === 1) {
        ctx.beginPath();
        ctx.arc(0, 0, p.size / 2.2, 0, TAU); // dot
        ctx.fill();
      } else {
        ctx.beginPath(); // triangle
        ctx.moveTo(0, -p.size / 2);
        ctx.lineTo(p.size / 2, p.size / 2);
        ctx.lineTo(-p.size / 2, p.size / 2);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
    if (alive > 0 && frame < 520) {
      window.requestAnimationFrame(tick);
    } else {
      ctx.clearRect(0, 0, width, height);
      window.removeEventListener('resize', resize);
      canvas.remove();
    }
  };
  window.requestAnimationFrame(tick);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', launch);
} else {
  launch();
}

export {};
