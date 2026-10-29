#!/usr/bin/env python3
"""Unifier build script.

Sources of truth:
    index.html, css/*.css, js/*.js

Outputs (all generated, all checked in so GitHub Pages can serve them):
    dist/unifier.html     single-file build (CSS + JS inlined)
    robots.txt, sitemap.xml, manifest.webmanifest
    assets/favicon.svg

Run:  python3 tools/build.py
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

SITE = {
    "name": "Unifier",
    "tagline": "Visualisasi Suara Real-time",
    "url": "https://antono4.github.io/VisualisasiSuaraReal-timeUnifier/",
    "repo": "https://github.com/antono4/VisualisasiSuaraReal-timeUnifier",
    "lang": "id",
    "theme": "#070b14",
}

FAVICON = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <defs>
    <linearGradient id="g" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="#2dd4bf"/>
      <stop offset="1" stop-color="#6366f1"/>
    </linearGradient>
  </defs>
  <rect width="32" height="32" rx="8" fill="#070b14"/>
  <g fill="url(#g)">
    <rect x="7"  y="14" width="3" height="8"  rx="1.5"/>
    <rect x="12" y="8"  width="3" height="16" rx="1.5"/>
    <rect x="17" y="11" width="3" height="12" rx="1.5"/>
    <rect x="22" y="6"  width="3" height="18" rx="1.5"/>
  </g>
</svg>
"""


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def inline(html: str) -> str:
    """Replace <link rel=stylesheet> and <script src> with inline content."""
    def css_repl(m: re.Match[str]) -> str:
        href = m.group(1)
        body = read(ROOT / href)
        return f"<style>\n{body}\n</style>"

    html = re.sub(r'<link rel="stylesheet" href="([^"]+)">', css_repl, html)

    def js_repl(m: re.Match[str]) -> str:
        src = m.group(1)
        body = read(ROOT / src)
        return f"<script>\n{body}\n</script>"

    html = re.sub(r'<script src="([^"]+)"></script>', js_repl, html)

    # single-file build: the manifest and favicon are inlined as data URIs
    # (base64 — raw JSON/SVG would break on '#', quotes and newlines).
    # Paths inside the inlined manifest must be absolute: relative ones would
    # resolve against the page's own directory and 404.
    dist_manifest = json.loads(MANIFEST)
    dist_manifest["start_url"] = SITE["url"]
    dist_manifest["scope"] = SITE["url"]
    dist_manifest["icons"] = [
        {"src": SITE["url"] + "assets/favicon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any maskable"}
    ]
    manifest = json.dumps(dist_manifest, separators=(",", ":")).encode("utf-8")
    html = html.replace(
        '<link rel="manifest" href="manifest.webmanifest">',
        '<link rel="manifest" href="data:application/manifest+json;base64,'
        + base64.b64encode(manifest).decode("ascii")
        + '">',
    )
    html = html.replace(
        '<link rel="icon" href="assets/favicon.svg" type="image/svg+xml">',
        '<link rel="icon" href="data:image/svg+xml;base64,'
        + base64.b64encode(FAVICON.encode("utf-8")).decode("ascii")
        + '" type="image/svg+xml">',
    )
    return html


MANIFEST = json.dumps(
    {
        "name": "Unifier — Visualisasi Suara Real-time",
        "short_name": "Unifier",
        "description": "Eksperimen visualisasi suara: audio, ucapan, dan sinyal agen AI menjadi efek visual.",
        "start_url": "./",
        "scope": "./",
        "display": "standalone",
        "background_color": SITE["theme"],
        "theme_color": SITE["theme"],
        "lang": "id",
        "icons": [
            {"src": "assets/favicon.svg", "sizes": "any", "type": "image/svg+xml", "purpose": "any maskable"}
        ],
    },
    indent=2,
)


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]
    print(f"  wrote {path.relative_to(ROOT)}  ({len(text):,} bytes, sha {digest})")


def main() -> None:
    print("Unifier build")

    html = read(ROOT / "index.html")
    write(DIST / "unifier.html", inline(html))

    write(ROOT / "assets" / "favicon.svg", FAVICON)
    write(ROOT / "manifest.webmanifest", MANIFEST)

    write(
        ROOT / "robots.txt",
        "User-agent: *\nAllow: /\n\nSitemap: " + SITE["url"] + "sitemap.xml\n",
    )
    write(
        ROOT / "sitemap.xml",
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        f'  <url>\n    <loc>{SITE["url"]}</loc>\n    <changefreq>weekly</changefreq>\n'
        "    <priority>1.0</priority>\n  </url>\n</urlset>\n",
    )
    print("done")


if __name__ == "__main__":
    main()
