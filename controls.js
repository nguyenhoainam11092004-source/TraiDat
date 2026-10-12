/**
 * GlobeControls — Google-Earth-style navigation around a unit sphere.
 *
 * The camera is described by a geographic pose:
 *   lat, lon  the point on the ground the camera looks at (degrees)
 *   range     distance from that point to the camera (Earth radii)
 *   heading   compass direction of the top of the screen (radians, 0 = north up)
 *   tilt      angle between the view and straight down (radians, 0 = top-down)
 *
 * Mouse   left-drag: move (at sensitivity 1 the point under the cursor follows it)
 *         right/middle-drag or Ctrl/Shift + drag: rotate (left/right) and tilt (up/down)
 *         wheel: zoom towards the cursor
 * Touch   one finger: move · pinch: zoom · twist: rotate · two fingers up/down: tilt
 *
 * Events  'start' when the user begins interacting, 'end' when they stop.
 *
 * Unlike OrbitControls (which orbits the globe centre), zoom is applied to the
 * distance from the ground, so the camera can come down to a few hundred metres.
 */
import { EventDispatcher, Raycaster, Sphere, Vector2, Vector3 } from 'three';
import {
  DEG, clamp, lerp, smoothstep, wrap180, wrapPi, latLonToVector3, vector3ToLatLon, eastNorthAt,
} from './geo.js';

const _U = new Vector3();
const _E = new Vector3();
const _N = new Vector3();
const _H = new Vector3();
const _P = new Vector3();
const _D = new Vector3();
const _C = new Vector3();
const _ndc = new Vector2();

export class GlobeControls extends EventDispatcher {
  constructor(camera, domElement) {
    super();
    this.camera = camera;
    this.domElement = domElement;
    this.enabled = true;

    // Pose
    this.lat = 0;
    this.lon = 0;
    this.range = 3;
    this.heading = 0;
    this.tilt = 0;

    // Limits & tuning
    this.minRange = 1e-4;       // ≈ 640 m above the ground
    this.maxRange = 12;
    this.maxTiltDeg = 80;
    this.minClearance = 5e-6;   // ≈ 30 m: the camera never goes below the terrain
    this.rotateSpeed = 0.0045;  // heading change per pixel (radians)
    this.tiltSpeed = 0.004;     // tilt change per pixel (radians)
    this.zoomSpeed = 0.0016;    // per wheel delta unit
    /** Multiplier for dragging, rotating and tilting (1 = the ground follows the pointer). */
    this.sensitivity = 1;
    /** Terrain height (Earth radii) at a geographic point; provided by the app. */
    this.getHeight = () => 0;
    this.focusHeight = 0;
    /** Height of the focus point above sea level (Earth radii) instead of the terrain, e.g. an aircraft. */
    this.focusOverride = null;
    this.interacting = false;

    this._pointers = new Map();
    this._mode = null;          // 'move' | 'orbit' | 'touch'
    this._last = null;          // previous pointer position and time
    this._vel = { lat: 0, lon: 0 }; // inertia, degrees per second
    this._zoom = null;          // { target, anchor } smooth zoom in progress
    this._touch = null;
    this._raycaster = new Raycaster();
    this._sphere = new Sphere(new Vector3(), 1);

    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onContextMenu = (event) => event.preventDefault();

    domElement.addEventListener('pointerdown', this._onPointerDown);
    domElement.addEventListener('pointermove', this._onPointerMove);
    domElement.addEventListener('pointerup', this._onPointerUp);
    domElement.addEventListener('pointercancel', this._onPointerUp);
    domElement.addEventListener('wheel', this._onWheel, { passive: false });
    domElement.addEventListener('contextmenu', this._onContextMenu);
    domElement.style.touchAction = 'none';
  }

  dispose() {
    const el = this.domElement;
    el.removeEventListener('pointerdown', this._onPointerDown);
    el.removeEventListener('pointermove', this._onPointerMove);
    el.removeEventListener('pointerup', this._onPointerUp);
    el.removeEventListener('pointercancel', this._onPointerUp);
    el.removeEventListener('wheel', this._onWheel);
    el.removeEventListener('contextmenu', this._onContextMenu);
  }

  /** Largest tilt allowed at a given range: top-down whenever the whole globe is in view. */
  maxTilt(range = this.range) {
    return this.maxTiltDeg * DEG * (1 - smoothstep(0.05, 0.8, range));
  }

  getPose() {
    return { lat: this.lat, lon: this.lon, range: this.range, heading: this.heading, tilt: this.tilt };
  }

  setPose(pose) {
    if (pose.lat !== undefined) this.lat = clamp(pose.lat, -89.5, 89.5);
    if (pose.lon !== undefined) this.lon = wrap180(pose.lon);
    if (pose.range !== undefined) this.range = clamp(pose.range, this.minRange, this.maxRange);
    if (pose.heading !== undefined) this.heading = wrapPi(pose.heading);
    if (pose.tilt !== undefined) this.tilt = Math.max(0, pose.tilt);
  }

  /** Stops inertia and any smooth zoom in progress (e.g. before a scripted flight). */
  stop() {
    this._vel.lat = 0;
    this._vel.lon = 0;
    this._zoom = null;
  }

  /** Zooms by a factor (<1 = closer) towards a screen point, smoothly. */
  zoomBy(factor, clientX, clientY) {
    const rect = this.domElement.getBoundingClientRect();
    this._zoomAt(factor, clientX ?? rect.left + rect.width / 2, clientY ?? rect.top + rect.height / 2, false);
  }

  /** Geographic point under a screen position, or null when the ray misses the globe. */
  pick(clientX, clientY, radius = 1 + this.focusHeight) {
    if (!this._ray(clientX, clientY)) return null;
    this._sphere.radius = radius;
    const hit = this._raycaster.ray.intersectSphere(this._sphere, _C);
    return hit ? vector3ToLatLon(hit) : null;
  }

  /** Like pick(), but falls back to the closest point on the globe's outline. */
  _pickOrEdge(clientX, clientY) {
    const hit = this.pick(clientX, clientY);
    if (hit || !this._ray(clientX, clientY)) return hit;
    const { origin, direction } = this._raycaster.ray;
    const s = Math.max(-origin.dot(direction), 0);
    _C.copy(origin).addScaledVector(direction, s);
    return _C.lengthSq() > 1e-12 ? vector3ToLatLon(_C) : null;
  }

  _ray(clientX, clientY) {
    const rect = this.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    _ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this._raycaster.setFromCamera(_ndc, this.camera);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Pointer input                                                       */
  /* ------------------------------------------------------------------ */
  _onPointerDown(event) {
    if (!this.enabled) return;
    if (event.pointerType === 'mouse' && event.button > 2) return;
    try { this.domElement.setPointerCapture(event.pointerId); } catch { /* not supported */ }
    this._pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.stop();

    if (this._pointers.size === 1) {
      const orbit = event.pointerType === 'mouse'
        && (event.button === 1 || event.button === 2 || event.ctrlKey || event.shiftKey || event.metaKey);
      this._begin(orbit ? 'orbit' : 'move', event.clientX, event.clientY);
    } else if (this._pointers.size === 2) {
      this._beginTouch();
    }
    if (!this.interacting) {
      this.interacting = true;
      this.dispatchEvent({ type: 'start' });
    }
  }

  _onPointerMove(event) {
    const p = this._pointers.get(event.pointerId);
    if (!p || !this.enabled) return;
    p.x = event.clientX;
    p.y = event.clientY;
    if (this._mode === 'move') this._drag(p.x, p.y);
    else if (this._mode === 'orbit') this._orbit(p.x, p.y);
    else if (this._mode === 'touch') this._touchMove();
  }

  _onPointerUp(event) {
    if (!this._pointers.has(event.pointerId)) return;
    this._pointers.delete(event.pointerId);
    try { this.domElement.releasePointerCapture(event.pointerId); } catch { /* already released */ }

    if (this._pointers.size === 1) {
      // Lifting one finger of a pinch continues as a one-finger drag
      const [p] = this._pointers.values();
      this._begin('move', p.x, p.y);
      this._vel.lat = 0;
      this._vel.lon = 0;
      return;
    }
    if (this._pointers.size === 0) {
      // Keep the inertia only if the pointer was still moving when it was released
      const idle = performance.now() - (this._last?.t ?? 0) > 90;
      if (this._mode !== 'move' || idle) {
        this._vel.lat = 0;
        this._vel.lon = 0;
      }
      this._mode = null;
      this.interacting = false;
      this.dispatchEvent({ type: 'end' });
    }
  }

  _begin(mode, x, y) {
    this._mode = mode;
    this._last = { x, y, t: performance.now() };
  }

  /**
   * Moves the focus by the geographic distance between the previous and the current
   * pointer position. At sensitivity 1 the ground follows the pointer exactly.
   */
  _drag(x, y) {
    const now = performance.now();
    const from = this._pickOrEdge(this._last.x, this._last.y);
    const to = this._pickOrEdge(x, y);
    if (from && to) {
      const dLat = (from.lat - to.lat) * this.sensitivity;
      const dLon = wrap180(from.lon - to.lon) * this.sensitivity;
      this.lat = clamp(this.lat + dLat, -89.5, 89.5);
      this.lon = wrap180(this.lon + dLon);
      this._applyPose();

      const dt = Math.max((now - this._last.t) / 1000, 1 / 240);
      this._vel.lat = lerp(this._vel.lat, dLat / dt, 0.6);
      this._vel.lon = lerp(this._vel.lon, dLon / dt, 0.6);
    }
    this._last = { x, y, t: now };
  }

  _orbit(x, y) {
    const dx = x - this._last.x;
    const dy = y - this._last.y;
    this.heading = wrapPi(this.heading - dx * this.rotateSpeed * this.sensitivity);
    this.tilt = clamp(this.tilt - dy * this.tiltSpeed * this.sensitivity, 0, this.maxTilt());
    this._last = { x, y, t: performance.now() };
  }

  _beginTouch() {
    const [a, b] = [...this._pointers.values()];
    this._mode = 'touch';
    this._touch = {
      dist: Math.hypot(b.x - a.x, b.y - a.y),
      angle: Math.atan2(b.y - a.y, b.x - a.x),
      midY: (a.y + b.y) / 2,
    };
  }

  _touchMove() {
    const [a, b] = [...this._pointers.values()];
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const t = this._touch;
    if (t.dist > 10 && dist > 10) this._zoomAt(t.dist / dist, midX, midY, true);
    this.heading = wrapPi(this.heading - wrapPi(angle - t.angle) * this.sensitivity);
    this.tilt = clamp(this.tilt - (midY - t.midY) * this.tiltSpeed * 1.2 * this.sensitivity, 0, this.maxTilt());
    this._touch = { dist, angle, midY };
  }

  _onWheel(event) {
    if (!this.enabled) return;
    event.preventDefault();
    let dy = event.deltaY;
    if (event.deltaMode === 1) dy *= 33;
    else if (event.deltaMode === 2) dy *= 400;
    if (event.ctrlKey) dy *= 3; // trackpad pinch gestures report small deltas
    this._vel.lat = 0;
    this._vel.lon = 0;
    this._zoomAt(Math.exp(clamp(dy, -400, 400) * this.zoomSpeed), event.clientX, event.clientY, false);
    this.dispatchEvent({ type: 'start' });
    this.dispatchEvent({ type: 'end' });
  }

  _zoomAt(factor, x, y, immediate) {
    const anchor = this.pick(x, y);
    const base = this._zoom ? this._zoom.target : this.range;
    const target = clamp(base * factor, this.minRange, this.maxRange);
    if (immediate) {
      this._zoomStep(target / this.range, anchor);
      this._zoom = null;
    } else {
      this._zoom = { target, anchor };
    }
  }

  /** Changes the range by `ratio` while keeping `anchor` (if any) roughly under the pointer. */
  _zoomStep(ratio, anchor) {
    if (anchor) {
      const f = 1 - ratio;
      this.lat = clamp(this.lat + (anchor.lat - this.lat) * f, -89.5, 89.5);
      this.lon = wrap180(this.lon + wrap180(anchor.lon - this.lon) * f);
    }
    this.range = clamp(this.range * ratio, this.minRange, this.maxRange);
  }

  /* ------------------------------------------------------------------ */
  /* Per-frame update                                                    */
  /* ------------------------------------------------------------------ */
  update(dt) {
    if (!this.enabled) return;
    if (this._zoom) {
      const from = Math.log(this.range);
      const to = Math.log(this._zoom.target);
      const next = Math.abs(to - from) < 1e-3 ? this._zoom.target : Math.exp(lerp(from, to, 1 - Math.exp(-dt * 10)));
      this._zoomStep(next / this.range, this._zoom.anchor);
      if (next === this._zoom.target) this._zoom = null;
    }

    if (this._pointers.size === 0 && (this._vel.lat !== 0 || this._vel.lon !== 0)) {
      this.lat = clamp(this.lat + this._vel.lat * dt, -89.5, 89.5);
      this.lon = wrap180(this.lon + this._vel.lon * dt);
      const decay = Math.exp(-dt * 3.5);
      this._vel.lat *= decay;
      this._vel.lon *= decay;
      if (Math.hypot(this._vel.lat, this._vel.lon) < this.range * 0.02) this.stop();
    }

    this.range = clamp(this.range, this.minRange, this.maxRange);
    this.tilt = clamp(this.tilt, 0, this.maxTilt());
    if (this.focusOverride !== null) {
      this.focusHeight = this.focusOverride;
    } else {
      const ground = this.getHeight(this.lat, this.lon);
      this.focusHeight += (ground - this.focusHeight) * (1 - Math.exp(-dt * 8));
    }
    this._applyPose();
    this._keepAboveGround();
  }

  /** Places the camera from the pose (no roll, never degenerate at nadir). */
  _applyPose() {
    latLonToVector3(this.lat, this.lon, 1, _U);
    eastNorthAt(this.lat, this.lon, _E, _N);
    _H.copy(_N).multiplyScalar(Math.cos(this.heading)).addScaledVector(_E, Math.sin(this.heading));
    _P.copy(_U).multiplyScalar(1 + this.focusHeight);
    _D.copy(_U).multiplyScalar(Math.cos(this.tilt)).addScaledVector(_H, -Math.sin(this.tilt));
    this.camera.position.copy(_P).addScaledVector(_D, this.range);
    this.camera.up.copy(_U).multiplyScalar(Math.sin(this.tilt)).addScaledVector(_H, Math.cos(this.tilt));
    this.camera.lookAt(_P);
    this.camera.updateMatrixWorld();
  }

  /** Lowers the tilt (or backs off) when the camera would end up below the terrain. */
  _keepAboveGround() {
    for (let i = 0; i < 10; i++) {
      const pos = this.camera.position;
      const ll = vector3ToLatLon(pos);
      const clearance = pos.length() - 1 - this.getHeight(ll.lat, ll.lon);
      if (clearance >= this.minClearance) return;
      if (this.tilt > 0.01) this.tilt *= 0.8;
      else this.range += this.minClearance - clearance;
      this._applyPose();
    }
  }
}
