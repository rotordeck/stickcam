// Copied unchanged from fpvstream viewer/src/bbl.js @ 8eb4661 — keep in sync; fix decoder bugs upstream first.
// Betaflight blackbox (.bbl) decoder: headers, I/P/S/G/H/E frames, multi-flight dumps.
// Reference: https://betaflight.com/docs/development/Blackbox-Internals and blackbox-log-viewer's flightlog_parser.js.

export const ENC = {
  SIGNED_VB: 0, UNSIGNED_VB: 1, NEG_14BIT: 3, ELIAS_DELTA_U32: 4, ELIAS_DELTA_S32: 5,
  TAG8_8SVB: 6, TAG2_3S32: 7, TAG8_4S16: 8, NULL: 9,
};
export const PRED = {
  ZERO: 0, PREVIOUS: 1, STRAIGHT_LINE: 2, AVERAGE_2: 3, MINTHROTTLE: 4, MOTOR_0: 5, INC: 6,
  HOME_COORD: 7, V1500: 8, VBATREF: 9, LAST_MAIN_FRAME_TIME: 10, MINMOTOR: 11,
};
export const EVENT = {
  SYNC_BEEP: 0, AUTOTUNE_CYCLE_START: 10, AUTOTUNE_CYCLE_RESULT: 11, AUTOTUNE_TARGETS: 12,
  INFLIGHT_ADJUSTMENT: 13, LOGGING_RESUME: 14, DISARM: 15, GTUNE_CYCLE_RESULT: 20, FLIGHT_MODE: 30, LOG_END: 255,
};

const LOG_MARKER = 'H Product:Blackbox flight data recorder by Nicholas Sherlock';
const MARKER_BYTES = Uint8Array.from(LOG_MARKER, (c) => c.charCodeAt(0));
const FRAME_CHARS = new Set([0x49, 0x50, 0x53, 0x45, 0x47, 0x48]); // I P S E G H
// Sanity limits used to reject garbage frames (same spirit as the reference viewer).
const MAX_ITERATION_JUMP = 5000;
const MAX_TIME_JUMP_US = 10_000_000;

class EndOfData extends Error {}

class ByteReader {
  constructor(buf, pos, end) { this.b = buf; this.pos = pos; this.end = end; }
  get more() { return this.pos < this.end; }
  u8() { if (this.pos >= this.end) throw new EndOfData(); return this.b[this.pos++]; }
  uvb() {
    let result = 0, mul = 1;
    for (let i = 0; i < 5; i++) {
      const c = this.u8();
      result += (c & 0x7f) * mul;
      if (c < 128) return result;
      mul *= 128;
    }
    throw new Error('bad variable-byte value');
  }
  svb() { const u = this.uvb() >>> 0; return (u >>> 1) ^ -(u & 1); }
  neg14() { let v = this.uvb() & 0x3fff; if (v & 0x2000) v |= ~0x3fff; return -v; }
  tag8_8svb(out, count) {
    if (count === 1) { out[0] = this.svb(); return; }
    let header = this.u8();
    for (let i = 0; i < count; i++, header >>= 1) out[i] = header & 1 ? this.svb() : 0;
  }
  tag2_3s32(out) {
    const lead = this.u8();
    switch (lead >> 6) {
      case 0: out[0] = (lead << 26) >> 30; out[1] = (lead << 28) >> 30; out[2] = (lead << 30) >> 30; break;
      case 1: { const l2 = this.u8(); out[0] = (lead << 28) >> 28; out[1] = (l2 << 24) >> 28; out[2] = (l2 << 28) >> 28; break; }
      case 2: { const l2 = this.u8(), l3 = this.u8(); out[0] = (lead << 26) >> 26; out[1] = (l2 << 26) >> 26; out[2] = (l3 << 26) >> 26; break; }
      default: {
        let sel = lead;
        for (let i = 0; i < 3; i++, sel >>= 2) {
          switch (sel & 3) {
            case 0: out[i] = (this.u8() << 24) >> 24; break;
            case 1: { const c1 = this.u8(), c2 = this.u8(); out[i] = ((c1 | (c2 << 8)) << 16) >> 16; break; }
            case 2: { const c1 = this.u8(), c2 = this.u8(), c3 = this.u8(); out[i] = ((c1 | (c2 << 8) | (c3 << 16)) << 8) >> 8; break; }
            default: { const c1 = this.u8(), c2 = this.u8(), c3 = this.u8(), c4 = this.u8(); out[i] = c1 | (c2 << 8) | (c3 << 16) | (c4 << 24); }
          }
        }
      }
    }
  }
  tag8_4s16(out) {
    let sel = this.u8(), buf = 0, nib = 0;
    for (let i = 0; i < 4; i++, sel >>= 2) {
      switch (sel & 3) {
        case 0: out[i] = 0; break;
        case 1:
          if (nib === 0) { buf = this.u8(); out[i] = (buf << 24) >> 28; nib = 1; }
          else { out[i] = (buf << 28) >> 28; nib = 0; }
          break;
        case 2:
          if (nib === 0) out[i] = (this.u8() << 24) >> 24;
          else { let c = (buf & 0x0f) << 4; buf = this.u8(); c |= buf >> 4; out[i] = (c << 24) >> 24; }
          break;
        default:
          if (nib === 0) { const c1 = this.u8(), c2 = this.u8(); out[i] = ((c1 << 8) | c2) << 16 >> 16; }
          else { const c1 = this.u8(), c2 = this.u8(); out[i] = ((((buf & 0x0f) << 12) | (c1 << 4) | (c2 >> 4)) << 16) >> 16; buf = c2; }
      }
    }
  }
}

function parseInts(s) { return s.split(',').map((v) => parseInt(v, 10)); }

export function parseHeader(lines) {
  const raw = {}; // every header key -> string value, in log order
  const frames = {}; // frame type -> {names, signed, predictor, encoding}
  for (const line of lines) {
    const body = line.slice(2);
    const sep = body.indexOf(':');
    if (sep < 0) continue;
    const key = body.slice(0, sep), value = body.slice(sep + 1);
    raw[key] = value;
    const m = /^Field (\w) (name|signed|predictor|encoding)$/.exec(key);
    if (!m) continue;
    const t = frames[m[1]] ||= {};
    if (m[2] === 'name') t.names = value.split(',');
    else t[m[2]] = parseInts(value);
    if (m[1] === 'I' && (m[2] === 'name' || m[2] === 'signed')) {
      const p = frames.P ||= {};
      const key = m[2] === 'name' ? 'names' : 'signed';
      p[key] = t[key]; // P frames inherit names/signedness from I
    }
  }
  const defs = {};
  for (const [type, t] of Object.entries(frames)) {
    if (!t.names) continue;
    defs[type] = t.names.map((name, i) => ({
      name, signed: !!(t.signed && t.signed[i]), predictor: t.predictor ? t.predictor[i] : 0, encoding: t.encoding ? t.encoding[i] : 0,
    }));
  }
  const num = (k, d) => (raw[k] !== undefined && raw[k] !== '' && !isNaN(+raw[k]) ? +raw[k] : d);
  const csv = (k) => (raw[k] ? raw[k].split(',').map(Number) : null);
  let pNum = 1, pDenom = 1;
  const pi = raw['P interval'];
  if (pi !== undefined) {
    const frac = /^(\d+)\/(\d+)$/.exec(pi);
    if (frac) { pNum = +frac[1]; pDenom = +frac[2]; } else if (/^\d+$/.test(pi)) { pDenom = Math.max(1, +pi); }
  }
  const gyroScale = raw.gyro_scale ? hexToFloat(raw.gyro_scale) : 1;
  const motorOutput = csv('motorOutput') || [48, 2047];
  return {
    raw, defs,
    firmware: raw['Firmware revision'] || raw['Firmware type'] || 'unknown',
    craft: raw['Craft name'] || '',
    iInterval: num('I interval', 32), pNum, pDenom,
    looptime: num('looptime', 0),
    minthrottle: num('minthrottle', 1150), maxthrottle: num('maxthrottle', 1850),
    motorOutput, vbatref: num('vbatref', 0), gyroScale,
    motorPoles: num('motor_poles', 14), acc1G: num('acc_1G', 2048),
    debugMode: num('debug_mode', 0),
  };
}

function hexToFloat(s) {
  const n = /^0x/i.test(s) ? parseInt(s, 16) : parseInt(s, 10);
  const dv = new DataView(new ArrayBuffer(4)); dv.setUint32(0, n >>> 0); return dv.getFloat32(0);
}

/**
 * Early builds of the app saved MSP_DATAFLASH_READ replies with the 7-byte header cut at only 4 bytes, so every 4099-byte
 * block starts with a 3-byte junk header (`00 10 00` = size 4096, no compression) and the 3 real bytes after each block
 * were never requested. The junk sits exactly where those 3 bytes belong, so the stream stays byte-aligned: we only drop
 * the leading header and report the other 3-byte placeholders as `gaps` (offsets in the returned bytes) so that frames
 * touching them can be flagged as unreliable instead of guessed at.
 */
export function repairLegacyDump(bytes) {
  const STRIDE = 4099;
  const isHeader = (o) => o + 2 < bytes.length && bytes[o] === 0x00 && bytes[o + 1] === 0x10 && bytes[o + 2] === 0x00;
  if (bytes.length < STRIDE * 3 || !isHeader(0) || !isHeader(STRIDE) || !isHeader(STRIDE * 2)) return { bytes, repaired: false, gaps: [] };
  const gaps = [];
  for (let o = STRIDE; o + 3 <= bytes.length; o += STRIDE) gaps.push(o - 3);
  return { bytes: bytes.subarray(3), repaired: true, gaps, lostBytes: gaps.length * 3 };
}

/** Byte ranges of each flight in a (possibly multi-flight) dump. */
export function findLogs(bytes) {
  const starts = [];
  const n = bytes.length - MARKER_BYTES.length;
  for (let i = 0; i <= n; i++) {
    if (bytes[i] !== 0x48 || bytes[i + 1] !== 0x20) continue; // 'H '
    let j = 2;
    while (j < MARKER_BYTES.length && bytes[i + j] === MARKER_BYTES[j]) j++;
    if (j === MARKER_BYTES.length) { starts.push(i); i += MARKER_BYTES.length - 1; }
  }
  return starts.map((start, k) => ({ index: k, start, end: k + 1 < starts.length ? starts[k + 1] : bytes.length }));
}

function readHeaderLines(bytes, start, end) {
  const lines = [], lineSpans = [];
  let pos = start;
  while (pos < end && bytes[pos] === 0x48 && bytes[pos + 1] === 0x20) {
    let nl = pos;
    while (nl < end && bytes[nl] !== 0x0a) nl++;
    if (nl >= end) break;
    let s = '';
    for (let k = pos; k < nl; k++) s += String.fromCharCode(bytes[k]);
    lines.push(s.replace(/\r$/, ''));
    lineSpans.push([pos, nl + 1]);
    pos = nl + 1;
  }
  return { lines, dataStart: pos, lineSpans };
}

const latin1 = (bytes, a, b) => { let t = ''; for (let i = a; i < b; i++) t += String.fromCharCode(bytes[i]); return t; };

/**
 * Rebuild a header that overlaps damaged bytes: walk the reference flight's keys in order, take each value from this flight
 * where its line is intact and from the reference where it is not. Returns null if the end of the header can't be located.
 */
function reconstructHeader(bytes, range, ref, gaps) {
  const lastKey = ref[ref.length - 1].slice(0, ref[ref.length - 1].indexOf(':') + 1);
  const refLen = ref.reduce((n, l) => n + l.length + 1, 0);
  const text = latin1(bytes, range.start, Math.min(range.end, range.start + refLen + 512));
  const lastAt = text.indexOf(lastKey);
  if (lastAt < 0) return null;
  const endNl = text.indexOf('\n', lastAt);
  if (endNl < 0) return null;
  const headerText = text.slice(0, endNl + 1);
  const lines = [], approx = [];
  let cursor = 0;
  ref.forEach((rl, i) => {
    const key = rl.slice(0, rl.indexOf(':') + 1);
    const at = headerText.indexOf('\n' + key, Math.max(0, cursor - 1));
    const lineStart = at < 0 ? -1 : (at === 0 && cursor === 0 && headerText.startsWith(key) ? 0 : at + 1);
    let found = lineStart >= 0 ? lineStart : (headerText.startsWith(key) && cursor === 0 ? 0 : -1);
    if (found < 0) { lines.push(rl); approx.push(i); return; }
    const nl = headerText.indexOf('\n', found);
    const stop = nl < 0 ? headerText.length : nl;
    const damaged = gaps.some((g) => g < range.start + stop && g + 3 > range.start + found);
    if (damaged) { lines.push(rl); approx.push(i); } else lines.push(headerText.slice(found, stop));
    cursor = stop + 1;
  });
  return { lines, approx, dataStart: range.start + headerText.length };
}

/** Header only: cheap, used to list flights without decoding them. */
export function readHeader(bytes, range, opts = {}) {
  const parsed = readHeaderLines(bytes, range.start, range.end);
  let { lines, dataStart, lineSpans } = parsed;
  const gaps = opts.gaps || [], ref = opts.referenceLines;
  let approx = [];
  if (gaps.length && ref) {
    const refLen = ref.reduce((n, l) => n + l.length + 1, 0);
    const probeEnd = range.start + Math.max(refLen, dataStart - range.start) + 64;
    if (gaps.some((g) => g < probeEnd && g + 3 > range.start)) {
      const rebuilt = reconstructHeader(bytes, range, ref, gaps);
      if (rebuilt) { lines = rebuilt.lines; approx = rebuilt.approx; dataStart = rebuilt.dataStart; lineSpans = []; }
    }
  }
  const header = parseHeader(lines);
  header.approximatedLines = approx.map((i) => lines[i]);
  return { header, dataStart, lines, lineSpans };
}

const CHUNK = 4096;

/**
 * Fully decode one flight.
 * Returns { header, fields, n, cols, slow, events, gps, stats } where `cols[name]` is a Float64Array of n samples.
 */
export function decodeFlight(bytes, range, opts = {}) {
  const { header, dataStart } = readHeader(bytes, range, opts);
  const gaps = opts.gaps || []; // sorted offsets of 3-byte damaged regions (see repairLegacyDump)
  let gapIdx = 0;
  const touchesGap = (a, b) => {
    while (gapIdx < gaps.length && gaps[gapIdx] + 3 <= a) gapIdx++;
    return gapIdx < gaps.length && gaps[gapIdx] < b;
  };
  const quality = []; // per main frame: 0 = verified, 1 = suspect (touches / follows damaged bytes until the next I-frame)
  let suspect = false;
  const I = header.defs.I;
  if (!I) throw new Error('flight has no main-frame definition');
  const nf = I.length;
  const P = header.defs.P || I;
  const idx = (name) => I.findIndex((f) => f.name === name);
  const timeIdx = idx('time'), iterIdx = idx('loopIteration'), motor0 = idx('motor[0]');
  if (timeIdx < 0 || iterIdx < 0) throw new Error('flight lacks time/loopIteration');

  const r = new ByteReader(bytes, dataStart, range.end);
  const chunks = [];
  let chunk = null, inChunk = 0, n = 0;
  const push = (frame) => {
    if (!chunk || inChunk === CHUNK) { chunk = new Float64Array(CHUNK * nf); chunks.push(chunk); inChunk = 0; }
    chunk.set(frame, inChunk * nf); inChunk++; n++;
  };

  const events = [], slowFrames = [], gpsFrames = [];
  const stats = { iFrames: 0, pFrames: 0, sFrames: 0, gFrames: 0, eFrames: 0, corrupt: 0, skippedP: 0, ended: false, truncated: false };
  let prev = null, prev2 = null, lastIter = -1, lastTime = 0;
  let slowLatest = null, gpsHome = [0, 0];
  const S = header.defs.S, G = header.defs.G, H = header.defs.H;

  const shouldHaveFrame = (i) => (((i % header.iInterval) + header.pNum - 1) % header.pDenom) < header.pNum;
  const skippedFrames = () => { if (lastIter < 0) return 0; let c = 0; for (let k = lastIter + 1; !shouldHaveFrame(k); k++) { c++; if (c > MAX_ITERATION_JUMP) break; } return c; };

  const scratch = new Array(8).fill(0);
  function decodeFields(defs, cur, prv, prv2, skipped, mainCur) {
    for (let i = 0; i < defs.length;) {
      const f = defs[i];
      if (f.predictor === PRED.INC) { cur[i] = skipped + 1 + (prv ? prv[i] : 0); i++; continue; }
      let count = 1;
      switch (f.encoding) {
        case ENC.SIGNED_VB: scratch[0] = r.svb(); break;
        case ENC.UNSIGNED_VB: scratch[0] = r.uvb(); break;
        case ENC.NEG_14BIT: scratch[0] = r.neg14(); break;
        case ENC.NULL: scratch[0] = 0; break;
        case ENC.TAG8_4S16: r.tag8_4s16(scratch); count = 4; break;
        case ENC.TAG2_3S32: r.tag2_3s32(scratch); count = 3; break;
        case ENC.TAG8_8SVB: {
          let end = i + 1;
          while (end < defs.length && end < i + 8 && defs[end].encoding === ENC.TAG8_8SVB) end++;
          count = end - i; r.tag8_8svb(scratch, count); break;
        }
        default: throw new Error(`unsupported field encoding ${f.encoding} (${f.name})`);
      }
      for (let k = 0; k < count; k++, i++) {
        const d = defs[i];
        let v = scratch[k];
        switch (d.predictor) {
          case PRED.PREVIOUS: if (prv) v += prv[i]; break;
          case PRED.STRAIGHT_LINE: if (prv && prv2) v += 2 * prv[i] - prv2[i]; break;
          case PRED.AVERAGE_2: if (prv && prv2) v += Math.trunc((prv[i] + prv2[i]) / 2); break;
          case PRED.MINTHROTTLE: v += header.minthrottle; break;
          case PRED.MINMOTOR: v += header.motorOutput[0]; break;
          case PRED.MOTOR_0: v += cur[motor0]; break;
          case PRED.V1500: v += 1500; break;
          case PRED.VBATREF: v += header.vbatref; break;
          case PRED.HOME_COORD: v += gpsHome[d.name.endsWith('[1]') ? 1 : 0]; break;
          case PRED.LAST_MAIN_FRAME_TIME: v += mainCur ? mainCur[timeIdx] : 0; break;
          default: break;
        }
        cur[i] = d.signed ? v | 0 : v >>> 0;
      }
    }
  }

  const validMain = (cur) => {
    if (lastIter < 0) return true;
    const dIter = cur[iterIdx] - lastIter, dt = (cur[timeIdx] - lastTime) >>> 0;
    return dIter >= 0 && dIter < MAX_ITERATION_JUMP && dt < MAX_TIME_JUMP_US;
  };
  let needIFrame = true;

  while (r.more) {
    const frameStart = r.pos;
    const marker = r.u8();
    if (!FRAME_CHARS.has(marker)) continue;
    // While resynchronising after damage only an I-frame (or the end-of-log marker) can be trusted: stray S/E/G/H bytes inside garbage would otherwise decode into bogus frames.
    if (needIFrame && marker !== 0x49 && !(marker === 0x45 && r.pos < r.end && r.b[r.pos] === 0xff)) continue;
    const checkNext = () => { if (r.more && !FRAME_CHARS.has(r.b[r.pos])) throw new Error('implausible frame: next byte'); };
    try {
      if (marker === 0x49 || marker === 0x50) { // I / P
        const isI = marker === 0x49;
        if (!isI && (needIFrame || !prev)) { // cannot decode deltas without a good reference; resync at next I
          stats.skippedP++; continue;
        }
        const cur = new Float64Array(nf);
        decodeFields(isI ? I : P, cur, isI ? null : prev, isI ? null : (prev2 || prev), isI ? 0 : skippedFrames(), null);
        if (!validMain(cur)) throw new Error('implausible frame: jump');
        checkNext();
        needIFrame = false;
        if (isI) suspect = false; // an I-frame is self-contained, so it re-anchors every predictor
        if (touchesGap(frameStart, r.pos)) suspect = true;
        quality.push(suspect ? 1 : 0);
        lastIter = cur[iterIdx]; lastTime = cur[timeIdx];
        // An I-frame resets both history slots (the encoder does the same), so the next P predicts off it alone.
        if (isI) { prev2 = prev = cur; } else { prev2 = prev; prev = cur; }
        push(cur); isI ? stats.iFrames++ : stats.pFrames++;
      } else if (marker === 0x53 && S) { // slow
        const cur = new Float64Array(S.length);
        decodeFields(S, cur, null, null, 0, prev);
        checkNext();
        slowLatest = cur; stats.sFrames++;
        slowFrames.push({ n, values: cur });
      } else if (marker === 0x48 && H) { // GPS home
        const cur = new Float64Array(H.length);
        decodeFields(H, cur, null, null, 0, prev);
        checkNext();
        gpsHome = [cur[0], cur[1]];
      } else if (marker === 0x47 && G) { // GPS
        const cur = new Float64Array(G.length);
        decodeFields(G, cur, null, null, 0, prev);
        checkNext();
        stats.gFrames++;
        gpsFrames.push({ values: cur });
      } else if (marker === 0x45) { // event
        const type = r.u8();
        let ev = { type, n, time: lastTime };
        switch (type) {
          case EVENT.SYNC_BEEP: ev.beepTime = r.uvb(); break;
          case EVENT.INFLIGHT_ADJUSTMENT: {
            const fn = r.u8(); ev.func = fn & 127;
            if (fn & 128) { let v = 0; for (let k = 0; k < 4; k++) v |= r.u8() << (8 * k); ev.value = new Float32Array(new Int32Array([v]).buffer)[0]; }
            else ev.value = r.svb();
            break;
          }
          case EVENT.LOGGING_RESUME: ev.iteration = r.uvb(); ev.resumeTime = r.uvb(); break;
          case EVENT.DISARM: ev.reason = r.uvb(); break;
          case EVENT.FLIGHT_MODE: ev.flags = r.uvb(); ev.lastFlags = r.uvb(); break;
          case EVENT.LOG_END: {
            let s = ''; for (let k = 0; k < 11 && r.more; k++) s += String.fromCharCode(r.u8());
            if (s !== 'End of log\0') throw new Error('bad log end');
            stats.ended = true; events.push(ev); stats.eFrames++;
            r.pos = r.end; // anything after the end marker belongs to padding / next flight
            continue;
          }
          default: throw new Error(`unknown event ${type}`);
        }
        checkNext();
        events.push(ev); stats.eFrames++;
        if (type === EVENT.LOGGING_RESUME) { needIFrame = true; }
      }
    } catch (e) {
      if (e instanceof EndOfData) { stats.truncated = true; break; }
      // Garbage or unsupported data: rewind to just after this marker byte and hunt for the next valid frame.
      stats.corrupt++; (stats.errors ||= {})[e.message] = (stats.errors[e.message] || 0) + 1; needIFrame = true; prev = prev2 = null; r.pos = frameStart + 1;
      if (e.message.startsWith('unsupported')) throw e;
    }
  }

  // Concatenate chunks into per-field columns.
  const cols = {};
  const fields = I.map((f) => f.name);
  for (let f = 0; f < nf; f++) cols[fields[f]] = new Float64Array(n);
  for (let c = 0, row = 0; c < chunks.length; c++) {
    const rows = Math.min(CHUNK, n - c * CHUNK);
    for (let k = 0; k < rows; k++, row++) for (let f = 0; f < nf; f++) cols[fields[f]][row] = chunks[c][k * nf + f];
  }
  const q = Uint8Array.from(quality);
  stats.suspect = q.reduce((a, v) => a + v, 0);
  return {
    header, fields, n, cols, events, stats, quality: q,
    slow: S ? { names: S.map((f) => f.name), frames: slowFrames } : null,
    gps: G ? { names: G.map((f) => f.name), frames: gpsFrames } : null,
    byteRange: range,
  };
}

/** Header-level info for every flight in a dump (no decoding). */
export function listFlights(bytes, opts = {}) {
  const ranges = findLogs(bytes);
  const gaps = opts.gaps || [];
  let referenceLines = null;
  if (gaps.length) {
    // The longest header with no damaged line is the reference for rebuilding damaged ones (damage only ever shortens/garbles).
    let best = null;
    ranges.forEach((range) => {
      const h = readHeader(bytes, range, { gaps: [] });
      const hit = h.lineSpans.some(([a, b]) => gaps.some((g) => g < b && g + 3 > a)) || gaps.some((g) => g >= h.dataStart - 4 && g < h.dataStart);
      if (!hit && (!best || h.lines.length > best.length)) best = h.lines;
    });
    referenceLines = best;
  }
  return ranges.map((range) => {
    const { header } = readHeader(bytes, range, { gaps, referenceLines });
    return { range, header, size: range.end - range.start, opts: { gaps, referenceLines } };
  });
}
