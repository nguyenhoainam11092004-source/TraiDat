/**
 * FlightAudio — every sound of the flight mode is synthesised with the Web Audio API
 * (no audio files): jet engine and afterburner, wind, bomb release, falling whistle,
 * explosions and warning tones.
 *
 * Explosions are heard after the light: the sound is delayed by distance / 343 m/s and
 * the air absorbs its high frequencies, so far blasts arrive late as a dull rumble.
 * A compressor on the master bus keeps big blasts from clipping.
 */
const SPEED_OF_SOUND = 343;
const MUTE_KEY = 'earth3d.flightMuted';

function readMuted() {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
}

export class FlightAudio {
  constructor() {
    this.ctx = null;
    this.muted = readMuted();
    this.running = false;
    this.whistles = new Map();
    this._warning = false;
    this._nextBeep = 0;
    this._suspendTimer = null;
  }

  get available() {
    return !!(window.AudioContext || window.webkitAudioContext);
  }

  /** Starts (or resumes) the audio. Must first be called from a user gesture. */
  start() {
    if (!this.available) return;
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      try {
        this.ctx = new Ctx();
        this._build();
      } catch (error) {
        console.warn('[Earth 3D] Web Audio unavailable:', error.message);
        this.ctx = null;
        return;
      }
    }
    clearTimeout(this._suspendTimer);
    this.ctx.resume?.().catch(() => {});
    this.running = true;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, t, 0.15);
  }

  /** Fades everything out and suspends the audio context (no CPU used while not flying). */
  stop() {
    if (!this.ctx) return;
    this.running = false;
    this.setWarning(false);
    for (const id of [...this.whistles.keys()]) this.stopWhistle(id);
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(0, t, 0.08);
    clearTimeout(this._suspendTimer);
    this._suspendTimer = setTimeout(() => { if (!this.running) this.ctx?.suspend?.().catch(() => {}); }, 600);
  }

  setMuted(muted) {
    this.muted = muted;
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* not persisted */ }
    if (this.ctx && this.running) this.master.gain.setTargetAtTime(muted ? 0 : 0.9, this.ctx.currentTime, 0.08);
  }

  /* ------------------------------------------------------------------ */
  /* Graph                                                               */
  /* ------------------------------------------------------------------ */
  _build() {
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.knee.value = 12;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.002;
    compressor.release.value = 0.3;
    this.master.connect(compressor).connect(ctx.destination);

    // Outdoor reverb: echoes of the blast from the ground and the hills
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this._impulse(3.4, 2.4);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.32;
    this.reverbSend.connect(this.reverb).connect(this.master);

    this.white = this._noiseBuffer(3, false);
    this.brown = this._noiseBuffer(4, true);

    // ---- Jet engine: low roar + exhaust hiss + turbine whine + afterburner rumble
    this.engine = ctx.createGain();
    this.engine.gain.value = 0;
    this.engine.connect(this.master);

    this.roarFilter = this._filter('lowpass', 400, 0.7);
    this.roarGain = this._gain(0.5);
    this._loop(this.brown).connect(this.roarFilter).connect(this.roarGain).connect(this.engine);

    this.hissFilter = this._filter('bandpass', 2600, 0.6);
    this.hissGain = this._gain(0.05);
    this._loop(this.white).connect(this.hissFilter).connect(this.hissGain).connect(this.engine);

    this.whineFilter = this._filter('bandpass', 1800, 5);
    this.whineGain = this._gain(0.012);
    this.whine = [ctx.createOscillator(), ctx.createOscillator()];
    this.whine.forEach((osc, i) => {
      osc.type = 'sawtooth';
      osc.frequency.value = 1200;
      osc.detune.value = i ? 7 : -7;
      osc.connect(this.whineFilter);
      osc.start();
    });
    this.whineFilter.connect(this.whineGain).connect(this.engine);

    this.abFilter = this._filter('lowpass', 170, 0.9);
    this.abGain = this._gain(0);
    // Afterburner "crackle": the rumble is amplitude-modulated (1 ± 0.3) by a fast LFO
    const crackleNode = this._gain(1);
    const crackle = ctx.createOscillator();
    crackle.type = 'square';
    crackle.frequency.value = 23;
    crackle.connect(this._gain(0.3)).connect(crackleNode.gain);
    crackle.start();
    this._loop(this.brown).connect(this.abFilter).connect(this.abGain).connect(crackleNode).connect(this.engine);

    // ---- Wind noise grows with airspeed
    this.windFilter = this._filter('bandpass', 900, 0.8);
    this.windGain = this._gain(0);
    this._loop(this.white).connect(this.windFilter).connect(this.windGain).connect(this.master);
  }

  _gain(value) {
    const g = this.ctx.createGain();
    g.gain.value = value;
    return g;
  }

  _filter(type, frequency, q) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = frequency;
    f.Q.value = q;
    return f;
  }

  _loop(buffer) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.start(0, Math.random() * buffer.duration);
    return src;
  }

  _noiseBuffer(seconds, brown) {
    const rate = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, Math.floor(seconds * rate), rate);
    const d = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      if (brown) {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      } else {
        d[i] = w;
      }
    }
    return buffer;
  }

  /** Stereo impulse response: exponentially decaying noise with a few early echoes. */
  _impulse(seconds, decay) {
    const rate = this.ctx.sampleRate;
    const length = Math.floor(seconds * rate);
    const buffer = this.ctx.createBuffer(2, length, rate);
    for (let c = 0; c < 2; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < length; i++) {
        const t = i / length;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay);
      }
      for (const echo of [0.11, 0.23, 0.41, 0.77]) {
        const at = Math.floor((echo + c * 0.013) * rate);
        for (let i = 0; i < 400 && at + i < length; i++) d[at + i] += (Math.random() * 2 - 1) * 0.5 * (1 - i / 400);
      }
    }
    return buffer;
  }

  /** One-shot noise burst through a filter, with an exponential decay envelope. */
  _burst({ at, buffer = this.white, duration, gain, type = 'lowpass', frequency = 1000, q = 0.7, attack = 0.002, sweepTo, out }) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = this._filter(type, frequency, q);
    if (sweepTo) filter.frequency.exponentialRampToValueAtTime(sweepTo, at + duration * 0.7);
    const env = this._gain(0);
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(gain, at + attack);
    env.gain.setTargetAtTime(0, at + attack, duration / 4);
    src.connect(filter).connect(env).connect(out);
    if (duration + 0.3 >= buffer.duration) {
      src.loop = true; // long rumbles
      src.start(at, Math.random() * buffer.duration);
    } else {
      src.start(at, Math.random() * (buffer.duration - duration - 0.3));
    }
    src.stop(at + duration + 0.2);
  }

  /* ------------------------------------------------------------------ */
  /* Per-frame update                                                    */
  /* ------------------------------------------------------------------ */
  /**
   * @param {object} p
   * @param {number} p.throttle      0..1
   * @param {number} p.afterburner   0..1
   * @param {number} p.speed         airspeed (m/s)
   * @param {number} p.distance      camera → aircraft (m)
   * @param {boolean} p.alive        false while the wreck burns
   */
  update({ throttle, afterburner, speed, distance, alive }) {
    if (!this.ctx || !this.running) return;
    const t = this.ctx.currentTime;
    const near = alive ? 1 / (1 + Math.max(distance - 15, 0) / 70) : 0;
    this.engine.gain.setTargetAtTime((0.3 + 0.7 * throttle) * near, t, 0.12);
    this.roarFilter.frequency.setTargetAtTime(240 + 820 * throttle + 500 * afterburner, t, 0.2);
    this.roarGain.gain.setTargetAtTime(0.32 + 0.55 * throttle, t, 0.2);
    this.hissGain.gain.setTargetAtTime(0.02 + 0.06 * throttle, t, 0.2);
    const whine = 1050 + 1700 * throttle;
    this.whine.forEach((osc) => osc.frequency.setTargetAtTime(whine, t, 0.35));
    this.whineFilter.frequency.setTargetAtTime(whine * 1.5, t, 0.35);
    this.abGain.gain.setTargetAtTime(0.85 * afterburner, t, 0.18);

    const v = Math.min(speed / 330, 1.2);
    this.windGain.gain.setTargetAtTime(alive ? 0.22 * v * v : 0, t, 0.25);
    this.windFilter.frequency.setTargetAtTime(500 + speed * 5, t, 0.3);

    if (this._warning && t >= this._nextBeep) {
      this._nextBeep = t + 0.55;
      this._beep(t, 980, 0.13);
      this._beep(t + 0.16, 760, 0.13);
    }
  }

  _beep(at, frequency, duration) {
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = frequency;
    const env = this._gain(0);
    env.gain.setValueAtTime(0, at);
    env.gain.linearRampToValueAtTime(0.06, at + 0.01);
    env.gain.setValueAtTime(0.06, at + duration - 0.02);
    env.gain.linearRampToValueAtTime(0, at + duration);
    osc.connect(env).connect(this.master);
    osc.start(at);
    osc.stop(at + duration + 0.05);
  }

  /** PULL UP warning tone (repeats while on). */
  setWarning(on) {
    if (on && !this._warning && this.ctx) this._nextBeep = this.ctx.currentTime;
    this._warning = on;
  }

  /* ------------------------------------------------------------------ */
  /* One-shot sounds                                                     */
  /* ------------------------------------------------------------------ */
  /** Bomb leaving the rack: metallic clunk + thump. */
  bombRelease() {
    if (!this.ctx || !this.running) return;
    const t = this.ctx.currentTime + 0.01;
    this._burst({ at: t, duration: 0.09, gain: 0.5, type: 'bandpass', frequency: 1400, q: 3, out: this.master });
    const osc = this.ctx.createOscillator();
    osc.frequency.setValueAtTime(120, t);
    osc.frequency.exponentialRampToValueAtTime(55, t + 0.15);
    const env = this._gain(0);
    env.gain.setValueAtTime(0.5, t);
    env.gain.setTargetAtTime(0, t, 0.05);
    osc.connect(env).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.3);
  }

  /** Rapid 20mm Vulcan cannon burst. */
  cannonFire() {
    if (!this.ctx || !this.running) return;
    const t = this.ctx.currentTime;
    this._burst({ at: t, duration: 0.05, gain: 0.45, type: 'bandpass', frequency: 1600, q: 2, out: this.master });
    const osc = this.ctx.createOscillator();
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(50, t + 0.04);
    const env = this._gain(0);
    env.gain.setValueAtTime(0.35, t);
    env.gain.setTargetAtTime(0, t, 0.015);
    osc.connect(env).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.06);
  }

  /** Missile rocket ignition and whoosh. */
  missileLaunch() {
    if (!this.ctx || !this.running) return;
    const t = this.ctx.currentTime;
    this._burst({ at: t, duration: 0.35, gain: 0.55, type: 'bandpass', frequency: 1100, sweepTo: 2800, out: this.master });
    this._burst({ at: t, buffer: this.brown, duration: 0.7, gain: 0.65, type: 'lowpass', frequency: 260, out: this.master });
  }

  /** Falling-bomb whistle (one per bomb, updated every frame). */
  startWhistle(id) {
    if (!this.ctx || !this.running || this.whistles.has(id)) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 1500;
    const vibrato = ctx.createOscillator();
    vibrato.frequency.value = 6.5;
    const depth = this._gain(14);
    vibrato.connect(depth).connect(osc.frequency);
    const gain = this._gain(0);
    const filter = this._filter('bandpass', 1400, 2);
    osc.connect(filter).connect(gain).connect(this.master);
    osc.start();
    vibrato.start();
    this.whistles.set(id, { osc, vibrato, gain, filter });
  }

  /** @param progress 0 at release … 1 at impact */
  updateWhistle(id, { distance, progress }) {
    const w = this.whistles.get(id);
    if (!w) return;
    const t = this.ctx.currentTime;
    const f = 1500 - 900 * Math.min(progress, 1);
    w.osc.frequency.setTargetAtTime(f, t, 0.05);
    w.filter.frequency.setTargetAtTime(f, t, 0.05);
    const fadeIn = Math.min(progress * 6, 1);
    w.gain.gain.setTargetAtTime((0.05 * fadeIn) / (1 + distance / 180), t, 0.06);
  }

  stopWhistle(id) {
    const w = this.whistles.get(id);
    if (!w) return;
    this.whistles.delete(id);
    const t = this.ctx.currentTime;
    w.gain.gain.setTargetAtTime(0, t, 0.02);
    w.osc.stop(t + 0.15);
    w.vibrato.stop(t + 0.15);
  }

  /**
   * Explosion heard from `distance` metres: crack, boom, sub-bass thump, long rumble and
   * crackling debris. Returns the delay (s) after which the sound (and shock) arrives.
   */
  explosion({ distance, yieldKg }) {
    const delay = distance / SPEED_OF_SOUND;
    if (!this.ctx || !this.running) return delay;
    const ctx = this.ctx;
    const s = Math.cbrt(yieldKg / 250); // 1 · 1.6 · 3.4 for 250 kg · 1 t · 10 t
    const t0 = ctx.currentTime + delay + 0.01;
    const loud = Math.min(1.7, (1.9 * s) / (1 + distance / 260));
    const cutoff = Math.max(150, 17000 * Math.exp(-distance / (900 * Math.sqrt(s))));

    const lowpass = this._filter('lowpass', cutoff, 0.5);
    const bus = this._gain(loud);
    lowpass.connect(bus);
    bus.connect(this.master);
    bus.connect(this.reverbSend);

    // Crack of the shock front (lost with distance)
    this._burst({ at: t0, duration: 0.04, gain: 0.9, type: 'highpass', frequency: 700, out: lowpass });
    // Boom: noise whose brightness falls quickly
    this._burst({ at: t0, duration: 1.1 * Math.sqrt(s), gain: 1.0, type: 'lowpass', frequency: 3200, sweepTo: 180, attack: 0.004, out: lowpass });
    // Sub-bass thump with a pitch drop
    const sub = ctx.createOscillator();
    sub.frequency.setValueAtTime(62 / Math.sqrt(s), t0);
    sub.frequency.exponentialRampToValueAtTime(26, t0 + 0.6);
    const subEnv = this._gain(0);
    subEnv.gain.setValueAtTime(0, t0);
    subEnv.gain.linearRampToValueAtTime(1.0, t0 + 0.012);
    subEnv.gain.setTargetAtTime(0, t0 + 0.02, 0.35 * Math.sqrt(s));
    sub.connect(subEnv).connect(lowpass);
    sub.start(t0);
    sub.stop(t0 + 3 * Math.sqrt(s));
    // Rolling rumble
    this._burst({ at: t0 + 0.05, buffer: this.brown, duration: 4.5 * Math.pow(s, 0.45), gain: 0.85, type: 'lowpass', frequency: 140, attack: 0.15, out: lowpass });
    // Crackle of falling debris and burning
    const crackles = Math.round(18 * Math.min(s, 2.5));
    for (let i = 0; i < crackles; i++) {
      const at = t0 + 0.25 + Math.random() * 2.6 * Math.sqrt(s);
      this._burst({ at, duration: 0.03 + Math.random() * 0.05, gain: 0.08 + Math.random() * 0.18, type: 'bandpass', frequency: 1500 + Math.random() * 3500, q: 1.5, out: lowpass });
    }
    setTimeout(() => { bus.disconnect(); }, (delay + 10 * Math.sqrt(s)) * 1000);
    return delay;
  }
}
