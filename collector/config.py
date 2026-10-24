#!/usr/bin/env python3
"""AOS-1 Observatory — Konfiguration (Engine<->Daten-Trennung, P4.1).

GRUNDSATZ fuer OSS: das OEFFENTLICHE Repository darf WEDER die echten Pfade
NOCH die Bind-IP des Betreibers enthalten. Alle umgebungsspezifischen Werte
stehen hier mit SICHEREN PUBLIC-DEFAULTS und werden lokal ueberschrieben
(nie committet), in dieser Rangfolge:

  1. AOS_*-Umgebungsvariablen            (hoechste Prioritaet)
  2. aos.local.json  (neben dieser Datei, GITIGNORED)
  3. die Defaults unten                  (safe fuer die Oeffentlichkeit)

Default-Modus ist "demo": frisch ausgecheckt zeigt die App eine SYNTHETISCHE
Firma, liest NICHTS Echtes und bindet nur an localhost. Der Betreiber hebt
sich seine echte Instanz ueber aos.local.json (mode="live", eigene IP/Pfade).
"""
import os
import json

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)
_HOME = os.path.expanduser("~")

# ---- SICHERE PUBLIC-DEFAULTS ------------------------------------------------
# Enthalten bewusst KEINE privaten Pfade und KEINE Betreiber-IP.
_DEFAULTS = {
    "mode": "demo",                       # "demo" (synthetisch) | "live" (echte Quellen)
    "bind": "127.0.0.1",                  # NIE die private Betreiber-IP im Repo. Nie 0.0.0.0.
    "port": 8080,                         # generischer Public-Default; eigener Port via aos.local.json
    "interval": 2.0,                      # Produzenten-Takt (s)

    # Daten-Wurzel fuer den Live-Modus. Generisch aus dem Home abgeleitet.
    "claude_home": os.path.join(_HOME, ".claude"),

    # Optionale explizite Quell-Overrides. Leer => aus claude_home abgeleitet
    # (sessions/projects) bzw. Quelle uebersprungen (memory/bus/services/brett).
    "sessions_dir": "",
    "projects_dir": "",
    "memory_dir": "",
    "bus_audit": "",
    "services_json": "",
    "brett_json": "",
    "tmux_log_fmt": "",   # leer => Tool-Aktivitaets-Quelle aus; Betreiber setzt sein Format lokal

    # Welche Hosts auf Dienst-Erreichbarkeit TCP-proben. Public: nur localhost.
    "probe_hosts": ["127.0.0.1"],

    # Wohin der Produzent schreibt / woher der Server liest (install-relativ).
    "state_file": os.path.join(HERE, "state.json"),
    "events_file": os.path.join(HERE, "events.jsonl"),
}


def _coerce(default, val):
    """Env-String auf den Typ des Defaults bringen (bool/int/float/list/str)."""
    if isinstance(default, bool):
        return str(val).strip().lower() in ("1", "true", "yes", "on")
    if isinstance(default, int) and not isinstance(default, bool):
        try:
            return int(val)
        except (TypeError, ValueError):
            return default
    if isinstance(default, float):
        try:
            return float(val)
        except (TypeError, ValueError):
            return default
    if isinstance(default, list):
        if isinstance(val, list):
            return val
        return [x.strip() for x in str(val).split(",") if x.strip()]
    return val


def _load():
    cfg = dict(_DEFAULTS)
    # (2) lokale, gitignorierte Override-Datei
    p = os.path.join(HERE, "aos.local.json")
    try:
        with open(p, encoding="utf-8") as f:
            loaded = json.load(f)
        if isinstance(loaded, dict):
            cfg.update(loaded)
    except (OSError, ValueError):
        pass  # fehlt/kaputt -> Defaults (public) greifen
    # (1) Env-Overrides (hoechste Prioritaet)
    for k in list(cfg.keys()):
        ev = os.environ.get("AOS_" + k.upper())
        if ev is not None:
            cfg[k] = _coerce(_DEFAULTS.get(k, ""), ev)
    # Quell-Pfade aus claude_home ableiten, wenn nicht explizit gesetzt
    ch = cfg["claude_home"]
    cfg["sessions_dir"] = cfg["sessions_dir"] or os.path.join(ch, "sessions")
    cfg["projects_dir"] = cfg["projects_dir"] or os.path.join(ch, "projects")
    return cfg


CFG = _load()

# ---- flache Exporte (von collector.py / serve.py / demo.py genutzt) ---------
MODE = CFG["mode"]
BIND = CFG["bind"]
PORT = int(CFG["port"])
INTERVAL = float(CFG["interval"])
CLAUDE_HOME = CFG["claude_home"]
SESSIONS_DIR = CFG["sessions_dir"]
PROJECTS_DIR = CFG["projects_dir"]
MEM_DIR = CFG["memory_dir"]
MEM_ACCESS_LOG = os.path.join(MEM_DIR, "metrics", "access_log.jsonl") if MEM_DIR else ""
BUS_AUDIT = CFG["bus_audit"]
SERVICES_JSON = CFG["services_json"]
BRETT_JSON = CFG["brett_json"]
TMUX_LOG_FMT = CFG["tmux_log_fmt"]
PROBE_HOSTS = tuple(CFG["probe_hosts"]) or ("127.0.0.1",)
STATE_FILE = CFG["state_file"]
EVENTS_FILE = CFG["events_file"]


if __name__ == "__main__":
    # Schneller Sichtbarkeits-Check ohne private Werte zu leaken (Pfade gekuerzt).
    safe = dict(CFG)
    print(json.dumps({"mode": MODE, "bind": BIND, "port": PORT,
                      "claude_home_set": bool(CFG["claude_home"]),
                      "live_sources": {k: bool(safe[k]) for k in
                                       ("memory_dir", "bus_audit", "services_json", "brett_json")},
                      "probe_hosts": list(PROBE_HOSTS)}, indent=2))
