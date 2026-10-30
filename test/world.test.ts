import { describe, expect, it } from 'vitest';
import { GATE_SPACING, groundH, pathX, pathY } from '../src/world/course.ts';
import { Flight, STEP } from '../src/world/flight.ts';

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
