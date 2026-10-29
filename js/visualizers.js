(() => {
/* Unifier — visualizers
   Six hand-written Canvas 2D renderers plus a composite "Unified" stage.
   Every renderer receives the same feature frame, so they are interchangeable. */

const { BAND_COUNT, clamp, lerp } = window.UnifierCore;

/* ------------------------------------------------------------------ */
/* Palettes + colour helpers                                           */
/* ------------------------------------------------------------------ */
const PALETTES = {
  aurora: { s1: "#2dd4bf", s2: "#6366f1", s3: "#f472b6", bg: "#05080f" },
  ember:  { s1: "#fbbf24", s2: "#f97316", s3: "#ef4444", bg: "#0d0605" },
  ion:    { s1: "#22d3ee", s2: "#3b82f6", s3: "#a855f7", bg: "#04070f" },
  moss:   { s1: "#a3e635", s2: "#14b8a6", s3: "#0ea5e9", bg: "#040b08" },
  mono:   { s1: "#e2e8f0", s2: "#94a3b8", s3: "#64748b", bg: "#080a0d" },
};

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a, b, t) {
  return [Math.round(lerp(a[0], b[0], t)), Math.round(lerp(a[1], b[1], t)), Math.round(lerp(a[2], b[2], t))];
}

function rgba(c, a) { return `rgba(${c[0]},${c[1]},${c[2]},${a})`; }

/** Three-stop ramp across a palette, t in 0..1 */
function ramp(pal, t) {
  const x = clamp(t);
  return x < 0.5 ? mix(pal.rgb1, pal.rgb2, x * 2) : mix(pal.rgb2, pal.rgb3, (x - 0.5) * 2);
}

function makePal(name) {
  const p = PALETTES[name] || PALETTES.aurora;
  return {
    name: p.name,
    bg: p.bg,
    hex1: p.s1, hex2: p.s2, hex3: p.s3,
    rgb1: hexToRgb(p.s1), rgb2: hexToRgb(p.s2), rgb3: hexToRgb(p.s3),
  };
}

/* ------------------------------------------------------------------ */
/* Base renderer                                                       */
/* ------------------------------------------------------------------ */
class Base {
  constructor(env) { this.env = env; this.t = 0; }
  /* default: paint the background with a trail fade */
  clear(trails) {
    const { ctx, w, h, pal } = this.env;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = rgba(hexToRgb(pal.bg), clamp(1 - trails, 0.04, 1));
    ctx.fillRect(0, 0, w, h);
  }
  bgGlow(f, strength = 0.5) {
    const { ctx, w, h, pal } = this.env;
    const c = ramp(pal, 0.25 + f.centroid * 0.5);
    const g = ctx.createRadialGradient(w / 2, h * 0.55, 0, w / 2, h * 0.55, Math.max(w, h) * 0.62);
    g.addColorStop(0, rgba(c, 0.16 * strength * (0.5 + f.level)));
    g.addColorStop(0.55, rgba(pal.rgb2, 0.05 * strength));
    g.addColorStop(1, rgba(pal.rgb2, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
}

/* ------------------------------------------------------------------ */
/* 1. Spectrum bars                                                    */
/* ------------------------------------------------------------------ */
class Bars extends Base {
  draw(f) {
    const { ctx, w, h, pal, opts } = this.env;
    this.clear(opts.trails);
    this.bgGlow(f);

    const n = Math.max(18, Math.round(BAND_COUNT * opts.complexity));
    const gap = Math.max(1, w * 0.004);
    const bw = (w - gap * (n + 1)) / n;
    const base = opts.mirror ? h * 0.72 : h * 0.92;
    const maxH = base * 0.9;

    ctx.globalCompositeOperation = "lighter";

    for (let i = 0; i < n; i++) {
      const src = Math.min(BAND_COUNT - 1, Math.round((i / n) * BAND_COUNT));
      const v = f.bands[src];
      const pk = f.peaks[src];
      const x = gap + i * (bw + gap);
      const bh = Math.max(1.5, v * maxH * (0.6 + f.level * 0.8));
      const col = ramp(pal, Math.pow(i / n, 0.7));

      const g = ctx.createLinearGradient(0, base - bh, 0, base);
      g.addColorStop(0, rgba(col, 0.98));
      g.addColorStop(0.6, rgba(mix(col, pal.rgb2, 0.5), 0.85));
      g.addColorStop(1, rgba(mix(col, pal.rgb2, 0.8), 0.35));
      ctx.fillStyle = g;
      roundRect(ctx, x, base - bh, bw, bh, Math.min(bw * 0.45, 5));
      ctx.fill();

      if (opts.glow && v > 0.2) {
        ctx.shadowColor = rgba(col, 0.7);
        ctx.shadowBlur = 14 * v;
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      /* peak cap */
      const py = base - Math.max(bh, pk * maxH);
      ctx.fillStyle = rgba(pal.rgb1, 0.95);
      ctx.fillRect(x, py - 2, bw, 2);

      /* reflection */
      if (opts.mirror) {
        const rh = bh * 0.34;
        const rg = ctx.createLinearGradient(0, base, 0, base + rh);
        rg.addColorStop(0, rgba(col, 0.34));
        rg.addColorStop(1, rgba(col, 0));
        ctx.fillStyle = rg;
        ctx.fillRect(x, base, bw, rh);
      }
    }
    ctx.globalCompositeOperation = "source-over";

    if (opts.labels) this.labels();
    if (f.beat > 0.05) this.beatLine(f);
  }

  labels() {
    const { ctx, w, h, pal } = this.env;
    const marks = [60, 120, 250, 500, 1000, 2000, 4000, 8000, 16000];
    ctx.font = `500 ${Math.round(h * 0.022)}px ui-monospace, monospace`;
    ctx.fillStyle = rgba(pal.rgb1, 0.55);
    ctx.textAlign = "center";
    const nyq = 24000;
    marks.forEach((hz) => {
      const t = Math.log(hz / 38) / Math.log(16000 / 38);
      if (t < 0 || t > 1) return;
      const x = t * w;
      ctx.fillText(hz >= 1000 ? hz / 1000 + "k" : String(hz), x, h * 0.965);
      ctx.fillStyle = rgba(pal.rgb1, 0.16);
      ctx.fillRect(x, h * 0.86, 1, h * 0.06);
      ctx.fillStyle = rgba(pal.rgb1, 0.55);
    });
    ctx.textAlign = "left";
  }

  beatLine(f) {
    const { ctx, w, h, pal } = this.env;
    ctx.fillStyle = rgba(pal.rgb3, 0.14 * f.beat);
    ctx.fillRect(0, 0, w, h);
  }
}

/* ------------------------------------------------------------------ */
/* 2. Waveform                                                         */
/* ------------------------------------------------------------------ */
class Wave extends Base {
  draw(f) {
    const { ctx, w, h, pal, opts } = this.env;
    this.clear(opts.trails * 0.85);
    this.bgGlow(f, 0.7);

    const layers = Math.round(clamp(1 + opts.complexity * 2.2, 1, 5));
    ctx.globalCompositeOperation = "lighter";
    ctx.lineJoin = "round";

    for (let l = layers - 1; l >= 0; l--) {
      const depth = l / Math.max(1, layers - 1);
      const amp = h * 0.3 * (1 - depth * 0.55) * (0.35 + f.level * 1.5);
      const phase = f.t * (0.6 + depth * 0.9) * (l % 2 ? -1 : 1);
      const col = ramp(pal, depth * 0.85);
      const alpha = 0.9 - depth * 0.55;

      ctx.beginPath();
      const step = Math.max(1, Math.floor(f.wave.length / (w * opts.complexity)));
      for (let x = 0; x <= w; x++) {
        const idx = Math.min(f.wave.length - 1, Math.floor((x / w) * f.wave.length));
        const base = f.wave[idx];
        const wobble = Math.sin(x * 0.012 + phase) * 0.18 * (0.4 + f.centroid);
        const y = h * 0.5 + (base + wobble) * amp * (1 - depth * 0.3);
        if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        void step;
      }
      ctx.strokeStyle = rgba(col, alpha);
      ctx.lineWidth = (2.6 - depth * 1.6) * (1 + f.level * 0.7);
      if (opts.glow) { ctx.shadowColor = rgba(col, 0.8); ctx.shadowBlur = 18 * (1 - depth); }
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    /* centre ribbon: filled area under the main wave */
    ctx.beginPath();
    ctx.moveTo(0, h * 0.5);
    for (let x = 0; x <= w; x++) {
      const idx = Math.min(f.wave.length - 1, Math.floor((x / w) * f.wave.length));
      ctx.lineTo(x, h * 0.5 + f.wave[idx] * h * 0.42 * (0.3 + f.level * 1.4));
    }
    ctx.lineTo(w, h * 0.5);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, h * 0.1, 0, h * 0.9);
    g.addColorStop(0, rgba(pal.rgb1, 0.06 + f.level * 0.1));
    g.addColorStop(0.5, rgba(pal.rgb2, 0.16 + f.level * 0.16));
    g.addColorStop(1, rgba(pal.rgb1, 0.06));
    ctx.fillStyle = g;
    ctx.fill();

    ctx.globalCompositeOperation = "source-over";
    this.axis();
  }

  axis() {
    const { ctx, w, h, pal } = this.env;
    ctx.strokeStyle = rgba(pal.rgb1, 0.12);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h * 0.5);
    ctx.lineTo(w, h * 0.5);
    ctx.stroke();
  }
}

/* ------------------------------------------------------------------ */
/* 3. Radial                                                            */
/* ------------------------------------------------------------------ */
class Radial extends Base {
  draw(f) {
    const { ctx, w, h, pal, opts } = this.env;
    this.clear(opts.trails);
    this.bgGlow(f, 0.9);

    const cx = w / 2;
    const cy = h / 2;
    const r0 = Math.min(w, h) * 0.17;
    const n = Math.round(clamp(48 * opts.complexity, 24, 128));
    const spin = f.t * 0.18 * opts.speed;

    ctx.globalCompositeOperation = "lighter";
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(spin);

    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const src = Math.round((i / n) * (BAND_COUNT - 1));
      const v = f.bands[src];
      const len = r0 * 0.35 + v * r0 * 1.5 * (0.5 + f.level);
      const col = ramp(pal, i / n);
      ctx.strokeStyle = rgba(col, 0.55 + v * 0.45);
      ctx.lineWidth = Math.max(1, (Math.PI * 2 * r0) / n * 0.55);
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      ctx.lineTo(Math.cos(a) * (r0 + len), Math.sin(a) * (r0 + len));
      ctx.stroke();

      const pk = f.peaks[src];
      if (pk > 0.06) {
        ctx.strokeStyle = rgba(pal.rgb1, 0.8);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * (r0 + pk * r0 * 1.5), Math.sin(a) * (r0 + pk * r0 * 1.5));
        ctx.lineTo(Math.cos(a) * (r0 + pk * r0 * 1.5 + 4), Math.sin(a) * (r0 + pk * r0 * 1.5 + 4));
        ctx.stroke();
      }
    }

    /* waveform ring */
    ctx.rotate(-spin * 1.6);
    ctx.beginPath();
    const steps = 240;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const idx = Math.floor((i / steps) * f.wave.length);
      const rr = r0 * 0.78 + f.wave[idx] * r0 * 0.5 * (0.4 + f.level);
      const x = Math.cos(a) * rr;
      const y = Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = rgba(pal.rgb3, 0.75);
    ctx.lineWidth = 1.8;
    if (opts.glow) { ctx.shadowColor = rgba(pal.rgb3, 0.8); ctx.shadowBlur = 16; }
    ctx.stroke();
    ctx.shadowBlur = 0;

    /* core: breathing orb reacting to level and beat */
    const coreR = r0 * (0.3 + f.level * 0.45 + f.beat * 0.14);
    const cg = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR * 2.6);
    cg.addColorStop(0, rgba(pal.rgb1, 0.95));
    cg.addColorStop(0.35, rgba(pal.rgb2, 0.5));
    cg.addColorStop(1, rgba(pal.rgb2, 0));
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.arc(0, 0, coreR * 2.6, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
    ctx.globalCompositeOperation = "source-over";

    if (f.beat > 0.05) {
      ctx.strokeStyle = rgba(pal.rgb1, 0.35 * f.beat);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r0 * (1.6 + (1 - f.beat) * 2.4), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

/* ------------------------------------------------------------------ */
/* 4. Particles                                                         */
/* ------------------------------------------------------------------ */
class Particles extends Base {
  constructor(env) {
    super(env);
    this.ps = [];
    this.max = 900;
    this.emit = 0;
    this.rings = [];
  }

  draw(f) {
    const { ctx, w, h, pal, opts } = this.env;
    this.clear(opts.trails * 0.92);
    this.bgGlow(f, 0.45);

    const cx = w / 2;
    const cy = h / 2;
    const budget = Math.round(this.max * opts.complexity);
    const rate = f.level * 26 + f.beat * 90 + f.speech * 40;

    for (let i = 0; i < rate; i++) {
      if (this.ps.length >= budget) break;
      const a = Math.random() * Math.PI * 2;
      const speed = 0.6 + Math.random() * 3.4 * (0.4 + f.level + f.centroid);
      const band = Math.floor(Math.random() * BAND_COUNT);
      const col = ramp(pal, band / BAND_COUNT);
      this.ps.push({
        x: cx, y: cy,
        vx: Math.cos(a) * speed,
        vy: Math.sin(a) * speed,
        life: 1,
        decay: 0.006 + Math.random() * 0.012,
        r: 0.7 + Math.random() * 2.6,
        col,
        band,
      });
    }

    ctx.globalCompositeOperation = "lighter";
    const turb = 0.0009 * (0.5 + f.centroid * 3);
    for (let i = this.ps.length - 1; i >= 0; i--) {
      const p = this.ps[i];
      const dx = p.x - cx;
      const dy = p.y - cy;
      const d2 = dx * dx + dy * dy + 40;
      /* curl-ish field: tangential drift + radial push from low bands */
      p.vx += (-dy / d2) * 60 * turb * 60 + (dx / Math.sqrt(d2)) * f.bands[p.band] * 0.16;
      p.vy += (dx / d2) * 60 * turb * 60 + (dy / Math.sqrt(d2)) * f.bands[p.band] * 0.16;
      p.vx *= 0.985;
      p.vy *= 0.985;
      p.x += p.vx * opts.speed;
      p.y += p.vy * opts.speed;
      p.life -= p.decay * (0.6 + opts.speed);

      if (p.life <= 0 || p.x < -40 || p.x > w + 40 || p.y < -40 || p.y > h + 40) {
        this.ps.splice(i, 1);
        continue;
      }
      const a = p.life * 0.85;
      ctx.fillStyle = rgba(p.col, a);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2);
      ctx.fill();
      if (p.life > 0.75) {
        ctx.strokeStyle = rgba(p.col, (p.life - 0.75) * 1.4);
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 3, p.y - p.vy * 3);
        ctx.stroke();
      }
    }

    /* beat rings */
    if (f.beat > 0.85) this.rings.push({ r: 0, a: 1 });
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const rg = this.rings[i];
      rg.r += (6 + f.level * 22) * opts.speed;
      rg.a -= 0.022 * opts.speed;
      if (rg.a <= 0) { this.rings.splice(i, 1); continue; }
      ctx.strokeStyle = rgba(pal.rgb1, rg.a * 0.7);
      ctx.lineWidth = 2.4 * rg.a;
      ctx.beginPath();
      ctx.arc(cx, cy, rg.r, 0, Math.PI * 2);
      ctx.stroke();
    }

    /* core */
    const cr = Math.min(w, h) * (0.03 + f.level * 0.06);
    const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr * 5);
    cg.addColorStop(0, rgba(pal.rgb1, 0.9));
    cg.addColorStop(0.4, rgba(pal.rgb2, 0.35));
    cg.addColorStop(1, rgba(pal.rgb2, 0));
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.arc(cx, cy, cr * 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalCompositeOperation = "source-over";
  }
}

/* ------------------------------------------------------------------ */
/* 5. Tunnel                                                            */
/* ------------------------------------------------------------------ */
class Tunnel extends Base {
  constructor(env) {
    super(env);
    this.rings = [];
    this.z = 0;
    this.grid = 0;
  }

  draw(f) {
    const { ctx, w, h, pal, opts } = this.env;
    this.clear(opts.trails * 0.7);
    this.bgGlow(f, 0.6);

    const cx = w / 2;
    const cy = h / 2;
    const depth = 22;
    const speed = (0.35 + f.level * 1.6) * opts.speed;
    this.z += speed * f.dt * 3.2;
    if (this.z > 1) {
      this.z -= 1;
      this.rings.push({ z: 1, col: ramp(pal, Math.random()), w: 1 });
    }
    if (f.beat > 0.8) this.rings.push({ z: 1, col: pal.rgb1, w: 2.4, bold: true });

    ctx.globalCompositeOperation = "lighter";
    ctx.lineJoin = "round";

    const rings = this.rings.concat(
      Array.from({ length: depth }, (_, i) => ({ z: (i + this.z) / depth, col: null, w: 1, ambient: true }))
    );

    for (const rg of rings) {
      rg.z -= speed * f.dt * 0.42;
      if (rg.z <= 0.02) continue;
      const persp = 1 / rg.z;
      const scale = Math.min(persp * 0.34, 14);
      const col = rg.col || ramp(pal, 0.2 + (1 - rg.z) * 0.6);
      const alpha = rg.ambient ? clamp((1 - rg.z) * 0.34) : clamp(rg.z * 0.7);
      const side = Math.min(w, h) * 0.5 * scale;
      const sides = 6;
      const rot = f.t * 0.22 * opts.speed + rg.z * 1.4;
      ctx.strokeStyle = rgba(col, alpha * (rg.bold ? 1.6 : 1));
      ctx.lineWidth = clamp((rg.w * scale) / 4, 0.5, 6);
      ctx.beginPath();
      for (let s = 0; s <= sides; s++) {
        const a = (s / sides) * Math.PI * 2 + rot;
        const wob = 1 + f.bands[Math.floor(((s / sides) % 1) * (BAND_COUNT - 1))] * 0.35;
        const x = cx + Math.cos(a) * side * wob;
        const y = cy + Math.sin(a) * side * wob;
        if (s === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (opts.glow && rg.bold) { ctx.shadowColor = rgba(col, 0.9); ctx.shadowBlur = 22; ctx.stroke(); ctx.shadowBlur = 0; }
    }

    this.rings = this.rings.filter((rg) => rg.z > 0.03);

    /* vanishing core */
    const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.min(w, h) * 0.16);
    cg.addColorStop(0, rgba(pal.rgb1, 0.75));
    cg.addColorStop(1, rgba(pal.rgb2, 0));
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.arc(cx, cy, Math.min(w, h) * 0.16, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalCompositeOperation = "source-over";
  }
}

/* ------------------------------------------------------------------ */
/* 6. Unified — every layer at once                                    */
/* ------------------------------------------------------------------ */
class Unified extends Base {
  constructor(env) {
    super(env);
    this.ps = [];
    this.rings = [];
    this.mote = 0;
  }

  draw(f) {
    const { ctx, w, h, pal, opts } = this.env;
    this.clear(opts.trails);
    this.bgGlow(f, 1);

    const cx = w / 2;
    const cy = h / 2;

    /* ---- layer 1: drifting field motes (agent "thinking" ambience) ---- */
    this.mote += f.dt * opts.speed;
    ctx.globalCompositeOperation = "lighter";
    const motes = Math.round(70 * opts.complexity);
    for (let i = 0; i < motes; i++) {
      const a = (i / motes) * Math.PI * 2 + this.mote * 0.12;
      const rr = Math.min(w, h) * (0.24 + 0.3 * ((i * 37) % 100) / 100) + Math.sin(this.mote + i) * 8 * (1 + f.level * 3);
      const x = cx + Math.cos(a) * rr * (w / Math.min(w, h)) * 0.8;
      const y = cy + Math.sin(a) * rr;
      const s = 0.7 + ((i * 13) % 7) / 7 * 1.6;
      ctx.fillStyle = rgba(ramp(pal, (i % 32) / 32), 0.1 + f.level * 0.22);
      ctx.beginPath();
      ctx.arc(x, y, s, 0, Math.PI * 2);
      ctx.fill();
    }

    /* ---- layer 2: radial spectrum ---- */
    const r0 = Math.min(w, h) * 0.15;
    const n = Math.round(clamp(72 * opts.complexity, 36, 160));
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(f.t * 0.1 * opts.speed);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const src = Math.round((i / n) * (BAND_COUNT - 1));
      const v = f.bands[src];
      const len = r0 * 0.22 + v * r0 * 1.35 * (0.5 + f.level);
      const col = ramp(pal, i / n);
      ctx.strokeStyle = rgba(col, 0.4 + v * 0.6);
      ctx.lineWidth = Math.max(1, (Math.PI * 2 * r0) / n * 0.5);
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      ctx.lineTo(Math.cos(a) * (r0 + len), Math.sin(a) * (r0 + len));
      ctx.stroke();
    }
    ctx.restore();

    /* ---- layer 3: waveform ribbon across the frame ---- */
    ctx.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const idx = Math.min(f.wave.length - 1, Math.floor((x / w) * f.wave.length));
      const env = Math.sin((x / w) * Math.PI);
      const y = h * 0.5 + f.wave[idx] * h * 0.2 * env * (0.5 + f.level * 1.4);
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = rgba(pal.rgb3, 0.5 + f.level * 0.4);
    ctx.lineWidth = 1.6;
    if (opts.glow) { ctx.shadowColor = rgba(pal.rgb3, 0.7); ctx.shadowBlur = 14; }
    ctx.stroke();
    ctx.shadowBlur = 0;

    /* ---- layer 4: token particles ---- */
    const rate = f.level * 16 + f.beat * 60 + f.pulse * 70;
    const budget = Math.round(420 * opts.complexity);
    for (let i = 0; i < rate; i++) {
      if (this.ps.length >= budget) break;
      const a = Math.random() * Math.PI * 2;
      const sp = 0.5 + Math.random() * 2.6;
      this.ps.push({
        x: cx, y: cy,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 1, decay: 0.008 + Math.random() * 0.01,
        r: 0.6 + Math.random() * 2, col: ramp(pal, Math.random()),
      });
    }
    for (let i = this.ps.length - 1; i >= 0; i--) {
      const p = this.ps[i];
      p.x += p.vx * opts.speed;
      p.y += p.vy * opts.speed;
      p.vx *= 0.99;
      p.vy *= 0.99;
      p.life -= p.decay * opts.speed;
      if (p.life <= 0 || p.x < -20 || p.x > w + 20 || p.y < -20 || p.y > h + 20) { this.ps.splice(i, 1); continue; }
      ctx.fillStyle = rgba(p.col, p.life * 0.8);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2);
      ctx.fill();
    }

    /* ---- layer 5: event flashes ---- */
    if (f.beat > 0.7) this.rings.push({ r: r0, a: 1 });
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const rg = this.rings[i];
      rg.r += 7 * opts.speed * (1 + f.level * 3);
      rg.a -= 0.02 * opts.speed;
      if (rg.a <= 0) { this.rings.splice(i, 1); continue; }
      ctx.strokeStyle = rgba(pal.rgb1, rg.a * 0.55);
      ctx.lineWidth = 2 * rg.a;
      ctx.beginPath();
      ctx.arc(cx, cy, rg.r, 0, Math.PI * 2);
      ctx.stroke();
    }

    /* core orb */
    const coreR = r0 * (0.42 + f.level * 0.5 + f.beat * 0.2);
    const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 3);
    cg.addColorStop(0, rgba(pal.rgb1, 0.92));
    cg.addColorStop(0.32, rgba(pal.rgb2, 0.42));
    cg.addColorStop(1, rgba(pal.rgb2, 0));
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.arc(cx, cy, coreR * 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalCompositeOperation = "source-over";

    /* tool flash: cyan sweep */
    if (f.flashTool > 0.02) {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, rgba(pal.rgb1, 0));
      g.addColorStop(clamp(1 - f.flashTool), rgba(pal.rgb1, 0.35 * f.flashTool));
      g.addColorStop(1, rgba(pal.rgb1, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    /* done flash: expanding halo */
    if (f.flashDone > 0.02) {
      ctx.strokeStyle = rgba(pal.rgb1, 0.5 * f.flashDone);
      ctx.lineWidth = 3 * f.flashDone;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.min(w, h) * (0.3 + (1 - f.flashDone) * 0.6), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Shared overlays (drawn after any mode)                              */
/* ------------------------------------------------------------------ */
function drawGrid(env) {
  const { ctx, w, h, pal } = env;
  ctx.save();
  ctx.strokeStyle = rgba(pal.rgb1, 0.08);
  ctx.lineWidth = 1;
  const step = w / 16;
  ctx.beginPath();
  for (let x = step; x < w; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
  for (let y = step; y < h; y += step) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
  ctx.stroke();
  ctx.restore();
}

function drawErrorFlash(env, f) {
  if (f.flashError < 0.02) return;
  const { ctx, w, h } = env;
  const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2, w / 2, h / 2, Math.max(w, h) * 0.72);
  g.addColorStop(0, `rgba(255,60,60,0)`);
  g.addColorStop(1, `rgba(255,60,60,${0.42 * f.flashError})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

const MODES = {
  bars: Bars,
  wave: Wave,
  radial: Radial,
  particles: Particles,
  tunnel: Tunnel,
  unified: Unified,
};

window.UnifierViz = { MODES, PALETTES, makePal, ramp, rgba, drawGrid, drawErrorFlash, hexToRgb };

})();
