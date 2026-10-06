// Derived motion features and "game" events for the effect layers. Computed once per (flight, trim, fps).
// Everything is measured, nothing is guessed: tricks come from the full-rate gyro (a real ≥ 330° rotation),
// throttle spans from the full-rate throttle so their timers are exact to the millisecond.
import { indexAtTime } from './decoder/units.js';
import { throttleRange, type FlightData, type Track } from './track.ts';

export type EventKind = 'snap' | 'flip' | 'roll' | 'spin' | 'punch' | 'arm' | 'disarm' | 'crash' | 'full' | 'hang';

export interface MotionEvent {
  frame: number;
  kind: EventKind;
  /** 0 = left gimbal, 1 = right gimbal (snap / punch). */
  side?: 0 | 1;
  /** Stick position at the event (gimbal units, -1..1). */
  x?: number; y?: number;
  /** Number of full rotations for flip/roll/spin. */
  turns?: number;
  /** +1 / -1 rotation direction. */
  dir?: number;
  /** Trick chain position (1 = first trick of a combo). */
  combo?: number;
  label?: string;
  /** Throttle spans (full / hang): last frame of the span, and exact start time and duration (s) from the log. */
  end?: number; t0?: number; dur?: number;
}

/** Cumulative real numbers per frame for the stats readout. */
export interface MotionStats {
  /** Seconds at full throttle so far. */
  fullTotal: Float32Array;
  /** Longest hang time so far (s). */
  hangBest: Float32Array;
  /** Seconds since arm (0 before arm). */
  armedTime: Float32Array;
}

export interface Motion {
  /** Gimbal dot positions per frame, gimbal units (-1..1, y down). */
  lx: Float32Array; ly: Float32Array; rx: Float32Array; ry: Float32Array;
  /** Dot speed per frame (full-scale units per second, lightly smoothed). */
  speedL: Float32Array; speedR: Float32Array;
  events: MotionEvent[];
  stats: MotionStats;
}

export interface MotionOptions { mode: 1 | 2; snapSpeed?: number }

/** Map a track frame to gimbal dot positions (y down: stick up = -1). */
export function gimbalPositions(tr: Track, i: number, mode: 1 | 2): [number, number, number, number] {
  const thrY = 1 - 2 * tr.throttle[i];
  const pitchY = -tr.pitch[i];
  return mode === 2
    ? [tr.yaw[i], thrY, tr.roll[i], pitchY]
    : [tr.yaw[i], pitchY, tr.roll[i], thrY];
}

const ROT_START = 280; // deg/s: rotation run begins
const ROT_HOLD = 140; // deg/s: run continues while above this
const ROT_GAP = 0.2; // s below ROT_HOLD that ends a run
const COMBO_WINDOW = 1.6; // s between tricks to chain a combo

const FULL_THR = 0.98; // throttle fraction that counts as full (sticks rarely reach exactly 2000)
const FULL_MIN = 0.3; // s: shortest full-throttle span that gets a timer
const ZERO_THR = 0.02; // throttle fraction that counts as zero
const HANG_MIN = 0.5; // s: shortest zero-throttle span that counts as hang time
const SPAN_JOIN = 0.06; // s: dips shorter than this don't break a span (radio jitter)
const HANG_FLYING = 0.2; // throttle needed before and after a hang (else it's idling on the ground)
const HANG_CONTEXT = 1.5; // s: window before/after a hang to look for that throttle

/** Spans [t0, t1] (s) where `inside(i)` holds on the full-rate samples, joining gaps up to SPAN_JOIN. */
function spans(t: Float64Array | Float32Array, a: number, b: number, inside: (i: number) => boolean): [number, number][] {
  const out: [number, number][] = [];
  let s0 = -1, last = -1;
  for (let i = a; i < b; i++) {
    if (!inside(i)) continue;
    if (s0 >= 0 && t[i] - t[last] <= SPAN_JOIN) { last = i; continue; }
    if (s0 >= 0) out.push([t[s0], t[last]]);
    s0 = i; last = i;
  }
  if (s0 >= 0) out.push([t[s0], t[last]]);
  return out;
}
const NAMES = ['', '', 'DOUBLE ', 'TRIPLE ', 'QUAD '];
const trickName = (kind: EventKind, turns: number) => {
  const base = kind === 'flip' ? 'FLIP' : kind === 'roll' ? 'ROLL' : '360';
  if (kind === 'spin') return turns > 1 ? `${turns * 360} SPIN` : '360 SPIN';
  return (NAMES[turns] ?? `${turns}x `) + base;
};

export function analyzeMotion(data: FlightData, tr: Track, opts: MotionOptions): Motion {
  const n = tr.frames, fps = tr.fps;
  const lx = new Float32Array(n), ly = new Float32Array(n), rx = new Float32Array(n), ry = new Float32Array(n);
  for (let i = 0; i < n; i++) [lx[i], ly[i], rx[i], ry[i]] = gimbalPositions(tr, i, opts.mode);

  const speed = (x: Float32Array, y: Float32Array) => {
    const s = new Float32Array(n);
    for (let i = 1; i < n; i++) s[i] = tr.live[i] && tr.live[i - 1] ? Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]) * fps : 0;
    // light one-pole smoothing (~35 ms) so single-frame jitter doesn't spray sparks
    const a = 1 - Math.exp(-1 / (0.035 * fps));
    for (let i = 1; i < n; i++) s[i] = s[i - 1] + a * (s[i] - s[i - 1]);
    return s;
  };
  const speedL = speed(lx, ly), speedR = speed(rx, ry);

  const events: MotionEvent[] = [];

  // Edge snaps: a stick slams into > 95 % deflection fast. Re-armed once it falls back under 80 %.
  // The throttle axis is left out: throttle chops are routine and punches have their own event.
  const snapSpeed = opts.snapSpeed ?? 5;
  const thrOnLeft = opts.mode === 2;
  ([[lx, ly, speedL, 0], [rx, ry, speedR, 1]] as const).forEach(([x, y, s, side]) => {
    const useY = thrOnLeft ? side === 1 : side === 0;
    let armed = true;
    for (let i = 1; i < n; i++) {
      if (!tr.live[i]) continue;
      const r = useY ? Math.max(Math.abs(x[i]), Math.abs(y[i])) : Math.abs(x[i]);
      if (armed && r > 0.95 && s[i] > snapSpeed) { events.push({ frame: i, kind: 'snap', side, x: x[i], y: y[i], }); armed = false; }
      else if (r < 0.8) armed = true;
    }
  });

  // Punch-outs: throttle up by > 45 % within 0.4 s, starting from below 35 %.
  {
    const look = Math.max(1, Math.round(0.4 * fps));
    let armed = true;
    const thSide: 0 | 1 = opts.mode === 2 ? 0 : 1;
    for (let i = look; i < n; i++) {
      const th = tr.throttle[i];
      if (armed && tr.live[i]) {
        let lo = 1;
        for (let k = i - look; k < i; k++) if (tr.live[k] && tr.throttle[k] < lo) lo = tr.throttle[k];
        if (lo < 0.35 && th - lo > 0.45) {
          events.push({ frame: i, kind: 'punch', side: thSide, x: thSide ? rx[i] : lx[i], y: thSide ? ry[i] : ly[i], label: 'PUNCH IT' });
          armed = false;
        }
      } else if (th < 0.3) armed = true;
    }
  }

  // Flips / rolls / spins from integrated full-rate gyro.
  const { sig } = data;
  const t0 = tr.start, t1 = tr.start + n / fps;
  const toFrame = (t: number) => Math.min(n - 1, Math.max(0, Math.round((t - t0) * fps)));
  const i0 = indexAtTime(sig.t, t0), i1 = Math.min(sig.n, indexAtTime(sig.t, t1));
  const tricks: MotionEvent[] = [];
  ([[1, 'flip'], [0, 'roll'], [2, 'spin']] as const).forEach(([axis, kind]) => {
    const g = sig.gyro[axis];
    if (!g) return;
    const start = kind === 'spin' ? ROT_START * 1.4 : ROT_START;
    let run = 0, active = false, quiet = 0, counted = 0;
    for (let i = Math.max(1, i0); i < i1; i++) {
      const dt = sig.t[i] - sig.t[i - 1];
      if (dt <= 0 || dt > 0.05) { active = false; run = 0; counted = 0; continue; }
      const w = g[i];
      if (!active) {
        if (Math.abs(w) > start) { active = true; run = 0; counted = 0; quiet = 0; }
        else continue;
      }
      if (Math.abs(w) < ROT_HOLD || (run !== 0 && Math.sign(w) !== Math.sign(run))) {
        quiet += dt;
        if (quiet > ROT_GAP) { active = false; continue; }
      } else quiet = 0;
      run += w * dt;
      // Count a turn at 330° so slightly short flips (gyro filtering, landing early) still register.
      const turns = Math.floor((Math.abs(run) + 30) / 360);
      if (turns > counted) {
        counted = turns;
        tricks.push({ frame: toFrame(sig.t[i]), kind, turns, dir: Math.sign(run) });
      }
    }
  });
  // A double flip emits at 1 and 2 turns; keep only the final count per run (merge same-kind events < 0.7 s apart).
  tricks.sort((a, b) => a.frame - b.frame);
  const merged: MotionEvent[] = [];
  for (const e of tricks) {
    const prev = [...merged].reverse().find((m) => m.kind === e.kind);
    if (prev && e.turns! > prev.turns! && e.frame - prev.frame < 0.7 * fps * e.turns!) { Object.assign(prev, e); continue; }
    merged.push(e);
  }
  let combo = 0, lastTrick = -Infinity;
  for (const e of merged) {
    combo = e.frame - lastTrick <= COMBO_WINDOW * fps ? combo + 1 : 1;
    lastTrick = e.frame;
    e.combo = combo;
    e.label = trickName(e.kind, e.turns!);
  }
  events.push(...merged);

  // Arm / disarm inside the trim range.
  const [armT, disarmT] = data.armed;
  if (armT > t0 && armT < t1) events.push({ frame: toFrame(armT), kind: 'arm', label: 'ARMED' });
  if (disarmT > t0 && disarmT < t1 - 0.05) {
    // Crash: an acc spike (> 6 g) in the 1.5 s before disarm. The card lands on the impact itself.
    let impact = -1;
    const acc = sig.acc;
    if (acc[0] && acc[1] && acc[2]) {
      const a = indexAtTime(sig.t, disarmT - 1.5), b = indexAtTime(sig.t, disarmT + 0.05);
      for (let i = a; i < b && impact < 0; i++) if (Math.hypot(acc[0][i], acc[1][i], acc[2][i]) > 6) impact = sig.t[i];
    }
    events.push(impact >= 0 && impact > t0
      ? { frame: toFrame(impact), kind: 'crash', label: 'WASTED' }
      : { frame: toFrame(disarmT), kind: 'disarm', label: 'DISARMED' });
  }

  // Full throttle and hang time, measured on the full-rate throttle so the timers are exact.
  const spanEvents: MotionEvent[] = [];
  const thr = sig.throttle;
  if (thr) {
    const [tLo, tHi] = throttleRange(data.flight.header.raw);
    const frac = (i: number) => (thr[i] - tLo) / (tHi - tLo);
    const a = Math.max(0, indexAtTime(sig.t, t0)), b = Math.min(sig.n, indexAtTime(sig.t, t1));
    const ev = (kind: 'full' | 'hang', label: string, [s0, s1]: [number, number]): MotionEvent =>
      ({ frame: toFrame(s0), end: toFrame(s1), kind, label, t0: s0, dur: s1 - s0 });
    for (const sp of spans(sig.t, a, b, (i) => frac(i) >= FULL_THR)) if (sp[1] - sp[0] >= FULL_MIN) spanEvents.push(ev('full', 'FULL SEND', sp));
    // Hang time: armed, throttle at zero, and flying on both sides of it (not idling before take-off or after landing).
    const flying = (from: number, to: number) => {
      for (let i = Math.max(0, indexAtTime(sig.t, from)); i < sig.n && sig.t[i] <= to; i++) if (frac(i) > HANG_FLYING) return true;
      return false;
    };
    for (const sp of spans(sig.t, a, b, (i) => frac(i) <= ZERO_THR)) {
      if (sp[1] - sp[0] < HANG_MIN || sp[0] < armT || sp[1] > disarmT) continue;
      if (flying(sp[0] - HANG_CONTEXT, sp[0]) && flying(sp[1], sp[1] + HANG_CONTEXT)) spanEvents.push(ev('hang', 'HANG TIME', sp));
    }
  }
  events.push(...spanEvents);
  events.sort((a, b) => a.frame - b.frame);

  const stats: MotionStats = { fullTotal: new Float32Array(n), hangBest: new Float32Array(n), armedTime: new Float32Array(n) };
  for (let i = 0; i < n; i++) {
    const t = t0 + i / fps;
    let full = 0, hang = 0;
    for (const e of spanEvents) {
      const el = Math.min(e.dur!, Math.max(0, t - e.t0!));
      if (e.kind === 'full') full += el; else hang = Math.max(hang, el);
    }
    stats.fullTotal[i] = full;
    stats.hangBest[i] = hang;
    stats.armedTime[i] = t >= armT && t <= disarmT ? t - armT : t > disarmT ? disarmT - armT : 0;
  }
  return { lx, ly, rx, ry, speedL, speedR, events, stats };
}
