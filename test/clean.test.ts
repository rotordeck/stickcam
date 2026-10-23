// The DVR clean pass (ports of FPV DVR Cleaner's analog and HDZero repairs) on synthetic footage.
import { describe, expect, it } from 'vitest';
import { repairWindow as repairAnalog, ChromaFrame } from '../src/clean/analog.ts';
import { denseFlow } from '../src/clean/flow.ts';
import { windowAt, repairRange } from '../src/clean/frames.ts';
import { BlockFrame, level, repairWindow as repairBlocks } from '../src/clean/hdzero.ts';
import { boxBlur, dilate, plane, remap, resizeArea, toYcc, fromYcc, type Rgba } from '../src/clean/image.ts';
import { guessKind, pictureBox, repairFrames, toCleaned, toOriginal } from '../src/clean/repair.ts';

const W = 320, H = 240;
let seed = 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

/** A smooth, colourful scene panning 2 px per frame: little fine colour detail, enough texture for flow. */
function scene(t: number, grey = false): Rgba {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x + 2 * t, j = (y * W + x) * 4;
    const tex = 25 * Math.sin(u / 5) * Math.cos(y / 6) + 15 * Math.sin((u + y) / 3.3);
    const r = 128 + 50 * Math.sin(u / 29) + tex, g = 120 + 40 * Math.sin(y / 23 + u / 41) + tex, b = 128 + 50 * Math.cos(u / 37 - y / 31) + tex;
    const l = (r + g + b) / 3;
    d[j] = grey ? l : r; d[j + 1] = grey ? l : g; d[j + 2] = grey ? l : b; d[j + 3] = 255;
  }
  return { w: W, h: H, d };
}
const copy = (f: Rgba): Rgba => ({ w: f.w, h: f.h, d: f.d.slice() });

/** Mean absolute RGB difference inside a pixel predicate. */
function err(a: Rgba, b: Rgba, inside: (x: number, y: number) => boolean) {
  let s = 0, n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!inside(x, y)) continue;
    const j = (y * W + x) * 4;
    s += Math.abs(a.d[j] - b.d[j]) + Math.abs(a.d[j + 1] - b.d[j + 1]) + Math.abs(a.d[j + 2] - b.d[j + 2]); n += 3;
  }
  return s / n;
}

describe('image ops (OpenCV semantics)', () => {
  it('INTER_AREA averages whole and fractional blocks', () => {
    const p = plane(4, 1, Float32Array.from([1, 3, 5, 7]));
    expect([...resizeArea(p, 2, 1).d]).toEqual([2, 6]);
    const q = resizeArea(plane(3, 1, Float32Array.from([0, 3, 6])), 2, 1);
    expect(q.d[0]).toBeCloseTo(1, 5); // (0·1 + 3·0.5) / 1.5
    expect(q.d[1]).toBeCloseTo(5, 5);
  });
  it('box blur reflects at the border (REFLECT_101), dilate takes the window max', () => {
    const b = boxBlur(plane(3, 1, Float32Array.from([1, 2, 3])), 3, 1);
    expect(b.d[0]).toBeCloseTo(5 / 3, 5);
    expect(b.d[1]).toBeCloseTo(2, 5);
    expect(b.d[2]).toBeCloseTo(7 / 3, 5); // index 3 reflects to 1
    expect([...dilate(plane(5, 1, Float32Array.from([0, 0, 1, 0, 0])), 3, 1).d]).toEqual([0, 1, 1, 1, 0]);
  });
  it('remap with an identity map and YCrCb round trip', () => {
    const p = plane(3, 2, Float32Array.from([1, 2, 3, 4, 5, 6]));
    const mx = Float32Array.from([0, 1, 2, 0, 1, 2]), my = Float32Array.from([0, 0, 0, 1, 1, 1]);
    expect([...remap([p], mx, my, 3, 2)[0].d]).toEqual([1, 2, 3, 4, 5, 6]);
    const f = scene(0), back = fromYcc(...toYcc(f));
    expect(err(f, back, () => true)).toBeLessThan(1);
  });
});

describe('dense flow', () => {
  it('finds a sub-pixel shift of a texture', () => {
    seed = 7;
    const base = plane(W + 40, H + 40);
    for (let i = 0; i < base.d.length; i++) base.d[i] = rnd() * 255;
    const tex = boxBlur(boxBlur(base, 5, 5), 3, 3);
    const at = (dx: number, dy: number) => {
      const mx = new Float32Array(W * H), my = new Float32Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { mx[y * W + x] = x + 20 + dx; my[y * W + x] = y + 20 + dy; }
      return remap([tex], mx, my, W, H)[0];
    };
    const f = denseFlow(at(0, 0), at(3.4, -1.7));
    let e = 0, n = 0;
    for (let y = 16; y < H - 16; y++) for (let x = 16; x < W - 16; x++) { const i = y * W + x; e += Math.hypot(f.fx[i] + 3.4, f.fy[i] - 1.7); n++; }
    expect(e / n).toBeLessThan(0.4);
  });
});

describe('frame windows', () => {
  it('matches pipeline.windows: up to radius on each side, cut short at the ends', () => {
    expect(windowAt(0, 1, 3)).toEqual([0, 0]);
    expect(windowAt(1, 2, 3)).toEqual([0, 1]);
    expect(windowAt(3, 7, 3)).toEqual([0, 6]);
    expect(windowAt(10, 20, 3)).toEqual([7, 13]);
    expect(windowAt(19, 20, 3)).toEqual([16, 19]);
    let prepared = 0;
    const out = repairRange([...Array(20).keys()], 0, 20, 3, (x) => { prepared++; return x; }, (w, c) => w[c]);
    expect(out).toEqual([...Array(20).keys()]);
    expect(prepared).toBe(20); // each frame prepared once
  });
});

describe('HDZero breakup repair', () => {
  const truth = Array.from({ length: 7 }, (_, t) => scene(t));
  /** Random-colour confetti in 16 px tiles of frame 3; returns the tile test. */
  function confetti(share: number) {
    seed = 3;
    const frames = truth.map(copy), hit = new Set<number>();
    for (let by = 1; by < H / 16 - 1; by++) for (let bx = 1; bx < W / 16 - 1; bx++) if (rnd() < share) hit.add(by * 100 + bx);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!hit.has(((y / 16) | 0) * 100 + ((x / 16) | 0))) continue;
      const j = (y * W + x) * 4, c = [rnd() * 255, rnd() * 255, rnd() * 255];
      frames[3].d[j] = c[0]; frames[3].d[j + 1] = c[1]; frames[3].d[j + 2] = c[2];
    }
    return { frames, inside: (x: number, y: number) => hit.has(((y / 16) | 0) * 100 + ((x / 16) | 0)) };
  }
  const run = (frames: Rgba[], c: number) => repairBlocks(frames.map((f) => new BlockFrame(f)), c, level(50));

  it('rebuilds scattered confetti blocks from the frames around', () => {
    const { frames, inside } = confetti(0.15);
    const before = err(frames[3], truth[3], inside), after = err(run(frames, 3), truth[3], inside);
    expect(after).toBeLessThan(before / 5);
  });
  it('rebuilds a frame that is mostly confetti', () => {
    const { frames, inside } = confetti(0.6);
    const before = err(frames[3], truth[3], inside), after = err(run(frames, 3), truth[3], inside);
    expect(after).toBeLessThan(before / 5);
  });
  it('leaves clean frames bit-identical', () => {
    const { frames } = confetti(0.15);
    for (const c of [0, 1, 2, 4, 5, 6]) expect(run(frames, c)).toBe(frames[c]);
  });
  it('keeps white OSD text that appears with the breakup', () => {
    const { frames } = confetti(0.15);
    // White text block appearing in frame 3 and staying, in a clean area.
    // Only the white pixels (and their rim) are protected, as in the original.
    const text = (x: number, y: number) => x >= 200 && x < 260 && y >= 20 && y < 30 && (x >> 2) % 2 === 1;
    for (let t = 3; t < 7; t++) for (let y = 20; y < 30; y++) for (let x = 200; x < 260; x++) {
      if ((x >> 2) % 2) { const j = (y * W + x) * 4; frames[t].d[j] = frames[t].d[j + 1] = frames[t].d[j + 2] = 250; }
    }
    expect(err(run(frames, 3), frames[3], text)).toBe(0);
  });
});

describe('analog colour repair', () => {
  const truth = Array.from({ length: 7 }, (_, t) => scene(t));
  const chromaErr = (a: Rgba, b: Rgba, y0: number, y1: number) => {
    const [, ar, ab] = toYcc(a), [, br, bb] = toYcc(b);
    let s = 0, n = 0;
    for (let i = y0 * W; i < y1 * W; i++) { s += Math.abs(ar.d[i] - br.d[i]) + Math.abs(ab.d[i] - bb.d[i]); n++; }
    return s / n;
  };
  /** Replace the chroma of rows y0..y1 in frame 3 (luma kept). */
  function damage(y0: number, y1: number, chroma: (y: number, x: number) => [number, number]) {
    const frames = truth.map(copy), [Y, Cr, Cb] = toYcc(frames[3]);
    for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) { const [r, b] = chroma(y, x); Cr.d[y * W + x] = 128 + r; Cb.d[y * W + x] = 128 + b; }
    frames[3] = fromYcc(Y, Cr, Cb);
    return frames;
  }
  const run = (frames: Rgba[]) => repairAnalog(frames.map((f) => new ChromaFrame(f)), 3, 35);

  it('gives a colour dropout band its colour back and keeps the luma', () => {
    const frames = damage(60, 90, () => [0, 0]);
    const before = chromaErr(frames[3], truth[3], 60, 90), out = run(frames);
    expect(chromaErr(out, truth[3], 60, 90)).toBeLessThan(before / 4);
    const [y0] = toYcc(frames[3]), [y1] = toYcc(out);
    let worst = 0;
    for (let i = 0; i < y0.d.length; i++) worst = Math.max(worst, Math.abs(y0.d[i] - y1.d[i]));
    expect(worst).toBeLessThanOrEqual(2);
  });
  it('removes rainbow stripes (hue jumping from row to row)', () => {
    // Carrier stripes are a few rows tall; the repair works on a half-height grid, like the original.
    const frames = damage(120, 150, (y) => [40 * Math.cos((y >> 2) * 1.3), 40 * Math.sin((y >> 2) * 1.3)]);
    const before = chromaErr(frames[3], truth[3], 120, 150);
    expect(chromaErr(run(frames), truth[3], 120, 150)).toBeLessThan(before / 4);
  });
  it('leaves a grey scene grey', () => {
    const frames = Array.from({ length: 7 }, (_, t) => scene(t, true));
    const [, cr, cb] = toYcc(run(frames));
    let worst = 0;
    for (let i = 0; i < cr.d.length; i++) worst = Math.max(worst, Math.abs(cr.d[i] - 128), Math.abs(cb.d[i] - 128));
    expect(worst).toBeLessThanOrEqual(1);
  });
});

describe('clean pass glue', () => {
  it('finds the 4:3 picture inside black side bars and guesses the kind', () => {
    const p = plane(W, H);
    for (let y = 0; y < H; y++) for (let x = 40; x < 280; x++) p.d[y * W + x] = 100;
    const box = pictureBox(p);
    expect(box).toEqual({ x: 40, y: 0, w: 240, h: H });
    expect(guessKind(W, H, box)).toBe('analog');
    expect(guessKind(1280, 720, { x: 0, y: 0, w: 1280, h: 720 })).toBe('hdzero');
    expect(guessKind(640, 480, { x: 0, y: 0, w: 640, h: 480 })).toBe('analog');
  });
  it('strength 0 passes frames through', () => {
    const frames = [scene(0), scene(1)];
    expect(repairFrames('analog', 0, frames, 0, 2)).toEqual(frames);
  });
  it('swapping the cleaned cut in and back keeps the log aligned', () => {
    const offset = -88.9, trim: [number, number] = [87.9, 135.6];
    const c = toCleaned(offset, trim);
    expect(c.trim[0]).toBe(0);
    expect(c.trim[1]).toBeCloseTo(47.7, 9);
    // The same log moment: original video time 100 ↔ clip time 100 − 87.9.
    expect(100 + offset).toBeCloseTo(100 - trim[0] + c.offset, 9);
    const back = toOriginal(c.offset, c.trim, trim[0]);
    expect(back.offset).toBeCloseTo(offset, 9);
    expect(back.trim[0]).toBeCloseTo(trim[0], 9);
    expect(back.trim[1]).toBeCloseTo(trim[1], 9);
  });
});
