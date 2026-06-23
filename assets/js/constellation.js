/* =====================================================================
   Particle Constellation Engine — Desire Group
   The brand mark IS the cosmos. Thousands of micro geometric primitives
   (triangles, circles, diamonds, squares @ 2–6px) drifting on the void,
   clustering into an organic rotating sphere. Palette-driven, no glow.
   Pure canvas 2D. Respects prefers-reduced-motion.
   ===================================================================== */
(() => {
  'use strict';

  const PALETTE = ['#8052ff', '#ffb829', '#15846e', '#ffffff'];
  const WEIGHTS = [0.34, 0.16, 0.18, 0.32]; // plum, amber, lichen, bone
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function pickColor() {
    let r = Math.random(), acc = 0;
    for (let i = 0; i < PALETTE.length; i++) {
      acc += WEIGHTS[i];
      if (r <= acc) return PALETTE[i];
    }
    return PALETTE[0];
  }

  // Draw one micro geometric primitive at (x,y)
  function drawShape(ctx, type, x, y, s, color, alpha) {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    switch (type) {
      case 0: // circle
        ctx.beginPath();
        ctx.arc(x, y, s * 0.5, 0, Math.PI * 2);
        ctx.fill();
        break;
      case 1: // square
        ctx.fillRect(x - s * 0.5, y - s * 0.5, s, s);
        break;
      case 2: // diamond
        ctx.beginPath();
        ctx.moveTo(x, y - s * 0.7);
        ctx.lineTo(x + s * 0.7, y);
        ctx.lineTo(x, y + s * 0.7);
        ctx.lineTo(x - s * 0.7, y);
        ctx.closePath();
        ctx.fill();
        break;
      default: // triangle (outlined — lets the void show through)
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, y - s * 0.7);
        ctx.lineTo(x + s * 0.65, y + s * 0.5);
        ctx.lineTo(x - s * 0.65, y + s * 0.5);
        ctx.closePath();
        ctx.stroke();
        break;
    }
    ctx.globalAlpha = 1;
  }

  /* ---------------------------------------------------------------
     HERO SPHERE — a rotating Fibonacci point-cloud projected to 2D.
     This is the focal "constellation" that owns the hero real estate.
  ---------------------------------------------------------------- */
  class SphereField {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.points = [];
      this.rot = 0;
      this.targetRX = 0; this.targetRY = 0;
      this.rx = 0; this.ry = 0;
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.build();
      this.resize();
      window.addEventListener('resize', () => this.resize());
      this.bindPointer();
    }
    build() {
      const N = window.innerWidth < 720 ? 520 : 1100;
      const gold = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < N; i++) {
        const y = 1 - (i / (N - 1)) * 2;
        const r = Math.sqrt(1 - y * y);
        const theta = gold * i;
        this.points.push({
          x: Math.cos(theta) * r,
          y: y,
          z: Math.sin(theta) * r,
          s: 1.4 + Math.random() * 3.4,
          type: (Math.random() * 4) | 0,
          color: pickColor(),
          tw: Math.random() * Math.PI * 2 // twinkle phase
        });
      }
    }
    bindPointer() {
      const move = (cx, cy) => {
        const rect = this.canvas.getBoundingClientRect();
        const nx = (cx - rect.left) / rect.width - 0.5;
        const ny = (cy - rect.top) / rect.height - 0.5;
        this.targetRY = nx * 0.9;
        this.targetRX = ny * 0.6;
      };
      window.addEventListener('mousemove', e => move(e.clientX, e.clientY), { passive: true });
      window.addEventListener('touchmove', e => {
        if (e.touches[0]) move(e.touches[0].clientX, e.touches[0].clientY);
      }, { passive: true });
    }
    resize() {
      const r = this.canvas.getBoundingClientRect();
      this.w = r.width; this.h = r.height;
      this.canvas.width = this.w * this.dpr;
      this.canvas.height = this.h * this.dpr;
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.radius = Math.min(this.w, this.h) * 0.42;
      this.cx = this.w * 0.5;
      this.cy = this.h * 0.5;
    }
    frame(t) {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);
      if (!reduceMotion) this.rot += 0.0016;
      this.rx += (this.targetRX - this.rx) * 0.05;
      this.ry += (this.targetRY - this.ry) * 0.05;

      const ry = this.rot + this.ry;
      const rx = this.rx;
      const cosY = Math.cos(ry), sinY = Math.sin(ry);
      const cosX = Math.cos(rx), sinX = Math.sin(rx);

      for (const p of this.points) {
        // rotate Y
        let x = p.x * cosY - p.z * sinY;
        let z = p.x * sinY + p.z * cosY;
        // rotate X
        let y = p.y * cosX - z * sinX;
        z = p.y * sinX + z * cosX;

        const persp = 1 / (1.8 - z); // depth scaling
        const sx = this.cx + x * this.radius * persp;
        const sy = this.cy + y * this.radius * persp;

        const depth = (z + 1) / 2;            // 0 (back) .. 1 (front)
        const twinkle = reduceMotion ? 1 : 0.65 + 0.35 * Math.sin(t * 0.002 + p.tw);
        const alpha = (0.18 + depth * 0.7) * twinkle;
        const size = p.s * (0.5 + depth * 0.9);
        drawShape(ctx, p.type, sx, sy, size, p.color, Math.min(alpha, 0.95));
      }
    }
  }

  /* ---------------------------------------------------------------
     AMBIENT DRIFT — sparse background micro-shapes across the void,
     fixed full-screen, slow parallax drift behind all content.
  ---------------------------------------------------------------- */
  class DriftField {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.particles = [];
      this.scrollY = 0;
      this.resize();
      this.spawn();
      window.addEventListener('resize', () => { this.resize(); this.spawn(); });
      window.addEventListener('scroll', () => { this.scrollY = window.scrollY; }, { passive: true });
    }
    resize() {
      this.w = window.innerWidth;
      this.h = window.innerHeight;
      this.canvas.width = this.w * this.dpr;
      this.canvas.height = this.h * this.dpr;
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    spawn() {
      const count = Math.min(160, Math.floor((this.w * this.h) / 14000));
      this.particles = [];
      for (let i = 0; i < count; i++) {
        this.particles.push({
          x: Math.random() * this.w,
          y: Math.random() * this.h,
          s: 1 + Math.random() * 3,
          type: (Math.random() * 4) | 0,
          color: pickColor(),
          vx: (Math.random() - 0.5) * 0.12,
          vy: -0.05 - Math.random() * 0.18,
          base: 0.08 + Math.random() * 0.30,
          tw: Math.random() * Math.PI * 2,
          depth: 0.3 + Math.random() * 0.7 // parallax factor
        });
      }
    }
    frame(t) {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);
      for (const p of this.particles) {
        if (!reduceMotion) {
          p.x += p.vx; p.y += p.vy;
          if (p.y < -8) { p.y = this.h + 8; p.x = Math.random() * this.w; }
          if (p.x < -8) p.x = this.w + 8;
          if (p.x > this.w + 8) p.x = -8;
        }
        const parallax = (this.scrollY * 0.04) * p.depth;
        const y = ((p.y - parallax) % (this.h + 16) + (this.h + 16)) % (this.h + 16);
        const twinkle = reduceMotion ? 1 : 0.6 + 0.4 * Math.sin(t * 0.0015 + p.tw);
        drawShape(ctx, p.type, p.x, y, p.s, p.color, p.base * twinkle);
      }
    }
  }

  /* ---------------------------------------------------------------
     FOCAL BURST — small dense cloud behind the section-two icon.
  ---------------------------------------------------------------- */
  class BurstField {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.particles = [];
      this.resize();
      this.spawn();
      window.addEventListener('resize', () => { this.resize(); this.spawn(); });
    }
    resize() {
      const r = this.canvas.getBoundingClientRect();
      this.w = r.width; this.h = r.height;
      this.canvas.width = this.w * this.dpr;
      this.canvas.height = this.h * this.dpr;
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    spawn() {
      const count = 220;
      this.particles = [];
      const cx = this.w / 2, cy = this.h / 2;
      const spread = Math.min(this.w, this.h) * 0.55;
      for (let i = 0; i < count; i++) {
        // gaussian-ish clustering toward centre
        const a = Math.random() * Math.PI * 2;
        const rad = Math.pow(Math.random(), 0.6) * spread;
        this.particles.push({
          x: cx + Math.cos(a) * rad,
          y: cy + Math.sin(a) * rad * 0.7,
          s: 1 + Math.random() * 3.5,
          type: (Math.random() * 4) | 0,
          color: pickColor(),
          base: 0.1 + (1 - rad / spread) * 0.5,
          tw: Math.random() * Math.PI * 2
        });
      }
    }
    frame(t) {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);
      for (const p of this.particles) {
        const twinkle = reduceMotion ? 1 : 0.55 + 0.45 * Math.sin(t * 0.0018 + p.tw);
        drawShape(ctx, p.type, p.x, p.y, p.s, p.color, p.base * twinkle);
      }
    }
  }

  /* ---------------------------------------------------------------
     Single RAF loop drives every field for efficiency.
  ---------------------------------------------------------------- */
  const fields = [];
  function register(f) { if (f) fields.push(f); }

  function loop(t) {
    for (const f of fields) f.frame(t);
    requestAnimationFrame(loop);
  }

  function init() {
    const bg = document.getElementById('bg-constellation');
    const hero = document.getElementById('hero-canvas');
    const burst = document.getElementById('focal-canvas');
    if (bg) register(new DriftField(bg));
    if (hero) register(new SphereField(hero));
    if (burst) register(new BurstField(burst));
    requestAnimationFrame(loop);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
