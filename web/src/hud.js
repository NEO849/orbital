// AOS-1 Observatory — src/hud.js
// Verantwortung: die festen 2D-Panels (reines DOM/CSS, Farben NUR aus palette.js).
// Der 3D-Kern bleibt frei: nichts schwebt ueber der Szene. Aufbau in 3 Schichten:
//   1) derive*  — reine Funktionen (state -> Anzeige-Modell), kein DOM
//   2) render*  — DOM aus dem Modell
//   3) createHud — verdrahtet Slots, exponiert update/pushEvents/setHealth/showDetail
//
// Panels:
//  TOP    — AOS-1 + 4 Glanz-Zahlen (Sessions aktiv/gesamt, Agenten laufend,
//           Durchsatz, Health-Ampel) + Uptime
//  LINKS  — Session-Liste (laufend zuerst, vertikal scrollbar)
//  RECHTS — Zustands-Legende, letzte 5 Events, Top-3 heiss
//  UNTEN  — Infrastruktur eingeklappt: "n/N ok", nur fehlerhafte Dienste farbig
//
// Detail-API: hud.showDetail(entity|null) -> feuert CustomEvent 'aos:detail' auf
// document; das Detail-Panel (carousel.js) lauscht darauf. Keine Emojis.

import { PALETTE } from '../palette.js';
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

function projectName(meta) {
  const p = meta && meta.project ? String(meta.project) : '';
  if (!p) return '~';
  // Home-Praefix -> '~' kuerzen (generisch fuer root-, home- und Users-Heimverzeichnisse).
  // Diese Referenz STRIPPT einen Pfad, sie leakt keinen -> vom Leak-Scanner ausgenommen.
  const m = p.match(/^(\/root|\/home\/[^/]+|\/Users\/[^/]+)(\/|$)/);  // scan:allow
  if (!m) return p;
  return m[2] === '/' ? p.replace(m[1] + '/', '~/') : '~';
}

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

export function deriveSessions(state, now = Date.now()) {
  const ents = (state && state.entities) || [];
  const byId = {};
  for (const e of ents) byId[e.id] = e;
  const ag = agentsBySession(state && state.edges, byId);
  const rank = { running: 0, stalled: 1, idle: 2 };
  return ents.filter((e) => e.type === 'session').map((e) => {
    const st = sessionState(e, now);
    const a = ag[e.id] || { total: 0, running: 0 };
    const upd = e.meta && e.meta.updatedAt;
    return { entity: e, state: st, project: projectName(e.meta), agents: a, ago: upd ? now - upd : null, upd: upd || 0 };
  }).sort((x, y) => (rank[x.state] - rank[y.state]) || (y.upd - x.upd));
}

// Health -> 'ok' | 'warn' | 'bad' + Text. Quelle: state.health (je Quelle status)
// plus Transport (reconnecting = bad).
export function deriveHealth(stateHealth, transport) {
  const vals = Object.values(stateHealth || {});
  const stale = vals.filter((v) => v && v.status && v.status !== 'ok');
  const dead = stale.filter((v) => /err|down|fail|dead/i.test(v.status));
  if (transport === 'reconnecting') return { level: 'bad', text: 'Verbindung', sub: 'reconnecting' };
  if (dead.length) return { level: 'bad', text: `${dead.length} Fehler`, sub: `${vals.length - stale.length}/${vals.length} Quellen ok` };
  if (stale.length) return { level: 'warn', text: `${stale.length} veraltet`, sub: `${vals.length - stale.length}/${vals.length} Quellen ok` };
  return { level: 'ok', text: 'ok', sub: vals.length ? `${vals.length}/${vals.length} Quellen ok` : 'keine Quellen' };
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
  .aos-top{ display:flex; align-items:center; gap:22px; padding:9px 16px; }
  .aos-div{ width:1px; align-self:stretch; background:var(--aos-line); margin:4px 0; }
  .aos-big{ display:flex; flex-direction:column; line-height:1.1; min-width:0; }
  .aos-big b{ font:600 24px ui-monospace,Menlo,Consolas,monospace; color:var(--aos-text);
    letter-spacing:-.01em; font-variant-numeric:tabular-nums; }
  .aos-big b small{ font-size:13px; color:var(--aos-dim); font-weight:500; }
  .aos-big span{ font:600 9px ui-monospace,Menlo,Consolas,monospace; color:var(--aos-muted);
    text-transform:uppercase; letter-spacing:.13em; margin-top:5px; }
  .aos-big i{ font-style:normal; font:11px ui-monospace,Menlo,Consolas,monospace; color:var(--aos-dim); margin-top:1px; }
  /* Durchsatz = ZWEI GLEICHWERTIGE, farbcodierte KPIs (Token amber / Daten cyan) — kein
     Riesen-Token + Mini-Daten mehr. Gleiche Größe = gleiche Wichtigkeit (Enterprise-KPI-Paar). */
  .aos-thru{ display:flex; flex-direction:column; gap:6px; }
  .aos-thru-label{ font:600 9px ui-monospace,Menlo,Consolas,monospace; text-transform:uppercase;
    letter-spacing:.13em; color:var(--aos-muted); }
  .aos-thru-rows{ display:flex; gap:22px; }
  .aos-thru-row{ display:flex; align-items:center; gap:7px; }
  .aos-thru-row .dot{ width:7px; height:7px; border-radius:2px; flex:0 0 7px; }
  .aos-thru-row b{ font:600 18px ui-monospace,Menlo,Consolas,monospace; color:var(--aos-text);
    letter-spacing:-.01em; font-variant-numeric:tabular-nums; }
  .aos-thru-row small{ font:500 10px ui-monospace,Menlo,Consolas,monospace; color:var(--aos-dim); margin-left:1px; }
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
    color:var(--aos-muted); text-transform:uppercase; letter-spacing:.06em; }
  .aos-empty{ color:var(--aos-dim); font:11px ui-monospace,Menlo,Consolas,monospace; padding:6px 2px; }

  /* RECHTS */
  .aos-block + .aos-block{ margin-top:12px; border-top:1px solid var(--aos-line); padding-top:10px; }
  .aos-leg-row{ display:flex; align-items:center; gap:8px; font-size:12px; color:var(--aos-text); margin:5px 0; }
  .aos-leg-row em{ font-style:normal; color:var(--aos-muted); font:11px ui-monospace,Menlo,Consolas,monospace; margin-left:auto; }
  .aos-leg-line{ width:18px; height:3px; flex:0 0 18px; }
  .aos-ticker{ display:flex; flex-direction:column; gap:4px; margin-top:6px; font:11px ui-monospace,Menlo,Consolas,monospace; }
  .aos-ev{ color:var(--aos-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; border-left:2px solid var(--aos-dim); padding-left:6px; }
  .aos-ev b{ color:var(--aos-text); font-weight:600; }
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

// ───────────────────────── Ansichts-Menue (eigene Einheit) ─────────────────────────
// Zentraler Toggle-State; Persistenz in localStorage (fail-open). "Nur Graph" blendet
// alle Panels aus, #scene-cell fuellt per Grid-Neuaufbau den ganzen Raum.
const VIEW_KEY = 'aos.view.v1';
const VIEW_DEFAULT = { graphOnly: false, top: true, left: true, right: true, bottom: true, debug: false };

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
    ['right', 'Zustand / Events / Heiss'], ['bottom', 'Infrastruktur'], ['debug', 'Diagnose']];
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
  const { top, left, right, bottom } = slots;
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
  brand.append(el('div', 'aos-kicker', 'Agent Operating System'), el('div', 'aos-title', 'AOS-1'),
    el('div', 'aos-brand-sub', 'Live Claude-Code-Aktivität'));
  const bigs = {};
  function big(key, label, hero) {
    const w = el('div', 'aos-big' + (hero ? ' hero' : ''));
    const b = el('b', null, '0'); const sp = el('span', null, label); const sub = el('i', null, '');
    w.append(b, sp, sub); bigs[key] = { b, sub }; return w;
  }
  // Durchsatz-Paar: Token (amber) + Daten (cyan) gleich groß, farbcodiert wie die Ströme.
  function thruBlock() {
    const w = el('div', 'aos-thru');
    w.append(el('div', 'aos-thru-label', 'Durchsatz'));
    const rows = el('div', 'aos-thru-rows');
    const mk = (hex, unit) => {
      const r = el('div', 'aos-thru-row');
      const dot = el('span', 'dot'); dot.style.background = hex;
      const b = el('b', null, '0');
      r.append(dot, b, el('small', null, unit)); rows.append(r); return b;
    };
    const tok = mk(PALETTE.flow.tokens, 'tok/min');
    const byt = mk(PALETTE.flow.bytes, 'B/min');
    w.append(rows); bigs.thru = { tok, byt };
    return w;
  }
  const ampel = el('div', 'aos-ampel');
  const lamp = el('span', 'lamp'); const atx = el('div', 'tx');
  const aTitle = el('b', null, '--'); const aSub = el('span', null, 'Health');
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
  const div = () => el('div', 'aos-div');
  top.append(brand, div(), big('sessions', 'Sessions aktiv'), div(), big('agents', 'Agenten laufend'),
    div(), thruBlock(), div(), ampel, el('div', 'aos-spacer'), up);

  // ── LINKS ──
  left.className = 'aos-panel';
  const leftHead = el('div', 'aos-sec');
  const leftCount = el('span', 'aos-kicker', '');
  leftHead.append(el('div', 'aos-kicker', 'Sessions'), el('div', 'aos-spacer'), leftCount);
  const sessList = el('ul', 'aos-list aos-scroll');
  left.append(leftHead, sessList);

  // ── RECHTS ──
  right.className = 'aos-panel';
  const legBlock = el('div', 'aos-block');
  legBlock.append(el('div', 'aos-kicker', 'Zustand'));
  const stateRows = [['running', 'laeuft'], ['idle', 'idle'], ['stalled', 'stalled']];
  for (const [k, lab] of stateRows) {
    const r = el('div', 'aos-leg-row'); const d = el('span', 'aos-dot'); d.style.background = C[k];
    r.append(d, el('span', null, lab)); legBlock.append(r);
  }
  legBlock.append(el('div', 'aos-kicker', 'Fluss')); legBlock.lastChild.style.marginTop = '10px';
  for (const f of PALETTE.legend.flows) {
    const r = el('div', 'aos-leg-row'); const d = el('span', 'aos-leg-line'); d.style.background = f.color;
    r.append(d, el('span', null, f.label), el('em', null, f.unit)); legBlock.append(r);
  }
  const feedBlock = el('div', 'aos-block');
  feedBlock.append(el('div', 'aos-kicker', 'Letzte Events'));
  const ticker = el('div', 'aos-ticker'); feedBlock.append(ticker);
  const hotBlock = el('div', 'aos-block');
  hotBlock.append(el('div', 'aos-kicker', 'Heiss'));
  const hotList = el('div'); hotBlock.append(hotList);
  right.append(legBlock, feedBlock, hotBlock);

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
    const sm = el('small', null, ` / ${rows.length}`); bigs.sessions.b.append(sm);
    const ents = (state && state.entities) || [];
    const agTotal = ents.filter((e) => e.type === 'agent' || e.type === 'professor').length;
    bigs.agents.b.replaceChildren(document.createTextNode(String(st.agents_running ?? 0)));
    bigs.agents.b.append(el('small', null, ` / ${agTotal}`));
    const th = deriveThroughput(state);
    bigs.thru.tok.textContent = fmtNum(th.tok);
    bigs.thru.byt.textContent = fmtNum(th.byt);
    renderHealth(state && state.health);
  }

  function renderHealth(stateHealth) {
    const h = deriveHealth(stateHealth, transport);
    const col = C[h.level];
    lamp.style.background = col; ampel.style.borderLeftColor = col;
    aTitle.textContent = h.text; aTitle.style.color = col; aSub.textContent = h.sub;
    if (stateHealth) lastHealth = stateHealth;   // fürs Popover vorhalten
    if (healthOpen) renderSrcPop(lastHealth);    // offenes Popover live mitziehen
  }

  function renderSessions(state) {
    const rows = deriveSessions(state);
    leftCount.textContent = `${rows.filter((r) => r.state === 'running').length} / ${rows.length}`;
    sessList.replaceChildren();
    for (const r of rows) {
      const li = el('li', 'aos-srow' + (selectedId === r.entity.id ? ' sel' : ''));
      li.style.borderLeftColor = C[r.state];
      li.append(el('span', 'pj', r.project), el('span', 'ago', fmtAgo(r.ago)));
      const sub = el('span', 'sub');
      const stx = el('span', null, r.state); stx.style.color = C[r.state];
      sub.append(stx, el('span', null, `${r.agents.total} Agenten`));
      if (r.agents.running) sub.append(el('span', null, `${r.agents.running} laufen`));
      li.append(sub);
      li.title = r.entity.label || r.entity.id;
      li.onclick = () => emitDetail(selectedId === r.entity.id ? null : r.entity);
      sessList.append(li);
    }
    if (!rows.length) sessList.append(el('li', 'aos-empty', 'keine Sessions'));
  }

  function renderHot(state) {
    hotList.replaceChildren();
    const hot = deriveHot(state);
    for (const e of hot) {
      const r = el('div', 'aos-hot');
      const d = el('span', 'aos-dot'); d.style.background = C.running;
      const bar = el('span', 'bar'); const fill = el('i'); fill.style.width = `${Math.round((e.heat || 0) * 100)}%`;
      fill.style.background = C.running; bar.append(fill);
      r.append(d, el('span', 'nm', e.label || e.id), bar, el('span', 'n', (e.heat || 0).toFixed(2)));
      r.title = e.type; r.onclick = () => emitDetail(e);
      hotList.append(r);
    }
    if (!hot.length) hotList.append(el('div', 'aos-empty', 'nichts heiss'));
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
    infraSum.textContent = inf.total ? `${inf.okCount}/${inf.total} ok` : 'keine Dienste';
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

  function update(state) {
    lastState = state;
    upB.textContent = fmtUptime(Date.now() - startTs);
    renderTop(state);
    renderSessions(state);
    renderHot(state);
    renderInfra(state);
  }

  // Letzte 5 Events, neueste oben.
  const MAX_TICK = 5;
  function pushEvents(events) {
    for (const ev of events) {
      const line = el('div', 'aos-ev');
      const who = (ev.actor || '').split(':').slice(1).join(':') || ev.actor || '?';
      const tgt = (ev.target || '').split(':').slice(1).join(':') || ev.target || '?';
      const isBytes = ev.metric === 'bytes';
      const mag = isBytes ? ev.bytes : ev.tokens;
      line.style.borderLeftColor = isBytes ? C.data : C.running;
      line.append(el('b', null, who), document.createTextNode(` ${ev.verb || 'access'} `), el('b', null, tgt));
      if (mag != null) line.append(document.createTextNode(` ${fmtNum(mag)} ${isBytes ? 'B' : 'tok'}`));
      ticker.prepend(line);
    }
    while (ticker.childElementCount > MAX_TICK) ticker.lastElementChild.remove();
  }

  // Transport-Health (aus data.js): bei reconnecting kippt die Ampel auf rot.
  function setHealth(health) {
    transport = (health && health.transport) || 'reconnecting';
    renderHealth(health && health.sources ? health.sources : (lastState && lastState.health));
  }

  createViewMenu(slots, (on) => document.body.classList.toggle('aos-debug', on));
  l.info('HUD montiert');
  return { update, pushEvents, setHealth, showDetail: emitDetail };
}
