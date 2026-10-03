import type { DecodedFlight } from './bbl.js';

type Axis3 = [Float32Array | null, Float32Array | null, Float32Array | null];

export interface Signals {
  n: number;
  t: Float64Array;
  fs: number;
  dt: number;
  duration: number;
  quality: Uint8Array;
  gyro: Axis3;
  setpoint: Axis3;
  stick: Axis3;
  throttle: Float64Array | null;
  acc: Axis3;
  attitude: [Float32Array, Float32Array, Float32Array] | null;
  motorCount: number;
  motorPct: Float32Array[];
  motorMean?: Float32Array;
  vbat: Float32Array | null;
}

export function buildSignals(flight: DecodedFlight): Signals;
export function indexAtTime(t: ArrayLike<number>, x: number): number;
