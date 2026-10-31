// Stick-driven camera path for the hero world. Pure: the pose at frame i is a function of the track alone,
// computed once from frame 0 forward, so play, pause, seek and scrub all show the same pose for a frame
// (no wall-clock state, nothing to drift). No three.js, so tests run it in node.
//
// Mapping (sticks: roll/pitch/yaw -1..1, throttle 0..1, each smoothed by a one-pole filter, TAU_STICK):
//   roll     -> bank  = roll * BANK_MAX            and a turn of -roll * TURN_ROLL rad/s (bank at speed turns)
//   pitch    -> nose  = -pitch * PITCH_MAX         (forward stick = nose down = more ground in view)
//   yaw      -> turn  = -yaw * TURN_YAW rad/s      (right stick = view turns right)
//   throttle -> speed = V_MIN + (V_MAX - V_MIN) * throttle
// A pull toward the course line keeps a long flight in the clear corridor between the trees: HOME acts only
// while roll and yaw are near centre (gone at half stick), and returns, up to 4x, 12-22 m off the line, sticks or not.
import { TAU, groundH, pathX, pathY, smooth } from './course.ts';

export const TAU_STICK = 0.1; // s, stick smoothing time constant
export const TAU_THR = 0.15; // s, throttle → speed
export const BANK_MAX = 60 * Math.PI / 180;
export const PITCH_MAX = 35 * Math.PI / 180;
export const TURN_ROLL = 1.1; // rad/s at full roll
export const TURN_YAW = 1.6; // rad/s at full yaw
export const V_MIN = 1.5, V_MAX = 46; // m/s
const HOME = 1.0; // 1/s, heading pull toward the course line
const WALL0 = 12, WALL1 = 22; // m off the line: the course pull returns (up to 4x) between these, sticks or not; trees thin in from 22 m
const SUB = 4; // integration sub-steps per frame

export interface PoseTrack { fps: number; frames: number; roll: ArrayLike<number>; pitch: ArrayLike<number>; yaw: ArrayLike<number>; throttle: ArrayLike<number>; live: ArrayLike<number> }
export interface PosePath {
  frames: number;
  x: Float32Array; y: Float32Array; z: Float32Array;
  yaw: Float32Array; pitch: Float32Array; bank: Float32Array; speed: Float32Array;
}
export interface Pose { x: number; y: number; z: number; yaw: number; pitch: number; bank: number; speed: number }

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const wrap = (a: number) => a - TAU * Math.round(a / TAU);

export function buildPosePath(tr: PoseTrack): PosePath {
  const n = Math.max(1, tr.frames), fps = tr.fps > 0 ? tr.fps : 30, dt = 1 / fps, h = dt / SUB;
  const P: PosePath = {
    frames: n,
    x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n),
    yaw: new Float32Array(n), pitch: new Float32Array(n), bank: new Float32Array(n), speed: new Float32Array(n),
  };
  const kS = 1 - Math.exp(-dt / TAU_STICK), kT = 1 - Math.exp(-dt / TAU_THR);
  let r = 0, p = 0, w = 0, t = 0.35; // smoothed sticks
  let x = pathX(0), z = 0, yaw = 0, alt = 0; // alt: metres above the course line
  for (let i = 0; i < n; i++) {
    const on = i < tr.frames && !!tr.live[i];
    // a log gap reads as centred sticks and a hover
    r += ((on ? tr.roll[i] : 0) - r) * kS;
    p += ((on ? tr.pitch[i] : 0) - p) * kS;
    w += ((on ? tr.yaw[i] : 0) - w) * kS;
    t += ((on ? tr.throttle[i] : 0.35) - t) * kT;
    const bank = clamp(r, -1, 1) * BANK_MAX, pitch = -clamp(p, -1, 1) * PITCH_MAX;
    const v = V_MIN + (V_MAX - V_MIN) * clamp(t, 0, 1);
    if (i > 0) {
      for (let k = 0; k < SUB; k++) {
        const s = -z, look = clamp(v * 1.0, 14, 32), off = x - pathX(s);
        // the course pull fades out while roll or yaw is deflected (the thumbs own the turn) and comes back in full
        // as the camera nears the trees
        const free = Math.max(0, 1 - 2 * Math.max(Math.abs(r), Math.abs(w)), smooth(WALL0, WALL1, Math.abs(off)));
        const home = HOME * (1 + 3 * smooth(WALL0, WALL1, Math.abs(off))) * free * wrap(Math.atan2(-(pathX(s + look) - x), look) - yaw);
        yaw += (-clamp(r, -1, 1) * TURN_ROLL - clamp(w, -1, 1) * TURN_YAW + home) * h;
        x -= Math.sin(yaw) * v * h;
        z -= Math.cos(yaw) * v * h;
        // nose down sinks, nose up climbs, and the height drifts back to the course line
        alt = clamp(alt + (Math.sin(pitch) * v * 0.25 - alt / 1.5) * h, -5, 14);
      }
    }
    const y = Math.max(pathY(-z) + alt, groundH(x, z) + 2.5);
    P.x[i] = x; P.y[i] = y; P.z[i] = z; P.yaw[i] = yaw; P.pitch[i] = pitch; P.bank[i] = bank; P.speed[i] = v;
  }
  return P;
}

export function poseAt(P: PosePath, i: number, out: Pose): Pose {
  const j = clamp(Math.round(i), 0, P.frames - 1);
  out.x = P.x[j]; out.y = P.y[j]; out.z = P.z[j];
  out.yaw = P.yaw[j]; out.pitch = P.pitch[j]; out.bank = P.bank[j]; out.speed = P.speed[j];
  return out;
}
