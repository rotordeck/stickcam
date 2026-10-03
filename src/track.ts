// Stick track: a decoded flight resampled to the output frame rate, sticks normalized.
// Port of fpvstream android/.../blackbox/overlay/StickTrack.kt (fixed-rate resample, nearest sample, null in gaps).
import type { DecodedFlight } from './decoder/bbl.js';
import { buildSignals, indexAtTime, type Signals } from './decoder/units.js';

export interface Track {
  fps: number;
  frames: number;
  /** Flight time (s, from the first logged sample) of output frame 0. */
  start: number;
  roll: Float32Array; pitch: Float32Array; yaw: Float32Array; // -1..1
  throttle: Float32Array; // 0..1
  gyro: [Float32Array, Float32Array, Float32Array]; // deg/s roll, pitch, yaw
  motor: Float32Array; // mean motor output 0..1
  /** 1 when a logged sample lies within MAX_GAP of the frame; 0 = gap (sticks rest at centre, dimmed). */
  live: Uint8Array;
}

const MAX_GAP = 0.15;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** rcCommand[3] range: BF4+ logs throttle as 1000..2000; older firmware used minthrottle..maxthrottle. */
export function throttleRange(raw: Record<string, string>): [number, number] {
  const lo = raw.minthrottle ? +raw.minthrottle : 1000;
  const hi = raw.maxthrottle ? +raw.maxthrottle : 2000;
  return hi > lo ? [lo, hi] : [1000, 2000];
}

export interface FlightData { flight: DecodedFlight; sig: Signals; armed: [number, number] }

export function prepare(flight: DecodedFlight): FlightData {
  const sig = buildSignals(flight);
  return { flight, sig, armed: armedSpan(flight, sig) };
}

/** First..last armed time (s) from S-frame flightModeFlags bit 0; whole log when flags are absent. */
export function armedSpan(flight: DecodedFlight, sig: Signals): [number, number] {
  const s = flight.slow;
  if (!sig.n) return [0, 0];
  if (!s || !s.frames.length || s.names[0] !== 'flightModeFlags') return [0, sig.duration];
  let first = -1, last = -1, state = 1, from = 0;
  const close = (to: number) => { if (state) { if (first < 0) first = from; last = to; } };
  for (const f of s.frames) {
    const flags = f.values[0];
    if (flags > 0xffff) continue;
    const armed = flags & 1 ? 1 : 0;
    const at = Math.min(sig.n - 1, f.n);
    if (armed !== state) { close(at); from = at; state = armed; }
  }
  close(sig.n - 1);
  if (first < 0) return [0, sig.duration];
  return [sig.t[first], sig.t[last]];
}

export function buildTrack(data: FlightData, fps: number, start: number, end: number): Track {
  const { sig, flight } = data;
  const frames = Math.max(1, Math.round((end - start) * fps));
  const [tLo, tHi] = throttleRange(flight.header.raw);
  const mk = () => new Float32Array(frames);
  const tr: Track = {
    fps, frames, start,
    roll: mk(), pitch: mk(), yaw: mk(), throttle: mk(),
    gyro: [mk(), mk(), mk()], motor: mk(), live: new Uint8Array(frames),
  };
  const [sr, sp, sy] = sig.stick;
  const thr = sig.throttle;
  for (let i = 0; i < frames; i++) {
    const tf = start + i / fps;
    let j = indexAtTime(sig.t, tf);
    if (j > 0 && (j >= sig.n || Math.abs(sig.t[j - 1] - tf) < Math.abs(sig.t[j] - tf))) j--;
    if (j < 0 || j >= sig.n || Math.abs(sig.t[j] - tf) > MAX_GAP) continue;
    tr.live[i] = 1;
    tr.roll[i] = sr ? clamp(sr[j] / 500, -1, 1) : 0;
    tr.pitch[i] = sp ? clamp(sp[j] / 500, -1, 1) : 0;
    tr.yaw[i] = sy ? clamp(sy[j] / 500, -1, 1) : 0;
    tr.throttle[i] = thr ? clamp((thr[j] - tLo) / (tHi - tLo), 0, 1) : 0;
    for (let a = 0; a < 3; a++) tr.gyro[a][i] = sig.gyro[a] ? sig.gyro[a]![j] : 0;
    tr.motor[i] = sig.motorMean ? clamp(sig.motorMean[j] / 100, 0, 1) : tr.throttle[i];
  }
  return tr;
}
