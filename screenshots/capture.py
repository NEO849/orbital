#!/usr/bin/env python3
"""orbital — Headless-Screenshot-Harness (R3.0).

Rendert die Live-Szene serverseitig mit SwiftShader (kein GPU noetig) und legt PNGs ab.
Dadurch unabhaengig vom Mac-Browser-Tab: ein verdeckter Tab drosselt requestAnimationFrame
und liefert schwarze Screenshots — headless rendert dagegen IMMER.

Aufruf:
    python3 capture.py [URL] [WELLE]
Default-URL: http://127.0.0.1:8942/?capture=1  (Loopback; Operator uebergibt Bind-URL als argv[1])
Default-WELLE: r3   -> Dateien screenshots/<welle>-desktop.png + <welle>-mobile.png

Wartet auf window.__frameReady (erster wirklich gerenderte Frame, gesetzt in main.js),
dann 2.5 s Nachlauf fuer Animation/Bloom. Prueft zusaetzlich den WebGL-Renderer-String
(muss SwiftShader/ANGLE zeigen) und meldet Konsolenfehler.
"""
import sys
import pathlib
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8942/?capture=1"
WAVE = sys.argv[2] if len(sys.argv) > 2 else "r3"
OUT = pathlib.Path(__file__).parent
VIEWPORTS = {"desktop": (1440, 900), "mobile": (390, 844)}
# Chromium-Flags fuer Software-WebGL ohne GPU (chromium docs/gpu/swiftshader.md).
FLAGS = [
    "--use-gl=angle",
    "--use-angle=swiftshader-webgl",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
]

RENDERER_JS = """() => {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return 'NO-WEBGL';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  } catch (e) { return 'ERR:' + e.message; }
}"""


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=FLAGS)
        results = []
        for name, (w, h) in VIEWPORTS.items():
            page = browser.new_page(viewport={"width": w, "height": h}, device_scale_factor=1)
            logs = []
            page.on("console", lambda m: logs.append((m.type, m.text)))
            page.on("pageerror", lambda e: logs.append(("pageerror", str(e))))
            page.goto(URL, wait_until="load", timeout=30000)
            try:
                page.wait_for_function("window.__frameReady === true", timeout=15000)
                ready = True
            except Exception:
                ready = False
            page.wait_for_timeout(2500)  # Nachlauf fuer Animation/Bloom
            renderer = page.evaluate(RENDERER_JS)
            out = OUT / f"{WAVE}-{name}.png"
            page.screenshot(path=str(out))
            errs = [t for (lvl, t) in logs if lvl in ("error", "pageerror")]
            results.append((name, ready, renderer, out, len(logs), errs[:6]))
            page.close()
        browser.close()

    print("=" * 64)
    for name, ready, renderer, out, nlogs, errs in results:
        print(f"[{name}] frameReady={ready}  renderer={renderer!r}")
        print(f"         -> {out}  (console-lines={nlogs}, errors={len(errs)})")
        for e in errs:
            print("         ERR:", e[:200])
    print("=" * 64)
    # Exit-Code: nicht-null, wenn ein Frame nie bereit wurde oder kein WebGL.
    bad = any((not r[1]) or (not r[2]) or str(r[2]).startswith(("NO-WEBGL", "ERR:")) for r in results)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
