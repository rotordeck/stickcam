// The handful of OpenCV image ops the DVR repairs need, on single-channel float planes.
// Semantics follow OpenCV (border modes, kernel sizes, rounding) so the ports of FPV DVR Cleaner
// (https://github.com/Bratwurstexe/FPV_DVR_CLEANER @ 264d232, MIT) behave like the original. Pure.

export interface Plane { w: number; h: number; d: Float32Array }
/** One video frame as canvas pixels. */
export interface Rgba { w: number; h: number; d: Uint8ClampedArray }

export const plane = (w: number, h: number, d: Float32Array = new Float32Array(w * h)): Plane => ({ w, h, d });
export const clone = (p: Plane): Plane => plane(p.w, p.h, p.d.slice());
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const clip01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const u8 = (v: number) => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));

/** BORDER_REFLECT_101: …cba|abcd|dcb… */
function reflect101(i: number, n: number) {
  if (n === 1) return 0;
  while (i < 0 || i >= n) i = i < 0 ? -i : 2 * n - 2 - i;
  return i;
}

// ---------- colour ----------

/** cv2.COLOR_BGR2YCrCb on 8-bit pixels (results rounded to 0..255, as OpenCV stores them). */
export function toYcc(f: Rgba): [Plane, Plane, Plane] {
  const n = f.w * f.h, y = new Float32Array(n), cr = new Float32Array(n), cb = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = f.d[j], g = f.d[j + 1], b = f.d[j + 2];
    const l = 0.299 * r + 0.587 * g + 0.114 * b;
    y[i] = u8(l); cr[i] = u8((r - l) * 0.713 + 128); cb[i] = u8((b - l) * 0.564 + 128);
  }
  return [plane(f.w, f.h, y), plane(f.w, f.h, cr), plane(f.w, f.h, cb)];
}

/** cv2.COLOR_YCrCb2BGR back into an RGBA frame (alpha 255). */
export function fromYcc(y: Plane, cr: Plane, cb: Plane, out?: Rgba): Rgba {
  const o = out ?? { w: y.w, h: y.h, d: new Uint8ClampedArray(y.w * y.h * 4) };
  for (let i = 0, j = 0; i < y.d.length; i++, j += 4) {
    const l = y.d[i], r = cr.d[i] - 128, b = cb.d[i] - 128;
    o.d[j] = u8(l + 1.403 * r); o.d[j + 1] = u8(l - 0.714 * r - 0.344 * b); o.d[j + 2] = u8(l + 1.773 * b); o.d[j + 3] = 255;
  }
  return o;
}

/** cv2.COLOR_BGR2GRAY, rounded. */
export function toGray(f: Rgba): Plane {
  const n = f.w * f.h, g = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = u8(0.299 * f.d[j] + 0.587 * f.d[j + 1] + 0.114 * f.d[j + 2]);
  return plane(f.w, f.h, g);
}

/** The R, G, B channels as planes. */
export function channels(f: Rgba): [Plane, Plane, Plane] {
  const n = f.w * f.h, out = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let i = 0, j = 0; i < n; i++, j += 4) { out[0][i] = f.d[j]; out[1][i] = f.d[j + 1]; out[2][i] = f.d[j + 2]; }
  return out.map((d) => plane(f.w, f.h, d)) as [Plane, Plane, Plane];
}

export function fromChannels(r: Plane, g: Plane, b: Plane): Rgba {
  const d = new Uint8ClampedArray(r.w * r.h * 4);
  for (let i = 0, j = 0; i < r.d.length; i++, j += 4) { d[j] = u8(r.d[i]); d[j + 1] = u8(g.d[i]); d[j + 2] = u8(b.d[i]); d[j + 3] = 255; }
  return { w: r.w, h: r.h, d };
}

/** Round to whole 8-bit levels, as a cv2 op on a uint8 image would leave them. */
export function round8(p: Plane): Plane {
  for (let i = 0; i < p.d.length; i++) p.d[i] = u8(p.d[i]);
  return p;
}

// ---------- resize ----------

/** Per destination index: the source indices and weights of INTER_AREA along one axis (shrinking). */
function areaTable(src: number, dst: number) {
  const scale = src / dst, idx: number[][] = [], wt: number[][] = [];
  for (let x = 0; x < dst; x++) {
    const a = x * scale, b = Math.min(src, (x + 1) * scale), is: number[] = [], ws: number[] = [];
    for (let s = Math.floor(a); s < Math.ceil(b - 1e-9); s++) {
      const w = Math.min(b, s + 1) - Math.max(a, s);
      if (w > 1e-9) { is.push(s); ws.push(w / scale); }
    }
    idx.push(is); wt.push(ws);
  }
  return { idx, wt };
}

/** cv2.resize INTER_AREA. Enlarging falls back to linear, which is what OpenCV does for whole factors. */
export function resizeArea(p: Plane, w: number, h: number): Plane {
  if (w > p.w || h > p.h) return resizeLinear(p, w, h);
  if (w === p.w && h === p.h) return clone(p);
  const tx = areaTable(p.w, w), ty = areaTable(p.h, h);
  const mid = new Float32Array(w * p.h);
  for (let y = 0; y < p.h; y++) {
    const row = y * p.w;
    for (let x = 0; x < w; x++) {
      let s = 0;
      const is = tx.idx[x], ws = tx.wt[x];
      for (let k = 0; k < is.length; k++) s += p.d[row + is[k]] * ws[k];
      mid[y * w + x] = s;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const is = ty.idx[y], ws = ty.wt[y];
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = 0; k < is.length; k++) s += mid[is[k] * w + x] * ws[k];
      out[y * w + x] = s;
    }
  }
  return plane(w, h, out);
}

/** Pixel-centre source position and weight for INTER_LINEAR, clamped at the edges like OpenCV. */
function linearTable(src: number, dst: number) {
  const scale = src / dst, i0 = new Int32Array(dst), f = new Float32Array(dst);
  for (let x = 0; x < dst; x++) {
    let s = (x + 0.5) * scale - 0.5, i = Math.floor(s), fr = s - i;
    if (i < 0) { i = 0; fr = 0; }
    if (i >= src - 1) { i = src - 1; fr = 0; }
    i0[x] = i; f[x] = fr;
  }
  return { i0, f };
}

/** cv2.resize INTER_LINEAR. */
export function resizeLinear(p: Plane, w: number, h: number): Plane {
  const tx = linearTable(p.w, w), ty = linearTable(p.h, h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const r0 = ty.i0[y] * p.w, r1 = Math.min(ty.i0[y] + 1, p.h - 1) * p.w, fy = ty.f[y];
    for (let x = 0; x < w; x++) {
      const c0 = tx.i0[x], c1 = Math.min(c0 + 1, p.w - 1), fx = tx.f[x];
      const top = p.d[r0 + c0] + (p.d[r0 + c1] - p.d[r0 + c0]) * fx;
      const bot = p.d[r1 + c0] + (p.d[r1 + c1] - p.d[r1 + c0]) * fx;
      out[y * w + x] = top + (bot - top) * fy;
    }
  }
  return plane(w, h, out);
}

/** cv2.resize INTER_NEAREST. */
export function resizeNearest(p: Plane, w: number, h: number): Plane {
  const out = new Float32Array(w * h), sx = p.w / w, sy = p.h / h;
  for (let y = 0; y < h; y++) {
    const r = Math.min(p.h - 1, Math.floor(y * sy)) * p.w;
    for (let x = 0; x < w; x++) out[y * w + x] = p.d[r + Math.min(p.w - 1, Math.floor(x * sx))];
  }
  return plane(w, h, out);
}

// ---------- filters ----------

/** Normalised 1-D box filter along rows (dx=1) or columns, BORDER_REFLECT_101, via a running sum. */
function box1d(src: Float32Array, w: number, h: number, k: number, alongX: boolean): Float32Array {
  const out = new Float32Array(w * h);
  if (k <= 1) { out.set(src); return out; }
  const n = alongX ? w : h, lines = alongX ? h : w, step = alongX ? 1 : w, r = k >> 1;
  const line = new Float32Array(n + 2 * r);
  for (let l = 0; l < lines; l++) {
    const base = alongX ? l * w : l;
    for (let i = -r; i < n + r; i++) line[i + r] = src[base + reflect101(i, n) * step];
    let s = 0;
    for (let i = 0; i < k; i++) s += line[i];
    for (let i = 0; i < n; i++) {
      out[base + i * step] = s / k;
      s += line[i + k] - line[i];
    }
  }
  return out;
}

/** cv2.blur(p, (kw, kh)). */
export function boxBlur(p: Plane, kw: number, kh: number): Plane {
  return plane(p.w, p.h, box1d(box1d(p.d, p.w, p.h, kw, true), p.w, p.h, kh, false));
}

/** cv2.getGaussianKernel, including OpenCV's fixed small kernels when no sigma is given. */
function gaussKernel(k: number, sigma: number): Float32Array {
  const fixed: Record<number, number[]> = {
    1: [1], 3: [0.25, 0.5, 0.25], 5: [0.0625, 0.25, 0.375, 0.25, 0.0625],
    7: [0.03125, 0.109375, 0.21875, 0.28125, 0.21875, 0.109375, 0.03125],
  };
  if (sigma <= 0 && fixed[k]) return Float32Array.from(fixed[k]);
  const s = sigma > 0 ? sigma : 0.3 * ((k - 1) * 0.5 - 1) + 0.8, c = (k - 1) / 2, out = new Float32Array(k);
  let sum = 0;
  for (let i = 0; i < k; i++) { out[i] = Math.exp(-((i - c) ** 2) / (2 * s * s)); sum += out[i]; }
  for (let i = 0; i < k; i++) out[i] /= sum;
  return out;
}

function conv1d(src: Float32Array, w: number, h: number, ker: Float32Array, alongX: boolean): Float32Array {
  const out = new Float32Array(w * h), r = ker.length >> 1;
  if (ker.length === 1) { out.set(src); return out; }
  const n = alongX ? w : h, lines = alongX ? h : w, step = alongX ? 1 : w, line = new Float32Array(n + 2 * r);
  for (let l = 0; l < lines; l++) {
    const base = alongX ? l * w : l;
    for (let i = -r; i < n + r; i++) line[i + r] = src[base + reflect101(i, n) * step];
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = 0; k < ker.length; k++) s += line[i + k] * ker[k];
      out[base + i * step] = s;
    }
  }
  return out;
}

/** cv2.GaussianBlur(p, (kw, kh), sigma) on a float image. kw = kh = 0 derives the size from sigma. */
export function gaussianBlur(p: Plane, kw: number, kh: number, sigma = 0): Plane {
  const size = (k: number) => (k > 0 ? k : Math.round(sigma * 8 + 1) | 1);
  const kx = gaussKernel(size(kw), sigma), ky = gaussKernel(size(kh), sigma);
  return plane(p.w, p.h, conv1d(conv1d(p.d, p.w, p.h, kx, true), p.w, p.h, ky, false));
}

/** cv2.dilate with a kw×kh rectangle: the maximum over the window, edges ignored. */
export function dilate(p: Plane, kw: number, kh: number): Plane {
  const max1d = (src: Float32Array, k: number, alongX: boolean) => {
    const out = new Float32Array(p.w * p.h), r = k >> 1, n = alongX ? p.w : p.h, lines = alongX ? p.h : p.w, step = alongX ? 1 : p.w;
    for (let l = 0; l < lines; l++) {
      const base = alongX ? l * p.w : l;
      for (let i = 0; i < n; i++) {
        let m = -Infinity;
        for (let j = Math.max(0, i - r); j <= Math.min(n - 1, i + r); j++) m = Math.max(m, src[base + j * step]);
        out[base + i * step] = m;
      }
    }
    return out;
  };
  return plane(p.w, p.h, max1d(max1d(p.d, kw, true), kh, false));
}

/** cv2.remap INTER_LINEAR, BORDER_REPLICATE, for several planes sharing one map. */
export function remap(planes: Plane[], mx: Float32Array, my: Float32Array, w: number, h: number): Plane[] {
  const sw = planes[0].w, sh = planes[0].h, outs = planes.map(() => new Float32Array(w * h));
  for (let i = 0; i < w * h; i++) {
    const x = clamp(mx[i], 0, sw - 1), y = clamp(my[i], 0, sh - 1);
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, sw - 1), y1 = Math.min(y0 + 1, sh - 1);
    const fx = x - x0, fy = y - y0;
    const a = y0 * sw + x0, b = y0 * sw + x1, c = y1 * sw + x0, d = y1 * sw + x1;
    const wa = (1 - fx) * (1 - fy), wb = fx * (1 - fy), wc = (1 - fx) * fy, wd = fx * fy;
    for (let k = 0; k < planes.length; k++) {
      const s = planes[k].d;
      outs[k][i] = s[a] * wa + s[b] * wb + s[c] * wc + s[d] * wd;
    }
  }
  return outs.map((d) => plane(w, h, d));
}

/** Median of the plane's values (np.median). */
export function median(p: Plane): number {
  const s = p.d.slice().sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
