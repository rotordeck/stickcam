// Visual style parameters and the built-in presets. Lengths are in gimbal-radius units (r) unless noted.

export interface Style {
  frame: 'circle' | 'square' | 'brackets' | 'none';
  plate: string | null; // gimbal background fill (with alpha)
  ring: string; ringW: number; // ring colour, or 'rainbow' for a rotating conic rainbow
  cross: string | null; grid: number; // crosshair colour; grid lines per half-axis (0 = none)
  dot: string; dotR: number; dotRing: string | null; dotShape: 'circle' | 'square';
  hot: string | null; // dot/trail colour at high stick speed
  glow: number; // shadow glow on rings/dots (r units)
  bloom: number; // 0..1 soft bloom of the effects layer
  trail: number; trailW: number; // trail length (s) and width
  sparks: number; sparkColors: string[]; // spark emission multiplier (0 = off)
  shock: number; // shockwave strength 0..1
  shake: number; // screen-shake amplitude (r units)
  popups: boolean; stats: boolean; // stats = live full-throttle / hang time / armed timers
  font: string; textColor: string; textStroke: string;
  flame: number; // throttle afterburner
  embers: number; // rising embers with throttle
  scan: number; // scanline strength 0..1
  chroma: number; // chromatic aberration offset (r units)
  thrBar: boolean; labels: boolean;
  intro: boolean; // arm/disarm animations
  rainbow: boolean; // hue-cycling trails, halos, sparks and text
  sparkShape: 'streak' | 'star' | 'glyph'; // streaks, twinkling stars, or falling terminal glyphs
  readout: boolean; // live numeric stick readout under the gimbals
  popupStyle: 'pop' | 'terminal'; // bouncy game text, or typed-out terminal lines
  glitch: number; // horizontal glitch bands on impacts
  labelMap: Record<string, string>; // rename popup labels (e.g. WASTED → FATAL ERROR)
}

export interface Preset { id: string; name: string; blurb: string; style: Style }

const BASE: Style = {
  frame: 'circle', plate: 'rgba(0,0,0,0.27)', ring: 'rgba(255,255,255,0.67)', ringW: 0.05,
  cross: 'rgba(255,255,255,0.35)', grid: 0,
  dot: '#ff5252', dotR: 0.14, dotRing: 'rgba(255,255,255,0.86)', hot: null,
  glow: 0, bloom: 0, trail: 0, trailW: 0.12,
  sparks: 0, sparkColors: ['#ffffff', '#fff2a8', '#ffb347', '#ff5e3a'],
  shock: 0, shake: 0, popups: false, stats: false,
  font: "{px}px Bungee, Impact, 'Arial Black', sans-serif", textColor: '#ffffff', textStroke: 'rgba(0,0,0,0.6)',
  flame: 0, embers: 0, scan: 0, chroma: 0, thrBar: false, labels: false, intro: false,
  dotShape: 'circle', rainbow: false, sparkShape: 'streak', readout: false, popupStyle: 'pop', glitch: 0, labelMap: {},
};

export const PRESETS: Preset[] = [
  { id: 'clean', name: 'Clean', blurb: 'The classic: white ring, crosshair, red dot', style: { ...BASE } },
  {
    id: 'minimal', name: 'Minimal', blurb: 'Thin square, white dot, nothing else',
    style: { ...BASE, frame: 'square', plate: null, ring: 'rgba(255,255,255,0.5)', ringW: 0.025, cross: 'rgba(255,255,255,0.2)', dot: '#ffffff', dotR: 0.1, dotRing: null },
  },
  {
    id: 'neon', name: 'Neon', blurb: 'Glowing rings and light-painted trails',
    style: {
      ...BASE, plate: 'rgba(5,0,20,0.35)', ring: '#29e7ff', ringW: 0.04, cross: 'rgba(41,231,255,0.25)', grid: 2,
      dot: '#29e7ff', dotR: 0.12, dotRing: '#ffffff', hot: '#ff3df2', glow: 0.35, bloom: 0.8, trail: 0.45, trailW: 0.14, intro: true,
    },
  },
  {
    id: 'arcade', name: 'Arcade', blurb: 'Sparks, shockwaves, combos and live throttle stats. Go nuts.',
    style: {
      ...BASE, plate: 'rgba(10,0,30,0.4)', ring: '#ffe14d', ringW: 0.05, cross: 'rgba(255,225,77,0.25)', grid: 0,
      dot: '#ffe14d', dotR: 0.13, dotRing: '#ffffff', hot: '#ff3b3b', glow: 0.3, bloom: 0.9, trail: 0.3, trailW: 0.12,
      sparks: 1, shock: 1, shake: 0.12, popups: true, stats: true, flame: 0.5, thrBar: true, intro: true,
      textColor: '#ffe14d', textStroke: '#b0006a',
    },
  },
  {
    id: 'synthwave', name: 'Synthwave', blurb: 'Retro grid, scanlines and RGB split',
    style: {
      ...BASE, frame: 'square', plate: 'rgba(30,0,50,0.45)', ring: '#ff2bd6', ringW: 0.035, cross: 'rgba(0,240,255,0.35)', grid: 4,
      dot: '#00f0ff', dotR: 0.11, dotRing: '#ffffff', hot: '#ff2bd6', glow: 0.3, bloom: 0.7, trail: 0.6, trailW: 0.1,
      sparks: 0.4, sparkColors: ['#ffffff', '#00f0ff', '#ff2bd6', '#7a00ff'], shock: 0.7, shake: 0.05, popups: true,
      scan: 0.5, chroma: 0.05, labels: true, intro: true, textColor: '#00f0ff', textStroke: '#ff2bd6',
      font: "italic 900 {px}px Orbitron, 'Arial Black', sans-serif",
    },
  },
  {
    id: 'inferno', name: 'Inferno', blurb: 'Afterburner flames and rising embers',
    style: {
      ...BASE, plate: 'rgba(25,5,0,0.4)', ring: '#ff7a1a', ringW: 0.05, cross: 'rgba(255,122,26,0.25)',
      dot: '#ffd23f', dotR: 0.13, dotRing: '#fff3c4', hot: '#ff2a00', glow: 0.4, bloom: 1, trail: 0.35, trailW: 0.16,
      sparks: 0.8, sparkColors: ['#fff6d5', '#ffd23f', '#ff7a1a', '#ff2a00'], shock: 0.8, shake: 0.1, popups: true,
      flame: 1, embers: 1, thrBar: true, intro: true, textColor: '#ffd23f', textStroke: '#7a1200',
    },
  },
  {
    id: 'unicorn', name: 'Unicorns & Rainbows', blurb: 'Rainbow trails, twinkling stars, pastel magic',
    style: {
      ...BASE, plate: 'rgba(255,182,230,0.25)', ring: 'rainbow', ringW: 0.075, cross: 'rgba(255,255,255,0.4)',
      dot: '#ffffff', dotR: 0.15, dotRing: '#ff9de2', hot: '#c9a7ff', glow: 0.55, bloom: 0.9, trail: 0.75, trailW: 0.2,
      rainbow: true, sparks: 1.3, sparkShape: 'star', sparkColors: ['#ffffff', '#fff3b0', '#ffc6ff', '#a0e7ff'],
      shock: 0.8, shake: 0.03, popups: true, embers: 0.7, intro: true,
      font: "700 {px}px Fredoka, 'Comic Sans MS', sans-serif", textColor: '#ffffff', textStroke: '#ff5fbf',
      labelMap: { WASTED: 'OOPSIE!', 'PUNCH IT': 'SPARKLE BOOST', ARMED: 'MAGIC ON', DISARMED: 'NAP TIME', 'FULL SEND': 'ZOOMIES!', 'HANG TIME': 'FLOATY TIME' },
    },
  },
  {
    id: 'hacker', name: '80s Cyberpunk Hacker', blurb: 'Green phosphor terminal, glyph rain, glitches',
    style: {
      ...BASE, frame: 'brackets', plate: 'rgba(0,18,4,0.6)', ring: '#33ff66', ringW: 0.04, cross: 'rgba(51,255,102,0.3)', grid: 4,
      dot: '#33ff66', dotR: 0.1, dotRing: null, dotShape: 'square', hot: '#e0ffe6', glow: 0.5, bloom: 0.6, trail: 0.5, trailW: 0.07,
      sparks: 1, sparkShape: 'glyph', sparkColors: ['#f0fff2', '#7dff9a', '#2bd94f', '#0d7a26'],
      shock: 0.45, shake: 0.05, popups: true, popupStyle: 'terminal', stats: true, thrBar: true, readout: true, intro: true,
      scan: 0.6, chroma: 0.02, glitch: 1,
      font: "{px}px VT323, 'Courier New', monospace", textColor: '#33ff66', textStroke: 'rgba(0,0,0,0.85)',
      labelMap: { WASTED: 'FATAL ERROR: CRASH', 'PUNCH IT': 'OVERCLOCK', ARMED: 'ACCESS GRANTED', DISARMED: 'CONNECTION CLOSED', 'FULL SEND': 'MAX_POWER', 'HANG TIME': 'NULL_THRUST' },
    },
  },
];

export const presetById = (id: string) => PRESETS.find((p) => p.id === id) ?? PRESETS[0];
