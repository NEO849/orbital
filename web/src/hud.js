// AOS-1 Observatory — src/hud.js
// Verantwortung: die festen 2D-Panels (reines DOM/CSS, Farben NUR aus palette.js).
// Der 3D-Kern bleibt frei: nichts schwebt ueber der Szene. Aufbau in 3 Schichten:
//   1) derive*  — reine Funktionen (state -> Anzeige-Modell), kein DOM
//   2) render*  — DOM aus dem Modell
//   3) createHud — verdrahtet Slots, exponiert update/pushEvents/setHealth/showDetail
//
// Panels:
//  TOP    — AOS-1 + KPIs (Sessions aktiv/gesamt, Agenten laufen/gesamt,
//           Durchsatz = EINZIGER Live-Wert Token/min + Byte/min, Datenquellen ✓N/N) + Uptime
//  LINKS  — Session-Liste (laufend zuerst, vertikal scrollbar)
//  RECHTS — Legende (Knoten-Zustand + Ströme, keine Zahlen), letzte 5 Aktivitäten, aktivste Knoten
//  UNTEN  — Infrastruktur eingeklappt: "Dienste n/N ok", nur fehlerhafte Dienste farbig
//
// Detail-API: hud.showDetail(entity|null) -> feuert CustomEvent 'aos:detail' auf
// document; das Detail-Panel (carousel.js) lauscht darauf. Keine Emojis.

import { PALETTE } from '../palette.js';
import { projectName, humanLabel, sessionName } from './entity.js';
import { visibility } from './nav/visibility.js';
import { log } from './log.js';

const l = log.mod('hud');
const B = PALETTE.base;

// Zustandsfarben (nur Palette): laeuft=amber (Token-Strom), idle=dim,
// stalled=sand, Fehler=koralle, ok=gruen.
const C = {
  running: PALETTE.flow.tokens,
  idle: B.dim,
  stalled: PALETTE.node.brett,
  ok: PALETTE.node.agent,
  warn: PALETTE.node.brett,
  bad: PALETTE.node.session,
  data: PALETTE.flow.bytes,
};
const STALL_MS = 10 * 60 * 1000;   // busy, aber seit >10 min kein Update -> stalled

// Einheitliche Zustands-Wörter (Legende UND Session-Liste nutzen DIESELBEN) —
// roher Status (running/idle/stalled) wird NIE direkt angezeigt.
const STATE_LABEL = { running: 'läuft', idle: 'idle', stalled: 'hängt' };

// Menschliches Typ-Wort je Knoten-Typ — macht Event-Zeilen ohne Vorwissen lesbar.
const TYPE_WORD = {
  session: 'Session', agent: 'Agent', professor: 'Professor', tool: 'Tool',
  pipeline: 'Pipeline', server: 'Server', memory: 'Gedächtnis', brett: 'Brett',
};

// Event-Verben -> einfaches Deutsch (für die Aktivitäts-Zeilen).
const VERB_DE = {
  read: 'liest', write: 'schreibt', edit: 'ändert', bash: 'führt aus',
  web: 'sucht', spawn: 'startet', access: 'nutzt',
};

// ───────────────────────── 1) derive* (rein, ohne DOM) ─────────────────────────

export function sessionState(e, now = Date.now()) {
  const busy = e.active || (e.meta && e.meta.status === 'busy');
  const upd = e.meta && e.meta.updatedAt;
  if (busy && upd && now - upd > STALL_MS) return 'stalled';
  return busy ? 'running' : 'idle';
}

export function fmtAgo(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '--';
  const s = Math.floor(ms / 1000);
  if (s < 10) return 'jetzt';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

export function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'G';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

// projectName lebt jetzt in entity.js (gemeinsam mit nodes.js → Liste↔3D gleicher Name).

// Agenten je Session ueber spawn-Kanten (session -> agent/professor).
function agentsBySession(edges, byId) {
  const out = {};
  for (const ed of edges || []) {
    if (ed.kind !== 'spawn') continue;
    const t = byId[ed.target];
    if (!t || (t.type !== 'agent' && t.type !== 'professor')) continue;
    const o = out[ed.source] || (out[ed.source] = { total: 0, running: 0 });
    o.total += 1;
    if (t.active || (t.meta && t.meta.running)) o.running += 1;
  }
  return out;
}

// Generischer Zustand einer Entität (Agent/Pipeline/Tool) — wie sessionState, erkennt aber
// AUCH meta.running (Agenten-Signal). Für die Kind-Zeilen der Session-Hierarchie.
function entState(e, now = Date.now()) {
  const busy = e.active || (e.meta && (e.meta.status === 'busy' || e.meta.running));
  const upd = e.meta && e.meta.updatedAt;
  if (busy && upd && now - upd > STALL_MS) return 'stalled';
  return busy ? 'running' : 'idle';
}

// Kind-Entitäten je Session: die Agenten/Professoren/Pipelines/Tools, mit denen die Session
// per Kante verbunden ist (= „was nutzt diese Session"). Richtungs-/Kind-unabhängig, dedupliziert.
function childrenBySession(edges, byId, now = Date.now()) {
  const KIND = new Set(['agent', 'professor', 'pipeline', 'tool']);
  const rank = { running: 0, stalled: 1, idle: 2 };
  const out = {};
  const seen = new Set();
  for (const ed of edges || []) {
    if (!ed || !ed.source || !ed.target) continue;
    const t = byId[ed.target];
    if (!t || !KIND.has(t.type)) continue;
    const key = ed.source + '>' + ed.target;
    if (seen.has(key)) continue;
    seen.add(key);
    (out[ed.source] || (out[ed.source] = [])).push({ entity: t, state: entState(t, now) });
  }
  for (const k of Object.keys(out)) {
    out[k].sort((a, b) => (rank[a.state] - rank[b.state]) || ((b.entity.heat || 0) - (a.entity.heat || 0)));
  }
  return out;
}

export function deriveSessions(state, now = Date.now()) {
  const ents = (state && state.entities) || [];
  const byId = {};
  for (const e of ents) byId[e.id] = e;
  const ag = agentsBySession(state && state.edges, byId);
  const kids = childrenBySession(state && state.edges, byId, now);
  const rank = { running: 0, stalled: 1, idle: 2 };
  return ents.filter((e) => e.type === 'session').map((e) => {
    const st = sessionState(e, now);
    const a = ag[e.id] || { total: 0, running: 0 };
    const upd = e.meta && e.meta.updatedAt;
    return { entity: e, state: st, project: sessionName(e), agents: a, children: kids[e.id] || [], heat: e.heat || 0, ago: upd ? now - upd : null, upd: upd || 0 };
  }).sort((x, y) => (rank[x.state] - rank[y.state]) || (y.heat - x.heat) || (y.upd - x.upd));
}

// Health -> 'ok' | 'warn' | 'bad' + Text. Quelle: state.health (je Quelle status)
// plus Transport (reconnecting = bad).
export function deriveHealth(stateHealth, transport) {
  const vals = Object.values(stateHealth || {});
  const stale = vals.filter((v) => v && v.status && v.status !== 'ok');
  const dead = stale.filter((v) => /err|down|fail|dead/i.test(v.status));
  const ok = vals.length - stale.length;
  const total = vals.length;
  if (transport === 'reconnecting') return { level: 'bad', text: 'Verbindung', sub: 'reconnecting', ok, total };
  if (dead.length) return { level: 'bad', text: `${dead.length} Fehler`, sub: `${ok}/${total} Quellen ok`, ok, total };
  if (stale.length) return { level: 'warn', text: `${stale.length} veraltet`, sub: `${ok}/${total} Quellen ok`, ok, total };
  return { level: 'ok', text: 'ok', sub: total ? `${total}/${total} Quellen ok` : 'keine Quellen', ok, total };
}

export function deriveInfra(state) {
  const ents = ((state && state.entities) || []).filter((e) => e.type === 'pipeline' || e.type === 'server');
  const isOk = (e) => !!(e.meta && e.meta.alive) || !!e.active;
  const items = ents.map((e) => ({ e, ok: isOk(e) }))
    .sort((a, b) => (a.e.label || '').localeCompare(b.e.label || ''));
  return { items, total: items.length, okCount: items.filter((i) => i.ok).length };
}

export function deriveHot(state, n = 3) {
  return ((state && state.entities) || []).filter((e) => (e.heat || 0) > 0.01)
    .sort((a, b) => (b.heat || 0) - (a.heat || 0)).slice(0, n);
}

// Durchsatz: bevorzugt Token/min, sonst Daten (Bytes/min).
export function deriveThroughput(state) {
  const tok = state && state.tokens && Number(state.tokens.rate_per_min) || 0;
  const byt = state && state.throughput && Number(state.throughput.bytes_per_min) || 0;
  return { tok, byt };
}

// ───────────────────────── 2) Styles + DOM-Helfer ─────────────────────────

function injectStyle() {
  if (document.getElementById('aos-hud-style')) return;
  const s = document.createElement('style');
  s.id = 'aos-hud-style';
  s.textContent = `
  :root{
    --aos-bg:${B.bg}; --aos-panel:${B.panel}; --aos-raised:${B.raised};
    --aos-line:${B.line}; --aos-text:${B.text}; --aos-muted:${B.muted}; --aos-dim:${B.dim};
  }
  .aos-panel{ background:var(--aos-panel); border:1px solid var(--aos-line);
    color:var(--aos-text); font:13px/1.45 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;
    padding:10px 12px; box-sizing:border-box; overflow:hidden; }
  .aos-kicker{ font:600 11px ui-monospace,Menlo,Consolas,monospace; letter-spacing:.14em;
    text-transform:uppercase; color:var(--aos-muted); }
  .aos-title{ font-weight:800; font-size:18px; letter-spacing:.02em; }
  .aos-brand-sub{ font:600 10px ui-monospace,Menlo,Consolas,monospace; color:var(--aos-dim);
    letter-spacing:.07em; margin-top:3px; white-space:nowrap; }
  .aos-mono{ font-family:ui-monospace,Menlo,Consolas,monospace; }
  .aos-sec{ display:flex; gap:7px; align-items:baseline; }
  .aos-spacer{ flex:1 1 auto; }
  .aos-dot{ width:8px; height:8px; flex:0 0 8px; border-radius:1px; }

  /* TOP */
  .aos-top{ display:flex; align-items:center; gap:13px; padding:9px 16px; }
  .aos-div{ width:1px; align-self:stretch; background:var(--aos-line); margin:4px 0; }
  /* W3d — Enterprise-KPI-Karten: raised Box, dünner farbiger Links-Akzent, Label oben,
     große tabellarische Ziffer, ruhige Kontext-Zeile. EINE Sprache mit Legende/Rail (W3b/c). */
  .aos-kpi{ display:flex; flex-direction:column; justify-content:center; gap:4px; min-width:0;
    padding:7px 14px; background:var(--aos-raised); border-left:2px solid var(--aos-line); }
  .aos-kpi .lab{ font:600 9px ui-monospace,Menlo,Consolas,monospace; text-transform:uppercase;
    letter-spacing:.13em; color:var(--aos-muted); display:flex; align-items:center; gap:6px; }
  .aos-kpi .lab i{ width:7px; height:7px; flex:0 0 7px; font-style:normal; }
  .aos-kpi .fig{ font:600 23px ui-monospace,Menlo,Consolas,monospace; color:var(--aos-text);
    letter-spacing:-.01em; font-variant-numeric:tabular-nums; line-height:1; white-space:nowrap; }
  .aos-kpi .fig small{ font-size:12px; color:var(--aos-dim); font-weight:500; margin-left:3px; letter-spacing:0; }
  .aos-ampel{ display:flex; align-items:center; gap:10px; padding:4px 12px; border:1px solid var(--aos-line);
    border-left-width:3px; background:var(--aos-raised); }
  .aos-ampel .lamp{ width:14px; height:14px; border-radius:1px; flex:0 0 14px; }
  .aos-ampel .tx{ display:flex; flex-direction:column; line-height:1.1; }
  .aos-ampel .tx b{ font:700 16px ui-monospace,Menlo,Consolas,monospace; }
  .aos-ampel .tx span{ font:10px ui-monospace,Menlo,Consolas,monospace; color:var(--aos-muted); margin-top:2px; }
  .aos-up{ text-align:right; }
  .aos-up b{ font:600 14px ui-monospace,Menlo,Consolas,monospace; color:var(--aos-muted); }
  .aos-up span{ display:block; font:10px ui-monospace,Menlo,Consolas,monospace; color:var(--aos-dim);
    text-transform:uppercase; letter-spacing:.1em; }

  /* LINKS: Session-Liste (scrollbar) */
  .aos-scroll{ overflow-y:auto; min-height:0; scrollbar-width:thin; scrollbar-color:var(--aos-dim) transparent; }
  .aos-scroll::-webkit-scrollbar{ width:6px; }
  .aos-scroll::-webkit-scrollbar-track{ background:transparent; }
  .aos-scroll::-webkit-scrollbar-thumb{ background:var(--aos-dim); border-radius:0; }
  .aos-list{ list-style:none; margin:8px 0 0; padding:0 4px 0 0; display:flex; flex-direction:column; gap:4px; flex:1 1 auto; }
  .aos-srow{ display:grid; grid-template-columns:1fr auto; gap:0 8px; padding:5px 8px;
    border-left:3px solid var(--aos-dim); background:var(--aos-raised); cursor:pointer; }
  .aos-srow:hover{ background:var(--aos-line); }
  .aos-srow.sel{ outline:1px solid var(--aos-muted); outline-offset:-1px; }
  .aos-srow .pj{ font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .aos-srow .ago{ font:11px ui-monospace,Menlo,Consolas,monospace; color:var(--aos-muted); text-align:right; }
  .aos-srow .sub{ grid-column:1 / 3; display:flex; gap:10px; font:10px ui-monospace,Menlo,Consolas,monospace;
    color:var(--aos-muted); text-transform:uppercase; letter-spacing:.06em; align-items:center; }
  /* Heat-Balken direkt in der Zeile = die „wie aktiv"-Rangordnung (ersetzt die separate
     rechte „Aktivste Knoten"-Liste → nur noch EINE Rangliste, kein Hin-und-her-Schauen). */
  .aos-srow .hb{ grid-column:1 / 3; height:3px; background:var(--aos-bg); margin-top:5px; overflow:hidden; }
  .aos-srow .hb i{ display:block; height:100%; width:0; background:var(--aos-dim); transition:width .45s ease, background .45s ease; }
  .aos-srow .vis{ margin-left:auto; background:transparent; color:var(--aos-muted); border:1px solid var(--aos-line);
    font:10px ui-monospace,Menlo,Consolas,monospace; padding:0 6px; cursor:pointer; }
  .aos-srow .vis:hover{ color:var(--aos-text); border-color:var(--aos-muted); }
  .aos-srow.hid{ opacity:.45; }                       /* in 3D ausgeblendet */
  .aos-srow.idle{ opacity:.58; }                      /* idle ruhigstellen (kein Aufmerksamkeits-Rauschen) */
  .aos-srow.idle .hb{ display:none; }                 /* idle: kein Balken */
  /* W3c — zwei gestapelte Live-Bars je Session (Token amber + Daten cyan) + Agenten-Hierarchie. */
  .aos-mbar{ grid-column:1 / 3; display:grid; grid-template-columns:1fr auto; gap:0 8px; align-items:center; margin-top:4px; }
  .aos-mbar .trk{ height:4px; background:var(--aos-bg); overflow:hidden; }
  .aos-mbar .trk i{ display:block; height:100%; width:0; transition:width .4s ease; }
  .aos-mbar .val{ font:10px ui-monospace,Menlo,Consolas,monospace; color:var(--aos-muted);
    font-variant-numeric:tabular-nums; white-space:nowrap; }
  .aos-mbar .val.z{ color:var(--aos-dim); }
  /* Fleet-Streifen: ein eckiger Chip je Agent/Pipeline (immer sichtbar), Zustandsfarbe. */
  .aos-fleet{ grid-column:1 / 3; display:flex; flex-wrap:wrap; gap:3px; margin-top:7px; }
  .aos-fleet:empty{ display:none; }
  .aos-fleet .chip{ width:9px; height:9px; box-sizing:border-box; border:1px solid var(--aos-line); }
  .aos-fleet .more{ font:9px ui-monospace,Menlo,Consolas,monospace; color:var(--aos-dim); align-self:center; margin-left:2px; }
  /* Kind-Zeilen (Agenten/Pipelines der Session) — NUR bei ausgewählter Session aufgeklappt. */
  .aos-kids{ grid-column:1 / 3; display:none; flex-direction:column; gap:3px; margin-top:7px; }
  .aos-srow.sel .aos-kids{ display:flex; }
  .aos-kid{ padding:4px 7px 5px 9px; background:var(--aos-bg); border-left:2px solid var(--aos-dim); }
  .aos-kid .khead{ display:flex; align-items:center; gap:7px; }
  .aos-kid .kdot{ width:7px; height:7px; flex:0 0 7px; }
  .aos-kid .knm{ font:11px ui-monospace,Menlo,Consolas,monospace; color:var(--aos-text);
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
  .aos-kid .ktype{ font:9px ui-monospace,Menlo,Consolas,monospace; color:var(--aos-dim);
    text-transform:uppercase; letter-spacing:.06em; margin-left:auto; flex:0 0 auto; }
  .aos-kid .aos-mbar{ margin-top:3px; }
  .aos-kid .aos-mbar .trk{ height:3px; }
  .aos-empty{ color:var(--aos-dim); font:11px ui-monospace,Menlo,Consolas,monospace; padding:6px 2px; }

  /* Live-Raten (Token/min amber, Byte/min cyan) je Session/Agent — Toggle 'aos-rates'. */
  .aos-rate{ margin-left:auto; display:inline-flex; gap:9px; font:10px ui-monospace,Menlo,Consolas,monospace;
    letter-spacing:.04em; text-transform:none; white-space:nowrap; font-variant-numeric:tabular-nums; }
  .aos-rate b{ font-weight:700; }
  .aos-rate .z{ color:var(--aos-dim); }   /* Null-Last ruhig stellen (kein Aufmerksamkeits-Rauschen) */
  .aos-hot .aos-rate{ margin-left:8px; }
  body:not(.aos-rates) .aos-rate{ display:none; }

  /* Erklär-Schicht: eine ruhige Subline je Sektion + optionaler "?"-Hinweis-Chip. */
  .aos-subline{ font:11px ui-monospace,Menlo,Consolas,monospace; color:var(--aos-dim);
    margin:3px 0 2px; letter-spacing:.02em; }
  .aos-hint{ display:inline-flex; align-items:center; justify-content:center; width:14px; height:14px;
    border:1px solid var(--aos-line); border-radius:50%; font:600 9px ui-monospace,Menlo,Consolas,monospace;
    color:var(--aos-muted); cursor:help; flex:0 0 14px; margin-left:5px; }
  .aos-hint:hover, .aos-hint:focus{ border-color:var(--aos-muted); color:var(--aos-text); outline:none; }

  /* RECHTS */
  .aos-block + .aos-block{ margin-top:12px; border-top:1px solid var(--aos-line); padding-top:10px; }
  /* Legende premium (Machined Graphite): eckige Swatch-Chips, dünner farbiger Links-Rahmen,
     raised-Containment je Zeile, straffe Mono-Labels → klar unterscheidbar statt grauer Block. */
  .aos-leg-lab{ font:600 9px ui-monospace,Menlo,Consolas,monospace; text-transform:uppercase;
    letter-spacing:.14em; color:var(--aos-muted); margin:10px 0 5px; display:flex; align-items:center; }
  .aos-leg{ display:flex; flex-direction:column; gap:3px; }
  .aos-leg-row{ display:flex; align-items:center; gap:9px; padding:5px 9px; font-size:12px;
    color:var(--aos-text); background:var(--aos-raised); border-left:2px solid var(--aos-line); }
  .aos-leg-row em{ font-style:normal; color:var(--aos-dim); font:10px ui-monospace,Menlo,Consolas,monospace;
    margin-left:auto; letter-spacing:.02em; }
  .aos-leg-sw{ width:11px; height:11px; flex:0 0 11px; box-sizing:border-box; }          /* eckiger Knoten-Swatch */
  .aos-leg-line{ width:16px; height:3px; flex:0 0 16px; }                                  /* Strom-Swatch (Linie) */
  .aos-ticker{ display:flex; flex-direction:column; gap:4px; margin-top:6px; font:11px ui-monospace,Menlo,Consolas,monospace; }
  /* feste Zeilenhöhe + Fade → Feed springt nie, Zeilen poppen nicht raus (Anti-Flacker) */
  .aos-ev{ color:var(--aos-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
    border-left:2px solid var(--aos-dim); padding-left:6px; min-height:16px; line-height:16px;
    opacity:1; transition:opacity .5s ease, transform .35s ease; }
  .aos-ev.in{ animation:aos-ev-in .35s ease; }
  .aos-ev.out{ opacity:0; }
  @keyframes aos-ev-in{ from{ opacity:0; transform:translateY(-4px); } to{ opacity:1; transform:none; } }
  .aos-ev b{ color:var(--aos-text); font-weight:600; }
  .aos-ev .xN{ color:var(--aos-dim); margin-left:6px; font-weight:600; }
  .aos-hot{ display:flex; align-items:center; gap:8px; margin:5px 0; font-size:12px; cursor:pointer; }
  .aos-hot:hover .nm{ text-decoration:underline; }
  .aos-hot .nm{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1 1 auto; }
  .aos-hot .bar{ width:46px; height:4px; background:var(--aos-raised); flex:0 0 46px; }
  .aos-hot .bar i{ display:block; height:100%; }
  .aos-hot .n{ font:11px ui-monospace,Menlo,Consolas,monospace; color:var(--aos-muted); width:30px; text-align:right; }

  /* UNTEN */
  .aos-infra-head{ display:flex; align-items:center; gap:12px; cursor:pointer; user-select:none; }
  .aos-infra-head .sum{ font:700 13px ui-monospace,Menlo,Consolas,monospace; padding:2px 8px; border:1px solid var(--aos-line); border-left-width:3px; }
  .aos-infra-head .car{ font:11px ui-monospace,Menlo,Consolas,monospace; color:var(--aos-muted); }
  .aos-chips{ display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
  .aos-chip{ display:flex; align-items:center; gap:6px; padding:3px 8px; background:var(--aos-raised);
    border:1px solid var(--aos-line); font:11px ui-monospace,Menlo,Consolas,monospace; color:var(--aos-muted); }
  .aos-chip.bad{ color:var(--aos-text); }
  .aos-chip .aos-dot{ border-radius:50%; }
  .aos-infra-body{ margin-top:8px; }
  .aos-infra-body[hidden]{ display:none; }

  /* Burger-Menue: fixed, unabhaengig von den Panels (bleibt im Nur-Graph-Modus erreichbar) */
  .aos-top{ padding-right:64px; }
  .aos-burger{ position:fixed; top:calc(var(--gutter,14px) + 8px); right:calc(var(--gutter,14px) + 8px); z-index:30; }
  .aos-burger > button{ width:36px; height:36px; background:var(--aos-raised); border:1px solid var(--aos-line);
    color:var(--aos-text); cursor:pointer; padding:0; display:flex; flex-direction:column; align-items:center;
    justify-content:center; gap:4px; }
  .aos-burger > button:hover, .aos-burger > button[aria-expanded="true"]{ border-color:var(--aos-muted); }
  .aos-burger > button i{ display:block; width:16px; height:2px; background:currentColor; }
  .aos-menu{ position:absolute; top:42px; right:0; width:220px; max-width:calc(100vw - 28px); background:var(--aos-panel);
    border:1px solid var(--aos-muted); padding:6px; box-sizing:border-box; }
  .aos-menu[hidden]{ display:none; }
  .aos-menu .hd{ padding:4px 6px 6px; }
  .aos-menu label{ display:flex; align-items:center; gap:10px; padding:7px 6px; cursor:pointer; font-size:13px; color:var(--aos-text); }
  .aos-menu label:hover{ background:var(--aos-raised); }
  .aos-menu label.main{ border-bottom:1px solid var(--aos-line); margin-bottom:4px; font-weight:700; }
  .aos-menu input{ appearance:none; width:14px; height:14px; margin:0; border:1px solid var(--aos-muted); background:transparent; flex:0 0 14px; }
  .aos-menu input:checked{ background:${C.running}; border-color:${C.running}; }
  .aos-menu input:disabled{ opacity:.4; }
  @media (max-width: 860px){ .aos-top{ flex-wrap:wrap; gap:14px 22px; } .aos-big b{ font-size:24px; } }
  @media (prefers-contrast: more){ .aos-panel{ background:#000; border-color:#fff; } .aos-srow{ background:#000; } }
  `;
  document.head.appendChild(s);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Kleiner "?"-Hinweis-Chip: native title-Tooltip (fail-open, keine Lib) + a11y-Label.
function hint(text) {
  const h = el('span', 'aos-hint', '?');
  h.title = text;
  h.tabIndex = 0;
  h.setAttribute('role', 'note');
  h.setAttribute('aria-label', text);
  return h;
}

// ───────────────────────── Ansichts-Menue (eigene Einheit) ─────────────────────────
// Zentraler Toggle-State; Persistenz in localStorage (fail-open). "Nur Graph" blendet
// alle Panels aus, #scene-cell fuellt per Grid-Neuaufbau den ganzen Raum.
const VIEW_KEY = 'aos.view.v1';
const VIEW_DEFAULT = { graphOnly: false, top: true, left: true, right: true, bottom: true, rates: true, debug: false };

function loadView() {
  try { return { ...VIEW_DEFAULT, ...JSON.parse(localStorage.getItem(VIEW_KEY) || '{}') }; }
  catch { return { ...VIEW_DEFAULT }; }
}
function saveView(v) { try { localStorage.setItem(VIEW_KEY, JSON.stringify(v)); } catch { /* fail-open */ } }

// Rein: Sichtbarkeit -> Grid-Definition (Desktop). Leere Spuren entfallen komplett (keine Luecken).
export function computeGrid(v) {
  const show = (k) => !v.graphOnly && v[k];
  const cols = [], row = [];
  if (show('left')) { cols.push('var(--side)'); row.push('left'); }
  cols.push('1fr'); row.push('scene');
  if (show('right')) { cols.push('var(--side)'); row.push('right'); }
  const rows = [], areas = [];
  const full = (n) => row.map(() => n).join(' ');
  if (show('top')) { rows.push('auto'); areas.push(`"${full('top')}"`); }
  rows.push('minmax(0,1fr)'); areas.push(`"${row.join(' ')}"`);
  if (show('bottom')) { rows.push('auto'); areas.push(`"${full('bottom')}"`); }
  return { cols: cols.join(' '), rows: rows.join(' '), areas: areas.join(' '), pad: v.graphOnly ? '0' : '' };
}

function createViewMenu(slots, onDebug) {
  const view = loadView();
  const app = slots.top.parentElement;
  const leftCol = slots.left.parentElement;       // #left-col (Liste + Detail-Panel)
  const panels = { top: slots.top, left: leftCol, right: slots.right, bottom: slots.bottom };
  const mq = window.matchMedia ? matchMedia('(max-width: 860px)') : { matches: false };

  function apply() {
    for (const k of Object.keys(panels)) panels[k].style.display = (!view.graphOnly && view[k]) ? '' : 'none';
    document.body.classList.toggle('aos-graph-only', view.graphOnly);
    document.body.classList.toggle('aos-rates', !!view.rates);   // Live-Raten ein/aus (Punkt 3c)
    if (mq.matches) {          // Mobile: CSS aus index.html regiert, nur display:none greift
      app.style.gridTemplateColumns = app.style.gridTemplateRows = app.style.gridTemplateAreas = app.style.padding = '';
    } else {
      const g = computeGrid(view);
      app.style.gridTemplateColumns = g.cols; app.style.gridTemplateRows = g.rows;
      app.style.gridTemplateAreas = g.areas; app.style.padding = g.pad;
      app.style.gap = view.graphOnly ? '0' : '';
    }
    saveView(view);
    sync();
    if (onDebug) onDebug(view.debug);
  }

  const wrap = el('div', 'aos-burger');
  const btn = el('button'); btn.type = 'button'; btn.setAttribute('aria-label', 'Ansicht');
  btn.setAttribute('aria-expanded', 'false'); btn.append(el('i'), el('i'), el('i'));
  const menu = el('div', 'aos-menu'); menu.hidden = true;
  menu.append(el('div', 'hd aos-kicker', 'Ansicht'));
  const inputs = {};
  const defs = [['graphOnly', 'Nur Graph', 'main'], ['top', 'Top-Leiste'], ['left', 'Sessions (links)'],
    ['right', 'Legende / Aktivität / Knoten'], ['bottom', 'Infrastruktur'],
    ['rates', 'Live Token/Daten'], ['debug', 'Diagnose']];
  for (const [k, lab, cls] of defs) {
    const lb = el('label', cls || ''); const inp = el('input'); inp.type = 'checkbox';
    lb.append(inp, el('span', null, lab)); menu.append(lb); inputs[k] = inp;
    inp.addEventListener('change', () => { view[k] = inp.checked; apply(); });
  }
  function sync() {
    for (const k of Object.keys(inputs)) {
      inputs[k].checked = !!view[k];
      if (k !== 'graphOnly' && k !== 'debug') inputs[k].disabled = view.graphOnly;
    }
  }
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', String(!menu.hidden));
  });
  document.addEventListener('click', (ev) => {
    if (!menu.hidden && !wrap.contains(ev.target)) { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
  });
  if (mq.addEventListener) mq.addEventListener('change', apply);
  wrap.append(btn, menu); document.body.append(wrap);
  apply();
  return { view };
}

// ───────────────────────── 3) createHud ─────────────────────────

export function createHud(slots) {
  injectStyle();
  const { top, left, right, bottom, rates } = slots;
  const startTs = Date.now();
  let selectedId = null;
  let lastState = null;
  let transport = 'reconnecting';
  let infraOpen = false;

  const emitDetail = (entity) => {
    selectedId = entity ? entity.id : null;
    document.dispatchEvent(new CustomEvent('aos:detail', { detail: { entity: entity || null } }));
    if (lastState) renderSessions(lastState);
  };

  // ── TOP ──
  top.className = 'aos-panel aos-top';
  const brand = el('div');
  brand.append(el('div', 'aos-kicker', 'Agent Operating System'), el('div', 'aos-title', 'Orbital'),
    el('div', 'aos-brand-sub', 'Live-Blick auf deine Agenten-Arbeit'));
  const bigs = {};
  // Eine KPI-Karte: Label oben, große tabellarische Ziffer unten. Optionaler Akzent (farbiger
  // Links-Rahmen + Label-Punkt) für farbcodierte KPIs (Token amber / Daten cyan). renderTop
  // setzt den Ziffer-Text (.fig) in-place.
  function big(key, label, accent) {
    const w = el('div', 'aos-kpi');
    const lab = el('div', 'lab');
    if (accent) { const d = el('i'); d.style.background = accent; lab.append(d); w.style.borderLeftColor = accent; }
    lab.append(document.createTextNode(label));
    const b = el('b', 'fig', '0');
    w.append(lab, b); bigs[key] = { b };
    return w;
  }
  // Durchsatz-Paar als zwei gleichwertige, farbcodierte KPI-Karten (Token amber / Daten cyan).
  const tokCard = big('tok', 'Token/min', PALETTE.flow.tokens);
  const bytCard = big('byt', 'Daten/min', PALETTE.flow.bytes);
  bigs.thru = { tok: bigs.tok.b, byt: bigs.byt.b };
  const ampel = el('div', 'aos-ampel');
  const lamp = el('span', 'lamp'); const atx = el('div', 'tx');
  const aTitle = el('b', null, '--'); const aSub = el('span', null, 'Datenquellen');
  atx.append(aTitle, aSub); ampel.append(lamp, atx);

  // ── Quellen-Status-Popover: klickbarer Drill-in am Ampel-Chip ──────────────
  // Betriebs-Status (welche Datenquelle frisch/veraltet ist) gehört INS HUD, nicht
  // in die Debug-Box. Klick auf die Ampel klappt pro Quelle Status + Grund auf.
  ampel.style.cursor = 'pointer';
  ampel.style.position = 'relative';
  ampel.title = 'Quellen-Status anzeigen';
  let healthOpen = false;
  let lastHealth = {};
  const srcPop = el('div', 'aos-srcpop');
  Object.assign(srcPop.style, {
    position: 'fixed', zIndex: '60',   // fixed + an <body> → entkommt overflow:hidden des Top-Panels
    minWidth: '232px', maxWidth: '304px', background: B.panel,
    border: `1px solid ${B.line}`, borderRadius: '6px',
    boxShadow: '0 14px 34px -12px rgba(0,0,0,0.78)', padding: '7px 2px', display: 'none',
  });
  document.body.appendChild(srcPop);

  function srcRow(name, status, note) {
    const ok = status === 'ok';
    const col = ok ? C.ok : (status === 'error' || status === 'bad') ? C.bad : C.warn;
    const row = el('div');
    Object.assign(row.style, { display: 'flex', alignItems: 'baseline', gap: '8px', padding: '4px 11px' });
    const d = el('span');
    Object.assign(d.style, { width: '7px', height: '7px', borderRadius: '2px', background: col, flex: '0 0 auto', transform: 'translateY(1px)' });
    const nm = el('span', null, name);
    Object.assign(nm.style, { color: B.text, fontSize: '12px', flex: '0 0 auto', minWidth: '98px' });
    const nt = el('span', null, note || status);
    Object.assign(nt.style, { color: ok ? B.dim : col, fontSize: '11px', flex: '1 1 auto', lineHeight: '1.4' });
    row.append(d, nm, nt); return row;
  }
  function renderSrcPop(stateHealth) {
    if (stateHealth) lastHealth = stateHealth;
    srcPop.replaceChildren();
    const head = el('div', null, 'Datenquellen');
    Object.assign(head.style, { padding: '2px 11px 6px', color: B.dim, fontSize: '10px', letterSpacing: '0.08em', textTransform: 'uppercase' });
    srcPop.append(head);
    const entries = Object.entries(lastHealth || {});
    if (!entries.length) { srcPop.append(srcRow('—', 'idle', 'keine Quellen')); return; }
    for (const [k, v] of entries) srcPop.append(srcRow(k, (v && v.status) || '?', v && v.note));
  }
  ampel.addEventListener('click', (e) => {
    e.stopPropagation();
    healthOpen = !healthOpen;
    if (healthOpen) {
      renderSrcPop(lastHealth);
      const r = ampel.getBoundingClientRect();   // Popover unter den Chip legen (fixed)
      srcPop.style.top = `${Math.round(r.bottom + 9)}px`;
      srcPop.style.left = `${Math.round(r.left)}px`;
    }
    srcPop.style.display = healthOpen ? 'block' : 'none';
  });
  srcPop.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => { if (healthOpen) { healthOpen = false; srcPop.style.display = 'none'; } });
  const up = el('div', 'aos-up'); const upB = el('b', null, '00:00'); up.append(upB, el('span', null, 'Uptime'));
  up.title = 'Laufzeit des Dashboards';
  top.append(brand, big('sessions', 'Sessions'), big('agents', 'Agenten'), tokCard, bytCard,
    el('div', 'aos-spacer'), ampel, up);

  // ── LINKS ──
  left.className = 'aos-panel';
  const leftHead = el('div', 'aos-sec');
  leftHead.append(el('div', 'aos-kicker', 'Sessions'));   // Zähler steht kanonisch oben (keine Dopplung)
  const sessList = el('ul', 'aos-list aos-scroll');
  left.append(leftHead, el('div', 'aos-subline', '→ antippen für Details'), sessList);

  // ── RECHTS ──
  right.className = 'aos-panel';
  // Block 1: LEGENDE — erklärt die 3D-Szene (Knoten-Zustand + Ströme) ohne Zahlen.
  // (Früher getrennte Panels "Zustand" + "Fluss"; "Fluss" zeigte kaputte Zahlen → entfernt,
  //  der einzige Live-Durchsatz steht jetzt kanonisch oben in der Top-Leiste.)
  const legBlock = el('div', 'aos-block');
  legBlock.append(el('div', 'aos-kicker', 'Legende'));
  // Subline entfernt (User-Wunsch). Knoten-Zustand als eckige Swatch-Chips mit farbigem Links-Rahmen.
  legBlock.append(el('div', 'aos-leg-lab', 'Knoten-Zustand'));
  const stateWrap = el('div', 'aos-leg');
  for (const k of ['running', 'idle', 'stalled']) {
    const r = el('div', 'aos-leg-row'); r.style.borderLeftColor = C[k];
    const sw = el('span', 'aos-leg-sw');
    if (k === 'idle') { sw.style.background = 'transparent'; sw.style.border = `1px solid ${B.dim}`; }  // hohl = idle
    else sw.style.background = C[k];
    r.append(sw, el('span', null, STATE_LABEL[k]));
    if (k === 'stalled') r.append(hint('beschäftigt, aber seit >10 min kein Update'));
    stateWrap.append(r);
  }
  legBlock.append(stateWrap);
  const flowLab = el('div', 'aos-leg-lab', 'Ströme');
  flowLab.append(hint('dichter = mehr Aktivität'));
  legBlock.append(flowLab);
  const flowWrap = el('div', 'aos-leg');
  const flows = [
    { color: PALETTE.flow.tokens, label: 'Token-Fluss (LLM-Arbeit)' },
    { color: PALETTE.flow.bytes, label: 'Daten-Fluss (Bytes)' },
  ];
  for (const f of flows) {
    const r = el('div', 'aos-leg-row'); r.style.borderLeftColor = f.color;
    const d = el('span', 'aos-leg-line'); d.style.background = f.color;
    r.append(d, el('span', null, f.label)); flowWrap.append(r);
  }
  legBlock.append(flowWrap);
  // Block 2: LETZTE AKTIVITÄT — menschlich lesbare Ereignis-Zeilen, neueste oben.
  const feedBlock = el('div', 'aos-block');
  feedBlock.append(el('div', 'aos-kicker', 'Letzte Aktivität'));
  feedBlock.append(el('div', 'aos-subline', 'Neueste Ereignisse'));
  const ticker = el('div', 'aos-ticker'); feedBlock.append(ticker);
  // Reihenfolge (Informations-Hierarchie): AKTIVITÄT zuerst (das Lebendige, oben), LEGENDE
  // danach (Nachschlag, unten demontiert). Die frühere „Aktivste Knoten"-Liste ist WEG — ihre
  // Aussage („wie aktiv") trägt jetzt der Heat-Balken je Session-Zeile links → nur EINE Rangliste,
  // kein Hin-und-her-Schauen mehr zwischen links und rechts (User-Beschwerde).
  right.append(feedBlock, legBlock);

  // ── UNTEN ──
  bottom.className = 'aos-panel';
  const infraHead = el('div', 'aos-infra-head');
  const infraSum = el('span', 'sum', '--'); const infraCar = el('span', 'car', 'Details');
  const failChips = el('div', 'aos-chips');
  infraHead.append(el('div', 'aos-kicker', 'Infrastruktur'), infraSum, failChips, el('div', 'aos-spacer'), infraCar);
  const infraBody = el('div', 'aos-infra-body'); infraBody.hidden = true;
  const allChips = el('div', 'aos-chips'); infraBody.append(allChips);
  bottom.append(infraHead, infraBody);
  infraHead.addEventListener('click', () => {
    infraOpen = !infraOpen; infraBody.hidden = !infraOpen; infraCar.textContent = infraOpen ? 'einklappen' : 'Details';
  });

  // ── Render ──
  function renderTop(state) {
    const st = (state && state.stats) || {};
    const rows = deriveSessions(state);
    bigs.sessions.b.replaceChildren(document.createTextNode(String(st.sessions_active ?? 0)));
    bigs.sessions.b.append(el('small', null, ` aktiv / ${rows.length} gesamt`));
    const ents = (state && state.entities) || [];
    const agTotal = ents.filter((e) => e.type === 'agent' || e.type === 'professor').length;
    bigs.agents.b.replaceChildren(document.createTextNode(String(st.agents_running ?? 0)));
    bigs.agents.b.append(el('small', null, ` laufen / ${agTotal} gesamt`));
    const th = deriveThroughput(state);
    bigs.thru.tok.textContent = fmtNum(th.tok);
    bigs.thru.byt.textContent = fmtNum(th.byt);
    renderHealth(state && state.health);
  }

  function renderHealth(stateHealth) {
    const h = deriveHealth(stateHealth, transport);
    const col = C[h.level];
    lamp.style.background = col; ampel.style.borderLeftColor = col;
    // "Datenquellen" = frische/gesunde Quellen (✓ N/N). Bei Verbindungsabbruch (keine
    // Quellen) den Klartext-Status zeigen statt "✓ 0/0".
    aTitle.textContent = (h.level === 'ok' && h.total) ? `✓ ${h.ok}/${h.total}` : h.text;
    aTitle.style.color = col; aSub.textContent = 'Datenquellen';
    if (stateHealth) lastHealth = stateHealth;   // fürs Popover vorhalten
    if (healthOpen) renderSrcPop(lastHealth);    // offenes Popover live mitziehen
  }

  // KEYED Reconciliation: eine <li> je Session-id, in-place aktualisiert, nur bei echtem
  // Reihenfolge-Wechsel umsortiert. Kein replaceChildren pro Tick → Scroll/Hover/Fokus bleiben,
  // stabile Zeilen flackern nicht (war eine der Flacker-Quellen).
  const sessEls = new Map();   // id -> rec (li + Felder + kidEls)
  let lastSessOrder = '';
  const rateOf = (id) => (rates && id ? rates.rateOf(id) : { tokPerMin: 0, bytPerMin: 0 });
  const stateColor = (st) => (st === 'running' ? C.running : (st === 'stalled' ? C.stalled : C.idle));

  // Eine Mini-Bar (Track + Fill + Zahl) bauen bzw. setzen. Breite = value/max mit kleinem
  // Floor (Nicht-Null bleibt sichtbar). So trägt JEDE Session zwei echte Live-Bars (Token/Byte).
  function buildBar() {
    const row = el('div', 'aos-mbar');
    const trk = el('span', 'trk'); const fill = el('i'); trk.append(fill);
    const val = el('span', 'val');
    row.append(trk, val);
    return { row, fill, val };
  }
  function setBar(bar, value, max, unit, color) {
    const v = Math.max(0, Number(value) || 0);
    const frac = max > 0 ? v / max : 0;
    const w = v > 0 ? Math.max(0.06, Math.min(1, frac)) : 0;
    bar.fill.style.width = (w * 100).toFixed(0) + '%';
    bar.fill.style.background = color;
    bar.val.textContent = `${fmtNum(v)} ${unit}`;
    bar.val.classList.toggle('z', v === 0);
  }

  function buildSessRow() {
    const li = el('li', 'aos-srow');
    const pj = el('span', 'pj'); const ago = el('span', 'ago');
    const sub = el('span', 'sub');
    const stx = el('span'); const agTot = el('span'); const agRun = el('span');
    const vis = el('button', 'vis'); vis.type = 'button';   // ausblenden/einblenden (3D L0)
    sub.append(stx, agTot, agRun, vis);
    const tokBar = buildBar(); const bytBar = buildBar();   // Token (amber) + Daten (cyan)
    const fleet = el('div', 'aos-fleet');                   // immer: Agenten/Pipelines als Chips
    const kids = el('div', 'aos-kids');                     // bei Auswahl: volle Unterzeilen
    li.append(pj, ago, sub, tokBar.row, bytBar.row, fleet, kids);
    return { li, pj, ago, stx, agTot, agRun, vis, tokBar, bytBar, fleet, kids, kidEls: new Map(), kidOrder: '' };
  }

  // Ein Kind (Fleet-Chip + aufklappbare Unterzeile mit eigenen Token/Daten-Bars).
  function buildKid() {
    const chip = el('span', 'chip');
    const row = el('div', 'aos-kid');
    const head = el('div', 'khead');
    const dot = el('span', 'kdot'); const knm = el('span', 'knm'); const ktype = el('span', 'ktype');
    head.append(dot, knm, ktype);
    const tok = buildBar(); const byt = buildBar();
    row.append(head, tok.row, byt.row);
    return { chip, row, dot, knm, ktype, tok, byt };
  }

  // Kind-Zeilen keyed reconcilen: Chips immer sichtbar, Unterzeilen via CSS nur bei .sel.
  // Bars der Kinder relativ zum Maximum UNTER den Geschwistern (lokaler Vergleich).
  function updateKids(rec, children) {
    let maxTok = 0, maxByt = 0;
    for (const c of children) { const r = rateOf(c.entity.id); if (r.tokPerMin > maxTok) maxTok = r.tokPerMin; if (r.bytPerMin > maxByt) maxByt = r.bytPerMin; }
    const seen = new Set();
    for (const c of children) {
      const id = c.entity.id; seen.add(id);
      let k = rec.kidEls.get(id);
      if (!k) { k = buildKid(); rec.kidEls.set(id, k); }
      const col = stateColor(c.state);
      if (c.state === 'idle') { k.chip.style.background = 'transparent'; k.chip.style.borderColor = B.dim; }
      else { k.chip.style.background = col; k.chip.style.borderColor = col; }
      k.dot.style.background = col;
      k.knm.textContent = humanLabel(c.entity);
      k.ktype.textContent = c.entity.type;
      const r = rateOf(id);
      setBar(k.tok, r.tokPerMin, maxTok, 'tok/m', C.running);
      setBar(k.byt, r.bytPerMin, maxByt, 'B/m', C.data);
    }
    // Reihenfolge/Mitgliedschaft nur bei Änderung angleichen (sonst keine DOM-Moves → kein Flacker).
    const ko = children.map((c) => c.entity.id).join(',');
    if (ko !== rec.kidOrder) {
      for (const c of children) { const k = rec.kidEls.get(c.entity.id); rec.fleet.appendChild(k.chip); rec.kids.appendChild(k.row); }
      rec.kidOrder = ko;
    }
    for (const [id, k] of rec.kidEls) { if (!seen.has(id)) { k.chip.remove(); k.row.remove(); rec.kidEls.delete(id); rec.kidOrder = ''; } }
  }

  function updateSessRow(rec, r, scale) {
    const id = r.entity.id;
    rec.li.style.borderLeftColor = C[r.state];
    rec.li.classList.toggle('sel', selectedId === id);
    rec.li.classList.toggle('idle', r.state === 'idle');
    rec.pj.textContent = r.project;
    rec.ago.textContent = fmtAgo(r.ago);
    rec.stx.textContent = STATE_LABEL[r.state] || r.state; rec.stx.style.color = C[r.state];
    rec.agTot.textContent = `${r.agents.total} Agenten`;
    rec.agRun.textContent = r.agents.running ? `${r.agents.running} laufen` : '';
    rec.agRun.style.display = r.agents.running ? '' : 'none';
    const rt = rateOf(id);
    setBar(rec.tokBar, rt.tokPerMin, scale.maxTok, 'tok/m', C.running);
    setBar(rec.bytBar, rt.bytPerMin, scale.maxByt, 'B/m', C.data);
    updateKids(rec, r.children || []);
    const shown = visibility.isVisible(id);
    rec.li.classList.toggle('hid', !shown);
    rec.vis.textContent = shown ? 'ausblenden' : 'einblenden';
    rec.vis.title = shown ? 'In der 3D-Ansicht ausblenden' : 'In der 3D-Ansicht wieder einblenden';
    rec.vis.onclick = (ev) => { ev.stopPropagation(); visibility.toggle(id); };
    rec.li.title = r.entity.label || r.entity.id;
    rec.li.onclick = () => emitDetail(selectedId === id ? null : r.entity);
  }

  function renderSessions(state) {
    const rows = deriveSessions(state);
    // Session-Bars relativ zum Maximum über alle Sessions (setBar-Floor hält kleine Last sichtbar).
    let maxTok = 0, maxByt = 0;
    for (const r of rows) { const rt = rateOf(r.entity.id); if (rt.tokPerMin > maxTok) maxTok = rt.tokPerMin; if (rt.bytPerMin > maxByt) maxByt = rt.bytPerMin; }
    const scale = { maxTok, maxByt };
    const seen = new Set();
    for (const r of rows) {
      const id = r.entity.id; seen.add(id);
      let rec = sessEls.get(id);
      if (!rec) { rec = buildSessRow(); sessEls.set(id, rec); }
      updateSessRow(rec, r, scale);
    }
    // nur bei echtem Reihenfolge-Wechsel umsortieren (sonst gar nichts am DOM anfassen)
    const order = rows.map((r) => r.entity.id).join(',');
    if (order !== lastSessOrder) {
      for (const r of rows) sessList.appendChild(sessEls.get(r.entity.id).li);
      lastSessOrder = order;
    }
    for (const [id, rec] of sessEls) { if (!seen.has(id)) { rec.li.remove(); sessEls.delete(id); lastSessOrder = ''; } }
    const emptyLi = sessList.querySelector('.aos-empty');
    if (!rows.length && !emptyLi) sessList.append(el('li', 'aos-empty', 'keine Sessions'));
    if (rows.length && emptyLi) emptyLi.remove();
  }

  function renderInfra(state) {
    const inf = deriveInfra(state);
    const bad = inf.items.filter((i) => !i.ok);
    const allOk = inf.total > 0 && bad.length === 0;
    // Dezentes, leicht transparentes GRÜN statt alarmierendem Rot (User-Wunsch): die Infra ist
    // normal nahezu vollständig ok → ruhiger grüner Rahmen; erst bei breitem Ausfall (<80%) amber.
    // Ein einzelner down-Dienst bleibt über seinen amber Punkt ehrlich sichtbar (kein Rot).
    const okRatio = inf.total ? inf.okCount / inf.total : 0;
    const GREEN = 'rgba(79,212,154,0.85)';       // agent-grün, leicht transparent
    const GREEN_SOFT = 'rgba(79,212,154,0.40)';  // noch dezenter für Chip-Rahmen
    const col = inf.total === 0 ? B.dim : (okRatio >= 0.8 ? GREEN : C.warn);
    infraSum.textContent = inf.total ? `Dienste ${inf.okCount}/${inf.total} ok` : 'keine Dienste';
    infraSum.style.borderLeftColor = col; infraSum.style.color = col;
    const mk = (i, isBad) => {
      const chip = el('span', 'aos-chip' + (isBad ? ' bad' : ''));
      const d = el('span', 'aos-dot'); d.style.background = isBad ? C.warn : B.dim;  // down = amber, nie Rot
      chip.style.borderColor = GREEN_SOFT;       // dezent grüner Rahmen für ALLE Infra-Chips
      const port = i.e.meta && i.e.meta.port ? `:${i.e.meta.port}` : '';
      chip.append(d, el('span', null, (i.e.label || i.e.id) + port));
      return chip;
    };
    // Eingeklappt: max. 4 fehlerhafte Dienste als Kurzliste, Rest als "+n".
    failChips.replaceChildren();
    for (const i of bad.slice(0, 4)) failChips.append(mk(i, true));
    if (bad.length > 4) failChips.append(el('span', 'aos-chip', `+${bad.length - 4}`));
    // Aufgeklappt: alle, fehlerhafte farbig, gesunde neutral.
    allChips.replaceChildren();
    for (const i of inf.items) allChips.append(mk(i, !i.ok));
  }

  function fmtUptime(ms) {
    const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
    const mm = String(m % 60).padStart(2, '0'), ss = String(s % 60).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  try { visibility.subscribe(() => { if (lastState) renderSessions(lastState); }); } catch (_) { /* fail-open */ }

  function update(state) {
    lastState = state;
    upB.textContent = fmtUptime(Date.now() - startTs);
    renderTop(state);
    renderSessions(state);
    renderInfra(state);
  }

  // ── Aktivitäts-Feed (Anti-Flacker). Drei Regeln gegen „manche nur ganz kurz angezeigt":
  //  1) Duplikate zusammenfassen: gleiche Zeile (actor|verb|target) innerhalb COALESCE_MS → ×N
  //     statt neue Zeile (die dreifach gezeigte Zeile aus dem Live-Bild verschwindet so).
  //  2) Gedrosselt freigeben: ≤1 neue Zeile / RELEASE_MS → jede Zeile lebt ~MAX_TICK·RELEASE_MS
  //     (≈4,5s); ein Event-Burst kann den Feed nicht mehr in 1s leerwischen.
  //  3) Ausblenden statt Rauspoppen + feste Zeilenhöhe (CSS) → der Feed springt nie.
  const MAX_TICK = 6;
  const RELEASE_MS = 750;
  const COALESCE_MS = 3000;
  const evKey = (ev) => `${ev.actor || ''}|${ev.verb || ''}|${ev.target || ''}`;
  let tickQueue = [];          // wartende Ereignisse {key, ev, count, at}
  let tickRows = [];           // sichtbare Zeilen {key, el, xn, count, at}

  function tickText(ev, count) {
    const [aType, ...aRest] = (ev.actor || '').split(':');
    const aName = aRest.join(':');
    const who = (TYPE_WORD[aType] ? `${TYPE_WORD[aType]} ` : '') + (aName || aType || '?');
    const tgt = (ev.target || '').split(':').slice(1).join(':') || ev.target || '?';
    const verb = VERB_DE[ev.verb] || ev.verb || 'nutzt';
    const isBytes = ev.metric === 'bytes';
    const mag = isBytes ? ev.bytes : ev.tokens;
    const line = el('div', 'aos-ev in');
    line.style.borderLeftColor = isBytes ? C.data : C.running;
    line.append(el('b', null, who), document.createTextNode(` ${verb} `), el('b', null, tgt));
    if (mag != null) line.append(document.createTextNode(` ${fmtNum(mag)} ${isBytes ? 'B' : 'tok'}`));
    const xn = el('span', 'xN', count > 1 ? `×${count}` : '');
    line.append(xn);
    setTimeout(() => line.classList.remove('in'), 360);
    return { el: line, xn };
  }

  function pushEvents(events) {
    const now = Date.now();
    for (const ev of events || []) {
      const key = evKey(ev);
      const disp = tickRows.find((r) => r.key === key && now - r.at < COALESCE_MS);
      if (disp) { disp.count++; disp.at = now; disp.xn.textContent = `×${disp.count}`; continue; }
      const q = tickQueue.find((r) => r.key === key && now - r.at < COALESCE_MS);
      if (q) { q.count++; q.at = now; continue; }
      tickQueue.push({ key, ev, count: 1, at: now });
    }
    if (tickQueue.length > 60) tickQueue.splice(0, tickQueue.length - 60);   // Stau deckeln
  }

  function releaseTick() {
    if (!tickQueue.length) return;
    const item = tickQueue.shift();
    const built = tickText(item.ev, item.count);
    ticker.prepend(built.el);
    tickRows.unshift({ key: item.key, el: built.el, xn: built.xn, count: item.count, at: Date.now() });
    while (tickRows.length > MAX_TICK) {
      const old = tickRows.pop();
      old.el.classList.add('out');
      setTimeout(() => old.el.remove(), 500);
    }
  }
  setInterval(releaseTick, RELEASE_MS);

  // Transport-Health (aus data.js): bei reconnecting kippt die Ampel auf rot.
  function setHealth(health) {
    transport = (health && health.transport) || 'reconnecting';
    renderHealth(health && health.sources ? health.sources : (lastState && lastState.health));
  }

  createViewMenu(slots, (on) => document.body.classList.toggle('aos-debug', on));
  l.info('HUD montiert');
  return { update, pushEvents, setHealth, showDetail: emitDetail };
}
