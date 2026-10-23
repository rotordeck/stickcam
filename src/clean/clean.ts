// The "Clean DVR" pass: clean the cut on the worker pool (pool.ts) and write a new H.264 MP4 with the
// source's own frame timestamps (VFR stays VFR, sync stays exact) and its audio packets copied
// untouched. The MP4 streams into the origin-private file system, which doubles as a cache keyed by
// file, cut and options. Also the one-frame before/after check.
import {
  BufferTarget, Mp4OutputFormat, Output, QUALITY_VERY_HIGH, StreamTarget, VideoSample, VideoSampleSink, VideoSampleSource,
  canEncodeVideo, type Target,
} from 'mediabunny';
import type { VideoInfo } from '../video.ts';
import { toGray, type Rgba } from './image.ts';
import { cacheKey, cacheName, cleanFrames, cutAudio, detectBox, logStats, newStats } from './pool.ts';
import { chainRadius, crop, guessKind, paste, pictureBox, repairChain, type Box, type CleanKind, type CleanOptions, type OsdMask } from './repair.ts';

export interface CleanJob {
  video: VideoInfo;
  /** The cut, in video seconds. */
  start: number; end: number;
  kind: CleanKind | 'auto';
  amount: number;
  /** The other CleanOptions; off when left out. */
  denoise?: number; osd?: boolean; damageOnly?: boolean;
  /** OSD mask for the OSD stage. */
  osdMask?: OsdMask;
  signal: AbortSignal;
  onProgress: (done: number, total: number, phase: string) => void;
}
export interface CleanResult { file: File; kind: CleanKind; box: Box; audio: boolean; frames: number; cached: boolean }

const abortCheck = (signal: AbortSignal) => { if (signal.aborted) throw new DOMException('Cancelled', 'AbortError'); };

// ---------- cache (origin-private file system) ----------

const CACHE_DIR = 'stickcam-clean';
interface Meta { key: string; name: string; kind: CleanKind; box: Box; audio: boolean; frames: number; created: number }

async function cacheDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await (await navigator.storage.getDirectory()).getDirectoryHandle(CACHE_DIR, { create: true });
  } catch {
    return null; // no OPFS (older browsers, some private modes): clean into memory instead
  }
}

async function readMeta(dir: FileSystemDirectoryHandle, id: string): Promise<Meta | null> {
  try {
    return JSON.parse(await (await (await dir.getFileHandle(`${id}.json`)).getFile()).text()) as Meta;
  } catch {
    return null;
  }
}

/** Cleaned clips kept from earlier runs. */
export async function listCached(): Promise<{ id: string; name: string; bytes: number; kind: CleanKind; frames: number; created: number }[]> {
  const dir = await cacheDir();
  if (!dir) return [];
  const out = [];
  for await (const [entry, h] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) {
    if (!entry.endsWith('.json') || h.kind !== 'file') continue;
    const id = entry.slice(0, -5), meta = await readMeta(dir, id);
    if (!meta) continue;
    const bytes = await dir.getFileHandle(`${id}.mp4`).then((f) => f.getFile()).then((f) => f.size, () => -1);
    if (bytes >= 0) out.push({ id, name: meta.name, bytes, kind: meta.kind, frames: meta.frames, created: meta.created });
  }
  return out;
}

/** Delete every cached clip. Files handed out earlier can't be read any more afterwards. */
export async function clearCache(): Promise<number> {
  const dir = await cacheDir();
  if (!dir) return 0;
  const names: string[] = [];
  for await (const [entry] of (dir as unknown as AsyncIterable<[string, FileSystemHandle]>)) names.push(entry);
  for (const n of names) await dir.removeEntry(n).catch(() => {});
  return names.filter((n) => n.endsWith('.mp4')).length;
}

// ---------- the clean ----------

export function cleanOptions(job: Pick<CleanJob, 'amount' | 'denoise' | 'osd' | 'damageOnly'>, kind: CleanKind): CleanOptions {
  return { kind, amount: job.amount, denoise: job.denoise ?? 0, osd: job.osd ?? false, damageOnly: job.damageOnly ?? false };
}

export async function cleanCut(job: CleanJob): Promise<CleanResult> {
  const { video: v, signal } = job;
  const W = v.width, H = v.height; // even, see openVideo
  const base = v.file.name.replace(/\.[^.]+$/, '');
  const name = `${base}-clean-${job.start.toFixed(1)}s.mp4`;
  const key = cacheKey(v.file, job.start, job.end, { kind: job.kind, amount: job.amount, denoise: job.denoise ?? 0, osd: job.osd ?? false, damageOnly: job.damageOnly ?? false });
  const id = cacheName(key);
  const dir = await cacheDir();
  if (dir) {
    const meta = await readMeta(dir, id);
    const file = meta?.key === key ? await dir.getFileHandle(`${id}.mp4`).then((h) => h.getFile(), () => null) : null;
    if (meta && file?.size) {
      job.onProgress(meta.frames, meta.frames, 'Cleaned before');
      return { file: new File([file], name, { type: 'video/mp4' }), kind: meta.kind, box: meta.box, audio: meta.audio, frames: meta.frames, cached: true };
    }
  }

  if (!(await canEncodeVideo('avc', { width: W, height: H }))) throw new Error('This browser can\'t encode H.264 video.');
  job.onProgress(0, 1, 'Looking for black bars');
  const box = await detectBox(v, job.start, job.end);
  const kind = job.kind === 'auto' ? guessKind(W, H, box) : job.kind;
  abortCheck(signal);

  // Long clips stream to disk; without OPFS they collect in memory as before.
  let handle: FileSystemFileHandle | null = null, target: Target;
  if (dir) {
    handle = await dir.getFileHandle(`${id}.mp4`, { create: true });
    target = new StreamTarget(await handle.createWritable(), { chunked: true });
  } else target = new BufferTarget();
  // No fast start: the moov goes at the end, as it must when streaming without knowing the length.
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: handle ? false : 'in-memory' }), target });
  const vsrc = new VideoSampleSource({ codec: 'avc', bitrate: QUALITY_VERY_HIGH });
  output.addVideoTrack(vsrc);
  const audio = await cutAudio(output, v, job.start, job.end, signal);
  await output.start();

  const stats = newStats(), t0 = performance.now();
  const phase = `Cleaning (${kind === 'analog' ? 'analog colour' : 'HDZero breakups'})`;
  let written = 0;
  const copying = audio.copy();
  try {
    for await (const f of cleanFrames(v, job.start, job.end, cleanOptions(job, kind), signal, {
      box, osd: job.osdMask, stats, onProgress: (done, total) => job.onProgress(done, total, phase),
    })) {
      const t = performance.now();
      const s = new VideoSample(f.rgba.d, { format: 'RGBA', codedWidth: W, codedHeight: H, timestamp: f.t, duration: f.d });
      await vsrc.add(s);
      s.close();
      stats.encode += performance.now() - t;
      written++;
    }
    vsrc.close();
    await copying;
    const t = performance.now();
    await output.finalize();
    stats.encode += performance.now() - t;
  } catch (e) {
    await output.cancel().catch(() => {});
    await copying.catch(() => {});
    if (dir) await dir.removeEntry(`${id}.mp4`).catch(() => {});
    throw e;
  }
  logStats(`clean ${name}`, stats, performance.now() - t0);
  if (!written) {
    if (dir) await dir.removeEntry(`${id}.mp4`).catch(() => {});
    throw new Error('No frames in this cut.');
  }
  let file: File;
  if (handle && dir) {
    const meta: Meta = { key, name, kind, box, audio: audio.copied, frames: written, created: Date.now() };
    const w = await (await dir.getFileHandle(`${id}.json`, { create: true })).createWritable();
    await w.write(JSON.stringify(meta));
    await w.close();
    file = new File([await handle.getFile()], name, { type: 'video/mp4' });
  } else {
    file = new File([(target as BufferTarget).buffer!], name, { type: 'video/mp4' });
  }
  return { file, kind, box, audio: audio.copied, frames: written, cached: false };
}

/** One frame through the repair, for a before/after check: the frame at `t` (video seconds) and its neighbours. */
export async function previewFrame(v: VideoInfo, t: number, kind: CleanKind | 'auto', amount: number,
  extra: { denoise?: number; osd?: boolean; damageOnly?: boolean; osdMask?: OsdMask } = {}): Promise<{ before: Rgba; after: Rgba; kind: CleanKind }> {
  const sink = new VideoSampleSink(v.track);
  const ctx = new OffscreenCanvas(v.width, v.height).getContext('2d', { willReadFrequently: true })!;
  const kinds: CleanKind[] = kind === 'auto' ? ['analog', 'hdzero'] : [kind];
  const radius = Math.max(...kinds.map((k) => chainRadius(cleanOptions({ amount, ...extra }, k))));
  const at = v.first + t, half = (radius + 0.5) / v.fps;
  const frames: Rgba[] = [], times: number[] = [];
  for await (const s of sink.samples(Math.max(v.first, at - half), at + half)) {
    s.draw(ctx, 0, 0, v.width, v.height);
    frames.push({ w: v.width, h: v.height, d: ctx.getImageData(0, 0, v.width, v.height).data });
    times.push(s.timestamp);
    s.close();
  }
  if (!frames.length) throw new Error('No frame at this time.');
  let c = 0;
  times.forEach((x, i) => { if (Math.abs(x - at) < Math.abs(times[c] - at)) c = i; });
  const box = pictureBox(toGray(frames[c]));
  const k = kind === 'auto' ? guessKind(v.width, v.height, box) : kind;
  // One frame is quick enough for the main thread (~0.1–0.3 s).
  await new Promise((r) => setTimeout(r, 0));
  const o = cleanOptions({ amount, ...extra }, k), r = chainRadius(o);
  const lo = Math.max(0, c - r), hi = Math.min(frames.length, c + r + 1);
  const [inner] = repairChain(o, frames.slice(lo, hi).map((f) => crop(f, box)), c - lo, c - lo + 1, { osd: extra.osdMask });
  return { before: frames[c], after: paste(inner, box, v.width, v.height), kind: k };
}
