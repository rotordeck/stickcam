// Breakup repair for HDZero recordings. Port of FPV DVR Cleaner src/flugbild/digital.py
// (https://github.com/Bratwurstexe/FPV_DVR_CLEANER @ 264d232, MIT).
//
// When the digital link drops packets, the decoder paints parts of a frame, or all of it, with blocks
// of random colour ("confetti"). The frames around it are usually intact.
// * Finding: per 16 px block, the energy of fine colour detail (chroma minus its 3×3 blur, at half
//   size). Real pictures have little of it, confetti is made of it. A block counts as broken when its
//   energy is high and clearly lower in the frames on both sides, so colourful things that stay, like
//   the OSD, do not.
// * Repair: the nearest frames before and after that are clean at those blocks are aligned with
//   optical flow measured between the two of them, never in the broken frame, and the in-between
//   picture is blended into the broken blocks with a soft edge. Pure.
import { denseFlow } from './flow.ts';
import {
  boxBlur, channels, dilate, fromChannels, gaussianBlur, median, plane, remap, resizeArea, resizeLinear,
  resizeNearest, round8, toGray, toYcc, type Plane, type Rgba,
} from './image.ts';

export const RADIUS = 3;
const BLOCK = 16;
const FLOW_WIDTH = 320;
/** A frame is repaired only from this many broken blocks on (about 1 % of a 720p picture). */
const MIN_BLOCKS = 30;
/** Fine colour energy of one pixel that makes it a confetti speck. */
const SPECK = 24;
/** Share of broken blocks from which the whole frame is rebuilt. */
const WHOLE_FRAME = 0.35;
/** Frames looked at on each side (more mistakes OSD text that comes and goes for confetti). */
const SPAN = 1;
/** OSD text: brighter than this and with less colour (|Cr| + |Cb| from grey). */
const WHITE_LEVEL = 190, WHITE_COLOUR = 24;

/** Fine-colour energy that marks a broken block; higher amounts find more. */
export const level = (amount: number) => 10 - (6 * amount) / 100;

/** Per-frame data shared by every window the frame appears in. */
export class BlockFrame {
  readonly frame: Rgba;
  readonly energy: Plane;
  readonly specks: Plane;
  private smallCache: Plane | null = null;
  constructor(frame: Rgba) {
    this.frame = frame;
    const { w, h } = frame;
    const hw = Math.max(2, w >> 1), hh = Math.max(2, h >> 1);
    const half = fromChannels(...(channels(frame).map((c) => round8(resizeArea(c, hw, hh))) as [Plane, Plane, Plane]));
    const [, cr, cb] = toYcc(half);
    const br = boxBlur(cr, 3, 3), bb = boxBlur(cb, 3, 3);
    const fine = plane(hw, hh), specks = plane(hw, hh);
    for (let i = 0; i < fine.d.length; i++) {
      fine.d[i] = Math.abs(cr.d[i] - br.d[i]) + Math.abs(cb.d[i] - bb.d[i]);
      specks.d[i] = fine.d[i] > SPECK ? 1 : 0;
    }
    const gw = Math.max(1, Math.floor(w / BLOCK)), gh = Math.max(1, Math.floor(h / BLOCK));
    this.energy = resizeArea(fine, gw, gh);
    // Single confetti specks are too small to lift a block's mean energy; their share of the block shows them.
    this.specks = resizeArea(specks, gw, gh);
  }
  small(): Plane {
    if (!this.smallCache) {
      const { w, h } = this.frame, f = Math.min(1, FLOW_WIDTH / w);
      this.smallCache = round8(resizeArea(toGray(this.frame), Math.max(8, Math.round(w * f)), Math.max(8, Math.round(h * f))));
    }
    return this.smallCache;
  }
}

const reduce = (planes: Plane[], op: (a: number, b: number) => number) => {
  const out = planes[0].d.slice();
  for (const p of planes.slice(1)) for (let i = 0; i < out.length; i++) out[i] = op(out[i], p.d[i]);
  return plane(planes[0].w, planes[0].h, out);
};

/**
 * Per block, the energy and speck share confetti must clearly exceed. Each side counts with its
 * cleanest frame up to SPAN frames away, and confetti must be missing on both sides: OSD text that
 * just appeared stays on screen after this frame, confetti goes away again.
 */
function reference(win: BlockFrame[], c: number): [Plane, Plane] {
  const sides = [win.slice(Math.max(0, c - SPAN), c), win.slice(c + 1, c + 1 + SPAN)].filter((s) => s.length);
  const calm = reduce(sides.map((s) => reduce(s.map((f) => f.energy), Math.min)), Math.max);
  const clear = reduce(sides.map((s) => reduce(s.map((f) => f.specks), Math.min)), Math.max);
  return [calm, clear];
}

/** 0/1 block grid of confetti that is new in win[c]. */
export function brokenBlocks(win: BlockFrame[], c: number, threshold: number): Plane {
  const present = win[c], { w, h } = present.energy, blocks = plane(w, h);
  const around = [c - 1, c + 1].filter((i) => i >= 0 && i < win.length).map((i) => win[i]);
  if (!around.length) return blocks;
  const [calm, clear] = reference(win, c);
  if (median(present.energy) > 2.5 * Math.max(...around.map((f) => median(f.energy))) + 0.5) {
    blocks.d.fill(1); // confetti all over, some of it too grey to stand out block by block
    return blocks;
  }
  let count = 0;
  for (let i = 0; i < blocks.d.length; i++) {
    const e = present.energy.d[i], s = present.specks.d[i];
    const hit = (e > threshold / 2 && e > 4 * calm.d[i] + 1.5) || (s > 0.02 && s > 3 * clear.d[i] + 0.02);
    // The outermost blocks flicker with edge effects of the recording.
    const x = i % w, y = (i / w) | 0, edge = x === 0 || y === 0 || x === w - 1 || y === h - 1;
    blocks.d[i] = hit && !edge ? 1 : 0;
    count += blocks.d[i];
  }
  if (count / blocks.d.length > WHOLE_FRAME) blocks.d.fill(1);
  return blocks;
}

/** Nearest frame in direction `step` that is calm and free of specks at nearly all `blocks`. */
function cleanSide(win: BlockFrame[], c: number, step: number, blocks: Plane, threshold: number, clear: Plane): number | null {
  for (let i = c + step; i >= 0 && i < win.length; i += step) {
    const f = win[i];
    let ok = 0, n = 0;
    for (let k = 0; k < blocks.d.length; k++) {
      if (!blocks.d[k]) continue;
      n++;
      if (f.energy.d[k] <= threshold && f.specks.d[k] <= clear.d[k] + 0.02) ok++;
    }
    if (n && ok / n >= 0.9) return i;
  }
  return null;
}

/** Picture at `share` of the way from `before` to `after` (0..1). */
function between(before: BlockFrame, after: BlockFrame, share: number): Plane[] {
  const first = before.small(), last = after.small(), { w, h } = before.frame;
  const f = denseFlow(first, last);
  const fx = resizeLinear(plane(f.w, f.h, f.fx), w, h).d, fy = resizeLinear(plane(f.w, f.h, f.fy), w, h).d;
  const sx = w / first.w, sy = h / first.h, n = w * h;
  const bx = new Float32Array(n), by = new Float32Array(n), ax = new Float32Array(n), ay = new Float32Array(n);
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    const u = fx[i] * sx, v = fy[i] * sy;
    // Backward warp with the flow at the target pixel, the usual approximation for a short step.
    bx[i] = x - share * u; by[i] = y - share * v;
    ax[i] = x + (1 - share) * u; ay[i] = y + (1 - share) * v;
  }
  const fromBefore = remap(channels(before.frame), bx, by, w, h).map(round8);
  const fromAfter = remap(channels(after.frame), ax, ay, w, h).map(round8);
  return fromBefore.map((p, k) => {
    for (let i = 0; i < n; i++) p.d[i] = Math.round(p.d[i] * (1 - share) + fromAfter[k].d[i] * share);
    return p;
  });
}

/** Bright, colourless pixels and their rim: OSD text. */
function white(frame: Rgba): Plane {
  const [y, cr, cb] = toYcc(frame), m = plane(frame.w, frame.h);
  for (let i = 0; i < m.d.length; i++) m.d[i] = y.d[i] > WHITE_LEVEL && Math.abs(cr.d[i] - 128) + Math.abs(cb.d[i] - 128) < WHITE_COLOUR ? 1 : 0;
  return dilate(m, 3, 3);
}

/** The repaired frame for win[c] (the same object when nothing needed repair). */
export function repairWindow(win: BlockFrame[], c: number, threshold: number): Rgba {
  const present = win[c];
  let blocks = brokenBlocks(win, c, threshold);
  let count = 0;
  for (const v of blocks.d) count += v;
  if (count < MIN_BLOCKS) return present.frame;
  const whole = count === blocks.d.length;
  blocks = dilate(blocks, 3, 3); // confetti often scatters around the blocks that were found
  const [, clear] = reference(win, c);
  const before = cleanSide(win, c, -1, blocks, threshold, clear), after = cleanSide(win, c, 1, blocks, threshold, clear);
  if (before === null && after === null) return present.frame;
  const fill = before === null || after === null
    ? channels(win[(before ?? after)!].frame)
    : between(win[before], win[after], (c - before) / (after - before));
  const { w, h } = present.frame;
  const mask = gaussianBlur(resizeNearest(blocks, w, h), 0, 0, BLOCK / 4);
  if (!whole) {
    // The VTX draws the OSD into the stream, so with a weak link its text can be missing in the frames
    // around; a frame that has it then looks broken there. Confetti is coloured, OSD text is white.
    const keep = white(present.frame);
    for (let i = 0; i < mask.d.length; i++) if (keep.d[i]) mask.d[i] = 0;
  }
  const out = new Uint8ClampedArray(present.frame.d.length), src = present.frame.d;
  for (let i = 0, j = 0; i < mask.d.length; i++, j += 4) {
    const m = mask.d[i];
    for (let k = 0; k < 3; k++) out[j + k] = Math.round(fill[k].d[i] * m + src[j + k] * (1 - m));
    out[j + 3] = 255;
  }
  return { w, h, d: out };
}
