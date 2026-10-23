import { describe, expect, it } from 'vitest';
import { ChunkPlan, cacheKey, cacheName, chunkFor, place, poolSize, type ChunkRange, type Place } from '../src/clean/pool.ts';
import { overlayIndex } from '../src/export/export.ts';

/** Run a whole stream through the plan and check every invariant the worker pool relies on. */
function simulate(places: Place[], size: number, radius: number, endEarly = true) {
  const plan = new ChunkPlan(size, radius);
  const sent = new Map<number, number[]>(); // frame → chunks
  const open = new Set<number>(), gone: ChunkRange[] = [], dropped: ChunkRange[] = [];
  const got = new Map<number, Set<number>>(); // chunk → frames received
  let decoded = 0, stopped = false;
  const apply = (s: ReturnType<ChunkPlan['frame']>) => {
    for (const id of s.open) { expect(open.has(id)).toBe(false); open.add(id); got.set(id, new Set()); }
    for (const { index, chunks } of s.send) {
      expect(sent.has(index)).toBe(false); // each decoded frame is handed out (or closed) exactly once
      expect(index).toBeLessThan(decoded);
      sent.set(index, chunks);
      for (const c of chunks) { expect(open.has(c)).toBe(true); got.get(c)!.add(index); }
    }
    for (const c of [...s.go, ...s.drop]) { expect(open.delete(c.id)).toBe(true); }
    for (const c of s.go) {
      // a chunk goes only with its whole window present
      for (let i = c.lo; i < c.hi; i++) expect(got.get(c.id)!.has(i)).toBe(true);
      expect(got.get(c.id)!.size).toBe(c.hi - c.lo);
      gone.push(c);
    }
    for (const c of s.drop) {
      // a dropped chunk releases exactly the frames it was given
      expect([...got.get(c.id)!].sort((x, y) => x - y)).toEqual(Array.from({ length: c.hi - c.lo }, (_, k) => c.lo + k));
      dropped.push(c);
    }
  };
  for (const p of places) {
    decoded++;
    const s = plan.frame(p);
    apply(s);
    if (s.done && endEarly) { stopped = true; break; }
  }
  apply(plan.end());
  expect(open.size).toBe(0);
  expect(sent.size).toBe(decoded); // nothing leaks
  return { gone, dropped, sent, decoded, stopped };
}

const stream = (before: number, inside: number, after: number): Place[] =>
  [...Array(before).fill('before'), ...Array(inside).fill('in'), ...Array(after).fill('after')];

describe('ChunkPlan', () => {
  it('repairs every frame of the cut exactly once, with radius context on both sides', () => {
    const { gone, decoded, stopped } = simulate(stream(5, 50, 9), 8, 3);
    const a = 5, b = 55;
    const repaired = gone.flatMap((c) => Array.from({ length: c.to - c.from }, (_, k) => c.from + k)).sort((x, y) => x - y);
    expect(repaired).toEqual(Array.from({ length: b - a }, (_, k) => a + k));
    for (const c of gone) {
      expect(c.lo).toBe(Math.max(a - 3, c.from - 3));
      expect(c.hi).toBe(c.to + 3);
    }
    expect(gone.map((c) => c.id)).toEqual(gone.map((_, i) => i)); // in order, no gaps
    expect(stopped).toBe(true);
    expect(decoded).toBe(b + 3); // decoding stops once the trailing context is in
  });

  it('closes pre-cut frames beyond the radius right away', () => {
    const { sent } = simulate(stream(10, 20, 4), 8, 3);
    for (let i = 0; i < 7; i++) expect(sent.get(i)).toEqual([]);
    expect(sent.get(7)!.length).toBeGreaterThan(0);
  });

  it('copes with a cut at the start and end of the video', () => {
    const { gone } = simulate(stream(0, 30, 0), 8, 3);
    expect(gone[0].lo).toBe(0);
    expect(gone.at(-1)!.to).toBe(30);
    expect(gone.at(-1)!.hi).toBe(30);
    expect(gone.reduce((s, c) => s + c.to - c.from, 0)).toBe(30);
  });

  it('drops a chunk whose leading context saw the cut end', () => {
    // 8-frame chunks, radius 3: chunk 1 (from 8) opens at frame 5; the cut ends at frame 6.
    const { gone, dropped } = simulate(stream(0, 6, 10), 8, 3);
    expect(dropped.map((c) => c.id)).toEqual([1]);
    expect(gone).toHaveLength(1);
    expect(gone[0]).toMatchObject({ from: 0, to: 6, hi: 9 });
  });

  it('shares context frames between neighbouring chunks', () => {
    const { sent } = simulate(stream(0, 40, 5), 8, 3);
    expect(sent.get(6)).toEqual([0, 1]); // last context of chunk 1 lies in chunk 0
    expect(sent.get(10)).toEqual([0, 1]);
    expect(sent.get(11)).toEqual([1]);
  });

  it('handles an empty cut and a radius of zero', () => {
    expect(simulate(stream(4, 0, 4), 8, 3).gone).toHaveLength(0);
    const { gone } = simulate(stream(2, 17, 2), 8, 0);
    expect(gone.map((c) => [c.from, c.to])).toEqual([[2, 10], [10, 18], [18, 19]]);
  });

  it('works with a radius as wide as the chunk', () => {
    const { gone } = simulate(stream(3, 40, 20), 4, 6);
    expect(gone.reduce((s, c) => s + c.to - c.from, 0)).toBe(40);
  });
});

describe('pool sizing and frame placement', () => {
  it('uses spare cores for small frames and caps memory for big ones', () => {
    expect(poolSize(24, 640, 480, 24, 3)).toBe(12);
    expect(poolSize(8, 640, 480, 24, 3)).toBe(7);
    expect(poolSize(4, 640, 480, 24, 3)).toBe(3);
    expect(poolSize(24, 1920, 1080, 24, 3)).toBe(3);
    expect(poolSize(1, 640, 480, 24, 3)).toBe(1);
    expect(chunkFor(3)).toBe(24);
    expect(chunkFor(10)).toBe(40);
  });

  it('places frames against the cut with a little tolerance', () => {
    expect(place(0.999_9995, 1, 2)).toBe('in');
    expect(place(0.99, 1, 2)).toBe('before');
    expect(place(1.999, 1, 2)).toBe('in');
    expect(place(1.999_9995, 1, 2)).toBe('after');
  });

  it('maps cut time to the overlay frame like the plain burn-in', () => {
    expect(overlayIndex(0, 30, 100)).toBe(0);
    expect(overlayIndex(0.016, 30, 100)).toBe(0);
    expect(overlayIndex(0.017, 30, 100)).toBe(1);
    expect(overlayIndex(-0.5, 30, 100)).toBe(0);
    expect(overlayIndex(10, 30, 100)).toBe(99);
  });
});

describe('clean cache key', () => {
  const file = { name: 'dvr.mp4', size: 123456, lastModified: 1_700_000_000_000 };
  const opts = { kind: 'analog', amount: 35, denoise: 0, osd: false, damageOnly: false };
  it('is stable regardless of option order', () => {
    const k1 = cacheKey(file, 1, 5, opts);
    const k2 = cacheKey(file, 1, 5, { damageOnly: false, osd: false, denoise: 0, amount: 35, kind: 'analog' });
    expect(k1).toBe(k2);
    expect(cacheName(k1)).toBe(cacheName(k2));
    expect(cacheName(k1)).toMatch(/^[0-9a-f]{16}$/);
  });
  it('changes with the file, the cut and every option', () => {
    const names = new Set([
      cacheKey(file, 1, 5, opts),
      cacheKey({ ...file, lastModified: 1 }, 1, 5, opts),
      cacheKey({ ...file, size: 1 }, 1, 5, opts),
      cacheKey(file, 1.01, 5, opts),
      cacheKey(file, 1, 5.5, opts),
      cacheKey(file, 1, 5, { ...opts, amount: 36 }),
      cacheKey(file, 1, 5, { ...opts, denoise: 10 }),
      cacheKey(file, 1, 5, { ...opts, osd: true }),
      cacheKey(file, 1, 5, { ...opts, damageOnly: true }),
      cacheKey(file, 1, 5, { ...opts, kind: 'auto' }),
    ].map(cacheName));
    expect(names.size).toBe(10);
  });
  it('is 64-bit FNV-1a', () => {
    expect(cacheName('')).toBe('cbf29ce484222325');
    expect(cacheName('a')).toBe('af63dc4c8601ec8c');
  });
});
