// Dev-only: cut short highlight clips out of real logs into public/samples/ (+ samples.json manifest).
// A clip = the flight's original header + a byte slice of its data; the decoder resyncs at the first I-frame.
// Run: node scripts/make-samples.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { repairLegacyDump, listFlights, readHeader, decodeFlight } from '../src/decoder/bbl.js';
import { prepare } from '../src/track.ts';

interface Clip { id: string; title: string; blurb: string; src: string; flight: number; from: number; to: number }

const FPV = '../fpvstream/flightdata/20261001/blackbox_20261001_105759.bbl';
const BMCP = '../betamcp/logs';
const clips: Clip[] = [
  { id: 'whoop-session', title: 'Whoop session', blurb: 'Indoor whoop, full-deflection stick work', src: FPV, flight: 2, from: 8, to: 25 },
  { id: 'the-tumble', title: 'The tumble', blurb: 'Snap, then a 2500°/s tumble', src: `${BMCP}/2026-09-09/btfl_013.bbl`, flight: 0, from: 28.5, to: 40 },
  { id: 'finale', title: 'Finale', blurb: 'Last ten seconds of a 94 s pack', src: `${BMCP}/2026-09-11/btfl_002.bbl`, flight: 0, from: 82, to: 94 },
];

const manifest = [];
for (const c of clips) {
  const rep = repairLegacyDump(new Uint8Array(readFileSync(c.src)));
  const f = listFlights(rep.bytes, { gaps: rep.gaps })[c.flight];
  const { dataStart } = readHeader(rep.bytes, f.range, f.opts);
  const dur = prepare(decodeFlight(rep.bytes, f.range, f.opts)).sig.duration;
  // Bytes are roughly proportional to time; keep 0.5 s of slack on both sides.
  const span = f.range.end - dataStart;
  const a = dataStart + Math.max(0, Math.floor(span * ((c.from - 0.5) / dur)));
  const b = dataStart + Math.min(span, Math.ceil(span * ((c.to + 0.5) / dur)));
  const out = new Uint8Array(dataStart - f.range.start + (b - a));
  out.set(rep.bytes.subarray(f.range.start, dataStart), 0);
  out.set(rep.bytes.subarray(a, b), dataStart - f.range.start);
  const file = `${c.id}.bbl`;
  writeFileSync(`public/samples/${file}`, out);
  // Verify the clip decodes on its own.
  const g = listFlights(out)[0];
  const d = prepare(decodeFlight(out, g.range, g.opts));
  console.log(`${file}: ${(out.length / 1024).toFixed(0)} KB, ${d.sig.duration.toFixed(1)} s, ${d.sig.n} frames, corrupt=${d.flight.stats.corrupt}`);
  manifest.push({ id: c.id, title: c.title, blurb: c.blurb, file, duration: d.sig.duration });
}
writeFileSync('public/samples/samples.json', JSON.stringify(manifest, null, 2) + '\n');
