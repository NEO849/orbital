#!/usr/bin/env python3
"""AOS-1 Observatory — read-only Telemetrie-Collector.

Liest ausschliesslich lokale Signal-Quellen von Disk und baut EIN State-dict
nach SCHEMA.md (Entity/Edge/Event/State). Rein read-only gegenueber dem System.

Modi:
  python3 collector.py --once     einmal bauen + state.json/events.jsonl schreiben, exit
  python3 collector.py --daemon   Endlosschleife, alle INTERVAL s neu bauen

FAIL-OPEN: jede Quelle laeuft in eigenem try/except. Eine kaputte/fehlende
Quelle darf build_state() NIE crashen — sie wird im health-dict markiert und
mit leeren Daten uebersprungen.
"""
import os
import re
import sys
import glob
import json
import time
import socket
import logging
import datetime
from collections import deque, OrderedDict
from logging.handlers import RotatingFileHandler

import config   # SSOT fuer Bind/Pfade/Modus (P4.1: keine privaten Werte mehr hart verdrahtet)

# ----------------------------------------------------------------------------
# Pfade — ALLE umgebungsspezifischen Werte kommen aus config (Public-Default =
# ~/.claude + localhost; Betreiber hebt sich seine echten Pfade in aos.local.json).
# Nur install-relative, nicht-private Pfade (logs/) bleiben hier lokal.
# ----------------------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))                 # .../collector
BASE = os.path.dirname(HERE)                                      # .../aos-observatory
LOG_DIR = os.path.join(BASE, "logs")
STATE_FILE = config.STATE_FILE
EVENTS_FILE = config.EVENTS_FILE

SESSIONS_DIR = config.SESSIONS_DIR
TMUX_LOG_FMT = config.TMUX_LOG_FMT
MEM_DIR = config.MEM_DIR
MEM_ACCESS_LOG = config.MEM_ACCESS_LOG
BUS_AUDIT = config.BUS_AUDIT
SERVICES_JSON = config.SERVICES_JSON
BRETT_JSON = config.BRETT_JSON

INTERVAL = config.INTERVAL            # Daemon-Takt in Sekunden
SESSION_ACTIVE_MS = 90_000   # Session gilt als aktiv, wenn vor < 90s aktualisiert
TMUX_TAIL_LINES = 40     # je aktiver Session die letzten N Aktivitaets-Zeilen
MEM_TAIL_LINES = 60      # letzte N Memory-Zugriffe als juengste Events
DEDUP_WINDOW = 4000      # Event-Signaturen die der Daemon gegen Doppel-Schreiben haelt

# ----------------------------------------------------------------------------
# Logging: rotierendes Logfile + Komponenten-Tag
# ----------------------------------------------------------------------------
log = logging.getLogger("aos.collector")


def _setup_logging():
    log.setLevel(logging.INFO)
    if log.handlers:
        return
    try:
        os.makedirs(LOG_DIR, exist_ok=True)   # nur unter aos-observatory
        fh = RotatingFileHandler(
            os.path.join(LOG_DIR, "collector.log"),
            maxBytes=1 << 20, backupCount=3, encoding="utf-8",
        )
        fh.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname)s [%(name)s] %(message)s"))
        log.addHandler(fh)
    except OSError as e:
        # Logfile nicht anlegbar -> trotzdem auf stderr weiterarbeiten
        print(f"WARN: logfile setup failed: {e}", file=sys.stderr)
    sh = logging.StreamHandler()
    sh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s"))
    log.addHandler(sh)


# ----------------------------------------------------------------------------
# Helfer
# ----------------------------------------------------------------------------
_PANE_RE = re.compile(r"%(\d+)")                       # tmux "...:@<win>.%<pane>"
_ACT_RE = re.compile(r"^(\d{2}):(\d{2})\|([^|]*)\|(.*)$")  # HH:MM|TOOL|LABEL
_MEM_MD_RE = re.compile(r"([A-Za-z0-9_.-]+\.md)")      # Memory-Dateiname im Label


def _now_iso():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")[:-4] + "Z"


def _memtype(fname):
    """Memtype aus dem Dateinamen-Praefix ableiten (Datenschutz: nur Typ, kein Inhalt)."""
    b = os.path.basename(fname).lower()
    if b.startswith("feedback_"):
        return "feedback"
    if b.startswith("project_"):
        return "project"
    if b.startswith("reference_"):
        return "reference"
    if b.startswith("user_") or b.startswith("profile_"):
        return "user"
    return "other"


def _verb_for(tool):
    """Rohes Tool -> Event-Verb (SCHEMA: read|edit|write|bash|web|spawn|access)."""
    t = (tool or "").lower()
    if t == "read":
        return "read"
    if t == "edit":
        return "edit"
    if t == "write":
        return "write"
    if t == "bash":
        return "bash"
    if t in ("websearch", "webfetch"):
        return "web"
    if t in ("task", "agent"):
        return "spawn"
    return "access"


def _reconstruct_ts(hh, mm):
    """HH:MM hat kein Datum -> heutiges Datum + Uhrzeit (lokal). Liegt das in der
    Zukunft (z.B. 23:50-Zeile kurz nach Mitternacht), dann minus 1 Tag. Ausgabe UTC-ISO."""
    now = datetime.datetime.now()
    dt = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if dt > now:
        dt -= datetime.timedelta(days=1)
    return datetime.datetime.fromtimestamp(
        dt.timestamp(), datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:00.000Z")


# Wo lauschen die Dienste? Dienste koennen bewusst an eine Nicht-localhost-IP binden
# (z.B. Tailscale, NICHT 0.0.0.0) — ein reiner 127.0.0.1-Probe faende sie nie und
# meldete sie faelschlich "down". Daher ALLE konfigurierten Hosts probieren: einer
# genuegt. Liste kommt aus der Config (Public-Default: nur localhost).
PROBE_HOSTS = config.PROBE_HOSTS


def _port_alive(port, timeout=0.2):
    """Billiger TCP-Connect-Check an allen Bind-Hosts (kein Subprocess-Sturm).
    Geschlossene Ports antworten mit ECONNREFUSED sofort → kein Timeout-Sturm."""
    for host in PROBE_HOSTS:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(timeout)
            rc = s.connect_ex((host, int(port)))
            s.close()
            if rc == 0:
                return True
        except OSError:
            continue
    return False


def _tail_lines(path, n, max_bytes=1 << 18):
    """Letzte ~n Zeilen einer Textdatei lesen (Rueckwaerts-Fenster, read-only)."""
    with open(path, "rb") as f:
        size = os.fstat(f.fileno()).st_size
        start = max(0, size - max_bytes)
        f.seek(start)
        raw = f.read(size - start)
    if start > 0:                       # erste, evtl. angeschnittene Zeile verwerfen
        nl = raw.find(b"\n")
        raw = raw[nl + 1:] if nl >= 0 else b""
    txt = raw.decode("utf-8", "replace")
    lines = [ln for ln in txt.split("\n") if ln.strip()]
    return lines[-n:] if n > 0 else lines


# ----------------------------------------------------------------------------
# Transcript-Reader: Modell(e) + ECHTE Tokens + ECHTE Bytes je Session.
# Quelle = das Session-Transcript-JSONL (projects/<proj>/<sid>.jsonl): jede
# Assistant-Zeile traegt model + usage(tokens); tool_result-Inhalte = echtes
# Datenvolumen (Bytes rein). Ersetzt die bisherigen Proxys. mtime/size-Cache
# haelt die Kosten niedrig (unveraenderte Transcripts werden nicht neu geparst),
# nur der 512KB-Schwanz wird gelesen (Transcripts werden sehr gross).
# ----------------------------------------------------------------------------
PROJECTS_DIR = config.PROJECTS_DIR
TX_TAIL_BYTES = 512 * 1024
TOKEN_WINDOW_SEC = 300                 # Rate = Summe der letzten 5 min / 5
EVENT_WINDOW_SEC = 120                 # tool_use juenger als 120s = frischer Live-Burst
_tx_cache = {}                         # sid -> {"key": (mtime,size), "stats": {...}}


def _parse_iso(s):
    """ISO-8601 (…Z) -> Epoch-Sekunden, sonst None."""
    if not s:
        return None
    try:
        return datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError):
        return None


def _content_len(c):
    """Grobe Byte-Laenge eines content-Werts (str | list von text/content-parts)."""
    if isinstance(c, str):
        return len(c)
    if isinstance(c, list):
        t = 0
        for part in c:
            if isinstance(part, dict):
                t += _content_len(part.get("content") or part.get("text") or "")
            elif isinstance(part, str):
                t += len(part)
        return t
    return 0


def _find_transcript(sid):
    if not sid:
        return None
    hits = glob.glob(os.path.join(PROJECTS_DIR, "*", f"{sid}.jsonl"))
    return hits[0] if hits else None


def read_transcript_stats(sid, now_s):
    """Pro Session: {models[], tokens{}, tok_per_min, bytes_per_min} oder None.
    models = distinkte Modelle im Fenster — MEHRERE gleichzeitig moeglich
    (Haupt-Session + Subagenten laufen auf verschiedenen Modellen)."""
    path = _find_transcript(sid)
    if not path:
        return None
    try:
        st = os.stat(path)
        key = (st.st_mtime, st.st_size)
    except OSError:
        return None
    cached = _tx_cache.get(sid)
    if cached and cached["key"] == key:
        return cached["stats"]
    sid8 = (sid or "")[:8]
    models, seen, last_model = [], set(), None
    tok = {"input": 0, "output": 0, "cache_read": 0, "cache_creation": 0}
    win_tok = win_bytes = 0
    events = []
    cutoff = now_s - TOKEN_WINDOW_SEC
    ev_cutoff = now_s - EVENT_WINDOW_SEC
    try:
        for ln in _tail_lines(path, 0, max_bytes=TX_TAIL_BYTES):
            if not ln or ln[0] != "{":
                continue
            try:
                o = json.loads(ln)
            except ValueError:
                continue                      # angeschnittene/letzte Zeile -> skip
            ts = _parse_iso(o.get("timestamp"))
            msg = o.get("message") or {}
            mdl = msg.get("model")
            if mdl and mdl != "<synthetic>":
                last_model = mdl
                if (ts is None or ts >= cutoff) and mdl not in seen:
                    seen.add(mdl)
                    models.append(mdl)
            u = msg.get("usage") or {}
            it = u.get("input_tokens") or 0
            ot = u.get("output_tokens") or 0
            tok["input"] += it
            tok["output"] += ot
            tok["cache_read"] += u.get("cache_read_input_tokens") or 0
            tok["cache_creation"] += u.get("cache_creation_input_tokens") or 0
            if ts is not None and ts >= cutoff:
                win_tok += it + ot
            # Content-Parts: tool_result = Bytes rein (300s), tool_use = frischer
            # Live-Event mit PRAEZISEM Zeitstempel (120s) -> echtzeitnaher Burst.
            content = msg.get("content")
            if isinstance(content, list):
                for part in content:
                    if not isinstance(part, dict):
                        continue
                    pt = part.get("type")
                    if pt == "tool_result" and ts is not None and ts >= cutoff:
                        win_bytes += _content_len(part.get("content"))
                    elif pt == "tool_use" and ts is not None and ts >= ev_cutoff:
                        nm = part.get("name") or "tool"
                        events.append({
                            "ts": o.get("timestamp"),
                            "session": sid8,
                            "actor": f"session:{sid8}",
                            "verb": _verb_for(nm),
                            "target": f"tool:{nm}",
                            "tool": nm,
                        })
    except OSError as e:
        log.warning("transcript read %s: %s", sid, e)
        return None
    if not models and last_model:
        models = [last_model]                 # idle: wenigstens das zuletzt genutzte
    win_min = TOKEN_WINDOW_SEC / 60.0
    stats = {
        "models": models,
        "tokens": tok,
        "tok_per_min": round(win_tok / win_min, 1),
        "bytes_per_min": round(win_bytes / win_min, 1),
        "events": events,
    }
    _tx_cache[sid] = {"key": key, "stats": stats}
    return stats


# ----------------------------------------------------------------------------
# State-Aufbau
# ----------------------------------------------------------------------------
class _Builder:
    """Sammelt Entities/Edges/Events dedupliziert waehrend eines build_state()-Laufs."""

    def __init__(self):
        self.entities = OrderedDict()   # id -> entity-dict
        self.edges = OrderedDict()      # (src,tgt,kind,static) -> edge-dict
        self.events = []                # juengste Events dieses Laufs
        self.health = {}                # source -> {status,last_success_ts,note}

    def entity(self, eid, etype, label, active=False, meta=None):
        if eid not in self.entities:
            self.entities[eid] = {
                "id": eid, "type": etype, "label": label,
                "active": bool(active), "heat": 0.0, "meta": meta or {},
            }
        else:
            e = self.entities[eid]
            e["active"] = e["active"] or bool(active)
            if meta:
                e["meta"].update(meta)
        return eid

    def edge(self, src, tgt, kind="access", static=False):
        if not src or not tgt:
            return
        key = (src, tgt, kind, static)
        if key not in self.edges:
            self.edges[key] = {"source": src, "target": tgt, "kind": kind, "static": static}

    def event(self, ev):
        self.events.append(ev)

    def ok(self, src, note=""):
        self.health[src] = {"status": "ok", "last_success_ts": _now_iso(), "note": note}

    def mark(self, src, status, note=""):
        self.health[src] = {"status": status, "last_success_ts": None, "note": note}


def build_state():
    """Liest ALLE Quellen und gibt EIN dict nach SCHEMA.md /state zurueck.

    Zusaetzlich enthaelt das dict den transienten Schluessel ``events`` (juengste
    Events dieses Laufs) fuer den Daemon-Ring; der Daemon entfernt ihn, bevor er
    state.json schreibt (state.json folgt strikt dem /state-Schema)."""
    b = _Builder()

    # sid8 -> pane (Join tmux-Pane <-> Session fuer die Aktivitaets-Logs)
    sid_pane = {}
    active_sids = set()
    tx_by_sid = {}            # sid8 -> Transcript-Stats (Modelle/Tokens/Bytes)
    now_s = time.time()

    # --- Quelle: sessions -----------------------------------------------------
    try:
        files = [p for p in glob.glob(os.path.join(SESSIONS_DIR, "*.json"))]
        now_ms = int(time.time() * 1000)
        count = 0
        for p in files:
            try:
                d = json.load(open(p, encoding="utf-8"))
            except (ValueError, OSError) as e:
                log.warning("session parse skip %s: %s", p, e)
                continue
            sid = d.get("sessionId") or ""
            sid8 = sid[:8] if sid else os.path.basename(p).split(".")[0]
            updated = d.get("updatedAt") or 0
            status = d.get("status")
            # active: busy ODER vor < 90s aktualisiert
            active = (status == "busy") or (now_ms - updated < SESSION_ACTIVE_MS)
            # tmux-Feld "<ns>:@<win>.%<pane>" -> Pane-Nummer nach '%'
            pane = None
            m = _PANE_RE.search(d.get("tmux") or "")
            if m:
                pane = m.group(1)
                sid_pane[sid8] = pane
            if active:
                active_sids.add(sid8)
            # Transcript-Stats: Modell(e) + echte Tokens/Bytes (mtime-gecacht)
            tx = read_transcript_stats(sid, now_s)
            if tx:
                tx_by_sid[sid8] = tx
                # Frische Tool-Aufruf-Events (praezise ts) -> echtzeitnahe Bursts;
                # Tool-Knoten + Kanten organisch anlegen (wie die tmux-Quelle).
                for ev in tx.get("events", []):
                    kind = "mcp" if ev["tool"].startswith("mcp__") else "builtin"
                    b.entity(ev["target"], "tool", ev["tool"], active=True, meta={"kind": kind})
                    b.edge(f"session:{sid8}", ev["target"], "access", static=False)
                    b.event(ev)
            models = tx["models"] if tx else []
            b.entity(
                f"session:{sid8}", "session", d.get("name") or sid8, active=active,
                meta={
                    "project": d.get("cwd"),
                    "status": status,
                    "model": models[0] if models else None,   # Primaer-Modell (Back-Compat)
                    "models": models,                         # ALLE (mehrere gleichzeitig moeglich)
                    "pane": pane,
                    "updatedAt": updated,
                },
            )
            count += 1
        b.ok("sessions", f"{count} sessions, {len(active_sids)} active")
    except Exception as e:                         # fail-open
        log.warning("sessions source error: %s", e)
        b.mark("sessions", "error", str(e))

    # --- Quelle: memory-Entitaeten (Cluster, nur Metadaten) -------------------
    try:
        groups = {}
        # Nur wenn ein Memory-Verzeichnis konfiguriert ist (sonst wuerde
        # glob("*.md") faelschlich das CWD scannen).
        for p in (glob.glob(os.path.join(MEM_DIR, "*.md")) if MEM_DIR else []):
            groups.setdefault(_memtype(p), 0)
            groups[_memtype(p)] += 1
        for mt, n in groups.items():
            b.entity(f"memcluster:{mt}", "memory", f"{mt} ({n} Karten)",
                     meta={"memtype": mt, "count": n})
        b.ok("memory_entities", f"{len(groups)} cluster")
    except Exception as e:
        log.warning("memory_entities source error: %s", e)
        b.mark("memory_entities", "error", str(e))

    # --- Quelle: tool-Aktivitaet je aktiver Session ---------------------------
    try:
        seen_tools = 0
        for sid8 in list(active_sids):
            pane = sid_pane.get(sid8)
            if not pane:
                continue
            path = TMUX_LOG_FMT.format(pane=pane)
            if not os.path.exists(path):
                # Pane ohne Aktivitaets-Log -> fail-open, Session bleibt trotzdem Entity
                continue
            try:
                lines = _tail_lines(path, TMUX_TAIL_LINES)
            except OSError as e:
                log.warning("tmux log read skip %s: %s", path, e)
                continue
            for ln in lines:
                m = _ACT_RE.match(ln)
                if not m:
                    # Fortsetzungs-/Mehrzeilen-Label -> ueberspringen (nicht raten)
                    continue
                hh, mm, tool, label = int(m.group(1)), int(m.group(2)), m.group(3), m.group(4)
                if not tool or tool.startswith("__"):   # z.B. __task_reset__
                    continue
                verb = _verb_for(tool)
                # Tool-Knoten organisch anlegen
                tool_id = b.entity(f"tool:{tool}", "tool", tool, active=True,
                                   meta={"kind": "builtin"})
                # Ziel bestimmen: Memory-Datei im Label -> memcluster, sonst Tool
                target = tool_id
                if verb in ("read", "edit", "write"):
                    mm_md = _MEM_MD_RE.search(label)
                    if mm_md and ("memory" in label.lower() or _memtype(mm_md.group(1)) != "other"
                                  or mm_md.group(1).lower().startswith("memory")):
                        target = f"memcluster:{_memtype(mm_md.group(1))}"
                actor = f"session:{sid8}"
                b.event({
                    "ts": _reconstruct_ts(hh, mm),
                    "session": sid8,
                    "actor": actor,
                    "verb": verb,
                    "target": target,
                    "tool": tool,
                })
                b.edge(actor, target, "access", static=False)      # fluechtig
                b.edge(actor, tool_id, "access", static=True)      # statische Topologie
                seen_tools += 1
        b.ok("tool_activity", f"{seen_tools} tool events")
    except Exception as e:
        log.warning("tool_activity source error: %s", e)
        b.mark("tool_activity", "error", str(e))

    # --- Quelle: memory-reads (access_log.jsonl) ------------------------------
    try:
        n = 0
        if os.path.exists(MEM_ACCESS_LOG):
            for ln in _tail_lines(MEM_ACCESS_LOG, MEM_TAIL_LINES):
                try:
                    d = json.loads(ln)
                except ValueError:
                    continue
                sid8 = (d.get("session") or "")[:8]
                fname = d.get("file") or ""
                if not sid8 or not fname:
                    continue
                target = f"memcluster:{_memtype(fname)}"
                actor = f"session:{sid8}"
                # memcluster-Entity sicherstellen (falls md-Listing es nicht hatte)
                if target not in b.entities:
                    b.entity(target, "memory", f"{_memtype(fname)} (? Karten)",
                             meta={"memtype": _memtype(fname)})
                b.event({
                    "ts": d.get("ts"),
                    "session": sid8,
                    "actor": actor,
                    "verb": "read",
                    "target": target,
                    "tool": "Read",
                })
                b.edge(actor, target, "memory", static=False)
                n += 1
        b.ok("memory_reads", f"{n} memory read events")
    except Exception as e:
        log.warning("memory_reads source error: %s", e)
        b.mark("memory_reads", "error", str(e))

    # --- Quelle: claude-bus audit.log -----------------------------------------
    # Format selbst sniffen. Aktuell: {ts,actor,channel,tool,args,...} OHNE
    # session-id (actor="mobile"). Ohne session-id KEINE Events raten -> stale.
    try:
        has_session = False
        sampled = 0
        if os.path.exists(BUS_AUDIT):
            for ln in _tail_lines(BUS_AUDIT, 5):
                try:
                    d = json.loads(ln)
                except ValueError:
                    continue
                sampled += 1
                sid = d.get("session") or d.get("sessionId")
                if sid:
                    has_session = True
                    sid8 = str(sid)[:8]
                    tool = d.get("tool") or "bus"
                    actor = f"session:{sid8}"
                    tool_id = b.entity(f"tool:{tool}", "tool", tool, meta={"kind": "mcp"})
                    b.event({
                        "ts": d.get("ts"), "session": sid8, "actor": actor,
                        "verb": _verb_for(tool), "target": tool_id, "tool": tool,
                    })
                    b.edge(actor, tool_id, "access", static=False)
            if has_session:
                b.ok("bus_events", "session-id extractable")
            else:
                # fail-open: Format liefert keine session-id -> Quelle stale, keine Events
                b.mark("bus_events", "stale",
                       f"no session-id in audit format (sampled {sampled} lines)")
        else:
            b.mark("bus_events", "stale", "audit.log missing")
    except Exception as e:
        log.warning("bus_events source error: %s", e)
        b.mark("bus_events", "error", str(e))

    # --- Quelle: pipelines/server (services.json) -----------------------------
    try:
        n = 0
        d = json.load(open(SERVICES_JSON, encoding="utf-8"))
        for svc in d.get("services", []):
            port = svc.get("port")
            name = svc.get("name") or "?"
            unit = svc.get("unit") or ""
            if port is None:
                continue
            alive = _port_alive(port)      # billiger localhost-Connect
            b.entity(f"server:{port}", "server", name, active=alive,
                     meta={"port": port, "alive": alive, "unit": unit})
            n += 1
        b.ok("services", f"{n} services")
    except Exception as e:
        log.warning("services source error: %s", e)
        b.mark("services", "error", str(e))

    # --- Quelle: brett --------------------------------------------------------
    try:
        d = json.load(open(BRETT_JSON, encoding="utf-8"))
        eintraege = d.get("eintraege", [])
        # offene Eintraege = status_init == "offen" (eindeutig erkennbar);
        # sonst Gesamtzahl als Fallback.
        open_count = sum(1 for e in eintraege if e.get("status_init") == "offen")
        if open_count == 0 and not any("status_init" in e for e in eintraege):
            open_count = len(eintraege)
        b.entity("brett:intro-remotion", "brett", f"brett ({open_count} offen)",
                 active=open_count > 0,
                 meta={"folge": d.get("folge"), "open_count": open_count,
                       "total": len(eintraege)})
        b.ok("brett", f"{open_count} open of {len(eintraege)}")
    except Exception as e:
        log.warning("brett source error: %s", e)
        b.mark("brett", "error", str(e))

    # --- Quelle: tokens + throughput (ECHT, aus Transcripts) ------------------
    tokens = {"by_session": {}, "by_model": {}, "rate_per_min": 0}
    total_tok_rate = total_byte_rate = 0.0
    for sid8, tx in tx_by_sid.items():
        tokens["by_session"][sid8] = tx["tokens"]
        total_tok_rate += tx.get("tok_per_min", 0)
        total_byte_rate += tx.get("bytes_per_min", 0)
        for m in tx.get("models", []):
            agg = tokens["by_model"].setdefault(m, {"input": 0, "output": 0})
            agg["input"] += tx["tokens"]["input"]
            agg["output"] += tx["tokens"]["output"]
    tokens["rate_per_min"] = round(total_tok_rate, 1)
    throughput = {"bytes_per_min": round(total_byte_rate, 1)}
    if tx_by_sid:
        b.ok("tokens", f"{len(tx_by_sid)} transcripts · {tokens['rate_per_min']} tok/min · "
                       f"{int(total_byte_rate)} B/min")
    else:
        b.mark("tokens", "stale", "keine aktiven Transcripts im Fenster")

    # --- Heat: Aktivitaet der letzten ~Runde aus Event-Haeufigkeit ------------
    heat = {}
    for ev in b.events:
        for k in (ev.get("actor"), ev.get("target")):
            if k:
                heat[k] = heat.get(k, 0) + 1
    # byteHeat: DATEN-I/O-Anteil (read/write/edit = echte Datei-/Memory-Byte-Bewegung),
    # getrennt von der Gesamt-Aktivitaet -> speist im Dashboard das cyan "Daten"-Band
    # neben dem amber "Token"-Band. EHRLICHKEIT: Proxy ueber Event-Haeufigkeit der
    # Daten-Verben, es gibt (noch) keinen echten Byte-Zaehler -> keine literalen MB/s.
    data_verbs = ("read", "write", "edit")
    byte_heat = {}
    for ev in b.events:
        if ev.get("verb") in data_verbs:
            for k in (ev.get("actor"), ev.get("target")):
                if k:
                    byte_heat[k] = byte_heat.get(k, 0) + 1
    for eid, ent in b.entities.items():
        h = min(1.0, heat.get(eid, 0) / 6.0)
        if ent["type"] == "session" and ent["active"]:
            h = max(h, 0.3)               # aktive Session glueht grundsaetzlich
        ent["heat"] = round(h, 3)
        ent["byteHeat"] = round(min(1.0, byte_heat.get(eid, 0) / 6.0), 3)

    # --- Stats ----------------------------------------------------------------
    ents = list(b.entities.values())
    stats = {
        "sessions_active": sum(1 for e in ents if e["type"] == "session" and e["active"]),
        "agents_running": sum(1 for e in ents if e["type"] in ("agent", "professor") and e["active"]),
        "pipelines_alive": sum(1 for e in ents if e["type"] in ("server", "pipeline") and e["meta"].get("alive")),
        "events_total": len(b.events),
    }

    state = {
        "generated": _now_iso(),
        "entities": ents,
        "edges": list(b.edges.values()),
        "tokens": tokens,
        "throughput": throughput,
        "stats": stats,
        "health": b.health,
        "events": b.events,     # transient: vom Daemon vor dem Schreiben entfernt
    }
    return state


# ----------------------------------------------------------------------------
# Event-Ring (append-only, Byte-Offset-tail wie memory-live)
# ----------------------------------------------------------------------------
def read_events(since_offset):
    """Tailt events.jsonl ab Byte-Offset. Gibt (events_list, new_offset) zurueck."""
    try:
        with open(EVENTS_FILE, "rb") as f:
            size = os.fstat(f.fileno()).st_size
            if since_offset > size:        # Ring rotiert/gekuerzt -> ab Ende weiter
                return [], size
            f.seek(max(0, since_offset))
            raw = f.read()
    except OSError:
        return [], 0
    cut = raw.rfind(b"\n")
    if cut < 0:                            # nur unvollstaendige Zeile
        return [], since_offset
    raw = raw[:cut + 1]
    out = []
    for ln in raw.split(b"\n"):
        if not ln.strip():
            continue
        try:
            out.append(json.loads(ln))
        except ValueError:
            pass
    return out, max(0, since_offset) + len(raw)


def _event_sig(ev):
    return f"{ev.get('ts')}|{ev.get('actor')}|{ev.get('target')}|{ev.get('tool')}|{ev.get('verb')}"


def _append_events(events, written_sigs):
    """Neue Events an events.jsonl anhaengen; gegen zuletzt geschriebene dedupen."""
    fresh = []
    for ev in events:
        sig = _event_sig(ev)
        if sig in written_sigs:
            continue
        written_sigs.append(sig)
        fresh.append(ev)
    if not fresh:
        return 0
    with open(EVENTS_FILE, "a", encoding="utf-8") as f:
        for ev in fresh:
            f.write(json.dumps(ev) + "\n")
    return len(fresh)


def _write_state_atomic(state):
    """state.json atomar schreiben (tmp + os.replace)."""
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f)
    os.replace(tmp, STATE_FILE)


def _tick(written_sigs):
    state = build_state()
    events = state.pop("events", [])          # transient raus -> state.json = /state-Schema
    _write_state_atomic(state)
    n = _append_events(events, written_sigs)
    return state, n


# ----------------------------------------------------------------------------
# main
# ----------------------------------------------------------------------------
def main():
    _setup_logging()
    mode = sys.argv[1] if len(sys.argv) > 1 else "--once"
    # Signaturen zuletzt geschriebener Events, damit der Ring nicht dupliziert
    written_sigs = deque(maxlen=DEDUP_WINDOW)
    # vorhandene Event-Signaturen laden, damit --daemon-Neustart nicht doppelt schreibt
    try:
        existing, _ = read_events(0)
        for ev in existing[-DEDUP_WINDOW:]:
            written_sigs.append(_event_sig(ev))
    except Exception:
        pass

    if mode == "--daemon":
        log.info("collector daemon start (interval=%.1fs)", INTERVAL)
        try:
            while True:
                try:
                    state, n = _tick(written_sigs)
                    log.info("tick: %d entities, %d edges, +%d events, %d active sessions",
                             len(state["entities"]), len(state["edges"]), n,
                             state["stats"]["sessions_active"])
                except Exception as e:                 # Tick-Fehler nie fatal
                    log.error("tick failed: %s", e)
                time.sleep(INTERVAL)
        except KeyboardInterrupt:
            log.info("collector daemon stop (keyboard interrupt)")
            return
    else:  # --once
        state, n = _tick(written_sigs)
        log.info("once: %d entities, %d edges, +%d events, %d active sessions",
                 len(state["entities"]), len(state["edges"]), n,
                 state["stats"]["sessions_active"])


if __name__ == "__main__":
    main()
