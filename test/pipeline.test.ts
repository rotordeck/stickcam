import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { decodeFlight, listFlights, repairLegacyDump } from '../src/decoder/bbl.js';
import { buildTrack, prepare, throttleRange } from '../src/track.ts';
import { analyzeMotion } from '../src/motion.ts';
import { makeFreestyleDemo } from '../src/demo.ts';
import { computeLayout, DEFAULT_SETTINGS } from '../src/render/layout.ts';

const load = (path: string) => {
  const rep = repairLegacyDump(new Uint8Array(readFileSync(path)));
  return listFlights(rep.bytes, { gaps: rep.gaps }).map((f) => prepare(decodeFlight(rep.bytes, f.range, f.opts)));
};

describe('decoder + track', () => {
  const samples = JSON.parse(readFileSync('public/samples/samples.json', 'utf8')) as { file: string; duration: number }[];
  it.each(samples)('bundled sample $file decodes with sticks in range', ({ file, duration }) => {
    const [d] = load(`public/samples/${file}`);
    expect(d.sig.duration).toBeCloseTo(duration, 1);
    const tr = buildTrack(d, 30, 0, d.sig.duration);
    const live = tr.live.reduce((a, v) => a + v, 0);
    expect(live / tr.frames).toBeGreaterThan(0.98);
    for (const a of [tr.roll, tr.pitch, tr.yaw]) for (const v of a) expect(Math.abs(v)).toBeLessThanOrEqual(1);
    for (const v of tr.throttle) expect(v >= 0 && v <= 1).toBe(true);
  });

  const full = '../fpvstream/flightdata/20261001/blackbox_20261001_105759.bbl';
  it.skipIf(!existsSync(full))('full 2026-10-01 log has three flights', () => {
    const flights = load(full);
    expect(flights.map((f) => Math.round(f.sig.duration))).toEqual([45, 2, 25]);
  });

  it('throttle range: BF4+ logs omit minthrottle and use 1000..2000', () => {
    expect(throttleRange({ maxthrottle: '2000' })).toEqual([1000, 2000]);
    expect(throttleRange({ minthrottle: '1070', maxthrottle: '2000' })).toEqual([1070, 2000]);
    expect(throttleRange({ minthrottle: '2000', maxthrottle: '1000' })).toEqual([1000, 2000]);
  });

  it('frames in a logging gap are not live', () => {
    const d = prepare(makeFreestyleDemo());
    const { t } = d.sig;
    // Cut 1 s out of the time axis: everything after jumps forward.
    const gapAt = t.findIndex((v) => v >= 5);
    for (let i = gapAt; i < t.length; i++) t[i] += 1;
    const tr = buildTrack(d, 30, 4, 7);
    expect(tr.live[Math.round(0.5 * 30)]).toBe(1); // 4.5 s
    expect(tr.live[Math.round(1.5 * 30)]).toBe(0); // 5.5 s: inside the gap
    expect(tr.live[Math.round(2.5 * 30)]).toBe(1); // 6.5 s
  });
});

describe('motion events on the freestyle demo', () => {
  const d = prepare(makeFreestyleDemo());
  const tr = buildTrack(d, 60, 0, d.sig.duration);
  const m = analyzeMotion(d, tr, { mode: 2 });
  const labels = m.events.filter((e) => e.label).map((e) => e.label);

  it('detects the scripted tricks in order', () => {
    expect(labels).toEqual(['PUNCH IT', 'ROLL', 'FLIP', 'DOUBLE ROLL', '360 SPIN', 'FLIP', 'TRIPLE FLIP', 'PUNCH IT', 'ROLL', 'WASTED']);
  });

  it('chains roll → flip → double roll into a 3-trick combo', () => {
    const combo = m.events.filter((e) => e.combo).slice(0, 3).map((e) => e.combo);
    expect(combo).toEqual([1, 2, 3]);
  });

  it('never counts throttle chops as snaps', () => {
    for (const e of m.events.filter((x) => x.kind === 'snap')) expect(e.side === 1 || Math.abs(e.x!) > 0.9).toBe(true);
  });

  it('score only goes up and ends at the sum of event points', () => {
    for (let i = 1; i < m.score.length; i++) expect(m.score[i]).toBeGreaterThanOrEqual(m.score[i - 1]);
    expect(m.score[m.score.length - 1]).toBe(m.events.reduce((a, e) => a + (e.points ?? 0), 0));
  });

  it('mode 1 swaps throttle and pitch between the gimbals', () => {
    const m1 = analyzeMotion(d, tr, { mode: 1 });
    const i = Math.round(2.5 * 60); // punch-out: throttle high
    expect(m.ly[i]).toBeLessThan(-0.5);
    expect(m1.ry[i]).toBeLessThan(-0.5);
  });
});

describe('layout', () => {
  it('matches StickHud sizing and gives even output dimensions', () => {
    const L = computeLayout({ ...DEFAULT_SETTINGS, width: 1920, height: 1080 });
    expect(L.r).toBeCloseTo(1080 * 0.17 * 0.46, 5);
    const C = computeLayout({ ...DEFAULT_SETTINGS, crop: true, cropRef: 1440 });
    expect(C.W % 2).toBe(0);
    expect(C.H % 2).toBe(0);
    expect(C.hud.x).toBeGreaterThan(0);
  });
});
