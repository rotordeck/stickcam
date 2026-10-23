// Glue for the optional "Clean DVR" pass: which repair, the picture box inside black bars, and the
// clock bookkeeping when the cleaned cut replaces the video. Pure (no DOM, no Mediabunny).
import * as analog from './analog.ts';
import { repairRange } from './frames.ts';
import * as hdzero from './hdzero.ts';
import type { Plane, Rgba } from './image.ts';

export type CleanKind = 'analog' | 'hdzero';
export const RADIUS = Math.max(analog.RADIUS, hdzero.RADIUS);
/** Default strength per kind: the desktop app's colour calming (35) and a middle breakup level. */
export const DEFAULT_AMOUNT: Record<CleanKind, number> = { analog: 35, hdzero: 50 };

export interface Box { x: number; y: number; w: number; h: number }

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
