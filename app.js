/**
 * EARTH 3D — Interactive Planet Explorer
 * ======================================
 * Three.js globe with real geographic data (Natural Earth borders & cities),
 * sun-based day/night lighting, clouds, atmosphere, search and camera fly-to —
 * plus Google-Earth-style deep zoom: streamed satellite imagery, 3D terrain,
 * map labels and a tilting camera.
 *
 * File map
 *   1. Imports & configuration
 *   2. Application state
 *   3. Utilities (formatting, tweens)
 *   4. Loading screen & toasts
 *   5. Renderer, scenes, camera, controls
 *   6. Quality / performance management
 *   7. Asset loading (textures + data) and fallbacks
 *   8. Planet: lighting, earth, clouds, atmosphere, stars, sun, tiles
 *   9. Countries: borders, picking, highlight, labels
 *  10. Cities: markers, picking, selection marker
 *  11. Selection & information panel
 *  12. Camera: fly-to, 3D view & reset
 *  13. Time, sun position & day/night
 *  14. UI: layers, controls, timeline, keyboard, tooltips, HUD
 *  15. Search
 *  16. Pointer interaction
 *  17. Animation loop & resize
 *  18. Boot
 *
 * Other modules
 *   geo.js       coordinates & Web Mercator maths
 *   controls.js  GlobeControls (camera: drag, zoom to cursor, tilt, rotate)
 *   tiles.js     TileEngine (satellite imagery, labels and terrain tiles)
 *   shaders.js   GLSL programs
 *
 * Coordinate system
 *   The Earth (radius 1) sits at the world origin and never rotates: the camera and the
 *   Sun move around it. Longitude 0 points to +X, longitude 90°E to −Z, the North Pole to +Y.
 *   Auto-rotation drifts the camera westwards and advances the simulated clock by the same
 *   angle, so the planet appears to spin eastwards under a fixed Sun — like the real Earth.
 */

/* =====================================================================
   1. IMPORTS & CONFIGURATION
   ===================================================================== */
import * as THREE from 'three';
import { GlobeControls } from './controls.js';
import { TileEngine } from './tiles.js';
import { FlightSystem } from './flight.js';
import * as SHADERS from './shaders.js';
import {
  DEG, TWO_PI, EARTH_RADIUS_M, clamp, lerp, smoothstep, wrap180, wrapPi, latLonToVector3, vector3ToLatLon,
} from './geo.js';

// Tells the boot check in index.html that ES modules loaded correctly.
window.__EARTH3D_STARTED = true;

let flightSystem = null;

const CONFIG = {
  textures: {
    day: 'textures/earth.jpg',
    night: 'textures/night.jpg',
    normal: 'textures/earth-normal.jpg',
    specular: 'textures/earth-specular.jpg',
    clouds: 'textures/clouds.png',
  },
  data: {
    boundaries: 'data/countries.geojson',
    countries: 'data/countries.json',
    cities: 'data/cities.json',
  },

  // High-resolution layers streamed while zooming in. Any XYZ imagery provider and any
  // Terrarium-encoded elevation source can be used: change the URL templates here.
  tiles: {
    imagery: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      maxZoom: 18,
      attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    },
    overlay: {
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      minZoom: 8,
      attribution: 'Labels © Esri',
    },
    terrain: {
      url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
      minZoom: 5,
      maxZoom: 12,
      exaggeration: 1,
      attribution: 'Terrain: Mapzen / AWS Terrain Tiles (SRTM, GMTED2010, ETOPO1)',
    },
  },

  loadTimeoutMs: 20000,
  earthRadius: 1,
  cloudRadius: 1.008,
  atmosphereRadius: 1.1,

  minRange: 1e-4,                         // closest the camera gets to the ground ≈ 640 m
  baseRotationSpeed: TWO_PI / 100,        // rad/s at 1x → one turn every 100 s
  cloudDrift: 0.006,                      // rad/s, clouds slowly drift over the surface
  resumeRotationDelay: 1200,              // ms after the user releases the globe
  view3DTilt: 58 * DEG,                   // camera tilt used by the 3D view

  // Local solar time placed at the centre of the view by Day / Night mode
  introLocalTime: 8.2, // first view: morning side, night lights visible on the left
  dayLocalTime: 10,
  nightLocalTime: 22,
  flyDayLocalTime: 11,
  flyNightLocalTime: 23,

  defaults: {
    earth: true,
    clouds: true,
    borders: true,
    countries: true,
    cities: false,
    nightLights: true,
    atmosphere: true,
    realistic: true,
    terminator: false,
    imagery: true,
    terrain: true,
    mapLabels: true,
  },
};

const QUALITY_PRESETS = {
  high: {
    pixelRatio: 2, stars: 9000, maxTextureSize: 4096, cloudShadow: true, anisotropy: 8, lowFx: false, specular: 0.55,
    tiles: { maxLeaves: 200, segments: 24, sse: 1.0, maxCache: 260, concurrency: 8, buildMs: 5 },
  },
  medium: {
    pixelRatio: 1.5, stars: 6000, maxTextureSize: 4096, cloudShadow: true, anisotropy: 4, lowFx: false, specular: 0.5,
    tiles: { maxLeaves: 150, segments: 20, sse: 1.2, maxCache: 200, concurrency: 6, buildMs: 4 },
  },
  low: {
    pixelRatio: 1, stars: 3000, maxTextureSize: 2048, cloudShadow: false, anisotropy: 1, lowFx: true, specular: 0.4,
    tiles: { maxLeaves: 100, segments: 14, sse: 1.6, maxCache: 140, concurrency: 4, buildMs: 3 },
  },
};

// Uniform values for the two lighting moods (tweened when switching)
const NIGHT_PARAMS = {
  day:   { ambient: 0.016, lights: 1.35, atmo: 1.0 },
  night: { ambient: 0.006, lights: 2.3,  atmo: 0.85 },
};

const CLOUD_OPACITY = 0.95;
const FALLBACK_MESSAGE = 'Some Earth textures could not be loaded. Running in fallback mode.';
const MISSING_DATA_NOTE = 'Feature requires additional geographic dataset';

/* =====================================================================
   2. APPLICATION STATE
   ===================================================================== */
const state = {
  layers: { ...CONFIG.defaults },
  disabledLayers: new Set(),

  autoRotate: true,
  rotationSpeed: 1,
  rotationVelocity: 0,
  userInteracting: false,
  resumeTimer: null,
  flying: false,

  nightMode: false,
  timeHours: 12,      // simulated UTC time of day
  dayOfYear: 1,
  date: new Date(),
  timeLocked: false,  // true once the user picks a time explicitly
  sliderActive: false,

  quality: 'high',
  qualitySetting: 'auto',

  selection: null,    // { type: 'country' | 'city', item }
  hoverCountry: null,
  hoverCity: null,
  pointer: { x: 0, y: 0, inside: false, type: 'mouse', down: null },

  screenshotPending: false,
  fallbackMode: false,
  elapsed: 0,
};

/** Values derived from the camera once per frame. */
const view = {
  range: 3,          // camera distance to the ground point at the centre (Earth radii)
  radiusPx: 400,     // apparent radius of the globe on screen
  focal: 1000,       // focal length in CSS pixels
  zoom: 0,           // equivalent web-map zoom level at the centre of the view
  tileBlend: 0,      // 0 = built-in texture only, 1 = streamed imagery
  mapLabelFade: 0,   // visibility of the streamed map labels
  minFacing: 0.1,    // horizon threshold for labels and picking
};

let renderer, scene, camera, controls, tiles, bgScene, bgCamera;

const world = {
  earthGroup: null,
  earth: null,
  clouds: null,
  atmosphere: null,
  stars: null,
  sunGlow: null,
  terminator: null,
  borders: null,
  borderFade: { value: 1 },
  imageryFade: { value: 1 },
  hoverOutline: null,
  selectOutline: null,
  markers: null,
  pin: null,
  highlight: null,
  sunLight: null,
  ambientLight: null,
  sunDir: new THREE.Vector3(1, 0, 0), // direction to the Sun (shared by every shader)
  hasNightTexture: false,
};

const uniforms = {
  earth: null,
  clouds: null,
  atmosphere: null,
  stars: null,
  markers: null,
  lineFacing: { value: 0.08 },   // horizon fade for lines (shared object)
  markerFacing: { value: 0.22 }, // horizon fade for markers (shared object)
};

const data = {
  countries: [],          // every country (with or without a boundary)
  countriesWithShape: [], // countries that have polygons
  countryByIso: new Map(),
  cities: [],
  searchIndex: [],
  available: { boundaries: false, info: false, cities: false },
};

const dom = {};

/* =====================================================================
   3. UTILITIES
   ===================================================================== */
const Z_AXIS = new THREE.Vector3(0, 0, 1);

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const wrap24 = (h) => ((h % 24) + 24) % 24;
const wrapSigned12 = (h) => wrap24(h + 12) - 12; // → [-12, 12)
const nextTick = () => new Promise((resolve) => setTimeout(resolve, 0));

const fmtInt = new Intl.NumberFormat('en-US');

function formatPopulation(n) {
  if (!n) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} billion`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} million`;
  return fmtInt.format(n);
}
const formatLat = (lat, d = 2) => `${Math.abs(lat).toFixed(d)}° ${lat >= 0 ? 'N' : 'S'}`;
const formatLon = (lon, d = 2) => `${Math.abs(lon).toFixed(d)}° ${lon >= 0 ? 'E' : 'W'}`;

function formatHours(h) {
  const minutes = Math.floor(wrap24(h) * 60 + 1e-6) % 1440;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function formatAltitude(km) {
  if (km >= 1000) return `${fmtInt.format(Math.round(km))} km`;
  if (km >= 10) return `${km.toFixed(0)} km`;
  if (km >= 1) return `${km.toFixed(1)} km`;
  return `${Math.round(km * 1000)} m`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Lower-case, accent-free text for search ("Hà Nội" → "ha noi"). */
function normalizeText(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Small deterministic PRNG so the starfield and procedural clouds are stable. */
function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rnd) {
  let u = 0;
  while (u === 0) u = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * rnd());
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out loading ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/* ---- Minimal tween engine (no external animation library needed) ---- */
const tweens = new Set();

function tween({ duration, ease = easeInOutCubic, onUpdate, onComplete }) {
  const t = { start: performance.now(), duration: Math.max(1, duration * 1000), ease, onUpdate, onComplete };
  t.cancel = () => tweens.delete(t);
  tweens.add(t);
  return t;
}

function updateTweens(now) {
  for (const t of [...tweens]) {
    if (!tweens.has(t)) continue; // cancelled by another tween's callback
    const p = clamp((now - t.start) / t.duration, 0, 1);
    t.onUpdate?.(t.ease(p), p);
    if (p >= 1) {
      tweens.delete(t);
      t.onComplete?.();
    }
  }
}

const uniformTweens = new Map();

/** Smoothly animates `{ value }` (a shader uniform or similar) to `to`. */
function fadeUniform(uniform, to, duration = 0.6, onComplete) {
  if (!uniform) return;
  uniformTweens.get(uniform)?.cancel();
  uniformTweens.delete(uniform);
  const from = uniform.value;
  if (from === to) { onComplete?.(); return; }
  const t = tween({
    duration,
    onUpdate: (e) => { uniform.value = lerp(from, to, e); },
    onComplete: () => { uniformTweens.delete(uniform); onComplete?.(); },
  });
  uniformTweens.set(uniform, t);
}

/* =====================================================================
   4. LOADING SCREEN & TOASTS
   ===================================================================== */
const loadingState = { total: 0, done: 0 };

function setLoadingDetail(text) {
  if (dom.loadingDetail) dom.loadingDetail.textContent = text;
}

function updateProgress() {
  const pct = loadingState.total ? (loadingState.done / loadingState.total) * 90 : 0;
  if (dom.progressBar) dom.progressBar.style.width = `${pct}%`;
}

/** Registers a promise with the progress bar. */
function track(promise, label) {
  loadingState.total++;
  updateProgress();
  return promise.finally(() => {
    loadingState.done++;
    updateProgress();
    setLoadingDetail(`Loaded ${label} (${loadingState.done}/${loadingState.total})`);
  });
}

function finishLoading() {
  dom.progressBar.style.width = '100%';
  dom.loadingText.textContent = 'Ready';
  setTimeout(() => {
    dom.loading.classList.add('hidden');
    document.body.classList.add('ready');
  }, 200);
  setTimeout(() => dom.loading.remove(), 1500);
}

function showFatal(title, detailHtml) {
  const root = document.getElementById('loading');
  if (!root) {
    showToast(title, 'error', 0);
    return;
  }
  root.classList.remove('hidden');
  root.classList.add('error');
  document.getElementById('loading-text').textContent = title;
  document.getElementById('loading-detail').innerHTML = detailHtml;
}

const activeToasts = new Map();

function showToast(message, type = 'info', duration = 4500) {
  if (!dom.toasts || activeToasts.has(message)) return;
  const icons = { info: 'ℹ️', warn: '⚠️', error: '⛔', success: '✅' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = `<span class="t-ico">${icons[type] || icons.info}</span><span>${escapeHtml(message)}</span>`;
  dom.toasts.appendChild(el);
  activeToasts.set(message, el);
  const close = () => {
    if (!activeToasts.has(message)) return;
    activeToasts.delete(message);
    el.classList.add('out');
    setTimeout(() => el.remove(), 300);
  };
  el.addEventListener('click', close);
  if (duration > 0) setTimeout(close, duration);
}

/* =====================================================================
   5. RENDERER, SCENES, CAMERA, CONTROLS
   ===================================================================== */
function initRenderer() {
  renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setClearColor(0x02040a, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.autoClear = false; // background and planet are rendered in two passes
  renderer.setSize(window.innerWidth, window.innerHeight);
  dom.scene.appendChild(renderer.domElement);

  renderer.domElement.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    showToast('The graphics context was lost. Please reload the page.', 'error', 0);
  });
}

function initScene() {
  scene = new THREE.Scene();
  world.earthGroup = new THREE.Group();
  world.earthGroup.name = 'earthGroup';
  scene.add(world.earthGroup);
  // Stars and the Sun glow live in their own scene: the main camera's near/far planes
  // follow the altitude (down to metres), which would clip anything that far away.
  bgScene = new THREE.Scene();
}

function initCamera() {
  const aspect = window.innerWidth / window.innerHeight;
  camera = new THREE.PerspectiveCamera(45, aspect, 0.01, 100);
  bgCamera = new THREE.PerspectiveCamera(45, aspect, 1, 2000);
}

function initControls() {
  controls = new GlobeControls(camera, renderer.domElement);
  controls.minRange = CONFIG.minRange;

  // Pause auto-rotation while the user interacts; resume shortly after. A drag or a
  // wheel turn during a flight hands the camera back to the user immediately.
  controls.addEventListener('start', () => {
    if (flight) cancelFlight();
    state.userInteracting = true;
    clearTimeout(state.resumeTimer);
    if (controls.interacting) renderer.domElement.style.cursor = 'grabbing';
  });
  controls.addEventListener('end', () => {
    clearTimeout(state.resumeTimer);
    state.resumeTimer = setTimeout(() => { state.userInteracting = false; }, CONFIG.resumeRotationDelay);
    renderer.domElement.style.cursor = '';
  });
}

/* =====================================================================
   6. QUALITY / PERFORMANCE MANAGEMENT
   ===================================================================== */
const perf = { frames: 0, last: performance.now(), fps: 60, lowStreak: 0, startedAt: 0 };

const qualityPreset = () => QUALITY_PRESETS[state.quality];

/** Picks a starting quality level from device hints. */
function detectQuality() {
  let gpu = '';
  try {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) gpu = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '');
  } catch { /* the extension is optional */ }
  if (/swiftshader|llvmpipe|software|basic render/i.test(gpu)) return 'low';

  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency || 4;
  const memory = navigator.deviceMemory || 8;
  if (coarse || cores <= 4 || memory <= 4) return 'medium';
  return 'high';
}

function applyPixelRatio() {
  const ratio = Math.min(window.devicePixelRatio || 1, qualityPreset().pixelRatio);
  renderer.setPixelRatio(ratio);
  if (uniforms.stars) uniforms.stars.uPixelRatio.value = ratio;
  if (uniforms.markers) uniforms.markers.uPixelRatio.value = ratio;
}

function applyQuality(level) {
  state.quality = level;
  const q = qualityPreset();
  applyPixelRatio();
  world.stars?.geometry.setDrawRange(0, q.stars);
  if (uniforms.earth) uniforms.earth.uSpecular.value = q.specular;
  tiles?.setSettings(q.tiles);
  document.body.classList.toggle('low-fx', q.lowFx);
  syncQualityUI();
}

function setQualitySetting(setting) {
  state.qualitySetting = setting;
  perf.lowStreak = 0;
  applyQuality(setting === 'auto' ? detectQuality() : setting);
}

function updateFps(now) {
  perf.frames++;
  const elapsed = now - perf.last;
  if (elapsed < 1000) return;
  perf.fps = (perf.frames * 1000) / elapsed;
  perf.frames = 0;
  perf.last = now;
  dom.hudFps.textContent = `${Math.round(perf.fps)} FPS`;
  dom.hudFps.classList.toggle('warn', perf.fps < 30);
  governQuality();
}

/** In "Auto" mode, lowers quality when the frame rate stays low for 3 seconds. */
function governQuality() {
  if (state.qualitySetting !== 'auto' || document.hidden) return;
  if (performance.now() - perf.startedAt < 5000) return; // ignore start-up hitches
  perf.lowStreak = perf.fps < 28 ? perf.lowStreak + 1 : 0;
  if (perf.lowStreak < 3) return;
  perf.lowStreak = 0;
  const next = state.quality === 'high' ? 'medium' : state.quality === 'medium' ? 'low' : null;
  if (next) {
    applyQuality(next);
    showToast(`Low frame rate detected — rendering quality reduced to ${next}.`, 'info', 4000);
  }
}

/* =====================================================================
   7. ASSET LOADING (TEXTURES + DATA) AND FALLBACKS
   ===================================================================== */
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load ${url}`));
    img.src = url;
  });
}

/** Loads an image as a texture, downscaling it when the device/quality limit is lower. */
async function loadTexture(url, { color = true, wrap = false } = {}) {
  const img = await withTimeout(loadImage(url), CONFIG.loadTimeoutMs, url);
  const limit = Math.min(qualityPreset().maxTextureSize, renderer.capabilities.maxTextureSize);
  let source = img;
  if (img.width > limit || img.height > limit) {
    const scale = limit / Math.max(img.width, img.height);
    source = makeCanvas(Math.round(img.width * scale), Math.round(img.height * scale));
    source.getContext('2d').drawImage(img, 0, 0, source.width, source.height);
  }
  const texture = new THREE.Texture(source);
  configureTexture(texture, { color, wrap });
  texture.needsUpdate = true;
  return texture;
}

function configureTexture(texture, { color = true, wrap = false } = {}) {
  texture.colorSpace = color ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.anisotropy = Math.min(qualityPreset().anisotropy, renderer.capabilities.getMaxAnisotropy());
  if (wrap) texture.wrapS = THREE.RepeatWrapping;
  return texture;
}

async function loadAllTextures() {
  const specs = {
    day: { color: true },
    night: { color: true },
    normal: { color: false },
    specular: { color: false },
    clouds: { color: false, wrap: true },
  };
  const jobs = Object.entries(specs).map(([key, options]) =>
    track(
      loadTexture(CONFIG.textures[key], options)
        .then((texture) => [key, texture])
        .catch((error) => {
          console.warn(`[Earth 3D] texture "${key}" unavailable:`, error.message);
          return [key, null];
        }),
      `${key} texture`,
    ),
  );
  return Object.fromEntries(await Promise.all(jobs));
}

async function fetchJSON(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.loadTimeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function fetchOptionalJSON(url, label) {
  return track(
    fetchJSON(url).catch((error) => {
      console.warn(`[Earth 3D] ${label} unavailable (${url}):`, error.message);
      return null;
    }),
    label,
  );
}

async function loadAllData() {
  const [boundaries, info, cities] = await Promise.all([
    fetchOptionalJSON(CONFIG.data.boundaries, 'country boundaries'),
    fetchOptionalJSON(CONFIG.data.countries, 'country information'),
    fetchOptionalJSON(CONFIG.data.cities, 'cities'),
  ]);
  loadCountries(boundaries, info);
  loadCities(cities);
}

/** Builds country records from the GeoJSON boundaries + the info table. */
function loadCountries(geojson, infoJson) {
  const info = infoJson?.countries || {};
  data.available.info = Object.keys(info).length > 0;
  data.available.boundaries = Array.isArray(geojson?.features) && geojson.features.length > 0;

  if (data.available.boundaries) {
    for (const feature of geojson.features) {
      const country = createCountryRecord(feature, info[feature.properties?.iso3]);
      if (!country || data.countryByIso.has(country.iso3)) continue;
      data.countries.push(country);
      data.countriesWithShape.push(country);
      data.countryByIso.set(country.iso3, country);
    }
  }

  // Countries that are too small for the 1:50m map (or all of them if the boundaries failed)
  for (const [iso3, entry] of Object.entries(info)) {
    if (data.countryByIso.has(iso3) || entry.latlng?.length !== 2) continue;
    const country = {
      iso3,
      name: entry.name,
      info: entry,
      polygons: [],
      bbox: null,
      mainBox: null,
      labelLat: entry.latlng[0],
      labelLon: entry.latlng[1],
      labelRank: 99,
    };
    data.countries.push(country);
    data.countryByIso.set(iso3, country);
  }
}

function createCountryRecord(feature, info) {
  const p = feature.properties || {};
  const g = feature.geometry;
  if (!g || !p.iso3) return null;
  const raw = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  const polygons = raw
    .filter((rings) => rings?.[0]?.length >= 4)
    .map((rings) => ({ rings, bbox: ringBBox(rings[0]), area: ringArea(rings[0]) }));
  if (!polygons.length) return null;

  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of polygons) {
    bbox[0] = Math.min(bbox[0], poly.bbox[0]);
    bbox[1] = Math.min(bbox[1], poly.bbox[1]);
    bbox[2] = Math.max(bbox[2], poly.bbox[2]);
    bbox[3] = Math.max(bbox[3], poly.bbox[3]);
  }
  const main = polygons.reduce((a, b) => (b.area > a.area ? b : a));

  return {
    iso3: p.iso3,
    name: info?.name || p.name,
    info: info || null,
    polygons,
    bbox,
    mainBox: main.bbox,
    labelLat: p.labelLat ?? (main.bbox[1] + main.bbox[3]) / 2,
    labelLon: p.labelLon ?? (main.bbox[0] + main.bbox[2]) / 2,
    labelRank: p.labelRank ?? 6,
  };
}

function ringBBox(ring) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lon, lat] of ring) {
    if (lon < box[0]) box[0] = lon;
    if (lat < box[1]) box[1] = lat;
    if (lon > box[2]) box[2] = lon;
    if (lat > box[3]) box[3] = lat;
  }
  return box;
}

/** Approximate area (deg², latitude-corrected) — only used to find a country's mainland. */
function ringArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  const box = ringBBox(ring);
  return Math.abs(sum / 2) * Math.cos(((box[1] + box[3]) / 2) * DEG);
}

function loadCities(json) {
  const list = Array.isArray(json?.cities) ? json.cities : [];
  data.cities = list
    .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon) && c.name)
    .map((c, index) => ({ ...c, index, population: c.population || 0, rank: c.rank ?? 5 }));
  data.available.cities = data.cities.length > 0;
}

/* ---- Fallback textures (generated from the real geographic data) ---- */
function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function canvasTexture(canvas, options) {
  const texture = new THREE.CanvasTexture(canvas);
  return configureTexture(texture, options);
}

function blankTexture() {
  const texture = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  texture.needsUpdate = true;
  return texture;
}

const equirectX = (lon, width) => ((lon + 180) / 360) * width;
const equirectY = (lat, height) => ((90 - lat) / 180) * height;

/** Adds the rings of the given polygons to the current canvas path (equirectangular). */
function tracePolygons(ctx, polygons, width, height) {
  for (const poly of polygons) {
    for (const ring of poly.rings) {
      ring.forEach(([lon, lat], i) => {
        const x = equirectX(lon, width);
        const y = equirectY(lat, height);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.closePath();
    }
  }
}

function traceAllCountries(ctx, width, height) {
  ctx.beginPath();
  for (const country of data.countriesWithShape) tracePolygons(ctx, country.polygons, width, height);
}

function generateLandTexture() {
  const W = 2048;
  const H = 1024;
  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const ocean = ctx.createLinearGradient(0, 0, 0, H);
  ocean.addColorStop(0, '#0c2747');
  ocean.addColorStop(0.5, '#123f73');
  ocean.addColorStop(1, '#0c2747');
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, W, H);

  // Land coloured by climate band (snow, boreal, temperate, arid, tropical)
  const land = ctx.createLinearGradient(0, 0, 0, H);
  const bands = [
    [90, '#e8eef2'], [66, '#dfe6e8'], [60, '#56684a'], [48, '#5a7a43'], [34, '#a8915e'], [22, '#b49b66'],
    [12, '#6f8c3f'], [0, '#2f6a33'], [-12, '#6f8c3f'], [-25, '#ad9562'], [-38, '#5f7d45'], [-52, '#7d8a7a'],
    [-62, '#dfe6e8'], [-90, '#eef3f5'],
  ];
  for (const [lat, colour] of bands) land.addColorStop((90 - lat) / 180, colour);
  ctx.save();
  traceAllCountries(ctx, W, H);
  ctx.clip('evenodd');
  ctx.fillStyle = land;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1;
  traceAllCountries(ctx, W, H);
  ctx.stroke();
  return canvasTexture(canvas, { color: true });
}

function generateOceanTexture() {
  const canvas = makeCanvas(1024, 512);
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, 0, 512);
  gradient.addColorStop(0, '#dfe8ee');
  gradient.addColorStop(0.08, '#14385f');
  gradient.addColorStop(0.5, '#1a4f8a');
  gradient.addColorStop(0.92, '#14385f');
  gradient.addColorStop(1, '#e6eef2');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1024, 512);
  return canvasTexture(canvas, { color: true });
}

function generateWaterMask() {
  const canvas = makeCanvas(1024, 512);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 1024, 512);
  ctx.fillStyle = '#000';
  traceAllCountries(ctx, 1024, 512);
  ctx.fill('evenodd');
  return canvasTexture(canvas, { color: false });
}

/** City glows at their real coordinates, sized by population. */
function generateNightLightsTexture() {
  const W = 2048;
  const H = 1024;
  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';
  for (const city of data.cities) {
    const x = equirectX(city.lon, W);
    const y = equirectY(city.lat, H);
    const r = 1.5 + Math.sqrt(Math.max(city.population, 1e4)) / 650;
    const glow = ctx.createRadialGradient(x, y, 0, x, y, r);
    glow.addColorStop(0, 'rgba(255, 220, 160, 0.95)');
    glow.addColorStop(0.4, 'rgba(255, 180, 100, 0.4)');
    glow.addColorStop(1, 'rgba(255, 160, 80, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  return canvasTexture(canvas, { color: true });
}

/** Procedural (fBm value noise) cloud map that wraps seamlessly around the globe. */
function generateCloudTexture() {
  const W = 512;
  const H = 256;
  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(W, H);
  const rnd = mulberry32(7);
  const octaves = [8, 16, 32, 64, 128].map((cells, i) => ({
    cells,
    rows: cells / 2,
    amp: Math.pow(0.55, i),
    grid: Float32Array.from({ length: cells * (cells / 2 + 1) }, () => rnd()),
  }));
  const smooth = (t) => t * t * (3 - 2 * t);
  const norm = octaves.reduce((sum, o) => sum + o.amp, 0);

  for (let py = 0; py < H; py++) {
    const lat = 90 - ((py + 0.5) / H) * 180;
    // More clouds along the equator (ITCZ) and the mid-latitude storm tracks
    const climate = 0.6 * Math.exp(-((lat / 10) ** 2)) + 0.8 * Math.exp(-(((Math.abs(lat) - 55) / 15) ** 2));
    for (let px = 0; px < W; px++) {
      let v = 0;
      for (const o of octaves) {
        const gx = (px / W) * o.cells;
        const gy = (py / H) * o.rows;
        const x0 = Math.floor(gx);
        const y0 = Math.floor(gy);
        const fx = smooth(gx - x0);
        const fy = smooth(gy - y0);
        const xa = x0 % o.cells;
        const xb = (x0 + 1) % o.cells;
        const ya = Math.min(y0, o.rows);
        const yb = Math.min(y0 + 1, o.rows);
        const top = lerp(o.grid[ya * o.cells + xa], o.grid[ya * o.cells + xb], fx);
        const bottom = lerp(o.grid[yb * o.cells + xa], o.grid[yb * o.cells + xb], fx);
        v += lerp(top, bottom, fy) * o.amp;
      }
      const density = clamp((v / norm - 0.44) * 3.0 + (climate - 0.3) * 0.6, 0, 1);
      const i = (py * W + px) * 4;
      const value = Math.round(Math.pow(density, 1.4) * 255);
      image.data[i] = image.data[i + 1] = image.data[i + 2] = value;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvasTexture(canvas, { color: false, wrap: true });
}

/** Replaces any texture that failed to load. Returns the texture set and fallback flag. */
function resolveTextures(textures) {
  const tex = { ...textures };
  let fallback = false;
  if (!tex.day) {
    tex.day = data.available.boundaries ? generateLandTexture() : generateOceanTexture();
    fallback = true;
  }
  if (!tex.night) {
    tex.night = data.available.cities ? generateNightLightsTexture() : null;
    fallback = true;
  }
  if (!tex.clouds) {
    tex.clouds = generateCloudTexture();
    fallback = true;
  }
  if (!tex.specular) {
    tex.specular = data.available.boundaries ? generateWaterMask() : null;
    fallback = true;
  }
  if (!tex.normal) fallback = true; // relief is simply skipped
  state.fallbackMode = fallback;
  world.hasNightTexture = !!tex.night;
  return tex;
}

/* =====================================================================
   8. PLANET: LIGHTING, EARTH, CLOUDS, ATMOSPHERE, STARS, SUN, TILES
   ===================================================================== */

/**
 * The Sun is a DirectionalLight + a faint AmbientLight. The custom shaders read
 * their direction/intensity every frame, so these lights are the single source
 * of truth for the lighting (and they also light any standard material added later).
 */
function setupLighting() {
  world.sunLight = new THREE.DirectionalLight(0xfff4e6, 1.25);
  world.ambientLight = new THREE.AmbientLight(0x88aaff, 0.04);
  scene.add(world.sunLight, world.ambientLight);
}

function createEarth(tex) {
  const blank = blankTexture();
  const night = NIGHT_PARAMS.day;
  uniforms.earth = {
    uDayMap: { value: tex.day },
    uNightMap: { value: tex.night || blank },
    uNormalMap: { value: tex.normal || blank },
    uSpecMap: { value: tex.specular || blank },
    uCloudMap: { value: tex.clouds || blank },
    uHighlightMap: { value: world.highlight.texture },
    uHasNight: { value: tex.night ? 1 : 0 },
    uHasNormal: { value: tex.normal ? 1 : 0 },
    uHasSpec: { value: tex.specular ? 1 : 0 },
    uHasClouds: { value: tex.clouds ? 1 : 0 },
    uSunDir: { value: world.sunDir },
    uSunIntensity: { value: world.sunLight.intensity },
    uAmbient: { value: world.ambientLight.intensity },
    uRealistic: { value: state.layers.realistic ? 1 : 0 },
    uSurface: { value: state.layers.earth ? 1 : 0 },
    uNightLights: { value: state.layers.nightLights ? 1 : 0 },
    uNightAmbient: { value: night.ambient },
    uLightsGain: { value: night.lights },
    uNormalScale: { value: 1.0 },
    uSpecular: { value: qualityPreset().specular },
    uAtmosphere: { value: state.layers.atmosphere ? 1 : 0 },
    uAtmoColor: { value: new THREE.Color('#5aa9ff') },
    uCloudShadow: { value: 0 },
    uCloudOffset: { value: 0 },
    uHoverColor: { value: new THREE.Color('#bfeaff') },
    uSelectColor: { value: new THREE.Color('#38d0ff') },
    uPulse: { value: 0 },
    uHighlightStrength: { value: 1 },
    uTileBlend: { value: 0 },
    uMapLabels: { value: 0 },
    uLightsFade: { value: 1 },
    uCloseNight: { value: 0 },
    // Flight mode explosions (explosions.js): light on the ground and scorch marks
    uBlastActive: { value: 0 },
    uBlastPos: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) },
    uBlastColor: { value: Array.from({ length: 4 }, () => new THREE.Vector3()) },
    uScorch: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
    uScorchInfo: { value: Array.from({ length: 8 }, () => new THREE.Vector2()) },
  };
  const material = new THREE.ShaderMaterial({
    uniforms: uniforms.earth,
    vertexShader: SHADERS.earthVertex,
    fragmentShader: SHADERS.earthFragment,
    // Satellite tiles are drawn at exactly the same radius: push the base globe slightly back.
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 4,
  });
  world.earth = new THREE.Mesh(new THREE.SphereGeometry(CONFIG.earthRadius, 160, 80), material);
  world.earth.name = 'earth';
  world.earthGroup.add(world.earth);
}

function createClouds(tex) {
  uniforms.clouds = {
    uCloudMap: { value: tex.clouds },
    uSunDir: { value: world.sunDir },
    uRealistic: { value: state.layers.realistic ? 1 : 0 },
    uOpacity: { value: state.layers.clouds ? CLOUD_OPACITY : 0 },
    uRangeFade: { value: 1 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms: uniforms.clouds,
    vertexShader: SHADERS.cloudsVertex,
    fragmentShader: SHADERS.cloudsFragment,
    transparent: true,
    depthWrite: false,
  });
  world.clouds = new THREE.Mesh(new THREE.SphereGeometry(CONFIG.cloudRadius, 128, 64), material);
  world.clouds.name = 'clouds';
  world.clouds.renderOrder = 1;
  world.earthGroup.add(world.clouds);
}

function createAtmosphere() {
  uniforms.atmosphere = {
    uSunDir: { value: world.sunDir },
    uColor: { value: new THREE.Color('#4f9dff') },
    uTwilightColor: { value: new THREE.Color('#ffb36b') },
    uRealistic: { value: state.layers.realistic ? 1 : 0 },
    uIntensity: { value: NIGHT_PARAMS.day.atmo },
    uVisible: { value: state.layers.atmosphere ? 1 : 0 },
    uShellRadius: { value: CONFIG.atmosphereRadius },
  };
  const material = new THREE.ShaderMaterial({
    uniforms: uniforms.atmosphere,
    vertexShader: SHADERS.atmosphereVertex,
    fragmentShader: SHADERS.atmosphereFragment,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  world.atmosphere = new THREE.Mesh(new THREE.SphereGeometry(CONFIG.atmosphereRadius, 96, 48), material);
  world.atmosphere.name = 'atmosphere';
  world.atmosphere.renderOrder = 6;
  scene.add(world.atmosphere);
}

/** Thousands of stars in a single THREE.Points draw call, with a faint Milky Way band. */
function createStars() {
  const count = QUALITY_PRESETS.high.stars;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const phases = new Float32Array(count);
  const rnd = mulberry32(20261007);
  const bandTilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(1.05, 0.3, 0.45));
  const v = new THREE.Vector3();
  const tints = [[0.68, 0.8, 1], [1, 1, 1], [1, 0.9, 0.76], [1, 0.72, 0.52]];

  for (let i = 0; i < count; i++) {
    const inBand = rnd() < 0.3;
    if (inBand) {
      const a = rnd() * TWO_PI;
      v.set(Math.cos(a), gaussian(rnd) * 0.09, Math.sin(a)).normalize().applyQuaternion(bandTilt);
    } else {
      const u = rnd() * 2 - 1;
      const t = rnd() * TWO_PI;
      const s = Math.sqrt(1 - u * u);
      v.set(s * Math.cos(t), u, s * Math.sin(t));
    }
    v.multiplyScalar(300 + rnd() * 200);
    positions.set([v.x, v.y, v.z], i * 3);

    const r = rnd();
    const tint = tints[r < 0.12 ? 0 : r < 0.72 ? 1 : r < 0.93 ? 2 : 3];
    const brightness = inBand ? 0.25 + rnd() * 0.5 : 0.35 + rnd() * 0.65;
    colors.set([tint[0] * brightness, tint[1] * brightness, tint[2] * brightness], i * 3);
    sizes[i] = (inBand ? 0.7 : 0.9) + Math.pow(rnd(), 7) * 3.2;
    phases[i] = rnd();
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geometry.setDrawRange(0, qualityPreset().stars);

  uniforms.stars = { uTime: { value: 0 }, uPixelRatio: { value: renderer.getPixelRatio() } };
  const material = new THREE.ShaderMaterial({
    uniforms: uniforms.stars,
    vertexShader: SHADERS.starsVertex,
    fragmentShader: SHADERS.starsFragment,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  world.stars = new THREE.Points(geometry, material);
  world.stars.frustumCulled = false;
  bgScene.add(world.stars);
}

/** A soft glow far away in the Sun's direction (visible behind the limb in night view). */
function createSunGlow() {
  const canvas = makeCanvas(256, 256);
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0, 'rgba(255, 253, 245, 1)');
  g.addColorStop(0.06, 'rgba(255, 244, 220, 0.95)');
  g.addColorStop(0.2, 'rgba(255, 214, 160, 0.35)');
  g.addColorStop(0.5, 'rgba(255, 190, 130, 0.08)');
  g.addColorStop(1, 'rgba(255, 180, 120, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  world.sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  world.sunGlow.scale.set(70, 70, 1);
  bgScene.add(world.sunGlow);
}

/** Material for lines drawn on the globe: always on top of the terrain, culled at the horizon. */
function lineMaterial(color, opacity) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
      uFacingFade: uniforms.lineFacing,
    },
    vertexShader: SHADERS.overlayLineVertex,
    fragmentShader: SHADERS.overlayLineFragment,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
}

/** Day/night boundary: a great circle perpendicular to the Sun direction. */
function createTerminator() {
  const points = [];
  for (let i = 0; i <= 512; i++) {
    const a = (i / 512) * TWO_PI;
    points.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0));
  }
  world.terminator = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), lineMaterial('#ffb35c', 0.8));
  world.terminator.renderOrder = 3;
  world.terminator.frustumCulled = false;
  scene.add(world.terminator);
  updateTerminatorVisibility();
}

function updateTerminatorVisibility() {
  if (world.terminator) world.terminator.visible = state.layers.terminator && state.layers.realistic;
}

/** Streams satellite imagery, map labels and terrain when the camera comes close. */
function createTiles() {
  tiles = new TileEngine({
    parent: world.earthGroup,
    uniforms: uniforms.earth,
    vertexShader: SHADERS.earthVertex,
    fragmentShader: SHADERS.earthFragment,
    sources: CONFIG.tiles,
    settings: qualityPreset().tiles,
    anisotropy: Math.min(qualityPreset().anisotropy, renderer.capabilities.getMaxAnisotropy()),
    onStatus: (status) => {
      if (status === 'unavailable') {
        showToast('High-resolution imagery could not be loaded (offline?). Showing the built-in Earth texture.', 'warn', 8000);
      }
    },
  });
  tiles.setOptions({ terrain: state.layers.terrain, overlay: state.layers.mapLabels });
  controls.getHeight = (lat, lon) => tiles.getHeight(lat, lon);
}

/* =====================================================================
   9. COUNTRIES: BORDERS, PICKING, HIGHLIGHT, LABELS
   ===================================================================== */
const _segA = new THREE.Vector3();
const _segB = new THREE.Vector3();

/**
 * Converts a lon/lat ring into line-segment vertices on the sphere.
 * Long segments are subdivided so they follow the curvature instead of cutting through it.
 */
function pushRingSegments(ring, out) {
  for (let i = 0; i < ring.length - 1; i++) {
    const [lon1, lat1] = ring[i];
    const [lon2, lat2] = ring[i + 1];
    if (Math.abs(lon1) >= 179.99 && Math.abs(lon2) >= 179.99) continue; // artificial antimeridian cut
    if (lat1 <= -89.9 && lat2 <= -89.9) continue;                        // artificial south-pole edge
    if (Math.abs(lon2 - lon1) > 180) continue;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(lon2 - lon1), Math.abs(lat2 - lat1)) / 0.5));
    latLonToVector3(lat1, lon1, 1, _segA);
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      latLonToVector3(lerp(lat1, lat2, t), lerp(lon1, lon2, t), 1, _segB);
      out.push(_segA.x, _segA.y, _segA.z, _segB.x, _segB.y, _segB.z);
      _segA.copy(_segB);
    }
  }
}

/** All country borders as one LineSegments object (a single draw call). */
function buildBorders() {
  const positions = [];
  for (const country of data.countriesWithShape) {
    for (const poly of country.polygons) {
      for (const ring of poly.rings) pushRingSegments(ring, positions);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  world.borders = new THREE.LineSegments(geometry, lineMaterial('#a8dcff', 0.5));
  world.borders.name = 'borders';
  world.borders.renderOrder = 2;
  world.borders.frustumCulled = false;
  world.borderFade.value = state.layers.borders ? 1 : 0;
  world.earthGroup.add(world.borders);

  const outline = (color, opacity) => {
    const line = new THREE.LineSegments(new THREE.BufferGeometry(), lineMaterial(color, opacity));
    line.renderOrder = 3;
    line.frustumCulled = false;
    line.visible = false;
    world.earthGroup.add(line);
    return line;
  };
  world.hoverOutline = outline('#ffffff', 0.7);
  world.selectOutline = outline('#5fe1ff', 1);
}

function setOutline(line, country) {
  if (!line) return;
  line.geometry.dispose();
  line.geometry = new THREE.BufferGeometry();
  if (country?.polygons.length) {
    const positions = [];
    for (const poly of country.polygons) {
      for (const ring of poly.rings) pushRingSegments(ring, positions);
    }
    line.geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    line.visible = true;
  } else {
    line.visible = false;
  }
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Finds the country containing a geographic point (bounding-box filter + point-in-polygon). */
function countryAt(lat, lon) {
  for (const country of data.countriesWithShape) {
    const b = country.bbox;
    if (lon < b[0] || lon > b[2] || lat < b[1] || lat > b[3]) continue;
    for (const poly of country.polygons) {
      const pb = poly.bbox;
      if (lon < pb[0] || lon > pb[2] || lat < pb[1] || lat > pb[3]) continue;
      if (!pointInRing(lon, lat, poly.rings[0])) continue;
      let inHole = false;
      for (let r = 1; r < poly.rings.length && !inHole; r++) inHole = pointInRing(lon, lat, poly.rings[r]);
      if (!inHole) return country;
    }
  }
  return null;
}

/**
 * Hover/selection fill: country shapes are painted into an equirectangular mask
 * (red = hover, green = selected) that the Earth shader samples with the same UVs.
 */
function createHighlightLayer() {
  const size = state.quality === 'high' ? 2048 : 1024;
  const canvas = makeCanvas(size, size / 2);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.NoColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  world.highlight = { canvas, ctx, texture };
}

function redrawHighlight() {
  const h = world.highlight;
  if (!h) return;
  const { ctx, canvas } = h;
  const W = canvas.width;
  const H = canvas.height;
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'lighter';
  const selected = selectedCountry();
  const paint = (country, colour) => {
    if (!country?.polygons.length) return;
    ctx.fillStyle = colour;
    ctx.beginPath();
    tracePolygons(ctx, country.polygons, W, H);
    ctx.fill('evenodd');
  };
  paint(selected, '#00ff00');
  if (state.hoverCountry !== selected) paint(state.hoverCountry, '#ff0000');
  h.texture.needsUpdate = true;
}

/* ---- HTML labels projected from the globe ---- */
const labels = { items: [], candidates: [], boxes: [], uiRects: [] };
const _lw = new THREE.Vector3();
const _ln = new THREE.Vector3();
const _lv = new THREE.Vector3();

function addLabel({ kind, text, lat, lon, rank, priority, ref, extraClass = '' }) {
  labels.items.push({
    kind, text, rank, priority, ref, extraClass,
    position: latLonToVector3(lat, lon, 1),
    el: null, w: 0, h: 0, sx: 0, sy: 0, alpha: 0,
    visible: false, selected: false,
  });
}

/** Label elements are created lazily, the first time they need to be shown. */
function ensureLabelEl(item) {
  if (item.el) return item.el;
  const el = document.createElement('div');
  el.className = `label label-${item.kind} ${item.extraClass}`.trim();
  if (item.selected) el.classList.add('selected');
  el.textContent = item.text;
  dom.labels.appendChild(el);
  item.el = el;
  item.w = el.offsetWidth;
  item.h = el.offsetHeight;
  return el;
}

function createCountryLabels() {
  for (const c of data.countries) {
    addLabel({
      kind: 'country', text: c.name, lat: c.labelLat, lon: c.labelLon,
      rank: c.polygons.length ? c.labelRank : 99, priority: c.labelRank, ref: c,
    });
  }
}

function createCityLabels() {
  for (const city of data.cities) {
    const capital = city.capital === 'national';
    addLabel({
      kind: 'city', text: city.name, lat: city.lat, lon: city.lon, rank: city.rank,
      priority: city.rank + 1.5 - (capital ? 1 : 0), ref: city, extraClass: capital ? 'capital' : '',
    });
  }
}

// Label / marker density depends on how large the globe appears on screen (radius in px).
const countryLabelRank = (r) => (r < 420 ? 2 : r < 650 ? 3 : r < 950 ? 4 : r < 1400 ? 5 : r < 2200 ? 7 : 10);
const cityLabelRank = (r) => (r < 420 ? 0 : r < 650 ? 1 : r < 950 ? 2 : r < 1400 ? 3 : 4);
const cityMarkerRank = (r) => (r < 420 ? 1 : r < 650 ? 2 : r < 950 ? 3 : r < 1400 ? 4 : 10);

function showLabel(item, x, y) {
  item.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`;
  const opacity = item.alpha.toFixed(2);
  if (item.el.style.opacity !== opacity) item.el.style.opacity = opacity;
  item.visible = true;
}

function hideLabel(item) {
  if (!item.visible) return;
  item.visible = false;
  item.el.style.opacity = '0';
}

/** Screen areas covered by UI (labels are not drawn underneath panels). Refreshed a few times per second. */
function refreshUiRects() {
  const rects = labels.uiRects;
  rects.length = 0;
  for (const el of document.querySelectorAll('.brand, .search, .panel, .control-bar, .hud, .fab, .compass.show, .attribution.show')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < window.innerHeight) {
      rects.push([r.left - 4, r.top - 4, r.right + 4, r.bottom + 4]);
    }
  }
}

const overlapsAny = (x0, y0, x1, y1, rects) => rects.some((b) => x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1]);

/** Projects labels to the screen, hides those beyond the horizon and resolves overlaps. */
function updateLabels(globeRadiusPx) {
  if (!labels.items.length) return;
  const W = window.innerWidth;
  const H = window.innerHeight;
  // Close to the ground the streamed map labels take over (only the selection keeps its label)
  const streamedLabels = view.mapLabelFade > 0.5;
  const showCountries = state.layers.countries && data.available.boundaries && !streamedLabels;
  const showCities = state.layers.cities && !streamedLabels;
  const maxCountryRank = countryLabelRank(globeRadiusPx);
  const maxCityRank = cityLabelRank(globeRadiusPx);
  const minFacing = view.minFacing;
  const candidates = labels.candidates;
  candidates.length = 0;

  for (const item of labels.items) {
    const wanted = item.selected || (item.kind === 'country'
      ? showCountries && item.rank <= maxCountryRank
      : showCities && item.rank <= maxCityRank);
    if (!wanted) { hideLabel(item); continue; }

    _lw.copy(item.position);
    _ln.copy(_lw).normalize();
    _lv.copy(camera.position).sub(_lw).normalize();
    const facing = _ln.dot(_lv);
    if (facing < minFacing) { hideLabel(item); continue; }

    _lv.copy(_lw).project(camera);
    if (_lv.z > 1 || Math.abs(_lv.x) > 1.2 || Math.abs(_lv.y) > 1.2) { hideLabel(item); continue; }
    item.sx = (_lv.x + 1) * 0.5 * W;
    item.sy = (1 - _lv.y) * 0.5 * H;
    item.alpha = Math.min(1, (facing - minFacing) / (minFacing * 2.5));
    candidates.push(item);
  }

  candidates.sort((a, b) => (a.selected ? -1000 : a.priority) - (b.selected ? -1000 : b.priority));
  const boxes = labels.boxes;
  boxes.length = 0;
  for (const item of candidates) {
    ensureLabelEl(item);
    const cx = item.kind === 'city' ? item.sx + item.w / 2 + 9 : item.sx; // city names sit right of the marker
    const x0 = cx - item.w / 2 - 4;
    const x1 = cx + item.w / 2 + 4;
    const y0 = item.sy - item.h / 2 - 2;
    const y1 = item.sy + item.h / 2 + 2;
    const hidden = x0 < 0 || x1 > W || y0 < 0 || y1 > H              // clipped by the screen edge
      || overlapsAny(x0, y0, x1, y1, labels.uiRects)                  // under a panel
      || (!item.selected && overlapsAny(x0, y0, x1, y1, boxes));      // collides with a more important label
    if (hidden) { hideLabel(item); continue; }
    boxes.push([x0, y0, x1, y1]);
    showLabel(item, cx, item.sy);
  }
}

/* =====================================================================
   10. CITIES: MARKERS, PICKING, SELECTION MARKER
   ===================================================================== */

/** Every city marker in one THREE.Points object; visibility per zoom level is decided in the shader. */
function createCityMarkers() {
  const n = data.cities.length;
  const positions = new Float32Array(n * 3);
  const ranks = new Float32Array(n);
  const sizes = new Float32Array(n);
  const indices = new Float32Array(n);
  const colors = new Float32Array(n * 3);
  const gold = new THREE.Color('#ffcf6b');
  const cyan = new THREE.Color('#5fd8ff');
  const white = new THREE.Color('#d9ecff');

  data.cities.forEach((city, i) => {
    city.position = latLonToVector3(city.lat, city.lon, 1);
    positions.set([city.position.x, city.position.y, city.position.z], i * 3);
    ranks[i] = city.rank;
    indices[i] = i;
    const popScale = clamp((Math.log10(Math.max(city.population, 1e4)) - 4) / 3.5, 0, 1);
    sizes[i] = city.capital === 'national' ? 9.5 : 5.5 + popScale * 3.5;
    const c = city.capital === 'national' ? gold : city.capital ? cyan : white; // regional / alternate → cyan
    colors.set([c.r, c.g, c.b], i * 3);
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aRank', new THREE.BufferAttribute(ranks, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
  geometry.setAttribute('aIndex', new THREE.BufferAttribute(indices, 1));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));

  uniforms.markers = {
    uMaxRank: { value: -1 },
    uSelected: { value: -1 },
    uHovered: { value: -1 },
    uPixelRatio: { value: renderer.getPixelRatio() },
    uScale: { value: 1 },
    uSelectedColor: { value: new THREE.Color('#ffd27a') },
    uHoverColor: { value: new THREE.Color('#ffffff') },
    uFacingFade: uniforms.markerFacing,
  };
  world.markers = new THREE.Points(geometry, new THREE.ShaderMaterial({
    uniforms: uniforms.markers,
    vertexShader: SHADERS.markersVertex,
    fragmentShader: SHADERS.markersFragment,
    transparent: true,
    depthTest: false, // drawn over the terrain; the horizon is handled in the shader
    depthWrite: false,
  }));
  world.markers.name = 'cities';
  world.markers.renderOrder = 4;
  world.markers.frustumCulled = false;
  world.earthGroup.add(world.markers);
  updateMarkersVisibility();
}

function updateMarkersVisibility() {
  if (world.markers) world.markers.visible = state.layers.cities || !!selectedCity();
}

const _pw = new THREE.Vector3();
const _pv = new THREE.Vector3();

/** Nearest visible city marker under the screen point (within a few pixels). */
function pickCity(x, y, globeRadiusPx) {
  if (!world.markers || !state.layers.cities) return null;
  const maxRank = cityMarkerRank(globeRadiusPx);
  const W = window.innerWidth;
  const H = window.innerHeight;
  let best = null;
  let bestDist = Infinity;
  for (const city of data.cities) {
    if (city.rank > maxRank) continue;
    _pw.copy(city.position);
    _pv.copy(camera.position).sub(_pw);
    if (_pv.dot(_pw) < view.minFacing * _pv.length() * _pw.length()) continue; // beyond the horizon
    _pw.project(camera);
    const d = Math.hypot((_pw.x + 1) * 0.5 * W - x, (1 - _pw.y) * 0.5 * H - y);
    if (d < bestDist) { bestDist = d; best = city; }
  }
  const radius = state.pointer.type === 'touch' ? 20 : 11;
  return bestDist <= radius ? best : null;
}

/** Pulsing ring that marks the selected city (or a country too small for the map). */
function createSelectionMarker() {
  const group = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({
    color: 0xffd27a, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false,
    side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.78, 1, 64), material);
  const pulse = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 64), material.clone());
  ring.renderOrder = pulse.renderOrder = 5;
  group.add(ring, pulse);
  group.visible = false;
  world.earthGroup.add(group);
  world.pin = { group, pulse, t: 0, active: false, lat: 0, lon: 0 };
}

function placeSelectionMarker(lat, lon) {
  const pin = world.pin;
  pin.lat = lat;
  pin.lon = lon;
  pin.active = true;
  pin.group.quaternion.setFromUnitVectors(Z_AXIS, latLonToVector3(lat, lon, 1));
}

function updateSelectionMarker(dt) {
  const pin = world.pin;
  if (!pin) return;
  if (!pin.active) {
    pin.group.visible = false;
    return;
  }
  // Sits on the terrain; hidden when it is beyond the horizon (it is drawn without depth test)
  const height = tiles ? tiles.getHeight(pin.lat, pin.lon) : 0;
  latLonToVector3(pin.lat, pin.lon, 1 + height + 1e-6, pin.group.position);
  _pv.copy(camera.position).sub(pin.group.position);
  pin.group.visible = _pv.dot(pin.group.position) > 0;
  pin.t = (pin.t + dt * 0.8) % 1;
  pin.group.scale.setScalar(clamp(controls.range * 0.03, 1e-6, 0.06));
  pin.pulse.scale.setScalar(1 + pin.t * 1.8);
  pin.pulse.material.opacity = (1 - pin.t) * 0.8;
}

/* =====================================================================
   11. SELECTION & INFORMATION PANEL
   ===================================================================== */
const selectedCountry = () => (state.selection?.type === 'country' ? state.selection.item : null);
const selectedCity = () => (state.selection?.type === 'city' ? state.selection.item : null);

function selectCountry(country, { fly = true, gentle = false } = {}) {
  if (!country) { clearSelection(); return; }
  state.selection = { type: 'country', item: country };
  updateSelectionVisuals();
  renderInfoPanel();
  if (fly) flyToCountry(country, { gentle });
}

function selectCity(city, { fly = true } = {}) {
  if (!city) { clearSelection(); return; }
  state.selection = { type: 'city', item: city };
  updateSelectionVisuals();
  renderInfoPanel();
  if (fly) flyToCity(city);
}

function clearSelection() {
  if (!state.selection) return;
  state.selection = null;
  updateSelectionVisuals();
  renderInfoPanel();
}

function updateSelectionVisuals() {
  const country = selectedCountry();
  const city = selectedCity();

  redrawHighlight();
  setOutline(world.selectOutline, country);
  if (state.hoverCountry === country) setOutline(world.hoverOutline, null);
  if (uniforms.markers) uniforms.markers.uSelected.value = city ? city.index : -1;

  if (world.pin) {
    if (city) placeSelectionMarker(city.lat, city.lon);
    else if (country && !country.polygons.length) placeSelectionMarker(country.labelLat, country.labelLon);
    else world.pin.active = false;
  }
  updateMarkersVisibility();

  for (const item of labels.items) {
    const selected = !!state.selection && item.ref === state.selection.item;
    if (selected === item.selected) continue;
    item.selected = selected;
    if (item.el) {
      item.el.classList.toggle('selected', selected);
      item.w = item.el.offsetWidth;
      item.h = item.el.offsetHeight;
    }
  }
  document.body.classList.toggle('has-selection', !!state.selection);
}

function findCity(name, iso3) {
  const key = normalizeText(name);
  return data.cities.find((c) => c.iso3 === iso3 && (normalizeText(c.name) === key || normalizeText(c.ascii) === key)) || null;
}

const infoRow = (label, value, className = '') => `<div class="info-row ${className}"><dt>${label}</dt><dd>${value}</dd></div>`;
const NOT_AVAILABLE = '<span class="na">Not in local dataset</span>';

function countryInfoHTML(country) {
  const i = country.info || {};
  const capitals = (i.capital || [])
    .map((name) => {
      const city = findCity(name, country.iso3);
      return city
        ? `<button type="button" class="link-btn" data-action="select-city" data-index="${city.index}">${escapeHtml(name)}</button>`
        : escapeHtml(name);
    })
    .join(', ');
  const population = i.population
    ? `${formatPopulation(i.population)} <span class="muted">(${fmtInt.format(i.population)} · ${escapeHtml(i.populationYear)}, ${escapeHtml(i.populationSource)})</span>`
    : NOT_AVAILABLE;
  const area = i.area ? `${fmtInt.format(Math.round(i.area))} km²` : NOT_AVAILABLE;
  const continent = i.continent
    ? `${escapeHtml(i.continent)}${i.subregion ? ` <span class="muted">· ${escapeHtml(i.subregion)}</span>` : ''}`
    : NOT_AVAILABLE;
  const languages = i.languages?.length ? escapeHtml(i.languages.join(', ')) : NOT_AVAILABLE;
  const currency = i.currencies?.length
    ? i.currencies
        .map((c) => `${escapeHtml(c.name)} <span class="muted">(${escapeHtml([c.symbol, c.code].filter(Boolean).join(' '))})</span>`)
        .join('<br>')
    : NOT_AVAILABLE;
  const [lat, lon] = i.latlng?.length === 2 ? i.latlng : [country.labelLat, country.labelLon];
  const codes = [i.cca2, country.iso3].filter(Boolean).join(' / ');
  const missingMeta = !i.capital?.length && !i.languages?.length && !i.currencies?.length;

  return `
    <div class="info-head">
      <div class="info-flag flag">${escapeHtml(i.flag || '🏳️')}</div>
      <div class="info-title">
        <div class="info-kind">Country${i.nameVi ? ` · ${escapeHtml(i.nameVi)}` : ''}</div>
        <h2>${escapeHtml(country.name)}</h2>
        ${i.official && i.official !== country.name ? `<p>${escapeHtml(i.official)}</p>` : ''}
      </div>
      <button type="button" class="icon-btn info-close" data-action="close" aria-label="Close">×</button>
    </div>
    <dl class="info-rows">
      ${infoRow('Capital', capitals || NOT_AVAILABLE)}
      ${infoRow('Population', population)}
      ${infoRow('Area', area)}
      ${infoRow('Continent', continent)}
      ${infoRow('Languages', languages)}
      ${infoRow('Currency', currency)}
      ${infoRow('Coordinates', `<span class="mono">${formatLat(lat)}, ${formatLon(lon)}</span>`)}
      ${infoRow('ISO code', `<span class="mono">${escapeHtml(codes)}</span>`)}
    </dl>
    ${missingMeta ? `<p class="info-note">${MISSING_DATA_NOTE}: capital, language and currency for this territory are not part of the local dataset.</p>` : ''}
    ${country.polygons.length ? '' : '<p class="info-note">This country is too small for the 1:50m boundary map — it is shown with a marker at its official coordinates.</p>'}
    <div class="info-actions">
      <button type="button" class="btn" data-action="fly">◎ Fly here</button>
      <button type="button" class="btn secondary" data-action="close">Close</button>
    </div>
    <p class="info-source">Sources: Natural Earth (borders) · mledoze/countries (capital, area, languages, currency) · World Bank (population)</p>`;
}

function cityInfoHTML(city) {
  const country = data.countryByIso.get(city.iso3);
  const flag = country?.info?.flag || '';
  const kinds = { national: 'National capital', alternate: 'Alternate capital', regional: 'Regional capital' };
  const kind = kinds[city.capital] || 'City';
  const countryHtml = country
    ? `<button type="button" class="link-btn" data-action="select-country" data-iso="${escapeHtml(city.iso3)}"><span class="flag">${escapeHtml(flag)}</span> ${escapeHtml(city.country)}</button>`
    : escapeHtml(city.country);

  return `
    <div class="info-head">
      <div class="info-flag">${city.capital === 'national' ? '★' : '📍'}</div>
      <div class="info-title">
        <div class="info-kind">${kind}</div>
        <h2>${escapeHtml(city.name)}</h2>
        <p>${escapeHtml(city.country)}</p>
      </div>
      <button type="button" class="icon-btn info-close" data-action="close" aria-label="Close">×</button>
    </div>
    <dl class="info-rows">
      ${infoRow('City name', escapeHtml(city.name), 'repeat-of-title')}
      ${infoRow('Country', countryHtml)}
      ${infoRow('Latitude', `<span class="mono">${formatLat(city.lat, 4)}</span>`)}
      ${infoRow('Longitude', `<span class="mono">${formatLon(city.lon, 4)}</span>`)}
      ${infoRow('Population', city.population ? `${fmtInt.format(city.population)} <span class="muted">(metro estimate)</span>` : NOT_AVAILABLE)}
      ${infoRow('Solar time', '<span class="mono" id="live-solar">--:--</span> <span class="muted">(simulated clock)</span>')}
      ${infoRow('Sunlight', '<span id="live-sun">—</span>')}
    </dl>
    <div class="info-actions">
      <button type="button" class="btn" data-action="fly">◎ Fly here</button>
      <button type="button" class="btn" data-action="view3d" data-tooltip="Tilted close-up with 3D terrain">🏔 3D view</button>
      <button type="button" class="btn secondary" data-action="close">Close</button>
    </div>
    <p class="info-source">Source: Natural Earth 1:50m populated places</p>`;
}

function renderInfoPanel() {
  const selection = state.selection;
  dom.infoEmpty.hidden = !!selection;
  dom.infoContent.hidden = !selection;
  if (!selection) {
    dom.infoContent.innerHTML = '';
    updateViewShiftTarget();
    return;
  }
  dom.infoContent.innerHTML = selection.type === 'country' ? countryInfoHTML(selection.item) : cityInfoHTML(selection.item);
  dom.infoContent.scrollTop = 0;
  // restart the entrance animation
  dom.infoContent.style.animation = 'none';
  void dom.infoContent.offsetWidth;
  dom.infoContent.style.animation = '';
  updateInfoLive();
  updateViewShiftTarget();
}

/** Values in the panel that change with the simulated clock. */
function updateInfoLive() {
  const city = selectedCity();
  if (!city) return;
  const solar = document.getElementById('live-solar');
  const sun = document.getElementById('live-sun');
  if (!solar || !sun) return;
  solar.textContent = formatHours(localSolarTime(city.lon));
  const elevation = sunElevationAt(city.lat, city.lon);
  const deg = Math.abs(elevation).toFixed(0);
  sun.textContent = elevation > 0
    ? `☀ Daylight — Sun ${deg}° above horizon`
    : elevation > -6
      ? `🌅 Twilight — Sun ${deg}° below horizon`
      : `🌙 Night — Sun ${deg}° below horizon`;
}

function onInfoAction(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const selection = state.selection;
  switch (button.dataset.action) {
    case 'close':
      clearSelection();
      break;
    case 'fly':
      if (selection?.type === 'country') flyToCountry(selection.item);
      else if (selection?.type === 'city') flyToCity(selection.item, { range: cityRange() });
      break;
    case 'view3d':
      if (selection?.type === 'city') {
        flyToLocation(selection.item.lat, selection.item.lon, {
          range: 0.012 * viewportFactor(),
          tilt: CONFIG.view3DTilt,
          heading: controls.heading,
        });
      }
      break;
    case 'select-city':
      selectCity(data.cities[Number(button.dataset.index)]);
      break;
    case 'select-country':
      selectCountry(data.countryByIso.get(button.dataset.iso));
      break;
    default:
      break;
  }
}

/* =====================================================================
   12. CAMERA: FLY-TO, 3D VIEW & RESET
   ===================================================================== */
let flight = null;

/** Camera distance (from the centre) at which the whole globe fits the viewport comfortably. */
function fitDistance() {
  const aspect = window.innerWidth / window.innerHeight;
  const vFov = camera.fov * DEG;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const fov = Math.min(vFov, hFov);
  const fill = aspect < 1 ? 0.86 : 0.72; // share of the smaller side covered by the globe
  return clamp(1 / Math.sin((fov / 2) * fill), 2.4, 9);
}

const fitRange = () => fitDistance() - 1;
/** Scales close-up ranges for narrow (portrait) viewports. */
const viewportFactor = () => clamp(fitDistance() / 3.6, 0.8, 2);
const cityRange = () => 0.0075 * viewportFactor();
const is3D = () => controls.tilt > 0.15;

function countryRange(country) {
  const b = country.mainBox;
  if (!b) return 0.75 * viewportFactor();
  const midLat = (b[1] + b[3]) / 2;
  const extent = Math.max(b[3] - b[1], (b[2] - b[0]) * Math.cos(midLat * DEG)); // degrees
  return clamp((0.38 + extent * 0.022) * viewportFactor(), 0.45, 3);
}

function cancelFlight() {
  flight?.cancel();
  flight = null;
  state.flying = false;
}

/**
 * Animated flight to a camera pose { lat, lon, range, heading, tilt }.
 *  - travels along the great circle and rises in the middle of long flights
 *  - when zooming in, it moves first and descends last (the reverse when zooming out)
 *  - 1 to 2.2 seconds, depending on distance and zoom change
 */
function flyTo(target, { duration, onComplete } = {}) {
  cancelFlight();
  controls.stop();
  const start = controls.getPose();
  const end = { heading: 0, tilt: 0, ...target };
  end.range = clamp(end.range, controls.minRange, controls.maxRange);

  const u0 = latLonToVector3(start.lat, start.lon, 1);
  const u1 = latLonToVector3(end.lat, end.lon, 1);
  const angle = u0.angleTo(u1);
  const hop = Math.max(0, Math.min(2.4, angle * 1.15) - Math.max(start.range, end.range));
  const zoomChange = Math.abs(Math.log(end.range / start.range));
  const dur = duration ?? clamp(1.0 + (angle / Math.PI) * 0.7 + zoomChange * 0.07, 1.0, 2.2);
  const q = new THREE.Quaternion().setFromUnitVectors(u0, u1);
  const qi = new THREE.Quaternion();
  const u = new THREE.Vector3();
  const dHeading = wrapPi(end.heading - start.heading);
  const zoomingIn = end.range < start.range;
  const logR0 = Math.log(start.range);
  const logR1 = Math.log(end.range);

  state.flying = true;
  flight = tween({
    duration: dur,
    ease: (t) => t, // each channel is eased separately below
    onUpdate: (_, p) => {
      const e = easeInOutCubic(p);
      const pMove = zoomingIn ? clamp(p / 0.8, 0, 1) : clamp((p - 0.2) / 0.8, 0, 1);
      qi.identity().slerp(q, easeInOutCubic(pMove));
      u.copy(u0).applyQuaternion(qi);
      const ll = vector3ToLatLon(u);
      controls.setPose({
        lat: ll.lat,
        lon: ll.lon,
        range: Math.exp(lerp(logR0, logR1, e)) + hop * Math.sin(Math.PI * p),
        heading: start.heading + dHeading * e,
        tilt: lerp(start.tilt, end.tilt, e),
      });
    },
    onComplete: () => {
      flight = null;
      state.flying = false;
      onComplete?.();
    },
  });
  return dur;
}

/** Flies to a geographic location and stops auto-rotation so it stays in view. */
function flyToLocation(lat, lon, { range = controls.range, tilt = 0, heading = 0, alignSun = true, onComplete } = {}) {
  setAutoRotate(false);
  const duration = flyTo({ lat, lon, range, tilt, heading }, { onComplete });
  if (alignSun) alignSunForLocation(lat, lon, duration);
}

function flyToCountry(country, { gentle = false } = {}) {
  const fit = countryRange(country);
  const current = controls.range;
  // A click on the globe zooms only part of the way ("gentle"); search goes all the way.
  const range = gentle ? clamp(lerp(current, fit, 0.6), CONFIG.minRange, Math.max(current, fit)) : fit;
  flyToLocation(country.labelLat, country.labelLon, { range });
}

function flyToCity(city, { range = Math.min(controls.range, cityRange()) } = {}) {
  // Keep the 3D perspective if the user is already looking at the terrain
  flyToLocation(city.lat, city.lon, { range, tilt: is3D() ? CONFIG.view3DTilt : 0, heading: is3D() ? controls.heading : 0 });
}

/** The 3D button: tilts the camera to show the terrain (zooming in first if needed), or back to top-down. */
function toggle3D() {
  const pose = controls.getPose();
  if (is3D()) {
    flyTo({ ...pose, tilt: 0 }, { duration: 0.9 });
    return;
  }
  if (pose.range > 0.12) {
    setAutoRotate(false);
    flyTo({ ...pose, range: 0.03 * viewportFactor(), tilt: CONFIG.view3DTilt }, { duration: 1.8 });
  } else {
    flyTo({ ...pose, tilt: CONFIG.view3DTilt }, { duration: 1.0 });
  }
}

/** Compass click: north up, looking straight down. */
function resetOrientation() {
  flyTo({ ...controls.getPose(), heading: 0, tilt: 0 }, { duration: 0.8 });
}

/** Opening view: the morning side of the planet (local solar time ≈ introLocalTime), 18° N. */
function initialPose() {
  const sub = subsolarPoint();
  return { lat: 18, lon: wrap180(sub.lon + (CONFIG.introLocalTime - 12) * 15), range: fitRange(), heading: 0, tilt: 0 };
}

function resetCamera() {
  clearSelection();
  setHover(null, null);
  setAutoRotate(true); // rotation resumes once the flight has finished
  flyTo(initialPose());
}

function positionInitialCamera() {
  controls.setPose({ ...initialPose(), range: fitDistance() * 1.9 - 1 });
  controls.update(0);
}

function introAnimation() {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  flyTo(initialPose(), { duration: reduced ? 0.01 : 2.6 });
}

/* =====================================================================
   13. TIME, SUN POSITION & DAY/NIGHT
   ===================================================================== */
let timeTween = null;

const utcHours = (d) => d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;

function dayOfYear(d) {
  return Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);
}

function initTime() {
  const now = new Date();
  state.date = now;
  state.timeHours = utcHours(now);
  state.dayOfYear = dayOfYear(now);
}

/**
 * Sub-solar point (where the Sun is directly overhead) for a UTC time.
 * NOAA approximations for the solar declination and the equation of time.
 */
function subsolarPoint(hours = state.timeHours, doy = state.dayOfYear) {
  const g = (TWO_PI / 365) * (doy - 1 + (hours - 12) / 24);
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g)
    + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const eqTimeMinutes = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
    - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  return { lat: decl / DEG, lon: wrap180(-15 * (hours - 12 + eqTimeMinutes / 60)) };
}

/** Updates the Sun direction, the light, the glow, the terminator and the starfield. */
function updateSun() {
  const sub = subsolarPoint();
  latLonToVector3(sub.lat, sub.lon, 1, world.sunDir);
  world.sunLight.position.copy(world.sunDir).multiplyScalar(50);
  if (uniforms.earth) {
    uniforms.earth.uSunIntensity.value = world.sunLight.intensity;
    uniforms.earth.uAmbient.value = world.ambientLight.intensity;
  }
  world.sunGlow?.position.copy(world.sunDir).multiplyScalar(320);
  world.terminator?.quaternion.setFromUnitVectors(Z_AXIS, world.sunDir);
  // The stars turn with the Sun (sidereal and solar days differ by only four minutes)
  if (world.stars) world.stars.rotation.y = -TWO_PI * (state.timeHours / 24);
}

const localSolarTime = (lon) => wrap24(12 + (lon - subsolarPoint().lon) / 15);

function sunElevationAt(lat, lon) {
  return Math.asin(clamp(latLonToVector3(lat, lon, 1, _pw).dot(world.sunDir), -1, 1)) / DEG;
}

/** Moves the simulated clock by `delta` hours, smoothly. Composes with auto-rotation. */
function shiftTime(delta, duration = 1.6) {
  timeTween?.cancel();
  timeTween = null;
  if (duration <= 0.01) {
    state.timeHours = wrap24(state.timeHours + delta);
    return;
  }
  let applied = 0;
  timeTween = tween({
    duration,
    ease: easeInOutCubic,
    onUpdate: (e) => {
      const step = delta * e;
      state.timeHours = wrap24(state.timeHours + step - applied);
      applied = step;
    },
    onComplete: () => { timeTween = null; },
  });
}

/** Shifts the clock so that longitude `lon` reaches the given local solar time. */
function alignSunTo(lon, localTime, duration) {
  const delta = wrapSigned12(localTime - localSolarTime(lon));
  if (Math.abs(delta) > 0.02) shiftTime(delta, duration);
}

/** During a fly-to, keep "Day" destinations lit and "Night" destinations dark. */
function alignSunForLocation(lat, lon, duration) {
  if (state.timeLocked || !state.layers.realistic) return;
  const elevation = sunElevationAt(lat, lon);
  if (!state.nightMode && elevation < 12) alignSunTo(lon, CONFIG.flyDayLocalTime, duration);
  else if (state.nightMode && elevation > -8) alignSunTo(lon, CONFIG.flyNightLocalTime, duration);
}

function applyNightParams(night) {
  const p = night ? NIGHT_PARAMS.night : NIGHT_PARAMS.day;
  fadeUniform(uniforms.earth.uNightAmbient, p.ambient, 1.6);
  fadeUniform(uniforms.earth.uLightsGain, p.lights, 1.6);
  fadeUniform(uniforms.atmosphere.uIntensity, p.atmo, 1.6);
}

/** DAY ⇄ NIGHT: sweeps the Sun around so the visible side becomes day or night. */
function setNightMode(on) {
  state.nightMode = on;
  state.timeLocked = false;
  if (on && !state.layers.realistic) setLayer('realistic', true);
  applyNightParams(on);
  alignSunTo(controls.lon, on ? CONFIG.nightLocalTime : CONFIG.dayLocalTime, 1.8);
  syncNightUI();
}

/* =====================================================================
   14. UI: LAYERS, CONTROLS, TIMELINE, KEYBOARD, TOOLTIPS, HUD
   ===================================================================== */
function cacheDom() {
  const $ = (id) => document.getElementById(id);
  Object.assign(dom, {
    scene: $('scene'),
    labels: $('labels'),
    tooltip: $('tooltip'),
    flash: $('flash'),
    loading: $('loading'),
    loadingText: $('loading-text'),
    loadingDetail: $('loading-detail'),
    progressBar: $('progress-bar'),
    toasts: $('toasts'),
    searchInput: $('search-input'),
    searchResults: $('search-results'),
    searchClear: $('search-clear'),
    layersPanel: $('layers-panel'),
    layersFab: $('layers-fab'),
    infoPanel: $('info-panel'),
    infoEmpty: $('info-empty'),
    infoContent: $('info-content'),
    hudLat: $('hud-lat'),
    hudLon: $('hud-lon'),
    hudAlt: $('hud-alt'),
    hudLoad: $('hud-load'),
    hudFps: $('hud-fps'),
    btnNight: $('btn-night'),
    btnRotate: $('btn-rotate'),
    btnReset: $('btn-reset'),
    btn3d: $('btn-3d'),
    btnScreenshot: $('btn-screenshot'),
    btnNow: $('btn-now'),
    compass: $('compass'),
    compassNeedle: $('compass-needle'),
    attribution: $('attribution'),
    timeSlider: $('time-slider'),
    timeDisplay: $('time-display'),
    dateDisplay: $('date-display'),
    qualityNote: $('quality-note'),
    sensitivity: $('sensitivity'),
    sensitivityValue: $('sensitivity-value'),
  });
  dom.speedButtons = [...document.querySelectorAll('[data-speed]')];
  dom.qualityButtons = [...document.querySelectorAll('[data-quality]')];
}

/** Single entry point for every layer toggle (panel switches, bar buttons, shortcuts). */
function setLayer(name, on) {
  if (state.disabledLayers.has(name) || !(name in state.layers)) return;
  state.layers[name] = on;
  const U = uniforms;

  switch (name) {
    case 'earth':
      fadeUniform(U.earth.uSurface, on ? 1 : 0, 0.9);
      break;
    case 'clouds':
      fadeUniform(U.clouds.uOpacity, on ? CLOUD_OPACITY : 0, 0.7); // visibility follows in updateViewState()
      break;
    case 'borders':
      fadeUniform(world.borderFade, on ? 1 : 0, 0.45);
      break;
    case 'countries':
      break; // labels are re-evaluated every frame
    case 'cities':
      updateMarkersVisibility();
      if (!on) setHover(state.hoverCountry, null);
      break;
    case 'nightLights':
      fadeUniform(U.earth.uNightLights, on ? 1 : 0, 0.8);
      break;
    case 'atmosphere':
      fadeUniform(U.atmosphere.uVisible, on ? 1 : 0, 0.7);
      fadeUniform(U.earth.uAtmosphere, on ? 1 : 0, 0.7);
      break;
    case 'terminator':
      updateTerminatorVisibility();
      break;
    case 'realistic':
      for (const u of [U.earth, U.clouds, U.atmosphere]) fadeUniform(u.uRealistic, on ? 1 : 0, 1.0);
      if (!on && state.nightMode) {
        state.nightMode = false;
        applyNightParams(false);
        syncNightUI();
      }
      updateTerminatorVisibility();
      break;
    case 'imagery':
      fadeUniform(world.imageryFade, on ? 1 : 0, 0.6);
      break;
    case 'terrain':
      tiles?.setOptions({ terrain: on });
      break;
    case 'mapLabels':
      tiles?.setOptions({ overlay: on });
      break;
    default:
      break;
  }
  syncLayerUI(name);
}

const toggleLayer = (name) => setLayer(name, !state.layers[name]);

function disableLayer(name, reason) {
  state.disabledLayers.add(name);
  state.layers[name] = false;
  document.querySelectorAll(`[data-layer="${name}"]`).forEach((el) => {
    el.disabled = true;
    const row = el.closest('.layer');
    if (row) {
      row.classList.add('disabled');
      row.dataset.tooltip = reason;
    } else {
      el.dataset.tooltip = reason;
    }
  });
  syncLayerUI(name);
}

function syncLayerUI(name) {
  const on = !!state.layers[name];
  document.querySelectorAll(`.switch[data-layer="${name}"]`).forEach((input) => { input.checked = on; });
  document.querySelectorAll(`.ctrl[data-layer="${name}"]`).forEach((button) => {
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', String(on));
  });
}

function setAutoRotate(on) {
  state.autoRotate = on;
  if (on) state.userInteracting = false;
  syncRotateUI();
}

function setRotationSpeed(speed) {
  state.rotationSpeed = speed;
  if (!state.autoRotate) setAutoRotate(true);
  syncRotateUI();
}

function syncRotateUI() {
  dom.btnRotate.classList.toggle('on', state.autoRotate);
  dom.btnRotate.setAttribute('aria-pressed', String(state.autoRotate));
  for (const button of dom.speedButtons) {
    const active = Number(button.dataset.speed) === state.rotationSpeed;
    button.classList.toggle('on', active);
    button.setAttribute('aria-checked', String(active));
  }
}

function syncNightUI() {
  dom.btnNight.classList.toggle('on', state.nightMode);
  dom.btnNight.setAttribute('aria-pressed', String(state.nightMode));
  dom.btnNight.dataset.tooltip = state.nightMode ? 'Night view is ON — click for day (N)' : 'Day / Night (N)';
}

function syncQualityUI() {
  if (!dom.qualityButtons) return;
  for (const button of dom.qualityButtons) {
    const active = button.dataset.quality === state.qualitySetting;
    button.classList.toggle('on', active);
    button.setAttribute('aria-checked', String(active));
  }
  const name = state.quality[0].toUpperCase() + state.quality.slice(1);
  const ratio = renderer ? renderer.getPixelRatio().toFixed(2).replace(/\.?0+$/, '') : '1';
  dom.qualityNote.textContent = `${state.qualitySetting === 'auto' ? `Auto → ${name}` : name} · pixel ratio ${ratio}`;
}

function setupUI() {
  document.querySelectorAll('.switch[data-layer]').forEach((input) => {
    input.addEventListener('change', () => setLayer(input.dataset.layer, input.checked));
  });
  document.querySelectorAll('.ctrl[data-layer]').forEach((button) => {
    button.addEventListener('click', () => toggleLayer(button.dataset.layer));
  });
  dom.btnNight.addEventListener('click', () => setNightMode(!state.nightMode));
  dom.btnRotate.addEventListener('click', () => setAutoRotate(!state.autoRotate));
  dom.speedButtons.forEach((b) => b.addEventListener('click', () => setRotationSpeed(Number(b.dataset.speed))));
  dom.btnReset.addEventListener('click', resetCamera);
  dom.btn3d.addEventListener('click', toggle3D);
  dom.compass.addEventListener('click', resetOrientation);
  dom.btnScreenshot.addEventListener('click', takeScreenshot);
  dom.qualityButtons.forEach((b) => b.addEventListener('click', () => setQualitySetting(b.dataset.quality)));
  dom.infoContent.addEventListener('click', onInfoAction);

  // Layers that cannot work without their dataset are disabled (instead of failing silently).
  if (!data.available.boundaries) {
    disableLayer('borders', 'Country boundaries could not be loaded');
    disableLayer('countries', 'Country boundaries could not be loaded');
  }
  if (!data.available.cities) disableLayer('cities', 'City data could not be loaded');
  if (!world.hasNightTexture) disableLayer('nightLights', 'Night lights texture unavailable');

  setupPanels();
  setupTimeline();
  setupSensitivity();
  setupKeyboard();
  setupTooltips();

  Object.keys(state.layers).forEach(syncLayerUI);
  syncRotateUI();
  syncNightUI();
  syncQualityUI();
}

function setupPanels() {
  document.querySelectorAll('[data-collapse]').forEach((button) => {
    button.addEventListener('click', () => {
      const panel = document.getElementById(button.dataset.collapse);
      const collapsed = panel.classList.toggle('collapsed');
      button.setAttribute('aria-expanded', String(!collapsed));
    });
  });
  document.querySelectorAll('[data-close]').forEach((button) => {
    button.addEventListener('click', () => document.getElementById(button.dataset.close).classList.remove('open'));
  });
  dom.layersFab.addEventListener('click', () => dom.layersPanel.classList.toggle('open'));
  // Tapping the globe closes the mobile layers sheet
  renderer.domElement.addEventListener('pointerdown', () => dom.layersPanel.classList.remove('open'));
}

function setupTimeline() {
  const slider = dom.timeSlider;
  slider.addEventListener('pointerdown', () => { state.sliderActive = true; });
  window.addEventListener('pointerup', () => { state.sliderActive = false; });
  slider.addEventListener('input', () => {
    timeTween?.cancel();
    timeTween = null;
    state.timeHours = Number(slider.value) / 60;
    state.timeLocked = true;
    updateTimeUI();
  });
  dom.btnNow.addEventListener('click', () => {
    const now = new Date();
    state.date = now;
    state.dayOfYear = dayOfYear(now);
    state.timeLocked = true;
    shiftTime(wrapSigned12(utcHours(now) - state.timeHours), 1.2);
    showToast(`Clock set to the current time: ${formatHours(utcHours(now))} UTC`, 'info', 2500);
  });
  dom.dateDisplay.textContent = state.date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const SENSITIVITY_KEY = 'earth3d.sensitivity';

/** Rotation sensitivity slider; the value is remembered in this browser. */
function setupSensitivity() {
  let saved = NaN;
  try { saved = Number(localStorage.getItem(SENSITIVITY_KEY)); } catch { /* storage unavailable */ }
  setSensitivity(Number.isFinite(saved) && saved > 0 ? saved : 1);
  dom.sensitivity.addEventListener('input', () => {
    setSensitivity(Number(dom.sensitivity.value) / 100);
    try { localStorage.setItem(SENSITIVITY_KEY, String(controls.sensitivity)); } catch { /* not persisted */ }
  });
}

function setSensitivity(value) {
  controls.sensitivity = clamp(value, 0.2, 1.5);
  const percent = Math.round(controls.sensitivity * 100);
  dom.sensitivity.value = String(percent);
  dom.sensitivityValue.textContent = `${percent}%`;
  const min = Number(dom.sensitivity.min);
  const max = Number(dom.sensitivity.max);
  dom.sensitivity.style.setProperty('--fill', `${((percent - min) / (max - min)) * 100}%`);
}

let lastTimeText = '';
function updateTimeUI() {
  const text = formatHours(state.timeHours);
  if (text !== lastTimeText) {
    dom.timeDisplay.textContent = text;
    lastTimeText = text;
  }
  if (!state.sliderActive) {
    const minutes = Math.floor(wrap24(state.timeHours) * 60);
    if (Number(dom.timeSlider.value) !== minutes) dom.timeSlider.value = String(minutes);
  }
  dom.timeSlider.style.setProperty('--fill', `${(Number(dom.timeSlider.value) / 1440) * 100}%`);
}

/** Altitude, tile loading indicator, attribution, compass and 3D button state. */
let lastAltText = '';
function updateHud() {
  const altText = formatAltitude(((camera.position.length() - 1) * EARTH_RADIUS_M) / 1000);
  if (altText !== lastAltText) {
    dom.hudAlt.textContent = altText;
    lastAltText = altText;
  }
  dom.hudLoad.classList.toggle('show', !!tiles && tiles.stats.loading > 0 && view.tileBlend > 0);

  const credits = [];
  if (view.tileBlend > 0.01 && tiles.loaded.imagery > 0) {
    credits.push(CONFIG.tiles.imagery.attribution);
    if (view.mapLabelFade > 0.01) credits.push(CONFIG.tiles.overlay.attribution);
    if (state.layers.terrain && view.zoom >= CONFIG.tiles.terrain.minZoom) credits.push(CONFIG.tiles.terrain.attribution);
  }
  const creditText = credits.join(' · ');
  if (dom.attribution.textContent !== creditText) dom.attribution.textContent = creditText;
  dom.attribution.classList.toggle('show', credits.length > 0);

  const oriented = Math.abs(controls.heading) > 0.01 || controls.tilt > 0.02;
  dom.compass.classList.toggle('show', oriented);
  dom.compassNeedle.style.transform = `rotate(${(-controls.heading).toFixed(3)}rad)`;
  dom.btn3d.classList.toggle('on', is3D());
  dom.btn3d.setAttribute('aria-pressed', String(is3D()));
}

function setupKeyboard() {
  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    const typing = target.matches?.('input[type="text"], input[type="search"], textarea, select');
    if (typing) return;
    if (flightSystem && flightSystem.active) {
      if (event.key.toLowerCase() === 'escape') {
        flightSystem.exit();
      }
      return;
    }
    switch (event.key.toLowerCase()) {
      case '/':
        event.preventDefault();
        dom.searchInput.focus();
        dom.searchInput.select();
        break;
      case 'r': resetCamera(); break;
      case 'n': setNightMode(!state.nightMode); break;
      case 't': toggle3D(); break;
      case 'c': toggleLayer('clouds'); break;
      case 'b': toggleLayer('borders'); break;
      case 'l': toggleLayer('countries'); break;
      case 'm': toggleLayer('cities'); break;
      case '+':
      case '=': controls.zoomBy(0.6); break;
      case '-':
      case '_': controls.zoomBy(1 / 0.6); break;
      case 'escape': clearSelection(); break;
      case ' ':
        if (target.closest?.('button, input, label')) return; // let Space activate the focused control
        event.preventDefault();
        setAutoRotate(!state.autoRotate);
        break;
      default:
        break;
    }
  });
}

/** Hint tooltips for every element with a data-tooltip attribute (mouse only). */
function setupTooltips() {
  const tip = document.createElement('div');
  tip.className = 'ui-tip';
  tip.setAttribute('role', 'tooltip');
  document.body.appendChild(tip);
  let timer = null;
  let current = null;
  const hide = () => {
    clearTimeout(timer);
    current = null;
    tip.classList.remove('show');
  };
  document.addEventListener('pointerover', (event) => {
    if (event.pointerType !== 'mouse') return;
    const el = event.target.closest?.('[data-tooltip]');
    if (el === current) return;
    hide();
    if (!el) return;
    current = el;
    timer = setTimeout(() => {
      tip.textContent = el.dataset.tooltip;
      const r = el.getBoundingClientRect();
      const t = tip.getBoundingClientRect();
      let x;
      let y;
      if (el.closest('.layers-panel')) {
        x = r.right + 10;
        y = r.top + r.height / 2 - t.height / 2;
      } else if (r.top > window.innerHeight / 2) {
        x = r.left + r.width / 2 - t.width / 2;
        y = r.top - t.height - 8;
      } else {
        x = r.left + r.width / 2 - t.width / 2;
        y = r.bottom + 8;
      }
      x = clamp(x, 8, window.innerWidth - t.width - 8);
      y = clamp(y, 8, window.innerHeight - t.height - 8);
      tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      tip.classList.add('show');
    }, 380);
  });
  document.addEventListener('pointerdown', hide);
  window.addEventListener('blur', hide);
}

/* ---- Screenshot ---- */
function takeScreenshot() {
  state.screenshotPending = true; // captured right after the next render
}

function captureScreenshot() {
  state.screenshotPending = false;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  renderer.domElement.toBlob((blob) => {
    if (!blob) {
      showToast('Screenshot failed — the browser blocked canvas export.', 'error');
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `earth-3d-${stamp}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    dom.flash.classList.remove('go');
    void dom.flash.offsetWidth;
    dom.flash.classList.add('go');
    showToast('Screenshot saved', 'success', 2500);
  }, 'image/png');
}

/* =====================================================================
   15. SEARCH
   ===================================================================== */
function buildSearchIndex() {
  const keys = (names) => [...new Set(names.filter(Boolean).map(normalizeText).filter(Boolean))]
    .map((k) => ({ k, c: k.replace(/ /g, '') }));
  const entries = [];

  for (const country of data.countries) {
    const i = country.info || {};
    entries.push({
      type: 'country',
      item: country,
      title: country.name,
      sub: [i.continent, i.capital?.length ? `Capital: ${i.capital[0]}` : null].filter(Boolean).join(' · ') || 'Country',
      icon: i.flag || '🏳️',
      keys: keys([country.name, i.official, i.nameVi, ...(i.aliases || [])]),
      weight: 14,
    });
  }
  for (const city of data.cities) {
    entries.push({
      type: 'city',
      item: city,
      title: city.name,
      sub: city.country,
      icon: city.capital === 'national' ? '★' : '📍',
      keys: keys([city.name, city.ascii]),
      weight: (10 - city.rank) + (city.capital === 'national' ? 4 : 0) + Math.log10(city.population + 1) * 0.6,
    });
  }
  data.searchIndex = entries;
}

/** Accent-insensitive search: exact > prefix > word prefix > substring, then importance. */
function searchPlaces(query, limit = 8) {
  const q = normalizeText(query);
  if (!q) return [];
  const qc = q.replace(/ /g, '');
  const scored = [];
  for (const entry of data.searchIndex) {
    let best = 0;
    for (const { k, c } of entry.keys) {
      let s = 0;
      if (k === q || c === qc) s = 100;
      else if (k.startsWith(q) || c.startsWith(qc)) s = 75;
      else if (` ${k}`.includes(` ${q}`)) s = 55;
      else if (qc.length >= 3 && c.includes(qc)) s = 35;
      if (s > best) best = s;
    }
    if (best) scored.push({ entry, score: best + entry.weight });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.entry);
}

function highlightMatch(title, query) {
  const q = query.trim();
  const index = q ? title.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (index < 0) return escapeHtml(title);
  return `${escapeHtml(title.slice(0, index))}<mark>${escapeHtml(title.slice(index, index + q.length))}</mark>${escapeHtml(title.slice(index + q.length))}`;
}

function setupSearch() {
  const input = dom.searchInput;
  const list = dom.searchResults;
  let results = [];
  let active = -1;
  let debounce = null;

  const open = () => {
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };
  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };
  const render = () => {
    const query = input.value.trim();
    if (!query) { close(); return; }
    if (!results.length) {
      list.innerHTML = `<li class="result-empty">No country or city matches “${escapeHtml(query)}”.</li>`;
      open();
      return;
    }
    list.innerHTML = results.map((r, i) => `
      <li class="result${i === active ? ' active' : ''}" role="option" id="sr-${i}" data-i="${i}" aria-selected="${i === active}">
        <span class="r-ico flag">${escapeHtml(r.icon)}</span>
        <span class="r-text">
          <span class="r-title">${highlightMatch(r.title, query)}</span>
          <span class="r-sub">${escapeHtml(r.sub)}</span>
        </span>
        <span class="r-type">${r.type}</span>
      </li>`).join('');
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', `sr-${active}`);
      list.querySelector('.result.active')?.scrollIntoView({ block: 'nearest' });
    }
    open();
  };
  const run = () => {
    results = searchPlaces(input.value);
    active = results.length ? 0 : -1;
    render();
  };
  const choose = (result) => {
    if (!result) return;
    input.value = result.title;
    dom.searchClear.hidden = false;
    close();
    input.blur();
    if (result.type === 'country') selectCountry(result.item, { fly: true });
    else selectCity(result.item, { fly: true });
  };

  input.addEventListener('input', () => {
    dom.searchClear.hidden = !input.value;
    clearTimeout(debounce);
    debounce = setTimeout(run, 70);
  });
  input.addEventListener('focus', () => { if (input.value.trim()) run(); });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!results.length) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + results.length) % results.length;
      render();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      clearTimeout(debounce);
      results = searchPlaces(input.value);
      choose(results[Math.max(active, 0)] || results[0]);
    } else if (event.key === 'Escape') {
      close();
      input.blur();
    }
  });
  list.addEventListener('pointerdown', (event) => event.preventDefault()); // keep focus while choosing
  list.addEventListener('click', (event) => {
    const li = event.target.closest('[data-i]');
    if (li) choose(results[Number(li.dataset.i)]);
  });
  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest?.('.search')) close();
  });
  dom.searchClear.addEventListener('click', () => {
    input.value = '';
    dom.searchClear.hidden = true;
    results = [];
    close();
    input.focus();
  });
}

/* =====================================================================
   16. POINTER INTERACTION
   ===================================================================== */
const raycaster = new THREE.Raycaster();
const globeSphere = new THREE.Sphere(new THREE.Vector3(), CONFIG.earthRadius);
const _ndc = new THREE.Vector2();
const _hit = new THREE.Vector3();
let tooltipWidth = 0;
let tooltipHeight = 0;
let lastCoordsText = '';

/** Ray-sphere intersection (exact and cheaper than raycasting the meshes) → lat/lon. */
function pickGlobe(x, y) {
  _ndc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
  raycaster.setFromCamera(_ndc, camera);
  globeSphere.radius = 1 + controls.focusHeight; // terrain height near the centre of the view
  if (!raycaster.ray.intersectSphere(globeSphere, _hit)) return null;
  return vector3ToLatLon(_hit);
}

function setupPointer() {
  const el = renderer.domElement;
  const p = state.pointer;
  el.addEventListener('pointermove', (event) => {
    p.x = event.clientX;
    p.y = event.clientY;
    p.inside = true;
    p.type = event.pointerType;
  });
  el.addEventListener('pointerleave', () => {
    p.inside = false;
  });
  el.addEventListener('pointerdown', (event) => {
    p.type = event.pointerType;
    p.down = { x: event.clientX, y: event.clientY, t: performance.now() };
  });
  el.addEventListener('pointerup', (event) => {
    const down = p.down;
    p.down = null;
    if (!down || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
    if (moved < 6 && performance.now() - down.t < 600) handleClick(event.clientX, event.clientY);
  });
  el.addEventListener('pointercancel', () => { p.down = null; });
  el.addEventListener('dblclick', (event) => handleDoubleClick(event.clientX, event.clientY));
}

function handleClick(x, y) {
  if (flight || (flightSystem && flightSystem.active)) return;
  const city = pickCity(x, y, view.radiusPx);
  if (city) {
    selectCity(city, { fly: true });
    return;
  }
  const hit = pickGlobe(x, y);
  const country = hit ? countryAt(hit.lat, hit.lon) : null;
  // Close to the ground a click only selects: flying out to the whole country would be disorienting
  if (country) selectCountry(country, { fly: controls.range > 0.3, gentle: true });
  else clearSelection(); // ocean or empty space
}

/** Double click: fly closer to that point, keeping the current heading and tilt. */
function handleDoubleClick(x, y) {
  const hit = pickGlobe(x, y);
  if (!hit) return;
  flyToLocation(hit.lat, hit.lon, {
    range: Math.max(CONFIG.minRange, controls.range * 0.35),
    heading: controls.heading,
    tilt: controls.tilt,
    alignSun: false,
  });
}

function setHover(country, city) {
  if (country !== state.hoverCountry) {
    state.hoverCountry = country;
    redrawHighlight();
    setOutline(world.hoverOutline, country && country !== selectedCountry() ? country : null);
  }
  if (city !== state.hoverCity) {
    state.hoverCity = city;
    if (uniforms.markers) uniforms.markers.uHovered.value = city ? city.index : -1;
  }
}

function showGlobeTooltip(html) {
  const tip = dom.tooltip;
  if (tip.dataset.html !== html) {
    tip.innerHTML = html;
    tip.dataset.html = html;
    tooltipWidth = tip.offsetWidth;
    tooltipHeight = tip.offsetHeight;
  }
  const x = clamp(state.pointer.x + 16, 8, window.innerWidth - tooltipWidth - 8);
  const y = clamp(state.pointer.y + 18, 8, window.innerHeight - tooltipHeight - 8);
  tip.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  tip.classList.add('show');
}

function hideGlobeTooltip() {
  dom.tooltip.classList.remove('show');
}

function updateCoordsHUD(hit) {
  const text = hit ? `${formatLat(hit.lat)}|${formatLon(hit.lon)}` : '—|—';
  if (text === lastCoordsText) return;
  lastCoordsText = text;
  const [lat, lon] = text.split('|');
  dom.hudLat.textContent = lat;
  dom.hudLon.textContent = lon;
}

/** Hover feedback: country highlight, city marker highlight, tooltip, coordinates. */
function updateHover(globeRadiusPx) {
  const p = state.pointer;
  if (!p.inside || p.type !== 'mouse' || p.down || state.flying || (flightSystem && flightSystem.active)) {
    setHover(null, null);
    hideGlobeTooltip();
    if (!p.inside) updateCoordsHUD(null);
    return;
  }
  const hit = pickGlobe(p.x, p.y);
  updateCoordsHUD(hit);
  const city = hit ? pickCity(p.x, p.y, globeRadiusPx) : null;
  const country = !city && hit ? countryAt(hit.lat, hit.lon) : null;
  setHover(country, city);

  if (city) {
    showGlobeTooltip(`📍 ${escapeHtml(city.name)}<span class="tt-sub">${escapeHtml(city.country)}</span>`);
  } else if (country) {
    const flag = country.info?.flag ? `<span class="flag">${escapeHtml(country.info.flag)}</span> ` : '';
    showGlobeTooltip(`${flag}${escapeHtml(country.name)}`);
  } else {
    hideGlobeTooltip();
  }
  renderer.domElement.style.cursor = city || country ? 'pointer' : hit ? 'grab' : '';
}

/* =====================================================================
   17. ANIMATION LOOP & RESIZE
   ===================================================================== */
let lastFrame = performance.now();
let lastUiUpdate = 0;
let lastLiveUpdate = 0;

const focalLength = () => window.innerHeight / 2 / Math.tan((camera.fov * DEG) / 2);

/** Apparent radius of the globe on screen, in CSS pixels. */
function globeScreenRadius(dist) {
  return focalLength() / Math.sqrt(Math.max(dist * dist - 1, 1e-6));
}

/**
 * Auto-rotation: the camera drifts west while the clock advances by the same angle, so the
 * planet appears to spin east under a fixed Sun. It fades out when zoomed in close.
 */
function updateRotation(dt) {
  const zoomFactor = smoothstep(0.25, 1.0, controls.range);
  const target = state.autoRotate && !state.userInteracting && !state.flying && (!flightSystem || !flightSystem.active)
    ? CONFIG.baseRotationSpeed * state.rotationSpeed * zoomFactor
    : 0;
  state.rotationVelocity += (target - state.rotationVelocity) * Math.min(1, dt * 2.2);
  if (target === 0 && Math.abs(state.rotationVelocity) < 1e-5) state.rotationVelocity = 0;

  const dTheta = state.rotationVelocity * dt;
  if (dTheta) {
    controls.lon = wrap180(controls.lon - dTheta / DEG);
    state.timeHours = wrap24(state.timeHours + (dTheta / TWO_PI) * 24);
  }
  if (world.clouds) {
    world.clouds.rotation.y = (world.clouds.rotation.y + CONFIG.cloudDrift * dt) % TWO_PI;
    uniforms.earth.uCloudOffset.value = world.clouds.rotation.y / TWO_PI;
  }
}

/** Near/far planes follow the altitude, so the depth buffer stays precise from space to street level. */
function updateClipPlanes() {
  if (flightSystem && flightSystem.active) {
    const near = 2e-7; // ~1.3m: keeps the 15m jet (30m from camera) and cockpit fully visible!
    // Must reach the whole atmosphere shell: towards the horizon it is ~0.46 radii away, and a
    // shorter far plane clips the sky into a black, jagged band (the depth precision depends on
    // the near plane, so a far plane this distant costs nothing)
    const far = camera.position.length() + CONFIG.atmosphereRadius;
    if (camera.near !== near || Math.abs(camera.far - far) > 0.01) {
      camera.near = near;
      camera.far = far;
      camera.updateProjectionMatrix();
    }
    return;
  }
  const dist = camera.position.length();
  const ll = vector3ToLatLon(camera.position);
  const ground = 1 + (tiles ? tiles.getHeight(ll.lat, ll.lon) : 0);
  const near = clamp((dist - ground) * 0.15, 2e-7, 0.05);
  const far = dist + 1.3;
  if (Math.abs(camera.near - near) > near * 0.02 || Math.abs(camera.far - far) > 0.01) {
    camera.near = near;
    camera.far = far;
    camera.updateProjectionMatrix();
  }
}

function syncBackgroundCamera() {
  bgCamera.fov = camera.fov;
  bgCamera.aspect = camera.aspect;
  const v = camera.view;
  if (v?.enabled) bgCamera.setViewOffset(v.fullWidth, v.fullHeight, v.offsetX, v.offsetY, v.width, v.height);
  else if (bgCamera.view?.enabled) bgCamera.clearViewOffset();
  bgCamera.updateProjectionMatrix();
  bgCamera.quaternion.copy(camera.quaternion);
  bgCamera.updateMatrixWorld();
}

/** Zoom-dependent tuning: tiles, clouds, highlights, borders, markers and labels. */
function updateViewState() {
  const range = controls.range;
  view.range = range;
  view.focal = focalLength();
  view.radiusPx = globeScreenRadius(camera.position.length());
  const pxPerRadian = view.focal / Math.max(range, 1e-7);
  view.zoom = Math.log2((pxPerRadian * TWO_PI * Math.max(Math.cos(controls.lat * DEG), 0.05)) / 256);
  view.tileBlend = smoothstep(4.4, 5.0, view.zoom) * world.imageryFade.value * uniforms.earth.uSurface.value;
  // Our own labels and borders only make way for the streamed ones once those actually load
  const streamedLabels = state.layers.mapLabels && tiles.loaded.overlay > 0 && !tiles.offline;
  view.mapLabelFade = streamedLabels ? smoothstep(8.5, 9.5, view.zoom) * view.tileBlend : 0;
  view.minFacing = clamp(range * 0.15, 0.004, 0.1);

  const U = uniforms;
  U.earth.uTileBlend.value = view.tileBlend;
  U.earth.uMapLabels.value = view.mapLabelFade;
  U.earth.uHighlightStrength.value = smoothstep(0.003, 0.05, range);
  // The 4K night-lights map turns into blocky glows at city scale: fade it out and keep the
  // ground faintly visible instead (the map labels stay readable at night).
  U.earth.uLightsFade.value = 1 - smoothstep(6.5, 9, view.zoom);
  U.earth.uCloseNight.value = 0.05 * smoothstep(7, 10, view.zoom) * view.tileBlend;
  U.lineFacing.value = clamp(range * 0.1, 0.005, 0.08);
  U.markerFacing.value = clamp(range * 0.3, 0.01, 0.22);

  // Clouds thin out when approaching the ground (they would hide the city)
  const cloudFade = smoothstep(0.02, 0.2, range);
  U.clouds.uRangeFade.value = cloudFade;
  world.clouds.visible = U.clouds.uOpacity.value > 0.001 && cloudFade > 0.001;
  U.earth.uCloudShadow.value = qualityPreset().cloudShadow ? (U.clouds.uOpacity.value / CLOUD_OPACITY) * cloudFade : 0;
  world.atmosphere.visible = U.atmosphere.uVisible.value > 0.001;

  if (world.borders) {
    // The 1:50m borders are generalised: at street level the streamed map labels draw precise ones
    const closeFade = smoothstep(0.0015, 0.015, range) * (1 - view.mapLabelFade);
    const opacity = world.borderFade.value * clamp(0.28 + view.radiusPx / 2600, 0.3, 0.7) * closeFade;
    world.borders.material.uniforms.uOpacity.value = opacity;
    world.borders.visible = opacity > 0.002;
    world.selectOutline.material.uniforms.uOpacity.value = smoothstep(0.0008, 0.008, range) * (1 - view.mapLabelFade * 0.6);
    world.hoverOutline.material.uniforms.uOpacity.value = 0.7 * smoothstep(0.0008, 0.008, range);
  }
  if (U.markers) {
    U.markers.uMaxRank.value = state.layers.cities ? cityMarkerRank(view.radiusPx) : -1;
    U.markers.uScale.value = clamp(0.8 + view.radiusPx / 2000, 0.85, 1.4);
  }
}

/* ---- Phones: keep the selected place visible above the bottom sheet ---- */
const viewShift = { current: 0, target: 0 };
const compactLayout = window.matchMedia('(max-width: 760px)');

function updateViewShiftTarget() {
  if (!compactLayout.matches || !state.selection) {
    viewShift.target = 0;
    return;
  }
  const panel = dom.infoPanel;
  const sheetTop = window.innerHeight - (parseFloat(getComputedStyle(panel).bottom) || 0) - panel.offsetHeight;
  const searchBottom = 112;
  const visibleCentre = (searchBottom + sheetTop) / 2;
  viewShift.target = clamp(window.innerHeight / 2 - visibleCentre, 0, window.innerHeight * 0.3);
}

/** Shifts the projection centre (not the camera) so the globe centre moves up on screen. */
function applyViewShift(dt) {
  viewShift.current += (viewShift.target - viewShift.current) * Math.min(1, dt * 5);
  if (viewShift.target === 0 && Math.abs(viewShift.current) < 0.5) {
    viewShift.current = 0;
    if (camera.view?.enabled) camera.clearViewOffset();
    return;
  }
  const W = window.innerWidth;
  const H = window.innerHeight;
  camera.setViewOffset(W, H, 0, viewShift.current, W, H);
}

function renderFrame() {
  renderer.clear();
  renderer.render(bgScene, bgCamera);
  renderer.clearDepth();
  renderer.render(scene, camera);
}

function animate(now) {
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;
  state.elapsed += dt;

  updateTweens(now);
  updateRotation(dt);
  controls.update(dt);
  if (flightSystem) flightSystem.update(dt);
  updateSun();
  applyViewShift(dt);
  updateClipPlanes();
  syncBackgroundCamera();
  updateViewState();
  tiles.update(camera, dt, { active: view.tileBlend > 0.001, focal: view.focal });

  updateHover(view.radiusPx);
  updateLabels(view.radiusPx);
  updateSelectionMarker(dt);

  uniforms.stars.uTime.value = state.elapsed;
  uniforms.earth.uPulse.value = 0.5 + 0.5 * Math.sin(state.elapsed * 2.4);

  renderFrame();
  if (state.screenshotPending) captureScreenshot();

  updateFps(now);
  if (now - lastUiUpdate > 100) {
    lastUiUpdate = now;
    updateTimeUI();
    updateHud();
  }
  if (now - lastLiveUpdate > 500) {
    lastLiveUpdate = now;
    updateInfoLive();
    refreshUiRects();
    updateViewShiftTarget();
  }
}

function onResize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
  applyPixelRatio();
  controls.maxRange = Math.max(11, fitDistance() * 1.8 - 1);
  refreshUiRects();
  updateViewShiftTarget();
}

/* =====================================================================
   18. BOOT
   ===================================================================== */
function reportDataProblems() {
  if (state.fallbackMode) showToast(FALLBACK_MESSAGE, 'warn', 9000);
  if (!data.available.boundaries) {
    showToast('Country boundaries could not be loaded — borders, country labels and country picking are disabled.', 'warn', 9000);
  }
  if (!data.available.info) {
    showToast('Country information (data/countries.json) could not be loaded — the panel shows names only.', 'warn', 9000);
  }
  if (!data.available.cities) {
    showToast('City data could not be loaded — city markers and city search are disabled.', 'warn', 9000);
  }
}

async function init() {
  cacheDom();

  try {
    initRenderer();
  } catch (error) {
    console.error(error);
    showFatal(
      'WebGL is not available',
      'Earth 3D needs WebGL 2 (a recent Chrome, Edge, Firefox or Safari with hardware acceleration enabled).',
    );
    return;
  }

  initScene();
  initCamera();
  initControls();
  state.quality = detectQuality();
  applyQuality(state.quality);
  initTime();
  setupLighting();
  createStars();
  createSunGlow();
  createTerminator();
  updateSun();

  setLoadingDetail('Downloading textures and geographic data');
  const [textures] = await Promise.all([loadAllTextures(), loadAllData()]);

  setLoadingDetail('Building the planet');
  await nextTick();
  const tex = resolveTextures(textures);
  createHighlightLayer();
  createEarth(tex);
  createClouds(tex);
  createAtmosphere();
  createTiles();
  if (data.available.boundaries) buildBorders();
  if (data.countries.length) createCountryLabels();
  if (data.available.cities) {
    createCityMarkers();
    createCityLabels();
  }
  createSelectionMarker();
  buildSearchIndex();

  flightSystem = new FlightSystem({
    scene,
    renderer,
    camera,
    controls,
    tiles,
    earthUniforms: uniforms.earth,
    getWorldEnv: () => ({
      sunDir: world.sunDir,
      sunColor: world.sunLight ? world.sunLight.color : new THREE.Color(1, 1, 1),
      ambient: new THREE.Color(0.3, 0.33, 0.4),
    }),
  });

  setupUI();
  setupSearch();
  setupPointer();

  positionInitialCamera();
  onResize();
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', () => {
    perf.frames = 0;
    perf.last = performance.now();
    perf.lowStreak = 0;
    lastFrame = performance.now();
  });
  // Web fonts change label widths once they arrive
  document.fonts?.ready.then(() => {
    for (const item of labels.items) {
      if (!item.el) continue;
      item.w = item.el.offsetWidth;
      item.h = item.el.offsetHeight;
    }
  });

  updateSun();
  updateTimeUI();
  updateClipPlanes();
  syncBackgroundCamera();
  updateViewState();
  renderer.compile(scene, camera);
  renderFrame(); // uploads textures before the loading screen disappears

  perf.startedAt = performance.now();
  lastFrame = performance.now();
  renderer.setAnimationLoop(animate);
  finishLoading();
  introAnimation();
  reportDataProblems();
}

init().catch((error) => {
  console.error(error);
  showFatal('Earth 3D could not start', escapeHtml(error?.message || String(error)));
});
