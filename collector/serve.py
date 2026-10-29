#!/usr/bin/env python3
"""AOS-1 Observatory — read-only HTTP-Server (Muster: memory-live/serve.py).

GET-only. Bind aus config (Public-Default 127.0.0.1, nie 0.0.0.0). Strikter Path-Guard
(nur definierte Routen + statische Dateien aus web/, kein ..). Liest die vom
Collector geschriebenen state.json / events.jsonl von Disk.

Routen:
  /  /index.html      -> web/index.html (falls vorhanden), sonst "AOS collector up"
  /state             -> state.json (application/json, no-store)
  /events?since=<n>  -> {events:[...], offset:<n>}  (no-store)
  /tokens            -> nur der tokens-Teil aus state.json
  /health            -> health-Teil aus state.json + {ok:true}
  web/*              -> statische Dateien (strikt innerhalb web/)
"""
import os
import json
import logging
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlsplit, parse_qs

import config    # SSOT fuer Bind/Port (P4.1)
import collector  # read_events(), STATE_FILE

BIND = config.BIND   # Public-Default 127.0.0.1; Betreiber-IP nur via aos.local.json
PORT = config.PORT   # finalen Port waehlt der Betrieb (CLI-Arg hat Vorrang)
HERE = os.path.dirname(os.path.abspath(__file__))
# Default: das mitgelieferte Vite-Build (web/dist); Fallback web/ fuer Dev ohne Build.
# Betrieb/Dev ueberschreibt per AOS_WEB_DIR.
_WEB_ROOT = os.path.dirname(HERE)
_DIST = os.path.join(_WEB_ROOT, "web", "dist")
WEB_DIR = os.environ.get("AOS_WEB_DIR") or (_DIST if os.path.isdir(_DIST) else os.path.join(_WEB_ROOT, "web"))
STATE_FILE = collector.STATE_FILE

# statische Datei-Endungen -> Content-Type (fuer web/*)
CTYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".wasm": "application/wasm",
    ".map": "application/json; charset=utf-8",
}

log = logging.getLogger("aos.serve")


def _load_state():
    with open(STATE_FILE, "rb") as f:
        return json.loads(f.read())


class H(BaseHTTPRequestHandler):
    server_version = "aos1-observatory"

    # -- Antwort-Helfer -------------------------------------------------------
    def _send(self, code, body, ctype, no_store=False):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if no_store:
            self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200, no_store=False):
        self._send(code, json.dumps(obj).encode(), "application/json", no_store)

    # -- statische Dateien aus web/ (strikter Path-Guard) ---------------------
    def _serve_static(self, rel):
        # rel ist der Pfad nach fuehrendem '/', ohne Query
        full = os.path.normpath(os.path.join(WEB_DIR, rel))
        # Guard: aufgeloester Pfad MUSS unterhalb WEB_DIR liegen
        if not (full == WEB_DIR or full.startswith(WEB_DIR + os.sep)):
            return self._json({"error": "forbidden"}, 403)
        if not os.path.isfile(full):
            return self._json({"error": "not found"}, 404)
        ctype = CTYPES.get(os.path.splitext(full)[1], "application/octet-stream")
        with open(full, "rb") as f:
            self._send(200, f.read(), ctype)

    def do_GET(self):
        u = urlsplit(self.path)
        p = u.path
        # harter Path-Guard gegen Traversal (zusaetzlich zur normpath-Pruefung)
        if ".." in self.path or "\\" in self.path or "\x00" in self.path:
            log.debug("GET %s -> 400 (bad path)", self.path)
            return self._json({"error": "bad path"}, 400)
        try:
            if p in ("/", "/index.html"):
                idx = os.path.join(WEB_DIR, "index.html")
                if os.path.isfile(idx):
                    with open(idx, "rb") as f:
                        return self._send(200, f.read(), CTYPES[".html"])
                return self._send(200, b"AOS collector up", "text/plain; charset=utf-8")

            if p == "/state":
                return self._json(_load_state(), no_store=True)

            if p == "/events":
                q = parse_qs(u.query)
                try:
                    since = max(0, int(q.get("since", ["0"])[0]))
                except ValueError:
                    return self._json({"error": "bad since"}, 400)
                events, offset = collector.read_events(since)
                return self._json({"events": events, "offset": offset}, no_store=True)

            if p == "/tokens":
                return self._json(_load_state().get("tokens", {}))

            if p == "/health":
                st = _load_state()
                return self._json({"ok": True, "health": st.get("health", {})})

            # sonst: statische Datei aus web/
            return self._serve_static(p.lstrip("/"))

        except FileNotFoundError:
            log.debug("GET %s -> 404 (no state yet)", self.path)
            return self._json({"error": "state not ready"}, 404)
        except (ValueError, OSError) as e:
            log.error("GET %s -> error: %s", self.path, e)
            return self._json({"error": type(e).__name__},
                              500 if isinstance(e, OSError) else 400)

    def _no(self):
        self._json({"error": "method not allowed"}, 405)

    do_POST = do_PUT = do_DELETE = do_PATCH = do_HEAD = do_OPTIONS = _no

    def log_message(self, fmt, *args):
        log.debug("%s - %s", self.address_string(), fmt % args)


def main():
    import sys
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    log.info("aos-observatory serve on %s:%d (web=%s)", BIND, port, WEB_DIR)
    ThreadingHTTPServer((BIND, port), H).serve_forever()


if __name__ == "__main__":
    main()
