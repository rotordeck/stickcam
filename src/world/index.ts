// The hero world: a live three.js dusk scene behind the preview canvas. Public API:
//   world.mount(container)  -> boolean (false = no WebGL: the host keeps its CSS gradient)
//   world.setMode('idle' | 'driven' | 'posed')   idle = looping autopilot, driven = the sticks passed to update(),
//                                               posed = the camera pose passed to setPose() (see pose.ts)
//   world.update({ roll, pitch, yaw, throttle, dt })   sticks for driven mode (dt only steps a host-driven world)
//   world.setPose(pose)   camera pose for posed mode: a pure function of the playback frame, set by the host
//   world.resize(w, h), world.setActive(bool), world.dispose()
// It runs its own rAF loop (one WebGLRenderer, DPR capped at 2) and stops while the tab is hidden,
// the container is off screen or display:none, or the host says it is inactive.
import * as THREE from 'three';
import { Flight, STEP, type Sticks } from './flight.ts';
import { Gates } from './gates.ts';
import type { Pose } from './pose.ts';
import { FOG_HEX, SUN_DIR, makeSky } from './sky.ts';
import { Terrain, makeRidges } from './terrain.ts';

export type WorldMode = 'idle' | 'driven' | 'posed';
export interface WorldInput extends Sticks { dt?: number }
export interface MountOptions { autoRun?: boolean; onLost?: () => void }

const MAX_DT = 0.1;

export class World {
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.3, 1600);
  private flight = new Flight();
  private input: Sticks = { roll: 0, pitch: 0, yaw: 0, throttle: 0.4 };
  private mode: WorldMode = 'idle';
  private terrain!: Terrain; private gates!: Gates;
  private sky!: ReturnType<typeof makeSky>; private ridges!: THREE.Group;
  private container: HTMLElement | null = null;
  private io: IntersectionObserver | null = null; private ro: ResizeObserver | null = null;
  private raf = 0; private last = 0; private acc = 0; private time = 0;
  private visible = true; private enabled = true; private autoRun = true;
  private w = 0; private h = 0; private ratio = 1; private slow = 0; private slowN = 0;
  private readonly cap = Math.min(2, window.devicePixelRatio || 1);
  private onVis = () => this.sync();
  private onLost: (() => void) | undefined;

  get mounted() { return !!this.renderer; }

  mount(container: HTMLElement, opts: MountOptions = {}): boolean {
    if (this.renderer) return true;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    } catch { return false; }
    this.renderer = renderer;
    this.autoRun = opts.autoRun !== false;
    this.onLost = opts.onLost;
    this.container = container;
    this.ratio = this.cap;
    renderer.setPixelRatio(this.ratio);
    renderer.domElement.className = 'world-canvas';
    renderer.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.onLost?.(); });
    container.appendChild(renderer.domElement);

    try { this.build(container); } catch (e) {
      console.warn('world: scene setup failed, keeping the gradient', e);
      this.dispose();
      return false;
    }
    return true;
  }

  private build(container: HTMLElement) {
    const renderer = this.renderer!;
    const fog = new THREE.Color(FOG_HEX);
    this.scene.background = fog;
    this.scene.fog = new THREE.FogExp2(fog, 0.0042);
    const hemi = new THREE.HemisphereLight(0xb09ac8, 0x8a7a52, 1.9);
    const sun = new THREE.DirectionalLight(0xffb27a, 2.6);
    sun.position.copy(SUN_DIR);
    this.scene.add(hemi, sun);
    this.sky = makeSky();
    this.ridges = makeRidges(fog);
    this.terrain = new Terrain();
    this.gates = new Gates();
    this.scene.add(this.sky.mesh, this.ridges, this.terrain.group, this.gates.group);

    const f = this.flight;
    this.terrain.update(f.x, f.z); this.gates.update(-f.z);
    this.applyCamera();

    this.ro = new ResizeObserver(() => { const r = container.getBoundingClientRect(); this.resize(r.width, r.height); });
    this.ro.observe(container);
    this.io = new IntersectionObserver((es) => { this.visible = es[es.length - 1].isIntersecting; this.sync(); });
    this.io.observe(container);
    document.addEventListener('visibilitychange', this.onVis);
    const r = container.getBoundingClientRect();
    this.resize(r.width || 640, r.height || 360);
    this.render();
    this.sync();
  }

  setMode(mode: WorldMode) { this.mode = mode; }
  /** Host switch: false pauses rendering (e.g. the preview background is not Sky). */
  setActive(on: boolean) { if (on !== this.enabled) { this.enabled = on; this.sync(); } }

  /** Posed mode: put the camera exactly here (no lag, no integration: the host owns the path). */
  setPose(p: Pose) {
    const f = this.flight;
    f.x = p.x; f.y = p.y; f.z = p.z; f.yaw = p.yaw; f.pitch = p.pitch; f.bank = p.bank; f.speed = p.speed;
    f.trickRoll = 0; f.trickPitch = 0;
    if (!this.autoRun) this.render();
  }

  update(i: WorldInput) {
    const c = this.input;
    c.roll = i.roll; c.pitch = i.pitch; c.yaw = i.yaw; c.throttle = i.throttle;
    if (!this.autoRun && i.dt && i.dt > 0) { this.advance(Math.min(i.dt, MAX_DT)); this.render(); }
  }

  resize(w: number, h: number) {
    if (!this.renderer || w < 2 || h < 2) return;
    this.w = w; this.h = h;
    this.renderer.setSize(Math.round(w), Math.round(h), false);
    this.camera.aspect = w / h;
    this.applyCamera();
    this.render();
  }

  dispose() {
    cancelAnimationFrame(this.raf); this.raf = 0;
    document.removeEventListener('visibilitychange', this.onVis);
    this.io?.disconnect(); this.ro?.disconnect();
    this.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      for (const x of Array.isArray(mat) ? mat : mat ? [mat] : []) { (x as THREE.MeshLambertMaterial).map?.dispose(); x.dispose(); }
    });
    this.renderer?.domElement.remove();
    this.renderer?.dispose();
    this.renderer = null;
    this.scene.clear();
  }

  // ---- internals ----

  private sync() {
    const run = this.autoRun && this.enabled && this.visible && !document.hidden && !!this.renderer;
    if (run && !this.raf) { this.last = 0; this.raf = requestAnimationFrame(this.frame); }
    else if (!run && this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
  }

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = this.last ? Math.min(MAX_DT, (now - this.last) / 1000) : 0;
    this.last = now;
    this.advance(dt);
    this.render();
    // a high-DPI screen that can't keep up steps down toward 1 device pixel per CSS pixel
    if (dt > 0 && this.ratio > 1) {
      this.slow += dt; this.slowN++;
      if (this.slowN >= 90) {
        if (this.slow / this.slowN > 1 / 40) { this.ratio = Math.max(1, this.ratio * 0.8); this.renderer!.setPixelRatio(this.ratio); this.renderer!.setSize(Math.round(this.w), Math.round(this.h), false); }
        this.slow = 0; this.slowN = 0;
      }
    }
  };

  private advance(dt: number) {
    this.time += dt; this.acc += dt;
    const driven = this.mode === 'driven';
    if (this.mode === 'posed') this.acc = 0; // the host sets the pose; nothing to integrate
    while (this.acc >= STEP) { this.flight.step(STEP, driven, this.input); this.acc -= STEP; }
    this.sky.uniforms.uTime.value = this.time;
  }

  private applyCamera() {
    const f = this.flight, cam = this.camera;
    cam.position.set(f.x, f.y, f.z);
    cam.rotation.set(f.pitch + f.trickPitch, f.yaw, -f.bank + f.trickRoll, 'YXZ');
    // portrait frames keep a 90° horizontal view; speed widens the lens a touch
    const wide = this.camera.aspect < 1.4 ? Math.min(100, (2 * Math.atan(1 / this.camera.aspect) * 180) / Math.PI) : 68;
    const fov = wide + Math.max(-2, Math.min(7, (f.speed - 14) * 0.3));
    if (Math.abs(fov - cam.fov) > 0.01) { cam.fov = fov; cam.updateProjectionMatrix(); }
  }

  private render() {
    const r = this.renderer;
    if (!r) return;
    const f = this.flight;
    this.applyCamera();
    this.terrain.update(f.x, f.z);
    this.gates.update(-f.z);
    this.sky.mesh.position.copy(this.camera.position);
    this.ridges.position.set(f.x, 0, f.z);
    r.render(this.scene, this.camera);
  }
}

export const world = new World();
