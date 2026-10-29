// AOS-1 Observatory — src/carousel.js
// Verantwortung: DETAIL-PANEL (frueher Spotlight-Karussell). Sitzt LINKS unter der
// Session-Liste (Container #spotlight), NICHT ueber dem 3D-Kern. Zeigt nur bei
// Auswahl Details, sonst ruhiger Leerzustand. Kein Auto-Durchblaettern mehr.
//
// Detail-API:
//   carousel.showDetail(entity|null)           (direkt)
//   hud.showDetail(entity|null)                (feuert document 'aos:detail', hier gehoert)
// Beide landen in derselben Funktion. update(state) frischt die gewaehlte Entitaet
// mit Live-Werten (per id) auf; tick(dt) bleibt als No-op fuer den main-Loop.
// Reines DOM/CSS, Farben nur aus palette.js; kennt three NICHT.

import { PALETTE, nodeColor } from '../palette.js';
import { humanLabel } from './entity.js';
import { log } from './log.js';

const l = log.mod('detail');
const B = PALETTE.base;

function injectStyle() {
  if (document.getElementById('aos-spot-style')) return;
  const s = document.createElement('style');
  s.id = 'aos-spot-style';
  s.textContent = `
  .aos-spot{ background:${B.panel}; border:1px solid ${B.line}; box-sizing:border-box; padding:10px 12px;
    color:${B.text}; font:13px/1.45 -apple-system,Segoe UI,Helvetica,Arial,sans-serif; }
  .aos-d-head{ display:flex; align-items:center; gap:8px; }
  .aos-d-kick{ font:600 11px ui-monospace,Menlo,Consolas,monospace; letter-spacing:.14em;
    text-transform:uppercase; color:${B.muted}; flex:1 1 auto; }
  .aos-d-x{ background:transparent; border:1px solid ${B.line}; color:${B.muted}; cursor:pointer;
    font:600 11px ui-monospace,Menlo,Consolas,monospace; padding:1px 7px; }
  .aos-d-x:hover{ border-color:${B.muted}; color:${B.text}; }
  .aos-d-idle{ margin-top:6px; color:${B.dim}; font:11px ui-monospace,Menlo,Consolas,monospace; }
  .aos-d-name{ display:flex; align-items:center; gap:8px; margin-top:8px; font:800 16px -apple-system,Segoe UI,Helvetica,Arial,sans-serif; }
  .aos-d-name i{ width:10px; height:10px; flex:0 0 10px; }
  .aos-d-name span{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .aos-d-desc{ margin-top:6px; color:${B.muted}; font:12px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif; }
  .aos-d-grid{ display:grid; grid-template-columns:auto 1fr; gap:3px 12px; margin-top:8px;
    font:12px ui-monospace,Menlo,Consolas,monospace; }
  .aos-d-grid .k{ color:${B.muted}; text-transform:uppercase; letter-spacing:.06em; font-size:10px; align-self:center; }
  .aos-d-grid .v{ color:${B.text}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .aos-d-heat{ height:4px; background:${B.raised}; margin-top:10px; }
  .aos-d-heat i{ display:block; height:100%; }
  `;
  document.head.appendChild(s);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// "claude-opus-4-8" -> "Opus 4.8" (lesbar), Fallback = roh.
function prettyModel(id) {
  if (!id) return '';
  const s = String(id).replace(/^claude-/, '');
  const m = s.match(/^([a-z]+)-(\d+)-(\d+)/);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}` : s;
}

// Kurz-Beschreibung je Werkzeug (was es TUT) — damit ein Klick auf ein Tool erklaert wird.
const TOOL_DESC = {
  Bash: 'Fuehrt Shell-Befehle im System aus.',
  Read: 'Liest Datei-Inhalte.',
  Edit: 'Aendert Dateien chirurgisch (Suchen/Ersetzen).',
  Write: 'Schreibt oder ueberschreibt Dateien.',
  Grep: 'Durchsucht Datei-Inhalte nach Mustern.',
  Glob: 'Findet Dateien per Namensmuster.',
  Task: 'Startet einen Spezialist-Subagenten.',
  Agent: 'Startet einen Spezialist-Subagenten.',
  WebSearch: 'Durchsucht das Web.',
  WebFetch: 'Laedt und liest eine Webseite.',
  TodoWrite: 'Pflegt die Aufgabenliste.',
  NotebookEdit: 'Bearbeitet Jupyter-Notebook-Zellen.',
};

// Was macht die ausgewaehlte Entitaet? Ein Satz, aus den echten Meta-Daten gebildet —
// erklaert dem Nutzer den angeklickten Knoten (enterprise: sinnvoll statt roh).
function describe(e) {
  const m = e.meta || {};
  switch (e.type) {
    case 'session': {
      const proj = m.project ? ` im Projekt ${m.project}` : '';
      return `Eine laufende Claude-Code-Sitzung${proj} — denkt, ruft Werkzeuge auf und delegiert an Agenten.`;
    }
    case 'agent':
    case 'professor': {
      const grp = m.group ? ` (${m.group})` : '';
      return `Ein delegierter Spezialist-Subagent${grp} — bearbeitet eine Teilaufgabe und meldet das Ergebnis zurueck.`;
    }
    case 'pipeline': {
      const unit = m.unit ? ` · ${m.unit}` : '';
      const port = m.port ? ` auf Port ${m.port}` : '';
      return `Eine automatisierte Hintergrund-Pipeline${port}${unit} — laeuft eigenstaendig und erzeugt oder ueberwacht Daten.`;
    }
    case 'server': {
      const port = m.port ? ` (Port ${m.port})` : '';
      return `Ein laufender Netzwerk-Dienst${port} der Infrastruktur.`;
    }
    case 'tool': {
      const nm = e.label || (e.id.split(':')[1] || '');
      if (TOOL_DESC[nm]) return TOOL_DESC[nm];
      if (nm.startsWith('mcp__')) {
        const parts = nm.split('__');
        return `Externes MCP-Werkzeug · ${parts[1] || '?'}: ${parts.slice(2).join('__') || '?'}.`;
      }
      return 'Ein Werkzeug, das die Session aufruft.';
    }
    case 'memory':
      return 'Gedaechtnis — gespeichertes Wissen/Erfahrung, das Sitzungen ueber die Zeit teilen.';
    case 'brett':
      return 'Schwarzes Brett — geteilte Notizen und Lernens der Agenten.';
    default:
      return '';
  }
}

// Reine Zeilenbildung je Entity-Typ (kein DOM).
function detailRows(e, tokensBySession) {
  const m = e.meta || {};
  const rows = [['Typ', e.type]];
  if (e.type === 'session') {
    const tok = tokensBySession[(e.id.split(':')[1] || '')];
    // MEHRERE Modelle gleichzeitig moeglich (Haupt-Session + Subagenten) -> alle zeigen.
    const models = (Array.isArray(m.models) && m.models.length) ? m.models : (m.model ? [m.model] : []);
    rows.push(['Projekt', String(m.project || '--')], ['Status', m.status || (e.active ? 'busy' : 'idle')],
      [models.length > 1 ? 'Modelle' : 'Modell', models.length ? models.map(prettyModel).join(', ') : '--']);
    if (tok) rows.push(['Tokens', `${((tok.input || 0) + (tok.output || 0)).toLocaleString('de')} io`]);
  } else if (e.type === 'agent' || e.type === 'professor') {
    rows.push(['Gruppe', m.group || '--'], ['Status', (m.running || e.active) ? 'running' : 'idle']);
  } else if (e.type === 'pipeline' || e.type === 'server') {
    if (m.port) rows.push(['Port', String(m.port)]);
    if (m.unit) rows.push(['Unit', m.unit]);
    rows.push(['Status', (m.alive || e.active) ? 'ok' : 'down']);
  } else if (e.type === 'tool') {
    rows.push(['Art', m.kind || '--'], ['Server', m.server || '--']);
  } else if (e.type === 'memory') {
    rows.push(['Memtype', m.memtype || '--'], ['Tier', m.tier || '--']);
  } else {
    rows.push(['Status', e.active ? 'active' : 'idle']);
  }
  return rows;
}

export function createCarousel(root) {
  injectStyle();
  root.classList.add('aos-spot');

  const head = el('div', 'aos-d-head');
  head.append(el('div', 'aos-d-kick', 'Detail'));
  const closeBtn = el('button', 'aos-d-x', 'schliessen'); closeBtn.hidden = true;
  head.append(closeBtn);
  const body = el('div');
  root.append(head, body);

  let selected = null;       // Entity (letzter bekannter Stand)
  let tokensBySession = {};

  function render() {
    body.replaceChildren();
    closeBtn.hidden = !selected;
    if (!selected) { body.append(el('div', 'aos-d-idle', 'Knoten oder Session wählen — zeigt Typ, Aufgabe, Modell, Tokens')); return; }
    const e = selected;
    const col = nodeColor(e.type, e.meta);
    const heat = Math.max(0, Math.min(1, Number(e.heat) || 0));
    const nm = el('div', 'aos-d-name'); const sw = el('i'); sw.style.background = col;
    nm.append(sw, el('span', null, humanLabel(e)));   // gleiche Beschriftung wie Liste + 3D
    const grid = el('div', 'aos-d-grid');
    for (const [k, v] of detailRows(e, tokensBySession)) grid.append(el('div', 'k', k), el('div', 'v', v));
    const hb = el('div', 'aos-d-heat'); const hi = el('i');
    hi.style.width = `${(heat * 100).toFixed(0)}%`; hi.style.background = col; hb.append(hi);
    // Beschreibung ("was macht das") — direkt unter dem Namen, vor den Detail-Zeilen.
    const d = describe(e);
    body.append(nm);
    if (d) body.append(el('div', 'aos-d-desc', d));
    body.append(grid, hb);
  }

  function showDetail(entity) { selected = entity || null; render(); }

  closeBtn.onclick = () => { showDetail(null); document.dispatchEvent(new CustomEvent('aos:detail-cleared')); };
  document.addEventListener('aos:detail', (ev) => showDetail(ev.detail && ev.detail.entity));

  function update(state) {
    tokensBySession = (state && state.tokens && state.tokens.by_session) || {};
    if (!selected) return;
    const fresh = ((state && state.entities) || []).find((e) => e.id === selected.id);
    selected = fresh || selected;   // verschwunden -> letzten Stand behalten
    render();
  }

  function tick() { /* kein Auto-Advance mehr */ }

  render();
  l.info('Detail-Panel montiert');
  return { update, tick, showDetail };
}
