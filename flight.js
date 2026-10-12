/**
 * FlightMode — interactive jet fighter flight & combat simulation on the 3D globe.
 *
 * Integrates:
 *   - Su30Model (su30.js, default) and JetModel (aircraft.js, F-16) — procedural fighters with
 *     moving controls, plumes, lights & shadow; P switches between them
 *   - ExplosionSystem (explosions.js) — realistic multi-stage detonations & terrain scorch marks
 *   - FlightAudio (audio.js) — procedural Web Audio jet engine, sonic boom, bomb whistles & blasts
 *   - Globe coordinate math (geo.js) — seamless WGS84 positioning and elevation tracking
 */
import * as THREE from 'three';
import { JetModel, createShadowMesh, createBombMesh, disposeBombMesh } from './aircraft.js';
import { Su30Model } from './su30.js';
import { ExplosionSystem } from './explosions.js';
import { FlightAudio } from './audio.js';
import {
  DEG, EARTH_RADIUS_M, clamp, lerp, wrap180, wrapPi,
  latLonToVector3, vector3ToLatLon, eastNorthAt, placeLocalFrame, offsetLatLon,
} from './geo.js';

const G = 9.81;
const BOMB_DRAG = 0.06;   // horizontal velocity lost per second (1/s)
const BOMB_EJECT = 5;     // ejector rack push away from the aircraft (m/s)
const REARM_TIME = 3;     // seconds before an empty rack is reloaded
const CONTROL_LAG = 0.18; // s: time constant of the control inputs (rotation builds up and stops smoothly)
const CAMERA_LAG = 0.2;   // s: time constant of the chase camera following the aircraft's attitude
const BOMB_YIELD = { mk82: 250, mk84: 1000, big: 8000 }; // kg

export class FlightSystem {
  /**
   * @param {object} p
   * @param {THREE.Scene} p.scene
   * @param {THREE.WebGLRenderer} p.renderer
   * @param {THREE.PerspectiveCamera} p.camera
   * @param {object} p.controls       GlobeControls instance
   * @param {object} p.tiles          TileEngine instance
   * @param {object} p.earthUniforms  uniforms.earth
   * @param {Function} p.getWorldEnv  () => { sunDir, sunColor, ambient }
   */
  constructor({ scene, renderer, camera, controls, tiles, earthUniforms, getWorldEnv }) {
    this.scene = scene;
    this.renderer = renderer;
    this.camera = camera;
    this.controls = controls;
    this.tiles = tiles;
    this.getWorldEnv = getWorldEnv;

    // Subsystems
    this.explosions = new ExplosionSystem({
      scene,
      renderer,
      earthUniforms,
      getGroundM: (lat, lon) => this.getGroundM(lat, lon),
      quality: 1,
    });
    this.audio = new FlightAudio();
    this.aircraft = { su30: new Su30Model({ renderer }), f16: new JetModel({ renderer }) };
    this.aircraftType = 'su30';
    this.jet = this.aircraft.su30;
    this.shadow = createShadowMesh(this.jet.shadowOutline, this.jet.shadowExtent);

    // Flight root containers (both aircraft are built once; only the selected one is shown)
    this.flightGroup = new THREE.Group();
    this.flightGroup.name = 'flight-group';
    this.flightGroup.visible = false;
    this.scene.add(this.flightGroup);
    for (const model of Object.values(this.aircraft)) {
      model.group.visible = model === this.jet;
      this.flightGroup.add(model.group);
    }

    this.shadowGroup = new THREE.Group();
    this.shadowGroup.name = 'flight-shadow';
    this.shadowGroup.visible = false;
    this.scene.add(this.shadowGroup);
    this.shadowGroup.add(this.shadow);

    // Bullet tracer system
    this.bulletGeo = new THREE.BufferGeometry();
    const bPos = new Float32Array(200 * 6);
    this.bulletGeo.setAttribute('position', new THREE.BufferAttribute(bPos, 3));
    this.bulletMat = new THREE.LineBasicMaterial({
      color: 0xffe066,
      linewidth: 2,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
    });
    this.bulletLines = new THREE.LineSegments(this.bulletGeo, this.bulletMat);
    this.bulletLines.frustumCulled = false;
    this.scene.add(this.bulletLines);

    // Projectile tracking
    this.bombs = [];
    this.bullets = [];
    this.missiles = [];
    this.bombIdCounter = 0;
    this.missileGeo = new THREE.CylinderGeometry(0.08, 0.08, 2.8, 10).rotateX(Math.PI / 2);
    this.missileMat = new THREE.MeshStandardMaterial({ color: 0xeeeeee, roughness: 0.4 });

    // Flight state
    this.active = false;
    this.alive = true;
    this.respawnTimer = 0;

    // Position & Attitude
    this.lat = 21.0285;   // default Hanoi
    this.lon = 105.8542;
    this.altM = 2200;     // metres
    this.speed = 240;     // m/s (~864 km/h)
    this.heading = 0;     // radians, 0 = North, + = clockwise
    this.pitch = 0;       // radians, + = nose up
    this.roll = 0;        // radians, + = bank right
    this.throttle = 0.85; // 0..1
    this.afterburner = 0; // 0..1
    this.gForce = 1.0;
    this.vs = 0;          // vertical speed m/s
    this.ctrl = { pitch: 0, roll: 0, yaw: 0 }; // smoothed control inputs −1..1

    // Input state
    this.keys = new Set();
    this.mouseFiring = false;
    this._firePressed = false; // Space / left click since the last update
    this.cameraMode = 0;  // 0: chase, 1: cockpit

    // Weapons
    this.weapon = 'bomb'; // 'cannon' | 'bomb' | 'missile'
    this.bombKind = 'mk82';
    this.bombCount = 4;
    this.maxBombs = 4;
    this.bombIndex = 0;
    this.rearmCooldown = 0;
    this.cannonCooldown = 0;
    this.missileCooldown = 0;

    // Reusable math objects
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._vCam = new THREE.Vector3();
    this._vLook = new THREE.Vector3();
    this._vUp = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._camQ = new THREE.Quaternion(); // chase camera attitude (aircraft frame, smoothed)
    this._camPull = 0;                   // extra chase distance on afterburner (m)
    this._camSnap = true;                // next camera update jumps to its target
    this._euler = new THREE.Euler();
    this._m = new THREE.Matrix4();

    // Dedicated aircraft illumination
    this.fillLight = new THREE.DirectionalLight(0xffffff, 1.2);
    this.fillLight.position.set(0, 12, 18);
    this.flightGroup.add(this.fillLight);

    // DOM bindings
    this._initDom();
    this._bindEvents();
  }

  _initDom() {
    this.hud = document.getElementById('flight-hud');
    this.btnFlight = document.getElementById('btn-flight');
    this.btnExit = document.getElementById('fhud-exit');
    this.elSpd = document.getElementById('fhud-spd');
    this.elAlt = document.getElementById('fhud-alt');
    this.elHdg = document.getElementById('fhud-heading');
    this.elThr = document.getElementById('fhud-thr');
    this.elAb = document.getElementById('fhud-ab');
    this.elG = document.getElementById('fhud-g');
    this.elVs = document.getElementById('fhud-vs');
    this.elWpn = document.getElementById('fhud-wpn');
    this.elAircraft = document.getElementById('fhud-aircraft');
    this.elAmmo = document.getElementById('fhud-ammo');
    this.elPullUp = document.getElementById('fhud-pullup');
    this.elFlash = document.getElementById('flash');
  }

  _bindEvents() {
    window.addEventListener('keydown', (e) => this._onKeyDown(e));
    window.addEventListener('keyup', (e) => this._onKeyUp(e));
    window.addEventListener('mousedown', (e) => {
      if (!this.active) return;
      // Only clicks on the 3D view fire (not the HUD, panels or sliders)
      if (e.button === 0 && e.target === this.renderer.domElement) {
        this.mouseFiring = true;
        this._firePressed = true;
      }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouseFiring = false;
    });
    // Keys released while the window is in the background never send keyup
    window.addEventListener('blur', () => this._releaseInputs());

    if (this.btnFlight) {
      this.btnFlight.addEventListener('click', () => this.toggle());
    }
    if (this.btnExit) {
      this.btnExit.addEventListener('click', () => this.exit());
    }
  }

  _onKeyDown(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      this.toggle();
      return;
    }

    if (!this.active) return;

    if (e.key === 'Escape') {
      e.preventDefault();
      this.exit();
      return;
    }

    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault(); // no page scroll
    // Latched here: a tap shorter than a frame would be missed by update(); auto-repeat ignored
    if (e.code === 'Space' && !e.repeat) this._firePressed = true;
    this.keys.add(e.code);

    if (e.code === 'KeyC') {
      this.cameraMode = (this.cameraMode + 1) % 2;
    } else if (e.code === 'Digit1') {
      this.setWeapon('cannon');
    } else if (e.code === 'Digit2') {
      this.setWeapon('bomb');
    } else if (e.code === 'Digit3') {
      this.setWeapon('missile');
    } else if (e.code === 'KeyB') {
      const modes = ['cannon', 'bomb', 'missile'];
      const next = modes[(modes.indexOf(this.weapon) + 1) % modes.length];
      this.setWeapon(next);
    } else if (e.code === 'KeyR') {
      this.rearm();
    } else if (e.code === 'KeyP') {
      this.setAircraft(this.aircraftType === 'su30' ? 'f16' : 'su30');
    }
  }

  _onKeyUp(e) {
    this.keys.delete(e.code);
    // A focused button is clicked on Space keyup: it would toggle the flight off
    if (this.active && e.code === 'Space') e.preventDefault();
  }

  _releaseInputs() {
    this.keys.clear();
    this.mouseFiring = false;
    this._firePressed = false;
  }

  setWeapon(wpn) {
    this.weapon = wpn;
    if (this.elWpn) {
      const names = this.jet.labels;
      this.elWpn.textContent = wpn === 'cannon' ? names.cannon : wpn === 'bomb' ? names.bombs[this.bombKind] : names.missile;
    }
    this._updateAmmoDisplay();
  }

  /** Switches the aircraft ('su30' | 'f16') in place: same position, attitude and speed. */
  setAircraft(type) {
    const next = this.aircraft[type];
    if (!next || next === this.jet) return;
    next.group.visible = this.jet.group.visible;
    next.group.quaternion.copy(this.jet.group.quaternion);
    next.setEnvironmentFrame(this.flightGroup.quaternion);
    this.jet.group.visible = false;
    this.jet = next;
    this.aircraftType = type;
    this._camSnap = true; // other chase distance: jump there instead of sliding

    // Its own ground shadow and pylons
    this.shadowGroup.remove(this.shadow);
    this.shadow.geometry.dispose();
    this.shadow.material.alphaMap.dispose();
    this.shadow.material.dispose();
    this.shadow = createShadowMesh(next.shadowOutline, next.shadowExtent);
    this.shadowGroup.add(this.shadow);
    this.flightGroup.updateMatrixWorld(true);
    this.rearm();
    this.setWeapon(this.weapon);
    if (this.elAircraft) this.elAircraft.textContent = next.name;
  }

  _updateAmmoDisplay() {
    if (!this.elAmmo) return;
    if (this.weapon === 'cannon') {
      this.elAmmo.textContent = '∞';
    } else if (this.weapon === 'bomb') {
      this.elAmmo.textContent = this.bombCount > 0 ? this.bombCount.toString() : 'RLD';
    } else if (this.weapon === 'missile') {
      this.elAmmo.textContent = '4';
    }
  }

  getGroundM(lat, lon) {
    if (!this.tiles) return 0;
    return this.tiles.getHeight(lat, lon) * EARTH_RADIUS_M;
  }

  /**
   * Enters flight mode at the globe's current view center or focus.
   */
  enter() {
    if (this.active) return;

    // Use current controls coordinate
    this.lat = clamp(this.controls.lat || 21.0285, -82, 82);
    this.lon = wrap180(this.controls.lon || 105.8542);
    const groundM = this.getGroundM(this.lat, this.lon);
    this.altM = Math.max(groundM + 1200, 1800);
    this.heading = this.controls.heading || 0;
    this.pitch = 0;
    this.roll = 0;
    this.speed = 240;
    this.throttle = 0.85;
    this.afterburner = 0;
    this.ctrl.pitch = this.ctrl.roll = this.ctrl.yaw = 0;
    this.alive = true;
    this.respawnTimer = 0;
    this.jet.group.visible = true;
    if (this.elAircraft) this.elAircraft.textContent = this.jet.name;
    this._releaseInputs();
    this.rearm();
    this.setWeapon(this.weapon);

    // The "Fly Jet" button keeps the focus after the click: Space would press it again
    document.activeElement?.blur?.();

    // Disable standard camera control
    this.controls.enabled = false;

    // Show flight visual nodes
    this.flightGroup.visible = true;
    this.shadowGroup.visible = true;
    this.active = true;

    // Start Audio
    this.audio.start();

    // Update UI
    if (this.btnFlight) this.btnFlight.classList.add('on');
    if (this.hud) this.hud.removeAttribute('hidden');
    // Position aircraft in world immediately and snap camera
    placeLocalFrame(this.flightGroup, this.lat, this.lon, this.altM);
    this.jet.group.rotation.set(this.pitch, -this.heading, -this.roll, 'YXZ');
    this.jet.setEnvironmentFrame(this.flightGroup.quaternion);
    this.flightGroup.updateMatrixWorld(true);
    this._updateCamera(0.016, true);

    // Notify earth shader of initial explosions
    this.explosions._writeEarthUniforms(this.camera);
  }

  /**
   * Exits flight mode and returns camera control back to Earth explorer.
   */
  exit() {
    if (!this.active) return;

    this.active = false;
    this.flightGroup.visible = false;
    this.shadowGroup.visible = false;

    // Clear active projectiles
    this._clearProjectiles();
    this._releaseInputs();

    // Stop audio
    this.audio.stop();

    // Hand pose back to GlobeControls
    this.controls.lat = this.lat;
    this.controls.lon = this.lon;
    this.controls.heading = this.heading;
    this.controls.tilt = 45 * DEG;
    this.controls.range = clamp((this.altM / EARTH_RADIUS_M) * 3, 0.001, 0.05);
    this.controls.enabled = true;

    // Update UI
    if (this.btnFlight) this.btnFlight.classList.remove('on');
    if (this.hud) this.hud.setAttribute('hidden', '');
    if (this.elPullUp) this.elPullUp.hidden = true;
  }

  toggle() {
    if (this.active) this.exit();
    else this.enter();
  }

  rearm() {
    this.maxBombs = this.jet.stores[this.bombKind]?.length || 4; // one bomb per pylon
    this.bombCount = this.maxBombs;
    this.bombIndex = 0;
    this.rearmCooldown = 0;
    this.jet.setStores(this.bombKind);
    this._updateAmmoDisplay();
  }

  _clearProjectiles() {
    for (const b of this.bombs) {
      this.audio.stopWhistle(b.id);
      disposeBombMesh(b.mesh);
      this.scene.remove(b.mesh);
    }
    this.bombs = [];
    this.bullets = [];
    for (const m of this.missiles) {
      if (m.mesh) this.scene.remove(m.mesh);
    }
    this.missiles = [];
    // Reset bullet tracer buffer
    const p = this.bulletGeo.attributes.position.array;
    p.fill(0);
    this.bulletGeo.attributes.position.needsUpdate = true;
  }

  crash() {
    if (!this.alive) return;
    this.alive = false;
    this.respawnTimer = 2.4;
    // The airframe is gone: only the fireball stays
    this.jet.group.visible = false;
    this.shadow.visible = false;
    this.audio.setWarning(false);
    if (this.elPullUp) this.elPullUp.hidden = true;

    const groundM = this.getGroundM(this.lat, this.lon);
    this.explosions.spawn({
      lat: this.lat,
      lon: this.lon,
      groundM,
      yieldKg: 3000,
      water: false,
    });
    this.audio.explosion({ distance: 15, yieldKg: 3000 });

    if (this.elFlash) {
      this.elFlash.classList.remove('go');
      void this.elFlash.offsetWidth; // retrigger
      this.elFlash.classList.add('go');
    }
  }

  _respawn() {
    this.alive = true;
    this.jet.group.visible = true;
    this.ctrl.pitch = this.ctrl.roll = this.ctrl.yaw = 0;
    this._camSnap = true;
    const groundM = this.getGroundM(this.lat, this.lon);
    this.altM = groundM + 1600;
    this.pitch = 0;
    this.roll = 0;
    this.speed = 220;
    this.rearm();
  }

  /* ------------------------------------------------------------------ */
  /* Weapons Actions                                                     */
  /* ------------------------------------------------------------------ */
  fire() {
    if (!this.alive) return;
    if (this.weapon === 'cannon') {
      this.fireCannon();
    } else if (this.weapon === 'bomb') {
      this.fireBomb();
    } else if (this.weapon === 'missile') {
      this.fireMissile();
    }
  }

  fireCannon() {
    if (this.cannonCooldown > 0) return;
    this.cannonCooldown = 0.055; // ~18 rounds/sec

    // Bullet origin at jet nose
    this._v1.copy(this.jet.gun).applyMatrix4(this.jet.group.matrixWorld);

    // Direction along nose
    this._v2.set(
      Math.sin(this.heading) * Math.cos(this.pitch) + (Math.random() - 0.5) * 0.012,
      Math.sin(this.pitch) + (Math.random() - 0.5) * 0.012,
      -Math.cos(this.heading) * Math.cos(this.pitch) + (Math.random() - 0.5) * 0.012
    ).normalize();

    const bulletSpeed = this.speed + 950; // m/s
    this.bullets.push({
      lat: this.lat,
      lon: this.lon,
      altM: this.altM,
      vx: this._v2.x * bulletSpeed,
      vy: this._v2.y * bulletSpeed,
      vz: this._v2.z * bulletSpeed,
      life: 2.2,
      prevWorld: this._v1.clone(),
    });

    this.audio.cannonFire();
  }

  fireBomb() {
    if (this.bombCount <= 0) return; // racks empty: reloaded after REARM_TIME (or R)

    this.bombCount--;
    if (this.bombCount === 0) this.rearmCooldown = REARM_TIME;
    this._updateAmmoDisplay();

    // Release point under its pylon and the ejector push, turned by the aircraft attitude
    // into the local frame (metres: +X east, +Y up, +Z south)
    const q = this.jet.group.quaternion;
    const rel = this.jet.releaseStore(this.bombKind, this.bombIndex++).applyQuaternion(q);
    const eject = this._v2.set(0, -BOMB_EJECT, 0).applyQuaternion(q);
    const start = offsetLatLon(this.lat, this.lon, rel.x, -rel.z);

    // The bomb keeps the aircraft's velocity
    const fx = Math.sin(this.heading) * Math.cos(this.pitch);
    const fy = Math.sin(this.pitch);
    const fz = -Math.cos(this.heading) * Math.cos(this.pitch);

    const bombId = ++this.bombIdCounter;
    this.audio.bombRelease();
    this.audio.startWhistle(bombId);

    const bomb = {
      id: bombId,
      lat: start.lat,
      lon: start.lon,
      altM: this.altM + rel.y,
      startAltM: this.altM + rel.y,
      vx: fx * this.speed + eject.x,
      vy: fy * this.speed + eject.y,
      vz: fz * this.speed + eject.z,
      mesh: createBombMesh(this.bombKind, this.jet.envMap),
      kind: this.bombKind,
    };
    this._placeProjectile(bomb); // placed before it is first drawn
    this.scene.add(bomb.mesh);
    this.bombs.push(bomb);
  }

  fireMissile() {
    if (this.missileCooldown > 0) return;
    this.missileCooldown = 0.5;

    const fx = Math.sin(this.heading) * Math.cos(this.pitch);
    const fy = Math.sin(this.pitch);
    const fz = -Math.cos(this.heading) * Math.cos(this.pitch);

    this.audio.missileLaunch();

    const missile = {
      lat: this.lat,
      lon: this.lon,
      altM: this.altM,
      vx: fx * (this.speed + 120),
      vy: fy * (this.speed + 120),
      vz: fz * (this.speed + 120),
      mesh: new THREE.Mesh(this.missileGeo, this.missileMat), // shared: nothing to dispose
      life: 3.5,
    };
    this._placeProjectile(missile);
    this.scene.add(missile.mesh);
    this.missiles.push(missile);
  }

  /**
   * Puts a bomb or missile at its position with the nose along its velocity. The attitude is
   * composed with the local frame set by placeLocalFrame (setting `rotation` would replace it).
   */
  _placeProjectile(p) {
    placeLocalFrame(p.mesh, p.lat, p.lon, p.altM);
    const hdg = Math.atan2(p.vx, -p.vz);
    const pitch = Math.atan2(p.vy, Math.hypot(p.vx, p.vz));
    p.mesh.quaternion.multiply(this._q.setFromEuler(this._euler.set(pitch, -hdg, 0, 'YXZ')));
  }

  /* ------------------------------------------------------------------ */
  /* Main Simulation Update Loop                                        */
  /* ------------------------------------------------------------------ */
  update(dt) {
    // Explosions continue evolving whether aircraft is active or not
    if (this.explosions.active) {
      const env = this.getWorldEnv ? this.getWorldEnv() : {
        sunDir: new THREE.Vector3(0, 1, 0),
        sunColor: new THREE.Color(1, 1, 1),
        ambient: new THREE.Color(0.3, 0.33, 0.4),
      };
      this.explosions.update(dt, this.camera, env);
    }

    if (!this.active) return;

    // Respawn countdown if crashed: bombs already released keep falling, the engine falls silent
    if (!this.alive) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this._respawn();
      this._firePressed = false; // no shot queued up for the respawn
      this._updateProjectiles(dt);
      this._updateCamera(dt);
      this.audio.update({ throttle: 0, afterburner: 0, speed: 0, distance: 30, alive: false });
      return;
    }

    // Cooldowns
    if (this.cannonCooldown > 0) this.cannonCooldown -= dt;
    if (this.missileCooldown > 0) this.missileCooldown -= dt;
    if (this.rearmCooldown > 0) {
      this.rearmCooldown -= dt;
      if (this.rearmCooldown <= 0) this.rearm();
    }

    // Trigger (Space or left mouse button): the cannon fires while held, bombs and missiles once per press
    const held = this.mouseFiring || this.keys.has('Space');
    if (this._firePressed || (held && this.weapon === 'cannon')) this.fire();
    this._firePressed = false;

    // Inputs
    let inputPitch = 0;
    let inputRoll = 0;
    let inputYaw = 0;

    // W = nose down (pitch -), S = pull up (pitch +)
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) inputPitch += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) inputPitch -= 1;

    // A = roll left, D = roll right
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) inputRoll -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) inputRoll += 1;

    // Q/E = Rudder yaw
    if (this.keys.has('KeyQ')) inputYaw -= 1;
    if (this.keys.has('KeyE')) inputYaw += 1;

    // Throttle: Shift = boost / afterburner, Ctrl = airbrake
    if (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) {
      this.throttle = Math.min(1.0, this.throttle + dt * 0.8);
      this.afterburner = Math.min(1.0, this.afterburner + dt * 4.0);
    } else {
      this.afterburner = Math.max(0.0, this.afterburner - dt * 5.0);
      if (this.keys.has('ControlLeft') || this.keys.has('ControlRight')) {
        this.throttle = Math.max(0.2, this.throttle - dt * 0.7);
      }
    }

    // The keys are on/off: the aircraft has inertia, so the rotation rates build up and die
    // down over a fraction of a second instead of jumping (frame-rate independent)
    const c = this.ctrl;
    const follow = 1 - Math.exp(-dt / CONTROL_LAG);
    c.pitch += (inputPitch - c.pitch) * follow;
    c.roll += (inputRoll - c.roll) * follow;
    c.yaw += (inputYaw - c.yaw) * follow;

    // Aerodynamics & Kinematics
    const pitchRate = 1.35; // rad/s
    const rollRate = 2.4;   // rad/s
    this.pitch = clamp(this.pitch + c.pitch * pitchRate * dt, -75 * DEG, 80 * DEG);
    this.roll = wrapPi(this.roll + c.roll * rollRate * dt);

    // Auto level assist when no roll input
    if (inputRoll === 0) {
      this.roll *= Math.exp(-dt * 1.5);
    }

    // Coordinated aerodynamic banking turn
    const bankTurn = (G * Math.tan(this.roll)) / Math.max(this.speed, 60);
    this.heading = wrapPi(this.heading + (bankTurn + c.yaw * 0.45) * dt);

    // Speed computation
    const targetSpeed = 150 + this.throttle * 130 + this.afterburner * 240;
    this.speed += (targetSpeed - this.speed) * (1 - Math.exp(-dt * 1.6));

    // Forward direction in local East-Up-North:
    // +X = East, +Y = Up, -Z = North
    const fx = Math.sin(this.heading) * Math.cos(this.pitch);
    const fy = Math.sin(this.pitch);
    const fz = -Math.cos(this.heading) * Math.cos(this.pitch);

    // Gravity effect on airspeed (dives accelerate, climbs decelerate)
    this.speed = clamp(this.speed - fy * G * dt * 0.5, 90, 560);
    this.vs = fy * this.speed;

    // G-force calculation: 1g + centripetal turn & pull
    this.gForce = clamp(1.0 + Math.abs(c.pitch) * 2.8 + Math.abs(Math.sin(this.roll)) * 2.0, 0.4, 7.5);

    // Coordinate translation
    const dEast = fx * this.speed * dt;
    const dNorth = -fz * this.speed * dt;
    const dAlt = fy * this.speed * dt;

    const nextLL = offsetLatLon(this.lat, this.lon, dEast, dNorth);
    this.lat = clamp(nextLL.lat, -84, 84);
    this.lon = nextLL.lon;
    this.altM += dAlt;

    // Ground elevation & terrain collision
    const groundM = this.getGroundM(this.lat, this.lon);
    if (this.altM <= groundM + 4) {
      this.crash();
      return;
    }

    // Pull up warning
    const terrainClearance = this.altM - groundM;
    const warning = terrainClearance < 260 && fy < -0.1;
    this.audio.setWarning(warning);
    if (this.elPullUp) this.elPullUp.hidden = !warning;

    // Position aircraft in world
    placeLocalFrame(this.flightGroup, this.lat, this.lon, this.altM);
    this.jet.group.rotation.set(this.pitch, -this.heading, -this.roll, 'YXZ');
    this.jet.setEnvironmentFrame(this.flightGroup.quaternion);
    this.flightGroup.updateMatrixWorld(true);

    // The globe view (HD tiles, 3D terrain, clouds, labels) is driven by the controls' pose:
    // keep it over the aircraft, otherwise a flight started from space has no terrain and
    // bombs detonate at sea level
    this.controls.lat = this.lat;
    this.controls.lon = this.lon;
    this.controls.range = clamp(terrainClearance / EARTH_RADIUS_M, this.controls.minRange, 0.05);

    // Jet model animations (nozzle plume, tailerons, rudder, strobe)
    this.jet.update({
      time: performance.now() / 1000,
      throttle: this.throttle,
      afterburner: this.afterburner,
      daylight: 1,
      pitch: c.pitch,
      roll: c.roll,
      yaw: c.yaw,
    });

    // Shadow on ground
    placeLocalFrame(this.shadowGroup, this.lat, this.lon, groundM + 0.6);
    this.shadow.rotation.y = -this.heading;
    const shadowScale = clamp(1.0 - terrainClearance / 1200, 0, 1);
    this.shadow.scale.setScalar(shadowScale);
    this.shadow.visible = shadowScale > 0.02;

    // Update Projectiles
    this._updateProjectiles(dt);

    // Update Camera
    this._updateCamera(dt);

    // Update Flight Audio engine
    // flightGroup sits at the aircraft (jet.group.position is local: always 0)
    const camDist = this.camera.position.distanceTo(this.flightGroup.position) * EARTH_RADIUS_M;
    this.audio.update({
      throttle: this.throttle,
      afterburner: this.afterburner,
      speed: this.speed,
      distance: camDist || 30,
      alive: this.alive,
    });

    // Update HUD overlay
    this._updateHud();
  }

  /* ------------------------------------------------------------------ */
  /* Projectile physics & collision                                     */
  /* ------------------------------------------------------------------ */
  _updateProjectiles(dt) {
    // 1. Bullets
    const posAttr = this.bulletGeo.attributes.position;
    const posArr = posAttr.array;
    let lineIdx = 0;

    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.life -= dt;

      // Update position
      const dEast = b.vx * dt;
      const dNorth = -b.vz * dt;
      const nextLL = offsetLatLon(b.lat, b.lon, dEast, dNorth);
      b.lat = nextLL.lat;
      b.lon = nextLL.lon;
      b.altM += b.vy * dt;

      const groundM = this.getGroundM(b.lat, b.lon);
      const curWorld = latLonToVector3(b.lat, b.lon, 1 + b.altM / EARTH_RADIUS_M);

      if (b.altM <= groundM || b.life <= 0) {
        // Impact
        if (b.altM <= groundM + 8) {
          // No scorch mark: 18 rounds/s would push the bomb craters out of the 8 slots
          this.explosions.spawn({ lat: b.lat, lon: b.lon, groundM, yieldKg: 20, scorch: false });
        }
        this.bullets.splice(i, 1);
        continue;
      }

      // Draw tracer line segment
      if (lineIdx < 190) {
        posArr[lineIdx * 6 + 0] = b.prevWorld.x;
        posArr[lineIdx * 6 + 1] = b.prevWorld.y;
        posArr[lineIdx * 6 + 2] = b.prevWorld.z;
        posArr[lineIdx * 6 + 3] = curWorld.x;
        posArr[lineIdx * 6 + 4] = curWorld.y;
        posArr[lineIdx * 6 + 5] = curWorld.z;
        lineIdx++;
      }
      b.prevWorld.copy(curWorld);
    }

    // Zero out unused lines
    for (let j = lineIdx * 6; j < posArr.length; j++) posArr[j] = 0;
    posAttr.needsUpdate = true;

    // 2. Bombs
    for (let i = this.bombs.length - 1; i >= 0; i--) {
      const b = this.bombs[i];
      b.vy -= G * dt; // gravity
      const drag = Math.exp(-BOMB_DRAG * dt); // same slowdown at any frame rate
      b.vx *= drag;
      b.vz *= drag;

      const dEast = b.vx * dt;
      const dNorth = -b.vz * dt;
      const nextLL = offsetLatLon(b.lat, b.lon, dEast, dNorth);
      b.lat = nextLL.lat;
      b.lon = nextLL.lon;
      b.altM += b.vy * dt;

      const groundM = this.getGroundM(b.lat, b.lon);

      // Position bomb mesh, nose along its velocity
      this._placeProjectile(b);

      // Update falling whistle
      const camWorld = this.camera.position;
      const bombWorld = b.mesh.position;
      const distance = bombWorld.distanceTo(camWorld) * EARTH_RADIUS_M;
      const progress = clamp(1 - (b.altM - groundM) / Math.max(b.startAltM - groundM, 100), 0, 1);
      this.audio.updateWhistle(b.id, { distance, progress });

      if (b.altM <= groundM) {
        // Impact Detonation
        this.audio.stopWhistle(b.id);
        const yieldKg = BOMB_YIELD[b.kind] ?? 250;
        this.explosions.spawn({ lat: b.lat, lon: b.lon, groundM, yieldKg, water: false });
        this.audio.explosion({ distance, yieldKg });

        disposeBombMesh(b.mesh);
        this.scene.remove(b.mesh);
        this.bombs.splice(i, 1);
      }
    }

    // 3. Missiles
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      m.life -= dt;

      const dEast = m.vx * dt;
      const dNorth = -m.vz * dt;
      const nextLL = offsetLatLon(m.lat, m.lon, dEast, dNorth);
      m.lat = nextLL.lat;
      m.lon = nextLL.lon;
      m.altM += m.vy * dt;

      const groundM = this.getGroundM(m.lat, m.lon);
      this._placeProjectile(m);

      if (m.altM <= groundM || m.life <= 0) {
        if (m.altM <= groundM + 12) {
          this.explosions.spawn({ lat: m.lat, lon: m.lon, groundM, yieldKg: 600 });
          const dist = m.mesh.position.distanceTo(this.camera.position) * EARTH_RADIUS_M;
          this.audio.explosion({ distance: dist, yieldKg: 600 });
        }
        this.scene.remove(m.mesh);
        this.missiles.splice(i, 1);
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Camera positioning (Chase & Cockpit)                               */
  /* ------------------------------------------------------------------ */
  _updateCamera(dt, snap = false) {
    if (!this.flightGroup.visible) return;
    const attitude = this.jet.group.quaternion;
    if (snap || this._camSnap) {
      this._camQ.copy(attitude);
      this._camPull = 0;
      this._camSnap = false;
    }

    if (this.cameraMode === 0) {
      // Chase camera. Its position is tied to the aircraft (a world-space lerp towards a target
      // moving at 240 m/s left it ~13 m behind, a gap that changed with every uneven frame time
      // and made the aircraft jerk back and forth); only its attitude follows with a short delay.
      this._camQ.slerp(attitude, 1 - Math.exp(-dt / CAMERA_LAG));
      this._camPull += (this.afterburner * 5 - this._camPull) * (1 - Math.exp(-dt * 2)); // drops back on afterburner
      const frame = this.flightGroup.matrixWorld; // the aircraft sits at its origin (metres, ENU)
      this._vCam.copy(this.jet.chaseOffset);
      this._vCam.z += this._camPull;
      this._vCam.applyQuaternion(this._camQ).applyMatrix4(frame);
      this._vLook.copy(this.jet.chaseLook).applyQuaternion(this._camQ).applyMatrix4(frame);
      this._vUp.set(0, 1, 0).applyQuaternion(this._camQ).transformDirection(frame);
    } else {
      // Cockpit view (first person from inside the canopy)
      this._camQ.copy(attitude);
      const m = this.jet.group.matrixWorld;
      this._vCam.copy(this.jet.cockpitEye).applyMatrix4(m);
      this._vLook.copy(this.jet.cockpitEye).setZ(this.jet.cockpitEye.z - 22).applyMatrix4(m);
      this._vUp.set(0, 1, 0).transformDirection(m);
    }

    this.camera.position.copy(this._vCam);
    this.camera.up.copy(this._vUp);
    this.camera.lookAt(this._vLook);
    this.camera.updateMatrixWorld();
  }

  /* ------------------------------------------------------------------ */
  /* Flight HUD display update                                          */
  /* ------------------------------------------------------------------ */
  _updateHud() {
    if (!this.hud || this.hud.hidden) return;

    const knots = Math.round(this.speed * 1.94384);
    const feet = Math.round(this.altM * 3.28084);
    const degHdg = Math.round((this.heading * (180 / Math.PI) + 360) % 360);

    if (this.elSpd) this.elSpd.textContent = knots.toString();
    if (this.elAlt) this.elAlt.textContent = feet.toLocaleString();
    if (this.elHdg) this.elHdg.textContent = `HDG ${degHdg.toString().padStart(3, '0')}°`;
    if (this.elThr) this.elThr.textContent = `${Math.round(this.throttle * 100)}%`;
    if (this.elAb) {
      this.elAb.textContent = this.afterburner > 0.1 ? 'AB' : 'MIL';
      this.elAb.classList.toggle('ab', this.afterburner > 0.1);
    }
    if (this.elG) this.elG.textContent = this.gForce.toFixed(1);
    if (this.elVs) {
      const fpm = Math.round(this.vs * 196.85);
      this.elVs.textContent = `${fpm >= 0 ? '+' : ''}${fpm}`;
    }
  }
}
