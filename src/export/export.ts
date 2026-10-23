// Export: render every frame with the same renderer as the preview and encode it.
//   webm   – VP9 with alpha via WebCodecs (Mediabunny muxes the alpha side data into WebM BlockAdditions)
//   mp4    – H.264 on a solid key colour via WebCodecs
//   prores – ProRes 4444 with alpha via ffmpeg.wasm (lazy-loaded, PNG chunks → .mov chunks → concat)
//   burn   – the user's video, cut to the trim range, with the overlay composited in (H.264 + original audio)
import { ALL_FORMATS, BlobSource, BufferTarget, CanvasSource, Conversion, Input, Mp4OutputFormat, Output, QUALITY_HIGH, WebMOutputFormat, canEncodeVideo } from 'mediabunny';
import { createScene, renderFrame, type Scene } from '../render/draw.ts';
import type { CleanOptions } from '../clean/repair.ts';
import type { VideoInfo } from '../video.ts';

export type Format = 'webm' | 'mp4' | 'prores' | 'burn';

export interface ExportJob {
  scene: Scene; // built at scale 1
  format: Format;
  background: string; // mp4 only
  onProgress: (done: number, total: number, phase: string) => void;
  signal: AbortSignal;
  /** burn only: the source video and the cut, in video seconds. `info` is the opened video (needed to clean while burning). */
  video?: { file: File; start: number; end: number; info?: VideoInfo };
  /** burn only: repair the DVR frames while burning (one decode, one encode). */
  clean?: CleanOptions;
}

export interface ExportResult { blob: Blob; ext: string }

export async function capabilities(w: number, h: number, fps: number) {
  const [webm, mp4] = await Promise.all([
    canEncodeVideo('vp9', { width: w, height: h, frameRate: fps, alpha: 'keep' }).catch(() => false),
    canEncodeVideo('avc', { width: w, height: h, frameRate: fps }).catch(() => false),
  ]);
  return { webm, mp4, prores: typeof WebAssembly === 'object' };
}

/** Exact rational frame rate string for ffmpeg (59.94 → 60000/1001). */
const fpsStr = (fps: number) => (Math.abs(fps - 60000 / 1001) < 1e-3 ? '60000/1001' : Math.abs(fps - 30000 / 1001) < 1e-3 ? '30000/1001' : String(fps));

export async function runExport(job: ExportJob): Promise<ExportResult> {
  if (job.format === 'prores') return exportProRes(job);
  if (job.format === 'burn') return exportBurned(job);
  return exportWebCodecs(job);
}

async function exportWebCodecs(job: ExportJob): Promise<ExportResult> {
  const { scene, format, signal } = job;
  const { W, H } = scene.layout;
  const fps = scene.track.fps, total = scene.track.frames;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: true })!;
  const webm = format === 'webm';
  const output = new Output({
    format: webm ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });
  const source = new CanvasSource(canvas, {
    codec: webm ? 'vp9' : 'avc',
    bitrate: QUALITY_HIGH,
    alpha: webm ? 'keep' : 'discard',
    keyFrameInterval: 2,
  });
  output.addVideoTrack(source, { frameRate: fps });
  await output.start();
  try {
    for (let i = 0; i < total; i++) {
      if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
      renderFrame(ctx, scene, i, webm ? null : job.background);
      await source.add(i / fps, 1 / fps);
      if (i % 4 === 0) job.onProgress(i, total, 'Rendering + encoding');
    }
    job.onProgress(total, total, 'Finalizing');
    await output.finalize();
  } catch (e) {
    await output.cancel().catch(() => {});
    throw e;
  }
  const buf = (output.target as BufferTarget).buffer!;
  return { blob: new Blob([buf], { type: webm ? 'video/webm' : 'video/mp4' }), ext: webm ? 'webm' : 'mp4' };
}

// ---------- burned-in: cut video + overlay ----------

async function exportBurned(job: ExportJob): Promise<ExportResult> {
  const { scene, signal } = job;
  const v = job.video!;
  const { W, H } = scene.layout; // the scene is laid out at the video's own size
  const fps = scene.track.fps, total = scene.track.frames;
  const input = new Input({ source: new BlobSource(v.file), formats: ALL_FORMATS });
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const frame = new OffscreenCanvas(W, H), fctx = frame.getContext('2d')!;
  const over = new OffscreenCanvas(W, H), octx = over.getContext('2d')!;
  // Sample timestamps after trimming may be relative to the cut or absolute; detect from the first frame.
  let base: number | null = null;
  const conversion = await Conversion.init({
    input, output,
    trim: { start: v.start, end: v.end },
    video: {
      codec: 'avc', bitrate: QUALITY_HIGH, forceTranscode: true, processedWidth: W, processedHeight: H,
      process: (sample) => {
        if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
        base ??= sample.timestamp > v.start - 0.25 && v.start > 0.5 ? v.start : 0;
        const i = Math.max(0, Math.min(total - 1, Math.round((sample.timestamp - base) * fps)));
        sample.drawWithFit(fctx, { fit: 'fill' });
        renderFrame(octx, scene, i, null);
        fctx.drawImage(over, 0, 0);
        return frame;
      },
    },
    // No forced audio codec: Mediabunny copies the original audio when it can and otherwise picks an encoder
    // this browser has (Linux Chrome, for one, can't encode AAC).
  });
  if (!conversion.isValid) throw new Error(`Can't convert this video: ${conversion.discardedTracks.map((d) => d.reason).join(', ')}`);
  conversion.onProgress = (p) => job.onProgress(Math.round(p * total), total, 'Rendering video + sticks');
  const onAbort = () => void conversion.cancel();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await conversion.execute();
  } catch (e) {
    if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError');
    throw e;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  const buf = (output.target as BufferTarget).buffer!;
  return { blob: new Blob([buf], { type: 'video/mp4' }), ext: 'mp4' };
}

// ---------- ProRes via ffmpeg.wasm ----------

const CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
let ffmpegPromise: Promise<import('@ffmpeg/ffmpeg').FFmpeg> | null = null;

async function loadFFmpeg(onProgress: ExportJob['onProgress']) {
  ffmpegPromise ??= (async () => {
    onProgress(0, 1, 'Loading ProRes encoder (~30 MB, once)');
    const [{ FFmpeg }, { toBlobURL }] = await Promise.all([import('@ffmpeg/ffmpeg'), import('@ffmpeg/util')]);
    const ff = new FFmpeg();
    await ff.load({
      coreURL: await toBlobURL(`${CORE}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${CORE}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    return ff;
  })().catch((e) => { ffmpegPromise = null; throw e; });
  return ffmpegPromise;
}

async function exportProRes(job: ExportJob): Promise<ExportResult> {
  const { scene, signal } = job;
  const ff = await loadFFmpeg(job.onProgress);
  const { W, H } = scene.layout;
  const fps = scene.track.fps, total = scene.track.frames;
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: true })!;
  // Chunks keep ffmpeg's in-memory FS small; ~2 s each.
  const CHUNK = Math.max(30, Math.round(fps * 2));
  const chunks: string[] = [];
  const pad = (n: number) => String(n).padStart(5, '0');
  const abort = () => { if (signal.aborted) throw new DOMException('Export cancelled', 'AbortError'); };
  const onAbort = () => ff.terminate();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (let c0 = 0, ci = 0; c0 < total; c0 += CHUNK, ci++) {
      const n = Math.min(CHUNK, total - c0);
      for (let j = 0; j < n; j++) {
        abort();
        renderFrame(ctx, scene, c0 + j, null);
        const png = await canvas.convertToBlob({ type: 'image/png' });
        await ff.writeFile(`f${pad(j)}.png`, new Uint8Array(await png.arrayBuffer()));
        if (j % 4 === 0) job.onProgress(c0 + j, total, 'Rendering + encoding ProRes');
      }
      const name = `c${pad(ci)}.mov`;
      const code = await ff.exec(['-framerate', fpsStr(fps), '-i', 'f%05d.png', '-c:v', 'prores_ks', '-profile:v', '4444',
        '-pix_fmt', 'yuva444p10le', '-alpha_bits', '8', '-vendor', 'apl0', '-qscale:v', '9', name]);
      if (code !== 0) throw new Error(`ffmpeg failed on chunk ${ci} (exit ${code})`);
      for (let j = 0; j < n; j++) await ff.deleteFile(`f${pad(j)}.png`);
      chunks.push(name);
    }
    abort();
    job.onProgress(total, total, 'Joining');
    await ff.writeFile('list.txt', chunks.map((c) => `file '${c}'`).join('\n'));
    const code = await ff.exec(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'out.mov']);
    if (code !== 0) throw new Error(`ffmpeg concat failed (exit ${code})`);
    const data = await ff.readFile('out.mov');
    for (const c of chunks) await ff.deleteFile(c);
    await ff.deleteFile('list.txt'); await ff.deleteFile('out.mov');
    return { blob: new Blob([data as Uint8Array<ArrayBuffer>], { type: 'video/quicktime' }), ext: 'mov' };
  } catch (e) {
    if (signal.aborted) { ffmpegPromise = null; throw new DOMException('Export cancelled', 'AbortError'); }
    throw e;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

export { createScene };
