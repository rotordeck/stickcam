// The user's FPV video: metadata for the export, and the passes over its frames: the motion pass that
// feeds auto-sync and the damage scan that finds breakups. Both read small canvases, so one decode
// serves them together.
import { ALL_FORMATS, BlobSource, Input, VideoSampleSink, type InputVideoTrack, type VideoSample } from 'mediabunny';
import { FLOW_H, FLOW_W, FlowEstimator, type FlowSample } from './sync.ts';
import { SCAN_H, SCAN_W, breakups, scoreFrame, type Damage, type FrameScore } from './clean/detect.ts';
import { pictureBox } from './clean/repair.ts';
import { plane } from './clean/image.ts';

export interface VideoInfo {
  file: File;
  url: string;
  /** Display size, rounded down to even. */
  width: number; height: number;
  /** Frame rate snapped to a standard rate when close (VFR cameras land on their average). */
  fps: number;
  duration: number;
  /** Presentation time of the first frame; Mediabunny timestamps are shifted by this to match <video>.currentTime. */
  first: number;
  track: InputVideoTrack;
  flow?: FlowSample[];
  /** Breakup scan (`analyzeDamage`, or for free with `analyzeFlow`). */
  damage?: Damage;
}

const STANDARD = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 100, 119.88, 120];
const exact = (f: number) => (Math.abs(f - 23.976) < 1e-3 ? 24000 / 1001 : Math.abs(f - 29.97) < 1e-3 ? 30000 / 1001 : Math.abs(f - 59.94) < 1e-3 ? 60000 / 1001 : Math.abs(f - 119.88) < 1e-3 ? 120000 / 1001 : f);

export function snapFps(rate: number): number {
  const near = STANDARD.filter((s) => Math.abs(rate - s) / s < 0.015).sort((a, b) => Math.abs(rate - a) - Math.abs(rate - b))[0];
  return near ? exact(near) : Math.round(rate * 100) / 100;
}

export async function openVideo(file: File): Promise<VideoInfo> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error('No video track in this file.');
  if (!(await track.canDecode())) throw new Error(`This browser can't decode ${track.codec ?? 'this'} video. Try an H.264 MP4.`);
  const [stats, duration, first] = await Promise.all([track.computePacketStats(300), input.computeDuration(), track.getFirstTimestamp()]);
  return {
    file, url: URL.createObjectURL(file),
    // Even sizes: H.264 4:2:0 can't encode odd ones, and non-square-pixel DVRs can display at one (720×486 → 720×547).
    width: track.displayWidth & ~1, height: track.displayHeight & ~1,
    fps: snapFps(stats.averagePacketRate || 30),
    duration: duration - first, first, track,
  };
}

// ---------- one decode, several small views ----------

type Rotation = 0 | 90 | 180 | 270;
interface View { w: number; h: number; canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D }
function view(w: number, h: number): View {
  const canvas = new OffscreenCanvas(w, h);
  return { w, h, canvas, ctx: canvas.getContext('2d', { alpha: false, willReadFrequently: true })! };
}

/** Draw a sample into a small view, stretched like CanvasSink({fit:'fill'}), with the browser's best downscaling. */
function drawSmall(s: VideoSample, v: View, rotation: Rotation, flip: boolean) {
  v.ctx.imageSmoothingQuality = 'high';
  s.drawWithFit(v.ctx, { fit: 'fill', rotation, flip });
}

const cancelled = () => new DOMException('Cancelled', 'AbortError');

/** Decode every frame once and feed the motion estimator and/or the damage scan. */
async function scan(v: VideoInfo, want: { flow: boolean; damage: boolean }, onProgress: (t: number) => void, signal: AbortSignal) {
  const [rotation, flip] = await Promise.all([v.track.getRotation(), v.track.getFlip()]);
  const est = want.flow ? new FlowEstimator() : null;
  const fv = want.flow ? view(FLOW_W, FLOW_H) : null, dv = want.damage ? view(SCAN_W, SCAN_H) : null;
  const gray = new Uint8Array(FLOW_W * FLOW_H);
  const times: number[] = [], scores: FrameScore[] = [];
  const bright = plane(SCAN_W, SCAN_H);
  let n = 0;
  for await (const s of new VideoSampleSink(v.track).samples()) {
    const t = s.timestamp - v.first;
    try {
      if (signal.aborted) throw cancelled();
      if (fv && est) {
        drawSmall(s, fv, rotation, flip);
        const px = fv.ctx.getImageData(0, 0, FLOW_W, FLOW_H).data;
        for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8;
        est.push(gray, t);
      }
      if (dv) {
        drawSmall(s, dv, rotation, flip);
        const d = dv.ctx.getImageData(0, 0, SCAN_W, SCAN_H).data;
        scores.push(scoreFrame({ w: SCAN_W, h: SCAN_H, d }));
        times.push(t);
        for (let i = 0, j = 0; i < bright.d.length; i++, j += 4) {
          const l = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
          if (l > bright.d[i]) bright.d[i] = l;
        }
      }
    } finally { s.close(); }
    if (++n % 30 === 0) { onProgress(t); await new Promise((r) => setTimeout(r, 0)); }
  }
  if (est) v.flow = est.samples;
  if (dv) {
    // The picture inside black bars, from the brightest luma per pixel over the whole video, in video pixels.
    const b = pictureBox(bright), sx = v.width / SCAN_W, sy = v.height / SCAN_H;
    const box = b.w === SCAN_W && b.h === SCAN_H ? { x: 0, y: 0, w: v.width, h: v.height }
      : { x: Math.round(b.x * sx) & ~1, y: Math.round(b.y * sy) & ~1, w: Math.round(b.w * sx) & ~1, h: Math.round(b.h * sy) & ~1 };
    // Neighbours within about half a second count as "around" a frame.
    v.damage = { t: Float32Array.from(times), s: breakups(scores, Math.max(4, Math.round(v.fps / 2))), raw: scores, box };
  }
}

/**
 * Decode every frame small and run the global-motion estimator. Cached on the VideoInfo. The damage
 * scan rides along in the same decode when it hasn't run yet.
 */
export async function analyzeFlow(v: VideoInfo, onProgress: (t: number) => void, signal: AbortSignal): Promise<FlowSample[]> {
  if (v.flow) return v.flow;
  await scan(v, { flow: true, damage: !v.damage }, onProgress, signal);
  return v.flow!;
}

/** Breakup strength per frame (see clean/detect.ts). Cached on the VideoInfo. */
export async function analyzeDamage(v: VideoInfo, onProgress: (t: number) => void, signal: AbortSignal): Promise<Damage> {
  if (v.damage) return v.damage;
  await scan(v, { flow: false, damage: true }, onProgress, signal);
  return v.damage!;
}
