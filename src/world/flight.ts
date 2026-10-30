// Flight model for the hero world: the same four sticks as the overlay (roll/pitch/yaw -1..1, throttle 0..1)
// bank, pitch, turn and speed a camera. Two stick sources feed it: a looping autopilot (idle) or the real
// track (driven). Fixed-step and allocation-free; attitude lags the sticks, so a seek eases instead of jumping.
import { TAU, groundH, pathDDX, pathDX, pathX, pathY } from './course.ts';

export interface Sticks { roll: number; pitch: number; yaw: number; throttle: number }

const G = 9.81;
const BANK_MAX = 55 * Math.PI / 180, PITCH_MAX = 28 * Math.PI / 180, YAW_RATE = 1.0;
const V_MIN = 6, V_MAX = 32;
const LOOP = 32; // s, autopilot script length
const HOME = 0.45; // 1/s, how hard driven flight is pulled back toward the course line

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const ease = (u: number) => u * u * (3 - 2 * u);
const wrap = (a: number) => a - TAU * Math.round(a / TAU);

/** 0 before `start`, eases up over `rise`, 1 through `hold`, eases down over `fall`. */
function window_(t: number, start: number, rise: number, hold: number, fall: number) {
  const u = t - start;
  if (u <= 0 || u >= rise + hold + fall) return 0;
  if (u < rise) return ease(u / rise);
  return u < rise + hold ? 1 : 1 - ease((u - rise - hold) / fall);
}
/** A full 360° that starts and ends at rest; it ends on a multiple of TAU, so outside the window it is 0. */
const turn = (t: number, start: number, dur: number) => {
  const u = (t - start) / dur;
  return u <= 0 || u >= 1 ? 0 : ease(u) * TAU;
};

export class Flight {
  x = pathX(0); y = pathY(0); z = 0;
  yaw = 0; pitch = 0; bank = 0; // bank > 0 is a right bank
  speed = 14;
  trickRoll = 0; trickPitch = 0; // extra rotation (autopilot tricks), added to the view only
  clock = 0; // autopilot script time
  readonly cmd: Sticks = { roll: 0, pitch: 0, yaw: 0, throttle: 0.3 };

  /** The autopilot's sticks at the current state. Pure pursuit of the course line plus the trick script. */
  private autopilot() {
    const t = this.clock % LOOP;
    const look = clamp(this.speed * 1.3, 16, 40);
    const s = -this.z, ts = s + look;
    const e = wrap(Math.atan2(-(pathX(ts) - this.x), look) - this.yaw);
    const c = this.cmd;
    // feedforward: the bank a coordinated turn needs to follow the line's curvature, plus a correction toward it
    const dx = pathDX(s), ff = Math.atan(this.speed * this.speed * pathDDX(s) / (G * (1 + dx * dx))) / BANK_MAX;
    c.roll = clamp(0.5 * ff - 2.4 * e, -1, 1); // half: the lookahead already leads the turn
    const climb = Math.atan((pathY(ts) - this.y) / look);
    c.pitch = clamp(-climb / (PITCH_MAX * 0.9), -1, 1);
    c.yaw = 0;
    let th = 0.3 + 0.05 * Math.sin(t * TAU * 5 / LOOP);
    th += (0.75 - th) * window_(t, 5, 0.35, 1.6, 0.9); // punch-out
    th += (0.06 - th) * window_(t, 25, 0.5, 1.2, 0.8); // throttle chop
    c.throttle = th;
    this.trickRoll = -turn(t, 9, 0.8) + turn(t, 21, 0.75); // right roll, then left
    this.trickPitch = turn(t, 15.2, 1.1); // back flip
    return c;
  }

  /** Advance by dt seconds (keep it small: the host uses 1/120). `input` is read only when driven. */
  step(dt: number, driven: boolean, input: Sticks) {
    let c: Sticks;
    if (driven) {
      c = this.cmd;
      c.roll = clamp(input.roll, -1, 1); c.pitch = clamp(input.pitch, -1, 1);
      c.yaw = clamp(input.yaw, -1, 1); c.throttle = clamp(input.throttle, 0, 1);
      // an autopilot trick still in flight unwinds the short way round
      const k = Math.exp(-6 * dt);
      this.trickRoll = wrap(this.trickRoll) * k; this.trickPitch = wrap(this.trickPitch) * k;
    } else {
      this.clock += dt;
      c = this.autopilot();
    }
    this.bank += (c.roll * BANK_MAX - this.bank) * (1 - Math.exp(-dt / 0.16));
    this.pitch += (-c.pitch * PITCH_MAX - this.pitch) * (1 - Math.exp(-dt / 0.2));
    const vT = V_MIN + (V_MAX - V_MIN) * c.throttle;
    this.speed += (vT - this.speed) * (1 - Math.exp(-dt / (vT > this.speed ? 0.5 : 0.9)));
    let w = -G * Math.tan(this.bank) / this.speed - c.yaw * YAW_RATE; // a right bank or right yaw turns right: yaw angle falls
    if (driven) {
      const s = -this.z, look = clamp(this.speed * 1.3, 16, 40);
      w += HOME * wrap(Math.atan2(-(pathX(s + look) - this.x), look) - this.yaw);
    }
    this.yaw += clamp(w, -1.4, 1.4) * dt;
    const gam = this.pitch * 0.9, v = this.speed * dt, cg = Math.cos(gam);
    this.x -= Math.sin(this.yaw) * cg * v;
    this.z -= Math.cos(this.yaw) * cg * v;
    this.y = clamp(this.y + Math.sin(gam) * v, groundH(this.x, this.z) + 2.5, 40);
  }
}

export const STEP = 1 / 120;
