# AOS-1 Observatory — Datenvertrag (Spine)

> Single Source of Truth für Collector ↔ Server ↔ 3D-Web-App. Rein read-only erzeugt.
> Alle IDs sind stabil + typpräfixiert, damit Kanten/Events eindeutig auf Knoten zeigen.

## Entity (Graph-Knoten)

```jsonc
{
  "id": "session:10b7bea9",          // "<type>:<key>" — stabil, eindeutig
  "type": "session",                  // session|agent|professor|pipeline|tool|memory|brett|server|project
  "label": "organischer-partikel-schwarm",
  "active": true,                     // aktuell live (busy / kürzlich gefeuert)
  "heat": 0.8,                        // 0..1 Aktivität der letzten ~30s (treibt Glow)
  "meta": {}                          // typ-spezifisch, s.u.
}
```

**meta je type:**
| type | meta-Felder (Quelle) |
|---|---|
| `session` | `project` (=cwd), `status` (busy/idle), `model`, `pane`, `updatedAt` · aus `sessions/<pid>.json` |
| `agent` | `group` (security/video/business/…), `running` (bool) · aus `agents/*.md` + SubagentStart-Feed |
| `professor` | wie agent (Teilmenge, 3–4) |
| `pipeline` | `unit` (systemd), `alive` (bool), `layer` · aus `services.json` + `wiring/graph.json` + Live-Check |
| `tool` | `kind` (mcp/builtin), `server` · aus Tool-Event-Feed + `services.json` |
| `memory` | `memtype` (feedback/project/reference/user/profile/other), `tier` (core/deep/rules/infra), `deg` · aus `graph.json` (oft **geclustert**: `id=memcluster:<memtype>`) |
| `brett` | `folge`, `open_count` · aus `brett.json` |
| `server` | `port`, `alive` · aus `services.json` + `ss`/`systemctl` |

## Edge (Graph-Kante)

```jsonc
{ "source": "session:10b7bea9", "target": "memcluster:feedback", "kind": "access", "static": false }
```
`kind`: `access` (live Zugriff) · `control` · `data` · `memory` · `model` · `extern` (aus wiring) · `spawn` (session→agent) · `membership` (agent→pipeline). `static:true` = dauerhafte Topologie (immer sichtbar); `static:false` = flüchtig (feuert, verblasst).

## Event (Live-Feed, treibt die Partikel-Flows)

```jsonc
{
  "ts": "2026-10-24T00:40:12.345Z",
  "session": "10b7bea9",
  "actor": "session:10b7bea9",       // oder "agent:<name>" wenn einem Subagenten zuordenbar
  "verb": "read",                     // read|edit|write|bash|web|spawn|brett|access
  "target": "memcluster:feedback",    // Entity-id, auf die zugegriffen wird
  "tool": "Read",                     // Roh-Tool (optional)
  "tokens": 1200,                      // Token-Delta dieses Schritts, falls LLM-Arbeit (treibt Flow-Dichte)
  "bytes": 0,                          // Daten-Delta dieses Schritts, falls Nicht-LLM-Arbeit (alternativer Dichte-Treiber)
  "metric": "tokens"                   // "tokens" | "bytes" — welche Einheit die Dichte/Legende dieses Flows beschreibt
}
```
Der Server reicht Events ab einem Byte-Offset (`?since=`) wie `memory-live`. Jedes Event → ein Partikel-Burst
entlang der Kante `actor → target`; **Dichte ∝ Intensität**:
- LLM/Agent/Session-Actor → Intensität aus **Token-Rate** (`tokens`, `metric:"tokens"`).
- Nicht-LLM-Prozess (Pipeline/Server/Daten-Job, verbraucht keine Token) → Intensität aus **Datendurchsatz**
  (`bytes`, `metric:"bytes"`), z.B. Byte-/Zeilen-Wachstum seiner Log-/Ausgabedateien pro Tick.
- **Gleiche visuelle Sprache** für beide (Dichte = „viel los"); nur die HUD-/Legenden-Einheit unterscheidet sich.

## State-Snapshot (`/state`)

```jsonc
{
  "generated": "2026-10-24T00:40:12.345Z",
  "entities": [ /* Entity[] */ ],
  "edges": [ /* Edge[] static+jüngste flüchtige */ ],
  "tokens": {
    "by_session": { "10b7bea9": { "input": N, "output": N, "cache_read": N, "thinking": N, "model": "claude-opus-4-8" } },
    "by_model":   { "claude-opus-4-8": N },
    "rate_per_min": 0
  },
  "throughput": {                      // Nicht-LLM-Datendurchsatz (Byte-Delta je Quelle/Prozess pro Tick)
    "by_source": { "pipeline:ingest-queue": { "bytes_per_min": N } },
    "bytes_per_min": 0
  },
  "stats": { "sessions_active": N, "agents_running": N, "pipelines_alive": N, "events_total": N }
}
```

## Quellen-Mapping (read-only)
| Entität/Signal | Quelle | live |
|---|---|---|
| sessions + projekt + status | `<claude_home>/sessions/<pid>.json` | ja |
| tool/datei-zugriffe | `<tmux_log_fmt>` (`ts\|tool\|label`) ⋈ pane aus sessions | ja |
| memory-reads | `<memory_dir>/metrics/access_log.jsonl` | ja |
| tokens | transcript `usage` (`<projects_dir>/<cwd>/<sid>.jsonl`) → Token-Aggregator | near |
| bus-events | `<bus_audit>` (claude-bus audit log) | ja |
| brett | `<brett_json>` (append-only) | ja |
| pipelines/server | `<services_json>` + `ss`/`systemctl` | teils |
| agent-spawns | SubagentStart-Hook → `logs/.../subagents.jsonl` | optional |

> Alle Quell-Pfade stammen aus `collector/config.py` (Public-Default: `~/.claude` +
> localhost). Betreiber-spezifische Pfade/IP stehen NUR in der gitignorierten
> `aos.local.json`, nie im Repo. Default-Modus `demo` liest gar keine echten Quellen.

## Harte Regeln
- **Read-only** nach außen. Server GET-only, Bind aus config (Default `127.0.0.1`), nie 0.0.0.0, nie GitHub.
- Private Inhalte (Kartentexte, Prompt-Inhalte) NICHT exponieren — nur Metadaten (Dateiname/Typ/Zähler). OSS = synthetisch.
- Collector fail-open: eine fehlende/kaputte Quelle darf `/state` nicht crashen (try/except je Quelle).
