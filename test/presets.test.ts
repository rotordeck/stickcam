import { describe, expect, it } from 'vitest';
import { applyImport, defaultChoices, exportFile, lookEquals, parseImport, planImport, sanitizeLook, uniqueName, type Look, type UserPreset } from '../src/presets.ts';

const look = (o: Partial<Look> = {}): Look => sanitizeLook({ presetId: 'neon', overrides: { sparks: 1.5 }, settings: { mode: 2, size: 0.2 }, ...o });
const preset = (name: string, l = look()): UserPreset => ({ id: name, name, look: l, updated: 1 });

describe('user presets', () => {
  it('round-trips through the export file', () => {
    const list = [preset('Mine'), preset('Fire', look({ presetId: 'inferno' }))];
    const back = parseImport(exportFile(list));
    expect(back.map((p) => p.name)).toEqual(['Mine', 'Fire']);
    expect(lookEquals(back[1].look, list[1].look)).toBe(true);
  });

  it('rejects files that are not a presets file', () => {
    expect(() => parseImport('not json')).toThrow(/not valid JSON/);
    expect(() => parseImport(JSON.stringify({ app: 'other', kind: 'presets', presets: [] }))).toThrow(/not a StickCam/);
    expect(() => parseImport(JSON.stringify({ app: 'stickcam', kind: 'presets' }))).toThrow(/no presets/);
    expect(() => parseImport(JSON.stringify({ app: 'stickcam', kind: 'presets', presets: [{ nope: 1 }] }))).toThrow(/no usable/);
  });

  it('sanitizes looks', () => {
    const l = sanitizeLook({ presetId: 'gone', overrides: { sparks: 2, bogus: 1, trail: 'x', hot: null, sparkColors: ['#fff'] }, settings: { mode: 1, position: 'sideways', size: 'big' } });
    expect(l.presetId).toBe('arcade');
    expect(l.overrides).toEqual({ sparks: 2, hot: null, sparkColors: ['#fff'] });
    expect(l.settings.mode).toBe(1);
    expect(l.settings.position).toBe('bottom');
    expect(l.settings.size).toBe(0.17);
  });

  it('compares looks independent of key order', () => {
    const a = look({ overrides: { sparks: 1, trail: 0.5 } });
    const b = look({ overrides: { trail: 0.5, sparks: 1 } });
    expect(lookEquals(a, b)).toBe(true);
  });

  it('plans an import: new, identical and clashing, names case-insensitive', () => {
    const mine = [preset('Mine'), preset('Fire')];
    const incoming = [preset('mine '), preset('FIRE', look({ presetId: 'inferno' })), preset('Fresh')];
    expect(planImport(mine, incoming).map((it) => it.kind)).toEqual(['same', 'conflict', 'new']);
  });

  it('applies overwrite, skip and keep-both', () => {
    const mine = [preset('Fire'), preset('Fire (2)')];
    const incoming = [preset('Fire', look({ presetId: 'inferno' })), preset('Fresh')];
    const plan = planImport(mine, incoming);

    const over = applyImport(mine, plan, defaultChoices(plan, 'overwrite'));
    expect(over.counts).toEqual({ added: 1, overwritten: 1, skipped: 0 });
    expect(over.list.find((p) => p.name === 'Fire')!.look.presetId).toBe('inferno');
    expect(mine[0].look.presetId).toBe('neon'); // input untouched

    const keep = applyImport(mine, plan, defaultChoices(plan, 'skip'));
    expect(keep.counts).toEqual({ added: 1, overwritten: 0, skipped: 1 });

    const both = applyImport(mine, plan, ['both', 'skip']);
    expect(both.list.map((p) => p.name)).toEqual(['Fire', 'Fire (2)', 'Fire (3)']);
  });

  it('makes unique names', () => {
    expect(uniqueName([preset('A')], 'B')).toBe('B');
    expect(uniqueName([preset('A')], 'a')).toBe('a (2)');
    expect(uniqueName([preset('A'), preset('A (2)')], 'A (2)')).toBe('A (3)');
  });
});
