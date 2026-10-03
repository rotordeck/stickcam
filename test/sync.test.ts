import { describe, expect, it } from 'vitest';
import { FLOW_H, FLOW_W, FlowEstimator, findOffset } from '../src/sync.ts';
import { makeFreestyleDemo } from '../src/demo.ts';
import { prepare } from '../src/track.ts';
import { snapFps } from '../src/video.ts';

// Smooth random texture, wrapping, larger than the frame so the "camera" can pan over it.
const TW = 1024, TH = 256;
function texture(seed = 3) {
  let s = seed;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const t = new Float32Array(TW * TH);
  for (let k = 0; k < 60; k++) {
    const cx = rnd() * TW, cy = rnd() * TH, r = 6 + rnd() * 30, v = rnd() * 255;
    for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
      const dx = Math.min(Math.abs(x - cx), TW - Math.abs(x - cx)), dy = y - cy;
      if (dx * dx + dy * dy < r * r) t[y * TW + x] = v;
    }
  }
  return t;
}
function view(tex: Float32Array, px: number, py: number) {
  const out = new Uint8Array(FLOW_W * FLOW_H);
  const ox = Math.round(px), oy = Math.round(py);
  for (let y = 0; y < FLOW_H; y++) for (let x = 0; x < FLOW_W; x++) {
    out[y * FLOW_W + x] = tex[(((y + oy) % TH) + TH) % TH * TW + ((((x + ox) % TW) + TW) % TW)];
  }
  return out;
}

describe('flow estimator', () => {
  it('recovers a known pan between two frames', () => {
    const tex = texture();
    const fe = new FlowEstimator();
    fe.push(view(tex, 100, 40), 0);
    fe.push(view(tex, 107, 37), 0.1); // camera moved +7 x, -3 y → image shifts -7, +3
    expect(fe.samples[0].dx * 0.1).toBeCloseTo(-7, 0);
    expect(fe.samples[0].dy * 0.1).toBeCloseTo(3, 0);
  });
});

describe('auto-sync', () => {
  it('finds where the flight starts in a synthetic video that pans with the gyro', () => {
    const d = prepare(makeFreestyleDemo());
    const { sig } = d;
    const START = 3.7; // the flight starts 3.7 s into the "video"
    const fps = 30, vDur = sig.duration + 6;
    const tex = texture();
    const fe = new FlowEstimator();
    let px = 0, py = 0;
    for (let i = 0; i < Math.round(vDur * fps); i++) {
      const t = i / fps, lt = t - START;
      const j = Math.max(0, Math.min(sig.n - 1, Math.round(lt * sig.fs)));
      const live = lt >= 0 && lt < sig.duration;
      // ~0.25 px per degree at this frame size (wide FPV lens): yaw pans x, pitch pans y.
      if (live) { px += (sig.gyro[2]![j] * 0.25) / fps; py += (sig.gyro[1]![j] * 0.08) / fps; }
      fe.push(view(tex, px, py), t);
    }
    const res = findOffset(fe.samples, sig)!;
    expect(res).not.toBeNull();
    expect(-res.offset).toBeCloseTo(START, 1); // within 0.05 s
    expect(res.margin).toBeGreaterThan(0.1);
  });
});

describe('video fps', () => {
  it('snaps near-standard rates and keeps odd VFR averages', () => {
    expect(snapFps(29.95)).toBeCloseTo(30000 / 1001, 6);
    expect(snapFps(59.99)).toBe(60);
    expect(snapFps(25.1)).toBe(25);
    expect(snapFps(33.17)).toBe(33.17);
  });
});
