// Windows of neighbouring frames, as in FPV DVR Cleaner's pipeline.windows (src/flugbild/pipeline.py
// @ 264d232, MIT): frame i sees up to `radius` frames on either side, cut short only at the ends of
// the stream. Every output frame depends on input frames only, so ranges can be repaired anywhere. Pure.

/** [first, last] input indices (inclusive) of the window around frame `i` of `n`. */
export function windowAt(i: number, n: number, radius: number): [number, number] {
  return [Math.max(0, i - radius), Math.min(n - 1, i + radius)];
}

/**
 * Repair frames `from..to-1` of `frames`, preparing each input once.
 * `work(window, centre)` gets the prepared window and the centre's index inside it.
 */
export function repairRange<F, P, R>(frames: F[], from: number, to: number, radius: number,
  prepare: (f: F) => P, work: (window: P[], centre: number) => R): R[] {
  const prepared = new Map<number, P>();
  const get = (i: number) => { let p = prepared.get(i); if (p === undefined) { p = prepare(frames[i]); prepared.set(i, p); } return p; };
  const out: R[] = [];
  for (let i = from; i < to; i++) {
    const [a, b] = windowAt(i, frames.length, radius);
    const win: P[] = [];
    for (let j = a; j <= b; j++) win.push(get(j));
    for (const k of prepared.keys()) if (k < a) prepared.delete(k);
    out.push(work(win, i - a));
  }
  return out;
}
