// Breakup detection on small synthetic frames: per-frame scores, the neighbour contrast, the Auto guess
// and the mapping onto output frames.
import { describe, expect, it } from 'vitest';
import { BREAK, SCAN_W, SCAN_H, breakups, breaksFor, guessFromScores, scoreFrame, type FrameScore } from '../src/clean/detect.ts';
import type { Rgba } from '../src/clean/image.ts';

const W = SCAN_W, H = SCAN_H;
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

/** A smooth, colourful scene panning 2 px per frame. */
function scene(t: number): Rgba {
  const d = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x + 2 * t, j = (y * W + x) * 4;
    const tex = 12 * Math.sin(u / 5) * Math.cos(y / 6);
    d[j] = 128 + 50 * Math.sin(u / 29) + tex;
    d[j + 1] = 120 + 40 * Math.sin(y / 23 + u / 41) + tex;
    d[j + 2] = 128 + 50 * Math.cos(u / 37 - y / 31) + tex;
    d[j + 3] = 255;
  }
  return { w: W, h: H, d };
}

/** Rows y0..y1 lose their colour (analog dropout). */
function dropout(f: Rgba, y0: number, y1: number): Rgba {
  const d = f.d.slice();
  for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) {
    const j = (y * W + x) * 4, l = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    d[j] = d[j + 1] = d[j + 2] = l;
  }
  return { w: W, h: H, d };
}

/** Rows y0..y1 become saturated stripes whose hue jumps every 2 rows (analog rainbow tear). */
function rainbow(f: Rgba, y0: number, y1: number): Rgba {
  const d = f.d.slice();
  const hues = [[255, 40, 40], [40, 255, 60], [60, 60, 255], [255, 230, 30], [255, 40, 255], [30, 240, 255]];
  for (let y = y0; y < y1; y++) {
    const c = hues[((y >> 1) * 5) % hues.length];
    for (let x = 0; x < W; x++) { const j = (y * W + x) * 4; d[j] = c[0]; d[j + 1] = c[1]; d[j + 2] = c[2]; }
  }
  return { w: W, h: H, d };
}

/** Random colour tiles of 2×2 px over a share of the picture (HDZero confetti, as it looks scaled down). */
function confetti(f: Rgba, share: number): Rgba {
  const d = f.d.slice();
  for (let ty = 0; ty < H; ty += 2) for (let tx = 0; tx < W; tx += 2) {
    if (rnd() > share) continue;
    const c = [rnd() * 255, rnd() * 255, rnd() * 255];
    for (let y = ty; y < ty + 2; y++) for (let x = tx; x < tx + 2; x++) { const j = (y * W + x) * 4; d[j] = c[0]; d[j + 1] = c[1]; d[j + 2] = c[2]; }
  }
  return { w: W, h: H, d };
}

const clip = (n: number, damage: Record<number, (f: Rgba) => Rgba> = {}): FrameScore[] =>
  Array.from({ length: n }, (_, i) => scoreFrame(damage[i] ? damage[i](scene(i)) : scene(i)));

describe('scoreFrame', () => {
  it('scores a clean scene low', () => {
    const s = scoreFrame(scene(0));
    expect(s.dropout).toBeLessThan(0.05);
    expect(s.tears).toBeLessThan(0.05);
    expect(s.confetti).toBeLessThan(0.02);
  });

  it('is cheap on a scan-sized frame', () => {
    const f = scene(3);
    const t0 = performance.now();
    for (let k = 0; k < 50; k++) scoreFrame(f);
    expect((performance.now() - t0) / 50).toBeLessThan(2);
  });

  it('sees dropout rows, rainbow rows and confetti tiles', () => {
    const base = scoreFrame(scene(5));
    expect(scoreFrame(dropout(scene(5), 30, 90)).dropout).toBeGreaterThan(base.dropout + 0.4);
    expect(scoreFrame(rainbow(scene(5), 40, 80)).tears).toBeGreaterThan(base.tears + 0.1);
    expect(scoreFrame(confetti(scene(5), 0.4)).confetti).toBeGreaterThan(base.confetti + 0.3);
  });

  it('a grey picture is all dropout, but that alone is no breakup', () => {
    const grey = Array.from({ length: 20 }, (_, i) => scoreFrame(dropout(scene(i), 0, H)));
    expect(grey[10].dropout).toBeGreaterThan(0.9);
    expect(Math.max(...breakups(grey))).toBeLessThan(BREAK);
  });
});

describe('breakups', () => {
  it('stays quiet on clean footage', () => {
    expect(Math.max(...breakups(clip(30)))).toBeLessThan(BREAK);
  });

  it('flags the damaged frames and not their neighbours', () => {
    const s = breakups(clip(40, { 10: (f) => dropout(f, 20, 100), 20: (f) => rainbow(f, 30, 70), 21: (f) => rainbow(f, 50, 90), 30: (f) => confetti(f, 0.3) }));
    for (const i of [10, 20, 21, 30]) expect(s[i]).toBeGreaterThan(0.6);
    for (const i of [5, 9, 11, 15, 19, 22, 29, 31, 35]) expect(s[i]).toBeLessThan(BREAK);
  });

  it('a lasting scene change is not a breakup', () => {
    // Colour drains from frame 15 on and stays gone (flying into a grey room).
    const sc = clip(40, Object.fromEntries(Array.from({ length: 25 }, (_, k) => [15 + k, (f: Rgba) => dropout(f, 0, 70)])));
    expect(Math.max(...breakups(sc))).toBeLessThan(BREAK);
  });
});

describe('guessFromScores', () => {
  const full = (w: number, h: number) => ({ x: 0, y: 0, w, h });

  it('clean 16:9 footage: HDZero, nothing to fix', () => {
    expect(guessFromScores(clip(40), 1280, 720, full(1280, 720))).toEqual({ kind: 'hdzero', clean: true });
  });

  it('clean 4:3 footage: analog, nothing to fix', () => {
    expect(guessFromScores(clip(40), 640, 480, full(640, 480))).toEqual({ kind: 'analog', clean: true });
  });

  it('analog 4:3 with dropouts', () => {
    const g = guessFromScores(clip(60, { 10: (f) => dropout(f, 0, 80), 25: (f) => dropout(f, 30, 120), 40: (f) => dropout(f, 10, 100) }), 640, 480, full(640, 480));
    expect(g).toEqual({ kind: 'analog', clean: false });
  });

  it('colour dropouts in a 16:9 picture without bars still mean analog', () => {
    const g = guessFromScores(clip(60, { 10: (f) => dropout(f, 0, 80), 25: (f) => dropout(f, 30, 120), 40: (f) => dropout(f, 10, 100) }), 1280, 720, full(1280, 720));
    expect(g.kind).toBe('analog');
  });

  it('16:9 with confetti: HDZero, not clean', () => {
    expect(guessFromScores(clip(40, { 12: (f) => confetti(f, 0.3), 26: (f) => confetti(f, 0.5) }), 1280, 720, full(1280, 720))).toEqual({ kind: 'hdzero', clean: false });
  });

  it('a 4:3 picture inside bars stays analog', () => {
    expect(guessFromScores(clip(30), 1280, 720, { x: 160, y: 0, w: 960, h: 720 }).kind).toBe('analog');
  });
});

describe('breaksFor', () => {
  it('maps scan samples onto output frames: max inside a frame, nearest when none falls inside', () => {
    // 25 fps scan, a breakup at 1.00 s (frame 25).
    const t = Float32Array.from({ length: 75 }, (_, i) => i / 25), s = new Float32Array(75);
    s[25] = 0.9; s[26] = 0.4;
    // 50 fps output starting at 0.5 s: output frame 25 covers 1.00..1.02 s.
    const b50 = breaksFor(t, s, 0.5, 50, 60);
    expect(b50[25]).toBeCloseTo(0.9);
    expect(b50[27]).toBeCloseTo(0.4); // 1.04..1.06 holds the sample at 1.04
    expect(b50[29]).toBe(0); // 1.08..1.10: no sample inside, the nearest one (1.08) is clean
    expect(b50[10]).toBe(0);
    // 10 fps output: frame 10 covers 1.0..1.1 s, the max of samples 25..27.
    const b10 = breaksFor(t, s, 0, 10, 30);
    expect(b10[10]).toBeCloseTo(0.9);
    expect(b10[9]).toBe(0);
    // Beyond the end of the video there is nothing.
    expect(breaksFor(t, s, 10, 25, 5).every((v) => v === 0)).toBe(true);
  });
});
