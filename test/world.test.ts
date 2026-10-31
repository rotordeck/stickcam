import { describe, expect, it } from 'vitest';
import { GATE_SPACING, groundH, pathX, pathY } from '../src/world/course.ts';
import { Flight, STEP } from '../src/world/flight.ts';
import { BANK_MAX, PITCH_MAX, buildPosePath, poseAt } from '../src/world/pose.ts';

const sticks = { roll: 0, pitch: 0, yaw: 0, throttle: 0.3 };

describe('hero world flight', () => {
  it('the autopilot flies through every gate of a 96 s run and stays above the ground', () => {
    const f = new Flight();
    let next = 1, gates = 0, worstX = 0, worstY = 0, clear = Infinity;
    for (let i = 0; i < 120 * 96; i++) {
      f.step(STEP, false, sticks);
      clear = Math.min(clear, f.y - groundH(f.x, f.z));
      if (-f.z >= next * GATE_SPACING) {
        worstX = Math.max(worstX, Math.abs(f.x - pathX(-f.z)));
        worstY = Math.max(worstY, Math.abs(f.y - pathY(-f.z)));
        next++; gates++;
      }
    }
    expect(gates).toBeGreaterThan(15);
    expect(worstX).toBeLessThan(2.8); // the gate opening is 5.6 m wide
    expect(worstY).toBeLessThan(2.8);
    expect(clear).toBeGreaterThan(2);
  });

  it('is deterministic', () => {
    const run = () => { const f = new Flight(); for (let i = 0; i < 6000; i++) f.step(STEP, false, sticks); return [f.x, f.y, f.z, f.yaw, f.bank]; };
    expect(run()).toEqual(run());
  });

  it('driven mode: right roll banks right and turns right, throttle sets speed, yaw turns', () => {
    const f = new Flight();
    for (let i = 0; i < 240; i++) f.step(STEP, true, { roll: 0.8, pitch: 0, yaw: 0, throttle: 0.9 });
    expect(f.bank).toBeGreaterThan(0.4);
    expect(f.yaw).toBeLessThan(0);
    expect(f.speed).toBeGreaterThan(20);
    const g = new Flight();
    for (let i = 0; i < 120; i++) g.step(STEP, true, { roll: 0, pitch: 0, yaw: -0.8, throttle: 0.3 });
    expect(g.yaw).toBeGreaterThan(0); // left yaw
    const h = new Flight();
    for (let i = 0; i < 120; i++) h.step(STEP, true, { roll: 0, pitch: 1, yaw: 0, throttle: 0.4 });
    expect(h.pitch).toBeLessThan(-0.2); // forward stick = nose down
  });
});

describe('hero world stick pose', () => {
  const fps = 30;
  const track = (n: number, f: (i: number) => [number, number, number, number]) => {
    const t = { fps, frames: n, roll: new Float32Array(n), pitch: new Float32Array(n), yaw: new Float32Array(n), throttle: new Float32Array(n), live: new Uint8Array(n).fill(1) };
    for (let i = 0; i < n; i++) [t.roll[i], t.pitch[i], t.yaw[i], t.throttle[i]] = f(i);
    return t;
  };
  const end = (p: ReturnType<typeof buildPosePath>) => poseAt(p, p.frames - 1, { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, bank: 0, speed: 0 });

  it('right roll banks right and turns right, forward pitch noses down, yaw turns, throttle sets speed', () => {
    const r = end(buildPosePath(track(30, () => [1, 0, 0, 0.4])));
    expect(r.bank).toBeGreaterThan(0.9 * BANK_MAX);
    expect(r.yaw).toBeLessThan(-0.6); // ~1 s at TURN_ROLL
    expect(end(buildPosePath(track(30, () => [0, 1, 0, 0.4]))).pitch).toBeLessThan(-0.9 * PITCH_MAX);
    expect(end(buildPosePath(track(30, () => [0, 0, -1, 0.4]))).yaw).toBeGreaterThan(1); // left yaw
    const fast = end(buildPosePath(track(30, () => [0, 0, 0, 1]))), slow = end(buildPosePath(track(30, () => [0, 0, 0, 0])));
    expect(fast.speed).toBeGreaterThan(40);
    expect(slow.speed).toBeLessThan(3);
    expect(-fast.z).toBeGreaterThan(5 * -slow.z);
  });

  it('follows the sticks within ~0.1 s and is a pure function of the frame', () => {
    const p = buildPosePath(track(60, (i) => [i >= 30 ? 1 : 0, 0, 0, 0.4]));
    expect(p.bank[30 + 3]).toBeGreaterThan(0.6 * BANK_MAX); // 0.1 s after the step
    const q = buildPosePath(track(60, (i) => [i >= 30 ? 1 : 0, 0, 0, 0.4]));
    expect(Array.from(q.x)).toEqual(Array.from(p.x));
    expect(Array.from(q.yaw)).toEqual(Array.from(p.yaw));
  });

  it('a long wobbly hover stays in the tree-free corridor and above the ground', () => {
    const p = buildPosePath(track(fps * 60, (i) => [0.3 * Math.sin(i / 20), 0.2 * Math.sin(i / 33), 0, 0.45]));
    for (let i = 0; i < p.frames; i += 15) {
      expect(Math.abs(p.x[i] - pathX(-p.z[i]))).toBeLessThan(22); // trees start 22 m from the line
      expect(p.y[i] - groundH(p.x[i], p.z[i])).toBeGreaterThan(2);
    }
  });
});
