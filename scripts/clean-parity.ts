// Dev-only: the DVR clean stages (src/clean/) against FPV DVR Cleaner's Python engine on real footage.
// Dumps frames with ffmpeg, runs each stage in both engines on the same input, and prints PSNR of ours
// vs Python plus each engine's mean change vs its input, and our single-threaded ms/frame.
// Run: node scripts/clean-parity.ts <video> [--start s] [--frames n] [--denoise 0..100] [--keep]
// (--keep leaves the raw rgb24 inputs and outputs in the temp folder it prints.)
// Python side (scripts/clean_ref.py): CLEANER_SRC = the cleaner's src/ (FPV_DVR_CLEANER @ 264d232),
// CLEANER_PY = a Python with numpy + opencv-python-headless (default python3). Skipped without them.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChromaFrame, damage } from '../src/clean/analog.ts';
import type { Flow } from '../src/clean/flow.ts';
import { repairRange } from '../src/clean/frames.ts';
import * as fuse from '../src/clean/fuse.ts';
import type { Plane, Rgba } from '../src/clean/image.ts';
import { repairChain, tuning, type CleanOptions } from '../src/clean/repair.ts';

const args = process.argv.slice(2);
const opt = (name: string, def: number) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : def; };
const video = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!video) { console.error('usage: node scripts/clean-parity.ts <video> [--start s] [--frames n] [--denoise 0..100]'); process.exit(1); }
const start = opt('start', 100), n = opt('frames', 24), denoise = opt('denoise', 50);
const COLOUR = 35, BREAKUPS = 50, LIFT = 15 / 50;

// ---------- frames ----------

const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', video], { encoding: 'utf8' });
const [w, h] = probe.stdout.trim().split(',').map(Number);
if (!w || !h) { console.error(`ffprobe failed: ${probe.stderr}`); process.exit(1); }
const dump = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(start), '-i', video, '-frames:v', String(n), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: w * h * 3 * n + 1024 });
if (dump.status !== 0 || dump.stdout.length !== w * h * 3 * n) { console.error(`ffmpeg failed: ${dump.stderr}`); process.exit(1); }

const fromRgb = (buf: Uint8Array, i: number): Rgba => {
  const d = new Uint8ClampedArray(w * h * 4), s = buf.subarray(i * w * h * 3);
  for (let p = 0, j = 0; p < w * h * 3; p += 3, j += 4) { d[j] = s[p]; d[j + 1] = s[p + 1]; d[j + 2] = s[p + 2]; d[j + 3] = 255; }
  return { w, h, d };
};
const toRgb = (frames: Rgba[]) => {
  const out = new Uint8Array(w * h * 3 * frames.length);
  frames.forEach((f, i) => { for (let p = 0, j = 0, o = i * w * h * 3; j < f.d.length; p += 3, j += 4) { out[o + p] = f.d[j]; out[o + p + 1] = f.d[j + 1]; out[o + p + 2] = f.d[j + 2]; } });
  return out;
};
const input = Array.from({ length: n }, (_, i) => fromRgb(dump.stdout, i));

/** HDZero-like confetti: random-colour 16 px blocks (15 %) in every 4th frame; the frames themselves are the truth. */
function confetti(frames: Rgba[]): Rgba[] {
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  return frames.map((f, t) => {
    if (t % 4 !== 2) return f;
    const g = { w, h, d: f.d.slice() };
    for (let by = 1; by < Math.floor(h / 16) - 1; by++) for (let bx = 1; bx < Math.floor(w / 16) - 1; bx++) {
      if (rnd() >= 0.15) continue;
      for (let y = by * 16; y < by * 16 + 16; y++) for (let x = bx * 16; x < bx * 16 + 16; x++) {
        const j = (y * w + x) * 4;
        g.d[j] = rnd() * 255; g.d[j + 1] = rnd() * 255; g.d[j + 2] = rnd() * 255;
      }
    }
    return g;
  });
}
const broken = confetti(input);

// ---------- ours ----------

const base: CleanOptions = { kind: 'analog', amount: 0, denoise: 0, osd: false, damageOnly: false };
function ours(o: Partial<CleanOptions>, frames: Rgba[], adaptive = false) {
  tuning.adaptiveWindow = adaptive;
  const t0 = performance.now(), out = repairChain({ ...base, ...o }, frames, 0, frames.length);
  return { out, ms: (performance.now() - t0) / frames.length };
}
// Warm the JIT up so the first stage's timing isn't inflated.
ours({ amount: COLOUR, denoise }, input.slice(0, 6));
ours({ kind: 'hdzero', amount: BREAKUPS }, broken.slice(0, 6));
const zeroFlow = (a: Plane): Flow => ({ w: a.w, h: a.h, fx: new Float32Array(a.w * a.h), fy: new Float32Array(a.w * a.h) });
const fusion0 = repairRange(input, 0, n, fuse.RADIUS, (f) => new fuse.LumaFrame(f), (win, c) => fuse.fuseWindow(win, c, { calm: denoise / 100, lift: LIFT, flow: zeroFlow }));
const runs = {
  colour: ours({ amount: COLOUR }, input),
  colourWide: ours({ amount: COLOUR }, input, true),
  damageOnly: ours({ amount: COLOUR, damageOnly: true }, input),
  breakups: ours({ kind: 'hdzero', amount: BREAKUPS }, broken),
  fusion: ours({ denoise }, input),
  chain: ours({ amount: COLOUR, denoise }, input),
};

// ---------- compare ----------

function psnr(a: Uint8Array, b: Uint8Array) {
  let se = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; se += d * d; }
  return se ? 10 * Math.log10((255 * 255) / (se / a.length)) : Infinity;
}
function change(a: Uint8Array, b: Uint8Array) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}
const db = (v: number) => (v === Infinity ? '   inf' : v.toFixed(2).padStart(6));
const lv = (v: number) => v.toFixed(3).padStart(6);

const raw = toRgb(input), rawBroken = toRgb(broken);
const untouched = runs.damageOnly.out.filter((f, i) => f === input[i]).length;
console.log(`${video} @ ${start} s, ${n} frames ${w}×${h}; colour ${COLOUR}, breakups ${BREAKUPS}, denoise ${denoise} (lift ${LIFT})`);
console.log('\nours, single-threaded:');
console.log(`  colour            ${runs.colour.ms.toFixed(1)} ms/frame`);
console.log(`  colour, wide on   ${runs.colourWide.ms.toFixed(1)} ms/frame (vs wide off: ${db(psnr(toRgb(runs.colourWide.out), toRgb(runs.colour.out)))} dB)`);
console.log(`  colour, dmg only  ${runs.damageOnly.ms.toFixed(1)} ms/frame, ${untouched}/${n} frames untouched`);
const prepared = input.map((f) => new ChromaFrame(f));
const scores = prepared.map((_, i) => damage(prepared.slice(Math.max(0, i - 3), i + 4), Math.min(i, 3)));
console.log(`    damage per frame (dropout/tears/bands, % of frame): ${scores.map((s) => [s.dropout, s.tears, s.bands].map((v) => (100 * v).toFixed(1)).join('/')).join('  ')}`);
console.log(`    full repair's change per frame (mean |Δ|): ${runs.colour.out.map((f, i) => change(toRgb([f]), toRgb([input[i]])).toFixed(1)).join(' ')}`);
console.log(`  breakups          ${runs.breakups.ms.toFixed(1)} ms/frame`);
console.log(`  fusion            ${runs.fusion.ms.toFixed(1)} ms/frame`);
console.log(`  colour → fusion   ${runs.chain.ms.toFixed(1)} ms/frame`);

const src = process.env.CLEANER_SRC, py = process.env.CLEANER_PY || 'python3';
const check = src ? spawnSync(py, ['-I', '-c', 'import numpy, cv2'], { encoding: 'utf8' }) : null;
if (!src || !check || check.status !== 0) {
  console.log(`\nPython reference skipped: set CLEANER_SRC (FPV_DVR_CLEANER/src) and CLEANER_PY (a Python with numpy + opencv)${check?.stderr ? `\n  ${check.stderr.trim().split('\n').pop()}` : ''}`);
  process.exit(0);
}

const dir = mkdtempSync(join(tmpdir(), 'clean-parity-'));
try {
  writeFileSync(join(dir, 'input.rgb'), raw);
  writeFileSync(join(dir, 'broken.rgb'), rawBroken);
  const stage = (name: string, inp: string, extra: object) => ({ name, input: join(dir, inp), output: join(dir, `${name}.out.rgb`), ...extra });
  const job = { w, h, n, stages: [
    stage('colour', 'input.rgb', { amount: COLOUR }),
    stage('breakups', 'broken.rgb', { amount: BREAKUPS }),
    stage('fusion', 'input.rgb', { calm: denoise / 100, lift: LIFT }),
    stage('fusion0', 'input.rgb', { calm: denoise / 100, lift: LIFT }),
    stage('chain', 'input.rgb', { amount: COLOUR, calm: denoise / 100, lift: LIFT }),
  ] };
  writeFileSync(join(dir, 'job.json'), JSON.stringify(job));
  const t0 = performance.now();
  const ref = spawnSync(py, ['-I', new URL('./clean_ref.py', import.meta.url).pathname, join(dir, 'job.json')], { encoding: 'utf8', env: { ...process.env, CLEANER_SRC: src } });
  if (ref.status !== 0) { console.error(`clean_ref.py failed:\n${ref.stderr}`); process.exit(1); }
  console.log(`\nPython reference: ${((performance.now() - t0) / 1000).toFixed(1)} s for all stages (thread pool)`);
  const theirs = (name: string) => new Uint8Array(readFileSync(join(dir, `${name}.out.rgb`)));

  console.log('\nstage             ours vs Py   change vs input: ours  Python   (mean |Δ| per channel, 0..255)');
  const row = (label: string, mine: Rgba[], name: string, inp: Uint8Array) => {
    const a = toRgb(mine), b = theirs(name);
    console.log(`  ${label.padEnd(16)} ${db(psnr(a, b))} dB            ${lv(change(a, inp))} ${lv(change(b, inp))}`);
    return { a, b };
  };
  row('colour', runs.colour.out, 'colour', raw);
  row('colour, wide on', runs.colourWide.out, 'colour', raw);
  const bk = row('breakups', runs.breakups.out, 'breakups', rawBroken);
  row('fusion', runs.fusion.out, 'fusion', raw);
  row('fusion, 0 flow', fusion0, 'fusion0', raw);
  row('colour → fusion', runs.chain.out, 'chain', raw);
  console.log(`\nbreakups vs the clean frames: ours ${db(psnr(bk.a, raw))} dB, Python ${db(psnr(bk.b, raw))} dB, confetti input ${db(psnr(rawBroken, raw))} dB`);
} finally {
  if (args.includes('--keep')) console.log(`\nkept ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
}
