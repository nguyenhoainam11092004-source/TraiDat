/**
 * Jet fighter model for the flight mode.
 *
 * Built from code (no download needed): a single-engine fighter shaped like an F-16 —
 * blended fuselage with a bubble canopy and a ventral intake, cropped-delta wings with
 * leading-edge root extensions, all-moving tailerons, fin with rudder, nozzle with an
 * afterburner plume (shock diamonds), navigation lights, wingtip missiles and bombs on
 * the pylons. Metal materials reflect a small procedural sky (PMREM environment map).
 *
 * A glTF model can replace the airframe: drop `models/jet.glb` into the project (see
 * models/README.md). The plume, lights and shadow are kept.
 *
 * Units: metres. The nose points to −Z, up is +Y, the right wing is +X.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SHADERS from './shaders.js';

const DEG = Math.PI / 180;

/* ------------------------------------------------------------------ */
/* Textures & environment                                              */
/* ------------------------------------------------------------------ */

/** Light grey panel texture: panel lines, rivets and mild weathering (multiplies the paint). */
function panelTexture() {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e6e6e6';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = 6 + Math.random() * 40;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    const tone = Math.random() < 0.5 ? '205,205,205' : '250,250,250';
    g.addColorStop(0, `rgba(${tone},0.35)`);
    g.addColorStop(1, `rgba(${tone},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.strokeStyle = 'rgba(70,70,70,0.55)';
  ctx.lineWidth = 1.2;
  const rows = 8;
  for (let r = 0; r <= rows; r++) {
    const y = (r / rows) * size + (r % 2) * 3;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y);
    ctx.stroke();
    for (let x = Math.random() * 40; x < size; x += 50 + Math.random() * 110) {
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + size / rows);
      ctx.stroke();
    }
  }
  ctx.fillStyle = 'rgba(90,90,90,0.4)';
  for (let r = 0; r <= rows; r++) {
    const y = (r / rows) * size + 4;
    for (let x = 2; x < size; x += 7) ctx.fillRect(x, y, 1.2, 1.2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** Light/dark stripes for the nozzle petals. */
export function stripeTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#d8d4cc';
  ctx.fillRect(0, 0, 256, 32);
  for (let i = 0; i < 16; i++) {
    ctx.fillStyle = i % 2 ? 'rgba(60,55,50,0.55)' : 'rgba(255,250,240,0.25)';
    ctx.fillRect(i * 16, 0, 2, 32);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Soft round glow (navigation lights, nozzle). */
export function glowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.15, 'rgba(255,255,255,0.75)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.18)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Small sky environment for reflections: blue sky, bright horizon, brown ground, a sun spot.
 * Its up is +Y; materials rotate it to the aircraft's local up (see setEnvironmentFrame).
 */
function createEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const scene = new THREE.Scene();
  const geometry = new THREE.SphereGeometry(10, 48, 24);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        float y = vDir.y;
        vec3 sky = mix(vec3(0.75, 0.82, 0.9), vec3(0.2, 0.38, 0.7), smoothstep(0.0, 0.7, y));
        vec3 ground = mix(vec3(0.36, 0.34, 0.3), vec3(0.16, 0.15, 0.13), smoothstep(0.0, -0.6, y));
        vec3 c = y > 0.0 ? sky : ground;
        c += vec3(1.0, 0.96, 0.88) * pow(max(dot(vDir, normalize(vec3(0.35, 0.75, 0.3))), 0.0), 90.0) * 6.0;
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(geometry, material));
  const target = pmrem.fromScene(scene, 0.01);
  pmrem.dispose();
  geometry.dispose();
  material.dispose();
  return target.texture;
}

/** One environment map per renderer, shared by every aircraft. */
const environments = new WeakMap();
function sharedEnvironment(renderer) {
  if (!environments.has(renderer)) environments.set(renderer, createEnvironment(renderer));
  return environments.get(renderer);
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

/** Lathe around the Z axis from [radius, z] pairs ordered from front to back. */
export function latheZ(profile, segments = 32) {
  const g = new THREE.LatheGeometry(profile.map(([r, z]) => new THREE.Vector2(Math.max(r, 1e-4), z)), segments);
  g.rotateX(Math.PI / 2); // lathe axis (Y) → model Z
  return g;
}

/** Flat planform in the XZ plane (points as [x, z]), extruded `thickness` along Y and centred. */
export function planformXZ(points, thickness, bevel = 0.03) {
  const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, -z)));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: thickness, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 10,
  });
  g.rotateX(-Math.PI / 2); // shape (x, y) → model (x, −z); extrusion → +Y
  g.translate(0, -thickness / 2, 0);
  return g;
}

/** Flat planform in the ZY plane (points as [z, y]), extruded `thickness` along X and centred. */
export function planformZY(points, thickness, bevel = 0.025) {
  const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(-z, y)));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: thickness, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 6,
  });
  g.rotateY(Math.PI / 2); // shape (x, y) → model (−z, y); extrusion → +X
  g.translate(-thickness / 2, 0, 0);
  return g;
}

function scaleUv(geometry, su, sv) {
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  return geometry;
}

/** Fuselage cross-section: wider than tall, flatter belly, dorsal spine behind the canopy. */
function shapeFuselage(geometry, inflate = 1) {
  const p = geometry.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    let y = p.getY(i);
    const z = p.getZ(i);
    const r = Math.hypot(x, y) || 1;
    if (y > 0) {
      const spine = 0.24 * Math.min(Math.max((z + 2.6) / 1.6, 0), 1) * Math.min(Math.max((5.8 - z) / 2.2, 0), 1);
      y += spine * (y / r) ** 3;
    } else {
      y *= 0.88;
    }
    p.setXYZ(i, x * 1.12 * inflate, y * 0.96 * inflate, z);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/* ------------------------------------------------------------------ */
/* Bombs                                                               */
/* ------------------------------------------------------------------ */
const BOMB_SHAPES = {
  mk82: { length: 2.22, radius: 0.137, color: '#4f5a3a', grid: false }, // 250 kg class
  mk84: { length: 3.28, radius: 0.229, color: '#4b5537', grid: false }, // 1 t class
  big: { length: 6.4, radius: 0.515, color: '#5d6150', grid: true },    // 10 t class, lattice fins
};

const sharedMaterials = new Map();
function sharedMaterial(key, create) {
  if (!sharedMaterials.has(key)) sharedMaterials.set(key, create());
  return sharedMaterials.get(key);
}

/**
 * A general-purpose bomb, nose to −Z: ogive nose, yellow band (filled), boat tail, fins.
 * Geometries are owned by the returned group; materials are shared (never dispose them).
 */
export function createBombMesh(kind, envMap = null) {
  const s = BOMB_SHAPES[kind] || BOMB_SHAPES.mk82;
  const L = s.length;
  const R = s.radius;
  const paint = sharedMaterial(`bomb-${kind}`, () => new THREE.MeshStandardMaterial({
    color: s.color, metalness: 0.35, roughness: 0.6, envMap, envMapIntensity: 0.6,
  }));
  const yellow = sharedMaterial('bomb-band', () => new THREE.MeshStandardMaterial({ color: '#d8b628', roughness: 0.6 }));
  const group = new THREE.Group();

  const profile = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8; // ogive nose over 28 % of the length
    profile.push([R * Math.sqrt(1 - (1 - t) * (1 - t)), -L / 2 + t * L * 0.28]);
  }
  profile.push([R, L * 0.12], [R * 0.93, L * 0.24], [R * 0.55, L * 0.42], [R * 0.42, L * 0.5]);
  group.add(new THREE.Mesh(latheZ(profile, 20), paint));

  const band = new THREE.Mesh(new THREE.CylinderGeometry(R * 1.005, R * 1.005, L * 0.035, 20, 1, true).rotateX(Math.PI / 2), yellow);
  band.position.z = -L * 0.13;
  group.add(band);

  if (s.grid) {
    const frame = sharedMaterial('bomb-grid', () => new THREE.MeshStandardMaterial({ color: '#3f4236', metalness: 0.5, roughness: 0.5 }));
    const fw = R * 1.25;
    const t = 0.03;
    for (let k = 0; k < 4; k++) {
      const fin = new THREE.Group();
      const bar = (w, h, x, y) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.18), frame);
        m.position.set(R * 0.9 + x, y, 0);
        fin.add(m);
      };
      bar(fw, t, fw / 2, -fw / 2);
      bar(fw, t, fw / 2, fw / 2);
      bar(t, fw, 0, 0);
      bar(t, fw, fw, 0);
      for (let i = 1; i < 5; i++) {
        bar(t * 0.6, fw, (i / 5) * fw, 0);
        bar(fw, t * 0.6, fw / 2, -fw / 2 + (i / 5) * fw);
      }
      fin.position.z = L * 0.4;
      fin.rotation.z = (k * Math.PI) / 2;
      group.add(fin);
    }
  } else {
    const finGeo = planformXZ([[0, L * 0.3], [R * 1.6, L * 0.44], [R * 1.6, L * 0.5], [0, L * 0.5]], 0.012, 0.004);
    for (let k = 0; k < 4; k++) {
      const fin = new THREE.Mesh(finGeo, paint);
      fin.rotation.z = Math.PI / 4 + (k * Math.PI) / 2;
      group.add(fin);
    }
  }
  return group;
}

/** Disposes the geometries of a bomb created by createBombMesh (materials are shared). */
export function disposeBombMesh(group) {
  const seen = new Set();
  group.traverse((o) => {
    if (o.geometry && !seen.has(o.geometry)) {
      seen.add(o.geometry);
      o.geometry.dispose();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Jet                                                                 */
/* ------------------------------------------------------------------ */
/**
 * F-16 (and the base of the other aircraft). `_buildAirframe()` builds the meshes and sets the
 * aircraft's specification used by the effects and the flight mode:
 *   name, labels { cannon, missile, bombs }  HUD texts
 *   nozzles, plumeRadius                     afterburner plumes (one per engine)
 *   navSpots [left, right, tail], strobeSpot navigation lights
 *   stores { kind: [[x, y, z, roll?], …] }   bombs hanging under the pylons
 *   tailerons, rudders                       moving control surfaces
 *   gun, cockpitEye, chaseOffset, chaseLook  positions on the airframe (m)
 *   shadowOutline, shadowExtent              top-down silhouette for the ground shadow
 */
export class JetModel {
  constructor({ renderer }) {
    this.group = new THREE.Group();
    this.group.name = 'jet';
    this.envMap = sharedEnvironment(renderer);
    this.materials = [];
    this._envEuler = new THREE.Euler();
    this._envMatrix = new THREE.Matrix4();
    this.storeKind = 'mk82';
    this.custom = false;

    this.airframe = new THREE.Group();
    this.group.add(this.airframe);
    this._buildAirframe();
    this._buildStores();
    this._buildEffects();
    this.setStores('mk82');
  }

  _material(params, physical = false) {
    const m = physical ? new THREE.MeshPhysicalMaterial(params) : new THREE.MeshStandardMaterial(params);
    m.envMap = this.envMap;
    this.materials.push(m);
    return m;
  }

  _buildAirframe() {
    const panels = panelTexture();
    this.panelTexture = panels;
    const body = this._material({ color: '#848c96', metalness: 0.42, roughness: 0.5, map: panels, bumpMap: panels, bumpScale: 0.5 });
    const dark = this._material({ color: '#565d66', metalness: 0.35, roughness: 0.55, map: panels });
    const intake = this._material({ color: '#060708', roughness: 0.95, metalness: 0 });
    const glass = this._material({
      color: '#a88a50', metalness: 0.05, roughness: 0.03, transparent: true, opacity: 0.62,
      envMapIntensity: 2.2, clearcoat: 1, clearcoatRoughness: 0.02,
    }, true);
    const frame = this._material({ color: '#3c4048', metalness: 0.5, roughness: 0.45 });
    const nozzleMat = this._material({ color: '#6b655c', metalness: 0.88, roughness: 0.34, map: stripeTexture(), side: THREE.DoubleSide });
    const white = this._material({ color: '#e3e5e8', metalness: 0.15, roughness: 0.45 });
    const a = this.airframe;
    const add = (geometry, material, x = 0, y = 0, z = 0, parent = a) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      parent.add(mesh);
      return mesh;
    };

    // ---- Fuselage, dark radome and pitot tube
    add(scaleUv(shapeFuselage(latheZ([
      [0, -7.42], [0.1, -7.1], [0.24, -6.6], [0.38, -6.0], [0.5, -5.2], [0.58, -4.3], [0.64, -3.2],
      [0.68, -1.6], [0.69, 0.5], [0.68, 2.4], [0.65, 4.0], [0.6, 5.4], [0.55, 6.2], [0.53, 6.6],
    ], 40)), 2, 3.5), body);
    add(shapeFuselage(latheZ([[0, -7.43], [0.1, -7.11], [0.24, -6.61], [0.3, -6.37]], 40), 1.012), dark);
    add(new THREE.CylinderGeometry(0.012, 0.025, 0.75, 8).rotateX(Math.PI / 2), frame, 0, 0, -7.75);

    // ---- Bubble canopy, frame bow, pilot
    const canopy = add(new THREE.SphereGeometry(1, 40, 20), glass, 0, 0.58, -3.65);
    canopy.scale.set(0.42, 0.5, 1.55);
    const bow = add(new THREE.TorusGeometry(1, 0.07, 8, 30, Math.PI), frame, 0, 0.58, -2.75);
    bow.scale.set(0.345, 0.41, 1);
    const helmet = add(new THREE.SphereGeometry(0.15, 16, 12), this._material({ color: '#2c3036', roughness: 0.5, metalness: 0.2 }), 0, 0.82, -3.55);
    helmet.scale.set(1, 1.1, 1.15);
    add(new THREE.BoxGeometry(0.4, 0.5, 0.18), dark, 0, 0.72, -3.15);

    // ---- Ventral intake: rounded box with a dark open mouth
    const mouth = new THREE.Shape();
    const w = 0.52;
    const h = 0.36;
    const c = 0.2;
    mouth.moveTo(-w + c, -h);
    mouth.lineTo(w - c, -h);
    mouth.quadraticCurveTo(w, -h, w, -h + c);
    mouth.lineTo(w, h - c);
    mouth.quadraticCurveTo(w, h, w - c, h);
    mouth.lineTo(-w + c, h);
    mouth.quadraticCurveTo(-w, h, -w, h - c);
    mouth.lineTo(-w, -h + c);
    mouth.quadraticCurveTo(-w, -h, -w + c, -h);
    add(scaleUv(new THREE.ExtrudeGeometry(mouth, { depth: 3.9, bevelEnabled: false, curveSegments: 6 }), 0.3, 0.3), [intake, body], 0, -0.66, -3.55);
    add(new THREE.TorusGeometry(1, 0.035, 6, 32), frame, 0, -0.66, -3.56).scale.set(0.5, 0.35, 1);

    // ---- Wings with leading-edge root extensions (right side, mirrored for the left)
    const wingGeo = planformXZ([[0.35, -4.75], [0.62, -3.4], [0.95, -2.0], [1.38, -0.9], [4.62, 1.82], [4.62, 2.85], [0.35, 3.05]], 0.2, 0.05);
    const wp = wingGeo.attributes.position;
    for (let i = 0; i < wp.count; i++) {
      const taper = 1 - 0.6 * Math.min(Math.max((wp.getX(i) - 1.2) / 3.4, 0), 1); // thinner towards the tip
      const lerx = wp.getZ(i) < -1.0 ? 0.45 : 1;                                     // thin root extension
      wp.setY(i, wp.getY(i) * taper * lerx);
    }
    scaleUv(wingGeo, 0.22, 0.22);
    for (const side of [1, -1]) add(wingGeo, body, 0, -0.05, 0).scale.x = side;

    // ---- All-moving tailerons with 10° anhedral (outer group: anhedral, inner: deflection)
    const tailGeo = scaleUv(planformXZ([[0.5, -1.35], [2.78, 0.55], [2.78, 1.3], [0.5, 1.1]], 0.1, 0.03), 0.25, 0.25);
    this.tailerons = [];
    for (const side of [1, -1]) {
      const outer = new THREE.Group();
      outer.position.set(0, -0.12, 5.95);
      outer.rotation.z = side * -10 * DEG;
      const inner = new THREE.Group();
      outer.add(inner);
      add(tailGeo, body, 0, 0, 0, inner).scale.x = side;
      a.add(outer);
      this.tailerons.push({ pivot: inner, side });
    }

    // ---- Fin with a cut-out for the rudder; rudder on a hinge leaning back
    add(scaleUv(planformZY([[3.2, 0.45], [5.85, 3.5], [6.85, 3.5], [6.82, 2.98], [6.32, 2.98], [6.06, 0.82], [6.62, 0.82], [6.66, 0.45]], 0.13, 0.03), 0.25, 0.25), body);
    const hinge = new THREE.Group();
    hinge.position.set(0, 0.82, 6.06);
    hinge.rotation.x = 0.12;
    const rudder = new THREE.Group();
    hinge.add(rudder);
    add(planformZY([[0.0, 0.0], [0.02, 2.17], [0.5, 2.17], [0.56, 0.0]], 0.08, 0.02), body, 0, 0, 0, rudder);
    a.add(hinge);
    this.rudders = [rudder];
    add(new THREE.BoxGeometry(0.36, 0.3, 1.25), body, 0, 0.62, 6.45);                          // fin root fairing
    add(new THREE.CylinderGeometry(0.05, 0.05, 0.9, 8).rotateX(Math.PI / 2), dark, 0, 3.52, 6.1); // fin-tip fairing

    // ---- Ventral fins
    const ventral = planformZY([[3.7, 0], [4.95, 0], [5.05, -0.55], [4.3, -0.55]], 0.05, 0.015);
    for (const side of [1, -1]) add(ventral, body, side * 0.45, -0.42, 0).rotation.z = side * 0.35;

    // ---- Nozzle: petals, dark interior, glowing turbine face
    add(new THREE.CylinderGeometry(0.535, 0.47, 0.78, 36, 1, true).rotateX(-Math.PI / 2), nozzleMat, 0, 0, 6.98);
    add(new THREE.CircleGeometry(0.47, 24), this._material({ color: '#0b0a09', roughness: 0.9 }), 0, 0, 6.9);
    this.turbine = new THREE.MeshBasicMaterial({ color: '#ff6a1a', transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false });
    add(new THREE.CircleGeometry(0.36, 24), this.turbine, 0, 0, 6.92);

    // ---- Wingtip missiles on their rails
    const finX = new THREE.BoxGeometry(0.01, 0.36, 0.3);
    const canardX = new THREE.BoxGeometry(0.01, 0.22, 0.12);
    for (const side of [1, -1]) {
      const x = side * 4.86;
      add(new THREE.BoxGeometry(0.07, 0.08, 2.5), frame, side * 4.72, -0.02, 1.05);
      add(new THREE.CylinderGeometry(0.064, 0.064, 2.55, 12).rotateX(Math.PI / 2), white, x, -0.03, 0.95);
      add(new THREE.ConeGeometry(0.064, 0.28, 12).rotateX(-Math.PI / 2), dark, x, -0.03, -0.465);
      for (const k of [0, 1]) {
        add(finX, white, x, -0.03, 2.05).rotation.z = k * (Math.PI / 2) + Math.PI / 4;
        add(canardX, white, x, -0.03, -0.05).rotation.z = k * (Math.PI / 2) + Math.PI / 4;
      }
    }

    // ---- Pylons
    const pylon = (x, y, z, len) => add(new THREE.BoxGeometry(0.07, 0.24, len), dark, x, y, z);
    for (const side of [1, -1]) {
      pylon(side * 2.15, -0.22, 0.9, 1.7);
      pylon(side * 3.25, -0.2, 1.4, 1.4);
    }
    pylon(0, -1.02, 0.4, 1.2);

    // ---- Stores: bombs of the selected type under the pylons
    this.stores = {
      mk82: [[-3.25, -0.48, 1.25], [3.25, -0.48, 1.25], [-2.15, -0.48, 0.75], [2.15, -0.48, 0.75]],
      mk84: [[-2.15, -0.57, 0.85], [2.15, -0.57, 0.85]],
      big: [[0, -1.66, 0.2]],
    };

    // ---- Specification (see the class comment)
    this.name = 'F-16C';
    this.labels = { cannon: '20MM GUN', missile: 'AIM-9', bombs: { mk82: 'MK-82', mk84: 'MK-84', big: 'GBU-43' } };
    this.nozzles = [new THREE.Vector3(0, 0, 7.35)];
    this.plumeRadius = 0.47;
    this.navSpots = [[-4.45, 0.02, 2.75], [4.45, 0.02, 2.75], [0, 3.2, 6.95]];
    this.strobeSpot = [0, 3.62, 6.05];
    this.gun = new THREE.Vector3(0, 0, -7.4);
    this.cockpitEye = new THREE.Vector3(0, 0.82, -3.3);
    this.chaseOffset = new THREE.Vector3(0, 6, 28);
    this.chaseLook = new THREE.Vector3(0, 1.2, -18);
    this.shadowExtent = 18;
    this.shadowOutline = [[[0, -7.4], [0.7, -4.5], [0.75, 6.8], [-0.75, 6.8], [-0.7, -4.5]]];
    for (const s of [1, -1]) {
      this.shadowOutline.push(
        [[0.35 * s, -4.75], [1.38 * s, -0.9], [4.9 * s, 1.82], [4.9 * s, 2.85], [0.35 * s, 3.05]],
        [[0.5 * s, 4.6], [2.78 * s, 6.5], [2.78 * s, 7.25], [0.5 * s, 7.05]],
      );
    }
  }

  /** One bomb mesh per pylon and store type (only the selected type is shown). */
  _buildStores() {
    this.storeMeshes = {};
    for (const [kind, spots] of Object.entries(this.stores)) {
      this.storeMeshes[kind] = spots.map(([x, y, z, roll = 0]) => {
        const bomb = createBombMesh(kind, this.envMap);
        bomb.position.set(x, y, z);
        bomb.rotation.z = roll;
        this.airframe.add(bomb);
        return bomb;
      });
    }
  }

  _buildEffects() {
    const fx = new THREE.Group();
    this.group.add(fx);

    // Afterburner plume: outer (long, bluish → orange) + inner core (short, white hot)
    const cone = new THREE.CylinderGeometry(1, 0.32, 1, 28, 1, true).rotateX(-Math.PI / 2).translate(0, 0, 0.5);
    const flame = (colorA, colorB, diamonds) => new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPower: { value: 0 },
        uColorA: { value: new THREE.Color(...colorA) },
        uColorB: { value: new THREE.Color(...colorB) },
        uDiamonds: { value: diamonds },
      },
      vertexShader: SHADERS.flameVertex,
      fragmentShader: SHADERS.flameFragment,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
    });
    this.plumeMaterial = flame([0.55, 0.62, 1.25], [1.25, 0.45, 0.14], 5);
    this.coreMaterial = flame([1.3, 1.15, 1.0], [1.3, 0.62, 0.25], 4);

    this.glowTexture = glowTexture();
    const sprite = (color, size) => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.glowTexture, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      s.scale.set(size, size, 1);
      s.renderOrder = 10;
      fx.add(s);
      return s;
    };
    // One plume, core and nozzle glow per engine
    this.engines = this.nozzles.map((nozzle) => {
      const plume = new THREE.Mesh(cone, this.plumeMaterial);
      const core = new THREE.Mesh(cone, this.coreMaterial);
      for (const m of [plume, core]) {
        m.renderOrder = 9;
        m.frustumCulled = false;
        m.position.copy(nozzle);
        fx.add(m);
      }
      return { nozzle, plume, core, glow: sprite('#ff8a3c', 3) };
    });
    // Navigation lights: red left, green right, white tail; white anti-collision strobe on the fin
    this.navLights = [
      sprite('#ff2a2a', 1), sprite('#2aff6a', 1), sprite('#ffffff', 0.8),
    ];
    this.navLights.forEach((s, i) => s.position.fromArray(this.navSpots[i]));
    this.strobe = sprite('#ffffff', 2.4);
    this.strobe.position.fromArray(this.strobeSpot);
  }

  /** Shows the bombs of the selected type on the pylons. */
  setStores(kind) {
    this.storeKind = kind;
    for (const [k, meshes] of Object.entries(this.storeMeshes)) {
      for (const m of meshes) m.visible = !this.custom && k === kind;
    }
  }

  /** Hides one store (re-armed after the cooldown) and returns its position on the airframe. */
  releaseStore(kind, index) {
    const meshes = this.storeMeshes[kind];
    if (this.custom || !meshes?.length) return new THREE.Vector3(0, -1.4, 0.5);
    const mesh = meshes[index % meshes.length];
    mesh.visible = false;
    return mesh.position.clone();
  }

  rearm() {
    this.setStores(this.storeKind);
  }

  /**
   * Turns the reflections so the sky of the environment map points to the local up.
   * @param {THREE.Quaternion} frameQuaternion  world rotation of the aircraft's local frame
   */
  setEnvironmentFrame(frameQuaternion) {
    // three.js uses Euler(−x, −y, −z) of envMapRotation on world directions; we need world → local
    this._envMatrix.makeRotationFromQuaternion(frameQuaternion).transpose();
    this._envEuler.setFromRotationMatrix(this._envMatrix);
    this._envEuler.set(-this._envEuler.x, -this._envEuler.y, -this._envEuler.z);
    for (const m of this.materials) m.envMapRotation?.copy(this._envEuler);
    for (const m of sharedMaterials.values()) m.envMapRotation?.copy(this._envEuler);
  }

  /**
   * @param {object} s
   * @param {number} s.time          seconds (flicker, strobe)
   * @param {number} s.throttle      0..1
   * @param {number} s.afterburner   0..1
   * @param {number} s.daylight      0 night … 1 day
   * @param {number} s.pitch         control inputs −1..1 (control surface deflections)
   * @param {number} s.roll
   * @param {number} s.yaw
   */
  update({ time, throttle, afterburner, daylight, pitch, roll, yaw }) {
    const ab = afterburner;
    const dry = Math.min(throttle / 0.85, 1);
    const night = 1 - daylight;
    // Faint heat haze when dry, a long flame with shock diamonds on afterburner
    const r = this.plumeRadius;
    const glowSize = (1.6 + 3.2 * ab) * (0.9 + 0.1 * Math.sin(time * 53)) * (r / 0.47);
    const glowOpacity = Math.min(1, (0.12 + 0.5 * night) * dry + ab * (0.6 + 0.4 * night));
    for (const e of this.engines) {
      e.plume.scale.set(r, r, 1.6 + 6.5 * ab);
      e.core.scale.set(r * 0.7, r * 0.7, 0.9 + 2.6 * ab);
      e.glow.position.copy(e.nozzle).z += 0.4;
      e.glow.scale.setScalar(glowSize);
      e.glow.material.opacity = glowOpacity;
    }
    this.plumeMaterial.uniforms.uTime.value = time;
    this.coreMaterial.uniforms.uTime.value = time;
    this.plumeMaterial.uniforms.uPower.value = 0.06 + 0.12 * dry * night + 0.95 * ab;
    this.coreMaterial.uniforms.uPower.value = 0.05 + 0.25 * dry * (0.4 + night) + 1.0 * ab;
    this.turbine.opacity = 0.15 + 0.35 * dry + 0.5 * ab;

    for (const s of this.navLights) {
      s.material.opacity = 0.35 + 0.65 * night;
      s.scale.setScalar(0.55 + 1.1 * night);
    }
    this.strobe.visible = time % 1.3 < 0.07;
    this.strobe.material.opacity = 0.6 + 0.4 * night;

    for (const t of this.tailerons) t.pivot.rotation.x = -pitch * 14 * DEG + t.side * roll * 7 * DEG;
    for (const rudder of this.rudders) rudder.rotation.y = -yaw * 20 * DEG;
  }

  /**
   * Replaces the built-in airframe with a glTF model (the plume, lights and shadow stay).
   * @param {string} url
   * @param {object} o
   * @param {number} o.length    the model is scaled to this length (m)
   * @param {string} o.forward   axis its nose points to: '+z' (glTF convention), '-z', '+x' or '-x'
   * @returns {Promise<boolean>} false when the file is missing or unreadable
   */
  async loadModel(url, { length = 15, forward = '+z' } = {}) {
    let gltf;
    try {
      const head = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      if (!head.ok) return false;
      gltf = await new GLTFLoader().loadAsync(url);
    } catch (error) {
      console.warn(`[Earth 3D] ${url} could not be loaded, using the built-in jet:`, error.message);
      return false;
    }
    const model = gltf.scene;
    model.rotation.y = { '+z': Math.PI, '-z': 0, '+x': Math.PI / 2, '-x': -Math.PI / 2 }[forward] ?? Math.PI;
    const holder = new THREE.Group();
    holder.add(model);
    holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(holder);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const scale = length / Math.max(size.z, 1e-6);
    model.position.sub(center);
    holder.scale.setScalar(scale);
    model.traverse((o) => {
      if (!o.isMesh) return;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m.isMeshStandardMaterial && !m.envMap) {
          m.envMap = this.envMap;
          this.materials.push(m);
        }
      }
    });
    this.airframe.visible = false;
    this.custom = true;
    this.setStores(this.storeKind);
    this.group.add(holder);
    // A single plume at the tail, a little below the middle of the bounding box
    const [engine, ...others] = this.engines;
    engine.nozzle.set(0, -0.1 * size.y * scale, (size.z / 2) * scale + 0.2);
    engine.plume.position.copy(engine.nozzle);
    engine.core.position.copy(engine.nozzle);
    for (const e of others) e.plume.visible = e.core.visible = e.glow.visible = false;
    return true;
  }

  dispose() {
    const shared = new Set(sharedMaterials.values()); // used by every bomb, also the falling ones
    this.group.traverse((o) => {
      o.geometry?.dispose();
      if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (!shared.has(m)) m.dispose();
    });
    this.panelTexture?.dispose();
    this.glowTexture.dispose();
  }
}

/**
 * Soft top-down silhouette of an aircraft, laid on the ground as its shadow.
 * @param {number[][][]} outline  polygons of [x, z] points (m), nose to −Z
 * @param {number} extent         side of the square the texture covers (m)
 */
export function createShadowMesh(outline, extent = 18) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.filter = 'blur(3px)';
  ctx.fillStyle = '#fff';
  const m = 256 / extent; // nose up (−Z = top of the image)
  const poly = (pts) => {
    ctx.beginPath();
    pts.forEach(([x, z], i) => {
      const px = 128 + x * m;
      const py = 128 + z * m;
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    });
    ctx.closePath();
    ctx.fill();
  };
  outline.forEach(poly);
  const texture = new THREE.CanvasTexture(canvas);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(extent, extent).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: 0x000000, alphaMap: texture, transparent: true, opacity: 0.5, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
    }),
  );
  mesh.renderOrder = 2;
  return mesh;
}
