// Web Worker: repairs chunks of frames. Decoded VideoFrames arrive one by one (transferred; a context
// frame shared with a chunk on another worker comes as a clone), are read back to RGBA here, off the
// main thread, and closed at once so the decoder never waits on them. A chunk carries chainRadius
// context frames on either side, so chunks are independent of each other.
import type { Rgba } from './image.ts';
import type { OsdState } from './osd.ts';
import { paste, repairChain, type Box, type CleanOptions, type OsdMask } from './repair.ts';

export type ToWorker =
  | { type: 'setup'; opts: CleanOptions; box: Box; w: number; h: number; osd?: OsdMask }
  /** Frame `index` of the decode, needed by `refs` chunks on this worker. */
  | { type: 'frame'; index: number; refs: number; frame: VideoFrame }
  /** All frames lo..hi-1 are here: repair from..to-1. */
  | { type: 'go'; chunk: number; lo: number; from: number; to: number; hi: number; osdState?: OsdState }
  /** A chunk that ended up with nothing to repair: just let go of its frames. */
  | { type: 'drop'; lo: number; hi: number };
export type FromWorker =
  | { type: 'done'; chunk: number; out: ArrayBuffer[]; read: number; repair: number; sent: number }
  | { type: 'error'; error: string };

const scope = self as unknown as Worker;
const now = () => performance.timeOrigin + performance.now();
let setup: Extract<ToWorker, { type: 'setup' }> | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;
const frames = new Map<number, { f: Rgba; refs: number }>();
let read = 0; // ms of readback since the last reply

const release = (lo: number, hi: number) => {
  for (let i = lo; i < hi; i++) {
    const e = frames.get(i);
    if (e && --e.refs <= 0) frames.delete(i);
  }
};

function repairChunk(m: Extract<ToWorker, { type: 'go' }>) {
  try {
    const t = performance.now(), { opts, box, w, h, osd } = setup!;
    const win: Rgba[] = [];
    for (let i = m.lo; i < m.hi; i++) {
      const f = frames.get(i);
      if (!f) throw new Error(`Clean worker: frame ${i} missing`);
      win.push(f.f);
    }
    const res = repairChain(opts, win, m.from - m.lo, m.to - m.lo, { osd, osdState: m.osdState }).map((f) => paste(f, box, w, h).d.buffer as ArrayBuffer);
    release(m.lo, m.hi);
    // A stage may hand an input back untouched (strength 0, damage-only): copy buffers that another
    // chunk here still reads, or that appear twice, instead of transferring them away.
    const kept = new Set<ArrayBufferLike>([...frames.values()].map((x) => x.f.d.buffer));
    const out = res.map((b) => (kept.has(b) ? b.slice(0) : (kept.add(b), b)));
    const repair = performance.now() - t;
    scope.postMessage({ type: 'done', chunk: m.chunk, out, read, repair, sent: now() } satisfies FromWorker, out);
    read = 0;
  } catch (err) {
    scope.postMessage({ type: 'error', error: (err as Error).message } satisfies FromWorker);
  }
}

scope.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  try {
    if (m.type === 'setup') {
      setup = m;
      ctx = new OffscreenCanvas(m.w, m.h).getContext('2d', { willReadFrequently: true })!;
    } else if (m.type === 'frame') {
      const t = performance.now(), { box, w, h } = setup!;
      try {
        // Same scaling as VideoSample.draw: the visible picture stretched to the display size.
        ctx!.drawImage(m.frame, 0, 0, w, h);
      } finally {
        m.frame.close();
      }
      // Read only the picture inside any black bars.
      const d = ctx!.getImageData(box.x, box.y, box.w, box.h).data;
      frames.set(m.index, { f: { w: box.w, h: box.h, d }, refs: m.refs });
      read += performance.now() - t;
    } else if (m.type === 'go') {
      // Let this thread run its pending tasks first: Chrome releases the decoder buffers behind drawn
      // VideoFrames there, and a worker busy repairing for seconds would starve the decoder (measured:
      // 3–4 s decode stalls per chunk without this).
      setTimeout(() => repairChunk(m), 0);
    } else {
      release(m.lo, m.hi);
    }
  } catch (err) {
    scope.postMessage({ type: 'error', error: (err as Error).message } satisfies FromWorker);
  }
};
