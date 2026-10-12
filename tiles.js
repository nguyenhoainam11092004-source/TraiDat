/**
 * TileEngine — streams high-resolution imagery, map labels and 3D terrain onto the globe.
 *
 *  - Imagery & labels: XYZ raster tiles in Web Mercator (e.g. Esri World Imagery).
 *  - Terrain: Terrarium elevation tiles (AWS Terrain Tiles): height = R·256 + G + B/256 − 32768 m.
 *
 * Every frame a quadtree is refined where the camera needs more detail (screen-space
 * error), within a tile budget. Each drawn tile is a small patch of the sphere, displaced
 * by the terrain and rendered with the Earth shader (TILE variant), so lighting, night
 * lights and highlights match the rest of the planet. While its own image loads, a tile
 * shows the best ancestor image and then cross-fades: no holes, no flashing.
 */
import * as THREE from 'three';
import {
  EARTH_RADIUS_M, clamp, lerp, latLonToVector3, lonToMercX, latToMercY, mercYToLat,
} from './geo.js';

const TILE_PX = 256;
const ROOT_ZOOM = 2;      // 16 root tiles
const MIN_LEAF_ZOOM = 4;  // coarser tiles are never drawn: the built-in 4K texture is as sharp
const KEEP_ZOOM = 4;      // tiles up to this zoom are never evicted (cheap fallbacks)

const _v = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _sphere = new THREE.Sphere();
const _frustum = new THREE.Frustum();
const _viewProj = new THREE.Matrix4();

/** Binary max-heap ordered by the items' `priority`. */
class MaxHeap {
  constructor() { this.items = []; }

  get size() { return this.items.length; }

  push(item) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].priority >= a[i].priority) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }

  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].priority > a[m].priority) m = l;
        if (r < a.length && a[r].priority > a[m].priority) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

class Tile {
  constructor(z, x, y) {
    this.z = z;
    this.x = x;
    this.y = y;
    this.key = `${z}/${x}/${y}`;
    const n = 2 ** z;
    this.west = (x / n) * 360 - 180;
    this.east = ((x + 1) / n) * 360 - 180;
    this.mercTop = y / n;
    this.mercBottom = (y + 1) / n;
    const north = mercYToLat(this.mercTop);
    const south = mercYToLat(this.mercBottom);
    const midLat = mercYToLat((this.mercTop + this.mercBottom) / 2);
    const midLon = (this.west + this.east) / 2;
    this.center = latLonToVector3(midLat, midLon, 1);

    // Angular radius: largest angle from the centre to a corner or an edge midpoint
    let radius = 0;
    for (const lat of [north, midLat, south]) {
      for (const lon of [this.west, midLon, this.east]) {
        radius = Math.max(radius, this.center.angleTo(latLonToVector3(lat, lon, 1, _v)));
      }
    }
    this.radius = radius;
    // Ground size in radians (Web Mercator tiles are roughly square on the ground)
    this.size = Math.max((this.east - this.west) * (Math.PI / 180) * Math.cos(midLat * (Math.PI / 180)),
      (north - south) * (Math.PI / 180));

    this.priority = 0;
    this.mesh = null;
    this.material = null;
    this.dirty = false;
    this.elevZ = -1;          // zoom of the elevation data the mesh was built with (-1 = flat)
    this.noRefine = false;    // the imagery server has nothing more detailed here
    this.lastUsed = 0;
    this.disposed = false;
    this.imagery = { status: 'none', texture: null, fade: 0, abort: null, errors: 0, errorAt: 0 };
    this.overlay = { status: 'none', texture: null, abort: null };
  }
}

const formatUrl = (template, { z, x, y }) => template.replace('{z}', z).replace('{x}', x).replace('{y}', y);

/** UV rectangle (offset.xy, scale.zw) of `child` inside an ancestor tile (UV v measured from the top). */
function setRect(vec4, child, ancestor) {
  const dz = child.z - ancestor.z;
  const s = 1 / 2 ** dz;
  vec4.set((child.x - ancestor.x * 2 ** dz) * s, (child.y - ancestor.y * 2 ** dz) * s, s, s);
}

/** Bilinear height (metres) from a decoded elevation tile at normalised Mercator coordinates. */
function sampleElevation(e, mercX, mercY) {
  const scale = 2 ** e.z * TILE_PX;
  const px = clamp(mercX * scale - e.x * TILE_PX - 0.5, 0, TILE_PX - 1);
  const py = clamp(mercY * scale - e.y * TILE_PX - 0.5, 0, TILE_PX - 1);
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const x1 = Math.min(x0 + 1, TILE_PX - 1);
  const y1 = Math.min(y0 + 1, TILE_PX - 1);
  const fx = px - x0;
  const fy = py - y0;
  const d = e.data;
  const top = lerp(d[y0 * TILE_PX + x0], d[y0 * TILE_PX + x1], fx);
  const bottom = lerp(d[y1 * TILE_PX + x0], d[y1 * TILE_PX + x1], fx);
  return lerp(top, bottom, fy);
}

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image decode failed')); };
    img.src = url;
  });
}

/** Downloads and decodes an image off the main thread (createImageBitmap), with an <img> fallback. */
async function loadBitmap(url, signal, raw = false) {
  const response = await fetch(url, { signal, mode: 'cors', credentials: 'omit' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  if (typeof createImageBitmap === 'function') {
    const options = raw ? { colorSpaceConversion: 'none', premultiplyAlpha: 'none' } : { premultiplyAlpha: 'none' };
    try {
      return await createImageBitmap(blob, options);
    } catch {
      try { return await createImageBitmap(blob); } catch { /* use the <img> path */ }
    }
  }
  return blobToImage(blob);
}

export class TileEngine {
  /**
   * @param {object} p
   * @param {THREE.Object3D} p.parent        where tile meshes are added
   * @param {object} p.uniforms              shared Earth shader uniforms (sun, layers, highlight…)
   * @param {string} p.vertexShader          Earth vertex shader (compiled with TILE defined)
   * @param {string} p.fragmentShader        Earth fragment shader
   * @param {object} p.sources               { imagery, overlay, terrain } URL templates & zoom limits
   * @param {object} p.settings              { maxLeaves, segments, sse, maxCache, concurrency, buildMs }
   * @param {number} p.anisotropy
   * @param {Function} p.onStatus            called with 'unavailable' when tiles keep failing
   */
  constructor({ parent, uniforms, vertexShader, fragmentShader, sources, settings, anisotropy = 4, onStatus }) {
    this.group = new THREE.Group();
    this.group.name = 'tiles';
    parent.add(this.group);
    this.shared = uniforms;
    this.vertexShader = vertexShader;
    this.fragmentShader = fragmentShader;
    this.sources = sources;
    this.settings = { maxLeaves: 180, segments: 24, sse: 1, maxCache: 240, concurrency: 8, buildMs: 4, ...settings };
    this.anisotropy = anisotropy;
    this.onStatus = onStatus || (() => {});
    this.options = { imagery: true, terrain: true, overlay: true };
    this.exaggeration = sources.terrain?.exaggeration ?? 1;

    this.tiles = new Map();
    this.elevation = new Map();
    this.visible = new Set();
    this.frame = 0;
    this.active = { imagery: 0, overlay: 0, terrain: 0 };
    this.loaded = { imagery: 0, overlay: 0, terrain: 0 }; // successful downloads so far
    this.stats = { tiles: 0, loading: 0, maxZoom: 0 };
    this.terrainActive = false;
    this._horizon = Math.PI / 2;
    this._wantedTerrain = new Map();
    this._failures = 0;
    this._pausedUntil = 0;
    this._reportedOffline = false;

    this.blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    this.blank.needsUpdate = true;
    const decode = document.createElement('canvas');
    decode.width = decode.height = TILE_PX;
    this._decodeCtx = decode.getContext('2d', { willReadFrequently: true });
    const probe = document.createElement('canvas');
    probe.width = probe.height = 8;
    this._probeCtx = probe.getContext('2d', { willReadFrequently: true });
  }

  /** True while requests are paused after repeated failures (e.g. no Internet connection). */
  get offline() {
    return performance.now() < this._pausedUntil;
  }

  setOptions(options) {
    const terrainChanged = options.terrain !== undefined && options.terrain !== this.options.terrain;
    Object.assign(this.options, options);
    if (terrainChanged) this._markAllDirty();
  }

  setSettings(settings) {
    const segmentsChanged = settings.segments !== undefined && settings.segments !== this.settings.segments;
    Object.assign(this.settings, settings);
    if (segmentsChanged) this._markAllDirty();
  }

  /** Terrain height (Earth radii) at a geographic point, from the most detailed tile loaded. */
  getHeight(lat, lon) {
    const src = this.sources.terrain;
    if (!this.terrainActive || !src) return 0;
    const mx = lonToMercX(lon);
    const my = latToMercY(lat);
    for (let z = src.maxZoom; z >= src.minZoom; z--) {
      const n = 2 ** z;
      const e = this.elevation.get(`${z}/${Math.min(Math.floor(mx * n), n - 1)}/${Math.min(Math.floor(my * n), n - 1)}`);
      if (e?.status === 'loaded') return (sampleElevation(e, mx, my) * this.exaggeration) / EARTH_RADIUS_M;
    }
    return 0;
  }

  /**
   * @param {THREE.PerspectiveCamera} camera  main camera, matrices up to date
   * @param {number} dt                       seconds since the previous frame
   * @param {object} p
   * @param {boolean} p.active                false when no tiles are needed (whole-globe view, layer off)
   * @param {number} p.focal                  focal length in CSS pixels
   */
  update(camera, dt, { active, focal }) {
    this.frame++;
    this.terrainActive = active && this.options.terrain;
    if (!active || !this.options.imagery) {
      this._setVisible([]);
      this._cancelStale(0);
      this.stats.tiles = 0;
    } else {
      const leaves = this._select(camera, focal);
      this._setVisible(leaves);
      for (const t of leaves) this._updateTextures(t, dt);
      this._schedule(leaves);
      this._cancelStale(20);
      this._evict();
      this.stats.tiles = leaves.length;
      this.stats.maxZoom = leaves.reduce((m, t) => Math.max(m, t.z), 0);
    }
    this.stats.loading = this.active.imagery + this.active.overlay + this.active.terrain;
  }

  /* ------------------------------------------------------------------ */
  /* Quadtree selection                                                  */
  /* ------------------------------------------------------------------ */
  _tile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    let t = this.tiles.get(key);
    if (!t) {
      t = new Tile(z, x, y);
      this.tiles.set(key, t);
    }
    return t;
  }

  _children(t) {
    const z = t.z + 1;
    const x = t.x * 2;
    const y = t.y * 2;
    return [this._tile(z, x, y), this._tile(z, x + 1, y), this._tile(z, x, y + 1), this._tile(z, x + 1, y + 1)];
  }

  /** Horizon test (spherical caps) + frustum test (bounding sphere). */
  _isVisible(t) {
    if (_camDir.angleTo(t.center) - t.radius > this._horizon) return false;
    _sphere.center.copy(t.center);
    _sphere.radius = 2 * Math.sin(t.radius / 2) + 0.0015; // + margin for terrain
    return _frustum.intersectsSphere(_sphere);
  }

  /** Screen-space error: how many screen pixels one tile pixel would cover. */
  _sse(t, camPos, focal) {
    const d = Math.max(camPos.distanceTo(t.center) - 2 * Math.sin(t.radius / 2), 1e-7);
    return ((t.size / d) * focal) / TILE_PX;
  }

  _select(camera, focal) {
    const camPos = camera.position;
    _viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_viewProj);
    _camDir.copy(camPos).normalize();
    this._horizon = Math.acos(clamp(1 / camPos.length(), -1, 1)) + 0.03;
    this._wantedTerrain.clear();

    const deadline = performance.now() + this.settings.buildMs;
    const canBuild = () => performance.now() < deadline;
    const maxZoom = this.sources.imagery.maxZoom;
    const heap = new MaxHeap();
    const leaves = [];
    const enqueue = (t) => {
      t.priority = this._sse(t, camPos, focal);
      t.lastUsed = this.frame;
      heap.push(t);
    };

    const n = 2 ** ROOT_ZOOM;
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        const t = this._tile(ROOT_ZOOM, x, y);
        if (this._isVisible(t)) enqueue(t);
      }
    }

    while (heap.size) {
      const t = heap.pop();
      if (t.z < MIN_LEAF_ZOOM) {
        for (const k of this._children(t)) if (this._isVisible(k)) enqueue(k);
        continue;
      }
      const budgetLeft = heap.size + leaves.length + 3 <= this.settings.maxLeaves;
      if (t.z < maxZoom && !t.noRefine && t.priority > this.settings.sse && budgetLeft) {
        const children = this._children(t).filter((k) => this._isVisible(k));
        // Refine only when every child can be drawn this frame; otherwise keep the parent a little longer.
        let ready = children.length > 0;
        for (const k of children) {
          if (k.mesh) continue;
          if (canBuild()) this._buildMesh(k);
          else ready = false;
        }
        if (ready) {
          children.forEach(enqueue);
          continue;
        }
      }
      leaves.push(t);
    }

    for (const t of leaves) {
      if ((!t.mesh || t.dirty) && canBuild()) this._buildMesh(t);
      this._wantTerrain(t);
    }
    return leaves.filter((t) => t.mesh);
  }

  _setVisible(leaves) {
    const next = new Set(leaves);
    for (const t of this.visible) if (!next.has(t) && t.mesh) t.mesh.visible = false;
    for (const t of next) t.mesh.visible = true;
    this.visible = next;
  }

  _ancestorWith(t, kind, maxLevels) {
    let { z, x, y } = t;
    for (let i = 0; i < maxLevels && z > 0; i++) {
      z -= 1;
      x = Math.floor(x / 2);
      y = Math.floor(y / 2);
      const a = this.tiles.get(`${z}/${x}/${y}`);
      if (a && a[kind].status === 'loaded') return a;
    }
    return null;
  }

  /** Chooses the textures each drawn tile samples: its own, or an ancestor's while loading. */
  _updateTextures(t, dt) {
    const u = t.material.uniforms;
    const img = t.imagery;
    if (img.status === 'loaded') {
      u.uTileMap.value = img.texture;
      img.fade = Math.min(1, img.fade + dt / 0.35);
      u.uTileMix.value = img.fade;
    } else {
      u.uTileMix.value = 0;
    }
    if (u.uTileMix.value < 1) {
      const ancestor = this._ancestorWith(t, 'imagery', 30);
      if (ancestor) {
        u.uParentMap.value = ancestor.imagery.texture;
        setRect(u.uParentRect.value, t, ancestor);
        u.uHasParent.value = 1;
        ancestor.lastUsed = this.frame;
      } else {
        u.uParentMap.value = this.blank;
        u.uHasParent.value = 0;
      }
    } else if (u.uHasParent.value) {
      u.uParentMap.value = this.blank; // release the ancestor so it can be evicted
      u.uHasParent.value = 0;
    }

    const minOverlay = this.sources.overlay?.minZoom ?? Infinity;
    if (!this.options.overlay || t.z < minOverlay) {
      u.uOverlayMix.value = 0;
      return;
    }
    if (t.overlay.status === 'loaded') {
      u.uOverlayMap.value = t.overlay.texture;
      u.uOverlayRect.value.set(0, 0, 1, 1);
      u.uOverlayMix.value = 1;
      return;
    }
    const parent = this._ancestorWith(t, 'overlay', 1);
    if (parent) {
      u.uOverlayMap.value = parent.overlay.texture;
      setRect(u.uOverlayRect.value, t, parent);
      u.uOverlayMix.value = 1;
      parent.lastUsed = this.frame;
    } else {
      u.uOverlayMap.value = this.blank;
      u.uOverlayMix.value = 0;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Meshes                                                              */
  /* ------------------------------------------------------------------ */
  _markAllDirty() {
    for (const t of this.tiles.values()) if (t.mesh) t.dirty = true;
  }

  _elevationFor(t) {
    const src = this.sources.terrain;
    if (!this.options.terrain || !src || t.z < src.minZoom) return null;
    for (let z = Math.min(t.z, src.maxZoom); z >= src.minZoom; z--) {
      const f = 2 ** (t.z - z);
      const e = this.elevation.get(`${z}/${Math.floor(t.x / f)}/${Math.floor(t.y / f)}`);
      if (e?.status === 'loaded') {
        e.lastUsed = this.frame;
        return e;
      }
    }
    return null;
  }

  _buildMesh(t) {
    const elevation = this._elevationFor(t);
    const geometry = this._geometry(t, elevation);
    t.elevZ = elevation ? elevation.z : -1;
    t.dirty = false;
    if (t.mesh) {
      t.mesh.geometry.dispose();
      t.mesh.geometry = geometry;
      return;
    }
    t.material = this._material(t);
    t.mesh = new THREE.Mesh(geometry, t.material);
    t.mesh.position.copy(t.center); // vertices are stored relative to the tile centre (precision)
    t.mesh.matrixAutoUpdate = false;
    t.mesh.updateMatrix();
    t.mesh.visible = false;
    this.group.add(t.mesh);
  }

  _material(t) {
    return new THREE.ShaderMaterial({
      uniforms: {
        ...this.shared,
        uTileMap: { value: this.blank },
        uTileMix: { value: 0 },
        uParentMap: { value: this.blank },
        uParentRect: { value: new THREE.Vector4(0, 0, 1, 1) },
        uHasParent: { value: 0 },
        uOverlayMap: { value: this.blank },
        uOverlayRect: { value: new THREE.Vector4(0, 0, 1, 1) },
        uOverlayMix: { value: 0 },
        uSpecScale: { value: t.z <= 6 ? 1 : 0 }, // the global water mask is too coarse for close-ups
      },
      vertexShader: this.vertexShader,
      fragmentShader: this.fragmentShader,
      defines: { TILE: '' },
    });
  }

  /** Grid of (n+1)² vertices in Mercator rows (aligned with the texture), plus skirts that hide cracks. */
  _geometry(t, elevation) {
    const n = t.z < 7 ? Math.max(8, this.settings.segments >> 1) : this.settings.segments;
    const side = n + 1;
    const grid = side * side;
    const total = grid + 4 * side;
    const position = new Float32Array(total * 3);
    const normal = new Float32Array(total * 3);
    const uv = new Float32Array(total * 2);
    const uvTile = new Float32Array(total * 2);
    const abs = new Float64Array(grid * 3);
    const scale = this.exaggeration / EARTH_RADIUS_M;
    const { x: cx, y: cy, z: cz } = t.center;
    let minH = Infinity;
    let maxH = -Infinity;

    for (let i = 0; i < side; i++) {
      const mercY = lerp(t.mercTop, t.mercBottom, i / n);
      const lat = mercYToLat(mercY);
      for (let j = 0; j < side; j++) {
        const lon = lerp(t.west, t.east, j / n);
        const h = elevation ? sampleElevation(elevation, lonToMercX(lon), mercY) * scale : 0;
        minH = Math.min(minH, h);
        maxH = Math.max(maxH, h);
        latLonToVector3(lat, lon, 1 + h, _v);
        const k = i * side + j;
        abs[k * 3] = _v.x;
        abs[k * 3 + 1] = _v.y;
        abs[k * 3 + 2] = _v.z;
        position[k * 3] = _v.x - cx;
        position[k * 3 + 1] = _v.y - cy;
        position[k * 3 + 2] = _v.z - cz;
        uv[k * 2] = (lon + 180) / 360;
        uv[k * 2 + 1] = (lat + 90) / 180;
        uvTile[k * 2] = j / n;
        uvTile[k * 2 + 1] = i / n;
      }
    }

    // Normals: east × north from neighbouring vertices (terrain), or radial (flat)
    for (let i = 0; i < side; i++) {
      for (let j = 0; j < side; j++) {
        const k = i * side + j;
        let nx = abs[k * 3];
        let ny = abs[k * 3 + 1];
        let nz = abs[k * 3 + 2];
        if (elevation) {
          const e0 = i * side + Math.max(j - 1, 0);
          const e1 = i * side + Math.min(j + 1, n);
          const n0 = Math.max(i - 1, 0) * side + j; // northern neighbour
          const n1 = Math.min(i + 1, n) * side + j; // southern neighbour
          const ex = abs[e1 * 3] - abs[e0 * 3];
          const ey = abs[e1 * 3 + 1] - abs[e0 * 3 + 1];
          const ez = abs[e1 * 3 + 2] - abs[e0 * 3 + 2];
          const qx = abs[n0 * 3] - abs[n1 * 3];
          const qy = abs[n0 * 3 + 1] - abs[n1 * 3 + 1];
          const qz = abs[n0 * 3 + 2] - abs[n1 * 3 + 2];
          nx = ey * qz - ez * qy;
          ny = ez * qx - ex * qz;
          nz = ex * qy - ey * qx;
        }
        const len = Math.hypot(nx, ny, nz) || 1;
        normal[k * 3] = nx / len;
        normal[k * 3 + 1] = ny / len;
        normal[k * 3 + 2] = nz / len;
      }
    }

    const indices = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const a = i * side + j;
        const b = a + side;
        const c = a + 1;
        indices.push(a, b, c, b, b + 1, c);
      }
    }

    // Skirts: a strip hanging down from every edge, drawn from both sides. In mountains they
    // must be deeper, because neighbours may use elevation data of a different resolution.
    const depth = Math.max(t.size * 0.03, 3e-6) + (maxH - minH) * 0.6;
    const edges = [
      Array.from({ length: side }, (_, j) => j),
      Array.from({ length: side }, (_, i) => i * side + n),
      Array.from({ length: side }, (_, j) => n * side + (n - j)),
      Array.from({ length: side }, (_, i) => (n - i) * side),
    ];
    let s = grid;
    for (const edge of edges) {
      const start = s;
      for (const k of edge) {
        const x = abs[k * 3];
        const y = abs[k * 3 + 1];
        const z = abs[k * 3 + 2];
        const r = Math.hypot(x, y, z);
        const f = (r - depth) / r;
        position[s * 3] = x * f - cx;
        position[s * 3 + 1] = y * f - cy;
        position[s * 3 + 2] = z * f - cz;
        normal.copyWithin(s * 3, k * 3, k * 3 + 3);
        uv.copyWithin(s * 2, k * 2, k * 2 + 2);
        uvTile.copyWithin(s * 2, k * 2, k * 2 + 2);
        s++;
      }
      for (let m = 0; m < n; m++) {
        const e0 = edge[m];
        const e1 = edge[m + 1];
        const s0 = start + m;
        const s1 = s0 + 1;
        indices.push(e0, s0, e1, e1, s0, s1, e0, e1, s0, e1, s1, s0);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geometry.setAttribute('uvTile', new THREE.BufferAttribute(uvTile, 2));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    return geometry;
  }

  /* ------------------------------------------------------------------ */
  /* Loading                                                             */
  /* ------------------------------------------------------------------ */
  /**
   * Queues the elevation tile this tile should use. When no elevation at all is available
   * yet, a much coarser tile is queued too: it loads first (the queue is coarse-first) and
   * gives every tile an approximate height quickly, so no tile is left flat at sea level
   * next to raised neighbours.
   */
  _wantTerrain(t) {
    const src = this.sources.terrain;
    if (!this.options.terrain || !src || t.z < src.minZoom) return;
    const desired = Math.min(t.z, src.maxZoom);
    let hasCoarser = false;
    for (let z = desired; z >= src.minZoom; z--) {
      const f = 2 ** (t.z - z);
      const e = this.elevation.get(`${z}/${Math.floor(t.x / f)}/${Math.floor(t.y / f)}`);
      if (!e) continue;
      e.lastUsed = this.frame;
      if (e.status === 'loaded' || e.status === 'loading') {
        if (z === desired) return;
        hasCoarser = true;
        break;
      }
    }
    this._queueTerrain(t, desired);
    if (!hasCoarser) this._queueTerrain(t, Math.max(src.minZoom, desired - 4));
  }

  _queueTerrain(t, z) {
    const f = 2 ** (t.z - z);
    const x = Math.floor(t.x / f);
    const y = Math.floor(t.y / f);
    const key = `${z}/${x}/${y}`;
    const e = this.elevation.get(key);
    if (e && (e.status !== 'error' || performance.now() - e.errorAt < 15000)) return;
    this._wantedTerrain.set(key, { z, x, y });
  }

  _schedule(leaves) {
    const now = performance.now();
    if (now < this._pausedUntil) return;
    const limit = this.settings.concurrency;
    const order = (a, b) => a.z - b.z || b.priority - a.priority; // coarse first, then most needed

    if (this.active.imagery < limit) {
      const queue = leaves.filter((t) => t.imagery.status === 'none'
        || (t.imagery.status === 'error' && t.imagery.errors < 3 && now - t.imagery.errorAt > 8000));
      queue.sort(order);
      for (const t of queue) {
        if (this.active.imagery >= limit) break;
        this._loadImagery(t);
      }
    }

    const overlay = this.sources.overlay;
    const half = Math.max(2, Math.ceil(limit / 2));
    if (this.options.overlay && overlay && this.active.overlay < half) {
      const queue = leaves.filter((t) => t.z >= overlay.minZoom && t.overlay.status === 'none');
      queue.sort(order);
      for (const t of queue) {
        if (this.active.overlay >= half) break;
        this._loadOverlay(t);
      }
    }

    const terrainLimit = Math.max(3, Math.ceil(limit * 0.75));
    if (this.options.terrain && this.sources.terrain && this.active.terrain < terrainLimit) {
      const queue = [...this._wantedTerrain.values()].sort((a, b) => a.z - b.z);
      for (const w of queue) {
        if (this.active.terrain >= terrainLimit) break;
        this._loadElevation(w.z, w.x, w.y);
      }
    }
  }

  _succeeded() {
    this._failures = 0;
  }

  _failed() {
    this._failures++;
    if (this._failures < 10) return;
    this._failures = 0;
    this._pausedUntil = performance.now() + 15000; // back off, then try again
    if (!this._reportedOffline) {
      this._reportedOffline = true;
      this.onStatus('unavailable');
    }
  }

  _loadImagery(t) {
    const job = t.imagery;
    const controller = new AbortController();
    job.status = 'loading';
    job.abort = () => controller.abort();
    this.active.imagery++;
    loadBitmap(formatUrl(this.sources.imagery.url, t), controller.signal)
      .then((image) => {
        if (t.disposed) return;
        if (this._isPlaceholder(image)) {
          // "Map data not yet available": keep showing the parent and stop refining here
          job.status = 'empty';
          t.noRefine = true;
          image.close?.();
        } else {
          job.texture = this._texture(image);
          job.status = 'loaded';
          job.fade = 0;
          this.loaded.imagery++;
        }
        this._succeeded();
      })
      .catch((error) => {
        if (t.disposed) return;
        if (error.name === 'AbortError') {
          job.status = 'none';
        } else if (/HTTP 404/.test(error.message)) {
          job.status = 'empty';
          t.noRefine = true;
        } else {
          job.status = 'error';
          job.errors++;
          job.errorAt = performance.now();
          this._failed();
        }
      })
      .finally(() => {
        this.active.imagery--;
        job.abort = null;
      });
  }

  _loadOverlay(t) {
    const job = t.overlay;
    const controller = new AbortController();
    job.status = 'loading';
    job.abort = () => controller.abort();
    this.active.overlay++;
    loadBitmap(formatUrl(this.sources.overlay.url, t), controller.signal)
      .then((image) => {
        if (t.disposed) return;
        job.texture = this._texture(image);
        job.status = 'loaded';
        this.loaded.overlay++;
      })
      .catch((error) => {
        if (t.disposed) return;
        job.status = error.name === 'AbortError' ? 'none' : 'empty'; // labels are optional: never retry
      })
      .finally(() => {
        this.active.overlay--;
        job.abort = null;
      });
  }

  _loadElevation(z, x, y) {
    const key = `${z}/${x}/${y}`;
    const e = { key, z, x, y, status: 'loading', data: null, lastUsed: this.frame, errorAt: 0, abort: null };
    const controller = new AbortController();
    e.abort = () => controller.abort();
    this.elevation.set(key, e);
    this.active.terrain++;
    loadBitmap(formatUrl(this.sources.terrain.url, e), controller.signal, true)
      .then((image) => {
        e.data = this._decodeTerrarium(image);
        image.close?.();
        e.status = 'loaded';
        this.loaded.terrain++;
        this._onElevation(e);
      })
      .catch((error) => {
        if (error.name === 'AbortError') {
          this.elevation.delete(key);
        } else {
          e.status = 'error';
          e.errorAt = performance.now();
        }
      })
      .finally(() => {
        this.active.terrain--;
        e.abort = null;
      });
  }

  _decodeTerrarium(image) {
    const ctx = this._decodeCtx;
    ctx.clearRect(0, 0, TILE_PX, TILE_PX);
    ctx.drawImage(image, 0, 0, TILE_PX, TILE_PX);
    const px = ctx.getImageData(0, 0, TILE_PX, TILE_PX).data;
    const out = new Float32Array(TILE_PX * TILE_PX);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) {
      // Oceans are clamped to sea level (the tiles also contain bathymetry)
      out[i] = Math.max(0, px[j] * 256 + px[j + 1] + px[j + 2] / 256 - 32768);
    }
    return out;
  }

  /** Marks meshes covered by newly loaded elevation data for a rebuild. */
  _onElevation(e) {
    for (const t of this.tiles.values()) {
      if (!t.mesh || t.z < e.z || t.elevZ >= e.z) continue;
      const f = 2 ** (t.z - e.z);
      if (Math.floor(t.x / f) === e.x && Math.floor(t.y / f) === e.y) t.dirty = true;
    }
  }

  /**
   * Esri answers missing areas with a flat grey (~208) "Map data not yet available" image.
   * The downscale may sample its white lettering (~245), so brighter grey samples are
   * tolerated: neutral everywhere, nothing dark, mostly the background grey.
   */
  _isPlaceholder(image) {
    const ctx = this._probeCtx;
    ctx.clearRect(0, 0, 8, 8);
    ctx.drawImage(image, 0, 0, 8, 8);
    const d = ctx.getImageData(0, 0, 8, 8).data;
    let background = 0;
    for (let i = 0; i < d.length; i += 4) {
      const chroma = Math.max(Math.abs(d[i] - d[i + 1]), Math.abs(d[i + 1] - d[i + 2]));
      const min = Math.min(d[i], d[i + 1], d[i + 2]);
      const max = Math.max(d[i], d[i + 1], d[i + 2]);
      if (chroma >= 6 || min <= 185) return false; // colour or shadow: real imagery
      if (max < 225) background++;
    }
    return background >= (d.length / 4) * 0.75;
  }

  _texture(image) {
    const texture = new THREE.Texture(image);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false; // tile UVs are measured from the top edge
    texture.anisotropy = this.anisotropy;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    return texture;
  }

  /* ------------------------------------------------------------------ */
  /* Housekeeping                                                        */
  /* ------------------------------------------------------------------ */
  _cancelStale(age) {
    for (const t of this.tiles.values()) {
      if (this.frame - t.lastUsed <= age) continue;
      if (t.imagery.status === 'loading') t.imagery.abort?.();
      if (t.overlay.status === 'loading') t.overlay.abort?.();
    }
    for (const e of this.elevation.values()) {
      if (e.status === 'loading' && this.frame - e.lastUsed > age + 30) e.abort?.();
    }
  }

  _disposeTile(t) {
    t.disposed = true;
    t.imagery.abort?.();
    t.overlay.abort?.();
    if (t.mesh) {
      this.group.remove(t.mesh);
      t.mesh.geometry.dispose();
      t.material.dispose();
    }
    t.imagery.texture?.dispose();
    t.overlay.texture?.dispose();
    this.visible.delete(t);
  }

  /** Least-recently-used eviction of tiles and elevation data. */
  _evict() {
    const limit = this.settings.maxCache;
    if (this.tiles.size > limit) {
      const old = [];
      for (const t of this.tiles.values()) {
        if (t.z > KEEP_ZOOM && this.frame - t.lastUsed > 30) old.push(t);
      }
      old.sort((a, b) => a.lastUsed - b.lastUsed);
      for (const t of old.slice(0, this.tiles.size - limit)) {
        this._disposeTile(t);
        this.tiles.delete(t.key);
      }
    }
    const elevationLimit = 160;
    if (this.elevation.size > elevationLimit) {
      const old = [...this.elevation.values()]
        .filter((e) => e.status !== 'loading' && this.frame - e.lastUsed > 60)
        .sort((a, b) => a.lastUsed - b.lastUsed);
      for (const e of old.slice(0, this.elevation.size - elevationLimit)) this.elevation.delete(e.key);
    }
  }
}
