// OSD detection and removal (port of FPV DVR Cleaner's osd.py) on synthetic panning footage.
import { describe, expect, it } from 'vitest';
import { boxBlur, plane, type Rgba } from '../src/clean/image.ts';
import { HOLD, OsdTrack, RADIUS, findOsd, preview, removeRange } from '../src/clean/osd.ts';

const W = 320, H = 240;

const SX = 3, SY = 10, TW = W + 32 * SX, TH = H + 32 * SY;
let seed = 5;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
/** Smooth random texture (blurred noise, a coarse and a fine layer), one plane per channel. */
const TEX = [0, 1, 2].map(() => {
  const noise = (k: number) => boxBlur(boxBlur(plane(TW, TH, Float32Array.from({ length: TW * TH }, rnd)), k, k), k, k);
  const coarse = noise(15), fine = noise(7);
  return coarse.d.map((v, i) => 128 + (v - 0.5) * 900 + (fine.d[i] - 0.5) * 300);
});

/**
 * A textured scene panning (3, 10) px per frame. Upstream refills a region only from a neighbour
 * (±RADIUS frames) whose aligned content lies off the overlay, so the pan must clear the short side
 * of an element within a few frames; a non-periodic texture keeps the flow honest.
 */
function scene(t: number): Rgba {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const s = (y + SY * t) * TW + x + SX * t, j = (y * W + x) * 4;
    d[j] = TEX[0][s]; d[j + 1] = TEX[1][s]; d[j + 2] = TEX[2][s]; d[j + 3] = 255;
  }
  return { w: W, h: H, d };
}

// 5×7 glyphs, enough for the test strings.
const FONT: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'], B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'], L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'], R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'], V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'], Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'], X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'], 2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'], '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

/** Paint white text with a dark outline (as goggle OSDs draw it); returns its box [x0, y0, x1, y1). */
function text(f: Rgba, s: string, x0: number, y0: number, scale = 2): number[] {
  const ink = new Set<number>();
  [...s].forEach((ch, k) => FONT[ch].forEach((row, r) => [...row].forEach((b, c) => {
    if (b !== '1') return;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) ink.add((y0 + r * scale + dy) * W + x0 + (k * 6 + c) * scale + dx);
  })));
  const put = (p: number, v: number) => { f.d[p * 4] = f.d[p * 4 + 1] = f.d[p * 4 + 2] = v; };
  for (const p of ink) for (const q of [p - 1, p + 1, p - W, p + W]) if (!ink.has(q)) put(q, 20);
  for (const p of ink) put(p, 245);
  return [x0 - 1, y0 - 1, x0 + s.length * 6 * scale + 1, y0 + 7 * scale + 1];
}

/** A battery-style bar: dark outline, coloured fill. */
function bar(f: Rgba, x0: number, y0: number, w: number, h: number): number[] {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const j = (y * W + x) * 4, edge = x < x0 + 2 || x >= x0 + w - 2 || y < y0 + 2 || y >= y0 + h - 2;
    f.d[j] = edge ? 240 : 40; f.d[j + 1] = edge ? 240 : 210; f.d[j + 2] = edge ? 240 : 60;
  }
  return [x0, y0, x0 + w, y0 + h];
}

const inBox = (b: number[], x: number, y: number, m = 0) => x >= b[0] - m && x < b[2] + m && y >= b[1] - m && y < b[3] + m;
const copy = (f: Rgba): Rgba => ({ w: f.w, h: f.h, d: f.d.slice() });

function iou(mask: Float32Array, boxes: number[][]) {
  let both = 0, either = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const a = mask[y * W + x] > 0, b = boxes.some((bx) => inBox(bx, x, y, 4));
    if (a && b) both++;
    if (a || b) either++;
  }
  return both / Math.max(either, 1);
}

/** Mean abs RGB difference over the pixels of `boxes`. */
function err(a: Rgba, b: Rgba, boxes: number[][]) {
  let s = 0, n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!boxes.some((bx) => inBox(bx, x, y))) continue;
    const j = (y * W + x) * 4;
    for (let c = 0; c < 3; c++) s += Math.abs(a.d[j + c] - b.d[j + c]);
    n += 3;
  }
  return s / Math.max(n, 1);
}


/** Frames with `draw` applied where `on(t)`; the truth stays untouched. */
const clip = (n: number, on: (t: number) => boolean, draw: (f: Rgba) => number[][]) => {
  const truth = Array.from({ length: n }, (_, t) => scene(t));
  let boxes: number[][] = [];
  const frames = truth.map((f, t) => { const g = copy(f); if (on(t)) boxes = draw(g); return g; });
  return { truth, frames, boxes };
};
const changed = (a: Rgba, b: Rgba) => a.d.some((v, i) => v !== b.d[i]);

describe('permanent OSD', () => {
  const { truth, frames, boxes } = clip(24, () => true, (g) => [text(g, '12.4V', 20, 196), text(g, 'TX 1', 230, 16), bar(g, 120, 206, 60, 12)]);
  const osd = findOsd(frames.filter((_, k) => k % 2 === 0)); // 12 probes spread over the cut

  it('finds static text and a bar (filled to their outline), and nothing in the moving scene', () => {
    expect(iou(osd.mask.d, boxes)).toBeGreaterThan(0.8);
    let guided = 0;
    for (let i = 0; i < osd.guide.d.length; i++) if (osd.guide.d[i] > 0) { guided++; expect(osd.mask.d[i]).toBe(255); expect(osd.guide.d[i]).toBeLessThanOrEqual(180); }
    expect(guided).toBeGreaterThan(100);
  });
  it('refills it from the neighbours, close to the true background', () => {
    const out = removeRange(frames, 8, 12, osd);
    out.forEach((f, k) => {
      const t = 8 + k, before = err(frames[t], truth[t], boxes), after = err(f, truth[t], boxes);
      expect(after).toBeLessThan(before / 4);
      expect(after).toBeLessThan(15); // upstream ≈ 10 on this clip; the gap is the flow (see osd.ts)
      // Far from the overlay the frame is untouched.
      expect(err(f, frames[t], [[0, 40, W, 180]])).toBe(0);
    });
  });
  it('inpaints when there are no neighbours, and preview marks the mask', () => {
    const [out] = removeRange([frames[3]], 0, 1, osd);
    expect(err(out, truth[3], boxes)).toBeLessThan(err(frames[3], truth[3], boxes) / 3);
    const p = preview(frames[3], osd), j = ((boxes[2][1] + 6) * W + boxes[2][0] + 20) * 4;
    expect([p.d[j], p.d[j + 1], p.d[j + 2]]).not.toEqual([frames[3].d[j], frames[3].d[j + 1], frames[3].d[j + 2]]);
  });
});

describe('brief and late overlays', () => {
  it('finds a brief warning row in the sliding window while the scene moves', () => {
    // Shown in frames 10..17 only; the probes miss it, so the clip mask is empty.
    const { truth, frames, boxes } = clip(28, (t) => t >= 10 && t < 18, (g) => [text(g, 'LOW BATTERY', 120, 110, 1)]);
    const osd = findOsd(frames.filter((_, k) => k < 10 || k >= 18));
    expect(osd.mask.d.some((v) => v > 0)).toBe(false);
    const out = removeRange(frames, 0, 28, osd);
    for (let t = 10; t < 18; t++) expect(err(out[t], truth[t], boxes)).toBeLessThan(err(frames[t], truth[t], boxes) / 4);
    // Far from it in time nothing happens (the window reaches RADIUS frames to either side).
    for (let t = 0; t < 10 - RADIUS; t++) expect(changed(out[t], frames[t])).toBe(false);
    for (let t = 18 + RADIUS; t < 28; t++) expect(changed(out[t], frames[t])).toBe(false);
  });

  it('removes a stats screen only from the frames that show it (and RADIUS before)', () => {
    const { truth, frames, boxes } = clip(30, (t) => t >= 20, (g) => [text(g, 'MAX ALT', 40, 60), text(g, 'MAX TX', 40, 100), text(g, 'BATTERY', 40, 140), bar(g, 200, 60, 70, 14)]);
    const osd = findOsd(frames.filter((_, k) => k % 2 === 1)); // 15 probes, 5 of them on the stats screen
    expect(iou(osd.mask.d, boxes)).toBeGreaterThan(0.7);
    const out = removeRange(frames, 0, 30, osd);
    for (let t = 0; t < 20 - RADIUS; t++) expect(changed(out[t], frames[t])).toBe(false);
    for (let t = 20; t < 30; t++) expect(err(out[t], truth[t], boxes)).toBeLessThan(err(frames[t], truth[t], boxes) / 4);
  });

  it('keeps an element removed for HOLD frames after it was last seen, across ranges via OsdTrack', () => {
    const { frames, boxes } = clip(16, (t) => t < 6, (g) => [text(g, 'MAX ALT', 40, 60)]);
    const osd = findOsd(frames.slice(0, 8));
    const track = new OsdTrack(osd);
    frames.forEach((f) => track.add(f));
    const state = track.state(10);
    expect(Math.max(...state.lastSeen!)).toBe(5 - 10);
    // Frames 10..15 no longer show it, but it was seen 5..10 frames ago: still painted out (blinking warnings don't flicker).
    const out = removeRange(frames.slice(10), 0, 6, osd, state);
    out.forEach((f, k) => expect(err(f, frames[10 + k], boxes)).toBeGreaterThan(0));
    // Without the history (or HOLD frames later) the same frames stay untouched.
    expect(removeRange(frames.slice(10), 0, 6, osd).every((f, k) => !changed(f, frames[10 + k]))).toBe(true);
    const old = { lastSeen: state.lastSeen!.map((v) => v - HOLD), picture: state.picture };
    expect(removeRange(frames.slice(10), 0, 6, osd, old).every((f, k) => !changed(f, frames[10 + k]))).toBe(true);
  });
});

describe('a static scene', () => {
  // Without motion every edge holds still, so coherence can't tell scene from overlay. Upstream drops
  // long straight runs (frame borders), shapes spanning the picture and big shapes, but a small sharp
  // object that never moves is taken for OSD: the pass is meant for flown footage.
  const f = scene(0), win = [40, 40, 280, 200], box = [150, 100, 170, 120];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const j = (y * W + x) * 4;
    if (inBox(win, x, y) && !inBox(win, x, y, -3)) f.d[j] = f.d[j + 1] = f.d[j + 2] = 250;
    if (inBox(box, x, y)) f.d[j] = f.d[j + 1] = f.d[j + 2] = 15;
  }
  const osd = findOsd(Array.from({ length: 10 }, () => f));
  const masked = (b: number[]) => { let n = 0; for (let y = b[1]; y < b[3]; y++) for (let x = b[0]; x < b[2]; x++) if (osd.mask.d[y * W + x]) n++; return n; };

  it('leaves the smooth texture and a big rectangular frame alone', () => {
    expect(masked([0, 0, W, 90])).toBe(0);
    expect(masked([0, 130, W, H])).toBe(0);
  });
  it('but takes a small sharp still object for an overlay, as upstream does', () => {
    expect(masked(box)).toBeGreaterThan(300);
  });
});

describe('in the clean chain', () => {
  it('chunked with tracker state equals one pass over the whole stream', async () => {
    const { chainRadius, osdInputStart, repairChain } = await import('../src/clean/repair.ts');
    // A warning that blinks on for a few frames, so the hold-over history matters across chunks.
    const frames = clip(36, (t) => t % 12 < 4, (f) => [text(f, 'LOW BAT', 40, 30), bar(f, 20, 200, 120, 8)]).frames;
    const osd = findOsd(frames);
    const o = { kind: 'analog' as const, amount: 35, denoise: 30, osd: true, damageOnly: false };
    const whole = repairChain(o, frames, 0, frames.length, { osd });
    const R = chainRadius(o), track = new OsdTrack(osd);
    frames.forEach((f) => track.add(f));
    const parts: Rgba[] = [];
    for (let from = 0; from < frames.length; from += 9) {
      const to = Math.min(frames.length, from + 9), lo = Math.max(0, from - R), hi = Math.min(frames.length, to + R);
      const osdState = track.state(lo + osdInputStart(o, from - lo));
      parts.push(...repairChain(o, frames.slice(lo, hi), from - lo, to - lo, { osd, osdState }));
    }
    expect(parts.length).toBe(whole.length);
    parts.forEach((p, i) => expect(changed(p, whole[i]), `frame ${i}`).toBe(false));
  }, 120_000);
});
