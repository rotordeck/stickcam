// The user's FPV video: metadata for the export, and the motion pass that feeds auto-sync.
import { ALL_FORMATS, BlobSource, CanvasSink, Input, type InputVideoTrack } from 'mediabunny';
import { FLOW_H, FLOW_W, FlowEstimator, type FlowSample } from './sync.ts';

export interface VideoInfo {
  file: File;
  url: string;
  width: number; height: number;
  /** Frame rate snapped to a standard rate when close (VFR cameras land on their average). */
  fps: number;
  duration: number;
  /** Presentation time of the first frame; Mediabunny timestamps are shifted by this to match <video>.currentTime. */
  first: number;
  track: InputVideoTrack;
  flow?: FlowSample[];
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
    width: track.displayWidth, height: track.displayHeight,
    fps: snapFps(stats.averagePacketRate || 30),
    duration: duration - first, first, track,
  };
}

/** Decode every frame small and run the global-motion estimator. Cached on the VideoInfo. */
export async function analyzeFlow(v: VideoInfo, onProgress: (t: number) => void, signal: AbortSignal): Promise<FlowSample[]> {
  if (v.flow) return v.flow;
  const sink = new CanvasSink(v.track, { width: FLOW_W, height: FLOW_H, fit: 'fill', poolSize: 2 });
  const est = new FlowEstimator();
  const gray = new Uint8Array(FLOW_W * FLOW_H);
  let n = 0;
  for await (const { canvas, timestamp } of sink.canvases()) {
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const ctx = (canvas as OffscreenCanvas).getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
    const px = ctx.getImageData(0, 0, FLOW_W, FLOW_H).data;
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8;
    est.push(gray, timestamp - v.first);
    if (++n % 30 === 0) { onProgress(timestamp - v.first); await new Promise((r) => setTimeout(r, 0)); }
  }
  v.flow = est.samples;
  return v.flow;
}
