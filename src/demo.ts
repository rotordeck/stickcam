// Synthetic freestyle flight: a scripted run of tricks so every effect has something to fire on.
// Produces the same shape as decodeFlight() so it flows through buildSignals/track/motion unchanged.
import type { DecodedFlight } from './decoder/bbl.js';

type Key = [t: number, roll: number, pitch: number, yaw: number, thr: number];

// Stick keyframes (roll/pitch/yaw -1..1, throttle 0..1). Between keys sticks ease (smoothstep).
const SCRIPT: Key[] = [
  [0.0, 0, 0, 0, 0], [0.8, 0, 0, 0, 0], [1.3, 0, 0.05, 0, 0.38], [1.7, 0.05, 0, -0.04, 0.4],
  // punch out
  [1.9, 0, 0, 0, 0.2], [2.15, 0, 0.1, 0, 1], [2.9, 0, 0.1, 0, 1], [3.1, 0, 0, 0, 0.45],
  // roll right, back flip (combo), double roll left (combo)
  [3.2, 1, 0, 0, 0.45], [3.76, 1, 0, 0, 0.45], [3.82, 0, 0, 0, 0.5],
  [4.05, 0, -1, 0, 0.45], [4.61, 0, -1, 0, 0.45], [4.67, 0, 0, 0, 0.55],
  [4.9, -1, 0, 0, 0.4], [6.02, -1, 0, 0, 0.4], [6.1, 0, 0, 0, 0.5],
  // carving
  [6.8, 0.45, 0.3, 0.5, 0.55], [7.6, -0.5, 0.35, -0.55, 0.6], [8.4, 0.5, 0.25, 0.6, 0.5], [9.2, -0.3, 0.2, -0.4, 0.55], [9.5, 0, 0, 0, 0.5],
  // yaw spin
  [9.6, 0, 0, 1, 0.5], [10.4, 0, 0, 1, 0.5], [10.5, 0, 0, 0, 0.5],
  // power loop
  [10.9, 0, 0.75, 0, 0.85], [12.4, 0, 0.75, 0, 0.85], [12.6, 0, 0, 0, 0.4],
  // corner snaps on the right stick
  [12.75, 1, 1, 0, 0.45], [12.95, -1, -1, 0, 0.45], [13.15, 1, -1, 0, 0.45], [13.35, -1, 1, 0, 0.45], [13.5, 0, 0, 0, 0.45],
  // triple flip
  [13.9, 0, 1, 0, 0.5], [15.55, 0, 1, 0, 0.5], [15.62, 0, 0, 0, 0.3],
  // dive and punch with a roll
  [16.0, 0, 0, 0, 0.05], [16.4, 0, 0, 0, 0.05], [16.65, 0, 0, 0, 1], [16.8, 1, 0, 0, 1], [17.36, 1, 0, 0, 1], [17.45, 0, 0, 0, 0.6],
  // juicy mixed carving
  [17.9, 0.7, -0.4, 0.6, 0.5], [18.4, -0.8, 0.5, -0.7, 0.65], [18.9, 0.6, 0.6, 0.3, 0.4], [19.3, 0, 0, 0, 0.35],
  // crash at 19.6, disarm at 20.1
  [19.6, 0, 0, 0, 0.35], [19.7, 0, 0, 0, 0], [21, 0, 0, 0, 0],
];
const CRASH = 19.6, DISARM = 20.1, END = 23;
const FS = 500;

const rate = (s: number) => 200 * s + 470 * s * s * s; // deg/s at stick s (≈ 670 °/s full stick)
const ease = (u: number) => u * u * (3 - 2 * u);

function sticks(t: number): [number, number, number, number] {
  let k = 0;
  while (k < SCRIPT.length - 2 && SCRIPT[k + 1][0] <= t) k++;
  const a = SCRIPT[k], b = SCRIPT[k + 1];
  const u = b[0] > a[0] ? ease(Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0])))) : 1;
  return [1, 2, 3, 4].map((i) => a[i] + (b[i] - a[i]) * u) as [number, number, number, number];
}

export function makeFreestyleDemo(seed = 7): DecodedFlight {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296 - 0.5; };
  const n = Math.round(END * FS);
  const names = ['time', 'rcCommand[0]', 'rcCommand[1]', 'rcCommand[2]', 'rcCommand[3]', 'gyroADC[0]', 'gyroADC[1]', 'gyroADC[2]',
    'accSmooth[0]', 'accSmooth[1]', 'accSmooth[2]', 'motor[0]', 'motor[1]', 'motor[2]', 'motor[3]'];
  const cols: Record<string, Float64Array> = Object.fromEntries(names.map((k) => [k, new Float64Array(n)]));
  const g = [0, 0, 0];
  const lag = 1 - Math.exp(-1 / (0.03 * FS)); // ~30 ms rate response
  for (let i = 0; i < n; i++) {
    const t = i / FS;
    const [r, p, y, th] = t < DISARM ? sticks(t) : [0, 0, 0, 0];
    cols.time[i] = 1_000_000 + Math.round(t * 1e6);
    cols['rcCommand[0]'][i] = Math.round(r * 500 + rnd() * 3);
    cols['rcCommand[1]'][i] = Math.round(p * 500 + rnd() * 3);
    cols['rcCommand[2]'][i] = Math.round(y * 500 + rnd() * 3);
    cols['rcCommand[3]'][i] = Math.round(1000 + th * 1000);
    const crashed = t >= CRASH && t < DISARM;
    const target = crashed
      ? [1800 * Math.sin(t * 41), -2200 * Math.cos(t * 37), 900 * Math.sin(t * 23)]
      : t < 0.8 || t >= DISARM ? [0, 0, 0] : [rate(r), rate(p), rate(y)];
    for (let a = 0; a < 3; a++) {
      g[a] += (crashed ? 0.5 : lag) * (target[a] - g[a]);
      cols[`gyroADC[${a}]`][i] = Math.round(g[a] + rnd() * (t < 0.8 ? 2 : 12));
    }
    const hit = t >= CRASH && t < CRASH + 0.06 ? 9 : 0;
    cols['accSmooth[0]'][i] = Math.round((rnd() * 0.3 + hit * 0.6) * 2048);
    cols['accSmooth[1]'][i] = Math.round((rnd() * 0.3 - hit * 0.5) * 2048);
    cols['accSmooth[2]'][i] = Math.round((1 + th * 1.5 + rnd() * 0.3 + hit * 0.6) * 2048);
    for (let m = 0; m < 4; m++) {
      const out = t >= DISARM || t < 0.8 ? 0 : 0.06 + th * 0.88 + rnd() * 0.04;
      cols[`motor[${m}]`][i] = Math.round(158 + out * (2047 - 158));
    }
  }
  const raw: Record<string, string> = { 'Firmware revision': 'Betaflight (stickcam demo)', 'Craft name': 'Freestyle demo', maxthrottle: '2000' };
  const header = { raw, defs: {}, firmware: raw['Firmware revision'], craft: raw['Craft name'], looptime: 125, minthrottle: 1000, maxthrottle: 2000,
    motorOutput: [158, 2047] as [number, number], gyroScale: 1, motorPoles: 14, acc1G: 2048 };
  return {
    header, fields: names, n, cols, events: [], stats: {}, quality: new Uint8Array(n),
    slow: { names: ['flightModeFlags'], frames: [{ n: 0, values: [1] }, { n: Math.round(DISARM * FS), values: [0] }] },
    gps: null, byteRange: { start: 0, end: 0 },
  };
}
