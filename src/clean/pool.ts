// Cleaned frames of a cut, in order: decode on the main thread, hand each VideoFrame to the worker
// that repairs its chunk (readback happens there), and give the repaired frames back in decode order
// with their source timestamps. Shared by "Clean DVR" (clean.ts) and clean-while-burning (export.ts).
// The chunk bookkeeping (ChunkPlan), pool sizing and cache key are pure and unit-tested.
import { EncodedAudioPacketSource, EncodedPacketSink, VideoSampleSink, type Output, type VideoSample } from 'mediabunny';
import type { VideoInfo } from '../video.ts';
import { toGray, type Plane, type Rgba } from './image.ts';
import { OsdTrack, PROBES, cropOsd, findOsd } from './osd.ts';
import { chainRadius, osdInputStart, pictureBox, type Box, type CleanOptions, type OsdMask } from './repair.ts';
import type { FromWorker, ToWorker } from './worker.ts';

/** Frames repaired per chunk (at least 4 × the radius, so context stays a small share of the work). */
export const CHUNK = 24;
const BAR_SAMPLES = 8;
/** Rough cap on the frame memory of all workers together. */
const MEMORY = 2.5e9;
/**
 * The repair is memory-bound: on 24 cores (640×480 analog) per-frame cost went 180 → 220 → 310 → 510 ms
 * with 6 / 10 / 14 / 22 workers, so wall time bottoms out around 10–14 and gets worse beyond.
 */
const MAX_WORKERS = 12;

// ---------- pure: chunk bookkeeping ----------

export interface ChunkRange { id: number; lo: number; from: number; to: number; hi: number }
export interface PlanStep {
  /** Decoded frames to hand out now, each to the chunks that need it; none = close it. */
  send: { index: number; chunks: number[] }[];
  /** Chunks that start receiving frames with this step. */
  open: number[];
  /** Chunks that have all their frames: repair `from..to-1` with `lo..hi-1` as the window. */
  go: ChunkRange[];
  /** Chunks left with nothing to repair (the cut ended inside their leading context); `lo..hi-1` is what they got. */
  drop: ChunkRange[];
  /** Every frame the cut needs has been seen: stop decoding. */
  done: boolean;
}
export type Place = 'before' | 'in' | 'after';

/** Where a decoded frame at `t` sits relative to the cut [t0, t1). */
export const place = (t: number, t0: number, t1: number): Place => (t < t0 - 1e-6 ? 'before' : t < t1 - 1e-6 ? 'in' : 'after');

/**
 * Which decoded frame goes to which chunk, while decoding (the frame count isn't known up front).
 * Frames are numbered in decode order. The cut is frames a..b-1; chunk c repairs a + c·size onwards and
 * sees `radius` more frames on either side, as far as they exist. Frames before the cut are held back
 * (the last `radius` of them) until the cut starts.
 */
export class ChunkPlan {
  readonly size: number;
  readonly radius: number;
  private n = 0;
  private a = -1;
  private b = -1;
  private lo0 = 0;
  private held: number[] = [];
  private chunks = new Map<number, ChunkRange>();
  private next = 0;
  private finished = false;
  constructor(size: number, radius: number) { this.size = size; this.radius = radius; }

  /** The next decoded frame. */
  frame(where: Place): PlanStep {
    const step: PlanStep = { send: [], open: [], go: [], drop: [], done: false };
    const j = this.n++;
    if (this.finished) { step.send.push({ index: j, chunks: [] }); step.done = true; return step; }
    if (this.a < 0) {
      if (where === 'before') {
        this.held.push(j);
        if (this.held.length > this.radius) step.send.push({ index: this.held.shift()!, chunks: [] });
        return step;
      }
      if (where === 'after') { // nothing inside the cut
        for (const k of [...this.held, j]) step.send.push({ index: k, chunks: [] });
        this.held = [];
        this.finished = step.done = true;
        return step;
      }
      this.a = j;
      this.lo0 = this.held.length ? this.held[0] : j;
      for (const k of this.held) this.route(k, step);
      this.held = [];
    } else if (where === 'after' && this.b < 0) {
      this.b = j;
      for (const c of this.chunks.values()) {
        // Nothing to repair: it got context frames lo..j-1 only, and lets go of exactly those.
        if (c.from >= j) { this.chunks.delete(c.id); c.to = c.from; c.hi = j; step.drop.push(c); continue; }
        c.to = Math.min(c.to, j);
        c.hi = c.to + this.radius;
      }
    }
    this.route(j, step);
    if (this.b >= 0 && this.n >= this.b + this.radius) this.finish(step);
    return step;
  }

  /** No more frames. */
  end(): PlanStep {
    const step: PlanStep = { send: [], open: [], go: [], drop: [], done: true };
    if (this.finished) return step;
    for (const k of this.held) step.send.push({ index: k, chunks: [] });
    this.held = [];
    this.finish(step);
    return step;
  }

  private route(j: number, step: PlanStep) {
    const { size, radius: r } = this;
    for (;;) {
      const from = this.a + this.next * size;
      if (from - r > j || (this.b >= 0 && from >= this.b)) break;
      const to = this.b >= 0 ? Math.min(from + size, this.b) : from + size;
      const c: ChunkRange = { id: this.next++, lo: Math.max(this.lo0, from - r), from, to, hi: to + r };
      this.chunks.set(c.id, c);
      step.open.push(c.id);
    }
    const need: number[] = [];
    for (const c of this.chunks.values()) if (c.lo <= j && j < c.hi) need.push(c.id);
    step.send.push({ index: j, chunks: need });
    for (const c of this.chunks.values()) if (c.hi <= j + 1) { this.chunks.delete(c.id); step.go.push(c); }
  }

  private finish(step: PlanStep) {
    for (const c of this.chunks.values()) {
      c.to = Math.min(c.to, this.n);
      c.hi = Math.min(c.hi, this.n);
      (c.to > c.from ? step.go : step.drop).push(c);
    }
    this.chunks.clear();
    this.finished = step.done = true;
  }
}

/**
 * Workers for a w×h video: one per spare core, but no more than the frame memory allows
 * (each holds a chunk plus context as RGBA, and the repair makes a few working copies).
 */
export function poolSize(cores: number, w: number, h: number, chunk: number, radius: number): number {
  const perWorker = (chunk + 2 * radius) * w * h * 4 * 3;
  return Math.max(1, Math.min(cores - 1, MAX_WORKERS, Math.floor(MEMORY / perWorker)));
}

/** Chunk size for a radius: CHUNK, or more when a stage needs a wide window. */
export const chunkFor = (radius: number) => Math.max(CHUNK, 4 * radius);

// ---------- pure: cache key ----------

/** Same file, same cut, same options → same cleaned clip. */
export function cacheKey(file: { name: string; size: number; lastModified: number }, start: number, end: number, opts: object): string {
  const o = opts as Record<string, unknown>;
  const sorted = Object.keys(o).sort().map((k) => [k, o[k]]);
  return `${file.name}|${file.size}|${file.lastModified}|${start}|${end}|${JSON.stringify(sorted)}`;
}

/** 64-bit FNV-1a of the key as 16 hex digits: the cache file name (without extension). */
export function cacheName(key: string): string {
  let h = 0xcbf29ce484222325n;
  const bytes = new TextEncoder().encode(key);
  for (const b of bytes) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n);
  return h.toString(16).padStart(16, '0');
}

// ---------- browser: frames ----------

export interface CleanFrame {
  /** Full frame (bars included), same size as the video. */
  rgba: Rgba;
  /** Seconds from the cut start (source timestamp − cut start: VFR stays VFR). */
  t: number;
  /** Duration in seconds. */
  d: number;
}

/** Milliseconds per phase, filled while cleaning. Worker phases are summed over all workers. */
export interface CleanStats {
  decode: number; post: number; wait: number; read: number; repair: number; transfer: number; encode: number;
  frames: number; workers: number;
}
export const newStats = (): CleanStats => ({ decode: 0, post: 0, wait: 0, read: 0, repair: 0, transfer: 0, encode: 0, frames: 0, workers: 0 });

export function logStats(what: string, s: CleanStats, ms: number) {
  if (!import.meta.env.DEV) return;
  const f = (x: number) => `${(x / 1000).toFixed(1)} s`;
  console.info(`[clean] ${what}: ${s.frames} frames in ${f(ms)} (${(s.frames / (ms / 1000)).toFixed(1)} fps), ${s.workers} workers · main: decode ${f(s.decode)}, post ${f(s.post)}, waiting on workers ${f(s.wait)}, encode ${f(s.encode)} · workers (sum): readback ${f(s.read)}, repair ${f(s.repair)}, transfer back ${f(s.transfer)}`);
}

const abortCheck = (signal?: AbortSignal) => { if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError'); };

/** Brightest luma per pixel over a few frames of the cut → the picture inside any black bars. */
export async function detectBox(v: VideoInfo, start: number, end: number): Promise<Box> {
  const w = v.width, h = v.height, sink = new VideoSampleSink(v.track);
  const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })!;
  let bright: Plane | null = null;
  for (let k = 0; k < BAR_SAMPLES; k++) {
    const s = await sink.getSample(v.first + start + ((end - start) * (k + 0.5)) / BAR_SAMPLES);
    if (!s) continue;
    s.draw(ctx, 0, 0, w, h);
    s.close();
    const g = toGray({ w, h, d: ctx.getImageData(0, 0, w, h).data });
    if (!bright) bright = g;
    else for (let i = 0; i < g.d.length; i++) bright.d[i] = Math.max(bright.d[i], g.d[i]);
  }
  return bright ? pictureBox(bright) : { x: 0, y: 0, w, h };
}

/**
 * The OSD of the cut, as upstream finds it (restoration.clip_mask): PROBES frames spread evenly over
 * the cut, the mask found on the full frame, then cropped to the picture inside any black bars.
 */
export async function detectOsd(v: VideoInfo, start: number, end: number, box: Box, signal?: AbortSignal): Promise<OsdMask> {
  const w = v.width, h = v.height, sink = new VideoSampleSink(v.track);
  const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true })!;
  const probes: Rgba[] = [];
  for (let k = 0; k < PROBES; k++) {
    abortCheck(signal);
    const s = await sink.getSample(v.first + start + ((end - start) * k) / PROBES);
    if (!s) continue;
    s.draw(ctx, 0, 0, w, h);
    s.close();
    probes.push({ w, h, d: ctx.getImageData(0, 0, w, h).data });
  }
  return cropOsd(findOsd(probes), box);
}

interface Lane { worker: Worker; open: Set<number>; repairing: Set<number> }

export interface CleanFramesExtra {
  /** The picture inside black bars (found with detectBox when left out). */
  box?: Box;
  /** OSD mask of the cut, for the OSD stage. */
  osd?: OsdMask;
  onProgress?: (done: number, total: number) => void;
  stats?: CleanStats;
  /** Worker count (default: poolSize). */
  workers?: number;
}

/**
 * The cut [start, end) (video seconds) cleaned with `opts`, frame by frame in order.
 * Memory stays bounded: decoding pauses while every worker is busy, and decoded frames are only held
 * by the main thread while waiting for the cut start (at most the radius).
 */
export async function* cleanFrames(v: VideoInfo, start: number, end: number, opts: CleanOptions, signal: AbortSignal,
  extra: CleanFramesExtra = {}): AsyncGenerator<CleanFrame, void, undefined> {
  const W = v.width, H = v.height, fps = v.fps;
  const stats = extra.stats ?? newStats();
  const box = extra.box ?? await detectBox(v, start, end);
  abortCheck(signal);
  const osdMask = opts.osd ? extra.osd ?? await detectOsd(v, start, end, box, signal) : undefined;
  // The OSD stage needs the stream history before each chunk (who was on screen up to osd.HOLD frames
  // back), so every decoded frame also goes through a tracker here, in order. Costs a readback on this
  // thread, only with OSD removal on.
  const track = osdMask ? new OsdTrack(osdMask) : null;
  const tctx = track ? new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true })! : null;
  const R = chainRadius(opts), size = chunkFor(R);
  const n = extra.workers ?? poolSize(navigator.hardwareConcurrency || 4, box.w, box.h, size, R);
  stats.workers = n;
  const t0 = v.first + start, t1 = v.first + end;
  const total = Math.max(1, Math.round((end - start) * fps));

  // ---- workers ----
  let failed: Error | null = null;
  let wake: (() => void)[] = [];
  const poke = () => { const w = wake; wake = []; w.forEach((f) => f()); };
  const ready = new Map<number, ArrayBuffer[]>();
  const owner = new Map<number, Lane>();
  const lanes: Lane[] = [];
  for (let k = 0; k < n; k++) {
    const lane: Lane = { worker: new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }), open: new Set(), repairing: new Set() };
    lane.worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      if (m.type === 'error') failed ??= new Error(m.error);
      else {
        stats.read += m.read; stats.repair += m.repair;
        stats.transfer += Math.max(0, performance.timeOrigin + performance.now() - m.sent);
        ready.set(m.chunk, m.out);
        lane.open.delete(m.chunk); lane.repairing.delete(m.chunk);
      }
      poke();
    };
    lane.worker.onerror = (e) => { failed ??= new Error(e.message || 'Clean worker failed'); poke(); };
    lane.worker.postMessage({ type: 'setup', opts, box, w: W, h: H, osd: osdMask } satisfies ToWorker);
    lanes.push(lane);
  }
  signal.addEventListener('abort', poke, { once: true });
  const waitAny = async () => {
    if (failed) throw failed;
    abortCheck(signal);
    const t = performance.now();
    await new Promise<void>((r) => wake.push(r));
    stats.wait += performance.now() - t;
    if (failed) throw failed;
    abortCheck(signal);
  };
  /** A new chunk goes to an idle worker; wait for one when all are busy repairing. */
  const assign = async (id: number) => {
    for (;;) {
      const idle = lanes.find((l) => l.open.size === 0);
      if (idle) { idle.open.add(id); owner.set(id, idle); return; }
      // Only when no worker is repairing (a radius as wide as the chunk) does waiting not help.
      if (!lanes.some((l) => l.repairing.size)) {
        const l = lanes.reduce((a, b) => (b.open.size < a.open.size ? b : a));
        l.open.add(id); owner.set(id, l); return;
      }
      await waitAny();
    }
  };

  // ---- decode and hand out ----
  const plan = new ChunkPlan(size, R);
  const held = new Map<number, VideoFrame>();
  const stamps: { t: number; d: number }[] = [];
  const order: ChunkRange[] = []; // go'd and not yet yielded, by id
  const dropped = new Set<number>();
  let nextOut = 0, yielded = 0, decoded = 0;

  const apply = async (step: PlanStep) => {
    for (const id of step.open) await assign(id);
    for (const { index, chunks } of step.send) {
      const f = held.get(index)!;
      held.delete(index);
      const targets = [...new Set(chunks.map((c) => owner.get(c)!))];
      let mine = true; // f is ours to close until the last target takes it
      try {
        for (let k = 0; k < targets.length; k++) {
          const lane = targets[k];
          // Never queue frames behind a repair: they'd sit there unread and unclosed for seconds, and
          // the decoder only has a few buffers.
          while (lane.repairing.size) await waitAny();
          const refs = chunks.filter((c) => owner.get(c) === lane).length;
          const t = performance.now();
          const frame = k === targets.length - 1 ? f : f.clone();
          if (frame === f) mine = false;
          lane.worker.postMessage({ type: 'frame', index, refs, frame } satisfies ToWorker, [frame]);
          stats.post += performance.now() - t;
        }
      } finally {
        if (mine) f.close();
      }
    }
    for (const c of step.drop) {
      dropped.add(c.id);
      const lane = owner.get(c.id)!;
      lane.open.delete(c.id);
      lane.worker.postMessage({ type: 'drop', lo: c.lo, hi: c.hi } satisfies ToWorker);
      poke();
    }
    for (const c of step.go) {
      const lane = owner.get(c.id)!;
      lane.repairing.add(c.id);
      const osdState = track?.state(c.lo + osdInputStart(opts, c.from - c.lo));
      lane.worker.postMessage({ type: 'go', chunk: c.id, lo: c.lo, from: c.from, to: c.to, hi: c.hi, osdState } satisfies ToWorker);
      order.push(c);
    }
    order.sort((x, y) => x.id - y.id);
  };

  /** Repaired frames that can go out in order now. */
  function* flush(): Generator<CleanFrame> {
    for (;;) {
      while (dropped.has(nextOut)) nextOut++;
      const out = ready.get(nextOut);
      if (!out) return;
      const c = order.find((x) => x.id === nextOut)!;
      ready.delete(nextOut);
      order.splice(order.indexOf(c), 1);
      nextOut++;
      for (let k = 0; k < out.length; k++) {
        const s = stamps[c.from + k];
        yielded++;
        yield { rgba: { w: W, h: H, d: new Uint8ClampedArray(out[k]) }, t: s.t - t0, d: s.d };
      }
      stats.frames = yielded;
      extra.onProgress?.(Math.min(yielded, total), total);
    }
  }

  const margin = (R + 1) / fps;
  const samples = new VideoSampleSink(v.track).samples(Math.max(v.first, t0 - margin), t1 + margin);
  try {
    for (;;) {
      abortCheck(signal);
      if (failed) throw failed;
      let t = performance.now();
      const r = await samples.next();
      stats.decode += performance.now() - t;
      if (r.done) break;
      const s: VideoSample = r.value;
      t = performance.now();
      const j = decoded++; // ChunkPlan numbers frames the same way
      stamps[j] = { t: s.timestamp, d: s.duration || 1 / fps };
      if (track) {
        s.draw(tctx!, 0, 0, W, H);
        track.add({ w: box.w, h: box.h, d: tctx!.getImageData(box.x, box.y, box.w, box.h).data });
      }
      held.set(j, s.toVideoFrame());
      s.close();
      const step = plan.frame(place(s.timestamp, t0, t1));
      stats.post += performance.now() - t;
      await apply(step);
      yield* flush();
      if (step.done) break;
    }
    await apply(plan.end());
    while (order.length) {
      yield* flush();
      if (order.length) await waitAny();
    }
    yield* flush();
  } finally {
    await samples.return(undefined).catch(() => {});
    for (const f of held.values()) f.close();
    signal.removeEventListener('abort', poke);
    lanes.forEach((l) => l.worker.terminate());
  }
}

// ---------- browser: audio of a cut ----------

/**
 * Copy the audio packets of the cut into `output` as they are (no re-encode, no forced codec), timed
 * from the cut start; packets that start before the cut are dropped. Call before output.start(), then
 * run `copy()` alongside the video. `copied` is false when there is no audio or MP4 can't hold it.
 */
export async function cutAudio(output: Output, v: VideoInfo, start: number, end: number, signal: AbortSignal) {
  const atrack = await v.track.input.getPrimaryAudioTrack();
  const acodec = atrack?.codec;
  const asrc = atrack && acodec && output.format.getSupportedAudioCodecs().includes(acodec) ? new EncodedAudioPacketSource(acodec) : null;
  if (asrc) output.addAudioTrack(asrc);
  const t0 = v.first + start, t1 = v.first + end;
  const copy = async () => {
    if (!asrc || !atrack) return;
    const sink = new EncodedPacketSink(atrack), config = await atrack.getDecoderConfig();
    let p = await sink.getPacket(t0), first = true;
    for (; p && p.timestamp < t1 - 1e-6; p = await sink.getNextPacket(p)) {
      abortCheck(signal);
      if (p.timestamp < t0 - 1e-6) continue;
      await asrc.add(p.clone({ timestamp: p.timestamp - t0 }), first && config ? { decoderConfig: config } : undefined);
      first = false;
    }
    asrc.close();
  };
  return { copied: !!asrc, copy };
}
