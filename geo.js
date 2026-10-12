/**
 * Geographic helpers shared by the app, the camera controls and the tile engine.
 *
 * Coordinate system: the Earth has radius 1 and sits at the world origin.
 * Longitude 0 points to +X, longitude 90°E to −Z and the North Pole to +Y —
 * the mapping three.js uses for equirectangular textures on a SphereGeometry.
 */
import { Matrix4, Vector3 } from 'three';

export const DEG = Math.PI / 180;
export const TWO_PI = Math.PI * 2;
export const EARTH_RADIUS_M = 6371008.8;
export const MAX_MERCATOR_LAT = 85.0511287798;

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
export const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Geographic coordinates → position on a sphere. */
export function latLonToVector3(lat, lon, radius = 1, target = new Vector3()) {
  const phi = (lon + 180) * DEG;
  const theta = (90 - lat) * DEG;
  return target.set(
    -radius * Math.sin(theta) * Math.cos(phi),
    radius * Math.cos(theta),
    radius * Math.sin(theta) * Math.sin(phi),
  );
}

/** Position (any radius) → geographic coordinates. */
export function vector3ToLatLon(v) {
  const len = v.length() || 1;
  const lat = Math.asin(clamp(v.y / len, -1, 1)) / DEG;
  const lon = wrap180(Math.atan2(v.z, -v.x) / DEG - 180);
  return { lat, lon };
}

/** Unit vectors pointing east and north at a geographic point (well defined at the poles too). */
export function eastNorthAt(lat, lon, east, north) {
  const phi = (lon + 180) * DEG;
  const theta = (90 - lat) * DEG;
  east.set(Math.sin(phi), 0, Math.cos(phi));
  north.set(Math.cos(theta) * Math.cos(phi), Math.sin(theta), -Math.cos(theta) * Math.sin(phi));
}

const _fE = new Vector3();
const _fN = new Vector3();
const _fU = new Vector3();
const _fM = new Matrix4();

/**
 * Turns an object into a local frame at a point `altM` metres above sea level: its children
 * are measured in metres, with +X east, +Y up and −Z north. three.js composes the matrices in
 * double precision, so things a few metres from the camera stay perfectly steady.
 */
export function placeLocalFrame(object, lat, lon, altM = 0) {
  latLonToVector3(lat, lon, 1, _fU);
  eastNorthAt(lat, lon, _fE, _fN);
  _fM.makeBasis(_fE, _fU, _fN.negate());
  object.quaternion.setFromRotationMatrix(_fM);
  object.position.copy(_fU).multiplyScalar(1 + altM / EARTH_RADIUS_M);
  object.scale.setScalar(1 / EARTH_RADIUS_M);
  return object;
}

/** Geographic point `east` / `north` metres away from (lat, lon), fine for distances of a few km. */
export function offsetLatLon(lat, lon, east, north) {
  const nLat = lat + north / EARTH_RADIUS_M / DEG;
  const cos = Math.max(Math.cos(((lat + nLat) / 2) * DEG), 1e-6);
  return { lat: nLat, lon: wrap180(lon + east / (EARTH_RADIUS_M * cos) / DEG) };
}

/* ---- Web Mercator (EPSG:3857), normalised to 0..1; y grows southwards like XYZ tiles ---- */
export const lonToMercX = (lon) => (lon + 180) / 360;

export function latToMercY(lat) {
  const s = Math.sin(clamp(lat, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT) * DEG);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

export const mercYToLat = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / DEG;
