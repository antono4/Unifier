#!/usr/bin/env node
/**
 * Generate the README screenshots.
 *
 * Drives the real page in headless Chromium and writes full-resolution PNGs to
 * .agent_tmp/shots/. The mode gallery is produced by the app's own export path,
 * so the images show exactly what the download button hands you.
 *
 *   node tools/make-shots.mjs
 *   python3 tools/make_assets.py     # downscales + optimises into docs/
 */

import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, ".agent_tmp/shots");
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

const MODES = ["bars", "wave", "radial", "particles", "tunnel", "unified"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function serve() {
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      const rel = path === "/" ? "/index.html" : path;
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

/** Ask the page for its own export and hand back the PNG bytes. */
async function grabExport(page) {
  const b64 = await page.evaluate(() => new Promise((resolve) => {
    const real = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (o) => {
      if (o instanceof Blob) {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result.split(",")[1]);
        fr.readAsDataURL(o);
      }
      return real(o);
    };
    window.__unifier.exportStill();
  }));
  return Buffer.from(b64, "base64");
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const server = await serve();
  const port = server.address().port;

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--force-color-profile=srgb", "--window-size=1440,1000"],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: "networkidle0" });
  await page.waitForFunction(() => !!window.__unifier, { timeout: 15_000 });

  /* demo feed so every shot has real signal behind it */
  await page.click("#btn-demo");
  await sleep(2500);

  const written = [];

  /* hero: the whole app as it looks on load */
  await page.evaluate(() => window.__unifier.setMode("unified", false));
  await sleep(1400);
  await page.screenshot({ path: join(OUT, "hero.png") });
  written.push("hero.png");

  /* mode gallery, straight from the export path */
  for (const mode of MODES) {
    await page.evaluate((m) => window.__unifier.setMode(m, false), mode);
    await sleep(1600);
    const png = await grabExport(page);
    await writeFile(join(OUT, `mode-${mode}.png`), png);
    written.push(`mode-${mode}.png`);
  }

  /* light theme, same stage */
  await page.evaluate(() => {
    window.__unifier.setTheme("light");
    window.__unifier.setMode("unified", false);
  });
  await sleep(1600);
  await page.screenshot({ path: join(OUT, "light.png") });
  written.push("light.png");

  await browser.close();
  server.close();

  for (const f of written) console.log("wrote .agent_tmp/shots/" + f);
  console.log(`\n${written.length} shots. Now run: python3 tools/make_assets.py`);
}

main().catch((e) => { console.error(e); process.exit(1); });
