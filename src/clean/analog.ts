// Temporal chroma repair for analog FPV recordings. Port of FPV DVR Cleaner src/flugbild/analog.py
// (https://github.com/Bratwurstexe/FPV_DVR_CLEANER @ 264d232, MIT).
//
// Analog receivers keep luma comparatively stable while chroma fails frame by frame:
// * Colour dropout: a frame or band of rows recorded with practically no chroma, tested per row
//   against an absolute level, so a genuinely grey scene stays grey.
// * Hue tears: rainbow stripes, saturated colour whose hue jumps from one row to the next.
// * Unbacked bands: stripes that keep reappearing at the same edge; their top and bottom are colour
//   edges without a brightness edge, refilled from a local luma-to-colour model.
// Luma is kept. Chroma is re-estimated from three earlier and three later frames aligned with optical
// flow, weighted by luma match and the fault scores, with a Cauchy reweighting against outliers.
// Where no neighbour carries usable colour, the estimate fades to grey instead of spreading a stripe.
// Chroma is complex in the original (Cr real, Cb imaginary); here it is the two planes cr and cb. Pure.
import { denseFlow } from './flow.ts';
import {
  boxBlur, clip01, dilate, fromYcc, gaussianBlur, plane, remap, resizeArea, resizeLinear, round8, toYcc,
  type Plane, type Rgba,
} from './image.ts';

export const RADIUS = 3;
const FLOW_WIDTH = 320;
const LUMA_MATCH = 16;
const OUTLIER_SCALE = 10;
const DROPOUT_LEVEL = 1.5, DROPOUT_RAMP = 2.5;

const each = (w: number, h: number, fn: (i: number) => number) => {
  const p = plane(w, h);
  for (let i = 0; i < p.d.length; i++) p.d[i] = fn(i);
  return p;
};
const max = (p: Plane) => p.d.reduce((m, v) => (v > m ? v : m), -Infinity);

/** Analog chroma carries far less horizontal than vertical detail: every 2nd row, every 4th column. */
const grid = (w: number, h: number): [number, number] => [Math.max(8, Math.floor(w / 4)), Math.max(8, Math.floor(h / 2))];

/** Score 0..1 for rainbow stripes: saturated colour whose hue jumps between rows. */
function hueTears(cr: Plane, cb: Plane): Plane {
  const { w, h } = cr, mag = each(w, h, (i) => Math.hypot(cr.d[i], cb.d[i]));
  const lvl = boxBlur(mag, 15, 1), turn = plane(w, h);
  for (let y = 0; y < h; y++) {
    const r = Math.min(y, h - 2); // the last row repeats the one above
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (r < 0 || mag.d[i] <= 10) continue;
      const a = (r + 1) * w + x, b = r * w + x; // angle of c[r+1]·conj(c[r])
      const re = cr.d[a] * cr.d[b] + cb.d[a] * cb.d[b], im = cb.d[a] * cr.d[b] - cr.d[a] * cb.d[b];
      turn.d[i] = Math.abs(Math.atan2(im, re));
    }
  }
  const jumps = boxBlur(turn, 15, 1);
  let tears = each(w, h, (i) => clip01((lvl.d[i] - 10) / 18) * clip01(jumps.d[i] / 0.6));
  // A stripe is a few rows tall; its edges carry the jumps, so spread them.
  const reach = Math.max(1, Math.floor(h / 60));
  tears = dilate(tears, 1, 2 * reach + 1);
  return gaussianBlur(tears, 9, 3);
}

/** Per-frame data computed once and shared by every window it appears in. */
export class ChromaFrame {
  readonly ycc: [Plane, Plane, Plane];
  readonly gw: number;
  readonly gh: number;
  readonly luma: Plane;
  readonly cr: Plane;
  readonly cb: Plane;
  readonly small: Plane;
  readonly tears: Plane;
  /** Colour level per row (gh values). */
  readonly colour: Float32Array;
  constructor(frame: Rgba) {
    this.ycc = toYcc(frame);
    const { w, h } = frame;
    [this.gw, this.gh] = grid(w, h);
    const [Y, Cr, Cb] = this.ycc.map((p) => round8(resizeArea(p, this.gw, this.gh)));
    this.luma = gaussianBlur(Y, 3, 3);
    this.cr = each(this.gw, this.gh, (i) => Cr.d[i] - 128);
    this.cb = each(this.gw, this.gh, (i) => Cb.d[i] - 128);
    const f = Math.min(1, FLOW_WIDTH / w);
    this.small = round8(resizeArea(this.ycc[0], Math.max(8, Math.round(w * f)), Math.max(8, Math.round(h * f))));
    this.tears = hueTears(this.cr, this.cb);
    const rows = plane(1, this.gh);
    for (let y = 0; y < this.gh; y++) {
      let s = 0;
      for (let x = 0; x < this.gw; x++) { const i = y * this.gw + x; s += Math.hypot(this.cr.d[i], this.cb.d[i]) * (1 - this.tears.d[i]); }
      rows.d[y] = s / this.gw;
    }
    const smooth = boxBlur(rows, 1, 5);
    this.colour = smooth.d.map((v) => clip01((v - DROPOUT_LEVEL) / DROPOUT_RAMP));
  }
}

/** Luma, chroma, tear score and colour level of `other` on `centre`'s grid. */
function warp(centre: ChromaFrame, other: ChromaFrame): Plane[] {
  const { gw: w, gh: h } = centre;
  const f = denseFlow(centre.small, other.small);
  const fx = resizeLinear(plane(f.w, f.h, f.fx), w, h).d, fy = resizeLinear(plane(f.w, f.h, f.fy), w, h).d;
  const sx = w / centre.small.w, sy = h / centre.small.h, mx = new Float32Array(w * h), my = new Float32Array(w * h);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) { mx[i] = x + fx[i] * sx; my[i] = y + fy[i] * sy; }
  const colour = each(w, h, (i) => other.colour[(i / w) | 0]);
  return remap([other.luma, other.cr, other.cb, other.tears, colour], mx, my, w, h);
}

/**
 * Score 0..1 for horizontal colour bands the brightness does not explain. Real colour edges almost
 * always come with a brightness edge; the top and bottom of a carrier band are colour edges in flat
 * brightness, running across a long stretch of the row.
 */
function unbackedBands(cr: Plane, cb: Plane, luma: Plane): Plane {
  const { w, h } = cr, lone = plane(w, h);
  for (let y = 0; y < h; y++) {
    const r = Math.min(y, h - 2);
    if (r < 0) break;
    for (let x = 0; x < w; x++) {
      const a = (r + 1) * w + x, b = r * w + x;
      const step = Math.hypot(cr.d[a] - cr.d[b], cb.d[a] - cb.d[b]), light = Math.abs(luma.d[a] - luma.d[b]);
      const vivid = Math.max(Math.hypot(cr.d[a], cb.d[a]), Math.hypot(cr.d[b], cb.d[b])) > 10;
      lone.d[y * w + x] = step > 8 && light < 5 && vivid ? 1 : 0;
    }
  }
  const run = boxBlur(lone, 31, 1);
  const edges = each(w, h, (i) => clip01((run.d[i] - 0.3) / 0.3));
  const reach = Math.max(2, Math.floor(h / 30));
  return gaussianBlur(dilate(edges, 1, 2 * reach + 1), 9, 3);
}

/**
 * Chroma predicted from luma by a local linear model fitted on trusted pixels: within a neighbourhood
 * one surface keeps its colour while its brightness varies. Without enough trusted pixels nearby the
 * prediction fades to neutral grey.
 */
function lumaGuided(cr: Plane, cb: Plane, luma: Plane, doubt: Plane): [Plane, Plane] {
  const { w, h } = cr, trust = each(w, h, (i) => 1 - doubt.d[i]);
  const weight = boxBlur(trust, 61, 25);
  const mean = (v: Plane) => {
    const b = boxBlur(each(w, h, (i) => v.d[i] * trust.d[i]), 61, 25);
    return each(w, h, (i) => b.d[i] / Math.max(weight.d[i], 1e-3));
  };
  const light = mean(luma), sq = mean(each(w, h, (i) => luma.d[i] * luma.d[i]));
  const spread = each(w, h, (i) => sq.d[i] - light.d[i] * light.d[i]);
  const coverage = each(w, h, (i) => clip01(weight.d[i] / 0.3));
  return [cr, cb].map((part) => {
    const colour = mean(part), cross = mean(each(w, h, (i) => luma.d[i] * part.d[i]));
    let slope = each(w, h, (i) => (cross.d[i] - light.d[i] * colour.d[i]) / (spread.d[i] + 25));
    let offset = each(w, h, (i) => colour.d[i] - slope.d[i] * light.d[i]);
    slope = boxBlur(slope, 31, 13); offset = boxBlur(offset, 31, 13);
    return each(w, h, (i) => (slope.d[i] * luma.d[i] + offset.d[i]) * coverage.d[i]);
  }) as [Plane, Plane];
}

/** Edge-aware chroma smoothing guided by luma (local linear guided filter). */
function followLuma(cr: Plane, cb: Plane, luma: Plane, amount: number): [Plane, Plane] {
  const { w, h } = cr, box = (v: Plane) => boxBlur(v, 9, 5); // grid is already 4× coarser across, 2× down
  const eps = 20 + 120 * amount;
  const light = box(luma), sq = box(each(w, h, (i) => luma.d[i] * luma.d[i]));
  const spread = each(w, h, (i) => sq.d[i] - light.d[i] * light.d[i]);
  return [cr, cb].map((part) => {
    const colour = box(part), cross = box(each(w, h, (i) => luma.d[i] * part.d[i]));
    const slope = each(w, h, (i) => (cross.d[i] - light.d[i] * colour.d[i]) / (spread.d[i] + eps));
    const offset = each(w, h, (i) => colour.d[i] - slope.d[i] * light.d[i]);
    const bs = box(slope), bo = box(offset);
    return each(w, h, (i) => part.d[i] + (bs.d[i] * luma.d[i] + bo.d[i] - part.d[i]) * 0.6 * amount);
  }) as [Plane, Plane];
}

/**
 * The repaired frame for win[c]. `overlay` marks OSD graphics on the repair grid (0..1); their
 * coloured bars are drawn, not received, and are never treated as hue tears.
 */
export function repairWindow(win: ChromaFrame[], c: number, amount: number, overlay?: Plane): Rgba {
  const present = win[c], { gw: w, gh: h } = present, n = w * h;
  const ov = overlay ?? plane(w, h);
  const row = (f: ChromaFrame, i: number) => f.colour[(i / w) | 0];
  interface Aligned { cr: Plane; cb: Plane; tears: Plane; colour: Plane; fit: Plane }
  const aligned: Aligned[] = [];
  win.forEach((other, k) => {
    if (k === c) return;
    const [luma, cr, cb, tears, colour] = warp(present, other);
    const a: Aligned = { cr: plane(w, h), cb: plane(w, h), tears: plane(w, h), colour: plane(w, h), fit: plane(w, h) };
    for (let i = 0; i < n; i++) {
      const moved = Math.exp(-(((luma.d[i] - present.luma.d[i]) / LUMA_MATCH) ** 2));
      // Static screen content (OSD, a still scene) matches best without motion.
      const stillFit = Math.exp(-(((other.luma.d[i] - present.luma.d[i]) / LUMA_MATCH) ** 2));
      const still = stillFit > moved;
      a.cr.d[i] = still ? other.cr.d[i] : cr.d[i];
      a.cb.d[i] = still ? other.cb.d[i] : cb.d[i];
      a.tears.d[i] = (still ? other.tears.d[i] : tears.d[i]) * (1 - ov.d[i]);
      a.colour.d[i] = still ? row(other, i) : colour.d[i];
      a.fit.d[i] = Math.max(moved, stillFit);
    }
    aligned.push(a);
  });
  // A hue tear is transient. An edge that shows the same jump in the aligned neighbours is part of
  // the picture (or a drawn bar), not a broken carrier.
  const lasting = each(w, h, (i) => (aligned.length ? aligned.reduce((s, a) => s + a.tears.d[i], 0) / aligned.length : 0));
  const ownTears = each(w, h, (i) => present.tears.d[i] * (1 - ov.d[i]) * (1 - lasting.d[i]));
  const sCr = [present.cr, ...aligned.map((a) => a.cr)], sCb = [present.cb, ...aligned.map((a) => a.cb)];
  // A small floor keeps colour available for a dropout frame during fast motion, when no neighbour passes the luma check.
  const weights = [each(w, h, (i) => row(present, i) * (1 - ownTears.d[i])),
    ...aligned.map((a) => each(w, h, (i) => a.colour.d[i] * (1 - a.tears.d[i] * (1 - lasting.d[i])) * (a.fit.d[i] + 0.05)))];
  const K = weights.length, eCr = plane(w, h), eCb = plane(w, h);
  const strength = plane(w, h), goalCr = plane(w, h), goalCb = plane(w, h);
  for (let i = 0; i < n; i++) {
    let sw = 0, sr = 0, sb = 0, others = 0;
    for (let k = 0; k < K; k++) { const wt = weights[k].d[i]; sw += wt; sr += sCr[k].d[i] * wt; sb += sCb[k].d[i] * wt; if (k) others += wt; }
    let er = sr / Math.max(sw, 1e-3), eb = sb / Math.max(sw, 1e-3);
    for (let it = 0; it < 2; it++) {
      let cw = 0, cr = 0, cb = 0;
      for (let k = 0; k < K; k++) {
        const d = Math.hypot(sCr[k].d[i] - er, sCb[k].d[i] - eb) / OUTLIER_SCALE, wt = weights[k].d[i] / (1 + d * d);
        cw += wt; cr += sCr[k].d[i] * wt; cb += sCb[k].d[i] * wt;
      }
      er = cr / Math.max(cw, 1e-3); eb = cb / Math.max(cw, 1e-3);
    }
    eCr.d[i] = er; eCb.d[i] = eb;
    // Without usable neighbours the goal fades to neutral grey: a stripe is never copied into a frame
    // that lacks trustworthy colour.
    const backing = Math.min(others, 1);
    goalCr.d[i] = er * backing; goalCb.d[i] = eb * backing;
    const pr = present.cr.d[i], pb = present.cb.d[i];
    const drained = 1 - row(present, i) * clip01(Math.hypot(pr, pb) / Math.max(0.6 * Math.hypot(er, eb), 1));
    const stray = clip01((Math.hypot(pr - er, pb - eb) - 8) / 12) * backing;
    const calming = (amount / 100) * 0.9 * Math.min(others / 2, 1);
    strength.d[i] = Math.max(drained, stray, ownTears.d[i], calming);
  }
  // Pixel-by-pixel decisions leave blotches; let the repair fade in and out over an area.
  const soft = gaussianBlur(strength, 0, 0, 6);
  let dCr = each(w, h, (i) => (goalCr.d[i] - present.cr.d[i]) * Math.max(strength.d[i], soft.d[i] * 0.9));
  let dCb = each(w, h, (i) => (goalCb.d[i] - present.cb.d[i]) * Math.max(strength.d[i], soft.d[i] * 0.9));
  // Bands that keep reappearing at the same edge survive the temporal step; catch them in the
  // repaired frame by their missing brightness edge.
  const rCr = each(w, h, (i) => present.cr.d[i] + dCr.d[i]), rCb = each(w, h, (i) => present.cb.d[i] + dCb.d[i]);
  const bandsRaw = unbackedBands(rCr, rCb, present.luma);
  const bands = each(w, h, (i) => bandsRaw.d[i] * (1 - ov.d[i]));
  if (max(bands) > 0.05) {
    const [gCr, gCb] = lumaGuided(rCr, rCb, present.luma, bands);
    for (let i = 0; i < n; i++) { dCr.d[i] += (gCr.d[i] - rCr.d[i]) * bands.d[i]; dCb.d[i] += (gCb.d[i] - rCb.d[i]) * bands.d[i]; }
  }
  if (amount) {
    // Colour carries little detail of its own in an analog signal: let it follow the brightness
    // contours, which survive the transmission.
    const [sCr2, sCb2] = followLuma(each(w, h, (i) => present.cr.d[i] + dCr.d[i]), each(w, h, (i) => present.cb.d[i] + dCb.d[i]), present.luma, amount / 100);
    dCr = each(w, h, (i) => sCr2.d[i] - present.cr.d[i]);
    dCb = each(w, h, (i) => sCb2.d[i] - present.cb.d[i]);
  }
  const [Y, Cr, Cb] = present.ycc, W = Y.w, H = Y.h;
  const upR = resizeLinear(dCr, W, H), upB = resizeLinear(dCb, W, H);
  // astype(uint8) after clipping truncates, as in the original.
  const outCr = each(W, H, (i) => Math.floor(Math.min(255, Math.max(0, Cr.d[i] + upR.d[i]))));
  const outCb = each(W, H, (i) => Math.floor(Math.min(255, Math.max(0, Cb.d[i] + upB.d[i]))));
  return fromYcc(Y, outCr, outCb);
}
