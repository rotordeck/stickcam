// Web Worker: repairs one chunk of frames. Input frames arrive as transferred RGBA buffers; the
// chunk carries RADIUS frames of context on either side, so chunks are independent of each other.
import { crop, paste, repairFrames, type Box, type CleanKind } from './repair.ts';

export interface CleanTask {
  id: number;
  kind: CleanKind;
  amount: number;
  box: Box;
  w: number; h: number;
  frames: ArrayBuffer[];
  /** Repair frames[from..to-1]; the others are context. */
  from: number; to: number;
}
export type CleanReply = { id: number; out: ArrayBuffer[] } | { id: number; error: string };

const scope = self as unknown as Worker;
scope.onmessage = (e: MessageEvent<CleanTask>) => {
  const t = e.data;
  try {
    const frames = t.frames.map((b) => crop({ w: t.w, h: t.h, d: new Uint8ClampedArray(b) }, t.box));
    const out = repairFrames(t.kind, t.amount, frames, t.from, t.to).map((f) => paste(f, t.box, t.w, t.h).d.buffer as ArrayBuffer);
    scope.postMessage({ id: t.id, out } satisfies CleanReply, out);
  } catch (err) {
    scope.postMessage({ id: t.id, error: (err as Error).message } satisfies CleanReply);
  }
};
