// Glue for the optional "Clean DVR" pass: which repair, the picture box inside black bars, and the
// clock bookkeeping when the cleaned cut replaces the video. Pure (no DOM, no Mediabunny).
import * as analog from './analog.ts';
import { repairRange, runChain, type Stage } from './frames.ts';
import * as fuse from './fuse.ts';
import * as hdzero from './hdzero.ts';
import * as osd from './osd.ts';
import { resizeArea, type Plane, type Rgba } from './image.ts';

export type CleanKind = 'analog' | 'hdzero';
export const RADIUS = Math.max(analog.RADIUS, hdzero.RADIUS);
/** Default strength per kind: the desktop app's colour calming (35) and a middle breakup level. */
export const DEFAULT_AMOUNT: Record<CleanKind, number> = { analog: 35, hdzero: 50 };

export interface Box { x: number; y: number; w: number; h: number }

/** Everything the clean pass can do to a cut. */
export interface CleanOptions {
  kind: CleanKind;
  /** Colour calming (analog) or breakup detection (HDZero), 0..100. */
  amount: number;
  /** Multi-frame noise reduction (fusion), 0..100; 0 = off. */
  denoise: number;
  /** Remove the goggle OSD. */
  osd: boolean;
  /** Repair damaged frames only and leave undamaged ones bit-identical (with no calming). */
  damageOnly: boolean;
}

/** OSD overlay of a cut: 0/255 mask and the guide of steady edge orientations (refined by the OSD port). */
export interface OsdMask { mask: Plane; guide: Plane }

/** What the OSD stage needs besides the frames: the cut's mask, and the stream history before the frames it gets. */
export interface OsdContext {
  osd?: OsdMask;
  /** From an `OsdTrack` fed with every earlier frame, at the index `osdInputStart` names. */
  osdState?: osd.OsdState;
}

/** Switches for measuring against the original; `adaptiveWindow` is our deviation in analog.ts (WIDE_RADIUS). */
export const tuning = { adaptiveWindow: true };

const analogRadius = () => (tuning.adaptiveWindow ? analog.WIDE_RADIUS : analog.RADIUS);

/** The stages of `o` in upstream order (restoration.py `_stages`): colour or breakups → OSD → fusion. */
function stages(o: CleanOptions, osdMask?: OsdMask, osdState?: osd.OsdState): Stage<Rgba>[] {
  const out: Stage<Rgba>[] = [];
  if (o.amount > 0 && o.kind === 'analog') {
    const opts = { wide: tuning.adaptiveWindow, damageOnly: o.damageOnly };
    let overlay: Plane | undefined; // the OSD mask on the repair grid, as upstream hands it to the colour stage
    out.push({
      radius: analogRadius(),
      run: (frames, from, to) => repairRange(frames, from, to, analogRadius(), (f) => new analog.ChromaFrame(f), (w, c) => {
        if (osdMask && !overlay) {
          const p = resizeArea(osdMask.mask, w[c].gw, w[c].gh);
          for (let i = 0; i < p.d.length; i++) p.d[i] /= 255;
          overlay = p;
        }
        return analog.repairWindow(w, c, o.amount, overlay, opts);
      }),
    });
  }
  if (o.amount > 0 && o.kind === 'hdzero') {
    // Undamaged frames come back as the same object, before any flow, with or without damageOnly.
    const threshold = hdzero.level(o.amount);
    out.push({ radius: hdzero.RADIUS, run: (frames, from, to) => repairRange(frames, from, to, hdzero.RADIUS, (f) => new hdzero.BlockFrame(f), (w, c) => hdzero.repairWindow(w, c, threshold)) });
  }
  if (o.osd && osdMask) {
    // A range stage, not a window one: whether an element is on screen depends on frames up to
    // osd.HOLD back, which come in as `osdState`.
    out.push({ radius: osd.RADIUS, run: (frames, from, to) => osd.removeRange(frames, from, to, osdMask, osdState) });
  }
  if (o.denoise > 0) {
    const fusion = { calm: o.denoise / 100, lift: fuse.LIFT };
    out.push({ radius: fuse.RADIUS, run: (frames, from, to) => repairRange(frames, from, to, fuse.RADIUS, (f) => new fuse.LumaFrame(f), (w, c) => fuse.fuseWindow(w, c, fusion)) });
  }
  return out;
}

/** Context frames needed on each side of a range for every stage of `o` together. */
export function chainRadius(o: CleanOptions): number {
  const r = (o.amount > 0 ? (o.kind === 'analog' ? analogRadius() : hdzero.RADIUS) : 0)
    + (o.osd ? osd.RADIUS : 0) + (o.denoise > 0 ? fuse.RADIUS : 0);
  return r;
}

/**
 * Run the stages of `o` on frames `from..to-1` (upstream order: colour or breakups → OSD → fusion);
 * the other frames are context, and with `chainRadius(o)` of them on each side the result matches a
 * run over the whole stream. Same size in, same size out. Frames no stage touched may come back as
 * the same objects.
 */
export function repairChain(o: CleanOptions, frames: Rgba[], from: number, to: number, ctx: OsdContext = {}): Rgba[] {
  return runChain(stages(o, ctx.osd, ctx.osdState), frames, from, to);
}

/** Repair frames `from..to-1` of `frames` (all the same size); neighbours outside the range are context only. */
export function repairFrames(kind: CleanKind, amount: number, frames: Rgba[], from: number, to: number): Rgba[] {
  if (amount <= 0) return frames.slice(from, to);
  if (kind === 'analog') return repairRange(frames, from, to, analog.RADIUS, (f) => new analog.ChromaFrame(f), (w, c) => analog.repairWindow(w, c, amount));
  const threshold = hdzero.level(amount);
  return repairRange(frames, from, to, hdzero.RADIUS, (f) => new hdzero.BlockFrame(f), (w, c) => hdzero.repairWindow(w, c, threshold));
}

// ---------- black bars ----------

const BAR_LEVEL = 24;

/**
 * The picture inside black side or top bars, from the per-pixel brightest luma over a few frames.
 * Goggles record a 4:3 picture in a 16:9 file; the bars need no repair. A side counts as bars only
 * when it adds up to at least 5 % of the frame. Port of FPV DVR Cleaner restoration.picture_box.
 */
export function pictureBox(brightest: Plane): Box {
  const { w, h } = brightest;
  const p90 = (vals: number[]) => { vals.sort((a, b) => a - b); const r = 0.9 * (vals.length - 1), i = Math.floor(r); return vals[i] + (vals[Math.min(i + 1, vals.length - 1)] - vals[i]) * (r - i); };
  const cols = Array.from({ length: w }, (_, x) => p90(Array.from({ length: h }, (_, y) => brightest.d[y * w + x])));
  const rows = Array.from({ length: h }, (_, y) => p90(Array.from(brightest.d.subarray(y * w, (y + 1) * w))));
  const span = (profile: number[], size: number): [number, number] => {
    const lit = profile.flatMap((v, i) => (v > BAR_LEVEL ? [i] : []));
    if (!lit.length) return [0, size];
    let first = lit[0], last = lit[lit.length - 1] + 1;
    if (first + size - last < size * 0.05) return [0, size];
    // Even edges keep the 4:2:0 chroma of the output aligned.
    first -= first % 2; last = Math.min(size, last + (last % 2));
    return [first, last - first];
  };
  const [x, iw] = span(cols, w), [y, ih] = span(rows, h);
  return { x, y, w: iw, h: ih };
}

export function crop(f: Rgba, b: Box): Rgba {
  if (b.x === 0 && b.y === 0 && b.w === f.w && b.h === f.h) return f;
  const d = new Uint8ClampedArray(b.w * b.h * 4);
  for (let y = 0; y < b.h; y++) d.set(f.d.subarray(((b.y + y) * f.w + b.x) * 4, ((b.y + y) * f.w + b.x + b.w) * 4), y * b.w * 4);
  return { w: b.w, h: b.h, d };
}

/** The repaired picture back in a full frame, with the bars as clean black. */
export function paste(inner: Rgba, b: Box, w: number, h: number): Rgba {
  if (inner.w === w && inner.h === h) return inner;
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 3; i < d.length; i += 4) d[i] = 255;
  for (let y = 0; y < b.h; y++) d.set(inner.d.subarray(y * b.w * 4, (y + 1) * b.w * 4), ((b.y + y) * w + b.x) * 4);
  return { w, h, d };
}

/**
 * Which repair fits: a 4:3 picture (on its own or inside bars) is analog; a full 16:9 picture
 * without bars is HDZero (and other digital systems, whose breakups look the same).
 */
export function guessKind(w: number, h: number, box: Box): CleanKind {
  if (box.w < w * 0.95 || box.h < h * 0.95) return 'analog';
  return w / h < 1.5 ? 'analog' : 'hdzero';
}

// ---------- the clock ----------

/**
 * Swapping the cleaned cut in: the cut starts at `trimStart` of the original, so the same log time
 * sits `trimStart` earlier in the clip (log time = video time + offset).
 */
export function toCleaned(offset: number, trim: [number, number]): { offset: number; trim: [number, number] } {
  return { offset: offset + trim[0], trim: [0, trim[1] - trim[0]] };
}

/** And back: `shift` is the cut start the clean was made with. */
export function toOriginal(offset: number, trim: [number, number], shift: number): { offset: number; trim: [number, number] } {
  return { offset: offset - shift, trim: [trim[0] + shift, trim[1] + shift] };
}

/**
 * Index into a chain's input of the first frame the OSD stage receives: runChain hands it the colour or
 * breakup stage's output, which starts where that stage's widened range starts (or the input itself
 * when that stage is off). The caller's `OsdTrack.state` must be taken at this frame.
 */
export function osdInputStart(o: CleanOptions, from: number): number {
  return o.amount > 0 ? Math.max(0, from - osd.RADIUS - (o.denoise > 0 ? fuse.RADIUS : 0)) : 0;
}
