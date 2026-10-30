// The DVR clean pass (ports of FPV DVR Cleaner's analog and HDZero repairs) on synthetic footage.
import { describe, expect, it } from 'vitest';
import { repairWindow as repairAnalog, ChromaFrame, WIDE_RADIUS } from '../src/clean/analog.ts';
import { denseFlow } from '../src/clean/flow.ts';
import { windowAt, repairRange, runChain, type Stage } from '../src/clean/frames.ts';
import { fuseWindow, LIFT, LumaFrame } from '../src/clean/fuse.ts';
import { BlockFrame, level, repairWindow as repairBlocks } from '../src/clean/hdzero.ts';
import { boxBlur, dilate, plane, remap, resizeArea, toYcc, fromYcc, type Rgba } from '../src/clean/image.ts';
import { chainRadius, guessKind, pictureBox, repairChain, repairFrames, toCleaned, toOriginal, tuning, type CleanOptions } from '../src/clean/repair.ts';

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

describe('stage chain', () => {
  // Two windowed stages on numbers: a sum over ±2, then a max over ±1. Cut short at the ends.
  const sum: Stage<number> = { radius: 2, run: (f, a, b) => repairRange(f, a, b, 2, (x) => x, (w) => w.reduce((s, x) => s + x, 0)) };
  const max: Stage<number> = { radius: 1, run: (f, a, b) => repairRange(f, a, b, 1, (x) => x, (w) => Math.max(...w)) };
  const stream = Array.from({ length: 40 }, (_, i) => (i * 7919) % 31);

  it('a range with the summed radii as context equals the run over the whole stream', () => {
    const whole = runChain([sum, max], stream, 0, stream.length);
    expect(whole).toEqual(max.run(sum.run(stream, 0, 40), 0, 40));
    for (const [a, b] of [[0, 5], [10, 20], [35, 40], [17, 18]]) {
      const lo = Math.max(0, a - 3), hi = Math.min(40, b + 3);
      expect(runChain([sum, max], stream.slice(lo, hi), a - lo, b - lo)).toEqual(whole.slice(a, b));
    }
    expect(runChain([], stream, 3, 6)).toEqual(stream.slice(3, 6));
  });
  it('chainRadius adds up the active stages', () => {
    const o = (p: Partial<CleanOptions>): CleanOptions => ({ kind: 'analog', amount: 35, denoise: 0, osd: false, damageOnly: false, ...p });
    expect(chainRadius(o({}))).toBe(tuning.adaptiveWindow ? WIDE_RADIUS : 3);
    expect(chainRadius(o({ denoise: 40 }))).toBe((tuning.adaptiveWindow ? WIDE_RADIUS : 3) + 2);
    expect(chainRadius(o({ kind: 'hdzero', amount: 50 }))).toBe(3);
    expect(chainRadius(o({ kind: 'hdzero', amount: 50, denoise: 40 }))).toBe(5);
    expect(chainRadius(o({ amount: 0, denoise: 40 }))).toBe(2);
    expect(chainRadius(o({ amount: 0 }))).toBe(0);
  });
});

describe('fusion (noise reduction)', () => {
  const fuse = (frames: Rgba[], c: number, calm = 0.5) => fuseWindow(frames.map((f) => new LumaFrame(f)), c, { calm, lift: LIFT });
  const lumaErr = (a: Rgba, b: Rgba, inside: (x: number, y: number) => boolean) => {
    const [ya] = toYcc(a), [yb] = toYcc(b);
    let s = 0, n = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inside(x, y)) { s += Math.abs(ya.d[y * W + x] - yb.d[y * W + x]); n++; }
    return s / n;
  };
  const truth = Array.from({ length: 5 }, (_, t) => scene(t));

  it('removes salt-and-pepper specks and a one-frame bright streak', () => {
    seed = 11;
    const frames = truth.map(copy), hit = new Set<number>();
    for (let i = 0; i < W * H; i++) if (rnd() < 0.02) {
      hit.add(i);
      const v = rnd() < 0.5 ? 0 : 255;
      frames[2].d[i * 4] = frames[2].d[i * 4 + 1] = frames[2].d[i * 4 + 2] = v;
    }
    const streak = (x: number, y: number) => y >= 100 && y < 104 && x >= 20 && x < 300;
    for (let y = 100; y < 104; y++) for (let x = 20; x < 300; x++) for (let k = 0; k < 3; k++) frames[2].d[(y * W + x) * 4 + k] += 90;
    const out = fuse(frames, 2), speck = (x: number, y: number) => hit.has(y * W + x) && !streak(x, y);
    expect(lumaErr(out, truth[2], speck)).toBeLessThan(lumaErr(frames[2], truth[2], speck) / 5);
    expect(lumaErr(out, truth[2], streak)).toBeLessThan(lumaErr(frames[2], truth[2], streak) / 5);
  });
  it('keeps a moving sharp edge sharp', () => {
    // A bright half sliding right 3 px per frame over the panning texture.
    const frames = truth.map((f, t) => {
      const g = copy(f);
      for (let y = 0; y < H; y++) for (let x = 0; x < 150 + 3 * t; x++) for (let k = 0; k < 3; k++) g.d[(y * W + x) * 4 + k] += 70;
      return g;
    });
    const step = (f: Rgba) => { // mean luma jump across the edge of frame 2 (between x = 155 and 156)
      const [y] = toYcc(f);
      let s = 0;
      for (let r = 20; r < H - 20; r++) s += y.d[r * W + 154] - y.d[r * W + 157];
      return s / (H - 40);
    };
    expect(step(fuse(frames, 2))).toBeGreaterThan(0.85 * step(frames[2]));
  });
  it('does not ghost an object that leaves the picture', () => {
    // A dark square in frames 0..3 that is gone from frame 4 on.
    const frames = Array.from({ length: 7 }, (_, t) => {
      const g = scene(t);
      if (t <= 3) for (let y = 80; y < 140; y++) for (let x = 120; x < 180; x++) for (let k = 0; k < 3; k++) g.d[(y * W + x) * 4 + k] = 30;
      return g;
    });
    const square = (x: number, y: number) => x >= 124 && x < 176 && y >= 84 && y < 136;
    const keep = 2; // levels of luma change allowed: denoising itself moves pixels a little
    // Window 1..5 around frame 3 (still has the square) and 2..6 around frame 4 (square gone).
    expect(lumaErr(fuse(frames.slice(1, 6), 2), frames[3], square)).toBeLessThan(keep);
    expect(lumaErr(fuse(frames.slice(2, 7), 2), frames[4], square)).toBeLessThan(keep);
  });
});

describe('analog extras: wider window, damage only', () => {
  const chroma = (a: Rgba, b: Rgba, y0: number, y1: number) => {
    const [, ar, ab] = toYcc(a), [, br, bb] = toYcc(b);
    let s = 0;
    for (let i = y0 * W; i < y1 * W; i++) s += Math.abs(ar.d[i] - br.d[i]) + Math.abs(ab.d[i] - bb.d[i]);
    return s / ((y1 - y0) * W);
  };
  const drain = (f: Rgba, y0: number, y1: number) => {
    const [Y, Cr, Cb] = toYcc(f);
    for (let i = y0 * W; i < y1 * W; i++) { Cr.d[i] = 128; Cb.d[i] = 128; }
    return fromYcc(Y, Cr, Cb);
  };

  it('gives colour back to a dropout that lasts longer than the normal window', () => {
    const truth = Array.from({ length: 13 }, (_, t) => scene(t));
    // Rows 60..90 lose their colour in frames 3..9: every frame within ±3 of frame 6 lacks it.
    const frames = truth.map((f, t) => (t >= 3 && t <= 9 ? drain(f, 60, 90) : f));
    const win = frames.map((f) => new ChromaFrame(f)), before = chroma(frames[6], truth[6], 60, 90);
    const narrow = chroma(repairAnalog(win, 6, 35), truth[6], 60, 90);
    const wide = chroma(repairAnalog(win, 6, 35, undefined, { wide: true }), truth[6], 60, 90);
    expect(narrow).toBeGreaterThan(before * 0.7); // the original's fallback: grey
    expect(wide).toBeLessThan(before / 3);
  });
  it('damage only: undamaged frames come back untouched, a dropout is still repaired', () => {
    const truth = Array.from({ length: 9 }, (_, t) => scene(t));
    const frames = truth.map((f, t) => (t === 4 ? drain(f, 60, 90) : f));
    const o: CleanOptions = { kind: 'analog', amount: 35, denoise: 0, osd: false, damageOnly: true };
    const out = repairChain(o, frames, 0, 9);
    for (const t of [0, 1, 2, 3, 5, 6, 7, 8]) expect(out[t]).toBe(frames[t]);
    expect(chroma(out[4], truth[4], 60, 90)).toBeLessThan(chroma(frames[4], truth[4], 60, 90) / 4);
    // HDZero: undamaged frames were already passed through as they are.
    const hd = repairChain({ ...o, kind: 'hdzero', amount: 50 }, truth, 0, 9);
    for (let t = 0; t < 9; t++) expect(hd[t]).toBe(truth[t]);
  });
});
