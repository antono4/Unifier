(() => {
/* Unifier — audio engine
   Web Audio analysis: FFT -> log bands -> temporal envelope -> beat/onset detection.
   Also a fully synthetic engine, so the visualizers can run with no input at all. */

const BAND_COUNT = 64;
const FFT_SIZE = 2048;
const F_MIN = 38;
const F_MAX = 16000;

const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

/* ------------------------------------------------------------------ */
/* Feature frame — the single currency of the whole system.            */
/* ------------------------------------------------------------------ */
function makeFrame() {
  return {
    t: 0,
    dt: 1 / 60,
    active: false,
    source: "idle",
    level: 0,
    db: -90,
    bands: new Float32Array(BAND_COUNT),
    peaks: new Float32Array(BAND_COUNT),
    wave: new Float32Array(1024),
    centroid: 0,
    flux: 0,
    beat: 0,
    bpm: 0,
    /* layered event envelopes (0..1, decaying) */
    pulse: 0,
    flashTool: 0,
    flashError: 0,
    flashDone: 0,
    speech: 0,
    tokens: 0,
  };
}

/* ------------------------------------------------------------------ */
/* Real audio analysis                                                 */
/* ------------------------------------------------------------------ */
class AudioEngine {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.gain = null;
    this.sourceNode = null;
    this.mode = "idle";        // idle | mic | file | osc
    this.stream = null;
    this.osc = null;
    this.oscKind = "sweep";
    this.freqData = null;
    this.timeData = null;
    this.bands = new Float32Array(BAND_COUNT);
    this.peaks = new Float32Array(BAND_COUNT);
    this.bandEdges = null;
    this.energyHistory = [];
    this.lastBeat = 0;
    this.beatIntervals = [];
    this.bpm = 0;
    this.prevSpectrum = null;
    this.fluxSmooth = 0;
    this.levelSmooth = 0;
    this.sensitivity = 1;
    this.smoothing = 0.82;
    this.onSourceChange = null;
  }

  async ensureContext() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) throw new Error("Web Audio tidak didukung browser ini.");
      this.ctx = new Ctor({ latencyHint: "interactive" });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = FFT_SIZE;
      this.analyser.smoothingTimeConstant = 0.6;
      this.analyser.minDecibels = -96;
      this.analyser.maxDecibels = -6;
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 1;
      this.gain.connect(this.analyser);
      this.freqData = new Uint8Array(this.analyser.frequencyBinCount);
      this.timeData = new Float32Array(this.analyser.fftSize);
      this.bandEdges = this._makeBandEdges();
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
    return this.ctx;
  }

  _makeBandEdges() {
    const nyquist = this.ctx.sampleRate / 2;
    const bins = this.analyser.frequencyBinCount;
    const edges = new Int32Array(BAND_COUNT + 1);
    for (let i = 0; i <= BAND_COUNT; i++) {
      const f = F_MIN * Math.pow(F_MAX / F_MIN, i / BAND_COUNT);
      edges[i] = clamp(Math.round((f / nyquist) * bins), 0, bins - 1);
      if (i > 0 && edges[i] <= edges[i - 1]) edges[i] = edges[i - 1] + 1;
    }
    edges[BAND_COUNT] = bins;
    return edges;
  }

  async startMic() {
    await this.ensureContext();
    this.stop();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.stream = stream;
    this.sourceNode = this.ctx.createMediaStreamSource(stream);
    this.sourceNode.connect(this.gain);
    this.mode = "mic";
    this._notify("Mikrofon perangkat");
  }

  async startElement(el) {
    await this.ensureContext();
    this.stop();
    if (!el.__unifierNode) el.__unifierNode = this.ctx.createMediaElementSource(el);
    this.sourceNode = el.__unifierNode;
    this.sourceNode.connect(this.gain);
    el.__unifierNode.connect(this.ctx.destination); // keep it audible
    this.mode = "file";
    this._notify("Berkas audio");
  }

  async startOsc(kind, freq) {
    await this.ensureContext();
    this.stop();
    this.oscKind = kind;
    this.osc = new OscillatorBank(this.ctx, this.gain, kind, freq);
    this.osc.start();
    this.mode = "osc";
    this._notify("Generator uji · " + kind);
  }

  stop() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.osc) {
      this.osc.stop();
      this.osc = null;
    }
    if (this.sourceNode) {
      try { this.sourceNode.disconnect(); } catch (e) { /* already gone */ }
      this.sourceNode = null;
    }
    if (this.mode !== "idle") this._notify(null);
    this.mode = "idle";
  }

  _notify(label) { if (this.onSourceChange) this.onSourceChange(label, this.mode); }

  get latencyMs() {
    if (!this.ctx) return 0;
    const base = (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0);
    return Math.round(base * 1000);
  }

  /** Pull one analysis frame into `out`. Returns true when real data was available. */
  read(out) {
    if (!this.analyser || this.mode === "idle") return false;
    this.analyser.getByteFrequencyData(this.freqData);
    this.analyser.getFloatTimeDomainData(this.timeData);

    const edges = this.bandEdges;
    const attack = 0.55 - this.smoothing * 0.5;
    const release = 0.985 - this.smoothing * 0.35;

    let sum = 0;
    let peak = 0;
    for (let i = 0; i < BAND_COUNT; i++) {
      const a = edges[i];
      const b = edges[i + 1];
      let acc = 0;
      for (let k = a; k < b; k++) acc += this.freqData[k];
      const norm = acc / Math.max(1, b - a) / 255;
      const v = clamp(Math.pow(norm, 0.85) * this.sensitivity);
      const prev = this.bands[i];
      this.bands[i] = v > prev ? lerp(prev, v, 1 - attack) : lerp(prev, v, 1 - release);
      this.peaks[i] = Math.max(this.peaks[i] - 0.006, this.bands[i]);
      sum += this.bands[i];
      if (this.bands[i] > peak) peak = this.bands[i];
    }
    out.bands.set(this.bands);
    out.peaks.set(this.peaks);

    /* waveform, decimated to 1024 samples for cheap drawing */
    const wave = out.wave;
    const step = Math.floor(this.timeData.length / wave.length);
    for (let i = 0; i < wave.length; i++) wave[i] = this.timeData[i * step] || 0;

    /* spectral centroid + flux (perceptual "brightness" and "motion") */
    let num = 0;
    let den = 0;
    let flux = 0;
    if (!this.prevSpectrum) this.prevSpectrum = new Uint8Array(this.freqData.length);
    for (let k = 1; k < this.freqData.length; k++) {
      const m = this.freqData[k] / 255;
      num += m * k;
      den += m;
      const d = m - this.prevSpectrum[k] / 255;
      if (d > 0) flux += d;
      this.prevSpectrum[k] = this.freqData[k];
    }
    out.centroid = den > 0 ? clamp(num / den / this.freqData.length) : 0;
    out.flux = clamp(flux / 8);
    this.fluxSmooth = lerp(this.fluxSmooth, out.flux, 0.25);
    out.flux = this.fluxSmooth;

    /* RMS level */
    let rms = 0;
    for (let i = 0; i < this.timeData.length; i++) rms += this.timeData[i] * this.timeData[i];
    rms = Math.sqrt(rms / this.timeData.length);
    const target = clamp(rms * 3.2 * this.sensitivity);
    this.levelSmooth = target > this.levelSmooth ? lerp(this.levelSmooth, target, 0.4) : lerp(this.levelSmooth, target, 0.12);
    out.level = this.levelSmooth;
    out.db = 20 * Math.log10(Math.max(1e-5, this.levelSmooth));

    /* beat: low-band energy vs. rolling mean, with a refractory window */
    const low = (this.bands[0] + this.bands[1] + this.bands[2] + this.bands[3]) / 4;
    this.energyHistory.push(low);
    if (this.energyHistory.length > 43) this.energyHistory.shift();
    const mean = this.energyHistory.reduce((a, b) => a + b, 0) / this.energyHistory.length;
    const now = performance.now();
    if (low > mean * 1.32 && low > 0.12 && now - this.lastBeat > 190) {
      const gap = now - this.lastBeat;
      if (this.lastBeat && gap < 2000) {
        this.beatIntervals.push(gap);
        if (this.beatIntervals.length > 12) this.beatIntervals.shift();
        const avg = this.beatIntervals.reduce((a, b) => a + b, 0) / this.beatIntervals.length;
        this.bpm = Math.round(60000 / avg);
      }
      this.lastBeat = now;
      out.beat = 1;
    } else {
      out.beat = Math.max(0, out.beat - out.dt * 4.5);
    }
    out.bpm = this.bpm;
    out.active = true;
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Oscillator bank — a calibration signal generator                    */
/* ------------------------------------------------------------------ */
class OscillatorBank {
  constructor(ctx, dest, kind, freq) {
    this.ctx = ctx;
    this.dest = dest;
    this.kind = kind;
    this.freq = freq || 220;
    this.nodes = [];
    this.lfo = null;
  }

  start() {
    const ctx = this.ctx;
    if (this.kind === "noise") {
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = this.freq;
      filter.Q.value = 0.8;
      src.connect(filter).connect(this.dest);
      src.start();
      this.nodes.push(src, filter);
      return;
    }

    if (this.kind === "pulse") {
      const carrier = ctx.createOscillator();
      carrier.type = "triangle";
      carrier.frequency.value = this.freq;
      const gate = ctx.createGain();
      gate.gain.value = 0;
      carrier.connect(gate).connect(this.dest);
      carrier.start();
      this.lfo = ctx.createOscillator();
      this.lfo.type = "square";
      this.lfo.frequency.value = 2.4;
      const depth = ctx.createGain();
      depth.gain.value = 0.5;
      this.lfo.connect(depth).connect(gate.gain);
      this.lfo.start();
      this.nodes.push(carrier, gate, this.lfo, depth);
      return;
    }

    const freqs = this.kind === "chord" ? [this.freq, this.freq * 1.26, this.freq * 1.5] : [this.freq];
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? "sawtooth" : "sine";
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = i === 0 ? 0.32 : 0.16;
      osc.connect(g).connect(this.dest);
      osc.start();
      this.nodes.push(osc, g);
    });

    if (this.kind === "sweep") {
      const osc = this.nodes[0];
      const t0 = ctx.currentTime;
      osc.frequency.setValueAtTime(this.freq, t0);
      osc.frequency.linearRampToValueAtTime(Math.min(6000, this.freq * 8), t0 + 3.2);
      osc.frequency.linearRampToValueAtTime(this.freq, t0 + 6.4);
      const loop = () => {
        if (!this.nodes.length) return;
        const t = ctx.currentTime;
        osc.frequency.setValueAtTime(this.freq, t);
        osc.frequency.linearRampToValueAtTime(Math.min(6000, this.freq * 8), t + 3.2);
        osc.frequency.linearRampToValueAtTime(this.freq, t + 6.4);
        this.sweepTimer = setTimeout(loop, 6400);
      };
      this.sweepTimer = setTimeout(loop, 6400);
    }
  }

  stop() {
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.nodes.forEach((n) => {
      try { if (n.stop) n.stop(); } catch (e) { /* already stopped */ }
      try { n.disconnect(); } catch (e) { /* already gone */ }
    });
    this.nodes = [];
  }
}

/* ------------------------------------------------------------------ */
/* Synthetic engine — no audio device required                         */
/* Deterministic, audio-like output driven by the clock + event input. */
/* ------------------------------------------------------------------ */
class SyntheticEngine {
  constructor() {
    this.on = false;
    this.kind = "demo";     // demo | tts | agent
    this.bands = new Float32Array(BAND_COUNT);
    this.peaks = new Float32Array(BAND_COUNT);
    this.t = 0;
    this.phrase = 0;
    this.energy = 0;
    this.energyTarget = 0.35;
    this.beat = 0;
    this.bpm = 96;
    this.seed = Math.random() * 1000;
    this.voice = 0;
  }

  start(kind) {
    this.on = true;
    this.kind = kind || "demo";
    this.t = 0;
    this.seed = Math.random() * 1000;
  }

  stop() { this.on = false; }

  /** Speech-like envelope: syllable bursts inside phrase-length pauses. */
  speechEnvelope(t) {
    const phrase = 1.6 + 0.9 * Math.sin(t * 0.31 + this.seed);
    const inPhrase = (t % phrase) < phrase * 0.78;
    if (!inPhrase) return 0;
    const syl = 0.5 + 0.5 * Math.sin(t * 9.4 + Math.sin(t * 3.1) * 1.6);
    const shape = Math.pow(Math.abs(Math.sin(t * 4.7)), 0.6);
    return clamp(syl * shape);
  }

  read(out) {
    if (!this.on) return false;
    const dt = out.dt;
    this.t += dt;

    const speech = this.kind === "tts" ? this.speechEnvelope(this.t) : 0;
    this.energyTarget = this.kind === "tts"
      ? 0.18 + speech * 0.8
      : this.kind === "agent"
        ? 0.1 + out.pulse * 0.7 + out.speech * 0.5
        : 0.22 + this.speechEnvelope(this.t) * 0.7;
    this.energy = lerp(this.energy, this.energyTarget, 0.22);

    const brightness = this.kind === "tts" ? 0.32 + speech * 0.3 : 0.3 + 0.35 * (0.5 + 0.5 * Math.sin(this.t * 0.21));
    for (let i = 0; i < BAND_COUNT; i++) {
      const x = i / (BAND_COUNT - 1);
      /* log-bell spectrum tilted by brightness, with per-band shimmer */
      const centre = brightness;
      const bell = Math.exp(-Math.pow((x - centre) / 0.3, 2));
      const tilt = Math.pow(1 - x * 0.72, 0.9);
      const shimmer = 0.82 + 0.18 * Math.sin(this.t * (5.5 + i * 0.13) + i * 0.7 + this.seed);
      const v = clamp(bell * tilt * shimmer * this.energy);
      const prev = this.bands[i];
      this.bands[i] = v > prev ? lerp(prev, v, 0.5) : lerp(prev, v, 0.18);
      this.peaks[i] = Math.max(this.peaks[i] - 0.007, this.bands[i]);
    }
    out.bands.set(this.bands);
    out.peaks.set(this.peaks);

    const wave = out.wave;
    const amp = this.energy * 0.85;
    for (let i = 0; i < wave.length; i++) {
      const x = i / wave.length;
      wave[i] = amp * (
        Math.sin(x * Math.PI * 2 * 3 + this.t * 2.1) * 0.5 +
        Math.sin(x * Math.PI * 2 * 7 + this.t * 3.7) * 0.28 +
        Math.sin(x * Math.PI * 2 * 13 - this.t * 5.3) * 0.16
      );
    }

    out.level = this.energy;
    out.db = 20 * Math.log10(Math.max(1e-5, this.energy));
    out.centroid = clamp(brightness + out.pulse * 0.2);
    out.flux = clamp(this.energy * 0.6 + out.pulse * 0.5);

    this.beat -= dt * 3.6;
    if (this.kind !== "tts" && Math.sin(this.t * (this.bpm / 60) * Math.PI * 2) > 0.97) this.beat = 1;
    if (this.kind === "tts" && speech > 0.86 && Math.random() < 0.06) this.beat = 1;
    out.beat = Math.max(0, this.beat);
    out.bpm = this.bpm;
    out.active = true;
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Unifier — merges every source into one frame                        */
/* ------------------------------------------------------------------ */
class Unifier {
  constructor() {
    this.sensitivity = 1;
    this.smoothing = 0.82;
    this.audio = new AudioEngine();
    this.synth = new SyntheticEngine();
    this.frame = makeFrame();
    this.last = performance.now();
    this.analysisMs = 0;
    this.sourceLabel = "idle";
    this.onSourceChange = null;

    this.audio.onSourceChange = (label, mode) => {
      if (mode !== "idle") this.sourceLabel = label;
      else if (!this.synth.on) this.sourceLabel = "idle";
      this._emit();
    };
  }

  _emit() { if (this.onSourceChange) this.onSourceChange(this.sourceLabel); }

  async mic() { await this.audio.startMic(); this.synth.stop(); }
  async file(el) { await this.audio.startElement(el); this.synth.stop(); }
  async osc(kind, freq) { await this.audio.startOsc(kind, freq); this.synth.stop(); }
  demo() { this.audio.stop(); this.synth.start("demo"); this.sourceLabel = "Mode demo (sintetis)"; this._emit(); }
  agentDrive() { this.audio.stop(); this.synth.start("agent"); this.sourceLabel = "Sinyal agen (sintetis)"; this._emit(); }
  ttsDrive() { this.audio.stop(); this.synth.start("tts"); this.sourceLabel = "Ucapan (sintetis)"; this._emit(); }
  stopAll() { this.audio.stop(); this.synth.stop(); this.sourceLabel = "idle"; this._emit(); }

  get mode() { return this.audio.mode !== "idle" ? this.audio.mode : (this.synth.on ? "synth" : "idle"); }

  /** Advance one frame. Call once per animation frame. */
  tick(now) {
    const f = this.frame;
    const t0 = performance.now();
    f.dt = clamp((now - this.last) / 1000, 1 / 240, 0.25);
    this.last = now;
    f.t += f.dt;

    f.bands.fill(0);
    f.peaks.fill(0);
    f.wave.fill(0);
    f.active = false;

    this.audio.sensitivity = this.sensitivity;
    this.audio.smoothing = this.smoothing;

    const real = this.audio.read(f);
    if (!real) this.synth.read(f);

    /* decay layered event envelopes */
    const d = (v, rate) => Math.max(0, v - f.dt * rate);
    f.pulse = d(f.pulse, 2.6);
    f.flashTool = d(f.flashTool, 2.2);
    f.flashError = d(f.flashError, 1.5);
    f.flashDone = d(f.flashDone, 1.8);
    f.speech = d(f.speech, 3.4);

    if (!real && !f.active) {
      /* idle: gentle breathing so the stage is never dead */
      const breath = 0.5 + 0.5 * Math.sin(f.t * 0.7);
      for (let i = 0; i < BAND_COUNT; i++) {
        const x = i / (BAND_COUNT - 1);
        f.bands[i] = 0.02 * breath * Math.exp(-Math.pow((x - 0.22) / 0.4, 2));
        f.peaks[i] = f.bands[i];
      }
      f.level = 0.015 * breath;
      f.source = "idle";
    } else {
      f.source = this.mode === "synth" ? this.synth.kind : this.audio.mode;
    }

    /* agent + speech impulses ride on top of whatever the audio is doing */
    f.level = clamp(f.level + f.pulse * 0.45 + f.speech * 0.3 + f.flashError * 0.3);
    f.beat = Math.max(f.beat, f.pulse * 0.9);

    this.analysisMs = this.analysisMs * 0.9 + (performance.now() - t0) * 0.1;
    return f;
  }

  /* ---- event inputs ---- */
  pulse(strength = 1) { this.frame.pulse = Math.max(this.frame.pulse, clamp(strength)); }
  speechHit(strength = 0.8) { this.frame.speech = Math.max(this.frame.speech, clamp(strength)); }
  tool() { this.frame.flashTool = 1; this.frame.pulse = Math.max(this.frame.pulse, 0.85); }
  error() { this.frame.flashError = 1; }
  done() { this.frame.flashDone = 1; }
  token() { this.frame.tokens++; }
}

window.UnifierCore = { AudioEngine, SyntheticEngine, Unifier, makeFrame, BAND_COUNT, clamp, lerp };

})();
