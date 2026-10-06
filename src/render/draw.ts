// Frame renderer. renderFrame(i) is a pure function of the frame index: particles are regenerated from a seeded hash
// of their spawn frame and integrated analytically, so preview, seeking and export always produce identical pixels.
import type { Track } from '../track.ts';
import type { Motion, MotionEvent } from '../motion.ts';
import type { Style } from './style.ts';
import { computeLayout, type Layout, type Settings } from './layout.ts';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface Scene {
  track: Track; motion: Motion; style: Style; settings: Settings; layout: Layout;
  /** Device pixels per layout pixel (preview renders smaller than the export). */
  scale: number;
  fx: OffscreenCanvas; fxc: OffscreenCanvasRenderingContext2D;
  tint: OffscreenCanvas; tintc: OffscreenCanvasRenderingContext2D;
  b1: OffscreenCanvas; b1c: OffscreenCanvasRenderingContext2D;
  b2: OffscreenCanvas; b2c: OffscreenCanvasRenderingContext2D;
}

const ctx2d = (c: OffscreenCanvas) => c.getContext('2d') as OffscreenCanvasRenderingContext2D;

export function createScene(track: Track, motion: Motion, style: Style, settings: Settings, scale = 1): Scene {
  const layout = computeLayout(settings);
  const w = Math.max(1, Math.round(layout.W * scale)), h = Math.max(1, Math.round(layout.H * scale));
  const fx = new OffscreenCanvas(w, h), tint = new OffscreenCanvas(w, h);
  const b1 = new OffscreenCanvas(Math.max(1, w >> 2), Math.max(1, h >> 2));
  const b2 = new OffscreenCanvas(Math.max(1, w >> 4), Math.max(1, h >> 4));
  return { track, motion, style, settings, layout, scale, fx, fxc: ctx2d(fx), tint, tintc: ctx2d(tint), b1, b1c: ctx2d(b1), b2, b2c: ctx2d(b2) };
}

// ---------- small helpers ----------

type RGBA = [number, number, number, number];
const colorCache = new Map<string, RGBA>();
export function parseColor(s: string): RGBA {
  let c = colorCache.get(s);
  if (c) return c;
  const m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((ch) => ch + ch).join('');
    c = [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  } else {
    const n = /rgba?\(([^)]+)\)/.exec(s)?.[1].split(',').map((v) => parseFloat(v)) ?? [255, 255, 255, 1];
    c = [n[0], n[1], n[2], n[3] ?? 1];
  }
  colorCache.set(s, c);
  return c;
}
const css = (c: RGBA, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.max(0, Math.min(1, c[3] * a)).toFixed(3)})`;
const mix = (a: RGBA, b: RGBA, t: number): RGBA => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
/** Rainbow hue for a frame (deterministic: depends only on the frame index). */
const hueAt = (f: number, fps: number, extra = 0) => ((f / fps) * 140 + extra) % 360;
const hsl = (h: number, a = 1, l = 65) => `hsla(${h.toFixed(0)},100%,${l}%,${a.toFixed(3)})`;
/** HSL hue (full saturation, 65 % lightness) → #rrggbb, for code that needs an RGBA tuple. */
function hslHex(h: number): string {
  const l = 0.65, a = 0.35, f = (n: number) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return '#' + [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (u: number) => 1 - (1 - u) * (1 - u) * (1 - u);
const easeOutBack = (u: number) => { const c = 1.9; return 1 + (c + 1) * Math.pow(u - 1, 3) + c * Math.pow(u - 1, 2); };

function hash(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  return (h ^ (h >>> 16)) >>> 0;
}
function rng(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Position at age t of a particle with drag k and gravity g (exact solution of v' = -k v + g). */
function ballistic(x0: number, y0: number, vx: number, vy: number, k: number, g: number, t: number): [number, number] {
  const e = (1 - Math.exp(-k * t)) / k;
  return [x0 + vx * e, y0 + vy * e + g * (t - e) / k];
}

/** First index of an event with frame >= f. */
function firstEvent(ev: MotionEvent[], f: number) {
  let lo = 0, hi = ev.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (ev[mid].frame < f) lo = mid + 1; else hi = mid; }
  return lo;
}

// ---------- frame ----------

interface FrameInfo {
  i: number; fps: number; r: number; C: number; s: Style; sc: Scene;
  dot: [[number, number], [number, number]]; // device-independent pixel positions of both dots
  live: boolean;
  recent: MotionEvent[]; // events within the last 2.5 s
  spans: MotionEvent[]; // full-throttle / hang-time spans running now or ended less than SPAN_HOLD ago
}

/** Seconds a throttle timer stays on screen (frozen) after its span ends. */
const SPAN_HOLD = 1.5;
const isSpan = (e: MotionEvent) => e.kind === 'full' || e.kind === 'hang';
/** Elapsed seconds of a span at frame i, exact from the log's start time, capped at its duration. */
const spanElapsed = (e: MotionEvent, sc: Scene, i: number) => Math.min(e.dur!, Math.max(0, sc.track.start + i / sc.track.fps - e.t0!));
/** 6.240 s → "6.240", 75.5 s → "1:15.500". */
const fmtSecs = (t: number) => {
  const m = Math.floor(t / 60), sec = t - m * 60;
  return m ? `${m}:${sec.toFixed(3).padStart(6, '0')}` : sec.toFixed(3);
};
/** Clock style for the stats readout: 0:06.240. */
const fmtClock = (t: number) => `${Math.floor(t / 60)}:${(t % 60).toFixed(3).padStart(6, '0')}`;
/** 0..1 visibility of the newest throttle timer: quick fade in, held, fades out SPAN_HOLD after the span. */
function timerVisibility(F: FrameInfo): number {
  const e = F.spans.at(-1);
  if (!e) return 0;
  const age = (F.i - e.frame) / F.fps, after = Math.max(0, (F.i - e.end!) / F.fps);
  return Math.min(clamp01(age / 0.05), 1 - clamp01((after - (SPAN_HOLD - 0.4)) / 0.4));
}

export function dotPos(sc: Scene, side: 0 | 1, f: number): [number, number] {
  const { layout: L, motion: m, track } = sc;
  const c = side ? L.right : L.left;
  const ff = Math.max(0, Math.min(track.frames - 1, f));
  if (!track.live[ff]) return [c.x, c.y];
  return side ? [c.x + m.rx[ff] * L.r, c.y + m.ry[ff] * L.r] : [c.x + m.lx[ff] * L.r, c.y + m.ly[ff] * L.r];
}

export function renderFrame(ctx: Ctx2D, sc: Scene, i: number, background: string | null = null) {
  const { layout: L, style: s, settings, track, motion } = sc;
  const fps = track.fps, r = L.r, C = settings.chaos;
  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  i = Math.max(0, Math.min(track.frames - 1, i));

  const ev = motion.events;
  const recent = ev.slice(firstEvent(ev, i - Math.ceil(2.5 * fps)), firstEvent(ev, i + 1));
  const spans = ev.filter((e) => isSpan(e) && e.frame <= i && i <= e.end! + SPAN_HOLD * fps);
  const F: FrameInfo = { i, fps, r, C, s, sc, dot: [dotPos(sc, 0, i), dotPos(sc, 1, i)], live: !!track.live[i], recent, spans };

  // Arm / disarm animation state.
  let hudAlpha = 1, hudScale = 1;
  if (s.intro) {
    const arm = ev.find((e) => e.kind === 'arm');
    const off = ev.find((e) => e.kind === 'disarm' || e.kind === 'crash');
    if (arm) {
      if (i < arm.frame) { hudAlpha = 0.45; hudScale = 0.85; }
      else hudScale = 0.85 + 0.15 * easeOutBack(clamp01((i - arm.frame) / (0.45 * fps)));
    }
    if (off && i > off.frame) hudAlpha = 1 - 0.65 * clamp01((i - off.frame) / (0.8 * fps));
  }

  // Screen shake from recent impacts.
  let shx = 0, shy = 0, crashAge = Infinity;
  if (s.shake > 0) {
    const R = rng(hash(i, 991, 3));
    for (const e of recent) {
      const age = (i - e.frame) / fps;
      const amp = e.kind === 'snap' ? 0.6 : e.kind === 'punch' || e.kind === 'full' ? 0.8 : e.kind === 'crash' ? 3 : e.kind === 'hang' ? 0 : e.label && e.kind !== 'arm' && e.kind !== 'disarm' ? 1.2 : 0;
      const T = e.kind === 'crash' ? 0.7 : 0.35;
      if (amp && age < T) { const k = amp * (1 - age / T) ** 2; shx += (R() - 0.5) * 2 * k; shy += (R() - 0.5) * 2 * k; }
    }
    shx *= s.shake * r * C; shy *= s.shake * r * C;
  }
  for (const e of recent) if (e.kind === 'crash') crashAge = (i - e.frame) / fps;

  const k = sc.scale;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, cw, ch);
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, cw, ch); }

  const hudT = (c: Ctx2D) => {
    // scale about the HUD centre for the arm pop-in, then shake
    const hx = L.hud.x + L.hud.w / 2, hy = L.hud.y + L.hud.h / 2;
    c.setTransform(k * hudScale, 0, 0, k * hudScale, k * (hx - hx * hudScale + shx), k * (hy - hy * hudScale + shy));
  };

  // 1. Base: plates, grids, crosshairs, rings, throttle bar, labels.
  hudT(ctx);
  ctx.globalAlpha = hudAlpha;
  drawBase(ctx, F);

  // 2. Effects layer (additive).
  const fx = sc.fxc;
  fx.setTransform(1, 0, 0, 1, 0, 0);
  fx.globalCompositeOperation = 'source-over';
  fx.clearRect(0, 0, sc.fx.width, sc.fx.height);
  hudT(fx);
  fx.globalCompositeOperation = 'lighter';
  drawEffects(fx, F);

  // 3. Composite effects (+ chromatic fringes + bloom).
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = hudAlpha;
  ctx.globalCompositeOperation = 'lighter';
  ctx.drawImage(sc.fx, 0, 0);
  const chroma = s.chroma + (crashAge < 0.6 ? 0.25 * (1 - crashAge / 0.6) * C : 0);
  if (chroma > 0) {
    const d = chroma * r * k;
    for (const [col, dx] of [['#ff0000', -d], ['#0040ff', d]] as const) {
      const t = sc.tintc;
      t.globalCompositeOperation = 'copy'; t.drawImage(sc.fx, 0, 0);
      t.globalCompositeOperation = 'multiply'; t.fillStyle = col; t.fillRect(0, 0, sc.tint.width, sc.tint.height);
      t.globalCompositeOperation = 'destination-in'; t.drawImage(sc.fx, 0, 0);
      ctx.globalAlpha = hudAlpha * 0.7;
      ctx.drawImage(sc.tint, dx, 0);
    }
  }
  if (s.bloom > 0) {
    sc.b1c.globalCompositeOperation = 'copy'; sc.b1c.imageSmoothingQuality = 'high';
    sc.b1c.drawImage(sc.fx, 0, 0, sc.b1.width, sc.b1.height);
    sc.b2c.globalCompositeOperation = 'copy'; sc.b2c.imageSmoothingQuality = 'high';
    sc.b2c.drawImage(sc.b1, 0, 0, sc.b2.width, sc.b2.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.globalAlpha = hudAlpha * s.bloom * 0.55; ctx.drawImage(sc.b1, 0, 0, cw, ch);
    ctx.globalAlpha = hudAlpha * s.bloom * 0.7; ctx.drawImage(sc.b2, 0, 0, cw, ch);
  }

  // 4. Crisp dots and text on top.
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = hudAlpha;
  hudT(ctx);
  drawDots(ctx, F);
  ctx.globalAlpha = 1;
  drawText(ctx, F);

  // 5. Glitch: on impacts, slice horizontal bands and shove them sideways.
  if (s.glitch > 0) {
    let g = 0;
    for (const e of recent) {
      const age = (i - e.frame) / fps;
      const amp = e.kind === 'crash' ? 3 : e.kind === 'snap' ? 0.6 : e.kind === 'punch' || e.kind === 'full' ? 0.8 : e.kind === 'hang' ? 0 : e.label && e.kind !== 'arm' && e.kind !== 'disarm' ? 1.2 : e.kind === 'arm' ? 1 : 0;
      const T = e.kind === 'crash' ? 0.8 : 0.25;
      if (amp && age < T) g += amp * (1 - age / T);
    }
    const R = rng(hash(i, 4242, 7));
    if (R() < 0.012) g += 0.5; // the odd idle flicker
    g *= s.glitch * C;
    if (g > 0.05) {
      const t = sc.tintc;
      t.globalCompositeOperation = 'copy'; t.drawImage(ctx.canvas, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const bands = 2 + Math.floor(R() * 3 + g * 3);
      for (let b = 0; b < bands; b++) {
        const y = Math.floor(R() * ch), h = Math.max(2, Math.floor((0.01 + R() * 0.05) * ch));
        const dx = (R() - 0.5) * 2 * g * r * 0.35 * k;
        ctx.clearRect(0, y, cw, h);
        ctx.drawImage(sc.tint, 0, y, cw, h, dx, y, cw, h);
      }
    }
  }

  // 6. Scanlines cut through everything (in device pixels).
  if (s.scan > 0) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0,0,0,${(0.55 * s.scan).toFixed(3)})`;
    const step = Math.max(3, Math.round(3 * k * (L.H / 1080) * 1.5));
    for (let y = (i % 2) * Math.floor(step / 2); y < ch; y += step) ctx.fillRect(0, y, cw, Math.max(1, step / 3));
    ctx.globalCompositeOperation = 'source-over';
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
}

// ---------- layers ----------

function gimbalPath(c: Ctx2D, s: Style, x: number, y: number, r: number) {
  c.beginPath();
  if (s.frame === 'square' || s.frame === 'brackets') c.rect(x - r, y - r, 2 * r, 2 * r);
  else c.arc(x, y, r, 0, Math.PI * 2);
}

function drawBase(c: Ctx2D, F: FrameInfo) {
  const { s, r, sc, i } = F;
  const L = sc.layout;
  const lw = (v: number) => Math.max(1 / sc.scale, v * r);
  for (const side of [0, 1] as const) {
    const { x, y } = side ? L.right : L.left;
    if (s.plate) { gimbalPath(c, s, x, y, r); c.fillStyle = s.plate; c.fill(); }
    if (s.grid > 0 || s.cross) {
      c.save();
      gimbalPath(c, s, x, y, r); c.clip();
      if (s.grid > 0) {
        c.strokeStyle = css(parseColor(s.cross ?? s.ring), 0.45); c.lineWidth = lw(0.012);
        c.beginPath();
        for (let g = 1; g <= s.grid; g++) {
          const d = (g / (s.grid + 1)) * r;
          for (const sgn of [-1, 1]) { c.moveTo(x - r, y + sgn * d); c.lineTo(x + r, y + sgn * d); c.moveTo(x + sgn * d, y - r); c.lineTo(x + sgn * d, y + r); }
        }
        c.stroke();
      }
      if (s.cross) {
        c.strokeStyle = s.cross; c.lineWidth = lw(0.03);
        c.beginPath(); c.moveTo(x - r, y); c.lineTo(x + r, y); c.moveTo(x, y - r); c.lineTo(x, y + r); c.stroke();
      }
      c.restore();
    }
    if (s.frame !== 'none') {
      if (s.frame === 'brackets') {
        // Corner brackets only, like a targeting reticle.
        const k = r * 0.38;
        c.beginPath();
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          c.moveTo(x + sx * r, y + sy * (r - k)); c.lineTo(x + sx * r, y + sy * r); c.lineTo(x + sx * (r - k), y + sy * r);
        }
      } else gimbalPath(c, s, x, y, r);
      let stroke: string | CanvasGradient = s.ring;
      if (s.ring === 'rainbow') {
        const rot = ((i / F.fps) * 1.6) % (Math.PI * 2);
        if ('createConicGradient' in c) {
          const g = c.createConicGradient(rot, x, y);
          for (let h = 0; h <= 6; h++) g.addColorStop(h / 6, hsl(h * 60, 1, 68));
          stroke = g;
        } else stroke = hsl(hueAt(i, F.fps));
      }
      c.strokeStyle = stroke; c.lineWidth = lw(s.ringW);
      if (s.glow > 0) { c.shadowColor = s.ring === 'rainbow' ? hsl(hueAt(i, F.fps), 0.9) : s.ring; c.shadowBlur = s.glow * r * sc.scale; }
      c.stroke();
      c.shadowBlur = 0;
    }
  }
  const full = s.popups && s.frame !== 'none' ? F.spans.find((e) => e.kind === 'full' && i <= e.end!) : undefined;
  if (full) {
    const g = sc.settings.mode === 2 ? L.left : L.right;
    const pulse = 0.55 + 0.45 * Math.sin(((i - full.frame) / F.fps) * Math.PI * 6);
    const hot = s.hot ?? s.dot;
    gimbalPath(c, s, g.x, g.y, r * 1.06);
    c.strokeStyle = css(parseColor(hot), 0.5 + 0.5 * pulse); c.lineWidth = lw(s.ringW * 1.6);
    c.shadowColor = hot; c.shadowBlur = r * (0.25 + 0.35 * pulse) * sc.scale;
    c.stroke();
    c.shadowBlur = 0;
  }
  if (s.thrBar) {
    const thrLeft = sc.settings.mode === 2;
    const g = thrLeft ? L.left : L.right;
    const bx = thrLeft ? g.x - r * 1.32 : g.x + r * 1.2, bw = r * 0.12;
    const th = sc.track.throttle[i];
    c.fillStyle = 'rgba(0,0,0,0.3)'; c.fillRect(bx, g.y - r, bw, 2 * r);
    const col = s.hot ? mix(parseColor(s.dot), parseColor(s.hot), th) : parseColor(s.dot);
    c.fillStyle = css(col);
    if (s.glow > 0) { c.shadowColor = css(col); c.shadowBlur = s.glow * r * sc.scale; }
    c.fillRect(bx, g.y + r - 2 * r * th, bw, 2 * r * th);
    c.shadowBlur = 0;
  }
  if (s.readout) {
    // Terminal-style live values: signed stick + 10-bit hex, throttle as percent.
    const tr = sc.track, m2 = sc.settings.mode === 2;
    const hex = (v: number) => '0x' + Math.round(((v + 1) / 2) * 1023).toString(16).toUpperCase().padStart(3, '0');
    const sg = (v: number) => (v >= 0 ? '+' : '-') + Math.abs(v).toFixed(2);
    const th = `${String(Math.round(tr.throttle[i] * 100)).padStart(3, ' ')}%`;
    const left = m2 ? [`YAW ${sg(tr.yaw[i])} ${hex(tr.yaw[i])}`, `THR ${th}`] : [`YAW ${sg(tr.yaw[i])} ${hex(tr.yaw[i])}`, `PIT ${sg(tr.pitch[i])} ${hex(tr.pitch[i])}`];
    const right = m2 ? [`ROL ${sg(tr.roll[i])} ${hex(tr.roll[i])}`, `PIT ${sg(tr.pitch[i])} ${hex(tr.pitch[i])}`] : [`ROL ${sg(tr.roll[i])} ${hex(tr.roll[i])}`, `THR ${th}`];
    c.font = s.font.replace('{px}', (r * 0.22).toFixed(1));
    c.textAlign = 'left'; c.textBaseline = 'top';
    c.fillStyle = css(parseColor(s.textColor), 0.9);
    if (s.glow > 0) { c.shadowColor = s.textColor; c.shadowBlur = s.glow * r * 0.5 * sc.scale; }
    left.forEach((t, k) => c.fillText(t, L.left.x - r, L.left.y + r * (1.1 + k * 0.22)));
    right.forEach((t, k) => c.fillText(t, L.right.x - r, L.right.y + r * (1.1 + k * 0.22)));
    c.shadowBlur = 0;
  }
  if (s.labels) {
    const m2 = sc.settings.mode === 2;
    c.font = `600 ${(r * 0.2).toFixed(1)}px system-ui, sans-serif`;
    c.textAlign = 'center'; c.textBaseline = 'top';
    c.fillStyle = css(parseColor(s.ring), 0.8);
    c.fillText(m2 ? 'THR · YAW' : 'PIT · YAW', L.left.x, L.left.y + r * 1.12);
    c.fillText(m2 ? 'PIT · ROL' : 'THR · ROL', L.right.x, L.right.y + r * 1.12);
  }
}

function drawDots(c: Ctx2D, F: FrameInfo) {
  const { s, r, sc, i, live } = F;
  const m = sc.motion;
  for (const side of [0, 1] as const) {
    const [x, y] = F.dot[side];
    const speed = side ? m.speedR[i] : m.speedL[i];
    let col = parseColor(s.dot);
    if (s.hot) col = mix(col, parseColor(s.hot), clamp01(speed / 9));
    if (!live) col = [255, 255, 255, 0.43];
    const dr = s.dotR * r;
    c.beginPath();
    if (s.dotShape === 'square') c.rect(x - dr, y - dr * 1.3, dr * 2, dr * 2.6); // block cursor
    else c.arc(x, y, dr, 0, Math.PI * 2);
    c.fillStyle = css(col);
    if (s.glow > 0 && live) { c.shadowColor = css(col); c.shadowBlur = s.glow * r * 1.4 * sc.scale; }
    c.fill();
    c.shadowBlur = 0;
    if (s.dotRing && live) { c.strokeStyle = s.dotRing; c.lineWidth = Math.max(1 / sc.scale, 0.04 * r); c.stroke(); }
  }
}

function drawEffects(c: Ctx2D, F: FrameInfo) {
  const { s } = F;
  if (s.trail > 0) drawTrails(c, F);
  if (s.glow > 0 && F.live) drawHalos(c, F);
  if (s.embers > 0) drawEmbers(c, F);
  if (s.flame > 0) drawFlame(c, F);
  if (s.sparks > 0) drawSparks(c, F);
  if (s.sparks > 0 || s.shock > 0) drawBursts(c, F);
  if (s.shock > 0) drawShockwaves(c, F);
}

function drawTrails(c: Ctx2D, F: FrameInfo) {
  const { s, r, sc, i, fps } = F;
  const N = Math.max(2, Math.round(s.trail * fps));
  const base = parseColor(s.dot), hot = s.hot ? parseColor(s.hot) : base;
  c.lineCap = 'round';
  for (const side of [0, 1] as const) {
    const speed = side ? sc.motion.speedR : sc.motion.speedL;
    const pts: [number, number][] = [];
    for (let f = i - N; f <= i; f++) pts.push(f >= 0 && sc.track.live[f] ? dotPos(sc, side, f) : [NaN, NaN]);
    for (let kk = 1; kk < pts.length; kk++) {
      const a = pts[kk - 1], b = pts[kk];
      if (isNaN(a[0]) || isNaN(b[0])) continue;
      const p = pts[kk - 2] && !isNaN(pts[kk - 2][0]) ? pts[kk - 2] : a;
      const u = kk / (pts.length - 1);
      const f = i - N + kk;
      const col = mix(base, hot, clamp01(speed[Math.max(0, f)] / 9));
      // Quadratic through midpoints keeps fast moves smooth at low frame rates.
      c.beginPath();
      c.moveTo((p[0] + a[0]) / 2, (p[1] + a[1]) / 2);
      c.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      c.lineTo(b[0], b[1]);
      c.strokeStyle = s.rainbow ? hsl(hueAt(f, fps, side * 180), u ** 1.4 * 0.95) : css(col, u ** 1.6 * 0.9);
      c.lineWidth = Math.max(1 / sc.scale, s.trailW * r * (0.25 + 0.75 * u));
      c.stroke();
    }
  }
}

function drawHalos(c: Ctx2D, F: FrameInfo) {
  const { s, r, sc, i } = F;
  for (const side of [0, 1] as const) {
    const [x, y] = F.dot[side];
    const speed = side ? sc.motion.speedR[i] : sc.motion.speedL[i];
    let col = parseColor(s.dot);
    if (s.hot) col = mix(col, parseColor(s.hot), clamp01(speed / 9));
    const R = s.dotR * r * (3 + 2 * clamp01(speed / 9) * F.C);
    const g = c.createRadialGradient(x, y, 0, x, y, R);
    if (s.rainbow) { const h = hueAt(i, F.fps, side * 180); g.addColorStop(0, hsl(h, 0.6)); g.addColorStop(1, hsl(h + 60, 0)); }
    else { g.addColorStop(0, css(col, 0.55)); g.addColorStop(1, css(col, 0)); }
    c.fillStyle = g; c.beginPath(); c.arc(x, y, R, 0, Math.PI * 2); c.fill();
  }
}

const GLYPHS = '01アイウエオカキクケコサシスセソタチツテトﾊﾋﾌﾍﾎ<>/\\#$%&*+=';
/** Cheap deterministic 0..1 from a particle's launch values (keeps particles stateless). */
const pr = (a: number, b: number) => { const v = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return v - Math.floor(v); };

/** Draw one particle in the style's spark shape: a streak, a twinkling star, or a falling terminal glyph. */
function streak(c: Ctx2D, F: FrameInfo, x0: number, y0: number, vx: number, vy: number, age: number, life: number, k: number, g: number, palette: RGBA[], w: number) {
  const u = age / life;
  const s = F.s;
  const seed = pr(x0 + vx, y0 + vy);
  const col = palette[Math.min(palette.length - 1, Math.floor(u * palette.length * 1.6))];
  const fill = s.rainbow ? hsl(seed * 360, 1 - u * u, 75) : css(col, 1 - u * u);
  if (s.sparkShape === 'star') {
    const [x, y] = ballistic(x0, y0, vx * 0.7, vy * 0.7, k, g * 0.3, age);
    const R = w * F.r * 3.2 * (1 - u * 0.5) * (0.7 + 0.5 * Math.sin(age * 28 + seed * 20) ** 2);
    const a = age * 5 + seed * 6, q = R * 0.22;
    c.fillStyle = fill;
    c.beginPath();
    for (let p = 0; p < 4; p++) {
      const t = a + (p * Math.PI) / 2;
      c.lineTo(x + Math.cos(t) * R, y + Math.sin(t) * R);
      c.lineTo(x + Math.cos(t + Math.PI / 4) * q, y + Math.sin(t + Math.PI / 4) * q);
    }
    c.closePath(); c.fill();
    return;
  }
  if (s.sparkShape === 'glyph') {
    // Burst out a little, then rain down like a terminal screen.
    const [x, y] = ballistic(x0, y0, vx * 0.35, vy * 0.35, 4, Math.abs(g) * 1.2 + F.r * 2, age);
    const ch = GLYPHS[Math.floor(pr(seed, Math.floor(age * 12)) * GLYPHS.length)];
    c.font = s.font.replace('{px}', (w * F.r * 7).toFixed(1));
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = u < 0.08 ? '#ffffff' : fill;
    c.fillText(ch, x, y);
    return;
  }
  const [x1, y1] = ballistic(x0, y0, vx, vy, k, g, age);
  const [x2, y2] = ballistic(x0, y0, vx, vy, k, g, Math.max(0, age - 0.03));
  c.strokeStyle = fill;
  c.lineWidth = Math.max(1 / F.sc.scale, w * F.r * (1 - u * 0.7));
  c.beginPath(); c.moveTo(x2, y2); c.lineTo(x1, y1); c.stroke();
}

function drawSparks(c: Ctx2D, F: FrameInfo) {
  const { s, r, sc, i, fps, C } = F;
  const palette = s.sparkColors.map(parseColor);
  const maxAge = 0.8, look = Math.ceil(maxAge * fps), perFrame = 60 / fps;
  c.lineCap = 'round';
  // More chaos also lowers the speed at which sparks start, so gentle flying can light up too.
  const v0 = 2.2 / (0.4 + 0.6 * C);
  for (const side of [0, 1] as const) {
    const speed = side ? sc.motion.speedR : sc.motion.speedL;
    for (let f = Math.max(1, i - look); f <= i; f++) {
      const excess = speed[f] - v0;
      if (excess <= 0 || !sc.track.live[f]) continue;
      const R = rng(hash(f, side, 1));
      const count = Math.min(30, Math.floor(excess * s.sparks * C * 1.6 * perFrame + R()));
      if (!count) continue;
      const [ax, ay] = dotPos(sc, side, f - 1), [bx, by] = dotPos(sc, side, f);
      const dir = Math.atan2(by - ay, bx - ax);
      for (let j = 0; j < count; j++) {
        const sub = R(), life = 0.3 + 0.5 * R();
        const age = (i - f + sub) / fps;
        const th = dir + (R() - 0.5) * 2.4, v = r * (2.5 + 5 * R()) * (0.6 + 0.12 * Math.min(speed[f], 12));
        const w = 0.03 + 0.03 * R();
        if (age > life) continue;
        streak(c, F, ax + (bx - ax) * (1 - sub), ay + (by - ay) * (1 - sub), Math.cos(th) * v, Math.sin(th) * v, age, life, 3, 4 * r, palette, w);
      }
    }
  }
}

function drawBursts(c: Ctx2D, F: FrameInfo) {
  const { s, r, sc, i, fps, C } = F;
  const L = sc.layout;
  const palette = s.sparkColors.map(parseColor);
  const amount = Math.max(s.sparks, s.shock * 0.6) * C;
  c.lineCap = 'round';
  for (const e of F.recent) {
    const age0 = (i - e.frame) / fps;
    if (age0 > 1.2) continue;
    const R = rng(hash(e.frame, 77, e.side ?? 9));
    if (e.kind === 'snap' || e.kind === 'punch') {
      const c0 = e.side ? L.right : L.left;
      const x0 = c0.x + (e.x ?? 0) * r, y0 = c0.y + (e.y ?? 0) * r;
      const out = Math.atan2(e.y ?? 0, e.x ?? 1);
      const n = Math.round((e.kind === 'punch' ? 50 : 34) * amount);
      for (let j = 0; j < n; j++) {
        const life = 0.4 + 0.5 * R(), th = out + (R() - 0.5) * 2.8, v = r * (4 + 9 * R());
        if (age0 < life) streak(c, F, x0, y0, Math.cos(th) * v, Math.sin(th) * v, age0, life, 3.2, 3 * r, palette, 0.04 + 0.03 * R());
      }
    } else if (e.label && (e.kind === 'flip' || e.kind === 'roll' || e.kind === 'spin')) {
      // Ring of sparks off both gimbals; bigger for multi-turn tricks and combos.
      const n = Math.round(40 * amount * Math.min(3, (e.turns ?? 1) * 0.7 + (e.combo ?? 1) * 0.3));
      for (const g of [L.left, L.right]) {
        for (let j = 0; j < n; j++) {
          const life = 0.5 + 0.6 * R(), th = R() * Math.PI * 2, v = r * (3 + 7 * R());
          if (age0 < life) streak(c, F, g.x + Math.cos(th) * r, g.y + Math.sin(th) * r, Math.cos(th) * v, Math.sin(th) * v, age0, life, 2.6, 2 * r, palette, 0.035 + 0.03 * R());
        }
      }
    } else if (e.kind === 'crash') {
      const n = Math.round(120 * amount);
      const cx = L.hud.x + L.hud.w / 2, cy = L.hud.y + L.hud.h / 2;
      const red: RGBA[] = [[255, 255, 255, 1], [255, 80, 60, 1], [200, 20, 20, 1]];
      for (let j = 0; j < n; j++) {
        const life = 0.6 + 0.6 * R(), th = R() * Math.PI * 2, v = r * (4 + 12 * R());
        if (age0 < life) streak(c, F, cx, cy, Math.cos(th) * v, Math.sin(th) * v, age0, life, 2.5, 5 * r, red, 0.05);
      }
    }
  }
}

function ring(c: Ctx2D, x: number, y: number, rad: number, w: number, col: string) {
  c.beginPath(); c.arc(x, y, Math.max(0.1, rad), 0, Math.PI * 2);
  c.strokeStyle = col; c.lineWidth = Math.max(0.5, w); c.stroke();
}

function drawShockwaves(c: Ctx2D, F: FrameInfo) {
  const { s, r, sc, i, fps, C } = F;
  const L = sc.layout;
  // A rainbow ring has no single colour: borrow the current hue.
  const rb = s.ring === 'rainbow' ? parseColor(hslHex(hueAt(i, fps))) : null;
  const hot = rb ?? parseColor(s.hot ?? s.ring), ringC = rb ?? parseColor(s.ring);
  const S = s.shock * Math.min(1.5, C);
  for (const e of F.recent) {
    const age = (i - e.frame) / fps;
    if (e.kind === 'snap' || e.kind === 'punch') {
      const T = 0.45;
      if (age > T) continue;
      const u = age / T, c0 = e.side ? L.right : L.left;
      const x = c0.x + (e.x ?? 0) * r, y = c0.y + (e.y ?? 0) * r;
      ring(c, x, y, r * (0.15 + 1.3 * easeOut(u)), r * 0.14 * (1 - u), css(hot, (1 - u) * S));
      // gimbal frame flashes on impact
      if (age < 0.2) { gimbalPath(c, s, c0.x, c0.y, r); c.strokeStyle = css(ringC, (1 - age / 0.2) * S); c.lineWidth = r * 0.12; c.stroke(); }
    } else if (e.kind === 'flip' || e.kind === 'roll' || e.kind === 'spin' || e.kind === 'crash') {
      const T = e.kind === 'crash' ? 0.9 : 0.6;
      if (age > T) continue;
      const u = age / T, cx = L.hud.x + L.hud.w / 2, cy = L.hud.y + L.hud.h / 2;
      const col = e.kind === 'crash' ? parseColor('#ff2020') : hot;
      ring(c, cx, cy, L.hud.w * 0.75 * easeOut(u), r * 0.22 * (1 - u), css(col, (1 - u) * S));
      ring(c, cx, cy, L.hud.w * 0.5 * easeOut(Math.max(0, u - 0.15) / 0.85), r * 0.1 * (1 - u), css(ringC, (1 - u) * S * 0.8));
    }
  }
}

const FLAME: RGBA[] = [[255, 250, 230, 1], [255, 214, 70, 1], [255, 130, 30, 1], [230, 40, 0, 1], [120, 10, 0, 1]];

function drawFlame(c: Ctx2D, F: FrameInfo) {
  const { s, r, sc, i, fps, C } = F;
  const tr = sc.track, side: 0 | 1 = sc.settings.mode === 2 ? 0 : 1;
  const look = Math.ceil(0.5 * fps), perFrame = 60 / fps;
  const punches = F.recent.filter((e) => e.kind === 'punch');
  for (let f = Math.max(1, i - look); f <= i; f++) {
    if (!tr.live[f]) continue;
    const th = tr.throttle[f];
    const boost = punches.some((e) => f >= e.frame && f - e.frame < 0.6 * fps) ? 2.5
      : F.spans.some((e) => e.kind === 'full' && f >= e.frame && f <= e.end!) ? 1.8 : 1;
    const R = rng(hash(f, 501, side));
    const count = Math.min(40, Math.floor(s.flame * C * th ** 1.5 * 9 * perFrame * boost + R()));
    const [x0, y0] = dotPos(sc, side, f);
    for (let j = 0; j < count; j++) {
      const sub = R(), life = 0.18 + 0.3 * R();
      const age = (i - f + sub) / fps;
      if (age > life) continue;
      const u = age / life;
      const [x, y] = ballistic(x0 + (R() - 0.5) * r * 0.12, y0, (R() - 0.5) * r * 1.4, r * (2 + 3 * R()) * (0.6 + th), 2, -1.5 * r, age);
      const col = FLAME[Math.min(FLAME.length - 1, Math.floor(u * FLAME.length))];
      c.fillStyle = css(col, (1 - u) * 0.55);
      c.beginPath(); c.arc(x, y, r * (0.05 + 0.16 * u) * (0.7 + 0.6 * th), 0, Math.PI * 2); c.fill();
    }
  }
}

function drawEmbers(c: Ctx2D, F: FrameInfo) {
  const { s, r, sc, i, fps, C } = F;
  const L = sc.layout, tr = sc.track;
  const look = Math.ceil(2 * fps), perFrame = 60 / fps;
  const palette = [parseColor('#ffd23f'), parseColor('#ff7a1a'), parseColor('#ff2a00')];
  for (let f = Math.max(0, i - look); f <= i; f++) {
    const R = rng(hash(f, 733, 0));
    const th = tr.live[f] ? tr.throttle[f] : 0;
    const count = Math.min(5, Math.floor(s.embers * C * (0.15 + th) * 1.6 * perFrame + R()));
    for (let j = 0; j < count; j++) {
      const sub = R(), life = 1.1 + 1.0 * R();
      const age = (i - f + sub) / fps;
      if (age > life) continue;
      const u = age / life;
      const x0 = L.hud.x - r * 0.3 + R() * (L.hud.w + r * 0.6), y0 = L.hud.y + L.hud.h + r * 0.1;
      const sway = Math.sin(age * (2 + 3 * R()) + R() * 6) * r * 0.25;
      const y = y0 - r * (0.8 + 1.6 * R()) * age;
      const flick = 0.6 + 0.4 * Math.sin(age * 25 + j);
      c.fillStyle = s.rainbow ? hsl(R() * 360, (1 - u) * flick, 82) : css(palette[Math.floor(R() * 3)], (1 - u) * flick);
      c.beginPath(); c.arc(x0 + sway, y, r * (0.02 + 0.025 * R()), 0, Math.PI * 2); c.fill();
    }
  }
}

function drawText(c: Ctx2D, F: FrameInfo) {
  const { s, r, sc, i, fps } = F;
  const L = sc.layout;
  const k = sc.scale;
  const font = (px: number) => s.font.replace('{px}', px.toFixed(1));
  const cx = L.hud.x + L.hud.w / 2;
  c.setTransform(k, 0, 0, k, 0, 0);
  c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';

  if (s.popups) {
    drawTimers(c, F);
    const timerUp = F.spans.length > 0 ? r * 0.55 : 0; // just clears the timer label; tight crop has ~2.3 r of headroom
    const pops = F.recent.filter((e) => e.label && !isSpan(e) && (e.kind !== 'arm' || s.intro) && (e.kind !== 'disarm' || s.intro));
    // With a timer up there's room for one popup above it, not two.
    const shown = pops.filter((e) => (i - e.frame) / fps < (e.kind === 'crash' ? 2.5 : 1.3)).slice(timerUp ? -1 : -2);
    shown.forEach((e, idx) => {
      const age = (i - e.frame) / fps, T = e.kind === 'crash' ? 2.5 : 1.3;
      const label = s.labelMap[e.label!] ?? e.label!;
      const alpha = 1 - clamp01((age - (T - 0.35)) / 0.35);
      const lift = (idx < shown.length - 1 ? r * 0.75 : 0) + timerUp;
      const crash = e.kind === 'crash';
      if (s.popupStyle === 'terminal') {
        // Typed out at ~40 chars/s with a blinking block cursor, left-aligned like a console.
        const size = (crash ? 0.62 : e.kind === 'arm' || e.kind === 'disarm' ? 0.36 : 0.5) * r;
        const line = `> ${label.replace(/ /g, '_')}`;
        const shownText = line.slice(0, Math.min(line.length, Math.floor(age * 40) + 1));
        const cursor = shownText.length < line.length || Math.floor(age * 4) % 2 === 0 ? '█' : '';
        const col = crash ? '#ff3355' : s.textColor;
        const y = L.hud.y - r * 0.85 - lift;
        c.save();
        c.globalAlpha = alpha;
        c.font = font(size);
        c.textAlign = 'left';
        c.shadowColor = col; c.shadowBlur = size * 0.45 * k;
        c.fillStyle = col; c.fillText(shownText + cursor, L.hud.x, y);
        if ((e.combo ?? 1) >= 2 && age > line.length / 40) {
          c.font = font(size * 0.6);
          c.fillText(`  COMBO x${e.combo}`, L.hud.x, y + size * 0.7);
        }
        c.restore();
        return;
      }
      const size = (crash ? 0.95 : e.kind === 'arm' || e.kind === 'disarm' ? 0.34 : e.kind === 'punch' ? 0.5 : 0.62) * r;
      const pop = age < 0.14 ? easeOutBack(age / 0.14) * 1.15 : 1.15 - 0.15 * clamp01((age - 0.14) / 0.2);
      const y = L.hud.y - r * 1.0 - lift - age * r * 0.2;
      const col = crash && !s.rainbow ? '#ff2a2a' : s.textColor;
      c.save();
      c.translate(cx, y); c.rotate(crash ? 0 : -0.06); c.scale(pop, pop);
      c.globalAlpha = alpha;
      c.font = font(size);
      c.lineWidth = size * 0.16; c.strokeStyle = crash && !s.rainbow ? '#000' : s.textStroke; c.strokeText(label, 0, 0);
      let fill: string | CanvasGradient = col;
      if (s.rainbow) {
        const w = c.measureText(label).width / 2, h0 = hueAt(i, fps);
        const g = c.createLinearGradient(-w, 0, w, 0);
        for (let q = 0; q <= 6; q++) g.addColorStop(q / 6, hsl(h0 + q * 50, 1, 72));
        fill = g;
      }
      c.shadowColor = s.rainbow ? hsl(hueAt(i, fps), 0.9) : col; c.shadowBlur = size * 0.5 * k;
      c.fillStyle = fill; c.fillText(label, 0, 0);
      c.shadowBlur = 0;
      if ((e.combo ?? 1) >= 2) {
        const sz = size * 0.45;
        c.font = font(sz);
        c.lineWidth = sz * 0.18; c.strokeText(`COMBO ×${e.combo}`, 0, size * 0.72);
        c.fillStyle = s.hot ?? '#ffffff'; c.fillText(`COMBO ×${e.combo}`, 0, size * 0.72);
      }
      c.restore();
    });
  }

  // Popups and timers take over the spot above the gimbals; the stats step aside at once and fade back after.
  let busy = s.popups ? timerVisibility(F) : 0;
  if (s.popups) {
    for (const e of F.recent) {
      if (!e.label || isSpan(e) || ((e.kind === 'arm' || e.kind === 'disarm') && !s.intro)) continue;
      const age = (i - e.frame) / fps, T = e.kind === 'crash' ? 2.5 : 1.3;
      busy = Math.max(busy, Math.min(clamp01(age / 0.05), 1 - clamp01((age - T) / 0.2)));
    }
  }
  const statsAlpha = 1 - busy;
  if (s.stats && statsAlpha > 0.01) {
    // OSD-style readout of real numbers only; a line appears once it has something to say.
    const st = sc.motion.stats;
    c.save();
    c.globalAlpha = statsAlpha;
    const rows: [string, number][] = [['ARMED', st.armedTime[i]], ['HANG MAX', st.hangBest[i]], ['FULL THR', st.fullTotal[i]]];
    const x = L.right.x + r, y = L.hud.y - r * 0.12;
    c.textAlign = 'right'; c.textBaseline = 'bottom';
    c.lineWidth = r * 0.04; c.strokeStyle = s.textStroke;
    let row = 0;
    for (const [name, v] of rows) {
      if (v <= 0) continue;
      const yy = y - row * r * 0.3;
      const txt = fmtClock(v);
      c.font = font(r * 0.24);
      const vw = c.measureText(txt).width;
      c.font = font(r * 0.16); c.fillStyle = css(parseColor(s.textColor), 0.75);
      c.fillText(name, x - vw - r * 0.1, yy);
      c.font = font(r * 0.24);
      c.strokeText(txt, x, yy); c.fillStyle = s.textColor; c.fillText(txt, x, yy);
      row++;
    }
    c.restore();
  }
}

/** Live throttle timers: counts up with milliseconds while the span lasts, then freezes, pops and fades. */
function drawTimers(c: Ctx2D, F: FrameInfo) {
  const { s, r, sc, i, fps } = F;
  const L = sc.layout, k = sc.scale;
  const font = (px: number) => s.font.replace('{px}', px.toFixed(1));
  const cx = L.hud.x + L.hud.w / 2;
  // Newest span wins the slot; overlapping spans can't happen (throttle can't be full and zero at once).
  const e = F.spans.at(-1);
  if (!e) return;
  const t = spanElapsed(e, sc, i);
  const after = Math.max(0, (i - e.end!) / fps); // seconds since the span ended (0 while running)
  const done = i > e.end!;
  const alpha = 1 - clamp01((after - (SPAN_HOLD - 0.4)) / 0.4);  const label = s.labelMap[e.label!] ?? e.label!;
  const full = e.kind === 'full';
  const num = `${fmtSecs(t)}s`;
  c.save();
  c.globalAlpha = alpha;
  if (s.popupStyle === 'terminal') {
    const size = 0.42 * r;
    const age = (i - e.frame) / fps;
    const head = `> ${label.replace(/ /g, '_')}`;
    const typed = head.slice(0, Math.min(head.length, Math.floor(age * 40) + 1));
    const line = typed.length < head.length ? typed + '█' : `${head} ${num}${done ? '' : Math.floor(age * 4) % 2 === 0 ? '█' : ' '}`;
    const col = full ? (s.hot ?? s.textColor) : s.textColor;
    c.font = font(size); c.textAlign = 'left'; c.textBaseline = 'middle';
    c.shadowColor = col; c.shadowBlur = size * 0.45 * k;
    c.fillStyle = col; c.fillText(line, L.hud.x, L.hud.y - r * 0.6);
    c.restore();
    return;
  }
  const col = s.rainbow ? hsl(hueAt(i, fps), 1, 72) : full ? (s.hot ?? s.textColor) : '#bff4ff';
  const pulse = full && !done ? 0.5 + 0.5 * Math.sin(t * Math.PI * 6) : 0;
  // A bounce when it starts, and again when the final time locks in.
  const age = (i - e.frame) / fps;
  const pop = age < 0.14 ? easeOutBack(age / 0.14) : done && after < 0.25 ? 1 + 0.18 * Math.sin((after / 0.25) * Math.PI) : 1;
  const drift = full ? 0 : -Math.min(age, 3) * r * 0.06; // hang time floats up gently
  c.translate(cx, L.hud.y - r * 0.55 + drift); c.scale(pop, pop);
  c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
  // label
  const ls = r * 0.3;
  c.font = font(ls);
  c.lineWidth = ls * 0.16; c.strokeStyle = s.textStroke; c.strokeText(label, 0, -r * 0.42);
  c.fillStyle = col; c.fillText(label, 0, -r * 0.42);
  // counter
  const ns = r * (done ? 0.56 : 0.5);
  c.font = font(ns);
  c.lineWidth = ns * 0.16; c.strokeText(num, 0, 0);
  c.shadowColor = col; c.shadowBlur = ns * (0.35 + 0.5 * pulse) * k;
  c.fillStyle = done ? s.textColor : col; c.fillText(num, 0, 0);
  c.restore();
}
