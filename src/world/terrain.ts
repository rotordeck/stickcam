// Ground, trees and far ridges. The ground is one mesh that re-centres on the camera in whole grid cells
// (same lattice, so nothing pops); trees are instanced and re-seeded from a cell hash, so the same
// spot always grows the same tree. Nothing here allocates per frame: work only happens when a cell is crossed.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { TAU, groundH, hash2, mulberry32, pathX, smooth } from './course.ts';

const N = 85, SP = 8.5; // vertices per side, spacing (m): ±357 m, fogged out well before the edge
const UV = 0.05; // texture tiles per metre
const CELL = 15, RAD = 25; // tree cell size (m), cells each way: ±375 m
const MAX_PINE = 900, MAX_ROUND = 500;

const col = (hex: number) => new THREE.Color(hex);

function grassTexture(): THREE.CanvasTexture {
  const S = 256, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const rnd = mulberry32(11);
  // tileable low-frequency mottling (integer frequencies), then blades drawn with wrap-around
  const img = g.createImageData(S, S);
  const comps = Array.from({ length: 7 }, () => ({ fx: 1 + Math.floor(rnd() * 6), fy: 1 + Math.floor(rnd() * 6), ph: rnd() * TAU, a: 0.35 + rnd() * 0.65 }));
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let v = 0;
    for (const k of comps) v += k.a * Math.sin(TAU * (k.fx * x + k.fy * y) / S + k.ph);
    const t = 0.93 + 0.07 * (v / 3);
    const o = (y * S + x) * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = Math.max(0, Math.min(255, t * 255));
    img.data[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  for (let i = 0; i < 2600; i++) {
    const x = rnd() * S, y = rnd() * S, len = 3 + rnd() * 7, a = (rnd() - 0.5) * 1.2 - Math.PI / 2;
    g.strokeStyle = rnd() < 0.5 ? `rgba(255,255,255,${0.05 + rnd() * 0.1})` : `rgba(0,0,0,${0.05 + rnd() * 0.12})`;
    g.lineWidth = 0.8 + rnd() * 0.8;
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      g.beginPath(); g.moveTo(x + ox, y + oy); g.lineTo(x + ox + Math.cos(a) * len, y + oy + Math.sin(a) * len); g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Merge parts with a flat vertex colour each (uvs dropped so the attribute sets match). */
function merged(parts: [THREE.BufferGeometry, THREE.Color][]): THREE.BufferGeometry {
  const gs = parts.map(([indexed, c]) => {
    const geo = indexed.index ? indexed.toNonIndexed() : indexed; // Polyhedra are non-indexed, cones are indexed: merge needs one kind
    geo.deleteAttribute('uv');
    const n = geo.getAttribute('position').count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return geo;
  });
  return mergeGeometries(gs, false);
}

function pineGeometry() {
  const bark = col(0x3a2a20), leaf = col(0x1f3a2e), leaf2 = col(0x2b4a30);
  const cone = (r: number, h: number, y: number, c: THREE.Color) => [new THREE.ConeGeometry(r, h, 7, 1).translate(0, y + h / 2, 0), c] as [THREE.BufferGeometry, THREE.Color];
  return merged([
    [new THREE.CylinderGeometry(0.22, 0.32, 2, 5).translate(0, 1, 0), bark],
    cone(2.7, 4.6, 1.4, leaf), cone(2.2, 4.0, 3.6, leaf2), cone(1.6, 3.4, 5.8, leaf), cone(1.0, 2.6, 7.8, leaf2),
  ]);
}

function roundGeometry() {
  const bark = col(0x3a2a20), leaf = col(0x3f5a2c), leaf2 = col(0x56612e);
  const blob = (r: number, x: number, y: number, z: number, c: THREE.Color) => [new THREE.IcosahedronGeometry(r, 1).translate(x, y, z), c] as [THREE.BufferGeometry, THREE.Color];
  return merged([
    [new THREE.CylinderGeometry(0.28, 0.4, 3.4, 5).translate(0, 1.7, 0), bark],
    blob(2.8, 0, 5.4, 0, leaf), blob(2.0, 1.6, 4.6, 0.6, leaf2), blob(1.9, -1.4, 6.4, -0.5, leaf2),
  ]);
}

export class Terrain {
  readonly group = new THREE.Group();
  private ground: THREE.Mesh;
  private gpos: THREE.BufferAttribute; private gnor: THREE.BufferAttribute; private gcol: THREE.BufferAttribute; private guv: THREE.BufferAttribute;
  private heights = new Float32Array((N + 2) * (N + 2));
  private gcx = NaN; private gcz = NaN;
  private pines: THREE.InstancedMesh; private rounds: THREE.InstancedMesh;
  private tcx = NaN; private tcz = NaN;
  private readonly tint = new THREE.Color();
  private readonly cA = col(0x6b7a30); private readonly cB = col(0xa08a46); private readonly cHill = col(0x4a5e38); private readonly cLane = col(0x93a049);
  private readonly tmp = new THREE.Color();

  constructor() {
    const geo = new THREE.BufferGeometry();
    this.gpos = new THREE.BufferAttribute(new Float32Array(N * N * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.gnor = new THREE.BufferAttribute(new Float32Array(N * N * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.gcol = new THREE.BufferAttribute(new Float32Array(N * N * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.guv = new THREE.BufferAttribute(new Float32Array(N * N * 2), 2).setUsage(THREE.DynamicDrawUsage);
    const idx = new Uint16Array((N - 1) * (N - 1) * 6);
    let k = 0;
    for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
      const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
    // x/z are local to the mesh (which sits on the grid centre), so they never change; only y, normals, colour, uv do
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      this.gpos.setXYZ(j * N + i, (i - (N - 1) / 2) * SP, 0, (j - (N - 1) / 2) * SP);
    }
    geo.setAttribute('position', this.gpos); geo.setAttribute('normal', this.gnor);
    geo.setAttribute('color', this.gcol); geo.setAttribute('uv', this.guv);
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: grassTexture(), vertexColors: true }));
    this.ground.frustumCulled = false;
    this.group.add(this.ground);

    const treeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.pines = new THREE.InstancedMesh(pineGeometry(), treeMat, MAX_PINE);
    this.rounds = new THREE.InstancedMesh(roundGeometry(), treeMat, MAX_ROUND);
    for (const m of [this.pines, this.rounds]) {
      m.frustumCulled = false; m.count = 0;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.setColorAt(0, this.tint); // allocates instanceColor once
      m.instanceColor!.setUsage(THREE.DynamicDrawUsage);
      this.group.add(m);
    }
  }

  update(camX: number, camZ: number) {
    const gx = Math.round(camX / SP) * SP, gz = Math.round(camZ / SP) * SP;
    if (gx !== this.gcx || gz !== this.gcz) { this.gcx = gx; this.gcz = gz; this.rebuildGround(gx, gz); }
    const tx = Math.round(camX / CELL), tz = Math.round(camZ / CELL);
    if (tx !== this.tcx || tz !== this.tcz) { this.tcx = tx; this.tcz = tz; this.rebuildTrees(tx, tz); }
  }

  private rebuildGround(gx: number, gz: number) {
    const M = N + 2, H = this.heights, half = (N - 1) / 2;
    for (let j = 0; j < M; j++) for (let i = 0; i < M; i++) {
      H[j * M + i] = groundH(gx + (i - 1 - half) * SP, gz + (j - 1 - half) * SP);
    }
    const pos = this.gpos.array as Float32Array, nor = this.gnor.array as Float32Array, uv = this.guv.array as Float32Array;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const v = j * N + i, hc = (j + 1) * M + i + 1;
      const x = gx + (i - half) * SP, z = gz + (j - half) * SP;
      pos[v * 3 + 1] = H[hc];
      // normal from central differences of the height lattice
      const nx = H[hc - 1] - H[hc + 1], nz = H[hc - M] - H[hc + M], ny = 2 * SP, l = 1 / Math.hypot(nx, ny, nz);
      nor[v * 3] = nx * l; nor[v * 3 + 1] = ny * l; nor[v * 3 + 2] = nz * l;
      uv[v * 2] = x * UV; uv[v * 2 + 1] = z * UV;
      this.paint(v, x, z, H[hc]);
    }
    this.ground.position.set(gx, 0, gz);
    this.gpos.needsUpdate = this.gnor.needsUpdate = this.gcol.needsUpdate = this.guv.needsUpdate = true;
  }

  /** Dusk meadow colour: mottled green and dry grass, darker on the hills, a mown lane under the gates. */
  private paint(v: number, x: number, z: number, h: number) {
    const n = 0.5 + 0.25 * Math.sin(x * 0.031 + Math.sin(z * 0.017) * 2) + 0.25 * Math.sin(z * 0.043 - x * 0.012 + 1);
    const t = this.tmp.copy(this.cA).lerp(this.cB, smooth(0.35, 0.85, n) * 0.8);
    t.lerp(this.cHill, smooth(2, 14, h) * 0.6);
    const d = Math.abs(x - pathX(-z));
    t.lerp(this.cLane, (1 - smooth(5, 16, d)) * 0.7);
    const a = this.gcol.array as Float32Array;
    a[v * 3] = t.r; a[v * 3 + 1] = t.g; a[v * 3 + 2] = t.b;
  }

  private rebuildTrees(cx: number, cz: number) {
    let np = 0, nr = 0;
    const pm = this.pines.instanceMatrix.array as Float32Array, rm = this.rounds.instanceMatrix.array as Float32Array;
    const pc = this.pines.instanceColor!.array as Float32Array, rc = this.rounds.instanceColor!.array as Float32Array;
    for (let j = cz - RAD; j <= cz + RAD; j++) for (let i = cx - RAD; i <= cx + RAD; i++) {
      const x = (i + hash2(i, j, 1)) * CELL, z = (j + hash2(i, j, 2)) * CELL;
      const d = Math.abs(x - pathX(-z));
      if (d < 22) continue;
      if (hash2(i, j, 0) > 0.07 + 0.5 * smooth(30, 140, d) * (0.5 + 0.5 * Math.sin(x * 0.006 + z * 0.0047))) continue;
      const round = hash2(i, j, 3) > 0.7;
      if (round ? nr >= MAX_ROUND : np >= MAX_PINE) continue;
      const s = 0.8 + 0.9 * hash2(i, j, 4), sy = s * (0.9 + 0.3 * hash2(i, j, 5)), a = hash2(i, j, 6) * TAU;
      const c = Math.cos(a) * s, sn = Math.sin(a) * s, o = (round ? nr : np) * 16, m = round ? rm : pm;
      m[o] = c; m[o + 1] = 0; m[o + 2] = -sn; m[o + 3] = 0;
      m[o + 4] = 0; m[o + 5] = sy; m[o + 6] = 0; m[o + 7] = 0;
      m[o + 8] = sn; m[o + 9] = 0; m[o + 10] = c; m[o + 11] = 0;
      m[o + 12] = x; m[o + 13] = groundH(x, z) - 0.3; m[o + 14] = z; m[o + 15] = 1;
      const k = 0.75 + 0.5 * hash2(i, j, 7), arr = round ? rc : pc, q = (round ? nr : np) * 3;
      arr[q] = k; arr[q + 1] = k * (0.95 + 0.1 * hash2(i, j, 8)); arr[q + 2] = k;
      if (round) nr++; else np++;
    }
    this.pines.count = np; this.rounds.count = nr;
    this.pines.instanceMatrix.needsUpdate = this.rounds.instanceMatrix.needsUpdate = true;
    this.pines.instanceColor!.needsUpdate = this.rounds.instanceColor!.needsUpdate = true;
  }
}

/** Two rings of far hills that rise out of the haze: foot = fog colour, crest = tinted. Follows the camera in x/z. */
export function makeRidges(fog: THREE.Color): THREE.Group {
  const g = new THREE.Group();
  const ring = (radius: number, crest: number, base: number, amp: number, seed: number, mix: number) => {
    const SEG = 180, pos: number[] = [], colr: number[] = [], idx: number[] = [];
    const top = col(crest).lerp(fog, mix), foot = fog;
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * TAU;
      const h = base + amp * (0.5 * Math.sin(3 * a + seed) + 0.3 * Math.sin(7 * a + seed * 2.1) + 0.15 * Math.sin(17 * a + seed * 0.7) + 0.55);
      const x = Math.sin(a) * radius, z = -Math.cos(a) * radius;
      pos.push(x, -30, z, x, h, z);
      colr.push(foot.r, foot.g, foot.b, top.r, top.g, top.b);
      if (i < SEG) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
    geo.setIndex(idx);
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide }));
    m.frustumCulled = false;
    return m;
  };
  g.add(ring(820, 0x7a5f86, 25, 70, 1.7, 0.45), ring(640, 0x4a3f62, 12, 42, 4.1, 0.2));
  return g;
}
