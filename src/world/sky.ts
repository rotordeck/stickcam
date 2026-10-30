// Dusk sky dome: haze at the horizon (same colour as the scene fog), salmon, violet, indigo overhead,
// a low warm sun, stretched clouds lit from below, a few stars. One draw call, no textures.
import * as THREE from 'three';

export const FOG_HEX = 0xd59a82;
export const SUN_DIR = new THREE.Vector3(0.26, 0.095, -0.96).normalize();

const vert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // pinned to the far plane
}`;

const frag = /* glsl */ `
varying vec3 vDir;
uniform vec3 uSun, uHorizon, uLow, uMid, uTop, uBelow;
uniform float uTime;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * noise(p); p = p * 2.03 + 7.1; a *= 0.5; } return s; }
void main() {
  vec3 d = normalize(vDir);
  float h = d.y, sa = max(dot(d, uSun), 0.0);
  float t = clamp(h, 0.0, 1.0);
  vec3 c = mix(uHorizon, uLow, smoothstep(0.0, 0.1, t));
  c = mix(c, uMid, smoothstep(0.07, 0.42, t));
  c = mix(c, uTop, smoothstep(0.35, 0.95, t));
  c = mix(c, uBelow, smoothstep(0.0, -0.25, h));
  // clouds: a plane overhead, squashed toward the horizon so they stretch into long dusk bands
  vec2 uv = d.xz / (h + 0.14) * vec2(0.8, 2.2) + vec2(uTime * 0.004, 0.0);
  float cl = smoothstep(0.5, 0.82, fbm(uv * 1.25)) * smoothstep(0.015, 0.12, h) * (1.0 - smoothstep(0.55, 0.95, h));
  float glow = pow(sa, 3.0);
  vec3 cc = mix(vec3(0.30, 0.22, 0.42), vec3(1.0, 0.52, 0.34), clamp(glow * 1.6 + (1.0 - smoothstep(0.0, 0.3, h)) * 0.55, 0.0, 1.0));
  cc = mix(cc, vec3(1.0, 0.82, 0.6), pow(sa, 14.0) * 0.8);
  c = mix(c, cc, cl * 0.92);
  // sun: broad glow, tight halo, hard-edged disc
  c += vec3(1.0, 0.5, 0.22) * pow(sa, 5.0) * 0.5 + vec3(1.0, 0.68, 0.38) * pow(sa, 48.0) * 0.8;
  c += vec3(1.0, 0.92, 0.74) * smoothstep(0.99935, 0.99965, sa) * 2.2 * (1.0 - cl * 0.7);
  // stars, only in the dark upper sky and not through clouds
  vec3 q = floor(d * 240.0);
  float st = step(0.9987, hash(q.xy + q.z * 17.0)) * smoothstep(0.32, 0.8, h) * (1.0 - cl);
  c += vec3(0.85, 0.9, 1.0) * st * 0.7;
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

export function makeSky() {
  const u = {
    uSun: { value: SUN_DIR.clone() },
    uHorizon: { value: new THREE.Color(FOG_HEX) },
    uLow: { value: new THREE.Color(0xe98a7a) },
    uMid: { value: new THREE.Color(0x6e5c9c) },
    uTop: { value: new THREE.Color(0x1b2250) },
    uBelow: { value: new THREE.Color(FOG_HEX).multiplyScalar(0.55) },
    uTime: { value: 0 },
  };
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(1000, 32, 20),
    new THREE.ShaderMaterial({ uniforms: u, vertexShader: vert, fragmentShader: frag, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false }),
  );
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  return { mesh, uniforms: u };
}
