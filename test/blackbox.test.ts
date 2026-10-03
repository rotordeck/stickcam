import { describe, expect, it } from 'vitest';
import { PROFILES, applyProfile, cliCommands, decodeConfig, describeChanges, encodeConfig, estimate, fieldTable, isFieldOn, maskFor, type BbConfig } from '../src/fc/blackbox.ts';

const base = (mask: number | null): BbConfig => ({ supported: true, device: 1, rateNum: 1, rateDenom: 1, pDenom: 2, sampleRate: 2, mask });
const ids = (t: ReturnType<typeof fieldTable>) => t.map((f) => f.id);

describe('blackbox field table', () => {
  it('follows the configurator bit order per API version', () => {
    expect(ids(fieldTable(45))).toEqual(['pid', 'rc', 'setpoint', 'battery', 'mag', 'alt', 'rssi', 'gyro', 'acc', 'debug', 'motor', 'gps', 'rpm', 'gyrounfilt']);
    const t47 = fieldTable(47);
    expect(ids(t47).slice(7, 10)).toEqual(['gyro', 'attitude', 'acc']);
    expect(ids(t47).at(-1)).toBe('servo');
    expect(ids(fieldTable(49)).at(-1)).toBe('pitot');
    fieldTable(49).forEach((f, i) => expect(f.bit).toBe(i));
  });
});

describe('blackbox config codec', () => {
  it('round-trips with and without the mask', () => {
    const wire = encodeConfig(base(0x1234), 47);
    expect(wire).toEqual([1, 1, 1, 2, 0, 2, 0x34, 0x12, 0, 0]);
    // The read reply has `supported` first, then the same fields.
    const reply = Uint8Array.from([1, ...wire]);
    expect(decodeConfig(reply, 47)).toEqual({ ...base(0x1234), pDenom: 2 });
    expect(encodeConfig(base(0), 44)).toEqual([1, 1, 1, 2, 0, 2]);
    expect(decodeConfig(Uint8Array.from([1, 1, 1, 1, 2, 0, 2]), 44).mask).toBeNull();
  });
});

describe('profiles', () => {
  it('StickCam keeps only RC and gyro, at 1/16', () => {
    const t = fieldTable(47);
    const c = applyProfile(base(0), PROFILES[0], t);
    expect(t.filter((f) => isFieldOn(c.mask, f)).map((f) => f.id)).toEqual(['rc', 'gyro']);
    expect(c.sampleRate).toBe(4);
    expect(applyProfile(c, PROFILES[2], t).mask).toBe(0);
    expect(c.mask).toBe(maskFor(t, ['rc', 'gyro']));
  });
  it('lists the changes and CLI commands', () => {
    const t = fieldTable(47);
    const to = applyProfile(base(0), PROFILES[0], t);
    const lines = describeChanges(base(0), to, 47, 4000);
    expect(lines[0]).toContain('1/4 (1 kHz) → 1/16 (250 Hz)');
    expect(lines.some((l) => l.startsWith('PID terms: on → off'))).toBe(true);
    const cli = cliCommands(to, 47);
    expect(cli).toContain('set blackbox_sample_rate = 1/16');
    expect(cli).toContain('set blackbox_disable_pids = ON');
    expect(cli).toContain('set blackbox_disable_rc = OFF');
    expect(cli.endsWith('save')).toBe(true);
  });
  it('estimates more flight time with fewer fields and lower rates', () => {
    const t = fieldTable(47);
    const flash = 16 * 1024 * 1024;
    const full = estimate(applyProfile(base(0), PROFILES[2], t), 47, 4000, flash).minutes;
    const bal = estimate(applyProfile(base(0), PROFILES[1], t), 47, 4000, flash).minutes;
    const slim = estimate(applyProfile(base(0), PROFILES[0], t), 47, 4000, flash).minutes;
    expect(full).toBeLessThan(bal);
    expect(bal).toBeLessThan(slim);
    expect(slim / full).toBeGreaterThan(10);
  });
});
