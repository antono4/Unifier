/* Unifier — application shell
   Wires sources -> engine -> renderers, and drives the UI, HUD, recorder, URL state. */

(() => {
  const { Unifier, clamp } = window.UnifierCore;
  const { SpeechSource, TtsSource, AgentSource, LiveSource } = window.UnifierSources;
  const { MODES, PALETTES, makePal, drawGrid, drawErrorFlash, ramp, rgba, hexToRgb } = window.UnifierViz;

  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */
  const state = {
    mode: "bars",
    palette: "aurora",
    sensitivity: 1,
    smoothing: 0.82,
    complexity: 1,
    speed: 1,
    trails: 0.88,
    grid: true,
    glow: true,
    mirror: true,
    labels: false,
    reduceMotion: true,
    theme: "dark",
  };

  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ------------------------------------------------------------------ */
  /* URL state — every control is shareable                             */
  /* ------------------------------------------------------------------ */
  const URL_KEYS = ["mode", "palette", "sensitivity", "smoothing", "complexity", "speed", "trails", "grid", "glow", "mirror", "labels", "theme"];

  function readUrl() {
    const q = new URLSearchParams(location.search);
    URL_KEYS.forEach((k) => {
      if (!q.has(k)) return;
      const raw = q.get(k);
      const cur = state[k];
      if (typeof cur === "number") {
        const n = parseFloat(raw);
        if (!Number.isNaN(n)) state[k] = n;
      } else if (typeof cur === "boolean") {
        state[k] = raw !== "0" && raw !== "false";
      } else if (k === "mode" && MODES[raw]) {
        state.mode = raw;
      } else if (k === "palette" && PALETTES[raw]) {
        state.palette = raw;
      } else if (k === "theme" && (raw === "dark" || raw === "light")) {
        state.theme = raw;
      }
    });
  }

  function writeUrl() {
    const q = new URLSearchParams();
    URL_KEYS.forEach((k) => {
      const v = state[k];
      q.set(k, typeof v === "boolean" ? (v ? "1" : "0") : String(v));
    });
    history.replaceState(null, "", location.pathname + "?" + q.toString());
  }

  /* ------------------------------------------------------------------ */
  /* Canvas + environment                                                */
  /* ------------------------------------------------------------------ */
  const canvas = $("stage-canvas");
  const ctx = canvas.getContext("2d", { alpha: false });
  const wrap = $("stage-wrap");

  const env = {
    ctx, canvas, w: 0, h: 0, dpr: 1,
    pal: makePal(state.palette),
    opts: state,
    reduceMotion: prefersReduced && state.reduceMotion,
  };

  function resize() {
    const rect = wrap.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(320, Math.round(rect.width));
    const h = Math.max(180, Math.round(rect.height));
    if (env.w === w && env.h === h && env.dpr === dpr) return;
    env.w = w; env.h = h; env.dpr = dpr;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = env.pal.bg;
    ctx.fillRect(0, 0, w, h);
  }

  /* ------------------------------------------------------------------ */
  /* Engine + sources                                                    */
  /* ------------------------------------------------------------------ */
  const unifier = new Unifier();
  const speech = new SpeechSource(onPhoneme, onSpeechStatus);
  const tts = new TtsSource(onSpeechStatus);
  const agent = new AgentSource(unifier, onAgentEvent);
  const live = new LiveSource(unifier, onAgentEvent, onLiveStatus);

  let renderer = new MODES[state.mode](env);

  function setMode(name, announce) {
    if (!MODES[name]) return;
    state.mode = name;
    renderer = new MODES[name](env);
    [...$("mode-picker").children].forEach((b) => {
      const on = b.dataset.mode === name;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    });
    $("hud-mode").textContent = name.toUpperCase();
    if (announce) toast("Modus: " + name);
    writeUrl();
  }

  function setPalette(name) {
    if (!PALETTES[name]) return;
    state.palette = name;
    env.pal = makePal(name);
    const p = PALETTES[name];
    root.style.setProperty("--s1", p.s1);
    root.style.setProperty("--s2", p.s2);
    root.style.setProperty("--s3", p.s3);
    [...$("palette-picker").children].forEach((b) => {
      const on = b.dataset.palette === name;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    });
    ctx.fillStyle = env.pal.bg;
    ctx.fillRect(0, 0, env.w, env.h);
    writeUrl();
  }

  function setTheme(name) {
    state.theme = name;
    root.setAttribute("data-theme", name);
    $("btn-theme").setAttribute("aria-label", name === "dark" ? "Ganti ke tema terang" : "Ganti ke tema gelap");
    writeUrl();
  }

  /* ------------------------------------------------------------------ */
  /* Main loop                                                           */
  /* ------------------------------------------------------------------ */
  let running = true;
  let fps = 60;
  let frames = 0;
  let fpsClock = performance.now();
  let lastUi = 0;

  function loop(now) {
    if (!running) return;
    requestAnimationFrame(loop);

    resize();
    const f = unifier.tick(now);
    env.reduceMotion = prefersReduced && state.reduceMotion;

    const speedScale = env.reduceMotion ? 0.35 : 1;
    const savedSpeed = state.speed;
    if (env.reduceMotion) state.speed = Math.min(state.speed, 0.6);

    renderer.draw(f);

    if (state.grid) drawGrid(env);
    drawErrorFlash(env, f);

    state.speed = savedSpeed;

    /* HUD + stats, throttled to ~6 Hz so text never costs a frame */
    frames++;
    if (now - fpsClock >= 500) {
      fps = Math.round((frames * 1000) / (now - fpsClock));
      frames = 0;
      fpsClock = now;
    }
    if (now - lastUi > 160) {
      lastUi = now;
      updateUi(f, speedScale);
    }
  }

  function updateUi(f, speedScale) {
    $("stat-fps").textContent = fps;
    $("stat-latency").textContent = unifier.audio.mode === "idle" ? "—" : unifier.audio.latencyMs;
    $("meter-label").textContent = f.active ? (f.db <= -60 ? "-60 dB" : f.db.toFixed(1) + " dB") : "-∞ dB";
    $("engine-label").textContent = env.reduceMotion && prefersReduced
      ? "reduced-motion " + speedScale.toFixed(2) + "×"
      : state.mode + " · " + (f.bpm ? f.bpm + " bpm" : "—");

    /* peak frequency */
    let bi = 0;
    for (let i = 1; i < f.bands.length; i++) if (f.bands[i] > f.bands[bi]) bi = i;
    const nyq = unifier.audio.ctx ? unifier.audio.ctx.sampleRate / 2 : 24000;
    const hz = 38 * Math.pow(16000 / 38, (bi + 0.5) / f.bands.length);
    $("stat-peak").textContent = f.active && hz > 40 ? (hz >= 1000 ? (hz / 1000).toFixed(1) + "k" : Math.round(hz)) : "—";
    void nyq;

    wrap.setAttribute("data-active", f.active ? "true" : "false");
  }

  /* ------------------------------------------------------------------ */
  /* Overlay / activation                                                */
  /* ------------------------------------------------------------------ */
  function activate() {
    const ov = $("stage-overlay");
    if (ov && !ov.hidden) ov.hidden = true;
  }

  /* ------------------------------------------------------------------ */
  /* Toast                                                               */
  /* ------------------------------------------------------------------ */
  let toastTimer = null;
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.classList.add("is-show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("is-show"), 2600);
  }

  /* ------------------------------------------------------------------ */
  /* Source status + event log                                           */
  /* ------------------------------------------------------------------ */
  function setNowPlaying(label) {
    $("now-playing").textContent = label || "Menunggu sumber sinyal…";
  }

  unifier.onSourceChange = (label) => {
    setNowPlaying(label);
    if (label) activate();
  };

  function onSpeechStatus(msg, isError) {
    const n = $("speech-note");
    n.textContent = msg;
    n.classList.toggle("is-error", !!isError);
    $("btn-speech").classList.toggle("is-on", speech.on);
  }

  function onLiveStatus(msg, isError) {
    toast(msg);
    $("btn-ws").classList.toggle("is-on", live.connected);
    if (isError) $("btn-ws").classList.remove("is-on");
  }

  const KIND_LABEL = {
    start: "mulai", thinking: "pikir", tool: "alat", token: "token",
    error: "galat", done: "selesai", speech: "ucapan",
  };

  function onAgentEvent(kind, msg) {
    const log = $("event-log");
    const row = document.createElement("div");
    row.className = "event-log__row";
    row.dataset.kind = kind;
    const t = new Date();
    const ts = String(t.getMinutes()).padStart(2, "0") + ":" + String(t.getSeconds()).padStart(2, "0") + "." + String(t.getMilliseconds()).padStart(3, "0");
    row.innerHTML = `<span class="event-log__time">${ts}</span>` +
      `<span class="event-log__kind">${KIND_LABEL[kind] || kind}</span>` +
      `<span class="event-log__msg"></span>`;
    row.querySelector(".event-log__msg").textContent = msg || "—";
    log.prepend(row);
    while (log.children.length > 14) log.lastChild.remove();
    activate();
  }

  let lastFinalText = "";
  function onPhoneme(text, isFinal) {
    const out = $("transcript");
    if (isFinal) lastFinalText = (lastFinalText + " " + text).trim();
    out.textContent = isFinal ? lastFinalText : lastFinalText + " " + text;
    out.classList.toggle("is-live", !isFinal);
    unifier.speechHit(isFinal ? 1 : 0.55);
    drawPhonemeStrip(text);
    activate();
  }

  function drawPhonemeStrip(text) {
    const strip = $("phoneme-strip");
    const words = (text || "").split(/\s+/).filter(Boolean);
    words.slice(-14).forEach((w) => {
      const i = document.createElement("i");
      const h = 6 + Math.min(26, w.length * 4);
      i.style.height = h + "px";
      i.title = w;
      strip.appendChild(i);
    });
    while (strip.children.length > 28) strip.firstChild.remove();
  }

  /* ------------------------------------------------------------------ */
  /* Controls: mode + palette                                            */
  /* ------------------------------------------------------------------ */
  $("mode-picker").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]");
    if (b) setMode(b.dataset.mode, true);
  });

  $("palette-picker").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-palette]");
    if (b) setPalette(b.dataset.palette);
  });

  /* ------------------------------------------------------------------ */
  /* Controls: sliders + toggles                                         */
  /* ------------------------------------------------------------------ */
  const sliders = [
    ["ctl-sensitivity", "sensitivity", "val-sensitivity", (v) => v.toFixed(2) + "×"],
    ["ctl-smoothing", "smoothing", "val-smoothing", (v) => v.toFixed(2)],
    ["ctl-complexity", "complexity", "val-complexity", (v) => v.toFixed(2) + "×"],
    ["ctl-speed", "speed", "val-speed", (v) => v.toFixed(2) + "×"],
    ["ctl-trails", "trails", "val-trails", (v) => v.toFixed(2)],
  ];
  sliders.forEach(([id, key, outId, fmt]) => {
    const el = $(id);
    const out = $(outId);
    el.value = state[key];
    out.textContent = fmt(state[key]);
    el.addEventListener("input", () => {
      state[key] = parseFloat(el.value);
      out.textContent = fmt(state[key]);
      writeUrl();
    });
  });

  const toggles = [
    ["tgl-grid", "grid"], ["tgl-glow", "glow"], ["tgl-mirror", "mirror"],
    ["tgl-labels", "labels"], ["tgl-reduce", "reduceMotion"],
  ];
  toggles.forEach(([id, key]) => {
    const el = $(id);
    el.checked = state[key];
    el.addEventListener("change", () => { state[key] = el.checked; writeUrl(); });
  });

  /* ------------------------------------------------------------------ */
  /* Controls: theme + share + fullscreen                                */
  /* ------------------------------------------------------------------ */
  $("btn-theme").addEventListener("click", () => setTheme(state.theme === "dark" ? "light" : "dark"));

  $("btn-share").addEventListener("click", async () => {
    writeUrl();
    const url = location.href;
    try {
      await navigator.clipboard.writeText(url);
      toast("Tautan preset disalin");
    } catch (e) {
      history.replaceState(null, "", url);
      toast("Tautan ada di address bar");
    }
  });

  function toggleFullscreen() {
    if (!document.fullscreenElement) wrap.requestFullscreen?.().catch(() => toast("Layar penuh tidak tersedia"));
    else document.exitFullscreen?.();
  }
  $("btn-full").addEventListener("click", toggleFullscreen);

  /* ------------------------------------------------------------------ */
  /* Controls: audio sources                                             */
  /* ------------------------------------------------------------------ */
  async function startMic() {
    try {
      await unifier.mic();
      $("btn-mic").classList.add("is-on");
      $("btn-mic").textContent = "Mikrofon aktif";
      $("mic-note").classList.remove("is-error");
      $("mic-note").textContent = "Input langsung aktif. Bicara, tepuk tangan, atau putar musik.";
      toast("Mikrofon aktif");
    } catch (e) {
      const msg = e.name === "NotAllowedError"
        ? "Izin mikrofon ditolak. Buka lewat http/https, bukan file://."
        : "Gagal membuka mikrofon: " + e.message;
      $("mic-note").textContent = msg;
      $("mic-note").classList.add("is-error");
      toast("Mikrofon gagal");
    }
  }

  $("btn-mic").addEventListener("click", startMic);

  const audioEl = $("audio-el");
  const fileInput = $("file-input");
  const dropzone = $("dropzone");

  async function loadFile(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    audioEl.src = url;
    setNowPlaying("Berkas: " + file.name);
    try {
      await unifier.file(audioEl);
      await audioEl.play();
      toast("Memutar " + file.name);
    } catch (e) {
      toast("Gagal memutar berkas");
    }
  }

  fileInput.addEventListener("change", () => loadFile(fileInput.files[0]));
  ["dragenter", "dragover"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("is-over"); }));
  ["dragleave", "drop"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("is-over"); }));
  dropzone.addEventListener("drop", (e) => loadFile(e.dataTransfer.files[0]));

  let oscOn = false;
  $("osc-freq").addEventListener("input", () => { $("val-osc-freq").textContent = $("osc-freq").value + " Hz"; });
  $("btn-osc").addEventListener("click", async () => {
    if (oscOn) { unifier.stopAll(); oscOn = false; $("btn-osc").textContent = "Jalankan generator"; $("btn-osc").classList.remove("is-on"); return; }
    try {
      await unifier.osc($("osc-type").value, parseFloat($("osc-freq").value));
      oscOn = true;
      $("btn-osc").textContent = "Hentikan generator";
      $("btn-osc").classList.add("is-on");
    } catch (e) { toast("Generator gagal: " + e.message); }
  });

  /* ------------------------------------------------------------------ */
  /* Controls: speech                                                    */
  /* ------------------------------------------------------------------ */
  $("btn-speech").addEventListener("click", () => {
    if (speech.on) speech.stop(); else speech.start("id-ID");
  });

  $("btn-tts").addEventListener("click", () => {
    const text = $("tts-text").value.trim();
    if (!text) { toast("Tulis teks dulu"); return; }
    unifier.ttsDrive();
    const ok = tts.speak(text, $("tts-lang").value);
    if (ok) { toast("Mengucapkan teks"); drawPhonemeStrip(text); }
  });

  /* ------------------------------------------------------------------ */
  /* Controls: agent scenarios + live feed                               */
  /* ------------------------------------------------------------------ */
  $("scenario-list").addEventListener("click", (e) => {
    const b = e.target.closest(".scenario");
    if (!b) return;
    [...$("scenario-list").children].forEach((x) => x.classList.toggle("is-active", x === b));
    agent.play(b.dataset.scenario);
    $("btn-scenario").classList.add("is-on");
    activate();
  });

  $("btn-scenario").addEventListener("click", () => {
    const active = $("scenario-list").querySelector(".scenario.is-active");
    agent.play(active ? active.dataset.scenario : "lifecycle");
    $("btn-scenario").classList.add("is-on");
    activate();
  });

  $("btn-scenario-stop").addEventListener("click", () => {
    agent.stop();
    $("btn-scenario").classList.remove("is-on");
    if (!live.connected) unifier.stopAll();
  });

  $("btn-ws").addEventListener("click", () => {
    if (live.connected) { live.disconnect(); $("btn-ws").textContent = "Sambung"; $("btn-ws").classList.remove("is-on"); return; }
    const url = $("ws-url").value.trim();
    if (!url) { toast("Masukkan URL WebSocket"); return; }
    live.connect(url);
    $("btn-ws").textContent = "Putuskan";
  });

  /* ------------------------------------------------------------------ */
  /* Recorder — WebM straight from the canvas                            */
  /* ------------------------------------------------------------------ */
  let recorder = null;
  let chunks = [];
  const btnRec = $("btn-rec");

  function toggleRecord() {
    if (recorder && recorder.state === "recording") {
      recorder.stop();
      return;
    }
    if (typeof MediaRecorder === "undefined" || !canvas.captureStream) {
      toast("Perekaman tidak didukung browser ini");
      return;
    }
    const stream = canvas.captureStream(60);
    const types = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
    const mime = types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined);
    } catch (e) { toast("Perekaman gagal dimulai"); return; }
    chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mime || "video/webm" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "unifier-" + state.mode + "-" + Date.now() + ".webm";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      btnRec.classList.remove("is-rec");
      btnRec.textContent = "Rekam";
      toast("Rekaman diunduh (" + (blob.size / 1e6).toFixed(1) + " MB)");
    };
    recorder.start(1000);
    btnRec.classList.add("is-rec");
    btnRec.textContent = "Berhenti";
    toast("Merekam panggung…");
  }
  btnRec.addEventListener("click", toggleRecord);

  /* ------------------------------------------------------------------ */
  /* Demo mode + keyboard                                                */
  /* ------------------------------------------------------------------ */
  function startDemo() {
    unifier.demo();
    $("btn-demo").classList.add("is-on");
    activate();
    toast("Mode demo: sinyal sintetis");
  }
  $("btn-demo").addEventListener("click", startDemo);
  $("btn-start").addEventListener("click", startMic);

  const MODE_ORDER = ["bars", "wave", "radial", "particles", "tunnel", "unified"];

  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    const k = e.key.toLowerCase();
    if (k >= "1" && k <= "6") setMode(MODE_ORDER[parseInt(k, 10) - 1], true);
    else if (k === "m") startMic();
    else if (k === "d") startDemo();
    else if (k === "f") toggleFullscreen();
    else if (k === "r") toggleRecord();
    else if (k === "t") setTheme(state.theme === "dark" ? "light" : "dark");
    else if (k === " ") { e.preventDefault(); setMode(MODE_ORDER[(MODE_ORDER.indexOf(state.mode) + 1) % MODE_ORDER.length], true); }
  });

  /* ------------------------------------------------------------------ */
  /* Tabs                                                                */
  /* ------------------------------------------------------------------ */
  const tabs = [...document.querySelectorAll('.tabs [role="tab"]')];
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => {
        const on = t === tab;
        t.classList.toggle("is-active", on);
        t.setAttribute("aria-selected", on ? "true" : "false");
        $(t.getAttribute("aria-controls")).classList.toggle("is-active", on);
      });
    });
    tab.addEventListener("keydown", (e) => {
      const i = tabs.indexOf(tab);
      let n = -1;
      if (e.key === "ArrowRight") n = (i + 1) % tabs.length;
      if (e.key === "ArrowLeft") n = (i - 1 + tabs.length) % tabs.length;
      if (n >= 0) { e.preventDefault(); tabs[n].focus(); tabs[n].click(); }
    });
  });

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */
  readUrl();
  setTheme(state.theme);
  setPalette(state.palette);
  setMode(state.mode, false);
  resize();

  if (prefersReduced && state.reduceMotion) {
    $("engine-label").textContent = "reduced-motion";
  }

  window.addEventListener("resize", resize);
  if ("ResizeObserver" in window) new ResizeObserver(resize).observe(wrap);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { running = false; }
    else if (!running) { running = true; unifier.last = performance.now(); requestAnimationFrame(loop); }
  });

  requestAnimationFrame(loop);
  window.__unifier = { state, unifier, env, setMode, setPalette, setTheme, toast, live, agent, speech, tts };
})();
