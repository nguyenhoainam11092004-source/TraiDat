/**
 * Su-30MK2 two-seat multirole fighter (Flanker family) for the flight mode, built from code
 * like the F-16 in aircraft.js (no download needed): long drooped nose with a pitot boom and
 * an IRST ball, tandem canopy, blended lifting body with large leading-edge root extensions,
 * widely spaced engine nacelles with raked intakes, twin fins on tail booms, all-moving
 * tailerons, the tail "stinger" between the nozzles and R-73 missiles on the wingtips.
 *
 * The three-tone blue-grey camouflage is computed in the shader from each vertex's position on
 * the airframe (baked into an `aPaint` attribute), so the pattern, panel lines and the light
 * belly run continuously across all the separate parts. Markings: Vietnamese flag on the fins,
 * roundels on the wings, side number on the intakes.
 *
 * Units: metres. The nose points to −Z, up is +Y, the right wing is +X (as JetModel).
 * Main dimensions follow the real aircraft: length ≈ 22 m, span 14.7 m, height ≈ 6.4 m.
 */
import * as THREE from 'three';
import { JetModel, planformXZ, planformZY, stripeTexture } from './aircraft.js';

const DEG = Math.PI / 180;
const ss = THREE.MathUtils.smoothstep;

/** Paint (sRGB): Flanker-style blue-grey camouflage over a light belly. */
const SCHEME = { light: '#9fb0bf', mid: '#74889b', dark: '#4f6275', belly: '#c5cfd8' };
const SIDE_NUMBER = '8521';

/* ------------------------------------------------------------------ */
/* Camouflage paint                                                    */
/* ------------------------------------------------------------------ */
const PAINT_GLSL = /* glsl */ `
  varying vec4 vPaint;          // xyz: position on the airframe (m), w: belly (0..1)
  uniform vec3 uPaintLight;
  uniform vec3 uPaintMid;
  uniform vec3 uPaintDark;
  uniform vec3 uPaintBelly;

  float paintHash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float paintNoise(vec3 x) {
    vec3 i = floor(x);
    vec3 f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(paintHash(i), paintHash(i + vec3(1.0, 0.0, 0.0)), f.x),
                   mix(paintHash(i + vec3(0.0, 1.0, 0.0)), paintHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
               mix(mix(paintHash(i + vec3(0.0, 0.0, 1.0)), paintHash(i + vec3(1.0, 0.0, 1.0)), f.x),
                   mix(paintHash(i + vec3(0.0, 1.0, 1.0)), paintHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
  }
  // Thin line every "period" metres, faded out when it would be thinner than a pixel
  float panelLine(float v, float period) {
    float d = abs(fract(v / period + 0.5) - 0.5) * period;
    float w = fwidth(v);
    return (1.0 - smoothstep(0.004, 0.004 + w * 1.5, d)) * (1.0 - smoothstep(0.02, 0.08, w));
  }
  vec3 paintColour(vec4 p) {
    // Large soft-edged patches, stretched along the fuselage like a sprayed scheme
    vec3 q = p.xyz * vec3(0.3, 0.42, 0.18);
    float n = paintNoise(q) * 0.62 + paintNoise(q * 2.1 + 5.3) * 0.38;
    float w = fwidth(n) + 0.012;
    vec3 c = mix(uPaintLight, uPaintMid, smoothstep(0.46 - w, 0.46 + w, n));
    c = mix(c, uPaintDark, smoothstep(0.6 - w, 0.6 + w, n));
    c = mix(c, uPaintBelly, p.w);
    // Panel lines: frames across the airframe, ribs along the wings
    float lines = max(panelLine(p.z + 0.31, 1.2), panelLine(abs(p.x) + 0.45, 1.6) * step(1.0, abs(p.x)));
    c *= 1.0 - 0.12 * lines;
    // Slightly uneven, weathered paint
    c *= 0.93 + 0.1 * paintNoise(p.xyz * 3.1 + 11.0);
    return c;
  }
`;

function paintMaterial(scheme) {
  const material = new THREE.MeshStandardMaterial({ color: '#ffffff', metalness: 0.1, roughness: 0.58, envMapIntensity: 0.8 });
  const uniforms = {
    uPaintLight: { value: new THREE.Color(scheme.light) },
    uPaintMid: { value: new THREE.Color(scheme.mid) },
    uPaintDark: { value: new THREE.Color(scheme.dark) },
    uPaintBelly: { value: new THREE.Color(scheme.belly) },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aPaint;\nvarying vec4 vPaint;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vPaint = aPaint;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${PAINT_GLSL}`)
      .replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.rgb *= paintColour(vPaint);');
  };
  material.customProgramCacheKey = () => 'su30-paint';
  material.userData.paint = true;
  return material;
}

/* ------------------------------------------------------------------ */
/* Markings                                                            */
/* ------------------------------------------------------------------ */
function canvasTexture(width, height, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d'));
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function drawStar(ctx, cx, cy, r, color) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const radius = i % 2 ? r * 0.382 : r;
    ctx.lineTo(cx + Math.cos(a) * radius, cy + Math.sin(a) * radius);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

/** Flag of Vietnam (2:3, star radius = 1/5 of the length). */
const flagTexture = () => canvasTexture(300, 200, (ctx) => {
  ctx.fillStyle = '#da251d';
  ctx.fillRect(0, 0, 300, 200);
  drawStar(ctx, 150, 100, 60, '#ffde00');
});

/** Wing roundel: yellow star on a red disc with a yellow ring. */
const roundelTexture = () => canvasTexture(256, 256, (ctx) => {
  ctx.fillStyle = '#ffd700';
  ctx.beginPath();
  ctx.arc(128, 128, 126, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#da251d';
  ctx.beginPath();
  ctx.arc(128, 128, 106, 0, Math.PI * 2);
  ctx.fill();
  drawStar(ctx, 128, 132, 84, '#ffde00');
});

/** Side number: red with a thin white outline. */
const numberTexture = (text) => canvasTexture(512, 200, (ctx) => {
  ctx.font = '900 170px "Arial Black", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 12;
  ctx.strokeStyle = '#f2f2f2';
  ctx.strokeText(text, 256, 104);
  ctx.fillStyle = '#c41e1e';
  ctx.fillText(text, 256, 104);
});

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */
function roundedRect(hw, hh, r) {
  const s = new THREE.Shape();
  s.moveTo(-hw + r, -hh);
  s.lineTo(hw - r, -hh);
  s.quadraticCurveTo(hw, -hh, hw, -hh + r);
  s.lineTo(hw, hh - r);
  s.quadraticCurveTo(hw, hh, hw - r, hh);
  s.lineTo(-hw + r, hh);
  s.quadraticCurveTo(-hw, hh, -hw, hh - r);
  s.lineTo(-hw, -hh + r);
  s.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
  return s;
}

/** Counter-clockwise loop of a shape, without the repeated closing point. */
function shapeLoop(shape, divisions = 4) {
  const pts = shape.getPoints(divisions).map((p) => [p.x, p.y]);
  const [a, b] = [pts[0], pts[pts.length - 1]];
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) pts.pop();
  return pts;
}

/** Unit circle (counter-clockwise), the lower half flattened by `belly`. */
function circleLoop(n, belly = 1) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const y = Math.sin(a);
    pts.push([Math.cos(a), y < 0 ? y * belly : y]);
  }
  return pts;
}

/**
 * Smooth tube along +Z through cross-sections: `section` is a counter-clockwise loop of [x, y]
 * points, `stations` a list of [z, scaleX, scaleY, offsetY]. Indexed, so the normals are smooth.
 */
function loft(section, stations) {
  const n = section.length;
  const position = [];
  for (const [z, sx, sy, dy = 0] of stations) {
    for (const [x, y] of section) position.push(x * sx, y * sy + dy, z);
  }
  const index = [];
  for (let j = 0; j < stations.length - 1; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * n + i;
      const b = j * n + ((i + 1) % n);
      index.push(a, b, a + n, b, b + n, a + n);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/* ------------------------------------------------------------------ */
/* Su-30MK2                                                            */
/* ------------------------------------------------------------------ */
// Nose and forward fuselage: [z, radius, centre height] — the nose droops by 20 cm
const NOSE = [
  [-10.6, 0.004, -0.2], [-10.48, 0.1, -0.195], [-10.25, 0.2, -0.185], [-9.9, 0.3, -0.168],
  [-9.45, 0.4, -0.146], [-8.9, 0.485, -0.118], [-8.3, 0.56, -0.088], [-7.6, 0.63, -0.058],
  [-6.8, 0.69, -0.03], [-6.0, 0.735, -0.012], [-5.0, 0.765, 0], [-4.0, 0.78, 0],
  [-3.0, 0.785, 0], [-2.0, 0.775, 0], [-1.0, 0.72, 0], [0.0, 0.56, 0.04],
];
const NACELLE_X = 1.38;
const NACELLE_Y = -0.52;
const NACELLE_FRONT = -3.4;

export class Su30Model extends JetModel {
  _buildAirframe() {
    const paint = paintMaterial(SCHEME);
    paint.envMap = this.envMap;
    this.materials.push(paint);
    const radome = this._material({ color: '#bfc6cc', metalness: 0.05, roughness: 0.5 });
    const dark = this._material({ color: '#3b4148', metalness: 0.3, roughness: 0.55 });
    const intake = this._material({ color: '#050607', roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
    const glass = this._material({
      color: '#a9c4cc', metalness: 0.05, roughness: 0.03, transparent: true, opacity: 0.4,
      envMapIntensity: 2.2, clearcoat: 1, clearcoatRoughness: 0.02,
    }, true);
    const sensor = this._material({ color: '#1d2a33', metalness: 0.2, roughness: 0.18, envMapIntensity: 1.1, clearcoat: 0.6 }, true);
    const frame = this._material({ color: '#2f343a', metalness: 0.5, roughness: 0.45 });
    const helmetMat = this._material({ color: '#dfe2e4', roughness: 0.45, metalness: 0.05 });
    const metal = this._material({ color: '#7b7670', metalness: 0.75, roughness: 0.42 });
    const nozzleMat = this._material({ color: '#58534d', metalness: 0.85, roughness: 0.36, map: stripeTexture(), side: THREE.DoubleSide });
    const white = this._material({ color: '#e6e8ea', metalness: 0.15, roughness: 0.45 });
    const a = this.airframe;
    const add = (geometry, material, x = 0, y = 0, z = 0, parent = a) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z);
      parent.add(mesh);
      return mesh;
    };

    // ---- Nose: radome (light grey), pitot boom, forward fuselage, IRST ball
    const round = circleLoop(32, 0.9);
    const noseStations = (rows, k = 1) => rows.map(([z, r, dy]) => [z, r * k, r * 1.04 * k, dy]);
    add(loft(round, noseStations(NOSE.slice(0, 8), 1.006)), radome);
    add(loft(round, noseStations(NOSE.slice(6))), paint);
    add(new THREE.CylinderGeometry(0.016, 0.03, 1.4, 8).rotateX(Math.PI / 2), metal, 0, -0.2, -11.3);
    add(new THREE.SphereGeometry(0.12, 20, 14), sensor, 0.3, 0.56, -7.35); // offset to starboard, as on the real aircraft

    // ---- Tandem canopy with two frames, two pilots
    const canopy = add(new THREE.SphereGeometry(1, 40, 20), glass, 0, 0.6, -4.55);
    canopy.scale.set(0.43, 0.58, 2.35);
    add(new THREE.TorusGeometry(1, 0.05, 8, 30, Math.PI), frame, 0, 0.6, -6.15).scale.set(0.315, 0.425, 1);
    add(new THREE.TorusGeometry(1, 0.04, 8, 30, Math.PI), frame, 0, 0.6, -4.25).scale.set(0.427, 0.575, 1);
    for (const [y, z] of [[0.92, -5.5], [0.95, -3.85]]) {
      add(new THREE.SphereGeometry(0.15, 16, 12), helmetMat, 0, y, z).scale.set(1, 1.1, 1.15);
      add(new THREE.BoxGeometry(0.42, 0.5, 0.2), dark, 0, y - 0.11, z + 0.45);
    }

    // ---- Dorsal spine: hump behind the canopy, running down to the tail stinger
    add(loft(circleLoop(28, 0.6), [
      [-3.0, 0.45, 0.55, 0.25], [-2.0, 0.56, 0.6, 0.25], [-1.0, 0.6, 0.6, 0.22], [0.5, 0.62, 0.55, 0.2],
      [2.5, 0.62, 0.48, 0.18], [4.5, 0.58, 0.42, 0.15], [6.5, 0.5, 0.36, 0.1], [8.0, 0.42, 0.32, 0.03],
      [9.2, 0.34, 0.28, -0.04], [10.1, 0.27, 0.24, -0.08], [10.7, 0.2, 0.19, -0.1], [11.0, 0.145, 0.14, -0.1],
    ]), paint);
    add(loft(circleLoop(16), [[10.95, 0.15, 0.145, -0.1], [11.2, 0.1, 0.095, -0.1], [11.45, 0.02, 0.02, -0.1]]), dark);

    // ---- Lifting body with the leading-edge root extensions (thin towards the edges)
    const half = [[0.62, -6.5], [0.9, -5.4], [1.3, -4.3], [1.75, -3.3], [2.1, -2.3], [2.35, -1.2], [2.4, -0.5],
      [2.4, 6.2], [2.05, 6.7], [1.05, 6.95], [0.6, 7.6]];
    const body = planformXZ([...half, ...half.slice().reverse().map(([x, z]) => [-x, z])], 0.38, 0.04);
    const bp = body.attributes.position;
    for (let i = 0; i < bp.count; i++) {
      const ax = Math.abs(bp.getX(i));
      let k = 1 - 0.72 * ss(ax, 0.75, 2.4);
      if (bp.getZ(i) < 0) k *= 1 - 0.45 * ss(ax, 0.75, 1.3);
      bp.setY(i, bp.getY(i) * k);
    }
    add(body, paint, 0, 0.1, 0);
    add(new THREE.CylinderGeometry(0.07, 0.07, 0.5, 10).rotateX(Math.PI / 2), dark, 0.92, 0.26, -4.2); // GSh-30-1 port

    // ---- Engine nacelles: raked intakes (lower lip further back), bare-metal tail, nozzles
    const duct = shapeLoop(roundedRect(0.57, 0.56, 0.3));
    const nacelle = loft(duct, [[NACELLE_FRONT, 1, 1], [-1.0, 1, 1], [6.0, 1, 1], [8.4, 0.94, 0.94], [9.25, 0.88, 0.88]]);
    const rake = (g) => {
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        if (p.getZ(i) <= NACELLE_FRONT + 1e-4) p.setZ(i, NACELLE_FRONT + (0.56 - p.getY(i)) * 0.3);
      }
      g.computeVertexNormals();
      return g;
    };
    rake(nacelle);
    const mouth = new THREE.ShapeGeometry(roundedRect(0.55, 0.54, 0.28), 4);
    const mp = mouth.attributes.position;
    for (let i = 0; i < mp.count; i++) mp.setZ(i, NACELLE_FRONT + 0.03 + (0.56 - mp.getY(i)) * 0.3);
    const tailMetal = loft(duct, [[8.3, 0.951, 0.951], [9.27, 0.885, 0.885]]);
    this.turbine = new THREE.MeshBasicMaterial({ color: '#ff6a1a', transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false });
    for (const side of [1, -1]) {
      const x = side * NACELLE_X;
      add(nacelle, paint, x, NACELLE_Y, 0);
      add(mouth, intake, x, NACELLE_Y, 0);
      add(tailMetal, metal, x, NACELLE_Y, 0);
      add(new THREE.CylinderGeometry(0.6, 0.52, 0.95, 36, 1, true).rotateX(-Math.PI / 2), nozzleMat, x, NACELLE_Y, 9.675);
      add(new THREE.CircleGeometry(0.5, 24), this._material({ color: '#0b0a09', roughness: 0.9 }), x, NACELLE_Y, 9.6);
      add(new THREE.CircleGeometry(0.4, 24), this.turbine, x, NACELLE_Y, 9.62);
    }

    // ---- Wings (right, mirrored for the left), thinner towards the tips; wingtip launch rails
    const wing = planformXZ([[2.3, -0.45], [7.05, 4.05], [7.05, 5.25], [5.9, 5.45], [2.3, 5.95]], 0.26, 0.04);
    const wp = wing.attributes.position;
    for (let i = 0; i < wp.count; i++) wp.setY(i, wp.getY(i) * (1 - 0.62 * ss(wp.getX(i), 2.3, 7.05)));
    for (const side of [1, -1]) {
      add(wing, paint, 0, 0.06, 0).scale.x = side;
      add(new THREE.BoxGeometry(0.1, 0.12, 2.6), paint, side * 7.1, 0.06, 4.7);
    }

    // ---- Tail booms, twin fins with rudders, ventral fins
    const boom = loft(shapeLoop(roundedRect(0.2, 0.19, 0.12)), [[4.4, 1, 1], [9.7, 1, 1], [10.3, 0.8, 0.75], [10.5, 0.1, 0.1]]);
    const fin = planformZY([[5.3, 0.15], [8.25, 3.6], [9.45, 3.6], [9.42, 3.32], [8.9, 3.32], [8.9, 0.95], [9.65, 0.95], [9.7, 0.15]], 0.14, 0.03);
    const fp = fin.attributes.position;
    for (let i = 0; i < fp.count; i++) fp.setX(i, fp.getX(i) * (1 - 0.5 * ss(fp.getY(i), 0.2, 3.6)));
    const rudderGeo = planformZY([[0, 0], [0.02, 2.37], [0.52, 2.37], [0.6, 0]], 0.09, 0.02);
    const ventral = planformZY([[6.2, 0], [7.7, 0], [7.95, -0.85], [7.0, -0.85]], 0.06, 0.015);
    this.rudders = [];
    for (const side of [1, -1]) {
      const x = side * 2.2;
      add(boom, paint, x, -0.02, 0);
      add(fin, paint, x, 0, 0);
      add(new THREE.BoxGeometry(0.16, 0.12, 1.3), dark, x, 3.63, 8.85); // fin-tip antenna fairing
      const hinge = new THREE.Group();
      hinge.position.set(x, 0.95, 8.9);
      const rudder = new THREE.Group();
      hinge.add(rudder);
      add(rudderGeo, paint, 0, 0, 0, rudder);
      a.add(hinge);
      this.rudders.push(rudder);
      add(ventral, paint, x, -0.17, 0).rotation.z = side * 0.25;
    }

    // ---- All-moving tailerons, 3° anhedral (outer group: anhedral, inner: deflection)
    const tailGeo = planformXZ([[0, -1.55], [2.5, 0.85], [2.5, 1.55], [0, 1.4]], 0.12, 0.03);
    const tp = tailGeo.attributes.position;
    for (let i = 0; i < tp.count; i++) tp.setY(i, tp.getY(i) * (1 - 0.5 * ss(tp.getX(i), 0, 2.5)));
    this.tailerons = [];
    for (const side of [1, -1]) {
      const outer = new THREE.Group();
      outer.position.set(side * 2.42, -0.02, 9.15);
      outer.rotation.z = side * -3 * DEG;
      const inner = new THREE.Group();
      outer.add(inner);
      add(tailGeo, paint, 0, 0, 0, inner).scale.x = side;
      a.add(outer);
      this.tailerons.push({ pivot: inner, side });
    }

    // ---- Pylons and R-73 missiles (wingtips + outer pylons)
    const pylon = (x, y, z, h, len) => add(new THREE.BoxGeometry(0.08, h, len), paint, x, y, z);
    for (const side of [1, -1]) {
      pylon(side * 3.15, -0.23, 3.0, 0.27, 1.6);
      pylon(side * 4.35, -0.2, 3.5, 0.27, 1.5);
      pylon(side * 5.75, -0.12, 4.15, 0.2, 1.3);
      pylon(side * NACELLE_X, -1.17, 1.2, 0.2, 1.9);
      this._r73(side * 7.1, -0.08, 4.55, white, dark);
      this._r73(side * 5.75, -0.305, 4.15, white, dark);
    }
    pylon(0, -0.45, 2.0, 0.36, 2.4);

    // ---- Markings
    const decal = (texture, w, h) => new THREE.Mesh(new THREE.PlaneGeometry(w, h), this._material({
      map: texture, transparent: true, depthWrite: false, roughness: 0.55, metalness: 0.08,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    const flag = flagTexture();
    const roundel = roundelTexture();
    const number = numberTexture(SIDE_NUMBER);
    this.decalTextures = [flag, roundel, number];
    for (const side of [1, -1]) {
      // Flags on both faces of each fin
      for (const face of [1, -1]) {
        const m = decal(flag, 1.05, 0.7);
        m.position.set(side * (2.2 + face * 0.08), 2.25, 8.0);
        m.rotation.y = side * face * Math.PI / 2;
        a.add(m);
      }
      // Roundels above and below the wings (the star points forward)
      const top = decal(roundel, 1.0, 1.0);
      top.position.set(side * 5.3, 0.172, 3.96);
      top.rotation.set(-Math.PI / 2, 0, side * -0.03, 'ZXY'); // lie flat, then follow the wing's taper
      a.add(top);
      const bottom = decal(roundel, 1.0, 1.0);
      bottom.position.set(side * 5.3, -0.052, 3.96);
      bottom.rotation.set(Math.PI / 2, 0, side * 0.03, 'ZXY');
      a.add(bottom);
      // Side number on the intake ducts
      const num = decal(number, 1.1, 0.43);
      num.position.set(side * (NACELLE_X + 0.582), NACELLE_Y, -2.25);
      num.rotation.y = side * Math.PI / 2;
      a.add(num);
    }

    // ---- Stores: bombs under the wings, under the intakes, or one in the tunnel between the engines
    this.stores = {
      mk82: [[-4.35, -0.47, 3.5], [4.35, -0.47, 3.5], [-3.15, -0.5, 3.0], [3.15, -0.5, 3.0]],
      mk84: [[-NACELLE_X, -1.5, 1.2], [NACELLE_X, -1.5, 1.2]],
      big: [[0, -1.15, 2.0, Math.PI / 4]], // turned 45° so the lattice fins clear the nacelles
    };

    // ---- Specification (see JetModel)
    this.name = 'SU-30MK2';
    this.labels = { cannon: 'GSH-30-1', missile: 'R-73', bombs: { mk82: 'FAB-250', mk84: 'FAB-1000', big: 'FOAB' } };
    this.nozzles = [new THREE.Vector3(-NACELLE_X, NACELLE_Y, 10.15), new THREE.Vector3(NACELLE_X, NACELLE_Y, 10.15)];
    this.plumeRadius = 0.5;
    this.navSpots = [[-7.1, 0.14, 3.45], [7.1, 0.14, 3.45], [0, -0.1, 11.5]];
    this.strobeSpot = [-2.2, 3.72, 9.3];
    this.gun = new THREE.Vector3(0.92, 0.26, -4.5);
    this.cockpitEye = new THREE.Vector3(0, 1.06, -5.45); // the Flanker pilot sits high in the canopy
    this.chaseOffset = new THREE.Vector3(0, 7.5, 36);
    this.chaseLook = new THREE.Vector3(0, 1.5, -22);
    this.shadowExtent = 24;
    this.shadowOutline = [[[0, -10.6], [0.55, -8.6], [0.78, -6.4], [0.78, 8], [0.25, 11.4], [-0.25, 11.4], [-0.78, 8], [-0.78, -6.4], [-0.55, -8.6]]];
    for (const s of [1, -1]) {
      this.shadowOutline.push(
        half.map(([x, z]) => [x * s, z]),
        [[2.3 * s, -0.45], [7.1 * s, 4.05], [7.1 * s, 5.25], [5.9 * s, 5.45], [2.3 * s, 5.95]],
        [[0.81 * s, NACELLE_FRONT], [1.95 * s, NACELLE_FRONT], [1.95 * s, 10.1], [0.81 * s, 10.1]],
        [[2.0 * s, 4.4], [2.4 * s, 4.4], [2.4 * s, 10.4], [2.0 * s, 10.4]],
        [[2.42 * s, 7.6], [4.92 * s, 10.0], [4.92 * s, 10.7], [2.42 * s, 10.55]],
      );
    }

    this._bakePaint();
  }

  /** R-73 short-range missile: seeker, forward destabilisers and canards, cruciform tail fins. */
  _r73(x, y, z, white, dark) {
    const add = (geometry, material, dz, roll = 0) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, z + dz);
      mesh.rotation.z = roll;
      this.airframe.add(mesh);
    };
    add(new THREE.CylinderGeometry(0.085, 0.085, 2.6, 12).rotateX(Math.PI / 2), white, 0);
    add(new THREE.ConeGeometry(0.085, 0.3, 12).rotateX(-Math.PI / 2), dark, -1.45);
    for (const k of [0, 1]) {
      const roll = k * (Math.PI / 2) + Math.PI / 4;
      add(new THREE.BoxGeometry(0.008, 0.46, 0.3), white, 1.1, roll);
      add(new THREE.BoxGeometry(0.008, 0.3, 0.14), white, -0.95, roll);
      add(new THREE.BoxGeometry(0.006, 0.22, 0.06), white, -1.25, roll);
    }
  }

  /**
   * Stores every painted vertex's position on the airframe (and whether it faces down) in the
   * `aPaint` attribute. Geometries shared by several meshes (mirrored parts) are cloned first.
   */
  _bakePaint() {
    this.airframe.updateMatrixWorld(true);
    const inverse = this.airframe.matrixWorld.clone().invert();
    const rel = new THREE.Matrix4();
    const normalMatrix = new THREE.Matrix3();
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    const done = new Set();
    this.airframe.traverse((o) => {
      if (!o.isMesh || !o.material.userData?.paint) return;
      if (done.has(o.geometry)) o.geometry = o.geometry.clone();
      done.add(o.geometry);
      rel.multiplyMatrices(inverse, o.matrixWorld);
      normalMatrix.getNormalMatrix(rel);
      const pos = o.geometry.attributes.position;
      const nor = o.geometry.attributes.normal;
      const out = new Float32Array(pos.count * 4);
      for (let i = 0; i < pos.count; i++) {
        p.fromBufferAttribute(pos, i).applyMatrix4(rel);
        n.fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize();
        out[i * 4] = p.x;
        out[i * 4 + 1] = p.y;
        out[i * 4 + 2] = p.z;
        out[i * 4 + 3] = 1 - ss(n.y, -0.55, -0.15);
      }
      o.geometry.setAttribute('aPaint', new THREE.BufferAttribute(out, 4));
    });
  }

  dispose() {
    super.dispose();
    for (const t of this.decalTextures) t.dispose();
  }
}
