// The place: a gate course along -Z and the terrain around it. Pure maths, no three.js, so the autopilot
// and the meshes agree on where the path, the ground and the trees are, and tests can run it in node.
export const TAU = Math.PI * 2;
export const GATE_SPACING = 55;

const P1 = 230, P2 = 370, P3 = 190, P4 = 97;

/** Lateral position of the course centre line at distance s along the course (s = -z). */
export const pathX = (s: number) => 18 * Math.sin(s * TAU / P1) + 8 * Math.sin(s * TAU / P2 + 1.3);
export const pathDX = (s: number) => 18 * TAU / P1 * Math.cos(s * TAU / P1) + 8 * TAU / P2 * Math.cos(s * TAU / P2 + 1.3);
export const pathDDX = (s: number) => -18 * (TAU / P1) ** 2 * Math.sin(s * TAU / P1) - 8 * (TAU / P2) ** 2 * Math.sin(s * TAU / P2 + 1.3);
/** Gate and flight altitude along the course. */
export const pathY = (s: number) => 7.5 + 2.6 * Math.sin(s * TAU / P3 + 0.6) + 1.4 * Math.sin(s * TAU / P4);

export const smooth = (a: number, b: number, x: number) => {
  const u = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return u * u * (3 - 2 * u);
};

/** Ground height: a flat valley around the course, rolling hills beyond it. */
export function groundH(x: number, z: number): number {
  const d = Math.abs(x - pathX(-z));
  const m = smooth(45, 190, d) * 0.62;
  if (m === 0) return 0;
  const h = 7 * (Math.sin(x * 0.012 + 0.7) * Math.cos(z * 0.009) + 1)
    + 4 * (Math.sin(x * 0.027 - z * 0.021 + 2) + 1)
    + 1.2 * Math.sin(x * 0.07 + z * 0.05) * Math.sin(z * 0.06);
  return m * Math.max(0, h);
}

/** Integer hash -> [0,1). Same input, same tree, on every machine. */
export function hash2(i: number, j: number, k = 0): number {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263) ^ Math.imul(k | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
