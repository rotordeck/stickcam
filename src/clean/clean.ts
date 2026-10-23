// The "Clean DVR" pass: decode the cut, repair every frame on a pool of workers, and write a new
// H.264 MP4 with the source's own frame timestamps (VFR stays VFR, sync stays exact) and its audio
// packets copied untouched. Also the one-frame before/after check.
import {
  BufferTarget, EncodedAudioPacketSource, EncodedPacketSink, Mp4OutputFormat, Output, QUALITY_VERY_HIGH,
  VideoSample, VideoSampleSink, VideoSampleSource, canEncodeVideo,
} from 'mediabunny';
import type { VideoInfo } from '../video.ts';
import { toGray, type Plane, type Rgba } from './image.ts';
import { RADIUS, crop, guessKind, paste, pictureBox, repairFrames, type Box, type CleanKind } from './repair.ts';
import type { CleanReply, CleanTask } from './worker.ts';

/** Frames repaired per worker task; each task also carries RADIUS frames of context on both sides. */
const CHUNK = 24;
const BAR_SAMPLES = 8;

export interface CleanJob {
  video: VideoInfo;
  /** The cut, in video seconds. */
  start: number; end: number;
  kind: CleanKind | 'auto';
  amount: number;
  signal: AbortSignal;
  onProgress: (done: number, total: number, phase: string) => void;
}
export interface CleanResult { file: File; kind: CleanKind; box: Box; audio: boolean; frames: number }

function grabber(w: number, h: number) {
  const cv = new OffscreenCanvas(w, h), ctx = cv.getContext('2d', { willReadFrequently: true })!;
  return (s: VideoSample): Rgba => {
    s.draw(ctx, 0, 0, w, h);
    return { w, h, d: ctx.getImageData(0, 0, w, h).data };
  };
}

const abortCheck = (signal: AbortSignal) => { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); };

/** Brightest luma per pixel over a few frames of the cut → the picture inside any black bars. */
async function findBox(v: VideoInfo, sink: VideoSampleSink, start: number, end: number, w: number, h: number): Promise<Box> {
  const grab = grabber(w, h);
  let bright: Plane | null = null;
  for (let k = 0; k < BAR_SAMPLES; k++) {
    const s = await sink.getSample(v.first + start + ((end - start) * (k + 0.5)) / BAR_SAMPLES);
    if (!s) continue;
    const g = toGray(grab(s));
    s.close();
    if (!bright) bright = g;
    else for (let i = 0; i < g.d.length; i++) bright.d[i] = Math.max(bright.d[i], g.d[i]);
  }
  return bright ? pictureBox(bright) : { x: 0, y: 0, w, h };
}

class Pool {
  private workers: Worker[] = [];
  private next = 0;
  private id = 0;
  private waiting = new Map<number, { ok: (b: ArrayBuffer[]) => void; fail: (e: Error) => void }>();
  constructor(n: number) {
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<CleanReply>) => {
        const p = this.waiting.get(e.data.id);
        this.waiting.delete(e.data.id);
        if ('error' in e.data) p?.fail(new Error(e.data.error)); else p?.ok(e.data.out);
      };
      w.onerror = (e) => { for (const p of this.waiting.values()) p.fail(new Error(e.message || 'Clean worker failed')); this.waiting.clear(); };
      this.workers.push(w);
    }
  }
  get size() { return this.workers.length; }
  run(task: Omit<CleanTask, 'id'>): Promise<ArrayBuffer[]> {
    const id = ++this.id, w = this.workers[this.next++ % this.workers.length];
    return new Promise((ok, fail) => {
      this.waiting.set(id, { ok, fail });
      w.postMessage({ ...task, id }, task.frames);
    });
  }
  close() { this.workers.forEach((w) => w.terminate()); this.workers = []; }
}

export async function cleanCut(job: CleanJob): Promise<CleanResult> {
  const { video: v, signal } = job;
  const W = v.width, H = v.height, fps = v.fps; // even, see openVideo
  if (!(await canEncodeVideo('avc', { width: W, height: H }))) throw new Error('This browser can\'t encode H.264 video.');
  const vsink = new VideoSampleSink(v.track);
  job.onProgress(0, 1, 'Looking for black bars');
  const box = await findBox(v, vsink, job.start, job.end, W, H);
  const kind = job.kind === 'auto' ? guessKind(W, H, box) : job.kind;
  abortCheck(signal);

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const vsrc = new VideoSampleSource({ codec: 'avc', bitrate: QUALITY_VERY_HIGH });
  output.addVideoTrack(vsrc);
  // Audio: copy the packets of the cut as they are (no re-encode, no forced codec).
  const atrack = await v.track.input.getPrimaryAudioTrack();
  const acodec = atrack?.codec;
  const asrc = atrack && acodec && output.format.getSupportedAudioCodecs().includes(acodec) ? new EncodedAudioPacketSource(acodec) : null;
  if (asrc) output.addAudioTrack(asrc);
  await output.start();

  const t0 = v.first + job.start, t1 = v.first + job.end;
  const copyAudio = async () => {
    if (!asrc || !atrack) return;
    const sink = new EncodedPacketSink(atrack), config = await atrack.getDecoderConfig();
    let p = await sink.getPacket(t0), first = true;
    for (; p && p.timestamp < t1 - 1e-6; p = await sink.getNextPacket(p)) {
      abortCheck(signal);
      if (p.timestamp < t0 - 1e-6) continue; // a packet that starts before the cut
      await asrc.add(p.clone({ timestamp: p.timestamp - t0 }), first && config ? { decoderConfig: config } : undefined);
      first = false;
    }
    asrc.close();
  };

  const total = Math.max(1, Math.round((job.end - job.start) * fps));
  const pool = new Pool(Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)));
  const grab = grabber(W, H);
  const frames: (Rgba | undefined)[] = [], stamps: { t: number; d: number }[] = [];
  const pending: { from: number; to: number; out: Promise<ArrayBuffer[]> }[] = [];
  let sent = 0, written = 0;
  const margin = (RADIUS + 1) / fps;

  const dispatch = (to: number) => {
    const lo = Math.max(0, sent - RADIUS), hi = Math.min(frames.length, to + RADIUS);
    const bufs = frames.slice(lo, hi).map((f) => f!.d.slice().buffer as ArrayBuffer);
    pending.push({ from: sent, to, out: pool.run({ kind, amount: job.amount, box, w: W, h: H, frames: bufs, from: sent - lo, to: to - lo }) });
    sent = to;
    for (let i = 0; i < sent - RADIUS; i++) frames[i] = undefined; // no later chunk needs these
  };
  const drain = async (keep: number) => {
    while (pending.length > keep) {
      const { from, out } = pending.shift()!;
      const bufs = await out;
      for (let k = 0; k < bufs.length; k++) {
        const { t, d } = stamps[from + k];
        if (t < t0 - 1e-6 || t >= t1 - 1e-6) continue; // context frames around the cut
        const s = new VideoSample(new Uint8Array(bufs[k]), { format: 'RGBA', codedWidth: W, codedHeight: H, timestamp: t - t0, duration: d });
        await vsrc.add(s);
        s.close();
        written++;
      }
      job.onProgress(Math.min(written, total), total, `Cleaning (${kind === 'analog' ? 'analog colour' : 'HDZero breakups'})`);
    }
  };

  const audio = copyAudio();
  try {
    for await (const s of vsink.samples(Math.max(v.first, t0 - margin), t1 + margin)) {
      abortCheck(signal);
      frames.push(grab(s));
      stamps.push({ t: s.timestamp, d: s.duration || 1 / fps });
      s.close();
      if (frames.length - sent >= CHUNK + RADIUS) dispatch(sent + CHUNK);
      await drain(pool.size * 2);
    }
    if (sent < frames.length) dispatch(frames.length);
    await drain(0);
    vsrc.close();
    await audio;
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => {});
    throw e;
  } finally {
    pool.close();
  }
  if (!written) throw new Error('No frames in this cut.');
  const buf = (output.target as BufferTarget).buffer!;
  const base = v.file.name.replace(/\.[^.]+$/, '');
  const name = `${base}-clean-${job.start.toFixed(1)}s.mp4`;
  return { file: new File([buf], name, { type: 'video/mp4' }), kind, box, audio: !!asrc, frames: written };
}

/** One frame through the repair, for a before/after check: the frame at `t` (video seconds) and its neighbours. */
export async function previewFrame(v: VideoInfo, t: number, kind: CleanKind | 'auto', amount: number): Promise<{ before: Rgba; after: Rgba; kind: CleanKind }> {
  const sink = new VideoSampleSink(v.track), grab = grabber(v.width, v.height);
  const at = v.first + t, half = (RADIUS + 0.5) / v.fps;
  const frames: Rgba[] = [], times: number[] = [];
  for await (const s of sink.samples(Math.max(v.first, at - half), at + half)) {
    frames.push(grab(s)); times.push(s.timestamp); s.close();
  }
  if (!frames.length) throw new Error('No frame at this time.');
  let c = 0;
  times.forEach((x, i) => { if (Math.abs(x - at) < Math.abs(times[c] - at)) c = i; });
  const box = pictureBox(toGray(frames[c]));
  const k = kind === 'auto' ? guessKind(v.width, v.height, box) : kind;
  // One frame is quick enough for the main thread (~0.1–0.3 s).
  await new Promise((r) => setTimeout(r, 0));
  const [inner] = repairFrames(k, amount, frames.map((f) => crop(f, box)), c, c + 1);
  return { before: frames[c], after: paste(inner, box, v.width, v.height), kind: k };
}
