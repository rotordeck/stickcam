// Output canvas size and gimbal placement. Sizing follows StickHud.layout (gimbal = 17 % of the short side).

export type Position = 'bottom' | 'middle' | 'top';

export interface Settings {
  /** Output size; ignored for the tight crop, which derives its size from `cropRef`. */
  width: number; height: number;
  crop: boolean;
  /** Short side of the footage the tight crop is meant for (sets the gimbal pixel size). */
  cropRef: number;
  position: Position;
  size: number; // gimbal box as a fraction of the short side
  gap: number; // space between gimbals as a fraction of the gimbal box
  /** Fine position nudge as a fraction of the frame (+x right, +y down); full-frame layouts only. */
  offsetX: number; offsetY: number;
  mode: 1 | 2;
  fps: number;
  chaos: number; // 0..2 effect intensity
}

export const DEFAULT_SETTINGS: Settings = {
  width: 1920, height: 1080, crop: false, cropRef: 1080, position: 'bottom', size: 0.17, gap: 0.14, offsetX: 0, offsetY: 0, mode: 2, fps: 60, chaos: 1,
};

export interface Layout {
  W: number; H: number;
  r: number; // gimbal radius (px)
  left: { x: number; y: number }; right: { x: number; y: number };
  hud: { x: number; y: number; w: number; h: number }; // box around both gimbals
}

const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);

export function computeLayout(s: Settings): Layout {
  const g = Math.max(16, (s.crop ? s.cropRef : Math.min(s.width, s.height)) * s.size);
  const r = g * 0.46;
  const hudW = g * 2 + g * s.gap;
  if (s.crop) {
    // Room for popups above, sparks/shockwaves around and labels below.
    const mx = g * 0.5, top = g * 1.05, bottom = g * 0.4;
    const W = even(hudW + mx * 2), H = even(g + top + bottom);
    const x = (W - hudW) / 2, y = top;
    return { W, H, r, left: { x: x + g / 2, y: y + g / 2 }, right: { x: x + hudW - g / 2, y: y + g / 2 }, hud: { x, y, w: hudW, h: g } };
  }
  const W = even(s.width), H = even(s.height);
  const x = (W - hudW) / 2 + (s.offsetX ?? 0) * W;
  const y = (s.position === 'bottom' ? H - g - H * 0.04 : s.position === 'top' ? H * 0.04 + g * 0.9 : (H - g) / 2) + (s.offsetY ?? 0) * H;
  return { W, H, r, left: { x: x + g / 2, y: y + g / 2 }, right: { x: x + hudW - g / 2, y: y + g / 2 }, hud: { x, y, w: hudW, h: g } };
}

export const SIZE_PRESETS: { id: string; label: string; w: number; h: number; crop?: boolean }[] = [
  { id: 'crop', label: 'Tight crop (fastest)', w: 0, h: 0, crop: true },
  { id: '1080p', label: '1920×1080', w: 1920, h: 1080 },
  { id: '1440p', label: '2560×1440', w: 2560, h: 1440 },
  { id: '4k', label: '3840×2160', w: 3840, h: 2160 },
  { id: '2.7k', label: '2704×1520 (GoPro 2.7K)', w: 2704, h: 1520 },
  { id: 'vertical', label: '1080×1920 (vertical)', w: 1080, h: 1920 },
  { id: 'square', label: '1080×1080', w: 1080, h: 1080 },
];
