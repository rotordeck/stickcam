// Blackbox logging settings: which fields the flight controller records and how often.
// Pure (no I/O) so it can be unit-tested. Wire format and the disabled-mask bit order follow
// betaflight-configurator (`MSPHelper` MSP_BLACKBOX_CONFIG / MSP_SET_BLACKBOX_CONFIG, `stores/debug.ts`).

export const API_1_44 = 44;
export const API_1_45 = 45;
export const API_1_47 = 47;
export const API_1_49 = 49;

export const DEVICES = ['None', 'Onboard flash', 'SD card', 'Serial port'] as const;
export const DEVICE_FLASH = 1;

export interface BbConfig {
  supported: boolean;
  device: number;
  rateNum: number;
  rateDenom: number;
  pDenom: number;
  /** n of 1/2^n of the PID rate (0 = every loop … 4 = 1/16). API >= 1.44. */
  sampleRate: number;
  /** Bit set = field NOT logged. null before API 1.45 (no field control over MSP). */
  mask: number | null;
}

export interface BbField {
  id: string;
  label: string;
  bit: number;
  /** CLI variable suffix (`blackbox_disable_<cli>`), if the firmware has one. */
  cli: string | null;
  /** Rough average bytes per logged frame once delta-coded. Only used for the size estimate. */
  bytes: number;
  /** StickCam needs this to do its job. */
  need?: string;
}

/** The field list in bit order for a given minor API version (1.<minor>). */
export function fieldTable(apiMinor: number): BbField[] {
  const f: BbField[] = [
    { id: 'pid', label: 'PID terms', bit: 0, cli: 'pids', bytes: 9 },
    { id: 'rc', label: 'RC commands (sticks, throttle)', bit: 1, cli: 'rc', bytes: 3.5, need: 'Drives the whole overlay.' },
    { id: 'setpoint', label: 'Setpoint', bit: 2, cli: 'setpoint', bytes: 3 },
    { id: 'battery', label: 'Battery', bit: 3, cli: 'bat', bytes: 0.5 },
    { id: 'mag', label: 'Magnetometer', bit: 4, cli: null, bytes: 0 },
    { id: 'alt', label: 'Altitude', bit: 5, cli: 'alt', bytes: 0 },
    { id: 'rssi', label: 'RSSI', bit: 6, cli: 'rssi', bytes: 0.5 },
    { id: 'gyro', label: 'Gyro (filtered)', bit: 7, cli: 'gyro', bytes: 3, need: 'Flip, roll and spin detection, and auto-sync to your video.' },
  ];
  let bit = 8;
  if (apiMinor >= API_1_47) f.push({ id: 'attitude', label: 'Attitude angles', bit: bit++, cli: 'attitude', bytes: 3 });
  f.push(
    { id: 'acc', label: 'Accelerometer', bit: bit++, cli: 'acc', bytes: 3 },
    { id: 'debug', label: 'Debug values', bit: bit++, cli: 'debug', bytes: 4 },
    { id: 'motor', label: 'Motor outputs', bit: bit++, cli: 'motors', bytes: 4 },
    { id: 'gps', label: 'GPS', bit: bit++, cli: 'gps', bytes: 0 },
    { id: 'rpm', label: 'Motor RPM', bit: bit++, cli: 'rpm', bytes: 4 },
    { id: 'gyrounfilt', label: 'Gyro (unfiltered)', bit: bit++, cli: 'gyrounfilt', bytes: 3 },
  );
  if (apiMinor >= API_1_47) f.push({ id: 'servo', label: 'Servos', bit: bit++, cli: 'servos', bytes: 0 });
  if (apiMinor >= API_1_49) f.push({ id: 'pitot', label: 'Pitot', bit: bit++, cli: null, bytes: 0 });
  return f;
}

/** Fixed per-frame cost (loop iteration + time deltas). */
const FRAME_OVERHEAD = 1.5;

export function decodeConfig(d: Uint8Array, apiMinor: number): BbConfig {
  if (d.length < 6) throw new Error('Short blackbox config reply');
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const cfg: BbConfig = {
    supported: !!(v.getUint8(0) & 1),
    device: v.getUint8(1),
    rateNum: v.getUint8(2),
    rateDenom: v.getUint8(3),
    pDenom: v.getUint16(4, true),
    sampleRate: 0,
    mask: null,
  };
  if (apiMinor >= API_1_44 && d.length >= 7) cfg.sampleRate = v.getUint8(6);
  if (apiMinor >= API_1_45 && d.length >= 11) cfg.mask = v.getUint32(7, true);
  return cfg;
}

/** MSP_SET_BLACKBOX_CONFIG payload. The configurator sends pDenom = sampleRate; we do the same. */
export function encodeConfig(c: BbConfig, apiMinor: number): number[] {
  const p = c.sampleRate & 0xff;
  const out = [c.device, c.rateNum, c.rateDenom, p, 0]; // pDenom u16 LE
  if (apiMinor >= API_1_44) out.push(p);
  if (apiMinor >= API_1_45) {
    const m = (c.mask ?? 0) >>> 0;
    out.push(m & 0xff, (m >> 8) & 0xff, (m >> 16) & 0xff, (m >>> 24) & 0xff);
  }
  return out;
}

export const isFieldOn = (mask: number | null, f: BbField) => ((mask ?? 0) >>> f.bit & 1) === 0;

export function maskFor(table: BbField[], enabled: Iterable<string>): number {
  const on = new Set(enabled);
  let m = 0;
  for (const f of table) if (!on.has(f.id)) m |= 1 << f.bit;
  return m >>> 0;
}

export interface Profile { id: string; title: string; blurb: string; enabled: string[] | 'all'; rate: number }

export const PROFILES: Profile[] = [
  { id: 'stickcam', title: 'StickCam', blurb: 'Sticks and gyro only at 1/16: the most flight time per flash.', enabled: ['rc', 'gyro'], rate: 4 },
  { id: 'balanced', title: 'Balanced', blurb: 'Sticks and gyro at 1/8: twice the data for smoother fast tricks.', enabled: ['rc', 'gyro'], rate: 3 },
  { id: 'default', title: 'Betaflight default', blurb: 'Everything on at 1/4, for tuning.', enabled: 'all', rate: 2 },
];

export function applyProfile(c: BbConfig, p: Profile, table: BbField[]): BbConfig {
  const enabled = p.enabled === 'all' ? table.map((f) => f.id) : p.enabled;
  return { ...c, sampleRate: p.rate, mask: c.mask === null ? null : maskFor(table, enabled) };
}

/** Logging frequency in Hz for a sample-rate index. */
export const loggingHz = (pidHz: number, sampleRate: number) => pidHz / 2 ** sampleRate;
export const rateLabel = (pidHz: number, sampleRate: number) => {
  const hz = loggingHz(pidHz, sampleRate);
  return `1/${2 ** sampleRate}` + (pidHz ? ` (${hz >= 1000 ? `${+(hz / 1000).toFixed(2)} kHz` : `${Math.round(hz)} Hz`})` : '');
};

/** Rough bytes per second and minutes of logging that fit in `flashBytes`. Approximate until calibrated on a real log. */
export function estimate(c: BbConfig, apiMinor: number, pidHz: number, flashBytes: number) {
  const table = fieldTable(apiMinor);
  const perFrame = FRAME_OVERHEAD + table.filter((f) => isFieldOn(c.mask, f)).reduce((s, f) => s + f.bytes, 0);
  const bytesPerSec = perFrame * loggingHz(pidHz, c.sampleRate);
  return { bytesPerSec, minutes: bytesPerSec > 0 ? flashBytes / bytesPerSec / 60 : Infinity };
}

/** What would change, as human lines, for the confirm dialog. */
export function describeChanges(from: BbConfig, to: BbConfig, apiMinor: number, pidHz: number): string[] {
  const out: string[] = [];
  if (from.sampleRate !== to.sampleRate) out.push(`Log rate ${rateLabel(pidHz, from.sampleRate)} → ${rateLabel(pidHz, to.sampleRate)}`);
  for (const f of fieldTable(apiMinor)) {
    const a = isFieldOn(from.mask, f), b = isFieldOn(to.mask, f);
    if (a !== b) out.push(`${f.label}: ${a ? 'on' : 'off'} → ${b ? 'on' : 'off'}`);
  }
  return out;
}

/** Same settings as CLI commands, for pasting into Betaflight Configurator's CLI. */
export function cliCommands(c: BbConfig, apiMinor: number): string {
  const lines = [`set blackbox_sample_rate = 1/${2 ** c.sampleRate}`];
  for (const f of fieldTable(apiMinor)) if (f.cli) lines.push(`set blackbox_disable_${f.cli} = ${isFieldOn(c.mask, f) ? 'OFF' : 'ON'}`);
  lines.push('save');
  return lines.join('\n');
}
