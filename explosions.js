/**
 * ExplosionSystem — bomb detonations for the flight mode.
 *
 * Every explosion lives in its own local frame (metres, +Y up) on the globe and scales
 * with the charge W following the cube-root law (fireball radius ≈ 15 m · (W / 250 kg)^⅓):
 *
 *   flash      a white flare, the ground lit for a fraction of a second
 *   fireball   three noise-displaced spheres that cool from white to orange, red and soot
 *   fire       glowing turbulent puffs thrown out of the fireball
 *   smoke      sorted, sun-lit billows that rise (buoyancy), grow and drift with the wind;
 *              10 t charges also form a stem and a rolling mushroom cap
 *   dust       the shock wave lifts a ring of dust along the ground
 *   ejecta     clods of earth fly out in a cone, drawing dirt plumes behind them
 *   debris     rocks and sparks on ballistic paths, glowing embers
 *   shock      a faint expanding shell (+ a condensation cloud for the biggest charge)
 *   after      small fires keep burning in the crater, a scorch mark stays on the ground
 *
 * Particles are simulated on the CPU and drawn as instanced sprites (one draw call per
 * explosion), sorted back to front with premultiplied alpha, so glowing fire and opaque
 * smoke mix correctly. The light of fireballs and fires and the scorch marks are applied
 * by the Earth shader itself (uBlastPos / uScorch uniforms), so they follow the terrain.
 */
import * as THREE from 'three';
import * as SHADERS from './shaders.js';
import { EARTH_RADIUS_M, clamp, lerp, latLonToVector3, placeLocalFrame, offsetLatLon } from './geo.js';

const METRE = 1 / EARTH_RADIUS_M;
const G = 9.81;
const MAX_EXPLOSIONS = 6;
const MAX_SCORCH = 8;
const SCORCH_LIFE = 180; // seconds before a scorch mark starts to fade (over 20 s)

const KIND = { SMOKE: 0, DUST: 1, FIRE: 2, DEBRIS: 3, EJECTA: 4, FLASH: 5, EMBER: 6, SPRAY: 7, CAP: 8, SOURCE: 9 };
const FRAME = { SMOKE: 0, FIRE: 8, ROCK: 12, GLOW: 14, FLARE: 15 };

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (n) => Math.floor(Math.random() * n);

/** Temperature (0..1) → emitted light (linear RGB, values above 1 for the white-hot core). */
const FIRE_RAMP = [
  [0.0, 0, 0, 0],
  [0.15, 0.35, 0.05, 0.01],
  [0.35, 1.2, 0.28, 0.04],
  [0.6, 2.2, 0.95, 0.22],
  [0.85, 3.0, 2.2, 1.0],
  [1.0, 3.6, 3.2, 2.4],
];
function fireColor(t, out) {
  t = clamp(t, 0, 1);
  for (let i = 1; i < FIRE_RAMP.length; i++) {
    const b = FIRE_RAMP[i];
    if (t <= b[0]) {
      const a = FIRE_RAMP[i - 1];
      const f = (t - a[0]) / (b[0] - a[0]);
      out[0] = lerp(a[1], b[1], f);
      out[1] = lerp(a[2], b[2], f);
      out[2] = lerp(a[3], b[3], f);
      return out;
    }
  }
  out[0] = 3.6; out[1] = 3.2; out[2] = 2.4;
  return out;
}
const _fc = [0, 0, 0];

class Particle {
  constructor() {
    this.kind = 0;
    this.x = 0; this.y = 0; this.z = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.age = 0; this.life = 1;
    this.s0 = 1; this.s1 = 1; this.sTau = 1;
    this.rot = 0; this.spin = 0; this.frame = 0;
    this.r = 0; this.g = 0; this.b = 0;       // albedo at birth
    this.r1 = 0; this.g1 = 0; this.b1 = 0;    // albedo it fades to
    this.cTau = 1;
    this.alpha = 1; this.fadeIn = 0.1; this.fadeOut = 0.4;
    this.heat = 0;                             // fire: initial temperature
    this.drag = 0; this.rise = 0; this.riseTau = 1; this.gravity = 0;
    this.rate = 0; this.timer = 0; this.until = 0; // emitters
    this.glow = 0;                             // emissive smoke right after the blast
    this.a0 = 0; this.a1 = 0; this.a2 = 0;     // kind specific
    this.strength = 0;                         // burning source: current intensity
    // visual output (filled every frame)
    this.size = 0; this.opacity = 0;
    this.curR = 0; this.curG = 0; this.curB = 0;
    this.er = 0; this.eg = 0; this.eb = 0; this.light = 0;
    this.key = 0;
  }
}

const GLOW_COLOUR = fireColor(0.55, [0, 0, 0]);

/* ------------------------------------------------------------------ */
/* One explosion                                                       */
/* ------------------------------------------------------------------ */
class Explosion {
  /**
   * @param {ExplosionSystem} sys
   * @param {object} o  { lat, lon, groundM, yieldKg, water }
   */
  constructor(sys, { lat, lon, groundM, yieldKg, water }) {
    this.sys = sys;
    this.lat = lat;
    this.lon = lon;
    this.groundM = groundM;
    this.yieldKg = yieldKg;
    this.water = water;
    this.s = Math.cbrt(yieldKg / 250);   // 1 · 1.59 · 3.42 for 250 kg · 1 t · 10 t
    this.ts = Math.sqrt(this.s);         // bigger blasts evolve more slowly
    this.rf = 15 * this.s;               // fireball radius (m)
    this.mushroom = yieldKg >= 5000;
    this.age = 0;
    this.fading = 0;                     // > 0: removed early (too many explosions), fade-out progress
    this.q = sys.quality;
    this.seed = Math.random() * 100;

    this.group = placeLocalFrame(new THREE.Group(), lat, lon, groundM);
    this.group.name = 'explosion';
    sys.scene.add(this.group);
    this.group.updateMatrixWorld(true);
    this.world = this.group.position.clone();
    this.up = this.world.clone().normalize();

    this._sampleGround();

    this.particles = [];
    this.free = [];
    this.capacity = Math.round((this.mushroom ? 1150 : 520 + 120 * this.s) * Math.max(this.q, 0.35));
    this._initBuffers();
    this._initMeshes();

    this.counters = { smoke: 0 };
    this.budget = {
      smoke: Math.round(70 * this.q * Math.pow(this.s, 0.75)),
      fire: Math.round(48 * this.q * Math.sqrt(this.s)),
      dust: Math.round(36 * this.q * Math.sqrt(this.s)),
      ejecta: Math.max(4, Math.round(9 * Math.sqrt(this.q))),
      debris: Math.round(40 * this.q),
      embers: Math.round(28 * this.q),
      sparks: Math.round(80 * this.q * Math.sqrt(this.s)),
      cap: this.mushroom ? Math.round(110 * this.q) : 0,
      fires: water ? 0 : Math.round(3 + 2 * this.s),
    };
    this.sources = []; // lingering fires (for the ground light)
    this._detonate();
  }

  /** 9 × 9 terrain heights around the blast (relative to ground zero), for particles that hit the ground. */
  _sampleGround() {
    const n = 9;
    this.gridN = n;
    this.gridExtent = Math.max(120, this.rf * 5);
    this.grid = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const east = ((i / (n - 1)) * 2 - 1) * this.gridExtent;
        const north = -((j / (n - 1)) * 2 - 1) * this.gridExtent; // local +Z is south
        const ll = offsetLatLon(this.lat, this.lon, east, north);
        this.grid[j * n + i] = this.sys.getGroundM(ll.lat, ll.lon) - this.groundM;
      }
    }
  }

  /** Ground height (m, relative to ground zero) at local x (east), z (south). */
  groundY(x, z) {
    const n = this.gridN;
    const e = this.gridExtent;
    const fx = clamp(((x / e + 1) / 2) * (n - 1), 0, n - 1.001);
    const fz = clamp(((z / e + 1) / 2) * (n - 1), 0, n - 1.001);
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const g = this.grid;
    const a = lerp(g[j * n + i], g[j * n + i + 1], u);
    const b = lerp(g[(j + 1) * n + i], g[(j + 1) * n + i + 1], u);
    return lerp(a, b, v) - (x * x + z * z) / (2 * EARTH_RADIUS_M); // + Earth curvature
  }

  _initBuffers() {
    const cap = this.capacity;
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = this.sys.quad.index;
    geometry.setAttribute('position', this.sys.quad.attributes.position);
    const attr = (size) => new THREE.InstancedBufferAttribute(new Float32Array(cap * size), size).setUsage(THREE.DynamicDrawUsage);
    this.iPos = attr(3);
    this.iShape = attr(4);
    this.iColor = attr(4);
    this.iEmit = attr(4);
    geometry.setAttribute('iPos', this.iPos);
    geometry.setAttribute('iShape', this.iShape);
    geometry.setAttribute('iColor', this.iColor);
    geometry.setAttribute('iEmit', this.iEmit);
    geometry.instanceCount = 0;
    this.particleGeometry = geometry;

    this.uniforms = {
      uAtlas: this.sys.shared.uAtlas,
      uMetre: this.sys.shared.uMetre,
      uGrid: this.sys.shared.uGrid,
      uSunView: this.sys.shared.uSunView,
      uSunColor: this.sys.shared.uSunColor,
      uAmbient: this.sys.shared.uAmbient,
      uUpView: { value: new THREE.Vector3(0, 1, 0) },
    };
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SHADERS.particleVertex,
      fragmentShader: SHADERS.particleFragment,
      ...this.sys.blending,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 8;
    this.group.add(this.mesh);

    // Sparks
    const sparkCap = Math.max(1, Math.round(80 * this.q * Math.sqrt(this.s)));
    const sg = new THREE.InstancedBufferGeometry();
    sg.index = this.sys.quad.index;
    sg.setAttribute('position', this.sys.quad.attributes.position);
    const sAttr = (size) => new THREE.InstancedBufferAttribute(new Float32Array(sparkCap * size), size).setUsage(THREE.DynamicDrawUsage);
    this.sPos = sAttr(3);
    this.sVel = sAttr(3);
    this.sData = sAttr(4);
    sg.setAttribute('iPos', this.sPos);
    sg.setAttribute('iVel', this.sVel);
    sg.setAttribute('iData', this.sData);
    sg.instanceCount = 0;
    this.sparkGeometry = sg;
    this.sparks = [];
    this.sparkCap = sparkCap;
    this.sparkMesh = new THREE.Mesh(sg, new THREE.ShaderMaterial({
      uniforms: { uMetre: this.sys.shared.uMetre },
      vertexShader: SHADERS.sparkVertex,
      fragmentShader: SHADERS.sparkFragment,
      ...this.sys.blending,
    }));
    this.sparkMesh.frustumCulled = false;
    this.sparkMesh.renderOrder = 9;
    this.group.add(this.sparkMesh);
  }

  _initMeshes() {
    // Fireball: inner core, main ball, outer turbulent layer
    this.fireballs = [0.55, 0.85, 1.0].map((scale, i) => {
      const uniforms = {
        uTime: { value: 0 },
        uSeed: { value: this.seed + i * 7.3 },
        uTurb: { value: 0.16 + i * 0.07 },
        uHeat: { value: 1 },
        uOpacity: { value: 1 },
        uSunView: this.sys.shared.uSunView,
        uSunColor: this.sys.shared.uSunColor,
        uAmbient: this.sys.shared.uAmbient,
        uUpView: this.uniforms.uUpView,
      };
      const mesh = new THREE.Mesh(this.sys.sphere, new THREE.ShaderMaterial({
        uniforms,
        vertexShader: SHADERS.fireballVertex,
        fragmentShader: SHADERS.fireballFragment,
        ...this.sys.blending,
      }));
      mesh.renderOrder = 7;
      mesh.frustumCulled = false;
      mesh.visible = false;
      this.group.add(mesh);
      return { mesh, uniforms, scale, layer: i };
    });

    this.shock = new THREE.Mesh(this.sys.shell, new THREE.ShaderMaterial({
      uniforms: { uOpacity: { value: 0 }, uColor: { value: new THREE.Color(0.85, 0.88, 0.95) } },
      vertexShader: SHADERS.shockVertex,
      fragmentShader: SHADERS.shockFragment,
      ...this.sys.blending,
    }));
    this.shock.renderOrder = 7;
    this.shock.frustumCulled = false;
    this.group.add(this.shock);
  }

  _spawn(kind) {
    if (this.particles.length >= this.capacity) return null;
    const p = this.free.pop() || new Particle();
    p.kind = kind;
    p.age = 0;
    p.vx = p.vy = p.vz = 0;
    p.rot = Math.random() * Math.PI * 2;
    p.spin = rand(-0.3, 0.3);
    p.drag = 0; p.rise = 0; p.riseTau = 1; p.gravity = 0;
    p.heat = 0; p.glow = 0; p.rate = 0; p.timer = 0; p.until = 0;
    p.fadeIn = 0.1; p.fadeOut = 0.4; p.cTau = 4;
    p.a0 = p.a1 = p.a2 = 0;
    p.r1 = p.g1 = p.b1 = 0;
    p.strength = 0;
    // invisible until its first update (particles born during an update are drawn next frame)
    p.size = 0; p.opacity = 0; p.er = p.eg = p.eb = 0; p.light = 0; p.key = 0;
    this.particles.push(p);
    return p;
  }

  /** Random point in a sphere (local metres). */
  static _inSphere(r, out) {
    let x;
    let y;
    let z;
    do {
      x = rand(-1, 1); y = rand(-1, 1); z = rand(-1, 1);
    } while (x * x + y * y + z * z > 1);
    out[0] = x * r; out[1] = y * r; out[2] = z * r;
    return out;
  }

  /** Everything that happens at t = 0. */
  _detonate() {
    const { rf, s, ts } = this;
    const b = this.budget;
    const v = [0, 0, 0];
    const water = this.water;

    // Flash: flare + broad glow
    const flare = this._spawn(KIND.FLASH);
    Object.assign(flare, { x: 0, y: rf * 0.3, z: 0, life: 0.35, s0: rf * 7, s1: rf * 9, sTau: 0.2, frame: FRAME.FLARE, alpha: 0, a0: 0.05, a1: 7 });
    const glow = this._spawn(KIND.FLASH);
    Object.assign(glow, { x: 0, y: rf * 0.3, z: 0, life: 1.0 * ts, s0: rf * 4, s1: rf * 5, sTau: 0.3, frame: FRAME.GLOW, alpha: 0, a0: 0.16 * ts, a1: 4 });

    // Fire puffs thrown out of the fireball
    for (let i = 0; i < b.fire; i++) {
      const p = this._spawn(KIND.FIRE);
      if (!p) break;
      Explosion._inSphere(rf * 0.45, v);
      const dir = Math.hypot(v[0], v[1], v[2]) || 1;
      const speed = (rf / ts) * rand(0.9, 2.2);
      Object.assign(p, {
        x: v[0], y: Math.abs(v[1]) + rf * 0.25, z: v[2],
        vx: (v[0] / dir) * speed, vy: (Math.abs(v[1]) / dir) * speed + rf * 0.4, vz: (v[2] / dir) * speed,
        life: rand(0.45, 1.15) * ts, s0: rf * rand(0.28, 0.42), s1: rf * rand(0.6, 0.9), sTau: 0.4 * ts,
        frame: FRAME.FIRE + pick(4), heat: rand(0.75, 1.0), drag: 3.2, rise: 9 * Math.sqrt(s), riseTau: 1.5,
        r: 0.035, g: 0.03, b: 0.028, alpha: 0.6, fadeIn: 0.04, fadeOut: 0.3, spin: rand(-1.2, 1.2),
      });
      if (water) p.heat *= 0.75;
    }

    // Dust ring lifted by the shock wave along the ground (white spray on water)
    for (let i = 0; i < b.dust; i++) {
      const p = this._spawn(water ? KIND.SPRAY : KIND.DUST);
      if (!p) break;
      const a = Math.random() * Math.PI * 2;
      const r0 = rf * rand(0.2, 0.45);
      const speed = (rf / ts) * rand(2.2, 3.6);
      const x = Math.cos(a) * r0;
      const z = Math.sin(a) * r0;
      const tone = rand(0.85, 1.12);
      Object.assign(p, {
        x, y: this.groundY(x, z) + rf * 0.15, z,
        vx: Math.cos(a) * speed, vy: speed * rand(0.04, 0.16), vz: Math.sin(a) * speed,
        life: rand(7, 13) * ts, s0: rf * rand(0.22, 0.34), s1: rf * rand(0.9, 1.3), sTau: 2.2 * ts,
        frame: FRAME.SMOKE + pick(8), drag: 2.4, rise: 1.2, riseTau: 5,
        r: 0.4 * tone, g: 0.34 * tone, b: 0.27 * tone, r1: 0.5 * tone, g1: 0.45 * tone, b1: 0.38 * tone, cTau: 6,
        alpha: 0.72, fadeIn: 0.05, fadeOut: 0.55,
      });
      if (water) Object.assign(p, { r: 0.85, g: 0.88, b: 0.9, r1: 0.92, g1: 0.94, b1: 0.96, alpha: 0.6, life: rand(3, 6) });
    }

    // Clods of earth thrown out in a cone: each draws a dirt plume behind it
    for (let i = 0; i < b.ejecta; i++) {
      const p = this._spawn(KIND.EJECTA);
      if (!p) break;
      const az = Math.random() * Math.PI * 2;
      const tilt = rand(0.12, 0.75);
      const speed = 37 * Math.pow(s, 0.6) * rand(0.6, 1.25) * (water ? 1.25 : 1);
      Object.assign(p, {
        x: 0, y: this.groundY(0, 0) + 1, z: 0,
        vx: Math.cos(az) * Math.sin(tilt) * speed, vy: Math.cos(tilt) * speed, vz: Math.sin(az) * Math.sin(tilt) * speed,
        life: 6, s0: 1.4 * Math.sqrt(s), s1: 1.4 * Math.sqrt(s), sTau: 1, frame: FRAME.ROCK + pick(2),
        r: 0.09, g: 0.075, b: 0.06, alpha: water ? 0 : 1, fadeIn: 0.01, fadeOut: 0.1,
        gravity: G, drag: 0.12, rate: rand(11, 16), until: rand(0.8, 1.3) * ts, spin: rand(-6, 6),
      });
    }

    // Rocks
    for (let i = 0; i < (water ? 0 : b.debris); i++) {
      const p = this._spawn(KIND.DEBRIS);
      if (!p) break;
      const az = Math.random() * Math.PI * 2;
      const tilt = rand(0.25, 1.25);
      const speed = rand(25, 70) * Math.pow(s, 0.4);
      Object.assign(p, {
        x: rand(-2, 2), y: this.groundY(0, 0) + 1, z: rand(-2, 2),
        vx: Math.cos(az) * Math.sin(tilt) * speed, vy: Math.cos(tilt) * speed, vz: Math.sin(az) * Math.sin(tilt) * speed,
        life: 9, s0: rand(0.35, 1.3) * Math.pow(s, 0.3), sTau: 1, frame: FRAME.ROCK + pick(2),
        r: 0.07, g: 0.06, b: 0.05, alpha: 1, fadeIn: 0.01, fadeOut: 0.05, gravity: G, drag: 0.04, spin: rand(-9, 9),
      });
      p.s1 = p.s0;
    }

    // Glowing embers
    for (let i = 0; i < (water ? 0 : b.embers); i++) {
      const p = this._spawn(KIND.EMBER);
      if (!p) break;
      Explosion._inSphere(rf * 0.4, v);
      const az = Math.random() * Math.PI * 2;
      const speed = rand(10, 34) * Math.sqrt(s);
      Object.assign(p, {
        x: v[0], y: rf * 0.3 + Math.abs(v[1]), z: v[2],
        vx: Math.cos(az) * speed * 0.7, vy: rand(0.3, 1) * speed, vz: Math.sin(az) * speed * 0.7,
        life: rand(1.5, 3.8), s0: rand(0.35, 0.9), sTau: 1, frame: FRAME.GLOW,
        alpha: 0, gravity: G * 0.35, drag: 0.9, a0: rand(0, 10),
      });
      p.s1 = p.s0;
    }

    // Sparks
    for (let i = 0; i < (water ? 0 : this.sparkCap); i++) {
      const az = Math.random() * Math.PI * 2;
      const el = Math.asin(rand(-0.15, 1));
      const speed = rand(55, 165) * Math.pow(s, 0.3);
      this.sparks.push({
        x: rand(-1, 1), y: rf * 0.25 + rand(0, 2), z: rand(-1, 1),
        vx: Math.cos(az) * Math.cos(el) * speed, vy: Math.sin(el) * speed, vz: Math.sin(az) * Math.cos(el) * speed,
        age: 0, life: rand(0.5, 2.2), width: 0.32 * Math.pow(s, 0.3),
      });
    }

    // Water: the blast throws up a tall column of spray
    if (water) {
      for (let i = 0; i < Math.round(40 * this.q * Math.sqrt(s)); i++) {
        const p = this._spawn(KIND.SPRAY);
        if (!p) break;
        const az = Math.random() * Math.PI * 2;
        const tilt = rand(0, 0.35);
        const speed = rand(25, 55) * Math.pow(s, 0.5);
        Object.assign(p, {
          x: rand(-3, 3), y: 1, z: rand(-3, 3),
          vx: Math.cos(az) * Math.sin(tilt) * speed, vy: Math.cos(tilt) * speed, vz: Math.sin(az) * Math.sin(tilt) * speed,
          life: rand(3.5, 6) * ts, s0: rf * 0.25, s1: rf * rand(0.7, 1.1), sTau: 1.5,
          frame: FRAME.SMOKE + pick(8), gravity: G * 0.85, drag: 0.35,
          r: 0.82, g: 0.86, b: 0.9, r1: 0.9, g1: 0.92, b1: 0.95, alpha: 0.75, fadeIn: 0.03, fadeOut: 0.5,
        });
      }
    }
  }

  /** Main smoke cloud: born inside the fireball during its first half second. */
  _spawnSmoke(n) {
    const { rf, s, ts } = this;
    const v = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const p = this._spawn(KIND.SMOKE);
      if (!p) return;
      Explosion._inSphere(rf * 0.6, v);
      const dir = Math.hypot(v[0], v[1], v[2]) || 1;
      const out = (rf / ts) * rand(0.3, 1.0);
      const steam = this.water;
      const dark = rand(0.03, 0.06);
      Object.assign(p, {
        x: v[0], y: rf * 0.45 + v[1] * 0.8, z: v[2],
        vx: (v[0] / dir) * out, vy: (v[1] / dir) * out * 0.5 + rf * 0.3 / ts, vz: (v[2] / dir) * out,
        life: rand(16, 28) * Math.pow(ts, 0.8), s0: rf * rand(0.4, 0.62), s1: rf * rand(1.4, 2.0), sTau: 5 * ts,
        frame: FRAME.SMOKE + pick(8), drag: 1.2, rise: rf * rand(0.42, 0.7) / ts, riseTau: 6 * ts,
        r: dark, g: dark * 0.94, b: dark * 0.88, r1: 0.2, g1: 0.185, b1: 0.17, cTau: 5 * ts,
        alpha: 0.88, fadeIn: 0.03, fadeOut: 0.45, glow: 1, spin: rand(-0.15, 0.15),
      });
      if (steam) Object.assign(p, { r: 0.55, g: 0.57, b: 0.6, r1: 0.85, g1: 0.87, b1: 0.9, alpha: 0.6, glow: 0.3, life: p.life * 0.6 });
      if (s > 2) p.rise *= 1.25;
    }
  }

  _spawnCap() {
    // Mushroom cap: puffs placed on a rising, growing torus that rolls (up inside, down outside)
    for (let i = 0; i < this.budget.cap; i++) {
      const p = this._spawn(KIND.CAP);
      if (!p) return;
      Object.assign(p, {
        life: rand(30, 45), s0: this.rf * rand(0.45, 0.7), s1: this.rf * rand(1.0, 1.4), sTau: 8,
        frame: FRAME.SMOKE + pick(8), r: 0.05, g: 0.047, b: 0.043, r1: 0.24, g1: 0.22, b1: 0.2, cTau: 7,
        alpha: 0.85, fadeIn: 0.08, fadeOut: 0.35, glow: 0.6,
        a0: Math.random() * Math.PI * 2,                // around the axis
        a1: Math.random() * Math.PI * 2,                // around the tube
        a2: Math.sqrt(Math.random()),                   // depth inside the tube
      });
      p.age = rand(0, 0.6);
    }
  }

  _spawnSource() {
    // A small fire that keeps burning in the crater for half a minute or more
    const { rf, s } = this;
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * rf * 1.1;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const p = this._spawn(KIND.SOURCE);
    if (!p) return;
    Object.assign(p, {
      x, y: this.groundY(x, z), z, life: rand(25, 70) * Math.sqrt(s), alpha: 0, s0: 0, s1: 0,
      rate: rand(7, 11), a0: rand(1.2, 2.0), a1: 0, a2: rand(0.6, 1.0) * Math.pow(s, 0.4),
    });
    this.sources.push(p);
  }

  /** Emitted by a burning source: one flame (and sometimes a puff of smoke). */
  _emitFromSource(src, strength) {
    const k = src.a2 * (0.4 + 0.6 * strength);
    const f = this._spawn(KIND.FIRE);
    if (f) {
      Object.assign(f, {
        x: src.x + rand(-1.5, 1.5) * k, y: src.y + 0.6 * k, z: src.z + rand(-1.5, 1.5) * k,
        vx: rand(-0.6, 0.6), vy: rand(2, 4) * k, vz: rand(-0.6, 0.6),
        life: rand(0.55, 1.0), s0: rand(2.2, 3.6) * k, s1: rand(4, 6) * k, sTau: 0.6,
        frame: FRAME.FIRE + pick(4), heat: rand(0.65, 0.9) * (0.6 + 0.4 * strength), drag: 1.5, rise: 5 * k, riseTau: 2,
        r: 0.03, g: 0.028, b: 0.026, alpha: 0.4, fadeIn: 0.1, fadeOut: 0.4, spin: rand(-1, 1),
      });
    }
    src.a1 += 1;
    if (src.a1 % 6 === 0) {
      const p = this._spawn(KIND.SMOKE);
      if (!p) return;
      const grey = rand(0.05, 0.09);
      Object.assign(p, {
        x: src.x, y: src.y + 3 * k, z: src.z,
        vx: rand(-0.5, 0.5), vy: 3 * k, vz: rand(-0.5, 0.5),
        life: rand(10, 16), s0: 3 * k, s1: rand(13, 18) * k, sTau: 6,
        frame: FRAME.SMOKE + pick(8), drag: 0.8, rise: rand(3, 5) * k, riseTau: 8,
        r: grey, g: grey * 0.95, b: grey * 0.9, r1: 0.16, g1: 0.155, b1: 0.15, cTau: 5,
        alpha: 0.55 * (0.5 + 0.5 * strength), fadeIn: 0.1, fadeOut: 0.5, glow: 0.15,
      });
    }
  }

  _kill(i) {
    const list = this.particles;
    const p = list[i];
    const last = list.pop();
    if (i < list.length) list[i] = last;
    this.free.push(p);
    if (p.kind === KIND.SOURCE) this.sources.splice(this.sources.indexOf(p), 1);
  }

  /** Heat of the fireball (0..1) and its light on the smoke at age t. */
  _fireLight(t) {
    return 3.2 * Math.exp(-t / (0.55 * this.ts));
  }

  /**
   * @param {number} dt
   * @param {object} ctx  { camLocal: Vector3 (camera in this frame, m), wind: Vector3 }
   * @returns {boolean} false once everything has burnt out
   */
  update(dt, ctx) {
    this.age += dt;
    const t = this.age;
    const { rf, ts } = this;

    // Scheduled spawns
    const smokeTarget = Math.round(this.budget.smoke * clamp((t - 0.04) / (0.5 * ts), 0, 1));
    if (smokeTarget > this.counters.smoke) {
      this._spawnSmoke(smokeTarget - this.counters.smoke);
      this.counters.smoke = smokeTarget;
    }
    if (!this.capDone && this.mushroom && t > 0.7) {
      this.capDone = true;
      this._spawnCap();
    }
    if (this.mushroom && t > 0.4 && t < 8) {
      // Stem: hot smoke keeps rising from the crater into the cap
      this.stemTimer = (this.stemTimer || 0) + dt * 6 * this.q;
      while (this.stemTimer >= 1) {
        this.stemTimer -= 1;
        this._stemPuff();
      }
    }
    if (!this.firesDone && t > 0.5 * ts) {
      this.firesDone = true;
      for (let i = 0; i < this.budget.fires; i++) this._spawnSource();
    }

    // Mushroom geometry (cap height, torus radius) at this time
    const capH = rf * (0.6 + 5.4 * (1 - Math.exp(-t / 7)));
    const capR = rf * (0.6 + 1.0 * (1 - Math.exp(-t / 5)));
    const tube = capR * 0.5;
    const capRise = (rf * 5.4 / 7) * Math.exp(-t / 7);

    const fireLight = this._fireLight(t);
    const wind = ctx.wind;
    const cam = ctx.camLocal;
    const list = this.particles;
    const fadeAll = this.fading > 0 ? Math.max(0, 1 - this.fading) : 1;

    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i];
      p.age += dt;
      if (p.age >= p.life) { this._kill(i); continue; }
      const a = p.age;
      const lifeT = a / p.life;

      switch (p.kind) {
        case KIND.SMOKE:
        case KIND.DUST:
        case KIND.FIRE: {
          const k = 1 - Math.exp(-p.drag * dt);
          const rise = p.rise * Math.exp(-a / p.riseTau);
          const windK = p.kind === KIND.FIRE ? 0.3 : clamp((p.y + 10) / 60, 0.25, 1);
          p.vx += (wind.x * windK - p.vx) * k;
          p.vz += (wind.z * windK - p.vz) * k;
          p.vy += (rise - p.vy) * k;
          if (this.mushroom && p.kind === KIND.SMOKE && p.glow > 0.9) {
            // The column feeds the cap: drawn towards the axis and up to the cap
            p.vx -= p.x * 0.18 * dt;
            p.vz -= p.z * 0.18 * dt;
            if (p.y < capH - tube) p.vy += (capRise * 1.6 + 4 - p.vy) * k;
          }
          break;
        }
        case KIND.SPRAY:
        case KIND.EJECTA:
        case KIND.DEBRIS:
        case KIND.EMBER: {
          const k = Math.exp(-p.drag * dt);
          p.vx *= k;
          p.vy = p.vy * k - p.gravity * dt;
          p.vz *= k;
          break;
        }
        default:
          break;
      }

      if (p.kind === KIND.CAP) {
        const roll = p.a1 - t * 0.33; // up through the middle, down on the outside
        const r = capR + Math.cos(roll) * tube * p.a2;
        p.x = Math.cos(p.a0) * r;
        p.z = Math.sin(p.a0) * r;
        p.y = capH + Math.sin(roll) * tube * p.a2 * 0.8;
      } else if (p.kind !== KIND.SOURCE && p.kind !== KIND.FLASH) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;
      }
      p.rot += p.spin * dt;

      // Size
      const grow = 1 - Math.exp(-a / p.sTau);
      p.size = p.s0 + (p.s1 - p.s0) * grow;

      // Ground
      if (p.kind !== KIND.CAP && p.kind !== KIND.FLASH && p.kind !== KIND.SOURCE) {
        const ground = this.groundY(p.x, p.z);
        if (p.kind === KIND.DEBRIS || p.kind === KIND.EJECTA || p.kind === KIND.EMBER || p.kind === KIND.SPRAY) {
          if (p.y < ground + 0.2 && p.vy < 0) {
            if (p.kind === KIND.DEBRIS) this._dustPuff(p.x, ground, p.z, p.s0);
            this._kill(i);
            continue;
          }
        } else {
          const floor = ground + p.size * 0.28;
          if (p.y < floor) {
            p.y = floor;
            if (p.vy < 0) p.vy = 0;
          }
        }
      }

      // Opacity: fade in / out
      const fin = p.fadeIn > 0 ? Math.min(lifeT / p.fadeIn, 1) : 1;
      const fout = Math.min((1 - lifeT) / p.fadeOut, 1);
      p.opacity = p.alpha * fin * fout * fadeAll;
      p.er = p.eg = p.eb = 0;
      p.light = 0;

      switch (p.kind) {
        case KIND.FIRE: {
          const temp = p.heat * Math.pow(1 - lifeT, 1.3);
          fireColor(temp, _fc);
          const e = fin * fadeAll;
          p.er = _fc[0] * e; p.eg = _fc[1] * e; p.eb = _fc[2] * e;
          p.opacity = (0.08 + 0.55 * (1 - temp)) * p.alpha * fin * fout * fadeAll; // cools into smoke
          p.curR = p.r; p.curG = p.g; p.curB = p.b;
          p.light = fireLight * 0.3;
          break;
        }
        case KIND.FLASH: {
          const e = Math.exp(-a / p.a0) * p.a1 * fadeAll;
          p.er = e; p.eg = e * 0.86; p.eb = e * 0.68;
          p.opacity = 0;
          break;
        }
        case KIND.EMBER: {
          const flicker = 0.6 + 0.4 * Math.sin(a * 23 + p.a0) * Math.sin(a * 7.3 + p.a0 * 2);
          const e = 2.6 * (1 - lifeT) * flicker * fadeAll;
          p.er = e; p.eg = e * 0.42; p.eb = e * 0.1;
          p.opacity = 0;
          break;
        }
        case KIND.EJECTA: {
          // Dirt plume behind the clod
          if (a < p.until) {
            p.timer += dt * p.rate;
            while (p.timer >= 1) {
              p.timer -= 1;
              this._trailPuff(p);
            }
          }
          p.curR = p.r; p.curG = p.g; p.curB = p.b;
          break;
        }
        case KIND.SOURCE: {
          const strength = 1 - lifeT;
          p.timer += dt * p.rate * (0.4 + 0.6 * strength);
          while (p.timer >= 1) {
            p.timer -= 1;
            this._emitFromSource(p, strength);
          }
          p.opacity = 0;
          p.strength = strength * (0.75 + 0.25 * Math.sin(this.age * 13 + p.a0 * 5));
          break;
        }
        default: {
          // Smoke, dust, cap, spray: colour slowly lightens as the cloud dilutes
          const c = 1 - Math.exp(-a / p.cTau);
          p.curR = p.r + (p.r1 - p.r) * c;
          p.curG = p.g + (p.g1 - p.g) * c;
          p.curB = p.b + (p.b1 - p.b) * c;
          if (p.glow > 0) {
            // Glowing right after the blast, lit by the fire from below afterwards
            const g = p.glow * Math.exp(-t / (0.22 * ts)) * 0.77;
            p.er = GLOW_COLOUR[0] * g; p.eg = GLOW_COLOUR[1] * g; p.eb = GLOW_COLOUR[2] * g;
            const d = Math.hypot(p.x, p.y - rf * 0.4, p.z);
            p.light = fireLight * clamp(1.4 - d / (2.2 * rf), 0, 1) * p.glow;
          }
          break;
        }
      }
      if (p.kind === KIND.DEBRIS) { p.curR = p.r; p.curG = p.g; p.curB = p.b; }
      if (p.kind === KIND.FLASH || p.kind === KIND.EMBER) { p.curR = p.curG = p.curB = 0; }

      const dx = p.x - cam.x;
      const dy = p.y - cam.y;
      const dz = p.z - cam.z;
      p.key = dx * dx + dy * dy + dz * dz;
    }

    // Lingering fires add a little light to the low smoke
    this._writeParticles();
    this._updateSparks(dt, cam);
    this._updateFireballs(t);
    this._updateShock(t);

    const fireLeft = this.sources.length > 0;
    return list.length > 0 || this.sparks.length > 0 || fireLeft || t < 3 * ts;
  }

  _trailPuff(src) {
    const p = this._spawn(this.water ? KIND.SPRAY : KIND.DUST);
    if (!p) return;
    const { rf, s } = this;
    const tone = rand(0.75, 1.0);
    Object.assign(p, {
      x: src.x, y: src.y, z: src.z,
      vx: src.vx * 0.12, vy: src.vy * 0.12, vz: src.vz * 0.12,
      life: rand(4.5, 8.5) * Math.sqrt(this.ts), s0: rf * 0.12 * rand(0.8, 1.2) + 1.5 * Math.sqrt(s), s1: rf * rand(0.45, 0.65), sTau: 2.4,
      frame: FRAME.SMOKE + pick(8), drag: 1.6, rise: 1.0, riseTau: 4,
      r: 0.2 * tone, g: 0.165 * tone, b: 0.13 * tone, r1: 0.36 * tone, g1: 0.32 * tone, b1: 0.27 * tone, cTau: 4,
      alpha: 0.7, fadeIn: 0.04, fadeOut: 0.6,
    });
    if (this.water) Object.assign(p, { r: 0.8, g: 0.84, b: 0.88, r1: 0.9, g1: 0.92, b1: 0.95, gravity: 3, alpha: 0.55 });
  }

  _stemPuff() {
    const p = this._spawn(KIND.SMOKE);
    if (!p) return;
    const { rf } = this;
    const a = Math.random() * Math.PI * 2;
    const r = rf * rand(0, 0.35);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const dark = rand(0.05, 0.08);
    Object.assign(p, {
      x, y: this.groundY(x, z) + rf * 0.3, z, vy: rf * 0.4,
      life: rand(22, 32), s0: rf * rand(0.3, 0.45), s1: rf * rand(0.75, 1.0), sTau: 6,
      frame: FRAME.SMOKE + pick(8), drag: 1.0, rise: rf * 0.25, riseTau: 12,
      r: dark, g: dark * 0.93, b: dark * 0.86, r1: 0.25, g1: 0.22, b1: 0.19, cTau: 6,
      alpha: 0.8, fadeIn: 0.05, fadeOut: 0.4, glow: 1,
    });
  }

  _dustPuff(x, y, z, size) {
    const p = this._spawn(KIND.DUST);
    if (!p) return;
    Object.assign(p, {
      x, y: y + size, z, life: rand(2.5, 4), s0: size * 2, s1: size * 6, sTau: 1.5,
      frame: FRAME.SMOKE + pick(8), drag: 2, rise: 0.8, riseTau: 3,
      r: 0.38, g: 0.33, b: 0.27, r1: 0.45, g1: 0.41, b1: 0.35, cTau: 3, alpha: 0.45, fadeIn: 0.05, fadeOut: 0.6,
    });
  }

  /** Back-to-front sort and upload of the instance attributes. */
  _writeParticles() {
    const list = this.particles;
    list.sort((a, b) => b.key - a.key);
    const pos = this.iPos.array;
    const shape = this.iShape.array;
    const color = this.iColor.array;
    const emit = this.iEmit.array;
    let n = 0;
    for (const p of list) {
      if (p.kind === KIND.SOURCE || (p.opacity <= 0.001 && p.er + p.eg + p.eb <= 0.002)) continue;
      const j3 = n * 3;
      const j4 = n * 4;
      pos[j3] = p.x; pos[j3 + 1] = p.y; pos[j3 + 2] = p.z;
      shape[j4] = p.size; shape[j4 + 1] = p.rot; shape[j4 + 2] = p.frame; shape[j4 + 3] = 0;
      color[j4] = p.curR; color[j4 + 1] = p.curG; color[j4 + 2] = p.curB; color[j4 + 3] = p.opacity;
      emit[j4] = p.er; emit[j4 + 1] = p.eg; emit[j4 + 2] = p.eb; emit[j4 + 3] = p.light;
      n++;
    }
    for (const attr of [this.iPos, this.iShape, this.iColor, this.iEmit]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * attr.itemSize);
      attr.needsUpdate = true;
    }
    this.particleGeometry.instanceCount = n;
    this.mesh.visible = n > 0;
  }

  _updateSparks(dt) {
    const list = this.sparks;
    const pos = this.sPos.array;
    const vel = this.sVel.array;
    const data = this.sData.array;
    let n = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      s.age += dt;
      const ground = this.groundY(s.x, s.z);
      if (s.age >= s.life || (s.y < ground && s.vy < 0)) {
        list[i] = list[list.length - 1];
        list.pop();
        continue;
      }
      const k = Math.exp(-0.7 * dt);
      s.vx *= k;
      s.vy = s.vy * k - G * dt;
      s.vz *= k;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.z += s.vz * dt;
      const lifeT = s.age / s.life;
      pos[n * 3] = s.x; pos[n * 3 + 1] = s.y; pos[n * 3 + 2] = s.z;
      vel[n * 3] = s.vx; vel[n * 3 + 1] = s.vy; vel[n * 3 + 2] = s.vz;
      data[n * 4] = s.width;
      data[n * 4 + 1] = 0.045;
      data[n * 4 + 2] = 1 - lifeT;
      data[n * 4 + 3] = 3.2 * (1 - lifeT * lifeT) * (this.fading > 0 ? 1 - this.fading : 1);
      n++;
    }
    for (const attr of [this.sPos, this.sVel, this.sData]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, n * attr.itemSize);
      attr.needsUpdate = true;
    }
    this.sparkGeometry.instanceCount = n;
    this.sparkMesh.visible = n > 0;
  }

  _updateFireballs(t) {
    const { rf, ts } = this;
    const fade = this.fading > 0 ? 1 - this.fading : 1;
    const rise = rf * 0.3 + rf * 0.55 * (t / ts);
    for (const f of this.fireballs) {
      const life = (1.1 + 0.45 * f.layer) * ts * (this.water ? 0.6 : 1);
      if (t > life) {
        f.mesh.visible = false;
        continue;
      }
      const grow = 1 - Math.exp(-t / ((0.05 + 0.03 * f.layer) * ts));
      const radius = rf * f.scale * grow * (1 + 0.22 * (t / ts));
      f.mesh.visible = radius > 0.01;
      f.mesh.scale.setScalar(Math.max(radius, 0.01));
      f.mesh.position.set(0, rise * (0.85 + 0.15 * f.layer), 0);
      const u = f.uniforms;
      u.uTime.value = t * 1.4 / ts;
      u.uHeat.value = (1 - 0.12 * f.layer) * Math.exp(-t / ((0.32 + 0.1 * f.layer) * ts)) * (this.water ? 0.7 : 1);
      u.uOpacity.value = Math.min(1, (1 - t / life) * 2.2) * (f.layer === 2 ? 0.85 : 1) * fade;
    }
  }

  _updateShock(t) {
    const { rf, ts } = this;
    const life = 1.1 * ts;
    if (t > life) {
      this.shock.visible = false;
      return;
    }
    this.shock.visible = true;
    const r = rf * 0.5 + 340 * t;
    this.shock.scale.setScalar(r);
    this.shock.material.uniforms.uOpacity.value = 0.22 * (1 - t / life) ** 2 * (this.mushroom ? 1.6 : 1);
  }

  /** Light sources of this explosion: { world, radius (m), r, g, b } (fireball, then fires). */
  collectLights(out) {
    const t = this.age;
    const { rf, ts } = this;
    const fade = this.fading > 0 ? 1 - this.fading : 1;
    const flash = 9 * Math.exp(-t / 0.06);
    const ball = 3.2 * Math.exp(-t / (0.5 * ts));
    const total = (flash + ball) * fade;
    if (total > 0.02) {
      out.push({
        x: 0, y: rf * 0.4 + rf * 0.4 * (t / ts), z: 0, frame: this,
        radius: rf * (6 + 10 * Math.min(flash / 9, 1)),
        r: (flash * 1.0 + ball * 1.0), g: (flash * 0.85 + ball * 0.42), b: (flash * 0.65 + ball * 0.12),
        strength: total,
      });
    }
    for (const src of this.sources) {
      const st = (src.strength ?? 0) * 0.55 * fade;
      if (st <= 0.01) continue;
      out.push({
        x: src.x, y: src.y + 2.5, z: src.z, frame: this,
        radius: 16 * src.a2 + 6, r: st, g: st * 0.45, b: st * 0.13, strength: st * 0.6,
      });
    }
  }

  dispose() {
    this.sys.scene.remove(this.group);
    this.particleGeometry.dispose();
    this.sparkGeometry.dispose();
    this.mesh.material.dispose();
    this.sparkMesh.material.dispose();
    for (const f of this.fireballs) f.mesh.material.dispose();
    this.shock.material.dispose();
  }
}

/* ------------------------------------------------------------------ */
/* System                                                              */
/* ------------------------------------------------------------------ */
export class ExplosionSystem {
  /**
   * @param {object} p
   * @param {THREE.Scene} p.scene
   * @param {THREE.WebGLRenderer} p.renderer
   * @param {object} p.earthUniforms   uniforms.earth (uBlastActive, uBlastPos, uBlastColor, uScorch, uScorchInfo)
   * @param {Function} p.getGroundM    (lat, lon) → terrain height in metres
   * @param {number} p.quality         particle multiplier (1 high … 0.4 low)
   */
  constructor({ scene, renderer, earthUniforms, getGroundM, quality = 1 }) {
    this.scene = scene;
    this.renderer = renderer;
    this.earth = earthUniforms;
    this.getGroundM = getGroundM;
    this.quality = quality;
    this.explosions = [];
    this.scorches = [];
    this.wind = new THREE.Vector3();
    this.setWind();

    this.blending = {
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    };
    this.quad = new THREE.BufferGeometry();
    this.quad.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    this.quad.setIndex([0, 1, 2, 0, 2, 3]);
    this.sphere = new THREE.IcosahedronGeometry(1, quality >= 0.9 ? 5 : quality >= 0.6 ? 4 : 3);
    this.shell = new THREE.IcosahedronGeometry(1, 3);

    this.shared = {
      uAtlas: { value: this._createAtlas(renderer) },
      uMetre: { value: METRE },
      uGrid: { value: 4 },
      uSunView: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uAmbient: { value: new THREE.Color(0.3, 0.33, 0.4) },
    };
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._lights = [];
    this.topLights = [];
  }

  /** New random breeze (2–7 m/s) for the smoke. */
  setWind() {
    const a = Math.random() * Math.PI * 2;
    const speed = rand(2, 7);
    this.wind.set(Math.cos(a) * speed, 0, Math.sin(a) * speed);
  }

  /** Renders the 4 × 4 particle atlas (smoke, flames, rocks, glow, flare) once on the GPU. */
  _createAtlas(renderer) {
    const size = 1024;
    const target = new THREE.WebGLRenderTarget(size, size, {
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        uniforms: { uGrid: { value: 4 } },
        vertexShader: SHADERS.atlasVertex,
        fragmentShader: SHADERS.atlasFragment,
        depthTest: false,
        depthWrite: false,
      }),
    );
    quad.frustumCulled = false;
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(quad, camera);
    renderer.setRenderTarget(previous);
    quad.geometry.dispose();
    quad.material.dispose();
    this.atlasTarget = target;
    return target.texture;
  }

  get active() {
    return this.explosions.length > 0 || this.scorches.length > 0;
  }

  /**
   * Detonates a charge on the ground.
   * @param {boolean} [scorch]  leave a scorch mark (default: on land)
   * @returns {{ world: THREE.Vector3, radius: number } | null} blast centre (world) and fireball
   *   radius (m); null when skipped because every live explosion is bigger
   */
  spawn({ lat, lon, groundM, yieldKg, water = false, scorch = !water }) {
    // Too many at once: the oldest one no bigger than this charge fades out quickly
    // (a cannon hit never cuts a bomb's explosion short)
    const live = this.explosions.filter((e) => e.fading === 0);
    if (live.length >= MAX_EXPLOSIONS) {
      const victim = live.find((e) => e.yieldKg <= yieldKg);
      if (!victim) return null;
      victim.fading = 0.0001;
    }
    const e = new Explosion(this, { lat, lon, groundM, yieldKg, water });
    this.explosions.push(e);
    if (scorch && !water) {
      if (this.scorches.length >= MAX_SCORCH) this.scorches.shift();
      this.scorches.push({
        world: latLonToVector3(lat, lon, 1 + groundM / EARTH_RADIUS_M),
        radius: e.rf * 1.7,
        born: performance.now() / 1000,
        seed: Math.random() * 50,
      });
    }
    return { world: e.world.clone(), radius: e.rf };
  }

  clear() {
    for (const e of this.explosions) e.dispose();
    this.explosions.length = 0;
    this.scorches.length = 0;
    this._writeEarthUniforms(null);
  }

  /**
   * @param {number} dt
   * @param {THREE.Camera} camera   final camera of this frame (matrices up to date)
   * @param {object} env            { sunDir: Vector3 (world), sunColor: Color, ambient: Color }
   */
  update(dt, camera, env) {
    const sh = this.shared;
    sh.uSunView.value.copy(env.sunDir).transformDirection(camera.matrixWorldInverse);
    sh.uSunColor.value.copy(env.sunColor);
    sh.uAmbient.value.copy(env.ambient);

    const camLocal = this._v;
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i];
      if (e.fading > 0) e.fading = Math.min(1, e.fading + dt);
      camLocal.copy(camera.position);
      e.group.worldToLocal(camLocal);
      e.uniforms.uUpView.value.copy(e.up).transformDirection(camera.matrixWorldInverse);
      const alive = e.update(dt, { camLocal, wind: this.wind });
      if (!alive || e.fading >= 1) {
        e.dispose();
        this.explosions.splice(i, 1);
      }
    }
    this._writeEarthUniforms(camera);
  }

  /** Strongest lights → Earth shader (ground lighting) and `topLights` (for the aircraft). */
  _writeEarthUniforms(camera) {
    const u = this.earth;
    const lights = this._lights;
    lights.length = 0;
    if (camera) for (const e of this.explosions) e.collectLights(lights);
    for (const l of lights) {
      // local → world
      this._v.set(l.x, l.y, l.z).applyMatrix4(l.frame.group.matrixWorld);
      l.world = this._v.clone();
      l.rank = l.strength / (1 + l.world.distanceTo(camera.position) * EARTH_RADIUS_M / 800);
    }
    lights.sort((a, b) => b.rank - a.rank);
    this.topLights = lights.slice(0, 2);

    let any = false;
    for (let i = 0; i < 4; i++) {
      const l = lights[i];
      if (l) {
        const v = l.world.clone().applyMatrix4(camera.matrixWorldInverse);
        u.uBlastPos.value[i].set(v.x, v.y, v.z, 1 / (l.radius * METRE));
        u.uBlastColor.value[i].set(l.r, l.g, l.b);
        any = true;
      } else {
        u.uBlastColor.value[i].set(0, 0, 0);
      }
    }

    const now = performance.now() / 1000;
    for (let i = this.scorches.length - 1; i >= 0; i--) {
      if (now - this.scorches[i].born > SCORCH_LIFE + 20) this.scorches.splice(i, 1);
    }
    for (let i = 0; i < MAX_SCORCH; i++) {
      const sc = this.scorches[i];
      if (sc && camera) {
        const age = now - sc.born;
        const strength = clamp(age / 0.4, 0, 1) * clamp(1 - (age - SCORCH_LIFE) / 20, 0, 1);
        const v = this._v.copy(sc.world).applyMatrix4(camera.matrixWorldInverse);
        u.uScorch.value[i].set(v.x, v.y, v.z, 1 / (sc.radius * METRE));
        u.uScorchInfo.value[i].set(strength, sc.seed);
        any = any || strength > 0;
      } else {
        u.uScorchInfo.value[i].set(0, 0);
      }
    }
    u.uBlastActive.value = any ? 1 : 0;
  }

  /** Screen flash (0..1) from explosions in view during their first fraction of a second. */
  flashLevel(camera) {
    let level = 0;
    for (const e of this.explosions) {
      if (e.age > 0.4) continue;
      this._v.copy(e.world).applyMatrix4(camera.matrixWorldInverse);
      if (this._v.z > 0) continue; // behind the camera
      const distM = this._v.length() * EARTH_RADIUS_M;
      const f = Math.exp(-e.age / 0.07) * clamp((e.rf * 9) / (distM + e.rf), 0, 1);
      level = Math.max(level, f);
    }
    return level;
  }

  dispose() {
    this.clear();
    this.quad.dispose();
    this.sphere.dispose();
    this.shell.dispose();
    this.atlasTarget.dispose();
  }
}
