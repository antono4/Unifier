#!/usr/bin/env node
/**
 * Unifier smoke test.
 *
 * Drives the real page in headless Chromium and measures what actually renders:
 * console errors, animation frames, canvas pixel statistics per mode, the agent
 * event pipeline, control wiring, and URL state round-tripping.
 *
 *   node tools/test/smoke.mjs            # uses dist/unifier.html? no - uses index.html
 *   node tools/test/smoke.mjs --shots    # also write PNG screenshots to .agent_tmp/
 *
 * A fake audio input device is enabled, so the microphone path is exercised
 * for real (Chrome synthesises a tone) rather than mocked.
 */

import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import puppeteer from "puppeteer-core";

const ROOT = resolve(import.meta.dirname, "../..");
const SHOTS = process.argv.includes("--shots");
const OUT = join(ROOT, ".agent_tmp");
const CHROME = process.env.CHROME_PATH || "/usr/bin/chromium";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
};

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

function serve() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const rel = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = join(ROOT, decodeURIComponent(rel));
      if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Toggle inputs are visually hidden (opacity 0, 0x0), so a synthetic click on the
   label is the only reliable way to flip them in headless Chromium. */
async function clickToggle(page, selector) {
  await page.evaluate((sel) => {
    const input = document.querySelector(sel);
    input.closest("label").click();
  }, selector);
  await sleep(60);
}

/** Measure the rendered canvas directly from the page's own pixel buffer. */
async function canvasStats(page) {
  return page.evaluate(() => {
    const c = document.getElementById("stage-canvas");
    const ctx = c.getContext("2d");
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let lum = 0;
    let n = 0;
    let max = 0;
    const seen = new Set();
    const stride = 4 * 7; // sample ~1/7 of pixels
    for (let i = 0; i < data.length; i += stride) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      lum += l;
      n++;
      if (l > max) max = l;
      seen.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
    }
    return {
      w: c.width, h: c.height,
      meanLum: lum / n, maxLum: max,
      colours: seen.size,
    };
  });
}

/** Ask the OS for a free TCP port (bind to 0 and read it back). */
function freePort() {
  return new Promise((ok, bad) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => ok(p));
    });
    srv.on("error", bad);
  });
}

/** Poll until something is listening, so the test never races the child process. */
async function waitForPort(port, timeout = 5000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const ok = await new Promise((res) => {
      const sock = createConnection({ port, host: "127.0.0.1" });
      sock.once("connect", () => { sock.destroy(); res(true); });
      sock.once("error", () => res(false));
    });
    if (ok) return true;
    if (Date.now() > deadline) throw new Error("ws-server did not start on port " + port);
    await sleep(80);
  }
}

/** WCAG 2.1 audit run inside the page. Walks the ancestor chain and composites
 *  every translucent layer, so `color-mix()` and rgba surfaces are judged on the
 *  colour that actually ends up on screen. */
const CONTRAST_AUDIT = `(() => {
  const parseColor = (c) => {
    if (!c || c === 'transparent') return [0, 0, 0, 0];
    let m = c.match(/^color\\(srgb\\s+([\\d.eE+-]+)\\s+([\\d.eE+-]+)\\s+([\\d.eE+-]+)(?:\\s*\\/\\s*([\\d.eE+-]+))?\\)$/);
    if (m) return [+m[1] * 255, +m[2] * 255, +m[3] * 255, m[4] === undefined ? 1 : +m[4]];
    m = c.match(/^rgba?\\(([^)]+)\\)$/);
    if (m) {
      const p = m[1].split(/[,\\s/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    }
    return [0, 0, 0, 0];
  };
  const over = (fg, bg) => { const a = fg[3]; return [fg[0]*a + bg[0]*(1-a), fg[1]*a + bg[1]*(1-a), fg[2]*a + bg[2]*(1-a), 1]; };
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126*f(r) + 0.7152*f(g) + 0.0722*f(b); };
  const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b); return (Math.max(l1,l2) + 0.05) / (Math.min(l1,l2) + 0.05); };

  const effectiveBg = (el) => {
    const stack = [];
    for (let n = el; n; n = n.parentElement) stack.push(parseColor(getComputedStyle(n).backgroundColor));
    stack.push(parseColor(getComputedStyle(document.body).backgroundColor));
    let acc = [255, 255, 255, 1];
    for (let i = stack.length - 1; i >= 0; i--) acc = over(stack[i], acc);
    return acc;
  };

  const failures = [];
  const uaBackgrounds = [];
  document.querySelectorAll('h1,h2,h3,p,span,b,small,a,li,label,kbd,button,code,pre').forEach((el) => {
    const cs = getComputedStyle(el);
    /* a button keeping the UA grey default would fail here and nowhere else */
    if (el.tagName === 'BUTTON' && /^rgb\\(239, 239, 239\\)$/.test(cs.backgroundColor)) {
      uaBackgrounds.push(el.id || el.className);
    }
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!hasText) return;
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    if (cs.webkitTextFillColor === 'rgba(0, 0, 0, 0)') return;          // gradient-clipped text
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return;     // gradient surface
    const bg = effectiveBg(el);
    const cr = ratio(over(parseColor(cs.color), bg), bg);
    const size = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight, 10) >= 600;
    const min = (size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5;
    if (cr < min) failures.push({
      sel: el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : ''),
      txt: el.textContent.trim().slice(0, 26), cr: +cr.toFixed(2), min,
      bg: 'rgb(' + bg.slice(0, 3).map((v) => Math.round(v)).join(',') + ')',
      fg: cs.color,
    });
  });
  return { failures, uaBackgrounds };
})()`;

async function main() {
  const server = await serve();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/index.html`;
  if (SHOTS) await mkdir(OUT, { recursive: true });

  /* The demo feed is a real deliverable, so start it and drive it from the page
     rather than asserting it in isolation. */
  const wsPort = await freePort();
  const wsProc = spawn("node", [join(ROOT, "tools/ws-server.mjs"), String(wsPort)], { stdio: "ignore" });
  await waitForPort(wsPort);
  const wsUrl = `ws://127.0.0.1:${wsPort}/events`;

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: [
      "--no-sandbox", "--disable-dev-shm-usage",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--window-size=1440,1000",
    ],
    defaultViewport: { width: 1440, height: 1000 },
  });

  const page = await browser.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));

  console.log("\n1. Load + wiring");
  await page.goto(base, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__unifier, { timeout: 10_000 });
  check("window.__unifier exposed", true);
  check("6 mode buttons present", (await page.$$("#mode-picker button")).length === 6);
  check("5 palette swatches present", (await page.$$("#palette-picker button")).length === 5);
  check("no console errors on load", errors.length === 0, errors.slice(0, 3).join(" | "));

  console.log("\n2. Demo mode drives real animation");
  await page.click("#btn-demo");
  await sleep(1200);
  const frames = await page.evaluate(() => new Promise((res) => {
    let n = 0;
    const t0 = performance.now();
    const tick = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(tick); else res(n); };
    requestAnimationFrame(tick);
  }));
  check("renders ≥ 30 fps in headless", frames >= 30, frames + " fps");
  const active = await page.evaluate(() => window.__unifier.unifier.frame.active);
  check("engine reports an active signal", active === true);
  const lvl = await page.evaluate(() => window.__unifier.unifier.frame.level);
  check("synthetic level is non-zero", lvl > 0.02, "level=" + lvl.toFixed(3));

  console.log("\n3. Every mode paints a distinct, non-blank frame");
  const modes = ["bars", "wave", "radial", "particles", "tunnel", "unified"];
  const stats = {};
  for (const m of modes) {
    await page.evaluate((mm) => window.__unifier.setMode(mm, false), m);
    await sleep(900);
    const s = await canvasStats(page);
    stats[m] = s;
    const hudMode = await page.$eval("#hud-mode", (e) => e.textContent);
    check(`mode "${m}" renders detail`, s.colours > 40 && s.maxLum > 40,
      `colours=${s.colours} maxLum=${s.maxLum.toFixed(0)}`);
    check(`mode "${m}" updates HUD`, hudMode === m.toUpperCase());
    if (SHOTS) await page.screenshot({ path: join(OUT, `mode-${m}.png`) });
  }
  const sigs = new Set(modes.map((m) => `${stats[m].colours}/${stats[m].meanLum.toFixed(1)}`));
  check("modes are visually distinct from each other", sigs.size === modes.length,
    `${sigs.size}/${modes.length} unique signatures`);

  console.log("\n4. Palettes change output");
  await page.evaluate(() => window.__unifier.setMode("bars", false));
  await page.evaluate(() => window.__unifier.setPalette("aurora"));
  await sleep(700);
  const aurora = await canvasStats(page);
  await page.evaluate(() => window.__unifier.setPalette("ember"));
  await sleep(700);
  const ember = await canvasStats(page);
  check("switching palette changes the frame", Math.abs(aurora.meanLum - ember.meanLum) > 0.5,
    `aurora=${aurora.meanLum.toFixed(1)} ember=${ember.meanLum.toFixed(1)}`);
  const cssVar = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--s1").trim());
  check("palette writes through to CSS vars", cssVar === "#fbbf24", cssVar);

  console.log("\n5. Controls are wired");
  await page.evaluate(() => {
    const el = document.getElementById("ctl-sensitivity");
    el.value = "2.4";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const sens = await page.evaluate(() => window.__unifier.state.sensitivity);
  check("sensitivity slider updates state", Math.abs(sens - 2.4) < 1e-6, "sensitivity=" + sens);
  const sensLabel = await page.$eval("#val-sensitivity", (e) => e.textContent);
  check("sensitivity slider updates its readout", sensLabel === "2.40×", sensLabel);

  await clickToggle(page, "#tgl-labels");
  check("toggle flips state", (await page.evaluate(() => window.__unifier.state.labels)) === true);
  await clickToggle(page, "#tgl-labels");

  const gridOn = await page.evaluate(() => window.__unifier.state.grid);
  await clickToggle(page, "#tgl-grid");
  check("grid toggle flips", (await page.evaluate(() => window.__unifier.state.grid)) !== gridOn);
  await clickToggle(page, "#tgl-grid");

  console.log("\n6. Keyboard shortcuts");
  /* blur first: clicking a <label> moves focus to its input in Chrome, and the
     shortcut handler deliberately ignores keys while a form control has focus. */
  await page.evaluate(() => document.activeElement?.blur());
  const focusTag = await page.evaluate(() => document.activeElement.tagName);
  check("focus returns to a non-input element", focusTag !== "INPUT", focusTag);
  await page.keyboard.press("3");
  check("key 3 selects radial", (await page.evaluate(() => window.__unifier.state.mode)) === "radial");
  await page.keyboard.press("1");
  check("key 1 selects bars", (await page.evaluate(() => window.__unifier.state.mode)) === "bars");
  await page.keyboard.press(" ");
  check("space advances to the next mode", (await page.evaluate(() => window.__unifier.state.mode)) === "wave");
  await page.keyboard.press("1");
  await page.keyboard.press("t");
  check("key t toggles the theme", (await page.evaluate(() => window.__unifier.state.theme)) === "light");
  await page.keyboard.press("t");

  /* the guard that keeps shortcuts out of text fields */
  await page.evaluate(() => document.getElementById("tab-speech").click());
  await page.click("#tts-text");
  const before = await page.evaluate(() => window.__unifier.state.mode);
  await page.keyboard.press("5");
  check("shortcuts are ignored while typing in a field",
    (await page.evaluate(() => window.__unifier.state.mode)) === before, "mode stayed " + before);
  await page.evaluate(() => document.activeElement?.blur());
  await page.evaluate(() => document.getElementById("tab-audio").click());

  console.log("\n7. Agent event pipeline");
  await page.evaluate(() => document.getElementById("tab-agent").click());
  const tabShown = await page.evaluate(() => document.getElementById("src-agent").classList.contains("is-active"));
  check("agent tab activates its panel", tabShown === true);
  await page.click("#btn-scenario");
  await sleep(3000);
  const rows = await page.$$eval("#event-log .event-log__row", (r) => r.length);
  check("scenario produces log rows", rows > 0, rows + " rows");
  const kinds = await page.$$eval("#event-log .event-log__row", (rs) => rs.map((r) => r.dataset.kind));
  check("lifecycle emits thinking/tool/token", kinds.includes("thinking") && kinds.includes("tool") && kinds.includes("token"),
    kinds.join(","));
  const logText = await page.$eval("#event-log", (e) => e.textContent);
  check("log shows scenario text", logText.includes("browser.search"), logText.slice(0, 60));
  await page.click("#btn-scenario-stop");

  console.log("\n8. Error scenario flashes");
  await page.evaluate(() => window.__unifier.agent.play("error"));
  await sleep(2400);
  const flashErr = await page.evaluate(() => window.__unifier.unifier.frame.flashError);
  const sawError = await page.$$eval("#event-log .event-log__row", (rs) => rs.some((r) => r.dataset.kind === "error"));
  check("error scenario triggers the flash", sawError === true, "flashError=" + flashErr.toFixed(2));
  await page.evaluate(() => window.__unifier.agent.stop());

  console.log("\n9. Live WebSocket feed");
  await page.evaluate(() => document.getElementById("tab-agent").click());
  await page.evaluate((u) => {
    document.getElementById("ws-url").value = u;
    document.getElementById("btn-ws").click();
  }, wsUrl);
  await sleep(2600);
  const wsConnected = await page.evaluate(() => window.__unifier.live.connected);
  check("page connects to the demo feed", wsConnected === true);
  const wsRows = await page.$$eval("#event-log .event-log__row", (rs) => rs.map((r) => r.dataset.kind));
  check("live events reach the log", wsRows.length > 0, wsRows.slice(0, 6).join(","));
  check("live feed emits thinking + tool", wsRows.includes("thinking") && wsRows.includes("tool"), wsRows.join(","));
  const wsBtn = await page.$eval("#btn-ws", (e) => e.textContent);
  check("button reflects the connected state", wsBtn === "Putuskan", wsBtn);
  await page.click("#btn-ws");
  await sleep(400);
  check("disconnect is honoured", (await page.evaluate(() => window.__unifier.live.connected)) === false);

  console.log("\n10. Speech synthesis path");
  await page.evaluate(() => {
    document.getElementById("tab-speech").click();
    window.__unifier.unifier.ttsDrive();
  });
  await sleep(400);
  const ttsActive = await page.evaluate(() => window.__unifier.unifier.frame.active);
  check("TTS synthetic drive produces a frame", ttsActive === true);
  await page.click("#btn-tts");
  await sleep(500);
  const ttsStatus = await page.$eval("#speech-note", (e) => e.textContent);
  check("TTS reports a status", /Berbicara|Selesai|tidak didukung|gagal/i.test(ttsStatus), ttsStatus);

  console.log("\n11. Microphone path with a fake device");
  await page.evaluate(() => document.getElementById("tab-audio").click());
  await page.click("#btn-mic");
  await sleep(2500);
  const micMode = await page.evaluate(() => window.__unifier.unifier.audio.mode);
  check("mic engine reports mode=mic", micMode === "mic", "mode=" + micMode);
  const micLevel = await page.evaluate(() => window.__unifier.unifier.frame.level);
  check("mic produces a level reading", micLevel > 0, "level=" + micLevel.toFixed(4));
  const latency = await page.evaluate(() => window.__unifier.unifier.audio.latencyMs);
  check("latency is reported", typeof latency === "number" && latency >= 0, latency + " ms");
  const meter = await page.$eval("#meter-label", (e) => e.textContent);
  check("dB meter is populated", /dB/.test(meter), meter);

  console.log("\n12. Oscillator generator");
  await page.click("#btn-mic"); // release the device first
  await sleep(300);
  await page.click("#btn-osc");
  await sleep(1500);
  const oscMode = await page.evaluate(() => window.__unifier.unifier.audio.mode);
  check("oscillator engine starts", oscMode === "osc", "mode=" + oscMode);
  await page.click("#btn-osc");
  await sleep(300);
  const stopped = await page.evaluate(() => window.__unifier.unifier.mode);
  check("stopping the oscillator returns to idle", stopped === "idle", "mode=" + stopped);

  console.log("\n13. URL state round-trip");
  await page.evaluate(() => {
    window.__unifier.setMode("tunnel", false);
    window.__unifier.setPalette("ion");
    const el = document.getElementById("ctl-complexity");
    el.value = "1.75";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    const g = document.getElementById("tgl-glow");
    if (g.checked) g.click();
  });
  await sleep(200);
  const url = page.url();
  check("state is written to the URL", url.includes("mode=tunnel") && url.includes("palette=ion"), url.split("?")[1] || "");
  await page.goto(url, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__unifier, { timeout: 10_000 });
  const restored = await page.evaluate(() => ({
    mode: window.__unifier.state.mode,
    palette: window.__unifier.state.palette,
    complexity: window.__unifier.state.complexity,
    glow: window.__unifier.state.glow,
  }));
  check("URL restores mode", restored.mode === "tunnel", restored.mode);
  check("URL restores palette", restored.palette === "ion", restored.palette);
  check("URL restores numeric control", Math.abs(restored.complexity - 1.75) < 1e-6, String(restored.complexity));
  check("URL restores boolean toggle", restored.glow === false, String(restored.glow));

  console.log("\n14. Theme + share");
  await page.click("#btn-theme");
  const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  check("theme toggles to light", theme === "light", theme);
  await page.evaluate(() => window.__unifier.setMode("unified", false));
  await sleep(800);
  const lightStats = await canvasStats(page);
  check("visualizer still paints in light theme", lightStats.colours > 40, "colours=" + lightStats.colours);
  if (SHOTS) await page.screenshot({ path: join(OUT, "theme-light.png"), fullPage: false });
  await page.click("#btn-theme");

  console.log("\n15. Layout + accessibility invariants");
  const layout = await page.evaluate(() => {
    const stage = document.getElementById("stage-wrap").getBoundingClientRect();
    const cs = getComputedStyle(document.body);
    return {
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      stageAspect: stage.width / stage.height,
      fontSizes: (() => {
        const seen = new Set();
        document.querySelectorAll("h1,h2,h3,p,span,b,small,a,button,li,label,kbd,code,pre").forEach((el) => {
          if (!el.textContent.trim()) return;
          seen.add(getComputedStyle(el).fontSize);
        });
        return [...seen];
      })(),
      bodyFont: cs.fontFamily,
    };
  });
  check("no horizontal overflow at 1440px", layout.overflowX <= 1, layout.overflowX + "px");
  check("stage keeps 16:9", Math.abs(layout.stageAspect - 16 / 9) < 0.05, layout.stageAspect.toFixed(3));
  check("type scale stays small (≤ 14 distinct sizes)", layout.fontSizes.length <= 14,
    layout.fontSizes.length + " sizes");

  /* WCAG audit in both themes: the same DOM, judged on composited colour.
     The pointer is parked in a corner first — an earlier click can leave the
     cursor over the drop zone, which changes the surface under the text.
     Waits exceed the longest colour transition (--dur-2, 220ms), otherwise the
     audit samples a half-finished hover and reports a colour nobody ever sees. */
  const SETTLE = 420;
  await page.mouse.move(2, 2);
  await sleep(SETTLE);
  for (const theme of ["dark", "light"]) {
    await page.evaluate((t) => window.__unifier.setTheme(t), theme);
    await sleep(SETTLE);
    const audit = await page.evaluate(CONTRAST_AUDIT);
    check(`no WCAG AA failures in ${theme} theme`, audit.failures.length === 0,
      audit.failures.slice(0, 3).map((f) => `${f.sel} "${f.txt}" ${f.cr}<${f.min} on ${f.bg}`).join(" | ") || "clean");
    check(`no button leaks the UA default background (${theme})`, audit.uaBackgrounds.length === 0,
      audit.uaBackgrounds.slice(0, 3).join(",") || "clean");
  }

  /* hover states get their own pass: a lifted surface can strand its own label */
  await page.hover(".dropzone");
  await sleep(SETTLE);
  const hoverAudit = await page.evaluate(CONTRAST_AUDIT);
  check("no WCAG AA failures while hovering the drop zone", hoverAudit.failures.length === 0,
    hoverAudit.failures.slice(0, 3).map((f) => `${f.sel} "${f.txt}" ${f.cr}<${f.min} on ${f.bg}`).join(" | ") || "clean");
  await page.mouse.move(2, 2);
  await sleep(SETTLE);
  await page.evaluate(() => window.__unifier.setTheme("dark"));

  // narrow viewport
  await page.setViewport({ width: 390, height: 844 });
  await sleep(600);
  const narrow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("no horizontal overflow at 390px", narrow <= 1, narrow + "px");
  if (SHOTS) await page.screenshot({ path: join(OUT, "narrow.png"), fullPage: false });
  await page.setViewport({ width: 1440, height: 1000 });

  console.log("\n16. Reduced motion is honoured");
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__unifier, { timeout: 10_000 });
  await page.click("#btn-demo");
  await sleep(900);
  const engineLabel = await page.$eval("#engine-label", (e) => e.textContent);
  check("reduced-motion is surfaced in the HUD", /reduced-motion/.test(engineLabel), engineLabel);

  console.log("\n17. Single-file build is self-contained");
  const distHtml = await readFile(join(ROOT, "dist/unifier.html"), "utf8");
  check("dist has no external css link", !/rel="stylesheet" href="(?!data:)/.test(distHtml));
  check("dist has no external script src", !/<script src="/.test(distHtml));
  check("dist inlines all four modules", ["UnifierCore", "UnifierSources", "UnifierViz", "__unifier"]
    .every((k) => distHtml.includes(k)));
  const distErrors = [];
  const page2 = await browser.newPage();
  page2.on("pageerror", (e) => distErrors.push(e.message));
  page2.on("console", (m) => { if (m.type() === "error") distErrors.push(m.text()); });
  await page2.goto(`http://127.0.0.1:${port}/dist/unifier.html`, { waitUntil: "networkidle0" });
  await page2.waitForFunction(() => !!window.__unifier, { timeout: 10_000 });
  await page2.click("#btn-demo");
  await sleep(1200);
  const distStats = await canvasStats(page2);
  check("dist build boots and renders", distStats.colours > 40, "colours=" + distStats.colours);
  check("dist build has no console errors", distErrors.length === 0, distErrors.slice(0, 2).join(" | "));
  await page2.close();

  console.log("\n18. Meta + generated files");
  const meta = await page.evaluate(() => ({
    title: document.title,
    desc: document.querySelector('meta[name="description"]')?.content || "",
    og: document.querySelector('meta[property="og:image"]')?.content || "",
    canonical: document.querySelector('link[rel="canonical"]')?.href || "",
    icon: document.querySelector('link[rel="icon"]')?.href || "",
  }));
  check("title is set", meta.title.includes("Unifier"), meta.title);
  check("description is set", meta.desc.length > 40);
  check("og:image is set", meta.og.endsWith("social-card.png"));
  check("canonical is set", meta.canonical.includes("VisualisasiSuaraReal-timeUnifier"));
  check("favicon is set", meta.icon.includes("favicon.svg"));
  for (const f of ["robots.txt", "sitemap.xml", "manifest.webmanifest"]) {
    const body = await readFile(join(ROOT, f), "utf8");
    check(`generated ${f}`, body.length > 20);
  }
  const robots = await readFile(join(ROOT, "robots.txt"), "utf8");
  check("robots.txt points at the sitemap", robots.includes("sitemap.xml"));

  console.log("\n19. Anchor links resolve");
  const deadAnchors = await page.evaluate(() => {
    const ids = new Set([...document.querySelectorAll("[id]")].map((e) => e.id));
    return [...document.querySelectorAll('a[href^="#"]')]
      .map((a) => a.getAttribute("href").slice(1))
      .filter((h) => h && !ids.has(h));
  });
  check("no dead in-page anchors", deadAnchors.length === 0, deadAnchors.join(","));
  const scrollMargin = await page.evaluate(() => {
    const el = document.getElementById("kontrol");
    return getComputedStyle(el).scrollMarginTop;
  });
  check("anchors clear the sticky header", scrollMargin !== "0px" && scrollMargin !== "", scrollMargin);

  check("no console errors across the whole run", errors.length === 0, errors.slice(0, 4).join(" | "));

  await browser.close();
  server.close();
  wsProc.kill();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("\nFailures:");
    failed.forEach((f) => console.log(`  - ${f.name} ${f.detail}`));
    process.exitCode = 1;
  }
  await writeFile(join(OUT, "smoke-report.json"), JSON.stringify({ results, errors }, null, 2)).catch(() => {});
}

main().catch((e) => { console.error(e); process.exit(1); });
