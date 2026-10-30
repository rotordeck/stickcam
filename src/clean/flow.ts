// Dense optical flow in the spirit of OpenCV's DIS "fast" preset (Kroeger et al. 2016), which the
// DVR repairs use: a coarse-to-fine pyramid; 8×8 patches with stride 4, each aligned by
// inverse-compositional Gauss-Newton on mean-normalised intensities and seeded by spatial
// propagation; patches are blended into a dense field weighted by their photometric fit. Stops at
// 1/4 resolution (finest scale 2) and is upsampled, like the preset. Pure.
import { plane, resizeArea, resizeLinear, type Plane } from './image.ts';

export interface Flow { w: number; h: number; fx: Float32Array; fy: Float32Array }

const PATCH = 8, STRIDE = 4, ITERS = 16, FINEST = 2;

function sample(p: Plane, x: number, y: number) {
  x = x < 0 ? 0 : x > p.w - 1 ? p.w - 1 : x;
  y = y < 0 ? 0 : y > p.h - 1 ? p.h - 1 : y;
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, p.w - 1), y1 = Math.min(y0 + 1, p.h - 1);
  const fx = x - x0, fy = y - y0, d = p.d;
  const top = d[y0 * p.w + x0] + (d[y0 * p.w + x1] - d[y0 * p.w + x0]) * fx;
  const bot = d[y1 * p.w + x0] + (d[y1 * p.w + x1] - d[y1 * p.w + x0]) * fx;
  return top + (bot - top) * fy;
}

/** Patch positions along one axis; the last one sits flush with the edge so every pixel is covered. */
function positions(n: number) {
  const out: number[] = [];
  for (let p = 0; p + PATCH <= n; p += STRIDE) out.push(p);
  if (out[out.length - 1] !== n - PATCH) out.push(n - PATCH);
  return out;
}

/** Template of one patch: mean-normalised values and gradients, plus the inverse Hessian. */
interface Template { t: Float32Array; gx: Float32Array; gy: Float32Array; inv: [number, number, number] | null }

function template(I: Plane, px: number, py: number): Template {
  const n = PATCH * PATCH, t = new Float32Array(n), gx = new Float32Array(n), gy = new Float32Array(n);
  let mean = 0;
  for (let j = 0; j < PATCH; j++) for (let i = 0; i < PATCH; i++) {
    const x = px + i, y = py + j, k = j * PATCH + i, d = I.d, w = I.w;
    t[k] = d[y * w + x]; mean += t[k];
    const xl = Math.max(0, x - 1), xr = Math.min(w - 1, x + 1), yu = Math.max(0, y - 1), yd = Math.min(I.h - 1, y + 1);
    gx[k] = (d[y * w + xr] - d[y * w + xl]) / (xr - xl || 1);
    gy[k] = (d[yd * w + x] - d[yu * w + x]) / (yd - yu || 1);
  }
  mean /= n;
  let a = 0, b = 0, c = 0, mx = 0, my = 0;
  for (let k = 0; k < n; k++) { t[k] -= mean; mx += gx[k]; my += gy[k]; }
  mx /= n; my /= n;
  // Mean normalisation removes the mean of the gradients from the Hessian as well.
  for (let k = 0; k < n; k++) { gx[k] -= mx; gy[k] -= my; a += gx[k] * gx[k]; b += gx[k] * gy[k]; c += gy[k] * gy[k]; }
  a += 1e-3; c += 1e-3;
  const det = a * c - b * b;
  return { t, gx, gy, inv: det > 1e-6 ? [c / det, -b / det, a / det] : null };
}

/** Mean-normalised SSD of the template against I1 at displacement (u, v). */
function cost(T: Template, I1: Plane, px: number, py: number, u: number, v: number) {
  const n = PATCH * PATCH, w = new Float32Array(n);
  let mean = 0;
  for (let j = 0; j < PATCH; j++) for (let i = 0; i < PATCH; i++) { const s = sample(I1, px + i + u, py + j + v); w[j * PATCH + i] = s; mean += s; }
  mean /= n;
  let ssd = 0;
  for (let k = 0; k < n; k++) { const r = w[k] - mean - T.t[k]; ssd += r * r; }
  return ssd;
}

function refine(T: Template, I1: Plane, px: number, py: number, u: number, v: number, iters: number): [number, number] {
  if (!T.inv) return [u, v];
  const [ia, ib, ic] = T.inv, n = PATCH * PATCH, w = new Float32Array(n), u0 = u, v0 = v;
  for (let it = 0; it < iters; it++) {
    let mean = 0;
    for (let j = 0; j < PATCH; j++) for (let i = 0; i < PATCH; i++) { const s = sample(I1, px + i + u, py + j + v); w[j * PATCH + i] = s; mean += s; }
    mean /= n;
    let bx = 0, by = 0;
    for (let k = 0; k < n; k++) { const r = w[k] - mean - T.t[k]; bx += T.gx[k] * r; by += T.gy[k] * r; }
    const du = ia * bx + ib * by, dv = ib * bx + ic * by;
    u -= du; v -= dv;
    if (du * du + dv * dv < 1e-4) break;
  }
  // A patch that wandered further than its own size found something else: keep the seed.
  if ((u - u0) ** 2 + (v - v0) ** 2 > PATCH * PATCH) return [u0, v0];
  return [u, v];
}

function level(I0: Plane, I1: Plane, init: Flow): Flow {
  const xs = positions(I0.w), ys = positions(I0.h), nx = xs.length, ny = ys.length;
  const pu = new Float32Array(nx * ny), pv = new Float32Array(nx * ny), temps: Template[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const cx = Math.min(I0.w - 1, xs[i] + PATCH / 2), cy = Math.min(I0.h - 1, ys[j] + PATCH / 2), k = j * nx + i;
    pu[k] = init.fx[cy * init.w + cx]; pv[k] = init.fy[cy * init.w + cx];
    temps.push(template(I0, xs[i], ys[j]));
  }
  // Two sweeps, as in DIS: propagate the better neighbour's flow forward (then backward), then descend.
  for (const dir of [1, -1]) {
    for (let jj = 0; jj < ny; jj++) for (let ii = 0; ii < nx; ii++) {
      const i = dir > 0 ? ii : nx - 1 - ii, j = dir > 0 ? jj : ny - 1 - jj, k = j * nx + i, T = temps[k];
      let best = cost(T, I1, xs[i], ys[j], pu[k], pv[k]);
      for (const [ni, nj] of [[i - dir, j], [i, j - dir]]) {
        if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
        const m = nj * nx + ni, c = cost(T, I1, xs[i], ys[j], pu[m], pv[m]);
        if (c < best) { best = c; pu[k] = pu[m]; pv[k] = pv[m]; }
      }
      [pu[k], pv[k]] = refine(T, I1, xs[i], ys[j], pu[k], pv[k], ITERS / 2);
    }
  }
  // Densify: each pixel averages the patches covering it, weighted by how well each one fits there.
  const n = I0.w * I0.h, su = new Float32Array(n), sv = new Float32Array(n), sw = new Float32Array(n);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, u = pu[k], v = pv[k];
    for (let y = ys[j]; y < ys[j] + PATCH; y++) for (let x = xs[i]; x < xs[i] + PATCH; x++) {
      const p = y * I0.w + x, diff = Math.abs(sample(I1, x + u, y + v) - I0.d[p]), wt = 1 / Math.max(1, diff);
      su[p] += wt * u; sv[p] += wt * v; sw[p] += wt;
    }
  }
  for (let p = 0; p < n; p++) { su[p] /= sw[p]; sv[p] /= sw[p]; }
  return { w: I0.w, h: I0.h, fx: su, fy: sv };
}

function scaleFlow(f: Flow, w: number, h: number): Flow {
  const fx = resizeLinear(plane(f.w, f.h, f.fx), w, h).d, fy = resizeLinear(plane(f.w, f.h, f.fy), w, h).d;
  const sx = w / f.w, sy = h / f.h;
  for (let i = 0; i < fx.length; i++) { fx[i] *= sx; fy[i] *= sy; }
  return { w, h, fx, fy };
}

/** Flow from I0 to I1 (I1(x + flow) ≈ I0(x)) at I0's size, like cv2.DISOpticalFlow.calc(I0, I1). */
export function denseFlow(I0: Plane, I1: Plane): Flow {
  const coarsest = Math.max(FINEST, Math.min(Math.floor(Math.log2((2 * I0.w) / (4 * PATCH)) + 0.5), Math.floor(Math.log2(Math.min(I0.w, I0.h) / PATCH))));
  const pyr0: Plane[] = [I0], pyr1: Plane[] = [I1];
  for (let s = 1; s <= coarsest; s++) {
    const w = Math.max(PATCH, Math.floor(I0.w / 2 ** s)), h = Math.max(PATCH, Math.floor(I0.h / 2 ** s));
    pyr0.push(resizeArea(pyr0[s - 1], w, h)); pyr1.push(resizeArea(pyr1[s - 1], w, h));
  }
  const top = pyr0[coarsest];
  let flow: Flow = { w: top.w, h: top.h, fx: new Float32Array(top.w * top.h), fy: new Float32Array(top.w * top.h) };
  for (let s = coarsest; s >= FINEST; s--) {
    const a = pyr0[s];
    if (flow.w !== a.w || flow.h !== a.h) flow = scaleFlow(flow, a.w, a.h);
    flow = level(a, pyr1[s], flow);
  }
  return scaleFlow(flow, I0.w, I0.h);
}
