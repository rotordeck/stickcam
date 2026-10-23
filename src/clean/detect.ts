// Cheap breakup detection on small frames (SCAN_W×SCAN_H), for the timeline markers, the Auto guess
// and the signal-glitch effect. The measures are single-frame proxies of the ones the repairs use:
// * dropout (analog.ts): share of rows whose colour level is under DROPOUT_LEVEL/RAMP;
// * tears (analog.ts): share of the picture with saturated colour whose hue jumps from row to row;
// * confetti (hdzero.ts): share of blocks with high fine-colour energy or many colour specks.
// A grey scene, a colourful one or a busy OSD score high on their own, so `breakups` only counts what
// is clearly worse than the frames around it, as the repairs do. Pure.
import type { Rgba } from './image.ts';
import { guessKind, type Box, type CleanKind } from './repair.ts';

export const SCAN_W = 160, SCAN_H = 120;

export interface FrameScore { dropout: number; tears: number; confetti: number }

/** The damage scan of a video, cached on its VideoInfo. */
export interface Damage {
  /** Frame times (video seconds) and breakup strength 0..1 per frame. */
  t: Float32Array;
  s: Float32Array;
  raw: FrameScore[];
  /** The picture inside black bars, in video pixels. */
  box: Box;
}

const DROPOUT_LEVEL = 1.5, DROPOUT_RAMP = 2.5;
/** Fine colour energy of one pixel that makes it a confetti speck (hdzero.ts SPECK). */
const SPECK = 24;
const BLOCK = 8;

const clip01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Mean over a sliding window of `k` (odd) along one line, edges clamped to the line. */
function slide(src: Float32Array, k: number): Float32Array {
  const n = src.length, out = new Float32Array(n), r = k >> 1;
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) { s += src[j]; c++; }
    out[i] = s / c;
  }
  return out;
}

export function scoreFrame(f: Rgba): FrameScore {
  const { w, h, d } = f, n = w * h;
  const cr = new Float32Array(n), cb = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const y = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    cr[i] = (d[j] - y) * 0.713; cb[i] = (d[j + 2] - y) * 0.564;
  }

  // ---- analog: chroma on a grid of every 4th column and every 2nd row, as in analog.ts ----
  const cx = Math.max(1, Math.floor(w / 40)), cy = Math.max(1, Math.floor(h / 60));
  const gw = Math.floor(w / cx), gh = Math.floor(h / cy), gn = gw * gh;
  const gr = new Float32Array(gn), gb = new Float32Array(gn), mag = new Float32Array(gn);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    let sr = 0, sb = 0;
    for (let y = gy * cy; y < (gy + 1) * cy; y++) for (let x = gx * cx; x < (gx + 1) * cx; x++) { sr += cr[y * w + x]; sb += cb[y * w + x]; }
    const g = gy * gw + gx, k = cx * cy;
    gr[g] = sr / k; gb[g] = sb / k; mag[g] = Math.hypot(gr[g], gb[g]);
  }
  // Hue tears: |angle of c[r+1]·conj(c[r])| where the colour is saturated, against the local colour level.
  const tear = new Float32Array(gn), win = Math.max(3, (Math.round(gw / 10) | 1));
  const line = new Float32Array(gw), turn = new Float32Array(gw);
  for (let gy = 0; gy < gh; gy++) {
    const r = Math.min(gy, gh - 2);
    for (let gx = 0; gx < gw; gx++) {
      const i = gy * gw + gx;
      line[gx] = mag[i];
      turn[gx] = 0;
      if (r < 0 || mag[i] <= 10) continue;
      const a = (r + 1) * gw + gx, b = r * gw + gx;
      const re = gr[a] * gr[b] + gb[a] * gb[b], im = gb[a] * gr[b] - gr[a] * gb[b];
      turn[gx] = Math.abs(Math.atan2(im, re));
    }
    const lvl = slide(line, win), jumps = slide(turn, win);
    for (let gx = 0; gx < gw; gx++) tear[gy * gw + gx] = clip01((lvl[gx] - 10) / 18) * clip01(jumps[gx] / 0.6);
  }
  let tears = 0;
  for (let i = 0; i < gn; i++) tears += tear[i];
  tears /= gn;
  // Dropout: colour level per row (torn colour doesn't count), smoothed over 5 rows.
  const rows = new Float32Array(gh);
  for (let gy = 0; gy < gh; gy++) {
    let s = 0;
    for (let gx = 0; gx < gw; gx++) { const i = gy * gw + gx; s += mag[i] * (1 - tear[i]); }
    rows[gy] = s / gw;
  }
  const smooth = slide(rows, 5);
  let dropout = 0;
  for (let gy = 0; gy < gh; gy++) dropout += 1 - clip01((smooth[gy] - DROPOUT_LEVEL) / DROPOUT_RAMP);
  dropout /= gh;

  // ---- HDZero: fine colour energy (chroma minus its 3×3 mean) per block ----
  const bw = Math.max(1, Math.floor(w / BLOCK)), bh = Math.max(1, Math.floor(h / BLOCK));
  const energy = new Float32Array(bw * bh), specks = new Float32Array(bw * bh);
  for (let y = 0; y < bh * BLOCK; y++) {
    for (let x = 0; x < bw * BLOCK; x++) {
      // Across the row only: analog chroma has almost no horizontal detail (its stripes run along the
      // rows), confetti blocks have edges both ways.
      const i = y * w + x, l = x > 0 ? i - 1 : i, r = x < w - 1 ? i + 1 : i;
      const fine = Math.abs(cr[i] - (cr[l] + cr[i] + cr[r]) / 3) + Math.abs(cb[i] - (cb[l] + cb[i] + cb[r]) / 3);
      const b = ((y / BLOCK) | 0) * bw + ((x / BLOCK) | 0);
      energy[b] += fine;
      if (fine > SPECK) specks[b]++;
    }
  }
  let hits = 0;
  const per = BLOCK * BLOCK;
  for (let b = 0; b < energy.length; b++) if (energy[b] / per > 6 || specks[b] / per > 0.06) hits++;
  return { dropout, tears, confetti: hits / energy.length };
}

/** How far each measure must rise above the frames around it to count fully. */
const SCALE: Record<keyof FrameScore, number> = { dropout: 0.25, tears: 0.12, confetti: 0.12 };
/** Rises below this are noise. */
const FLOOR: Record<keyof FrameScore, number> = { dropout: 0.04, tears: 0.015, confetti: 0.02 };
const KEYS = ['dropout', 'tears', 'confetti'] as const;

/**
 * Per-frame rise of each measure above its surroundings: the higher of the lowest value within
 * `span` frames before and the lowest within `span` frames after. A breakup is transient, so at least
 * one clean frame lies on each side; a scene that just changed has its new level on one side.
 */
export function excess(scores: FrameScore[], span = 12): Record<keyof FrameScore, Float32Array> {
  const n = scores.length;
  const out = {} as Record<keyof FrameScore, Float32Array>;
  for (const k of KEYS) {
    const v = Float32Array.from(scores, (s) => s[k]), e = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let lo = Infinity, hi = Infinity;
      for (let j = Math.max(0, i - span); j < i; j++) lo = Math.min(lo, v[j]);
      for (let j = i + 1; j <= Math.min(n - 1, i + span); j++) hi = Math.min(hi, v[j]);
      const base = Math.max(lo === Infinity ? -Infinity : lo, hi === Infinity ? -Infinity : hi);
      e[i] = base === -Infinity ? 0 : Math.max(0, v[i] - base);
    }
    out[k] = e;
  }
  return out;
}

/** Breakup strength 0..1 per frame, from the per-frame scores and how they compare with the neighbours. */
export function breakups(scores: FrameScore[], span = 12): Float32Array {
  const ex = excess(scores, span), s = new Float32Array(scores.length);
  for (let i = 0; i < s.length; i++) {
    let m = 0;
    for (const k of KEYS) m = Math.max(m, clip01((ex[k][i] - FLOOR[k]) / SCALE[k]));
    s[i] = m;
  }
  return s;
}

/** Strength from which a frame counts as broken (timeline marker, "looks clean" test). */
export const BREAK = 0.35;

/**
 * Which repair fits, from the damage the scan found, and whether there is any. The picture shape
 * (repair.ts guessKind) decides, with one exception: colour dropouts are an analog signature, so they
 * turn a 16:9 picture without bars into analog. The other way round is never trusted: analog rainbow
 * breakups and snow lift the confetti measure as much as HDZero confetti does (seen on real 4:3 DVRs).
 * `clean` = no strong breakup and hardly any weak ones.
 */
export function guessFromScores(samples: FrameScore[], w: number, h: number, box: Box, span = 12): { kind: CleanKind; clean: boolean } {
  const fallback = guessKind(w, h, box);
  if (samples.length < 3) return { kind: fallback, clean: false };
  const ex = excess(samples, span), s = breakups(samples, span);
  const part = (k: keyof FrameScore, i: number) => Math.max(0, (ex[k][i] - FLOOR[k]) / SCALE[k]);
  let broken = 0, strong = 0, dropouts = 0, confetti = 0;
  for (let i = 0; i < samples.length; i++) {
    if (s[i] < BREAK) continue;
    broken++;
    if (s[i] >= 0.8) strong++;
    const d = part('dropout', i), t = part('tears', i), c = part('confetti', i);
    if (d >= Math.max(t, c)) dropouts++;
    else if (c > 2 * t) confetti++;
  }
  const clean = strong === 0 && broken <= Math.max(1, samples.length * 0.002);
  let kind = fallback;
  if (fallback === 'hdzero' && dropouts >= 3 && dropouts > confetti) kind = 'analog';
  return { kind, clean };
}

/**
 * Breakup strength per OUTPUT frame: frame i covers video time [t0 + i/fps, t0 + (i+1)/fps); it takes
 * the strongest scan sample inside, or the nearest one when none falls inside. `t` is sorted.
 */
export function breaksFor(t: Float32Array, s: Float32Array, t0: number, fps: number, frames: number): Float32Array {
  const out = new Float32Array(Math.max(0, frames));
  if (!t.length) return out;
  let j = 0;
  for (let i = 0; i < frames; i++) {
    const a = t0 + i / fps, b = a + 1 / fps;
    while (j < t.length && t[j] < a - 1e-6) j++;
    let m = -1;
    for (let k = j; k < t.length && t[k] < b - 1e-6; k++) m = Math.max(m, s[k]);
    if (m < 0) {
      // Nearest sample, but only when it is within a frame or so (outside the video there's nothing).
      const c = j >= t.length ? t.length - 1 : j > 0 && a - t[j - 1] < t[j] - a ? j - 1 : j;
      m = Math.abs(t[c] - (a + b) / 2) < 1.5 / fps ? s[c] : 0;
    }
    out[i] = m;
  }
  return out;
}
