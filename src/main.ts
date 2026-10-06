import '@fontsource/bungee/400.css';
import '@fontsource/orbitron/900.css';
import '@fontsource/vt323/400.css';
import '@fontsource/fredoka/700.css';
import { decodeFlight, listFlights, repairLegacyDump, type FlightInfo } from './decoder/bbl.js';
import { buildTrack, prepare, type FlightData, type Track } from './track.ts';
import { analyzeMotion, type Motion } from './motion.ts';
import { makeFreestyleDemo } from './demo.ts';
import { PRESETS, presetById, type Style } from './render/style.ts';
import { DEFAULT_SETTINGS, SIZE_PRESETS, computeLayout, type Settings } from './render/layout.ts';
import { createScene, renderFrame, type Scene } from './render/draw.ts';
import { capabilities, runExport, type Format } from './export/export.ts';
import { analyzeFlow, openVideo, type VideoInfo } from './video.ts';
import { initFcDialog } from './fc/dialog.ts';
import { FcLink, fcSupported, pullDataflash } from './fc/fc.ts';
import { findOffset, type SyncResult } from './sync.ts';
import {
  LOOK_SETTINGS, applyImport, defaultChoices, exportFile, findByName, loadPresets, lookEquals, newId, parseImport, planImport, sanitizeLook, savePresets,
  type ImportChoice, type ImportItem, type Look, type UserPreset,
} from './presets.ts';

// ---------- state ----------

type OutFormat = 'webm' | 'prores' | 'mp4-black' | 'mp4-green' | 'burn';

const S = {
  name: '',
  bytes: null as Uint8Array | null,
  flights: [] as FlightInfo[],
  gaps: [] as number[],
  flightIdx: 0,
  data: null as FlightData | null,
  full: null as { track: Track; motion: Motion } | null, // whole flight at 30 fps for the timeline
  trim: [0, 0] as [number, number],
  presetId: 'arcade',
  overrides: {} as Partial<Style>,
  settings: { ...DEFAULT_SETTINGS } as Settings,
  sizeId: '1080p',
  format: 'webm' as OutFormat,
  cur: null as { track: Track; motion: Motion } | null,
  scene: null as Scene | null,
  frame: 0,
  playing: false,
  video: null as VideoInfo | null,
  /** log time = video time + offset (s). */
  offset: 0,
};

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const preview = $<HTMLCanvasElement>('preview');
const pctx = preview.getContext('2d')!;
const stage = $('stage');
const style = (): Style => ({ ...presetById(S.presetId).style, ...S.overrides });
const BASE = import.meta.env.BASE_URL;

function status(msg: string, err = false) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('err', err);
}

// ---------- share state in the URL hash ----------

function saveHash() {
  const { mode, size, gap, position, chaos, fps, offsetX, offsetY } = S.settings;
  const st = { p: S.presetId, o: S.overrides, s: { mode, size, gap, position, chaos, fps, offsetX, offsetY }, z: S.sizeId, f: S.format };
  history.replaceState(null, '', '#' + btoa(unescape(encodeURIComponent(JSON.stringify(st)))));
  markUserPresets(); // every look change ends up here
}
function loadHash() {
  try {
    if (location.hash.length < 2) return;
    const st = JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(1)))));
    if (st.p && PRESETS.some((p) => p.id === st.p)) S.presetId = st.p;
    if (st.o && typeof st.o === 'object') S.overrides = st.o;
    if (st.s) Object.assign(S.settings, st.s);
    if (st.z && SIZE_PRESETS.some((z) => z.id === st.z)) S.sizeId = st.z;
    if (st.f) S.format = st.f;
  } catch { /* ignore a bad hash */ }
}

// ---------- loading ----------

async function loadBytes(bytes: Uint8Array, name: string) {
  status(`Reading ${name}…`);
  await new Promise((r) => setTimeout(r, 0));
  try {
    const rep = repairLegacyDump(bytes);
    const flights = listFlights(rep.bytes, { gaps: rep.gaps });
    if (!flights.length) throw new Error('No Betaflight blackbox flights found in this file.');
    Object.assign(S, { name, bytes: rep.bytes, flights, gaps: rep.gaps });
    decoded.clear();
    // Default to the biggest flight (most flying).
    let best = 0;
    flights.forEach((f, i) => { if (f.size > flights[best].size) best = i; });
    renderFlightList();
    await selectFlight(best);
  } catch (e) {
    status((e as Error).message, true);
  }
}

async function selectFlight(i: number) {
  if (!S.bytes) return;
  S.flightIdx = i;
  status(`Decoding flight ${i + 1}…`);
  await new Promise((r) => setTimeout(r, 0));
  const data = decodeCached(i);
  renderFlightList();
  setData(data);
  const h = data.flight.header;
  status(`${h.craft || 'Unnamed craft'} · ${h.firmware} · ${data.sig.duration.toFixed(1)} s · ${Math.round(data.sig.fs)} Hz`);
  // A log made with RC or gyro logging switched off can't drive the overlay: point at the fix.
  if (!data.sig.stick[0]) status('This log has no RC commands, so there are no sticks to show. Switch RC logging on (Logging settings…) and fly again.', true);
  else if (!data.sig.gyro[0]) status(`${$('status').textContent} · no gyro in this log: tricks and video auto-sync are unavailable (Logging settings…).`, true);
}

function loadDemo() {
  Object.assign(S, { name: 'freestyle-demo', bytes: null, flights: [] });
  renderFlightList();
  setData(prepare(makeFreestyleDemo()));
  status('Synthetic freestyle run: flips, rolls, a spin, punch-outs, snaps and a crash.');
}

function renderFlightList() {
  const el = $('flights');
  el.innerHTML = '';
  if (S.flights.length < 2) return;
  S.flights.forEach((f, i) => {
    const b = document.createElement('button');
    b.className = 'flight' + (i === S.flightIdx ? ' on' : '');
    b.innerHTML = `<span>Flight ${i + 1}</span><small>${(f.size / 1024).toFixed(0)} KB</small>`;
    b.onclick = () => selectFlight(i);
    el.appendChild(b);
  });
}

function setData(data: FlightData) {
  const dur = data.sig.duration;
  const [a, b] = data.armed;
  if (!S.video) S.trim = b - a > 1 ? [Math.max(0, a - 0.5), Math.min(dur, b + 2.5)] : [0, dur];
  S.frame = 0;
  setDataKeepClock(data);
  renderSyncBar();
  if (S.video && S.bytes && !S.video.flow) void autoSync();
  else if (S.video && S.bytes && S.video.flow) {
    // A new flight against an analysed video: re-match quickly with the cached motion.
    const res = findOffset(S.video.flow, data.sig);
    if (res && res.margin >= 0.06) {
      S.offset = res.offset;
      rebuildCur(); drawTimeline(); renderSyncBar();
      setSyncNote(`Auto-synced: flight starts at ${fmtTime(-res.offset)} in the video (r=${res.score.toFixed(2)}).`, res.margin < 0.1);
    }
  }
}

/** Swap the flight without touching the trim/clock (used by auto-sync). */
function setDataKeepClock(data: FlightData) {
  S.data = data;
  const track = buildTrack(data, 30, 0, data.sig.duration);
  S.full = { track, motion: analyzeMotion(data, track, { mode: S.settings.mode }) };
  rebuildCur();
  drawTimeline();
  $('empty').hidden = true;
  $<HTMLButtonElement>('play').disabled = false;
  $<HTMLButtonElement>('export').disabled = false;
}

// ---------- pipeline ----------
// Clock: without a video the timeline is the flight's own time. With a video, the video is the master clock:
// timeline / trim / playhead are video seconds, and log time = video time + S.offset.

const off = () => (S.video ? S.offset : 0);
const axisDur = () => (S.video ? S.video.duration : S.data?.sig.duration ?? 1);

function outputSettings(): Settings {
  if (S.sizeId === 'video' && S.video) return { ...S.settings, crop: false, width: S.video.width, height: S.video.height };
  const z = SIZE_PRESETS.find((p) => p.id === S.sizeId) ?? SIZE_PRESETS[1];
  return { ...S.settings, crop: !!z.crop, width: z.w || 1920, height: z.h || 1080 };
}

function rebuildCur() {
  if (!S.data) return;
  const fps = S.settings.fps;
  const track = buildTrack(S.data, fps, S.trim[0] + off(), S.trim[1] + off());
  S.cur = { track, motion: analyzeMotion(S.data, track, { mode: S.settings.mode }) };
  S.frame = Math.min(S.frame, track.frames - 1);
  rebuildScene();
  renderThumbs();
}

function rebuildScene() {
  if (!S.cur) return;
  const set = outputSettings();
  const L = computeLayout(set);
  const box = stage.getBoundingClientRect();
  const dpr = Math.min(2, devicePixelRatio || 1);
  const fit = Math.min((box.width - 16) / L.W, (box.height - 16) / L.H);
  // Display at the fitted size (small outputs scale up); render at device resolution, capped for speed.
  const scale = Math.min(fit * dpr, 2);
  S.scene = createScene(S.cur.track, S.cur.motion, style(), set, scale);
  preview.width = Math.round(L.W * scale);
  preview.height = Math.round(L.H * scale);
  const cssW = `${Math.floor(L.W * fit)}px`, cssH = `${Math.floor(L.H * fit)}px`;
  frameEl.style.width = cssW; frameEl.style.height = cssH;
  // The video only lines up with full-frame layouts of its own aspect ratio.
  const showVideo = !!S.video && !set.crop && Math.abs(set.width / set.height - S.video.width / S.video.height) < 0.02;
  vid.hidden = !showVideo;
  stage.classList.toggle('has-video', showVideo);
  draw();
  updateHint();
}

// The Sky preview background flies with the sticks while playing: roll banks the horizon, pitch moves it.
// Preview only (a DOM layer under the canvas), never exported. The pose is a pure function of the frame,
// a mean over the last SKY_WIN seconds of sticks, so it stays smooth and seeking can't make it drift.
const skyWorld = $('skyWorld');
const SKY_WIN = 0.3, SKY_BANK = 32, SKY_PITCH = 0.12; // s, degrees at full roll, horizon shift (fraction of world) at full pitch
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
function updateSky() {
  const fly = S.playing && !!S.cur && !reducedMotion.matches && stage.dataset.bg === 'sky' && !S.video;
  skyWorld.classList.toggle('flying', fly);
  if (!fly) { skyWorld.style.transform = ''; return; }
  const { roll, pitch, live, fps } = S.cur!.track;
  const n = Math.max(1, Math.round(SKY_WIN * fps));
  let r = 0, p = 0;
  for (let i = Math.max(0, S.frame - n + 1); i <= S.frame; i++) if (live[i]) { r += roll[i]; p += pitch[i]; }
  r /= n; p /= n;
  skyWorld.style.transform = `translateY(${(-p * SKY_PITCH * 100).toFixed(2)}%) rotate(${(-r * SKY_BANK).toFixed(2)}deg)`;
}

function draw() {
  if (!S.scene) return;
  renderFrame(pctx, S.scene, S.frame, null);
  updateSky();
  const t = S.trim[0] + S.frame / S.settings.fps;
  $('time').textContent = fmtTime(t);
  placeHead();
}

const fmtTime = (t: number) => `${t < 0 ? '-' : ''}${Math.floor(Math.abs(t) / 60)}:${(Math.abs(t) % 60).toFixed(2).padStart(5, '0')}`;

/** Show frame i: with a video, seek it too (the overlay draws immediately, the picture follows). */
function seekFrame(i: number) {
  if (!S.cur) return;
  S.frame = Math.max(0, Math.min(S.cur.track.frames - 1, i));
  if (S.video && !S.playing) vid.currentTime = S.trim[0] + S.frame / S.settings.fps + 1e-3;
  draw();
}

// ---------- playback ----------

let raf = 0, playT0 = 0, playF0 = 0;
function setPlaying(on: boolean) {
  S.playing = on && !!S.cur;
  $('play').textContent = S.playing ? '❚❚' : '▶';
  updateSky(); // pausing eases the horizon back to level
  cancelAnimationFrame(raf);
  if (!S.playing) { if (S.video) vid.pause(); return; }
  if (S.video) {
    vid.currentTime = S.trim[0] + S.frame / S.settings.fps;
    void vid.play();
    const tick = () => {
      if (!S.playing) return;
      let t = vid.currentTime;
      if (t >= S.trim[1] || vid.ended) { t = S.trim[0]; vid.currentTime = t; if (vid.paused) void vid.play(); }
      S.frame = Math.max(0, Math.min(S.cur!.track.frames - 1, Math.round((t - S.trim[0]) * S.settings.fps)));
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return;
  }
  playT0 = performance.now(); playF0 = S.frame;
  const tick = (now: number) => {
    const n = S.cur!.track.frames;
    S.frame = (playF0 + Math.floor(((now - playT0) / 1000) * S.settings.fps)) % n;
    draw();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}
$('play').onclick = () => setPlaying(!S.playing);
addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('input, select, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); setPlaying(!S.playing); }
  if (S.cur && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
    setPlaying(false);
    seekFrame(S.frame + (e.code === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1));
  }
});

// ---------- timeline ----------
// With a video: the top lane is the flight (drag it to sync), the bottom lane is the video (scrub, trim).

const tl = $<HTMLCanvasElement>('tl'), tlBox = $('timeline'), trimEl = $('trim'), head = $('head');
const xOf = (t: number) => (t / axisDur()) * tlBox.clientWidth;
const tOf = (x: number) => Math.max(0, Math.min(axisDur(), (x / tlBox.clientWidth) * axisDur()));
const FLIGHT_LANE = 0.58; // fraction of the timeline height used by the flight lane when a video is loaded

function drawTimeline() {
  const dpr = devicePixelRatio || 1;
  tl.width = tlBox.clientWidth * dpr; tl.height = tlBox.clientHeight * dpr;
  const c = tl.getContext('2d')!;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = tlBox.clientWidth, H = tlBox.clientHeight;
  c.clearRect(0, 0, w, H);
  if (!S.full || !S.data) return;
  const { track, motion } = S.full;
  const n = track.frames, ldur = S.data.sig.duration;
  const h = S.video ? Math.round(H * FLIGHT_LANE) : H;
  // flight time → x (shifted onto the video clock when there is one)
  const fx = (lt: number) => xOf(lt - off());
  const x0 = Math.max(0, fx(0)), x1 = Math.min(w, fx(ldur));
  if (S.video) {
    // video lane
    c.fillStyle = 'rgba(41,231,255,0.10)'; c.fillRect(0, h + 3, w, H - h - 6);
    c.fillStyle = 'rgba(41,231,255,0.55)'; c.font = '600 10px system-ui'; c.textBaseline = 'middle';
    c.fillText(`VIDEO ${fmtTime(S.video.duration)}`, 6, h + (H - h) / 2);
    // flight block
    c.fillStyle = dragging === 'shift' ? 'rgba(255,225,77,0.16)' : 'rgba(255,255,255,0.06)';
    c.fillRect(fx(0), 1, fx(ldur) - fx(0), h - 2);
    c.strokeStyle = 'rgba(255,225,77,0.6)'; c.lineWidth = 1;
    c.strokeRect(fx(0) + 0.5, 1.5, fx(ldur) - fx(0) - 1, h - 3);
  }
  const iAt = (x: number) => Math.floor(((tOf(x) + off()) / ldur) * n);
  // throttle (area) and stick activity (line)
  c.fillStyle = 'rgba(255,122,26,0.18)';
  c.beginPath(); c.moveTo(x0, h);
  for (let x = Math.floor(x0); x < x1; x++) { const i = iAt(x); if (i >= 0 && i < n) c.lineTo(x, h - track.throttle[i] * (h - 8)); }
  c.lineTo(x1, h); c.fill();
  c.strokeStyle = 'rgba(236,236,243,0.75)'; c.lineWidth = 1;
  c.beginPath();
  let started = false;
  for (let x = Math.floor(x0); x < x1; x++) {
    const a = iAt(x), b = Math.max(a + 1, iAt(x + 1));
    if (a < 0 || a >= n) continue;
    let m = 0; for (let i = a; i < b && i < n; i++) m = Math.max(m, motion.speedL[i] + motion.speedR[i]);
    const y = h - 4 - Math.min(1, m / 14) * (h - 12);
    started ? c.lineTo(x, y) : c.moveTo(x, y);
    started = true;
  }
  c.stroke();
  const colors: Record<string, string> = { flip: '#ffe14d', roll: '#ffe14d', spin: '#ffe14d', snap: '#29e7ff', punch: '#ff7a1a', crash: '#ff3b3b' };
  for (const e of motion.events) {
    const col = colors[e.kind];
    if (!col) continue;
    c.fillStyle = col;
    c.beginPath(); c.arc(fx((e.frame / n) * ldur), e.kind === 'snap' ? h - 8 : 9, e.kind === 'snap' ? 2.5 : 4, 0, Math.PI * 2); c.fill();
  }
  placeTrim();
  placeHead();
}
function placeTrim() {
  trimEl.style.left = `${xOf(S.trim[0])}px`;
  trimEl.style.width = `${Math.max(4, xOf(S.trim[1]) - xOf(S.trim[0]))}px`;
}
function placeHead() {
  head.style.left = `${xOf(S.trim[0] + S.frame / S.settings.fps)}px`;
}

let dragging: 'in' | 'out' | 'scrub' | 'shift' | null = null;
let shiftFrom = { t: 0, offset: 0 };
let shiftRaf = 0;
tlBox.addEventListener('pointerdown', (e) => {
  if (!S.data) return;
  const t = e.target as HTMLElement;
  const box = tlBox.getBoundingClientRect();
  const inFlightLane = !!S.video && e.clientY - box.top < box.height * FLIGHT_LANE;
  dragging = t.id === 'hin' ? 'in' : t.id === 'hout' ? 'out' : inFlightLane ? 'shift' : 'scrub';
  shiftFrom = { t: tOf(e.clientX - box.left), offset: S.offset };
  tlBox.setPointerCapture(e.pointerId);
  setPlaying(false);
  onDrag(e);
});
tlBox.addEventListener('pointermove', (e) => {
  if (dragging) onDrag(e);
  else if (S.video) {
    const box = tlBox.getBoundingClientRect();
    tlBox.style.cursor = e.clientY - box.top < box.height * FLIGHT_LANE ? 'grab' : 'pointer';
  }
});
tlBox.addEventListener('pointerup', () => {
  if (dragging === 'in' || dragging === 'out') rebuildCur();
  if (dragging === 'shift') { setSyncNote(`Synced by hand: flight starts at ${fmtTime(-S.offset)} in the video.`); drawTimeline(); }
  dragging = null;
});
function onDrag(e: PointerEvent) {
  const t = tOf(e.clientX - tlBox.getBoundingClientRect().left);
  if (dragging === 'in') { S.trim[0] = Math.min(t, S.trim[1] - 0.5); placeTrim(); }
  else if (dragging === 'out') { S.trim[1] = Math.max(t, S.trim[0] + 0.5); placeTrim(); }
  else if (dragging === 'scrub' && S.cur) seekFrame(Math.round((t - S.trim[0]) * S.settings.fps));
  else if (dragging === 'shift') {
    // Dragging the flight right means it starts later in the video: offset decreases.
    S.offset = shiftFrom.offset - (t - shiftFrom.t);
    cancelAnimationFrame(shiftRaf);
    shiftRaf = requestAnimationFrame(() => { rebuildCur(); drawTimeline(); renderSyncBar(); });
  }
}

// ---------- video + sync ----------

const vid = $<HTMLVideoElement>('vid');
const frameEl = $('frame');
let syncAbort: AbortController | null = null;

async function loadVideo(file: File) {
  setPlaying(false);
  syncAbort?.abort();
  try {
    setSyncNote(`Opening ${file.name}…`);
    $('syncbar').hidden = false;
    const v = await openVideo(file);
    if (S.video) URL.revokeObjectURL(S.video.url);
    S.video = v;
    vid.src = v.url;
    S.sizeId = 'video';
    S.settings.fps = v.fps;
    S.trim = [0, v.duration];
    S.frame = 0;
    buildOutput();
    if (!S.data) { setSyncNote('Video loaded. Now load the blackbox log for this flight.'); renderSyncBar(); return; }
    rebuildCur();
    drawTimeline();
    renderSyncBar();
    if (S.bytes) await autoSync();
    else setSyncNote('Load your own log (not the demo) to auto-sync. You can drag the flight lane to line it up by hand.');
  } catch (e) {
    setSyncNote((e as Error).message, true);
  }
}

function removeVideo() {
  setPlaying(false);
  syncAbort?.abort();
  if (S.video) URL.revokeObjectURL(S.video.url);
  S.video = null; S.offset = 0;
  vid.removeAttribute('src'); vid.load();
  $('syncbar').hidden = true;
  if (S.sizeId === 'video') S.sizeId = '1080p';
  buildOutput();
  if (S.data) setData(S.data);
}

/** Correlate video motion with the gyro of every flight in the file; pick the best match. */
async function autoSync() {
  if (!S.video || !S.bytes) return;
  syncAbort?.abort();
  const ac = (syncAbort = new AbortController());
  const v = S.video;
  try {
    const flow = await analyzeFlow(v, (t) => setSyncNote(`Reading video motion… ${Math.round((t / v.duration) * 100)}%`), ac.signal);
    setSyncNote('Matching against the gyro…');
    await new Promise((r) => setTimeout(r, 0));
    let best: { idx: number; res: SyncResult } | null = null;
    for (let i = 0; i < S.flights.length; i++) {
      const data = i === S.flightIdx ? S.data! : decodeCached(i);
      if (data.sig.duration < 4) continue;
      const res = findOffset(flow, data.sig);
      if (res && (!best || res.score * (0.5 + res.margin) > best.res.score * (0.5 + best.res.margin))) best = { idx: i, res };
    }
    if (ac.signal.aborted) return;
    if (!best || best.res.margin < 0.06) {
      setSyncNote('Couldn\'t find a confident match (not enough motion?). Drag the flight lane to line it up by hand.', true);
      return;
    }
    const { idx, res } = best;
    const conf = res.margin > 0.2 && res.score > 0.4 ? 'high' : res.margin > 0.1 ? 'medium' : 'low';
    if (idx !== S.flightIdx) { S.flightIdx = idx; renderFlightList(); setDataKeepClock(decodeCached(idx)); }
    S.offset = res.offset;
    rebuildCur(); drawTimeline(); renderSyncBar();
    const which = S.flights.length > 1 ? `Flight ${idx + 1}` : 'The flight';
    setSyncNote(`Auto-synced: ${which} starts at ${fmtTime(-res.offset)} in the video · confidence ${conf} (r=${res.score.toFixed(2)}). Check it, then nudge if needed.`, conf === 'low');
  } catch (e) {
    if ((e as Error).name !== 'AbortError') setSyncNote(`Auto-sync failed: ${(e as Error).message}`, true);
  }
}

const decoded = new Map<number, FlightData>();
function decodeCached(i: number): FlightData {
  let d = decoded.get(i);
  if (!d) {
    const f = S.flights[i];
    d = prepare(decodeFlight(S.bytes!, f.range, f.opts));
    decoded.set(i, d);
  }
  return d;
}

function setSyncNote(msg: string, warn = false) {
  const el = $('syncNote');
  el.textContent = msg;
  el.classList.toggle('warn', warn);
}

function renderSyncBar() {
  const el = $('syncCtl');
  el.innerHTML = '';
  if (!S.video) return;
  const fps = S.video.fps;
  const btn = (label: string, title: string, fn: () => void) => {
    const b = document.createElement('button'); b.textContent = label; b.title = title; b.onclick = fn; el.appendChild(b); return b;
  };
  const nudge = (d: number) => () => { S.offset += d; rebuildCur(); drawTimeline(); renderSyncBar(); setSyncNote(`Synced by hand: flight starts at ${fmtTime(-S.offset)} in the video.`); };
  const lbl = document.createElement('span');
  lbl.className = 'sync-at';
  lbl.textContent = S.data ? `flight @ ${fmtTime(-S.offset)}` : '';
  el.appendChild(lbl);
  // Moving the flight later in the video = smaller offset.
  btn('−1 s', 'Flight 1 s earlier in the video', nudge(1));
  btn('−1 f', 'Flight 1 frame earlier', nudge(1 / fps));
  btn('+1 f', 'Flight 1 frame later', nudge(-1 / fps));
  btn('+1 s', 'Flight 1 s later in the video', nudge(-1));
  const sep = document.createElement('i'); el.appendChild(sep);
  btn('Auto-sync', 'Match video motion against the gyro', () => void autoSync()).disabled = !S.bytes;
  btn('Trim to flight', 'Export only the part of the video where the flight is', () => {
    if (!S.data || !S.video) return;
    const [a, b] = S.data.armed;
    S.trim = [Math.max(0, a - 1 - S.offset), Math.min(S.video.duration, b + 2.5 - S.offset)];
    if (S.trim[1] - S.trim[0] < 0.5) S.trim = [0, S.video.duration];
    S.frame = 0; rebuildCur(); drawTimeline();
  });
  btn('Whole video', 'Export the full length of the video', () => { if (S.video) { S.trim = [0, S.video.duration]; S.frame = 0; rebuildCur(); drawTimeline(); } });
  btn('Remove video', 'Go back to overlay-only', removeVideo);
}

// ---------- presets ----------

const thumbs = new Map<string, HTMLCanvasElement>();
function buildPresetCards() {
  const el = $('presets');
  el.innerHTML = '';
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.className = 'preset' + (p.id === S.presetId ? ' on' : '');
    const cv = document.createElement('canvas');
    cv.width = 320; cv.height = 180;
    thumbs.set(p.id, cv);
    const info = document.createElement('div');
    info.innerHTML = `<b>${p.name}</b><small>${p.blurb}</small>`;
    b.append(cv, info);
    b.onclick = () => {
      S.presetId = p.id; S.overrides = {};
      el.querySelectorAll('.preset').forEach((x) => x.classList.toggle('on', x === b));
      buildParams(); rebuildScene(); saveHash();
    };
    el.appendChild(b);
  }
}

/** A frame that shows each style off: just after the first trick, else the fastest stick moment. */
function showcaseFrame(m: Motion, n: number, fps: number) {
  const trick = m.events.find((e) => e.kind === 'flip' || e.kind === 'roll' || e.kind === 'spin') ?? m.events.find((e) => e.kind === 'snap');
  if (trick) return Math.min(n - 1, trick.frame + Math.round(0.12 * fps));
  let best = 0;
  for (let i = 0; i < n; i++) if (m.speedL[i] + m.speedR[i] > m.speedL[best] + m.speedR[best]) best = i;
  return best;
}

function drawThumb(cv: HTMLCanvasElement, st: Style, settings: Settings) {
  if (!S.cur) return;
  const { track, motion } = S.cur;
  const f = showcaseFrame(motion, track.frames, track.fps);
  const set = { ...settings, crop: true, cropRef: 1080 };
  const L = computeLayout(set);
  const scale = Math.min(cv.width / L.W, cv.height / L.H);
  const sc = createScene(track, motion, st, set, scale);
  const off = new OffscreenCanvas(Math.round(L.W * scale), Math.round(L.H * scale));
  renderFrame(off.getContext('2d')!, sc, f, null);
  const c = cv.getContext('2d')!;
  c.clearRect(0, 0, cv.width, cv.height);
  c.drawImage(off, (cv.width - off.width) / 2, (cv.height - off.height) / 2);
}

let userThumbsFor: Track | null = null;
function renderThumbs() {
  if (!S.cur) return;
  for (const p of PRESETS) {
    const cv = thumbs.get(p.id);
    if (cv) drawThumb(cv, p.style, S.settings);
  }
  // Saved looks carry their own settings, so they only need redrawing when the flight changes.
  if (userThumbsFor !== S.cur.track) renderUserThumbs();
}

// ---------- the user's own presets (saved looks) ----------

let userPresets = loadPresets();
const userThumbs = new Map<string, HTMLCanvasElement>();

const currentLook = (): Look => sanitizeLook({
  presetId: S.presetId,
  overrides: structuredClone(S.overrides),
  settings: Object.fromEntries(LOOK_SETTINGS.map((k) => [k, S.settings[k]])),
});

function lookStyle(l: Look): Style { return { ...presetById(l.presetId).style, ...l.overrides }; }

function renderUserThumbs() {
  if (!S.cur) return;
  userThumbsFor = S.cur.track;
  for (const p of userPresets) {
    const cv = userThumbs.get(p.id);
    if (cv) drawThumb(cv, lookStyle(p.look), { ...S.settings, ...p.look.settings });
  }
}

/** Highlight the saved look that matches what's on screen, if any. */
function markUserPresets() {
  const cur = currentLook();
  for (const p of userPresets) userThumbs.get(p.id)?.parentElement?.classList.toggle('on', lookEquals(cur, p.look));
}

function storeUserPresets() {
  if (!savePresets(userPresets)) status('Could not save presets: this browser blocks local storage. Use "Export presets…" to keep them.', true);
  buildUserPresets();
}

function applyLook(p: UserPreset) {
  const modeChanged = p.look.settings.mode !== S.settings.mode;
  S.presetId = p.look.presetId;
  S.overrides = structuredClone(p.look.overrides);
  Object.assign(S.settings, p.look.settings);
  document.querySelectorAll('#presets .preset').forEach((x, i) => x.classList.toggle('on', PRESETS[i].id === S.presetId));
  buildParams();
  if (modeChanged) { rebuildCur(); drawTimeline(); } else { rebuildScene(); renderThumbs(); }
  saveHash();
  status(`Applied “${p.name}”`);
}

/** A chip that needs a second click within 3 s to fire. */
function confirmChip(label: string, ask: string, onConfirm: () => void) {
  const b = document.createElement('button');
  b.className = 'chip'; b.textContent = label;
  let timer = 0;
  b.onclick = (e) => {
    e.stopPropagation();
    if (!timer) { b.textContent = ask; timer = window.setTimeout(() => { timer = 0; b.textContent = label; }, 3000); return; }
    clearTimeout(timer); timer = 0; b.textContent = label;
    onConfirm();
  };
  return b;
}

function buildUserPresets() {
  const el = $('upList');
  el.innerHTML = '';
  userThumbs.clear();
  document.querySelector('.up-empty')?.remove();
  if (!userPresets.length) {
    const p = document.createElement('p'); p.className = 'up-empty';
    p.textContent = 'Nothing saved yet. Tweak a look and save it here.';
    el.before(p);
  }
  for (const p of userPresets) {
    const card = document.createElement('div');
    card.className = 'preset'; card.tabIndex = 0; card.role = 'button';
    card.title = `Apply “${p.name}”`;
    const cv = document.createElement('canvas');
    cv.width = 320; cv.height = 180;
    userThumbs.set(p.id, cv);
    const info = document.createElement('div');
    const b = document.createElement('b'); b.textContent = p.name;
    const small = document.createElement('small'); small.textContent = `on ${presetById(p.look.presetId).name}`;
    info.append(b, small);
    const acts = document.createElement('div'); acts.className = 'up-acts';
    const upd = confirmChip('Update', 'Overwrite?', () => { p.look = currentLook(); p.updated = Date.now(); storeUserPresets(); status(`Updated “${p.name}”`); });
    upd.title = 'Replace this preset with the current look';
    const ren = document.createElement('button'); ren.className = 'chip'; ren.textContent = 'Rename';
    ren.onclick = (e) => {
      e.stopPropagation();
      const name = prompt('New name', p.name)?.trim().slice(0, 60);
      if (!name || name === p.name) return;
      const clash = findByName(userPresets, name);
      if (clash && clash !== p) { status(`There is already a preset called “${clash.name}”.`, true); return; }
      p.name = name; p.updated = Date.now(); storeUserPresets();
    };
    const del = confirmChip('Delete', 'Really delete?', () => { userPresets = userPresets.filter((x) => x !== p); storeUserPresets(); status(`Deleted “${p.name}”`); });
    acts.append(upd, ren, del);
    card.append(cv, info, acts);
    card.onclick = () => applyLook(p);
    card.onkeydown = (e) => { if (e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); applyLook(p); } };
    el.appendChild(card);
  }
  $<HTMLButtonElement>('upExport').disabled = !userPresets.length;
  renderUserThumbs();
  markUserPresets();
}

const upName = $<HTMLInputElement>('upName'), upSave = $<HTMLButtonElement>('upSave');
let upConfirm = 0;
function resetUpSave() { clearTimeout(upConfirm); upConfirm = 0; upSave.textContent = 'Save current'; }
upName.oninput = resetUpSave;
upName.onkeydown = (e) => { if (e.key === 'Enter') upSave.click(); };
upSave.onclick = () => {
  const name = upName.value.trim().slice(0, 60);
  if (!name) { upName.focus(); status('Give the look a name first.', true); return; }
  const existing = findByName(userPresets, name);
  if (existing && !upConfirm) {
    upSave.textContent = `Overwrite “${existing.name}”?`;
    upConfirm = window.setTimeout(resetUpSave, 3000);
    return;
  }
  resetUpSave();
  if (existing) { existing.look = currentLook(); existing.updated = Date.now(); }
  else userPresets.push({ id: newId(), name, look: currentLook(), updated: Date.now() });
  storeUserPresets();
  upName.value = '';
  status(existing ? `Overwrote “${existing.name}”` : `Saved “${name}”`);
};

$('upExport').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([exportFile(userPresets)], { type: 'application/json' }));
  const d = new Date(), p2 = (n: number) => String(n).padStart(2, '0');
  a.download = `stickcam-presets-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

const upFile = $<HTMLInputElement>('upFile');
$('upImport').onclick = () => upFile.click();
upFile.onchange = async () => {
  const file = upFile.files?.[0];
  upFile.value = '';
  if (!file) return;
  let incoming: UserPreset[];
  try { incoming = parseImport(await file.text()); } catch (e) { status(`Import failed: ${(e as Error).message}`, true); return; }
  const plan = planImport(userPresets, incoming);
  if (!plan.some((it) => it.kind === 'conflict')) finishImport(plan, defaultChoices(plan, 'skip'));
  else openImportDialog(plan);
};

function finishImport(plan: ImportItem[], choices: ImportChoice[]) {
  const { list, counts } = applyImport(userPresets, plan, choices);
  userPresets = list;
  storeUserPresets();
  const same = plan.filter((it) => it.kind === 'same').length;
  const parts = [`${counts.added} added`];
  if (counts.overwritten) parts.push(`${counts.overwritten} overwritten`);
  if (same) parts.push(`${same} already there`);
  if (counts.skipped - same > 0) parts.push(`${counts.skipped - same} skipped`);
  status(`Imported presets: ${parts.join(', ')}.`);
}

function openImportDialog(plan: ImportItem[]) {
  const dlg = $<HTMLDialogElement>('upDlg');
  const n = (k: ImportItem['kind']) => plan.filter((it) => it.kind === k).length;
  const h = document.createElement('h3'); h.textContent = 'Import presets';
  const p = document.createElement('p'); p.className = 'muted';
  p.textContent = `${plan.length} in the file: ${n('new')} new, ${n('same')} identical, ${n('conflict')} with the same name as one of yours but a different look.`;
  const items = document.createElement('div'); items.className = 'up-items'; items.hidden = true;
  const choices = defaultChoices(plan, 'overwrite');
  plan.forEach((it, i) => {
    if (it.kind === 'same') return;
    const r = document.createElement('div'); r.className = 'up-item';
    const lab = document.createElement('label');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true;
    const small = document.createElement('small'); small.textContent = it.kind === 'new' ? ' new' : ' clashes with yours';
    lab.append(cb, document.createTextNode(it.preset.name), small);
    r.append(lab);
    let mode: ImportChoice = it.kind === 'new' ? 'add' : 'overwrite';
    if (it.kind === 'conflict') {
      const s = seg<ImportChoice>('', 'overwrite', [['overwrite', 'Overwrite'], ['both', 'Keep both']], (v) => { mode = v; if (cb.checked) choices[i] = v; }).querySelector('.seg')!;
      r.append(s);
    }
    cb.onchange = () => { choices[i] = cb.checked ? mode : 'skip'; };
    items.append(r);
  });
  const acts = document.createElement('div'); acts.className = 'dlg-actions';
  const btn = (text: string, onClick: () => void, go = false) => {
    const b = document.createElement('button'); b.textContent = text; if (go) b.className = 'go';
    b.onclick = onClick; return b;
  };
  const done = (c: ImportChoice[]) => { dlg.close(); finishImport(plan, c); };
  const overwrite = btn('Overwrite all', () => done(defaultChoices(plan, 'overwrite')), true);
  const keep = btn('Keep mine', () => done(defaultChoices(plan, 'skip')));
  const choose = btn('Choose…', () => {
    items.hidden = false;
    acts.replaceChildren(btn('Import selected', () => done(choices), true), cancel);
  });
  const cancel = btn('Cancel', () => dlg.close());
  acts.append(overwrite, keep, choose, cancel);
  dlg.replaceChildren(h, p, items, acts);
  dlg.showModal();
}

// ---------- parameter panel ----------

type Num = { label: string; key: keyof Style; min: number; max: number; step: number };
const STYLE_SLIDERS: Num[] = [
  { label: 'Trail', key: 'trail', min: 0, max: 1.2, step: 0.05 },
  { label: 'Sparks', key: 'sparks', min: 0, max: 2.5, step: 0.05 },
  { label: 'Shockwaves', key: 'shock', min: 0, max: 1.5, step: 0.05 },
  { label: 'Screen shake', key: 'shake', min: 0, max: 0.4, step: 0.01 },
  { label: 'Glow', key: 'glow', min: 0, max: 1, step: 0.05 },
  { label: 'Bloom', key: 'bloom', min: 0, max: 1.5, step: 0.05 },
  { label: 'Afterburner', key: 'flame', min: 0, max: 2, step: 0.05 },
  { label: 'Embers', key: 'embers', min: 0, max: 2, step: 0.05 },
  { label: 'Scanlines', key: 'scan', min: 0, max: 1, step: 0.05 },
  { label: 'RGB split', key: 'chroma', min: 0, max: 0.2, step: 0.005 },
  { label: 'Glitch', key: 'glitch', min: 0, max: 2, step: 0.05 },
  { label: 'Dot size', key: 'dotR', min: 0.05, max: 0.3, step: 0.005 },
];

const toHex = (c: string) => {
  if (c.startsWith('#')) return c.length === 4 ? '#' + [...c.slice(1)].map((x) => x + x).join('') : c.slice(0, 7);
  const n = /rgba?\(([^)]+)\)/.exec(c)?.[1].split(',').map((v) => parseFloat(v)) ?? [255, 255, 255];
  return '#' + n.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
};

function row(label: string, control: HTMLElement, out?: HTMLElement) {
  const r = document.createElement('div');
  r.className = 'row';
  const l = document.createElement('span'); l.textContent = label;
  r.append(l, control);
  if (out) r.append(out);
  return r;
}
function slider(label: string, value: number, min: number, max: number, step: number, onInput: (v: number) => void, fmt = (v: number) => String(+v.toFixed(2))) {
  const i = document.createElement('input');
  Object.assign(i, { type: 'range', min, max, step, value: String(value) });
  const o = document.createElement('output'); o.textContent = fmt(value);
  i.oninput = () => { o.textContent = fmt(+i.value); onInput(+i.value); };
  return row(label, i, o);
}
function seg<T extends string | number>(label: string, value: T, options: [T, string][], onPick: (v: T) => void) {
  const g = document.createElement('div'); g.className = 'seg';
  for (const [v, text] of options) {
    const b = document.createElement('button'); b.textContent = text;
    b.classList.toggle('on', v === value);
    b.onclick = () => { g.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); onPick(v); };
    g.appendChild(b);
  }
  return row(label, g);
}
function select(label: string, value: string, options: [string, string][], onPick: (v: string) => void) {
  const s = document.createElement('select');
  for (const [v, text] of options) { const o = document.createElement('option'); o.value = v; o.textContent = text; s.appendChild(o); }
  s.value = value;
  s.onchange = () => onPick(s.value);
  return row(label, s);
}
function sub(text: string) { const d = document.createElement('div'); d.className = 'sub'; d.textContent = text; return d; }

let sceneTimer = 0;
const restyle = () => { clearTimeout(sceneTimer); sceneTimer = window.setTimeout(() => { rebuildScene(); renderThumbs(); saveHash(); }, 30); };
const setStyle = <K extends keyof Style>(k: K, v: Style[K]) => { S.overrides[k] = v; restyle(); };

function buildParams() {
  const el = $('params');
  el.innerHTML = '';
  const st = style();
  el.append(slider('Chaos', S.settings.chaos, 0, 2, 0.05, (v) => { S.settings.chaos = v; restyle(); }, (v) => `${Math.round(v * 100)}%`));

  el.append(sub('Colours'));
  const colors = document.createElement('div'); colors.className = 'toggles';
  for (const [k, label] of [['dot', 'Dot'], ['ring', 'Ring'], ['hot', 'Fast'], ['textColor', 'Text']] as const) {
    const lab = document.createElement('label');
    const inp = document.createElement('input'); inp.type = 'color';
    inp.value = toHex((st[k] as string | null) ?? st.dot);
    inp.oninput = () => setStyle(k, inp.value);
    lab.append(inp, document.createTextNode(label));
    colors.appendChild(lab);
  }
  el.append(colors);

  el.append(sub('Effects'));
  for (const s of STYLE_SLIDERS) el.append(slider(s.label, st[s.key] as number, s.min, s.max, s.step, (v) => setStyle(s.key, v as never)));
  const tg = document.createElement('div'); tg.className = 'toggles';
  for (const [k, label] of [['popups', 'Popups'], ['stats', 'Stats'], ['thrBar', 'Throttle bar'], ['labels', 'Labels'], ['readout', 'Readout'], ['rainbow', 'Rainbow'], ['intro', 'Arm animation']] as const) {
    const lab = document.createElement('label');
    const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!st[k];
    inp.onchange = () => setStyle(k, inp.checked);
    lab.append(inp, document.createTextNode(label));
    tg.appendChild(lab);
  }
  el.append(tg);

  el.append(sub('Gimbals'));
  el.append(seg('Frame', st.frame, [['circle', 'Circle'], ['square', 'Square'], ['brackets', 'Brackets'], ['none', 'None']], (v) => setStyle('frame', v)));
  el.append(seg('Particles', st.sparkShape, [['streak', 'Sparks'], ['star', 'Stars'], ['glyph', 'Glyphs']], (v) => setStyle('sparkShape', v)));
  el.append(seg('Stick mode', S.settings.mode, [[2, 'Mode 2'], [1, 'Mode 1']], (v) => { S.settings.mode = v; rebuildCur(); drawTimeline(); saveHash(); }));
  el.append(slider('Size', S.settings.size, 0.08, 0.32, 0.005, (v) => { S.settings.size = v; restyle(); }, (v) => `${Math.round(v * 100)}%`));
  el.append(slider('Spacing', S.settings.gap, 0, 3, 0.02, (v) => { S.settings.gap = v; restyle(); }));
  el.append(seg('Position', S.settings.position, [['bottom', 'Bottom'], ['middle', 'Middle'], ['top', 'Top']], (v) => { S.settings.position = v; restyle(); }));
  const pct = (v: number) => `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
  el.append(slider('Vertical', S.settings.offsetY, -0.5, 0.5, 0.0025, (v) => { S.settings.offsetY = v; restyle(); }, pct));
  el.append(slider('Horizontal', S.settings.offsetX, -0.5, 0.5, 0.0025, (v) => { S.settings.offsetX = v; restyle(); }, pct));
  const reset = document.createElement('button');
  reset.className = 'chip'; reset.textContent = 'Reset position'; reset.style.justifySelf = 'start';
  reset.onclick = () => { S.settings.offsetX = 0; S.settings.offsetY = 0; buildParams(); restyle(); };
  el.append(reset);
}

function buildOutput() {
  const el = $('output');
  el.innerHTML = '';
  const sizes: [string, string][] = SIZE_PRESETS.map((p) => [p.id, p.label]);
  if (S.video) sizes.unshift(['video', `Match video (${S.video.width}×${S.video.height})`]);
  el.append(select('Size', S.sizeId, sizes, (v) => { S.sizeId = v; buildOutput(); rebuildScene(); saveHash(); }));
  if (S.sizeId === 'crop') {
    el.append(select('For footage', String(S.settings.cropRef), [['720', '720p'], ['1080', '1080p'], ['1440', '1440p / 2.7K'], ['2160', '4K']],
      (v) => { S.settings.cropRef = +v; rebuildScene(); }));
  }
  const rates: [string, string][] = [['24', '24 fps'], ['25', '25 fps'], [String(30000 / 1001), '29.97 fps'], ['30', '30 fps'], ['50', '50 fps'], [String(60000 / 1001), '59.94 fps'], ['60', '60 fps']];
  if (S.video && !rates.some(([v]) => Math.abs(+v - S.video!.fps) < 1e-6)) rates.unshift([String(S.video.fps), `${+S.video.fps.toFixed(2)} fps (video)`]);
  else if (S.video) { const r = rates.find(([v]) => Math.abs(+v - S.video!.fps) < 1e-6)!; r[1] += ' (video)'; }
  el.append(select('Frame rate', String(S.settings.fps), rates,
    (v) => { S.settings.fps = +v; rebuildCur(); saveHash(); }));
  if (!S.video && S.format === 'burn') S.format = 'webm';
  const formats: [string, string][] = [
    ['webm', 'WebM VP9 · transparent'], ['prores', 'ProRes 4444 .mov · transparent'], ['mp4-black', 'MP4 on black (Screen blend)'], ['mp4-green', 'MP4 on green (chroma key)'],
  ];
  if (S.video) formats.unshift(['burn', 'Cut video + sticks burned in (MP4)']);
  el.append(select('Format', S.format, formats, (v) => { S.format = v as OutFormat; buildOutput(); updateHint(); saveHash(); }));
}

const HINTS: Record<OutFormat, string> = {
  webm: 'Real transparency, small file, fast. Works in DaVinci Resolve, Kdenlive, Shotcut, CapCut desktop and browsers. Premiere and Final Cut can\'t read it: use ProRes.',
  prores: 'ProRes 4444 with alpha, the pro-editor standard (Premiere, Final Cut, Resolve, After Effects). Encoded by ffmpeg inside your browser: big files and slower. Tight crop is much faster.',
  'mp4-black': 'Plain H.264 on black. Put it above your footage with blend mode Screen or Add. Works in every editor, phone apps included, and the glow styles look best this way.',
  'mp4-green': 'Plain H.264 on green for chroma keying. Glow and bloom key out poorly; prefer black + Screen for the flashy styles.',
  burn: 'Your video cut to the trimmed range with the sticks drawn in, plus its audio. Ready to post, no editor needed. Size always matches the video.',
};

const capCache = new Map<string, Promise<Awaited<ReturnType<typeof capabilities>>>>();
async function updateHint() {
  const burn = S.format === 'burn' && !!S.video;
  const set = burn ? { ...S.settings, crop: false, width: S.video!.width, height: S.video!.height } : outputSettings();
  const L = computeLayout(set);
  const secs = S.cur ? S.cur.track.frames / S.settings.fps : 0;
  const place = burn ? '' : S.video ? (S.trim[0] > 0.01 ? ` Place it at ${fmtTime(S.trim[0])} on top of your video.` : ' Drop it at 0:00 on top of your video.') : '';
  $('formatHint').textContent = `${HINTS[S.format]} Output: ${L.W}×${L.H}, ${secs.toFixed(1)} s.${place}`;
  const key = `${L.W}x${L.H}@${S.settings.fps}`;
  if (!capCache.has(key)) capCache.set(key, capabilities(L.W, L.H, S.settings.fps));
  const caps = await capCache.get(key)!;
  const btn = $<HTMLButtonElement>('export');
  const ok = S.format === 'prores' ? caps.prores : S.format === 'webm' ? caps.webm : caps.mp4;
  btn.disabled = !S.cur || !ok;
  if (!ok) $('formatHint').textContent = `This browser can't encode ${S.format === 'webm' ? 'transparent VP9' : 'H.264'} at ${L.W}×${L.H}. Try Chrome or Edge, a smaller size, or ProRes.`;
}

// ---------- export ----------

const dlg = $<HTMLDialogElement>('exportDlg');
let abort: AbortController | null = null;
let lastUrl = '';
$('export').onclick = async () => {
  if (!S.cur) return;
  setPlaying(false);
  const burn = S.format === 'burn' && !!S.video;
  const set = burn ? { ...S.settings, crop: false, width: S.video!.width, height: S.video!.height } : outputSettings();
  const scene = createScene(S.cur.track, S.cur.motion, style(), set, 1);
  const format: Format = S.format.startsWith('mp4') ? 'mp4' : (S.format as Format);
  abort = new AbortController();
  const save = $<HTMLAnchorElement>('exSave');
  save.hidden = true;
  $('exTitle').textContent = 'Exporting…';
  $('exCancel').textContent = 'Cancel';
  const bar = $<HTMLProgressElement>('exBar');
  bar.value = 0;
  dlg.showModal();
  const t0 = performance.now();
  try {
    const res = await runExport({
      scene, format, background: S.format === 'mp4-green' ? '#00b140' : '#000000', signal: abort.signal,
      video: burn ? { file: S.video!.file, start: S.trim[0], end: S.trim[1] } : undefined,
      onProgress: (done, total, phase) => {
        bar.value = done / total;
        const el = (performance.now() - t0) / 1000;
        const eta = done > 8 ? ` · ${Math.ceil((el / done) * (total - done))} s left` : '';
        $('exPhase').textContent = `${phase} · frame ${done}/${total}${eta}`;
      },
    });
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(res.blob);
    const base = S.name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_') || 'log';
    const fpsLabel = String(+S.settings.fps.toFixed(2)).replace('.', '_');
    save.href = lastUrl;
    const at = S.video && S.trim[0] > 0.01 ? `_at${S.trim[0].toFixed(2).replace('.', 's')}` : '';
    const vname = S.video ? `_${S.video.file.name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_')}` : '';
    const kind = burn ? '_burned' : '';
    save.download = `stickcam${kind}_${base}${S.flights.length > 1 ? `_f${S.flightIdx + 1}` : ''}${vname}_${S.presetId}_${fpsLabel}fps${at}.${res.ext}`;
    save.hidden = false;
    $('exTitle').textContent = 'Done';
    $('exPhase').textContent = `${(res.blob.size / 1048576).toFixed(1)} MB · ${((performance.now() - t0) / 1000).toFixed(1)} s`;
    $('exCancel').textContent = 'Close';
  } catch (e) {
    if ((e as Error).name === 'AbortError') { dlg.close(); return; }
    $('exTitle').textContent = 'Export failed';
    $('exPhase').textContent = (e as Error).message;
    $('exCancel').textContent = 'Close';
    console.error(e);
  } finally {
    abort = null;
  }
};
$('exCancel').onclick = () => { if (abort) abort.abort(); else dlg.close(); };

// ---------- inputs ----------

const drop = $('drop'), fileInput = $<HTMLInputElement>('file');
const isVideo = (f: File) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name);
async function openFiles(files: FileList | File[] | null | undefined) {
  const list = [...(files ?? [])];
  const log = list.find((f) => !isVideo(f)), video = list.find(isVideo);
  if (log) { markSample(''); await loadBytes(new Uint8Array(await log.arrayBuffer()), log.name); }
  if (video) await loadVideo(video);
}
fileInput.onchange = () => openFiles(fileInput.files);
$<HTMLInputElement>('videoFile').onchange = () => openFiles($<HTMLInputElement>('videoFile').files);
for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, () => drop.classList.remove('over'));
// Logs and videos can be dropped anywhere on the page, together or one at a time.
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => { e.preventDefault(); void openFiles((e as DragEvent).dataTransfer?.files); });

// ---------- read the log off the flight controller (WebSerial + MSP) ----------

const fcRead = $<HTMLButtonElement>('fcRead'), fcSave = $<HTMLButtonElement>('fcSave');
let fcLog: Uint8Array | null = null;
let fcDownloaded = 0; // bytes pulled off the FC this session; erasing the flash is only offered after one
initFcDialog($<HTMLDialogElement>('fcDlg'), $<HTMLButtonElement>('fcSettings'), { downloadedBytes: () => fcDownloaded, onErased: () => { fcDownloaded = 0; } });
if (!fcSupported()) { $<HTMLButtonElement>('fcSettings').disabled = true; fcRead.disabled = true; fcRead.title = 'Needs Web Serial: use Chrome, Edge or Opera'; }
fcRead.onclick = async () => {
  fcRead.disabled = true;
  let link: FcLink | null = null;
  try {
    link = await FcLink.connect();
    status('Connected. Reading the blackbox flash…');
    const bytes = await pullDataflash(link, (f, n) => status(`Reading blackbox from flight controller… ${Math.round(f * 100)} % (${(n / 1024).toFixed(0)} KB)`));
    fcLog = bytes;
    fcDownloaded = bytes.length;
    fcSave.hidden = false;
    markSample('');
    await loadBytes(bytes, `fc-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.bbl`);
  } catch (e) {
    status((e as Error).message, true);
  } finally {
    await link?.close();
    fcRead.disabled = !fcSupported();
  }
};
fcSave.onclick = () => {
  if (!fcLog) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([fcLog as BlobPart], { type: 'application/octet-stream' }));
  a.download = S.name.endsWith('.bbl') ? S.name : 'blackbox.bbl';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

function markSample(id: string) {
  document.querySelectorAll<HTMLElement>('#samples .chip').forEach((c) => c.classList.toggle('on', c.dataset.id === id));
}
async function buildSamples() {
  const el = $('samples');
  const add = (id: string, title: string, blurb: string, go: () => void) => {
    const b = document.createElement('button');
    b.className = 'chip'; b.dataset.id = id; b.textContent = title; b.title = blurb;
    b.onclick = () => { markSample(id); go(); };
    el.appendChild(b);
  };
  add('demo', 'Freestyle demo', 'Synthetic run with flips, rolls, spins and a crash', loadDemo);
  try {
    const list: { id: string; title: string; blurb: string; file: string }[] = await (await fetch(`${BASE}samples/samples.json`)).json();
    for (const s of list) {
      add(s.id, s.title, s.blurb, async () => {
        status(`Downloading ${s.title}…`);
        const buf = new Uint8Array(await (await fetch(`${BASE}samples/${s.file}`)).arrayBuffer());
        await loadBytes(buf, s.file);
      });
    }
  } catch { /* samples are optional */ }
}

document.querySelectorAll<HTMLButtonElement>('.bg-pick button').forEach((b) => {
  b.onclick = () => {
    stage.dataset.bg = b.dataset.bg!;
    document.querySelectorAll('.bg-pick button').forEach((x) => x.classList.toggle('on', x === b));
    updateSky();
  };
});

let resizeTimer = 0;
new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = window.setTimeout(() => { rebuildScene(); drawTimeline(); }, 80); }).observe(stage);

// ---------- boot ----------

loadHash();
buildPresetCards();
buildUserPresets();
buildParams();
buildOutput();
await Promise.all(['40px Bungee', 'italic 900 40px Orbitron', '40px VT323', '700 40px Fredoka'].map((f) => document.fonts.load(f))).catch(() => {});
await buildSamples();
markSample('demo');
loadDemo();

// Dev-only test hook: export without a download prompt and hand the file to the dev server (.dev-out/).
if (import.meta.env.DEV) {
  Object.assign(window, {
    __stickcam: {
      S,
      async exportTo(fmt: OutFormat, name: string) {
        const burn = fmt === 'burn' && !!S.video;
        const set = burn ? { ...S.settings, crop: false, width: S.video!.width, height: S.video!.height } : outputSettings();
        const scene = createScene(S.cur!.track, S.cur!.motion, style(), set, 1);
        const t0 = performance.now();
        const res = await runExport({
          scene, format: fmt.startsWith('mp4') ? 'mp4' : (fmt as Format), background: fmt === 'mp4-green' ? '#00b140' : '#000000',
          signal: new AbortController().signal, onProgress: () => {},
          video: burn ? { file: S.video!.file, start: S.trim[0], end: S.trim[1] } : undefined,
        });
        await fetch(`/__dev/save?name=${encodeURIComponent(name)}.${res.ext}`, { method: 'POST', body: res.blob });
        return { bytes: res.blob.size, ms: Math.round(performance.now() - t0), frames: S.cur!.track.frames };
      },
      async loadUrls(log: string | null, video: string | null) {
        const get = async (u: string) => new File([await (await fetch(u)).blob()], u.split('/').pop()!, { type: u.endsWith('.mp4') ? 'video/mp4' : '' });
        await openFiles([...(log ? [await get(log)] : []), ...(video ? [await get(video)] : [])]);
      },
      set(p: { preset?: string; size?: string; fps?: number }) {
        if (p.preset) { S.presetId = p.preset; S.overrides = {}; }
        if (p.size) S.sizeId = p.size;
        if (p.fps) S.settings.fps = p.fps;
        rebuildCur();
      },
    },
  });
}
