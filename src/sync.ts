// Automatic video ↔ log sync. Gyroflow's idea, kept cheap enough for a browser:
//   1. global camera motion per video frame from intensity projections (pan x, pan y, roll),
//   2. normalized cross-correlation of those rates against the gyro, over every possible offset.
// Pure module (no DOM): feed it small grayscale frames + timestamps.
import { indexAtTime, type Signals } from './decoder/units.js';

export interface FlowSample { t: number; dx: number; dy: number }

/** Frame size the estimator expects (powers of two for the FFT). Callers scale video frames to this. */
export const FLOW_W = 128, FLOW_H = 64;

/** In-place iterative radix-2 FFT over n complex values with stride (re/im interleaved arrays). */
function fft(re: Float64Array, im: Float64Array, off: number, n: number, stride: number, inverse: boolean) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const a = off + i * stride, b = off + j * stride;
      let t = re[a]; re[a] = re[b]; re[b] = t;
      t = im[a]; im[a] = im[b]; im[b] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len >> 1; k++) {
        const a = off + (i + k) * stride, b = off + (i + k + (len >> 1)) * stride;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}
function fft2(re: Float64Array, im: Float64Array, w: number, h: number, inverse: boolean) {
  for (let y = 0; y < h; y++) fft(re, im, y * w, w, 1, inverse);
  for (let x = 0; x < w; x++) fft(re, im, x, h, w, inverse);
}

const hann = (n: number) => Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));

/**
 * Streaming global-motion estimator: phase correlation between consecutive frames gives the image
 * shift (pan x / pan y), which tracks yaw / pitch rate. push() one FLOW_W×FLOW_H grayscale frame at a time.
 */
export class FlowEstimator {
  readonly samples: FlowSample[] = [];
  private prevRe: Float64Array | null = null;
  private prevIm: Float64Array | null = null;
  private prevT = 0;
  private win: Float64Array;
  private re = new Float64Array(FLOW_W * FLOW_H);
  private im = new Float64Array(FLOW_W * FLOW_H);
  constructor() {
    const wx = hann(FLOW_W), wy = hann(FLOW_H);
    this.win = new Float64Array(FLOW_W * FLOW_H);
    for (let y = 0; y < FLOW_H; y++) for (let x = 0; x < FLOW_W; x++) this.win[y * FLOW_W + x] = wx[x] * wy[y];
  }

  push(gray: ArrayLike<number>, t: number) {
    const N = FLOW_W * FLOW_H;
    let mean = 0;
    for (let i = 0; i < N; i++) mean += gray[i];
    mean /= N;
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = (gray[i] - mean) * this.win[i];
    fft2(re, im, FLOW_W, FLOW_H, false);
    if (this.prevRe && this.prevIm && t > this.prevT) {
      // Normalized cross-power spectrum → inverse FFT → peak at the shift.
      const cr = this.re, ci = this.im, pr = this.prevRe, pi = this.prevIm;
      for (let i = 0; i < N; i++) {
        const a = re[i] * pr[i] + im[i] * pi[i], b = im[i] * pr[i] - re[i] * pi[i];
        const m = Math.hypot(a, b) + 1e-9;
        cr[i] = a / m; ci[i] = b / m;
      }
      fft2(cr, ci, FLOW_W, FLOW_H, true);
      cr[0] *= 0.3; // static OSD pulls towards zero shift
      let k = 0;
      for (let i = 1; i < N; i++) if (cr[i] > cr[k]) k = i;
      const px = k % FLOW_W, py = (k / FLOW_W) | 0;
      const at = (x: number, y: number) => cr[((y + FLOW_H) % FLOW_H) * FLOW_W + ((x + FLOW_W) % FLOW_W)];
      const sub = (a: number, b: number, c: number) => { const d = a - 2 * b + c; return d < 0 ? (0.5 * (a - c)) / d : 0; };
      let x = px + sub(at(px - 1, py), at(px, py), at(px + 1, py));
      let y = py + sub(at(px, py - 1), at(px, py), at(px, py + 1));
      if (x > FLOW_W / 2) x -= FLOW_W;
      if (y > FLOW_H / 2) y -= FLOW_H;
      const dt = t - this.prevT;
      this.samples.push({ t: (t + this.prevT) / 2, dx: x / dt, dy: y / dt });
    }
    this.prevRe = re; this.prevIm = im; this.prevT = t;
  }
}

// ---------- correlation ----------

const HZ = 30; // common grid for the coarse search

/** Linear resample of (t, v) samples onto a uniform grid starting at t0. */
function grid(ts: ArrayLike<number>, vs: ArrayLike<number>, t0: number, n: number, hz: number): Float32Array {
  const out = new Float32Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + i / hz;
    while (j < ts.length - 2 && ts[j + 1] < t) j++;
    const a = ts[j], b = ts[j + 1] ?? a;
    const u = b > a ? Math.min(1, Math.max(0, (t - a) / (b - a))) : 0;
    out[i] = vs[j] + ((vs[j + 1] ?? vs[j]) - vs[j]) * u;
  }
  return out;
}

/** Normalized correlation of a[i0..] with b[j0..] over n samples. */
function ncc(a: Float32Array, i0: number, b: Float32Array, j0: number, n: number): number {
  let sa = 0, sb = 0;
  for (let k = 0; k < n; k++) { sa += a[i0 + k]; sb += b[j0 + k]; }
  const ma = sa / n, mb = sb / n;
  let ab = 0, aa = 0, bb = 0;
  for (let k = 0; k < n; k++) { const x = a[i0 + k] - ma, y = b[j0 + k] - mb; ab += x * y; aa += x * x; bb += y * y; }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

export interface SyncResult {
  /** log time = video time + offset (seconds). */
  offset: number;
  /** Peak correlation (0..1) and how far it stands above the next-best distinct peak. */
  score: number;
  margin: number;
  /** Score per candidate offset, for plotting. */
  curve: { offsets: Float32Array; scores: Float32Array };
}

/**
 * Find the offset that best aligns video motion with the gyro. Offsets are searched so that at least
 * `minOverlap` seconds (default: 60 % of the flight, max 20 s) of the flight overlap the video.
 */
export function findOffset(flow: FlowSample[], sig: Signals, opts: { minOverlap?: number } = {}): SyncResult | null {
  if (flow.length < HZ * 3 || !sig.gyro[0] || !sig.gyro[1] || !sig.gyro[2]) return null;
  const vt = flow.map((f) => f.t);
  const v0 = vt[0], vDur = vt[vt.length - 1] - v0;
  const nv = Math.floor(vDur * HZ);
  const lDur = sig.duration, nl = Math.floor(lDur * HZ);
  const minOv = Math.min(opts.minOverlap ?? Math.min(20, lDur * 0.6), lDur, vDur);
  const mOv = Math.max(HZ * 2, Math.floor(minOv * HZ));

  // Pan x tracks yaw rate, pan y tracks pitch rate. Mounting decides the signs, so both count by |r|.
  const clip = (a: Float32Array) => {
    const abs = Float32Array.from(a, Math.abs).sort();
    const lim = 6 * (abs[Math.floor(abs.length * 0.9)] || 1);
    for (let i = 0; i < a.length; i++) a[i] = Math.max(-lim, Math.min(lim, a[i]));
    return a;
  };
  const vx = clip(grid(vt, flow.map((f) => f.dx), v0, nv, HZ)), vy = clip(grid(vt, flow.map((f) => f.dy), v0, nv, HZ));
  const gy = grid(sig.t, sig.gyro[2]!, 0, nl, HZ), gp = grid(sig.t, sig.gyro[1]!, 0, nl, HZ);

  // lag k (samples): log index i ↔ video index i - k  ⇔ offset = k/HZ - v0 … see below.
  // Video sample j is at time v0 + j/HZ; log sample i at i/HZ. Aligning i with j ⇒ offset = i/HZ - (v0 + j/HZ).
  const kMin = -(nv - mOv), kMax = nl - mOv; // k = i - j
  const nK = kMax - kMin + 1;
  if (nK <= 0) return null;
  const scores = new Float32Array(nK), offsets = new Float32Array(nK);
  for (let k = kMin; k <= kMax; k++) {
    const i0 = Math.max(0, k), j0 = i0 - k;
    const n = Math.min(nl - i0, nv - j0);
    if (n < mOv) { scores[k - kMin] = 0; continue; }
    const s = 0.7 * Math.abs(ncc(gy, i0, vx, j0, n)) + 0.3 * Math.abs(ncc(gp, i0, vy, j0, n));
    scores[k - kMin] = s;
    offsets[k - kMin] = k / HZ - v0;
  }
  let best = 0;
  for (let i = 1; i < nK; i++) if (scores[i] > scores[best]) best = i;
  // Second-best peak at least 1 s away.
  let second = 0;
  for (let i = 0; i < nK; i++) if (Math.abs(i - best) > HZ && scores[i] > second) second = scores[i];
  let frac = 0;
  if (best > 0 && best < nK - 1) {
    const a = scores[best - 1], b = scores[best], c = scores[best + 1];
    const den = a - 2 * b + c;
    if (den < 0) frac = 0.5 * (a - c) / den;
  }
  return {
    offset: (best + kMin + frac) / HZ - v0,
    score: scores[best], margin: scores[best] - second,
    curve: { offsets, scores },
  };
}

/** Convenience for the UI: index of the log sample at a video time under an offset. */
export const logIndexAt = (sig: Signals, videoT: number, offset: number) => indexAtTime(sig.t, videoT + offset);
