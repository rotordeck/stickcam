// Find on-screen display graphics in a cut and paint them out. Port of FPV DVR Cleaner
// src/flugbild/osd.py (https://github.com/Bratwurstexe/FPV_DVR_CLEANER @ 264d232, MIT).
//
// Detection uses gradient coherence. An overlay edge points the same way in every frame, while edges
// of the moving scene point in all directions over time. Per colour channel, the summed gradient
// vectors are compared with the summed gradient lengths; values near one mark edges that hold still.
// Bars and icons are found by their outlines and filled to the enclosed area.
// * Across probes spread over the whole cut (`findOsd`) this finds permanent overlays.
// * A sliding window over the frames (`removeRange`) finds overlays shown only briefly, such as
//   warnings, but only while the scene itself is moving.
// Removal works per overlay region: of the neighbouring frames, the one whose motion-aligned content
// matches the ring around the region best is pasted in with its brightness offset corrected. Without
// a good match the region is inpainted from its surroundings (a Telea fast-marching fill written here,
// since cv2.inpaint isn't available). Masks are 0/1 bytes internally; OsdMask planes are 0/255. Pure.
import { denseFlow, type Flow } from './flow.ts';
import { boxBlur, gaussianBlur, plane, remap, resizeArea, resizeLinear, resizeNearest, round8, type Plane, type Rgba } from './image.ts';
import type { OsdMask } from './repair.ts';

/** Neighbours on each side for the refill and the brief-overlay window ("balanced" osd_radius). */
export const RADIUS = 4;
/** Uncovered regions are inpainted at this scale ("balanced" osd_fill). The flow is the DIS fast preset. */
export const FILL_SCALE = 0.5;
/** Width of the grey frames the flow runs on. */
export const FLOW_WIDTH = 320;
/** Frames upstream samples over the cut for `findOsd`, and the fewest it accepts. */
export const PROBES = 40;
export const MIN_PROBES = 8;
/** Rim mismatch (mean abs, 8-bit levels) above which a neighbour isn't used. */
const FIT_LIMIT = 14;
/** An element counts as on screen when this share of its steady edges is found in a frame, and stays removed for HOLD frames after. */
export const SHOWN_SHARE = 0.35;
export const HOLD = 150;

type Bits = Uint8Array<ArrayBuffer>;

// ---------- binary morphology and shapes (OpenCV semantics, pixels outside the image ignored) ----------

/** Rect erode (grow = false) or dilate along one axis; window [i − k>>1, i − k>>1 + k), as OpenCV's anchor. */
function morph1d(src: Bits, w: number, h: number, k: number, alongX: boolean, grow: boolean): Bits {
  if (k <= 1) return src.slice();
  const out = new Uint8Array(w * h), a = k >> 1;
  if (alongX) {
    const pre = new Int32Array(w + 1);
    for (let y = 0, base = 0; y < h; y++, base += w) {
      for (let x = 0; x < w; x++) pre[x + 1] = pre[x] + src[base + x];
      for (let x = 0; x < w; x++) {
        const lo = x - a < 0 ? 0 : x - a, hi = x - a + k > w ? w : x - a + k, ones = pre[hi] - pre[lo];
        out[base + x] = grow ? (ones > 0 ? 1 : 0) : ones === hi - lo ? 1 : 0;
      }
    }
    return out;
  }
  // Down the columns: running sums kept row by row, so memory is read in order.
  const pre = new Int32Array((h + 1) * w);
  for (let y = 0; y < h; y++) for (let x = 0, o = y * w; x < w; x++) pre[o + w + x] = pre[o + x] + src[o + x];
  for (let y = 0; y < h; y++) {
    const lo = Math.max(0, y - a), hi = Math.min(h, y - a + k);
    const top = lo * w, bot = hi * w, o = y * w, full = hi - lo;
    if (grow) for (let x = 0; x < w; x++) out[o + x] = pre[bot + x] > pre[top + x] ? 1 : 0;
    else for (let x = 0; x < w; x++) out[o + x] = pre[bot + x] - pre[top + x] === full ? 1 : 0;
  }
  return out;
}
const grow = (m: Bits, w: number, h: number, kw: number, kh: number) => morph1d(morph1d(m, w, h, kw, true, true), w, h, kh, false, true);
const shrink = (m: Bits, w: number, h: number, kw: number, kh: number) => morph1d(morph1d(m, w, h, kw, true, false), w, h, kh, false, false);

/** cv2.dilate with getStructuringElement(MORPH_ELLIPSE, (k, k)). */
function growEllipse(m: Bits, w: number, h: number, k: number): Bits {
  const r = k >> 1, out = new Uint8Array(w * h), rows = new Map<number, Bits>();
  for (let dy = -r; dy <= r; dy++) {
    const dx = Math.round(r * Math.sqrt((r * r - dy * dy) / (r * r)));
    let row = rows.get(dx);
    if (!row) { row = morph1d(m, w, h, 2 * dx + 1, true, true); rows.set(dx, row); }
    for (let y = Math.max(0, -dy); y < Math.min(h, h - dy); y++) {
      const o = y * w, s = (y + dy) * w;
      for (let x = 0; x < w; x++) out[o + x] |= row[s + x];
    }
  }
  return out;
}

const and = (a: Bits, b: Bits) => a.map((v, i) => v & b[i]);
const any = (m: Bits) => m.some((v) => v !== 0);

interface Components { labels: Int32Array; count: number; /** x0, y0, x1, y1 (inclusive) per label */ boxes: Int32Array }

/** cv2.connectedComponentsWithStats(…, connectivity=8): labels in raster order of their first pixel, 0 = background. */
function components(m: Bits, w: number, h: number): Components {
  const labels = new Int32Array(w * h), boxes: number[] = [0, 0, w - 1, h - 1], stack: number[] = [];
  let count = 1;
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || labels[s]) continue;
    const id = count++;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    labels[s] = id; stack.push(s);
    while (stack.length) {
      const p = stack.pop()!, x = p % w, y = (p - x) / w;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (m[q] && !labels[q]) { labels[q] = id; stack.push(q); }
      }
    }
    boxes.push(x0, y0, x1, y1);
  }
  return { labels, count, boxes: Int32Array.from(boxes) };
}

/**
 * What findContours(RETR_EXTERNAL) + drawContours(FILLED) covers: every outer outline filled, holes
 * included. Background 4-connected to the outside stays empty; the rest falls into 8-connected shapes.
 */
function outlines(m: Bits, w: number, h: number): Components {
  const outside = new Uint8Array(w * h), stack: number[] = [];
  const seed = (p: number) => { if (!m[p] && !outside[p]) { outside[p] = 1; stack.push(p); } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (stack.length) {
    const p = stack.pop()!, x = p % w;
    if (x > 0) seed(p - 1); if (x < w - 1) seed(p + 1); if (p >= w) seed(p - w); if (p < w * (h - 1)) seed(p + w);
  }
  return components(outside.map((v) => 1 - v), w, h);
}

/** Angle 0..90° of the long side of the minimum-area rectangle around label `id` (cv2.minAreaRect). */
function tilt(c: Components, id: number, w: number): number {
  const b = c.boxes, x0 = b[id * 4], y0 = b[id * 4 + 1], x1 = b[id * 4 + 2], y1 = b[id * 4 + 3], pts: [number, number][] = [];
  for (let y = y0; y <= y1; y++) {
    let lo = -1, hi = -1;
    for (let x = x0; x <= x1; x++) if (c.labels[y * w + x] === id) { if (lo < 0) lo = x; hi = x; }
    if (lo >= 0) { pts.push([lo, y]); if (hi !== lo) pts.push([hi, y]); }
  }
  // Monotone-chain convex hull, then rotating calipers over the hull edges.
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o: number[], a: number[], b2: number[]) => (a[0] - o[0]) * (b2[1] - o[1]) - (a[1] - o[1]) * (b2[0] - o[0]);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  if (hull.length < 2) return 0;
  let best = Infinity, angle = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i], q = hull[(i + 1) % hull.length], len = Math.hypot(q[0] - a[0], q[1] - a[1]);
    if (!len) continue;
    const ux = (q[0] - a[0]) / len, uy = (q[1] - a[1]) / len;
    let lo = Infinity, hi = -Infinity, lo2 = Infinity, hi2 = -Infinity;
    for (const p of hull) {
      const s = p[0] * ux + p[1] * uy, t = -p[0] * uy + p[1] * ux;
      lo = Math.min(lo, s); hi = Math.max(hi, s); lo2 = Math.min(lo2, t); hi2 = Math.max(hi2, t);
    }
    const area = (hi - lo) * (hi2 - lo2);
    if (area < best - 1e-9) {
      best = area;
      const along = (Math.atan2(uy, ux) * 180) / Math.PI;
      const long = hi - lo >= hi2 - lo2 ? along : along + 90;
      const t = ((long % 180) + 180) % 180;
      angle = Math.min(t, 180 - t);
    }
  }
  return angle;
}

// ---------- pixels ----------

/** cv2.COLOR_BGR2GRAY on 8-bit pixels, OpenCV's fixed point. */
function gray8(f: Rgba): Uint8Array {
  const n = f.w * f.h, g = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (f.d[j] * 4899 + f.d[j + 1] * 9617 + f.d[j + 2] * 1868 + 8192) >> 14;
  return g;
}

const reflect = (i: number, n: number) => (i < 0 ? Math.min(-i, n - 1) : i >= n ? Math.max(2 * n - 2 - i, 0) : i);

/** 3×3 Sobel x and y of one channel (`stride` bytes per pixel, `off` within), BORDER_REFLECT_101. */
function sobel(src: ArrayLike<number>, w: number, h: number, stride = 1, off = 0): [Int16Array, Int16Array] {
  const sx = new Int16Array(w * h), sy = new Int16Array(w * h);
  const L = Int32Array.from({ length: w }, (_, x) => reflect(x - 1, w) * stride + off);
  const C = Int32Array.from({ length: w }, (_, x) => x * stride + off);
  const R = Int32Array.from({ length: w }, (_, x) => reflect(x + 1, w) * stride + off);
  for (let y = 0; y < h; y++) {
    const u = reflect(y - 1, h) * w * stride, m = y * w * stride, d = reflect(y + 1, h) * w * stride, o = y * w;
    for (let x = 0; x < w; x++) {
      const l = L[x], c = C[x], r = R[x];
      sx[o + x] = src[u + r] - src[u + l] + 2 * (src[m + r] - src[m + l]) + src[d + r] - src[d + l];
      sy[o + x] = src[d + l] - src[u + l] + 2 * (src[d + c] - src[u + c]) + src[d + r] - src[u + r];
    }
  }
  return [sx, sy];
}

/** Edge orientation in whole degrees, 1..180 (0 is kept for "no edge"). */
const orientation = (sx: number, sy: number) => ((((Math.trunc((Math.atan2(sy, sx) * 180) / Math.PI) % 180) + 180) % 180) + 1);

/** Python's round(): half to even. */
const pyRound = (v: number) => { const r = Math.round(v); return Math.abs(v % 1) === 0.5 && r % 2 ? r - 1 : r; };

/** Active picture without letterbox bars and their static border. */
function pictureArea(f: Rgba): Bits {
  const g = gray8(f);
  return shrink(g.map((v) => (v > 14 ? 1 : 0)), f.w, f.h, 9, 9);
}

const toBits = (p: Plane): Bits => { const m = new Uint8Array(p.d.length); for (let i = 0; i < m.length; i++) m[i] = p.d[i] > 0 ? 1 : 0; return m; };
const toPlane = (m: Bits, w: number, h: number, on = 255) => { const p = plane(w, h); for (let i = 0; i < m.length; i++) p.d[i] = m[i] * on; return p; };

// ---------- coherence ----------

/** Per-channel (interleaved R, G, B) Sobel steps and their rounded lengths of one frame. */
interface Gradients { sx: Int16Array; sy: Int16Array; len: Int16Array }

function gradients(f: Rgba): Gradients {
  const n = f.w * f.h, sx = new Int16Array(n * 3), sy = new Int16Array(n * 3), len = new Int16Array(n * 3);
  for (let c = 0; c < 3; c++) {
    const [gx, gy] = sobel(f.d, f.w, f.h, 4, c);
    for (let i = 0; i < n; i++) {
      const k = i * 3 + c;
      sx[k] = gx[i]; sy[k] = gy[i];
      // np.rint; the root of a whole number is never exactly x.5, so plain rounding matches.
      len[k] = Math.round(Math.sqrt(gx[i] * gx[i] + gy[i] * gy[i]));
    }
  }
  return { sx, sy, len };
}

/** Running per-channel sums of gradient vectors and gradient lengths. */
class Coherence {
  readonly vx: Int32Array;
  readonly vy: Int32Array;
  readonly len: Int32Array;
  count = 0;
  constructor(n: number) { this.vx = new Int32Array(n * 3); this.vy = new Int32Array(n * 3); this.len = new Int32Array(n * 3); }
  add(g: Gradients, sign = 1) {
    for (let k = 0; k < this.vx.length; k++) { this.vx[k] += sign * g.sx[k]; this.vy[k] += sign * g.sy[k]; this.len[k] += sign * g.len[k]; }
    this.count += sign;
  }
  /** Edges whose direction held over the frames and that are clearly drawn. */
  stillEdges(steadiness: number, strength: number): Bits {
    const n = this.vx.length / 3, out = new Uint8Array(n), count = Math.max(this.count, 1);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) {
      const k = i * 3 + c, l = this.len[k];
      if (l / count > strength && Math.sqrt(this.vx[k] * this.vx[k] + this.vy[k] * this.vy[k]) / Math.max(l, 1e-3) > steadiness) { out[i] = 1; break; }
    }
    return out;
  }
}

// ---------- shapes ----------

/** Join edge fragments into text lines and shapes; drop what is not overlay. */
function overlayShapes(edgesIn: Bits, picture: Bits, w: number, h: number): Bits {
  // The border between letterbox and picture holds still as well; leave it out so it cannot chain
  // the overlays along the edge into one shape.
  let edges = and(edgesIn, shrink(picture, w, h, 7, 7));
  // Long straight runs are frame borders, not OSD.
  for (const [kw, kh] of [[Math.max(3, w >> 2), 1], [1, Math.max(3, Math.floor(h / 6))]]) {
    const open = grow(shrink(edges, w, h, kw, kh), w, h, kw, kh), border = grow(open, w, h, 5, 5);
    edges = edges.map((v, i) => v & (1 - border[i]));
  }
  let lines = grow(edges, w, h, Math.max(3, w >> 6), 3);
  const ch = Math.max(3, Math.floor(h / 120));
  lines = shrink(grow(lines, w, h, 3, ch), w, h, 3, ch);
  let left = 0, right = w - 1;
  const cols: number[] = [];
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) if (picture[y * w + x]) { cols.push(x); break; }
  if (cols.length) { left = cols[0]; right = cols[cols.length - 1]; }
  let shapes: Bits = new Uint8Array(w * h);
  const c = outlines(lines, w, h);
  for (let id = 1; id < c.count; id++) {
    const x = c.boxes[id * 4], y = c.boxes[id * 4 + 1], bw = c.boxes[id * 4 + 2] - x + 1, bh = c.boxes[id * 4 + 3] - y + 1;
    const hugsSide = x - left < 12 || right - (x + bw) < 12;
    const spansPicture = x - left < 12 && right - (x + bw) < 12;
    // A whole OSD row may join into one wide shape; it stays a short strip.
    const tooBig = bh > h * 0.22 || (bw > w * 0.45 && bh > h * 0.1);
    let drawn = 0;
    for (let yy = y; yy < y + bh; yy++) for (let xx = x; xx < x + bw; xx++) drawn += edges[yy * w + xx];
    if (drawn < 40 || spansPicture || (hugsSide && bw < 1.5 * bh)) continue;
    for (let yy = y; yy < y + bh; yy++) for (let xx = x; xx < x + bw; xx++) {
      const p = yy * w + xx;
      // Several elements merged with something larger: keep only the still edges themselves.
      if (c.labels[p] === id && (!tooBig || lines[p])) shapes[p] = 1;
    }
  }
  shapes = growEllipse(shapes, w, h, 7);
  return and(shapes, picture);
}

/**
 * Keep only shapes that look like a line of OSD text. A straight scene edge that slides along itself
 * while the drone flies keeps its direction just like a drawn overlay. Warnings such as CRASH FLIP
 * differ: a flat, level row whose letters are full of upright strokes.
 */
function textRows(shapes: Bits, gray: Uint8Array, w: number, h: number): Bits {
  const [gx, gy] = sobel(gray, w, h), kept = new Uint8Array(w * h), c = outlines(shapes, w, h);
  for (let id = 1; id < c.count; id++) {
    const x0 = c.boxes[id * 4], y0 = c.boxes[id * 4 + 1], x1 = c.boxes[id * 4 + 2], y1 = c.boxes[id * 4 + 3];
    if (tilt(c, id, w) > 8 || y1 - y0 + 1 > h * 0.1) continue;
    let strong = 0, upright = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const p = y * w + x;
      if (c.labels[p] !== id) continue;
      const across = Math.abs(gx[p]), down = Math.abs(gy[p]);
      if (Math.max(across, down) > 60) { strong++; if (across > down) upright++; }
    }
    if (strong && upright >= 0.3 * strong) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (c.labels[y * w + x] === id) kept[y * w + x] = 1;
  }
  return kept;
}

// ---------- the clip mask ----------

/**
 * Mask (0/255) of overlay graphics from frames sampled over one cut, and its guide.
 *
 * Upstream (_probe_frames) samples PROBES = 40 frames evenly over the cut, at about start + k·duration/40
 * (ffmpeg fps=40/duration; cuts of 40 s and more use keyframes only, which may repeat), on the full
 * frame; the mask and guide are then cropped to the picture box (`cropOsd`). Fewer than 8 frames throw.
 *
 * The guide holds, inside the mask, the orientation (1..180°) of every edge that held still over the
 * probes, 0 elsewhere. It tells whether an element is on screen in a given frame: digits that change
 * have no steady edges, while the icon, point and unit around them do.
 */
export function findOsd(frames: Rgba[]): OsdMask {
  if (frames.length < MIN_PROBES) throw new Error('Too few readable frames to find the OSD');
  const { w, h } = frames[0], n = w * h, coherence = new Coherence(n);
  for (const f of frames) coherence.add(gradients(f));
  const picture = new Uint8Array(n);
  for (let k = 0; k < frames.length; k += Math.max(1, Math.floor(frames.length / 8))) {
    const p = pictureArea(frames[k]);
    for (let i = 0; i < n; i++) picture[i] |= p[i];
  }
  const edges = coherence.stillEdges(0.7, 80), mask = overlayShapes(edges, picture, w, h), guide = plane(w, h);
  for (let i = 0; i < n; i++) {
    if (!edges[i] || !mask[i]) continue;
    // The colour channel with the strongest steady edge sets the direction (first in B, G, R order on ties, as argmax on BGR).
    let best = -1, bc = 2;
    for (const c of [2, 1, 0]) { const m = Math.hypot(coherence.vx[i * 3 + c], coherence.vy[i * 3 + c]); if (m > best) { best = m; bc = c; } }
    guide.d[i] = orientation(coherence.vx[i * 3 + bc], coherence.vy[i * 3 + bc]);
  }
  return { mask: toPlane(mask, w, h), guide };
}

/** Mask and guide cut to the picture box (restoration._crop). */
export function cropOsd(osd: OsdMask, box: { x: number; y: number; w: number; h: number }): OsdMask {
  const cut = (p: Plane) => {
    const out = plane(box.w, box.h);
    for (let y = 0; y < box.h; y++) out.d.set(p.d.subarray((box.y + y) * p.w + box.x, (box.y + y) * p.w + box.x + box.w), y * box.w);
    return out;
  };
  return { mask: cut(osd.mask), guide: cut(osd.guide) };
}

// ---------- which elements are on screen ----------

/** Mask elements (8-connected, raster order; 0 = background) and the guide pixels inside them. */
interface Elements { labels: Int32Array; count: number; at: Int32Array; label: Int32Array; dir: Int16Array; unguided: Uint8Array }

function elements(osd: OsdMask): Elements {
  const { w, h } = osd.mask, c = components(toBits(osd.mask), w, h), at: number[] = [];
  for (let i = 0; i < osd.guide.d.length; i++) if (osd.guide.d[i] > 0) at.push(i);
  const label = Int32Array.from(at, (i) => c.labels[i]), dir = Int16Array.from(at, (i) => osd.guide.d[i]);
  // Elements without steady edges cannot be checked; they stay removed.
  const unguided = new Uint8Array(c.count).fill(1);
  for (const l of label) unguided[l] = 0;
  return { labels: c.labels, count: c.count, at: Int32Array.from(at), label, dir, unguided };
}

/** Per mask element, the share of its guide edges found with the same orientation in `f` (_shown_share). */
function shownShare(f: Rgba, e: Elements): Float32Array {
  const { w, h } = f, g = gray8(f), total = new Float32Array(e.count), hit = new Float32Array(e.count);
  for (let k = 0; k < e.at.length; k++) {
    const p = e.at[k], x = p % w, y = (p - x) / w, u = reflect(y - 1, h) * w, m = y * w, d = reflect(y + 1, h) * w;
    const l = reflect(x - 1, w), r = reflect(x + 1, w);
    const sx = g[u + r] - g[u + l] + 2 * (g[m + r] - g[m + l]) + g[d + r] - g[d + l];
    const sy = g[d + l] - g[u + l] + 2 * (g[d + x] - g[u + x]) + g[d + r] - g[u + r];
    let turn = Math.abs(orientation(sx, sy) - e.dir[k]);
    turn = Math.min(turn, 180 - turn);
    total[e.label[k]]++;
    if (sx * sx + sy * sy > 1600 && turn <= 20) hit[e.label[k]]++;
  }
  return hit.map((v, i) => v / Math.max(total[i], 1));
}

/** What `removeRange` needs to know about the frames before its first one. */
export interface OsdState {
  /** Per mask element, the index (relative to frames[0], so negative) of the last earlier frame that showed it. */
  lastSeen?: Int32Array;
  /** Picture area (0/1) OR-ed over all earlier frames of the stream. */
  picture?: Uint8Array;
}

/**
 * Follows a stream in order so ranges repaired apart (in workers) see the history upstream's single
 * stream has: which elements were on screen during the last HOLD frames, and the picture area so far.
 * Cheap: a grey frame, Sobel at the guide pixels only, and one 9×9 erosion.
 */
export class OsdTrack {
  private readonly el: Elements;
  private readonly seen: Float64Array;
  private readonly sightings: Int32Array[] = [];
  private picture: Uint8Array | null = null;
  private pending: Uint8Array[] = [];
  private base = 0;
  added = 0;
  constructor(osd: OsdMask) {
    this.el = elements(osd);
    this.seen = new Float64Array(this.el.count).fill(-Infinity);
  }
  /** Feed the next frame of the stream. */
  add(f: Rgba) {
    const share = shownShare(f, this.el), hits: number[] = [];
    for (let e = 0; e < share.length; e++) if (share[e] >= SHOWN_SHARE) hits.push(e);
    this.sightings.push(Int32Array.from(hits));
    this.pending.push(pictureArea(f));
    this.added++;
  }
  /** State for a range whose frames[0] is stream frame `index` (only frames before it count). Call with rising `index`. */
  state(index: number): OsdState {
    while (this.base < index && this.pending.length) {
      const p = this.pending.shift()!;
      if (!this.picture) this.picture = p.slice(); else for (let i = 0; i < p.length; i++) this.picture[i] |= p[i];
      for (const e of this.sightings[this.base]) this.seen[e] = this.base;
      this.base++;
    }
    const lastSeen = new Int32Array(this.el.count);
    for (let e = 0; e < lastSeen.length; e++) lastSeen[e] = Number.isFinite(this.seen[e]) ? this.seen[e] - index : -HOLD - 1;
    return { lastSeen, picture: this.picture?.slice() };
  }
}

// ---------- refill ----------

/** Grey frame at the flow size. */
function small(f: Rgba): Plane {
  const sw = Math.min(f.w, FLOW_WIDTH), sh = Math.max(8, pyRound((f.h * sw) / f.w));
  return round8(resizeArea(plane(f.w, f.h, Float32Array.from(gray8(f))), sw, sh));
}

/** Clip mask at the flow size, grown by 5 px: there the flow is carried in from around. */
function blockedAt(mask: Bits, w: number, h: number, sw: number, sh: number): Bits {
  return grow(toBits(resizeNearest(toPlane(mask, w, h), sw, sh)), sw, sh, 5, 5);
}

/** Flow from `present` into `other`. Overlays do not move and would hold it at zero; carry the surrounding scene motion into those areas. */
function motion(present: Plane, other: Plane, blocked: Bits): Flow {
  const f = denseFlow(present, other), { w, h } = present, open = plane(w, h);
  for (let i = 0; i < open.d.length; i++) open.d[i] = blocked[i] ? 0 : 1;
  const reach = boxBlur(open, 41, 41);
  for (const part of [f.fx, f.fy]) {
    const spread = boxBlur(plane(w, h, part.map((v, i) => v * open.d[i])), 41, 41);
    for (let i = 0; i < part.length; i++) if (blocked[i]) part[i] = spread.d[i] / Math.max(reach.d[i], 1e-3);
  }
  return f;
}

/** `total` followed by `step` from where it lands (one link of _chained). */
function chain(total: Flow, step: Flow): Flow {
  const { w, h } = total, mx = new Float32Array(w * h), my = new Float32Array(w * h);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) { mx[i] = x + total.fx[i]; my[i] = y + total.fy[i]; }
  const [sx, sy] = remap([plane(w, h, step.fx), plane(w, h, step.fy)], mx, my, w, h);
  return { w, h, fx: total.fx.map((v, i) => v + sx.d[i]), fy: total.fy.map((v, i) => v + sy.d[i]) };
}

interface Neighbour { frame: Rgba; flow: () => Flow }

/** Paste each overlay region from the neighbour that fits its rim best (_Patcher.apply). */
function patch(frame: Rgba, mask: Bits, neighbours: Neighbour[], picture: () => Bits, fillScale: number): Rgba {
  const { w, h } = frame;
  if (!any(mask)) return frame;
  if (!neighbours.length) return inpaint(frame, mask, picture(), fillScale);
  const result: Rgba = { w, h, d: frame.d.slice() }, src = frame.d;
  const c = components(mask, w, h), unresolved = new Uint8Array(w * h);
  let sw = 0, sh = 0;
  for (let id = 1; id < c.count; id++) {
    const left = Math.max(0, c.boxes[id * 4] - 10), top = Math.max(0, c.boxes[id * 4 + 1] - 10);
    const right = Math.min(w, c.boxes[id * 4 + 2] + 1 + 10), bottom = Math.min(h, c.boxes[id * 4 + 3] + 1 + 10);
    const bw = right - left, bh = bottom - top, n = bw * bh, inside = new Uint8Array(n);
    let count = 0;
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (c.labels[(top + y) * w + left + x] === id) { inside[y * bw + x] = 1; count++; }
    const near = grow(inside, bw, bh, 9, 9), rim: number[] = [];
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const k = y * bw + x;
      if (near[k] && !inside[k] && !mask[(top + y) * w + left + x]) rim.push(k);
    }
    let best: { patch: Float32Array; offset: number[] } | null = null, bestFit = FIT_LIMIT;
    for (const nb of neighbours) {
      const flow = nb.flow();
      sw = flow.w; sh = flow.h;
      const scx = sw / w, scy = sh / h, mx = new Float32Array(n), my = new Float32Array(n);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        // Nearest lookup of the small-scale flow, the same for every neighbour.
        const ax = Math.min(Math.trunc((left + x) * scx), sw - 1), ay = Math.min(Math.trunc((top + y) * scy), sh - 1), k = y * bw + x;
        mx[k] = left + x + flow.fx[ay * sw + ax] / scx; my[k] = top + y + flow.fy[ay * sw + ax] / scy;
      }
      let landed = 0;
      for (let k = 0; k < n; k++) {
        if (!inside[k]) continue;
        const lx = Math.round(mx[k]), ly = Math.round(my[k]);
        if (lx < 0 || ly < 0 || lx >= w || ly >= h || mask[ly * w + lx]) landed++;
      }
      if (landed / count > 0.05) continue; // The neighbour shows overlay or picture edge there too.
      const pt = warpRgb(nb.frame, mx, my);
      if (!rim.length) { best = { patch: pt, offset: [0, 0, 0] }; bestFit = 0; break; }
      const offset = [0, 0, 0];
      for (const k of rim) for (let ch = 0; ch < 3; ch++) offset[ch] += src[((top + ((k / bw) | 0)) * w + left + (k % bw)) * 4 + ch] - pt[k * 3 + ch];
      for (let ch = 0; ch < 3; ch++) offset[ch] /= rim.length;
      let fit = 0;
      for (const k of rim) for (let ch = 0; ch < 3; ch++) fit += Math.abs(src[((top + ((k / bw) | 0)) * w + left + (k % bw)) * 4 + ch] - pt[k * 3 + ch] - offset[ch]);
      fit /= rim.length * 3;
      if (fit < bestFit) {
        best = { patch: pt, offset }; bestFit = fit;
        if (fit < FIT_LIMIT / 2) break; // Neighbours are ordered by distance; this one is good enough.
      }
    }
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const k = y * bw + x, p = (top + y) * w + left + x;
      if (!inside[k]) continue;
      if (!best) { unresolved[p] = 1; continue; }
      // astype(uint8) after clipping truncates, as in the original.
      for (let ch = 0; ch < 3; ch++) result.d[p * 4 + ch] = Math.trunc(Math.min(255, Math.max(0, best.patch[k * 3 + ch] + best.offset[ch])));
    }
  }
  const filled = any(unresolved) ? inpaint(result, unresolved, picture(), fillScale) : result;
  // Soften the seam so analog noise differences do not draw an outline (cv2.blendLinear).
  const edge = gaussianBlur(toPlane(mask, w, h, 1), 7, 7);
  const out: Rgba = { w, h, d: frame.d.slice() };
  for (let i = 0; i < w * h; i++) {
    const e = edge.d[i];
    if (e <= 0) continue;
    for (let ch = 0; ch < 3; ch++) out.d[i * 4 + ch] = Math.round((filled.d[i * 4 + ch] * e + src[i * 4 + ch] * (1 - e)) / (1 + 1e-5));
  }
  return out;
}

/** cv2.remap INTER_LINEAR, BORDER_REPLICATE of an RGBA frame into rounded RGB values at the given points. */
function warpRgb(f: Rgba, mx: Float32Array, my: Float32Array): Float32Array {
  const { w, h, d } = f, out = new Float32Array(mx.length * 3);
  for (let k = 0; k < mx.length; k++) {
    const x = Math.min(Math.max(mx[k], 0), w - 1), y = Math.min(Math.max(my[k], 0), h - 1);
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, w - 1), y1 = Math.min(y0 + 1, h - 1), fx = x - x0, fy = y - y0;
    const a = (y0 * w + x0) * 4, b = (y0 * w + x1) * 4, c = (y1 * w + x0) * 4, e = (y1 * w + x1) * 4;
    for (let ch = 0; ch < 3; ch++) {
      out[k * 3 + ch] = Math.round(d[a + ch] * (1 - fx) * (1 - fy) + d[b + ch] * fx * (1 - fy) + d[c + ch] * (1 - fx) * fy + d[e + ch] * fx * fy);
    }
  }
  return out;
}

// ---------- spatial fallback ----------

/**
 * Spatial fallback: inpaint each region from the picture around it. Below a `scale` of one the regions
 * are filled at a reduced size and enlarged again: the fill is smooth anyway, and the cost falls with area.
 */
function inpaint(frame: Rgba, mask: Bits, picture: Bits, scale: number): Rgba {
  const { w, h } = frame, result: Rgba = { w, h, d: frame.d.slice() };
  // Letterbox pixels next to a hole are treated as unknown so no black bleeds into the fill; only a
  // narrow band, to keep the inpainting work small.
  const letterbox = grow(picture, w, h, 15, 15), near = grow(mask, w, h, 17, 17);
  const unknown = mask.map((v, i) => v | ((1 - letterbox[i]) & near[i]));
  const c = components(mask, w, h);
  for (let id = 1; id < c.count; id++) {
    const left = Math.max(0, c.boxes[id * 4] - 12), top = Math.max(0, c.boxes[id * 4 + 1] - 12);
    const right = Math.min(w, c.boxes[id * 4 + 2] + 1 + 12), bottom = Math.min(h, c.boxes[id * 4 + 3] + 1 + 12);
    const bw = right - left, bh = bottom - top, area: Plane[] = [plane(bw, bh), plane(bw, bh), plane(bw, bh)], gaps = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const p = (top + y) * w + left + x;
      for (let ch = 0; ch < 3; ch++) area[ch].d[y * bw + x] = result.d[p * 4 + ch];
      gaps[y * bw + x] = unknown[p];
    }
    let painted: Plane[];
    if (scale < 1 && Math.min(bw, bh) * scale >= 8) {
      const sw = Math.max(1, pyRound(bw * scale)), sh = Math.max(1, pyRound(bh * scale));
      const smallGaps = grow(toBits(resizeNearest(toPlane(gaps, bw, bh), sw, sh)), sw, sh, 3, 3);
      painted = telea(area.map((p) => round8(resizeArea(p, sw, sh))), smallGaps, Math.max(2, pyRound(5 * scale)));
      painted = painted.map((p) => round8(resizeLinear(p, bw, bh)));
    } else painted = telea(area, gaps, 5);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
      const p = (top + y) * w + left + x;
      if (mask[p]) for (let ch = 0; ch < 3; ch++) result.d[p * 4 + ch] = painted[ch].d[y * bw + x];
    }
  }
  return result;
}

/**
 * Replacement for cv2.inpaint(…, INPAINT_TELEA), which isn't available here. Same method as OpenCV's
 * (Telea 2004): fast marching from the hole's border inward; each pixel is the weighted mean of the
 * known pixels within `range`, weighted by direction, distance and level-set closeness, plus OpenCV's
 * normalised gradient term and +0.5 rounding bias. Simplified: the image gradient at the neighbours uses
 * plain central or one-sided differences, and ties in the march are broken by insertion order.
 */
function telea(img: Plane[], hole: Bits, range: number): Plane[] {
  const { w, h } = img[0], W = w + 2, H = h + 2, KNOWN = 0, BAND = 1, INSIDE = 2;
  const out = img.map((p) => plane(w, h, p.d.slice()));
  const at = (x: number, y: number) => (y + 1) * W + x + 1; // padded index of image pixel (x, y)
  const f = new Uint8Array(W * H), t = new Float32Array(W * H).fill(1e6);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (hole[y * w + x]) f[at(x, y)] = INSIDE;
  const heap = new Heap();
  // The band: known pixels 4-touching the hole (cross dilation minus the hole), at distance 0.
  const isHole = (p: number) => f[p] === INSIDE;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = at(x, y);
    if (f[p] !== INSIDE && (isHole(p - 1) || isHole(p + 1) || isHole(p - W) || isHole(p + W))) { f[p] = BAND; t[p] = 0; heap.push(p, 0); }
  }
  const solve = (a: number, b: number, fl: Uint8Array) => {
    const a11 = t[a], a22 = t[b], m12 = Math.min(a11, a22);
    if (fl[a] !== INSIDE) {
      if (fl[b] !== INSIDE) return Math.abs(a11 - a22) >= 1 ? 1 + m12 : (a11 + a22 + Math.sqrt(2 - (a11 - a22) ** 2)) * 0.5;
      return 1 + a11;
    }
    return fl[b] !== INSIDE ? 1 + a22 : 1 + m12;
  };
  const dist = (p: number, fl: Uint8Array) => Math.min(solve(p - W, p - 1, fl), solve(p + W, p - 1, fl), solve(p - W, p + 1, fl), solve(p + W, p + 1, fl));
  const real = (p: number) => { const x = p % W, y = (p - x) / W; return x > 0 && y > 0 && x < W - 1 && y < H - 1; };
  // Outside the hole, within `range`: negative distances from the band (gives the level-set term its sign).
  {
    const ring = new Uint8Array(W * H), r = new Heap();
    const near = grow(hole, w, h, 2 * range + 1, 2 * range + 1);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = at(x, y); if (near[y * w + x] && f[p] === KNOWN) ring[p] = INSIDE; }
    for (let p = 0; p < W * H; p++) if (f[p] === BAND) r.push(p, 0);
    const changed: number[] = [];
    for (let p = r.pop(); p >= 0; p = r.pop()) {
      changed.push(p);
      for (const q of [p - W, p - 1, p + W, p + 1]) {
        if (!real(q) || ring[q] !== INSIDE) continue;
        t[q] = dist(q, ring); ring[q] = BAND; r.push(q, t[q]);
      }
    }
    for (const p of changed) if (f[p] === KNOWN) t[p] = -t[p];
  }
  for (let p = heap.pop(); p >= 0; p = heap.pop()) {
    f[p] = KNOWN;
    for (const q of [p - W, p - 1, p + W, p + 1]) {
      if (!real(q) || f[q] !== INSIDE) continue;
      const d = dist(q, f);
      t[q] = d;
      const gtx = f[q + 1] !== INSIDE ? (f[q - 1] !== INSIDE ? (t[q + 1] - t[q - 1]) * 0.5 : t[q + 1] - t[q]) : f[q - 1] !== INSIDE ? t[q] - t[q - 1] : 0;
      const gty = f[q + W] !== INSIDE ? (f[q - W] !== INSIDE ? (t[q + W] - t[q - W]) * 0.5 : t[q + W] - t[q]) : f[q - W] !== INSIDE ? t[q] - t[q - W] : 0;
      const qx = (q % W) - 1, qy = ((q - qx - 1) / W) - 1;
      for (let ch = 0; ch < out.length; ch++) {
        const o = out[ch].d;
        let ia = 0, jx = 0, jy = 0, s = 1e-20;
        for (let ky = qy - range; ky <= qy + range; ky++) for (let kx = qx - range; kx <= qx + range; kx++) {
          if (kx < 0 || ky < 0 || kx >= w || ky >= h) continue;
          const k = at(kx, ky);
          if (f[k] === INSIDE || (kx - qx) ** 2 + (ky - qy) ** 2 > range * range) continue;
          const ry = qy - ky, rx = qx - kx, r2 = rx * rx + ry * ry;
          const dst = 1 / (r2 * Math.sqrt(r2)), lev = 1 / (1 + Math.abs(t[k] - t[q]));
          let dir = rx * gtx + ry * gty;
          if (Math.abs(dir) <= 0.01) dir = 1e-6;
          const wt = Math.abs(dst * lev * dir), v = (xx: number, yy: number) => o[yy * w + xx];
          const kn = (xx: number, yy: number) => xx >= 0 && yy >= 0 && xx < w && yy < h && f[at(xx, yy)] !== INSIDE;
          const gix = kn(kx + 1, ky) ? (kn(kx - 1, ky) ? (v(kx + 1, ky) - v(kx - 1, ky)) * 2 : v(kx + 1, ky) - v(kx, ky)) : kn(kx - 1, ky) ? v(kx, ky) - v(kx - 1, ky) : 0;
          const giy = kn(kx, ky + 1) ? (kn(kx, ky - 1) ? (v(kx, ky + 1) - v(kx, ky - 1)) * 2 : v(kx, ky + 1) - v(kx, ky)) : kn(kx, ky - 1) ? v(kx, ky) - v(kx, ky - 1) : 0;
          ia += wt * v(kx, ky); jx -= wt * gix * rx; jy -= wt * giy * ry; s += wt;
        }
        o[qy * w + qx] = Math.min(255, Math.max(0, Math.round(ia / s + (jx + jy) / (Math.sqrt(jx * jx + jy * jy) + 1e-20) + 0.5)));
      }
      f[q] = BAND;
      heap.push(q, d);
    }
  }
  return out;
}

/** Binary min-heap of pixel indices by distance; ties pop in insertion order. */
class Heap {
  private keys: number[] = [];
  private ids: number[] = [];
  private order: number[] = [];
  private n = 0;
  private less(a: number, b: number) { return this.keys[a] < this.keys[b] || (this.keys[a] === this.keys[b] && this.order[a] < this.order[b]); }
  private swap(a: number, b: number) {
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    [this.ids[a], this.ids[b]] = [this.ids[b], this.ids[a]];
    [this.order[a], this.order[b]] = [this.order[b], this.order[a]];
  }
  push(id: number, key: number) {
    let i = this.keys.length;
    this.keys.push(key); this.ids.push(id); this.order.push(this.n++);
    while (i > 0) { const p = (i - 1) >> 1; if (!this.less(i, p)) break; this.swap(i, p); i = p; }
  }
  /** Smallest id, or −1 when empty. */
  pop(): number {
    if (!this.keys.length) return -1;
    const top = this.ids[0], last = this.keys.length - 1;
    this.swap(0, last); this.keys.pop(); this.ids.pop(); this.order.pop();
    for (let i = 0; ;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < this.keys.length && this.less(l, m)) m = l;
      if (r < this.keys.length && this.less(r, m)) m = r;
      if (m === i) break;
      this.swap(i, m); i = m;
    }
    return top;
  }
}

// ---------- the stream ----------

/** Per-frame data, computed once and shared by every window the frame is in (_Probe). */
interface Probe { small: Plane; tiny: Float32Array; parts: Gradients | null; picture: Bits }

/**
 * Frames `from..to-1` of `frames` with the clip mask plus briefly shown overlays painted out
 * (remove_stream). Frames outside the range are context: for an exact match with upstream's single
 * stream, give RADIUS frames on each side (fewer only at the ends of the stream), and `state` from an
 * `OsdTrack` for the HOLD frames before frames[0]. All frames the same size as the mask.
 *
 * The clip mask gathers everything shown at some point of the cut, such as the stats screen after
 * landing. With the guide, an element is painted out only around the frames that show it: seen up to
 * RADIUS frames ahead or HOLD frames before, so blinking warnings and changing digits do not flicker.
 * Motion between a frame and its neighbours is chained from flows between consecutive frames.
 */
export function removeRange(frames: Rgba[], from: number, to: number, osd: OsdMask, state: OsdState = {}, fillScale = FILL_SCALE): Rgba[] {
  const n = frames.length, { w, h } = frames[0], N = w * h, R = RADIUS;
  const clip = toBits(osd.mask), widen = (m: Bits) => grow(m, w, h, 11, 3); // analog chroma smears colour sideways past the graphic
  const flat = widen(clip), el = elements(osd);
  const lastSeen = Int32Array.from({ length: el.count }, (_, e) => state.lastSeen?.[e] ?? -HOLD - 1);
  const picture = state.picture ? state.picture.slice() : new Uint8Array(N);
  const probes = new Map<number, Probe>(), movement: number[] = [];
  let read = -1, sw = 0, sh = 0, blocked: Bits | null = null, coh: Coherence | null = null, ca = 0, cb = -1;
  const probe = (k: number): Probe => {
    let p = probes.get(k);
    if (!p) {
      const g = plane(w, h, Float32Array.from(gray8(frames[k])));
      p = { small: small(frames[k]), tiny: round8(resizeArea(g, 160, 90)).d, parts: null, picture: pictureArea(frames[k]) };
      probes.set(k, p);
    }
    return p;
  };
  const parts = (k: number) => { const p = probe(k); return (p.parts ??= gradients(frames[k])); };
  /** Read frames up to k, in stream order: who is on screen, picture area, movement. */
  const readTo = (k: number) => {
    for (; read < k;) {
      read++;
      const share = shownShare(frames[read], el);
      for (let e = 0; e < share.length; e++) if (share[e] >= SHOWN_SHARE) lastSeen[e] = read;
      // Frames before the first window only add to the history.
      const early = read < from - R, area = early ? pictureArea(frames[read]) : probe(read).picture;
      for (let i = 0; i < N; i++) picture[i] |= area[i];
      if (early) { movement[read] = 0; continue; }
      const p = probe(read), prev = read > 0 ? probe(read - 1) : null;
      let m = 0;
      if (prev) { for (let i = 0; i < p.tiny.length; i++) m += Math.abs(p.tiny[i] - prev.tiny[i]); m /= p.tiny.length; }
      movement[read] = m;
    }
  };
  const steps = new Map<string, Flow>();
  const step = (k: number, dir: number) => {
    const key = `${k},${dir}`;
    let s = steps.get(key);
    if (!s) { s = motion(probe(k).small, probe(k + dir).small, blocked!); steps.set(key, s); }
    return s;
  };
  const out: Rgba[] = [];
  for (let here = from; here < to; here++) {
    const a = Math.max(0, here - R), b = Math.min(n - 1, here + R);
    readTo(b);
    for (const k of probes.keys()) if (k < a - 1) probes.delete(k);
    for (const key of steps.keys()) if (+key.split(',')[0] < a) steps.delete(key);
    const frame = frames[here];
    if (!blocked) { const s = probe(here).small; sw = s.w; sh = s.h; blocked = blockedAt(clip, w, h, sw, sh); }
    // Brief overlays can only be told apart from the scene while it moves.
    let edges: Bits | null = null;
    const moves = movement.slice(a, b + 1).sort((x, y) => x - y), mid = moves.length >> 1;
    const med = moves.length % 2 ? moves[mid] : (moves[mid - 1] + moves[mid]) / 2;
    if (b - a + 1 > 4 && med > 4) {
      if (!coh || cb < a) { coh = new Coherence(N); ca = a; cb = a - 1; }
      while (cb < b) coh.add(parts(++cb));
      while (ca < a) coh.add(parts(ca++), -1);
      edges = coh.stillEdges(0.85, 80);
    }
    const shown = new Uint8Array(el.count);
    let all = true;
    for (let e = 1; e < el.count; e++) { shown[e] = here - lastSeen[e] <= HOLD || el.unguided[e] ? 1 : 0; all &&= shown[e] === 1; }
    let regions = flat;
    if (!all) regions = widen(Uint8Array.from(el.labels, (l) => shown[l]));
    if (edges) {
      const brief = widen(textRows(overlayShapes(edges, picture, w, h), gray8(frame), w, h));
      regions = regions.map((v, i) => v | brief[i]);
    }
    // Neighbours by distance, the earlier one first; flows chained outward one frame at a time.
    const neighbours: Neighbour[] = [], chains = new Map<number, Flow>();
    const chained = (j: number): Flow => {
      let f = chains.get(j);
      if (!f) {
        const dir = j > here ? 1 : -1;
        const prev = j - dir === here ? { w: sw, h: sh, fx: new Float32Array(sw * sh), fy: new Float32Array(sw * sh) } : chained(j - dir);
        f = chain(prev, step(j - dir, dir));
        chains.set(j, f);
      }
      return f;
    };
    for (let d = 1; d <= R; d++) for (const j of [here - d, here + d]) if (j >= a && j <= b) neighbours.push({ frame: frames[j], flow: () => chained(j) });
    out.push(patch(frame, regions, neighbours, () => probe(here).picture, fillScale));
  }
  return out;
}

/** Remove the clip mask from one frame, preferring content from `neighbours` (remove_osd); flows taken directly, inpaint at full size. */
export function removeOsd(frame: Rgba, osd: OsdMask, neighbours: Rgba[] = []): Rgba {
  const mask = toBits(osd.mask), present = small(frame), blocked = blockedAt(mask, frame.w, frame.h, present.w, present.h);
  return patch(frame, mask, neighbours.map((o) => ({ frame: o, flow: () => motion(present, small(o), blocked) })), () => pictureArea(frame), 1);
}

/** Mark the detected OSD in orange on one frame. */
export function preview(frame: Rgba, osd: OsdMask): Rgba {
  const { w, h } = frame, mask = toBits(osd.mask), out: Rgba = { w, h, d: frame.d.slice() };
  const thick = grow(mask, w, h, 3, 3), thin = shrink(mask, w, h, 3, 3), tint = [239, 119, 27];
  for (let i = 0; i < w * h; i++) {
    if (thick[i] && !thin[i]) for (let c = 0; c < 3; c++) out.d[i * 4 + c] = tint[c];
    else if (mask[i]) for (let c = 0; c < 3; c++) out.d[i * 4 + c] = Math.round(frame.d[i * 4 + c] * 0.35 + tint[c] * 0.65);
  }
  return out;
}
