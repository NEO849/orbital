// Orbital — nav/hierarchy.js
// Reine Ableitung "was zeigt Ebene N?" ueber dem liveStore. Kein React, kein three, fail-open
// (fehlende Daten -> leere Liste). NUR Metadaten (Typ, Tool, Zaehler) — nie private Inhalte.
//
// Item: { id, type, label, sub, heat, meta, detail? }
//   type: Entitaetstyp (session|agent|...) oder 'event' fuer Aktivitaets-Karten (L2/L3).
import { liveStore } from '../live/store.js';
import { visibility } from './visibility.js';
import { humanLabel, sessionName } from '../entity.js';

const L1_TYPES = new Set(['agent', 'professor', 'pipeline', 'tool', 'memory', 'brett', 'server']);
const MAX_ITEMS = 14;   // Bogen bleibt lesbar; Rest wird abgeschnitten

const byIdMap = () => {
  const m = new Map();
  const ents = (liveStore.state && liveStore.state.entities) || [];
  for (const e of ents) if (e && e.id) m.set(e.id, e);
  return m;
};
const edges = () => (liveStore.state && liveStore.state.edges) || [];
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const fmt = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(Math.round(n)));

function entityItem(e, sub) {
  return { id: e.id, type: e.type, label: humanLabel(e), sub: sub || '', heat: e.heat || 0, meta: e.meta || {} };
}

function sessions() {
  const ents = (liveStore.state && liveStore.state.entities) || [];
  return ents.filter((e) => e && e.type === 'session' && visibility.isVisible(e.id))
    .map((e) => ({ ...entityItem(e, (e.meta && e.meta.project) || ''), label: sessionName(e) }))
    .sort(byId);
}

// Ziele ausgehender Kanten, dedupliziert; sub = Kantenarten.
function outgoing(id) {
  const ents = byIdMap();
  const kinds = new Map();
  for (const ed of edges()) {
    if (!ed || ed.source !== id || !ed.target) continue;
    const t = ents.get(ed.target);
    if (!t || !L1_TYPES.has(t.type)) continue;
    if (!kinds.has(t.id)) kinds.set(t.id, new Set());
    kinds.get(t.id).add(ed.kind || 'link');
  }
  return [...kinds].map(([tid, ks]) => entityItem(ents.get(tid), [...ks].join(' / ')));
}

function level1(sid) {
  return outgoing(sid).sort((a, b) => (b.heat - a.heat) || byId(a, b)).slice(0, MAX_ITEMS);
}

// L2: Events zu einem Knoten gruppiert nach verb@target, plus Graph-Nachbarn (Kantenart als verb).
function level2(nid) {
  const groups = new Map();
  const add = (verb, target, ev) => {
    const key = `${verb || 'link'}@${target || ''}`;
    let g = groups.get(key);
    if (!g) {
      g = { id: `event:${key}`, type: 'event', verb: verb || 'link', target: target || '', tool: '',
        tokens: 0, bytes: 0, count: 0, ts: '', actor: '' };
      groups.set(key, g);
    }
    if (ev) {
      g.count++; g.tokens += Number(ev.tokens) || 0; g.bytes += Number(ev.bytes) || 0;
      if (ev.tool) g.tool = ev.tool;
      if (ev.actor) g.actor = ev.actor;
      if (ev.ts && ev.ts > g.ts) g.ts = ev.ts;
    }
  };
  for (const ev of liveStore.eventsFor(nid)) if (ev) add(ev.verb, ev.target, ev);
  for (const ed of edges()) if (ed && ed.source === nid && ed.target) add(ed.kind, ed.target, null);
  const ents = byIdMap();
  return [...groups.values()]
    .sort((a, b) => (b.count - a.count) || (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0) || byId(a, b))
    .slice(0, MAX_ITEMS)
    .map((g) => {
      const t = ents.get(g.target);
      const tgtLabel = t ? humanLabel(t) : (g.target || '-');
      const sub = g.count
        ? `${g.count}x  ${fmt(g.tokens)} tok  ${fmt(g.bytes)} B`
        : 'Verbindung';
      return { ...g, label: tgtLabel, sub, heat: 0, meta: {} };
    });
}

// L3: Metadaten-Detail zu einer L2-Karte (ein Item mit detail-Zeilen).
function level3(nid, cardId) {
  const card = level2(nid).find((c) => c.id === cardId);
  if (!card) return [];
  const t = byIdMap().get(card.target);
  const detail = [
    ['Typ', t ? t.type : 'event'],
    ['Aktion', card.verb],
    ['Ziel', card.target || '-'],
    ['Tool', card.tool || '-'],
    ['Aufrufe', String(card.count)],
    ['Token', fmt(card.tokens)],
    ['Bytes', fmt(card.bytes)],
    ['Zuletzt', card.ts ? card.ts.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '-'],
  ];
  return [{ ...card, sub: '', detail }];
}

// path: [{id,type}] ab L1. Rueckgabe: Item[] der AKTUELLEN Ebene (path.length).
export function childrenAt(path) {
  try {
    const p = path || [];
    if (p.length === 0) return sessions();
    if (p.length === 1) return level1(p[0].id);
    if (p.length === 2) return level2(p[1].id);
    return level3(p[1].id, p[2].id);
  } catch (_) { return []; }
}

// Anzeigename eines Pfad-Segments (Breadcrumb); faellt auf den id-Stamm zurueck.
export function labelOf(seg) {
  try {
    const e = byIdMap().get(seg.id);
    if (e) return e.type === 'session' ? sessionName(e) : humanLabel(e);
  } catch (_) { /* fall through */ }
  const s = String(seg.id || '');
  const i = s.indexOf(':');
  const rest = i > 0 ? s.slice(i + 1) : s;
  return rest.includes('@') ? rest.replace('@', '  ') : rest;
}
