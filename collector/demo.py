#!/usr/bin/env python3
"""AOS-1 Observatory — DEMO-Produzent (synthetische Firma).

Schreibt EXAKT dasselbe Schema wie collector.py (state.json + events.jsonl nach
SCHEMA.md), liest aber NICHTS Echtes vom System. Das ist die oeffentlich sichere
Daten-Quelle: frisch ausgecheckt (mode=demo) zeigt die App diese lebendige,
erfundene Agenten-Firma, damit Nutzer sofort sehen, was moeglich ist — mehrere
Claude-Sessions, die Pipelines bedienen und Agenten/Professoren spawnen.

Modi (wie collector):
  python3 demo.py --once     einmal bauen + schreiben, exit
  python3 demo.py --daemon   Endlosschleife, alle INTERVAL s neu bauen (lebt)

Alle Namen, Ports und Zahlen sind FREI ERFUNDEN — bewusst OHNE Bezug zu realer
Infrastruktur, echten Agenten/Pipelines, Ports, Pfaden oder IDs. (Diese Datei
wird mitgeliefert, also darf hier NICHTS Betreiber-Spezifisches stehen.)
"""
import sys
import math
import time
import random
import logging
import datetime

import config
from collector import (_write_state_atomic, _append_events, read_events,
                       _event_sig, DEDUP_WINDOW)
from collections import deque, OrderedDict

log = logging.getLogger("aos.demo")

# ----------------------------------------------------------------------------
# Modell-IDs (damit die HUD-Modell-Erkennung greift). Schwer/mittel/leicht =
# verschiedene Modelle fuer verschiedene Lasten (generisches Muster, nur Optik).
# ----------------------------------------------------------------------------
MODELS = {
    "heavy":  "claude-opus-5-5",
    "mid":    "claude-sonnet-5-5",
    "light":  "claude-haiku-5-5",
}
# grobe Token-Rate je Modell-Klasse (tok/min bei voller Auslastung) — nur Optik
MODEL_RATE = {"heavy": 3600, "mid": 2300, "light": 950}

# ----------------------------------------------------------------------------
# Die erfundene Firma (reine Daten). Jede Session: key, Label, Modell, Gruppe,
# bediente Pipelines, gespawnte Agenten (Typ professor via "prof:"-Praefix).
# ----------------------------------------------------------------------------
SESSIONS = [
    ("alpha",   "data-ingest",   "heavy", "data",     ["ingest-queue"], ["crawler", "parser", "dedup-checker"]),
    ("bravo",   "media-encode",  "mid",   "media",    ["render-farm"],  ["encoder", "thumb-maker"]),
    ("charlie", "doc-review",    "mid",   "docs",     [],               ["reviewer"]),
    ("delta",   "release-run",   "mid",   "ops",      ["watchdog"],     ["packager"]),
    ("echo",    "research-run",  "heavy", "research", ["feed-sync"],    ["searcher", "prof:analyst"]),
    ("foxtrot", "index-refresh", "light", "ops",      [],               ["indexer"]),
]

# Pipelines (systemd-artig): key, Label, Layer, speist welchen Server-Port.
PIPELINES = [
    ("ingest-queue", "ingest-queue", "data",  7002),
    ("render-farm",  "render-farm",  "media", 7002),
    ("watchdog",     "watchdog",     "ops",   7001),
    ("feed-sync",    "feed-sync",    "intel", 7003),
]

# Server (Dienste), alle "alive". Port, Label. Fiktiver Port-Bereich 7001-7003.
SERVERS = [(7001, "gateway"), (7002, "render-node"), (7003, "metrics")]

# Memory-Cluster (nur Metadaten/Zaehler — wie im Live-Schema). Generische Labels.
MEM_CLUSTERS = [("notes", 180), ("specs", 64), ("refs", 110), ("people", 20)]

# Werkzeuge, die Agenten/Sessions benutzen. (Name, kind, Verb).
TOOLS = [
    ("Read", "builtin", "read"), ("Edit", "builtin", "edit"),
    ("Bash", "builtin", "bash"), ("Write", "builtin", "write"),
    ("Grep", "builtin", "read"), ("WebSearch", "builtin", "web"),
    ("mcp__github", "mcp", "access"), ("mcp__chrome-devtools", "mcp", "access"),
]

BRETT_ID = "brett:studio"

# Welche Werkzeuge welche Gruppe bevorzugt (etwas Charakter pro Session).
GROUP_TOOLS = {
    "data":     ["Bash", "Grep", "WebSearch", "mcp__github", "Read"],
    "media":    ["Bash", "Write", "Read", "Edit"],
    "docs":     ["Read", "Edit", "Grep", "Bash"],
    "ops":      ["Bash", "Read", "Write", "mcp__github"],
    "research": ["WebSearch", "Read", "mcp__chrome-devtools", "Grep"],
}


def _phase(key):
    """Stabile Pseudo-Phase je Entitaet (deterministisch aus dem Namen)."""
    return (sum(ord(c) for c in key) % 100) / 100.0 * 2 * math.pi


def _now_dt():
    return datetime.datetime.now(datetime.timezone.utc)


def _iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _busy(key, t, duty=0.35, speed=0.05):
    """Ist diese Session/Agent gerade 'busy'? Langsame Sinus-Welle je Entitaet
    -> Sessions gehen organisch an/aus, es ist immer etwas los, aber nie alles."""
    return math.sin(t * speed + _phase(key)) > duty


# ----------------------------------------------------------------------------
# DRAMATURGIE: die Firma durchlaeuft WELLEN. Ein Zyklus (~108 s) wandert durch
# benannte Phasen; jede hebt eine Gruppe hervor (Fokus) und verschiebt die
# Dominanz Token<->Daten (token_bias: 1=LLM-lastig, 0=datenlastig). So "passiert
# etwas" sichtbar in Wellen statt gleichfoermig — inkl. Stoerfall mit Erholung.
# (name, dauer_s, fokus-gruppe, token_bias)
# ----------------------------------------------------------------------------
PHASES = [
    ("ingest",   22, "data",     0.30),   # Daten stroemen rein (byte-lastig)
    ("render",   20, "media",    0.22),   # Render-Schub (stark byte-lastig)
    ("research", 24, "research", 0.88),   # Deep-Dive: token-lastig + Agenten-Schwarm
    ("review",   16, "docs",     0.62),
    ("incident", 14, "ops",      0.50),   # ein Dienst faellt aus -> Infra amber, Ops spiked
    ("quiet",    12, None,       0.50),   # Ruhephase
]
CYCLE = sum(p[1] for p in PHASES)


def phase_at(t):
    """(name, fokus_group, token_bias, intensity 0..1) fuer Zeitpunkt t."""
    tm = t % CYCLE
    acc = 0
    for name, dur, focus, tbias in PHASES:
        if tm < acc + dur:
            ramp = math.sin((tm - acc) / dur * math.pi)   # 0->1->0 weiche Rampe
            intensity = 0.35 + 0.65 * ramp
            if name == "quiet":
                intensity *= 0.45
            return name, focus, tbias, intensity
        acc += dur
    return "quiet", None, 0.5, 0.3


class _World:
    """Baut einen State-Snapshot + die Events dieses Ticks (wie _Builder)."""

    def __init__(self):
        self.ents = OrderedDict()
        self.edges = OrderedDict()
        self.events = []

    def ent(self, eid, etype, label, active=False, meta=None):
        if eid not in self.ents:
            self.ents[eid] = {"id": eid, "type": etype, "label": label,
                              "active": bool(active), "heat": 0.0, "meta": meta or {}}
        else:
            self.ents[eid]["active"] = self.ents[eid]["active"] or bool(active)
            if meta:
                self.ents[eid]["meta"].update(meta)
        return eid

    def edge(self, src, tgt, kind="access", static=False):
        key = (src, tgt, kind, static)
        if key not in self.edges:
            self.edges[key] = {"source": src, "target": tgt, "kind": kind, "static": static}

    def event(self, ev):
        self.events.append(ev)


def build_demo_state(t):
    """Erzeugt EIN /state-dict + transiente events[] fuer den Zeitpunkt t (Sekunden)."""
    w = _World()
    now = _now_dt()
    rng = random.Random(int(t * 7))     # leicht variabel, aber tick-stabil
    pname, focus, tbias, pint = phase_at(t)   # aktuelle Dramaturgie-Welle
    ev_i = 0

    def mk_event(actor, target, tool, verb, tokens=0, byts=0):
        nonlocal ev_i
        ev_i += 1
        ts = _iso(now + datetime.timedelta(milliseconds=ev_i))   # eindeutige ts je Event
        metric = "bytes" if byts and not tokens else "tokens"
        w.event({"ts": ts, "session": actor.split(":")[-1][:8], "actor": actor,
                 "verb": verb, "target": target, "tool": tool,
                 "tokens": tokens, "bytes": byts, "metric": metric})

    # --- feste Topologie: Memory-Cluster, Server, Pipelines, Brett ----------
    for mt, n in MEM_CLUSTERS:
        w.ent(f"memcluster:{mt}", "memory", f"{mt} ({n} Karten)",
              meta={"memtype": mt, "count": n})
    # Stoerfall: in der incident-Phase faellt der metrics-Dienst (7003) aus -> Infra amber
    down_port = 7003 if (pname == "incident" and pint > 0.5) else None
    for port, label in SERVERS:
        alive = port != down_port
        w.ent(f"server:{port}", "server", label, active=alive,
              meta={"port": port, "alive": alive, "unit": f"{label}.service"})
    for pkey, plabel, layer, feeds in PIPELINES:
        alive = True
        w.ent(f"pipeline:{pkey}", "pipeline", plabel, active=alive,
              meta={"unit": f"{pkey}.service", "alive": alive, "layer": layer})
        w.edge(f"pipeline:{pkey}", f"server:{feeds}", "data", static=True)
    open_count = 2 + int(2 + 2 * math.sin(t * 0.03))
    w.ent(BRETT_ID, "brett", f"brett ({open_count} offen)", active=open_count > 0,
          meta={"folge": "studio", "open_count": open_count, "total": 9})

    tokens = {"by_session": {}, "by_model": {}, "rate_per_min": 0}
    total_tok_rate = total_byte_rate = 0.0

    # Ein Tool-Zugriff als Event; Token- vs Daten-Dominanz folgt der Phase (tbias).
    def work_event(actor, pref_tools):
        tool = rng.choice(pref_tools)
        verb = next((v for (n, k, v) in TOOLS if n == tool), "access")
        toolid = f"tool:{tool}"
        w.ent(toolid, "tool", tool, active=True,
              meta={"kind": "mcp" if tool.startswith("mcp__") else "builtin"})
        w.edge(actor, toolid, "access", static=False)
        if rng.random() < tbias:
            mk_event(actor, toolid, tool, verb, tokens=rng.randint(400, 2200))
        else:
            mk_event(actor, toolid, tool, verb, byts=rng.randint(400, 3200))

    # --- Sessions + ihre Agenten/Pipelines + Live-Arbeit --------------------
    for skey, slabel, mkind, group, drives, agents in SESSIONS:
        sid8 = skey
        in_focus = (group == focus)
        # Ruhephase: hoehere Schwelle -> nur wenige Sessions aktiv (echter Breather)
        duty = 0.45 if pname == "quiet" else -0.15
        sess_busy = _busy(skey, t, duty=duty)
        if in_focus and pint > 0.45:
            sess_busy = True                      # Fokus-Gruppe der Phase ist sicher aktiv
        model = MODELS[mkind]
        sess_id = f"session:{sid8}"
        w.ent(sess_id, "session", slabel, active=sess_busy,
              meta={"project": f"~/work/{skey}", "status": "busy" if sess_busy else "idle",
                    "model": model, "models": [model], "pane": None,
                    "updatedAt": int(time.time() * 1000)})

        # bediente Pipelines (Kontroll-Kante, statisch) + gelegentliche Jobs
        for pkey in drives:
            w.edge(sess_id, f"pipeline:{pkey}", "control", static=True)
            if sess_busy and rng.random() < 0.5:
                mk_event(sess_id, f"pipeline:{pkey}", "Bash", "bash", byts=rng.randint(400, 2200))

        # Agenten-Roster: in intensiven Fokus-Phasen ephemere Zusatz-Agenten
        # (sichtbarer Schwarm/Churn in der Spitze, verschwinden danach wieder).
        pref_tools = GROUP_TOOLS.get(group, ["Read", "Bash"])
        roster = list(agents)
        if in_focus and pint > 0.6:
            roster += [f"worker-{i}" for i in range(1, 1 + int(2 * pint))]
        for araw in roster:
            is_prof = araw.startswith("prof:")
            aname = araw.split(":", 1)[1] if is_prof else araw
            aid = f"{'professor' if is_prof else 'agent'}:{aname}"
            a_busy = sess_busy and (in_focus or _busy(skey + aname, t, duty=0.1))
            w.ent(aid, "professor" if is_prof else "agent", aname, active=a_busy,
                  meta={"group": group, "running": a_busy})
            w.edge(sess_id, aid, "spawn", static=True)
            for pkey in drives:
                w.edge(aid, f"pipeline:{pkey}", "membership", static=True)
            if a_busy:
                for _ in range(rng.randint(1, 2 + int(2 * pint))):
                    work_event(aid, pref_tools)

        # Session-eigene Arbeit (Menge skaliert mit der Phasen-Intensitaet)
        if sess_busy:
            for _ in range(rng.randint(1, 2 + int(2 * pint))):
                work_event(sess_id, pref_tools)
            if rng.random() < 0.55:
                mt = rng.choice([m for m, _ in MEM_CLUSTERS])
                tgt = f"memcluster:{mt}"
                w.edge(sess_id, tgt, "memory", static=False)
                mk_event(sess_id, tgt, "Read", "read", byts=rng.randint(200, 1500))

        # Token-/Durchsatz-Raten je Session (modell- UND phasenabhaengig):
        # Fokus-Gruppe + token-lastige Phase -> hohe tok/min; datenlastige Phase -> hohe B/min.
        if sess_busy:
            boost = 1.0 + (0.8 * pint if in_focus else 0.0)
            act = (0.4 + 0.6 * pint) * boost
            tpm = round(MODEL_RATE[mkind] * act, 1)
            bpm = round(tpm * (0.9 - 0.6 * tbias) * rng.uniform(0.8, 1.2), 1)
            total_tok_rate += tpm * (0.4 + tbias)
            total_byte_rate += bpm
            tok = {"input": int(tpm * 4), "output": int(tpm * 1.2),
                   "cache_read": int(tpm * 9), "cache_creation": int(tpm * 0.6)}
            tokens["by_session"][sid8] = tok
            agg = tokens["by_model"].setdefault(model, {"input": 0, "output": 0})
            agg["input"] += tok["input"]
            agg["output"] += tok["output"]

    tokens["rate_per_min"] = round(total_tok_rate, 1)
    throughput = {"bytes_per_min": round(total_byte_rate, 1)}

    # --- Heat aus Event-Haeufigkeit dieses Ticks (wie collector) -------------
    heat, byte_heat = {}, {}
    for ev in w.events:
        for k in (ev.get("actor"), ev.get("target")):
            if k:
                heat[k] = heat.get(k, 0) + 1
        if ev.get("verb") in ("read", "write", "edit"):
            for k in (ev.get("actor"), ev.get("target")):
                if k:
                    byte_heat[k] = byte_heat.get(k, 0) + 1
    for eid, ent in w.ents.items():
        h = min(1.0, heat.get(eid, 0) / 5.0)
        if ent["type"] == "session" and ent["active"]:
            h = max(h, 0.35)
        if ent["type"] in ("pipeline", "server") and ent["active"]:
            h = max(h, 0.2 + 0.15 * (0.5 + 0.5 * math.sin(t * 0.1 + _phase(eid))))
        ent["heat"] = round(h, 3)
        ent["byteHeat"] = round(min(1.0, byte_heat.get(eid, 0) / 5.0), 3)

    ents = list(w.ents.values())
    stats = {
        "sessions_active": sum(1 for e in ents if e["type"] == "session" and e["active"]),
        "agents_running": sum(1 for e in ents if e["type"] in ("agent", "professor") and e["active"]),
        "pipelines_alive": sum(1 for e in ents if e["type"] in ("server", "pipeline") and e["meta"].get("alive")),
        "events_total": len(w.events),
    }
    # health: alle Demo-Quellen "ok" (synthetisch) -> HUD zeigt saubere Quellen-Zahl
    health = {src: {"status": "ok", "last_success_ts": _iso(now), "note": "synthetic demo"}
              for src in ("sessions", "memory_entities", "tool_activity",
                          "memory_reads", "services", "brett", "tokens")}
    if down_port:   # Stoerfall spiegelt sich auch in der Quellen-Ampel
        health["services"] = {"status": "stale", "last_success_ts": None,
                              "note": "1 service down (demo incident)"}

    return {"generated": _iso(now), "entities": ents, "edges": list(w.edges.values()),
            "tokens": tokens, "throughput": throughput, "stats": stats,
            "health": health, "events": w.events}


def _tick(written_sigs, t0):
    state = build_demo_state(time.time() - t0)
    events = state.pop("events", [])
    _write_state_atomic(state)
    n = _append_events(events, written_sigs)
    return state, n


def main():
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s [%(name)s] %(message)s")
    mode = sys.argv[1] if len(sys.argv) > 1 else "--once"
    written_sigs = deque(maxlen=DEDUP_WINDOW)
    try:
        existing, _ = read_events(0)
        for ev in existing[-DEDUP_WINDOW:]:
            written_sigs.append(_event_sig(ev))
    except Exception:
        pass
    t0 = time.time()
    if mode == "--daemon":
        log.info("demo daemon start (interval=%.1fs) -> %s", config.INTERVAL, config.STATE_FILE)
        try:
            while True:
                try:
                    state, n = _tick(written_sigs, t0)
                    log.info("tick: %d entities, %d edges, +%d events, %d active sessions, %d agents",
                             len(state["entities"]), len(state["edges"]), n,
                             state["stats"]["sessions_active"], state["stats"]["agents_running"])
                except Exception as e:
                    log.error("tick failed: %s", e)
                time.sleep(config.INTERVAL)
        except KeyboardInterrupt:
            log.info("demo daemon stop")
    else:
        state, n = _tick(written_sigs, t0)
        log.info("once: %d entities, %d edges, +%d events, %d active sessions",
                 len(state["entities"]), len(state["edges"]), n,
                 state["stats"]["sessions_active"])


if __name__ == "__main__":
    main()
