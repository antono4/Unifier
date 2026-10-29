(() => {
/* Unifier — signal sources
   Speech recognition, speech synthesis, agent event scenarios, live WebSocket. */

const { clamp, lerp } = window.UnifierCore;

/* ------------------------------------------------------------------ */
/* Speech recognition — words become "phoneme" impulses                */
/* ------------------------------------------------------------------ */
class SpeechSource {
  constructor(onPhoneme, onStatus) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.supported = !!SR;
    this.rec = null;
    this.on = false;
    this.onPhoneme = onPhoneme;
    this.onStatus = onStatus;
    this.SR = SR;
  }

  start(lang = "id-ID") {
    if (!this.supported) {
      this.onStatus("Recognition tidak didukung browser ini. Coba Chrome atau Edge.", true);
      return false;
    }
    if (this.on) { this.stop(); return false; }
    const rec = new this.SR();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => { this.on = true; this.onStatus("Mendengarkan…"); };
    rec.onerror = (e) => {
      const msg = e.error === "not-allowed"
        ? "Izin mikrofon ditolak untuk pengenalan ucapan."
        : "Galat pengenalan: " + e.error;
      this.onStatus(msg, true);
    };
    rec.onend = () => {
      this.on = false;
      if (this._want) { try { rec.start(); } catch (err) { this._want = false; this.onStatus("Berhenti."); } }
    };
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        const txt = res[0].transcript;
        if (res.isFinal) this.onPhoneme(txt.trim(), true);
        else interim += txt;
      }
      if (interim) this.onPhoneme(interim.trim(), false);
    };

    this.rec = rec;
    this._want = true;
    try { rec.start(); } catch (err) { this.onStatus("Tidak bisa memulai: " + err.message, true); }
    return true;
  }

  stop() {
    this._want = false;
    if (this.rec) { try { this.rec.stop(); } catch (e) { /* already stopped */ } }
    this.on = false;
    this.onStatus("Berhenti.");
  }
}

/* ------------------------------------------------------------------ */
/* Speech synthesis — envelope drives the synthetic engine             */
/* ------------------------------------------------------------------ */
class TtsSource {
  constructor(onStatus) {
    this.supported = "speechSynthesis" in window;
    this.onStatus = onStatus;
    this.speaking = false;
  }

  speak(text, lang) {
    if (!this.supported) { this.onStatus("SpeechSynthesis tidak didukung.", true); return false; }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang || "id-ID";
    u.rate = 1;
    u.pitch = 1;
    const voices = window.speechSynthesis.getVoices();
    const match = voices.find((v) => v.lang === u.lang) || voices.find((v) => v.lang.startsWith((u.lang || "id").slice(0, 2)));
    if (match) u.voice = match;
    u.onstart = () => { this.speaking = true; this.onStatus("Berbicara…"); };
    u.onend = () => { this.speaking = false; this.onStatus("Selesai."); };
    u.onerror = () => { this.speaking = false; this.onStatus("Ucapan gagal di perangkat ini.", true); };
    window.speechSynthesis.speak(u);
    return true;
  }

  stop() { if (this.supported) window.speechSynthesis.cancel(); }
}

/* ------------------------------------------------------------------ */
/* Agent scenarios — a scripted lifecycle with visual "signatures"      */
/* ------------------------------------------------------------------ */
const SCENARIOS = {
  lifecycle: [
    { t: 0, type: "start", msg: "agen: generalist" },
    { t: 300, type: "thinking", msg: "menafsirkan permintaan" },
    { t: 1500, type: "tool", msg: "browser.search(\"visualisasi audio\")" },
    { t: 2600, type: "token", msg: "Menyusun rencana" },
    { t: 2900, type: "token", msg: " · membaca 4 sumber" },
    { t: 3200, type: "token", msg: " · memilih palet" },
    { t: 3800, type: "thinking", msg: "memeriksa konsistensi" },
    { t: 4700, type: "tool", msg: "canvas.render()" },
    { t: 5600, type: "token", msg: "Hasil siap" },
    { t: 6200, type: "done", msg: "selesai dalam 6.2 s" },
  ],
  burst: [
    { t: 0, type: "start", msg: "agen: writer" },
    { t: 200, type: "thinking", msg: "menyiapkan draf" },
    { t: 900, type: "token", msg: "Aliran keluaran padat" },
    ...Array.from({ length: 46 }, (_, i) => ({ t: 1000 + i * 62, type: "token", msg: "token#" + (i + 1) })),
    { t: 4200, type: "done", msg: "draf lengkap" },
  ],
  error: [
    { t: 0, type: "start", msg: "agen: researcher" },
    { t: 300, type: "thinking", msg: "mencoba sumber" },
    { t: 1300, type: "tool", msg: "http.get(primary)" },
    { t: 2100, type: "error", msg: "timeout setelah 2000 ms" },
    { t: 2800, type: "thinking", msg: "strategi ulang" },
    { t: 3600, type: "tool", msg: "http.get(mirror)" },
    { t: 4600, type: "token", msg: "Pemulihan berhasil" },
    { t: 5400, type: "done", msg: "selesai dengan 1 percobaan ulang" },
  ],
};

class AgentSource {
  constructor(unifier, onEvent) {
    this.u = unifier;
    this.onEvent = onEvent;
    this.timer = null;
    this.running = false;
    this.startAt = 0;
  }

  play(name) {
    this.stop();
    const script = SCENARIOS[name] || SCENARIOS.lifecycle;
    this.u.agentDrive();
    this.running = true;
    this.startAt = performance.now();
    script.forEach((step) => {
      setTimeout(() => { if (this.running) this.fire(step.type, step.msg); }, step.t);
    });
    this.endTimer = setTimeout(() => { this.running = false; }, script[script.length - 1].t + 900);
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.endTimer) clearTimeout(this.endTimer);
  }

  /** Translate an agent event into a visual impulse. */
  fire(type, msg) {
    const u = this.u;
    switch (type) {
      case "thinking": u.pulse(0.6); break;
      case "tool": u.tool(); break;
      case "token": u.token(); u.pulse(0.28); break;
      case "speech": u.speechHit(0.9); break;
      case "error": u.error(); break;
      case "done": u.done(); break;
      case "start": u.pulse(0.4); break;
    }
    if (this.onEvent) this.onEvent(type, msg || "");
  }
}

/* ------------------------------------------------------------------ */
/* Live WebSocket feed                                                 */
/* ------------------------------------------------------------------ */
class LiveSource {
  constructor(unifier, onEvent, onStatus) {
    this.u = unifier;
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.ws = null;
  }

  connect(url) {
    this.disconnect();
    let ws;
    try { ws = new WebSocket(url); } catch (e) { this.onStatus("URL tidak valid: " + e.message, true); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.onStatus("Terhubung ke " + url);
      this.u.agentDrive();
    };
    ws.onmessage = (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch (err) { data = { type: "token", text: String(e.data) }; }
      const kind = data.type || "token";
      const msg = data.text || data.message || data.name || "";
      if (kind === "token") this.u.token();
      this.u.pulse(typeof data.intensity === "number" ? data.intensity : 0.3);
      this.onEvent(kind, msg);
      if (kind === "tool") this.u.tool();
      if (kind === "error") this.u.error();
      if (kind === "done") this.u.done();
      if (kind === "speech") this.u.speechHit(0.9);
    };
    ws.onerror = () => this.onStatus("Galat koneksi WebSocket.", true);
    ws.onclose = () => { this.onStatus("Koneksi ditutup."); this.ws = null; };
  }

  disconnect() {
    if (this.ws) { try { this.ws.close(); } catch (e) { /* already closed */ } this.ws = null; }
  }

  get connected() { return !!this.ws && this.ws.readyState === 1; }
}

window.UnifierSources = { SpeechSource, TtsSource, AgentSource, LiveSource, SCENARIOS };

})();
