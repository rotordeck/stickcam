// Multi-frame fusion (noise reduction and streak repair) at the source size. Port of FPV DVR Cleaner
// src/flugbild/upscale.py (https://github.com/Bratwurstexe/FPV_DVR_CLEANER @ 264d232, MIT), with the
// desktop app's "balanced" effort: two frames on each side, flow at 400 px wide, linear warping.
// No upscaling and no GPU path.
//
// Two earlier and two later frames are warped onto the current frame's grid with optical flow. The
// per-pixel median of the five luma values is the reference: a bright or dark streak in one frame is
// an outlier against it and gets replaced, and random analog noise averages out. Every value is then
// weighted by its distance to the reference. Where the aligned frames disagree among themselves
// (occlusion, flow errors) the current frame is kept, so fast motion does not ghost. A limited detail
// lift follows; its overshoot is clipped to avoid halos. Chroma comes from the current frame only, it
// is repaired earlier by the analog colour stage. Pure.
import { denseFlow } from './flow.ts';
import { fromYcc, gaussianBlur, plane, remap, resizeArea, resizeLinear, round8, toYcc, type Plane, type Rgba } from './image.ts';

export const RADIUS = 2;
const FLOW_WIDTH = 400;
const LIFT_LIMIT = 12;
/** Detail lift for the desktop app's default edge detail (kantendetail 15, lift = 15 / 50). */
export const LIFT = 15 / 50;

/** Per-frame data shared by every window it appears in. */
export class LumaFrame {
  readonly ycc: [Plane, Plane, Plane];
  readonly small: Plane;
  constructor(frame: Rgba) {
    this.ycc = toYcc(frame);
    const { w, h } = frame, f = Math.min(1, FLOW_WIDTH / w);
    this.small = round8(resizeArea(this.ycc[0], Math.max(8, Math.round(w * f)), Math.max(8, Math.round(h * f))));
  }
}

/**
 * Per-pixel median of up to five values with the min/max networks of the original (which also run on
 * the GPU there). Four values give the mean of the middle two, two their mean.
 */
function median(v: number[]): number {
  const n = v.length;
  if (n === 1) return v[0];
  if (n === 2) return 0.5 * v[0] + 0.5 * v[1];
  if (n === 3) { const [a, b, c] = v; return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c)); }
  if (n === 4 || n === 5) {
    const [a, b, c, d] = v;
    // The middle two of four values.
    let second = Math.max(Math.min(a, b), Math.min(c, d)), third = Math.min(Math.max(a, b), Math.max(c, d));
    [second, third] = [Math.min(second, third), Math.max(second, third)];
    if (n === 4) return 0.5 * second + 0.5 * third;
    return Math.max(second, Math.min(third, v[4]));
  }
  const s = v.slice().sort((x, y) => x - y), m = n >> 1;
  return n % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Strength of the fusion: `calm` 0..1 (the desktop app's rauschminderung / 100), `lift` ≥ 0. */
export interface Fusion { calm: number; lift: number }

/** The fused frame for win[c]. */
export function fuseWindow(win: LumaFrame[], c: number, { calm, lift }: Fusion): Rgba {
  const present = win[c], [Y, Cr, Cb] = present.ycc, { w, h } = Y, n = w * h;
  // Stronger calming accepts larger differences as noise and trusts the current frame less.
  const tolerance = 6 + 14 * calm, ownWeight = 1 + 3 * (1 - calm);
  const layers: Float32Array[] = [Y.d];
  win.forEach((other, k) => {
    if (k === c) return;
    const f = denseFlow(present.small, other.small);
    const fx = resizeLinear(plane(f.w, f.h, f.fx), w, h).d, fy = resizeLinear(plane(f.w, f.h, f.fy), w, h).d;
    const sx = w / present.small.w, sy = h / present.small.h, mx = new Float32Array(n), my = new Float32Array(n);
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) { mx[i] = x + fx[i] * sx; my[i] = y + fy[i] * sy; }
    layers.push(remap([other.ycc[0]], mx, my, w, h)[0].d);
  });
  let fused = Y.d;
  if (layers.length > 2) {
    fused = new Float32Array(n);
    const L = layers.length, vals = new Array<number>(L), gaps = new Array<number>(L - 1);
    const inv = 1 / tolerance ** 2, invTrust = 1 / (1.5 * tolerance) ** 2;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < L; k++) vals[k] = layers[k][i];
      const ref = median(vals);
      let total = 0, weights = 0;
      for (let k = 0; k < L; k++) {
        const gap = Math.abs(vals[k] - ref);
        let close = Math.exp(-gap * gap * inv);
        if (k === 0) close *= ownWeight; else gaps[k - 1] = gap;
        total += vals[k] * close; weights += close;
      }
      // Only when every value is far from a four-value median; keep the frame then.
      const blended = weights > 0 ? total / weights : vals[0];
      // How well the aligned frames agree with each other; poor agreement means the motion was not
      // followed, so keep the frame as it is.
      const spread = median(gaps), trust = Math.exp(-spread * spread * invTrust);
      fused[i] = vals[0] + (blended - vals[0]) * trust;
    }
  }
  let out = plane(w, h, fused);
  if (lift) {
    const soft = gaussianBlur(out, 0, 0, 1.2), d = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const detail = (fused[i] - soft.d[i]) * lift;
      d[i] = fused[i] + (detail > LIFT_LIMIT ? LIFT_LIMIT : detail < -LIFT_LIMIT ? -LIFT_LIMIT : detail);
    }
    out = plane(w, h, d);
  } else if (out.d === Y.d) out = plane(w, h, Y.d.slice());
  // convertScaleAbs(max(fused, 0)): saturating round to 8 bits.
  return fromYcc(round8(out), Cr, Cb);
}
