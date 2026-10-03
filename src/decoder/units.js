// Copied unchanged from fpvstream viewer/src/units.js @ 8eb4661 — keep in sync; fix decoder bugs upstream first.
// Turns a decoded flight (raw integer columns) into physical, named signals. Pure; no DOM.

const RAD = 180 / Math.PI;

const f32 = (src, fn) => { const out = new Float32Array(src.length); for (let i = 0; i < src.length; i++) out[i] = fn(src[i], i); return out; };
const median = (a) => { const b = Float64Array.from(a).sort(); return b.length ? b[b.length >> 1] : 0; };

/** Quaternion (x,y,z scaled by 32767; w implied) -> roll, pitch, yaw in degrees. */
export function quatToEuler(qx, qy, qz) {
  const x = qx / 32767, y = qy / 32767, z = qz / 32767;
  const w = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
  const roll = Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y));
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x))));
  const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
  return [roll * RAD, pitch * RAD, yaw * RAD];
}

/**
 * Build the physical-signal bundle for a decoded flight.
 * Every array has one entry per main frame; missing fields yield `null` (never a made-up zero).
 */
export function buildSignals(flight) {
  const { cols, header, n } = flight;
  const has = (name) => name in cols;
  const col3 = (base, fn) => [0, 1, 2].map((a) => (has(`${base}[${a}]`) ? f32(cols[`${base}[${a}]`], fn) : null));

  const time = cols.time;
  const t = new Float64Array(n);
  for (let i = 0; i < n; i++) t[i] = ((time[i] - time[0]) >>> 0) / 1e6;
  // Robust sample-rate estimate: median of the deltas, ignoring gaps.
  const dts = new Float64Array(Math.max(0, n - 1));
  for (let i = 1; i < n; i++) dts[i - 1] = t[i] - t[i - 1];
  const dt = median(dts) || 0.00125;
  const fs = 1 / dt;

  const gs = header.gyroScale && isFinite(header.gyroScale) && header.gyroScale > 0 ? header.gyroScale : 1;
  const [mLo, mHi] = header.motorOutput;
  const mRange = Math.max(1, mHi - mLo);
  const motorCount = [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => has(`motor[${i}]`)).length;
  const motorRaw = [], motorPct = [], rpm = [];
  for (let i = 0; i < motorCount; i++) {
    motorRaw.push(cols[`motor[${i}]`]);
    motorPct.push(f32(cols[`motor[${i}]`], (v) => ((v - mLo) / mRange) * 100));
    // Logged eRPM is electrical RPM / 100; mechanical RPM = eRPM * 100 / (poles / 2).
    rpm.push(has(`eRPM[${i}]`) ? f32(cols[`eRPM[${i}]`], (v) => (v * 100) / (header.motorPoles / 2)) : null);
  }

  let attitude = null;
  if (has('imuQuaternion[0]') && has('imuQuaternion[1]') && has('imuQuaternion[2]')) {
    attitude = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    for (let i = 0; i < n; i++) {
      const e = quatToEuler(cols['imuQuaternion[0]'][i], cols['imuQuaternion[1]'][i], cols['imuQuaternion[2]'][i]);
      attitude[0][i] = e[0]; attitude[1][i] = e[1]; attitude[2][i] = e[2];
    }
  }

  const gyro = col3('gyroADC', (v) => v * gs);
  const setpoint = col3('setpoint', (v) => v);
  const sig = {
    n, t, fs, dt, quality: flight.quality,
    duration: n ? t[n - 1] : 0,
    gyro,
    gyroUnfilt: col3('gyroUnfilt', (v) => v * gs),
    setpoint,
    error: [0, 1, 2].map((a) => (gyro[a] && setpoint[a] ? f32(gyro[a], (v, i) => setpoint[a][i] - v) : null)),
    stick: col3('rcCommand', (v) => v),
    throttle: has('rcCommand[3]') ? cols['rcCommand[3]'] : null,
    setpointThrottle: has('setpoint[3]') ? cols['setpoint[3]'] : null,
    pid: {
      P: col3('axisP', (v) => v), I: col3('axisI', (v) => v), D: col3('axisD', (v) => v), F: col3('axisF', (v) => v),
    },
    motorCount, motorRaw, motorPct, rpm,
    vbat: has('vbatLatest') ? f32(cols.vbatLatest, (v) => v / 100) : null,
    amps: has('amperageLatest') ? f32(cols.amperageLatest, (v) => v / 100) : null,
    rssi: has('rssi') ? f32(cols.rssi, (v) => (v / 1023) * 100) : null,
    acc: col3('accSmooth', (v) => v / (header.acc1G || 2048)),
    attitude,
  };
  // Mean motor output (% of range): the simplest robust "how hard is it flying" signal.
  if (motorCount) {
    sig.motorMean = new Float32Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (let m = 0; m < motorCount; m++) s += motorPct[m][i]; sig.motorMean[i] = s / motorCount; }
  }
  return sig;
}

/** Index of the first sample with t >= x (binary search on the sorted time axis). */
export function indexAtTime(t, x) {
  let lo = 0, hi = t.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (t[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

/** Contiguous runs of verified frames without time gaps: [[i0, i1), ...] within [from, to). */
export function goodSegments(sig, from = 0, to = sig.n, opts = {}) {
  const maxGap = (opts.maxGapFactor || 3) * sig.dt;
  const segs = [];
  let start = -1;
  for (let i = from; i < to; i++) {
    const ok = !sig.quality[i] && !(opts.mask && !opts.mask[i]);
    const gap = i > from && sig.t[i] - sig.t[i - 1] > maxGap;
    if (ok && start >= 0 && gap) { segs.push([start, i]); start = i; }
    else if (ok && start < 0) start = i;
    else if (!ok && start >= 0) { segs.push([start, i]); start = -1; }
  }
  if (start >= 0) segs.push([start, to]);
  return segs;
}
