// The gate course: square race gates on legs, alternating orange and teal, placed on the course line.
// A fixed ring of instances is re-seated as the camera advances, so the course never runs out.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GATE_SPACING, groundH, pathDX, pathX, pathY } from './course.ts';

const COUNT = 10, OPEN = 5.6, BAR = 0.36;
const ORANGE = new THREE.Color(0xff9540), TEAL = new THREE.Color(0x36d6c4);

export class Gates {
  readonly group = new THREE.Group();
  private frames: THREE.InstancedMesh; private legs: THREE.InstancedMesh;
  private base = NaN;
  private readonly o = new THREE.Object3D();

  constructor() {
    const box = (w: number, h: number, x: number, y: number) => {
      const b = new THREE.BoxGeometry(w, h, BAR).translate(x, y, 0);
      b.deleteAttribute('uv');
      return b;
    };
    const h = OPEN / 2;
    const frame = mergeGeometries([box(OPEN + BAR, BAR, 0, h), box(OPEN + BAR, BAR, 0, -h), box(BAR, OPEN + BAR, h, 0), box(BAR, OPEN + BAR, -h, 0)], false);
    this.frames = new THREE.InstancedMesh(frame, new THREE.MeshBasicMaterial(), COUNT);
    const leg = new THREE.BoxGeometry(0.22, 1, 0.22).translate(0, 0.5, 0); // unit height, scaled per gate
    this.legs = new THREE.InstancedMesh(leg, new THREE.MeshLambertMaterial({ color: 0x2c2740 }), COUNT * 2);
    for (const m of [this.frames, this.legs]) { m.frustumCulled = false; this.group.add(m); }
    for (let i = 0; i < COUNT; i++) this.frames.setColorAt(i, i % 2 ? TEAL : ORANGE);
  }

  /** Re-seat the ring around the camera's distance along the course (s = -z). */
  update(s: number) {
    const base = Math.floor(s / GATE_SPACING) - 1;
    if (base === this.base) return;
    this.base = base;
    const o = this.o;
    for (let k = 0; k < COUNT; k++) {
      const j = base + k, js = j * GATE_SPACING, slot = ((j % COUNT) + COUNT) % COUNT;
      const x = pathX(js), y = pathY(js), yaw = -Math.atan(pathDX(js));
      o.position.set(x, y, -js); o.rotation.set(0, yaw, 0); o.scale.set(1, 1, 1);
      o.updateMatrix();
      this.frames.setMatrixAt(slot, o.matrix);
      this.frames.setColorAt(slot, ((j % 2) + 2) % 2 ? TEAL : ORANGE);
      const bottom = y - OPEN / 2 - BAR / 2, gy = groundH(x, -js), c = Math.cos(yaw), sn = Math.sin(yaw);
      for (let side = 0; side < 2; side++) {
        const lx = (side ? 1 : -1) * OPEN / 2;
        o.position.set(x + c * lx, gy, -js - sn * lx); o.rotation.set(0, yaw, 0); o.scale.set(1, Math.max(0.1, bottom - gy), 1);
        o.updateMatrix();
        this.legs.setMatrixAt(slot * 2 + side, o.matrix);
      }
    }
    this.frames.instanceMatrix.needsUpdate = this.legs.instanceMatrix.needsUpdate = true;
    this.frames.instanceColor!.needsUpdate = true;
  }
}
