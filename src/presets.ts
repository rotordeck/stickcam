// The user's own saved looks: localStorage persistence, a JSON file for moving them between machines,
// and an import plan that finds name clashes. Pure apart from the two storage calls.

import { ALL_PRESETS, PRESETS, type Style } from './render/style.ts';
import { DEFAULT_SETTINGS, type Settings } from './render/layout.ts';

/** The gimbal settings that belong to a look. Output size, fps and format stay with the footage. */
export const LOOK_SETTINGS = ['mode', 'size', 'gap', 'position', 'chaos', 'offsetX', 'offsetY'] as const;
export type LookSettings = Pick<Settings, (typeof LOOK_SETTINGS)[number]>;

export interface Look { presetId: string; overrides: Partial<Style>; settings: LookSettings }
export interface UserPreset { id: string; name: string; look: Look; updated: number }

export const STORAGE_KEY = 'stickcam.presets.v1';
const FALLBACK_PRESET = 'freestyle';

// ---------- clean-up of stored or imported data ----------

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const NULLABLE = new Set<string>(['plate', 'cross', 'dotRing', 'hot']);

/** Keep an override only if its key exists on Style and its value has the same shape as the built-in one. */
function validOverride(k: string, v: unknown): boolean {
  const ref = (PRESETS[0].style as unknown as Record<string, unknown>)[k];
  if (!(k in PRESETS[0].style)) return false;
  if (v === null) return NULLABLE.has(k) || ref === null;
  if (Array.isArray(ref)) return Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (isObj(ref)) return isObj(v) && Object.values(v).every((x) => typeof x === 'string');
  if (ref === null) return typeof v === 'string';
  if (typeof ref === 'number') return typeof v === 'number' && Number.isFinite(v);
  return typeof v === typeof ref;
}

export function sanitizeLook(raw: unknown): Look {
  const r = isObj(raw) ? raw : {};
  const presetId = typeof r.presetId === 'string' && ALL_PRESETS.some((p) => p.id === r.presetId) ? r.presetId : FALLBACK_PRESET;
  const overrides: Record<string, unknown> = {};
  if (isObj(r.overrides)) for (const [k, v] of Object.entries(r.overrides)) if (validOverride(k, v)) overrides[k] = v;
  const s = isObj(r.settings) ? r.settings : {};
  const num = (k: 'size' | 'gap' | 'chaos' | 'offsetX' | 'offsetY') => (typeof s[k] === 'number' && Number.isFinite(s[k]) ? s[k] as number : DEFAULT_SETTINGS[k]);
  const settings: LookSettings = {
    mode: s.mode === 1 ? 1 : 2,
    position: s.position === 'top' || s.position === 'middle' ? s.position : 'bottom',
    size: num('size'), gap: num('gap'), chaos: num('chaos'), offsetX: num('offsetX'), offsetY: num('offsetY'),
  };
  return { presetId, overrides: overrides as Partial<Style>, settings };
}

function sanitizePreset(raw: unknown): UserPreset | null {
  if (!isObj(raw) || typeof raw.name !== 'string' || !raw.name.trim()) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(),
    name: raw.name.trim().slice(0, 60),
    look: sanitizeLook(raw.look),
    updated: typeof raw.updated === 'number' ? raw.updated : Date.now(),
  };
}

export const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

// ---------- storage ----------

export function loadPresets(): UserPreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.map(sanitizePreset).filter((p): p is UserPreset => !!p) : [];
  } catch { return []; }
}
export function savePresets(list: UserPreset[]): boolean {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(list)); return true; } catch { return false; /* storage can be blocked */ }
}

// ---------- helpers ----------

/** JSON with sorted object keys, so two looks compare equal whatever order their keys were written in. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (isObj(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
export const lookEquals = (a: Look, b: Look) => stable(a) === stable(b);

const norm = (name: string) => name.trim().toLowerCase();
export const findByName = (list: UserPreset[], name: string) => list.find((p) => norm(p.name) === norm(name));

/** "Name", or "Name (2)", "Name (3)"… if that is taken. */
export function uniqueName(list: UserPreset[], name: string): string {
  const base = name.trim().replace(/ \(\d+\)$/, '');
  if (!findByName(list, name)) return name.trim();
  for (let i = 2; ; i++) if (!findByName(list, `${base} (${i})`)) return `${base} (${i})`;
}

// ---------- file format ----------

export function exportFile(list: UserPreset[]): string {
  return JSON.stringify({ app: 'stickcam', kind: 'presets', version: 1, exported: new Date().toISOString(), presets: list }, null, 2);
}

export function parseImport(text: string): UserPreset[] {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('This file is not valid JSON.'); }
  if (!isObj(raw) || raw.app !== 'stickcam' || raw.kind !== 'presets') throw new Error('This is not a StickCam presets file.');
  if (!Array.isArray(raw.presets)) throw new Error('The presets file has no presets in it.');
  const list = raw.presets.map(sanitizePreset).filter((p): p is UserPreset => !!p);
  if (!list.length) throw new Error('The presets file has no usable presets in it.');
  return list;
}

// ---------- import ----------

export type ImportKind = 'new' | 'same' | 'conflict';
export interface ImportItem { preset: UserPreset; kind: ImportKind; existing?: UserPreset }
export type ImportChoice = 'skip' | 'add' | 'overwrite' | 'both';

export function planImport(mine: UserPreset[], incoming: UserPreset[]): ImportItem[] {
  return incoming.map((preset) => {
    const existing = findByName(mine, preset.name);
    if (!existing) return { preset, kind: 'new' };
    return { preset, kind: lookEquals(existing.look, preset.look) ? 'same' : 'conflict', existing };
  });
}

/** Default choice per item: new ones are added, identical ones skipped, clashes per `onConflict`. */
export function defaultChoices(plan: ImportItem[], onConflict: 'overwrite' | 'skip' | 'both'): ImportChoice[] {
  return plan.map((it) => (it.kind === 'new' ? 'add' : it.kind === 'same' ? 'skip' : onConflict));
}

export function applyImport(mine: UserPreset[], plan: ImportItem[], choices: ImportChoice[]) {
  const out = mine.map((p) => ({ ...p }));
  const counts = { added: 0, overwritten: 0, skipped: 0 };
  plan.forEach((it, i) => {
    const c = choices[i] ?? 'skip';
    const existing = findByName(out, it.preset.name);
    if (c === 'skip') { counts.skipped++; return; }
    if (c === 'overwrite' && existing) {
      existing.look = it.preset.look; existing.updated = Date.now();
      counts.overwritten++;
      return;
    }
    const name = existing ? uniqueName(out, it.preset.name) : it.preset.name;
    out.push({ ...it.preset, id: newId(), name, updated: Date.now() });
    counts.added++;
  });
  return { list: out, counts };
}
