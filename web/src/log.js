// AOS-1 Observatory — src/log.js
// Verantwortung: EINZIGER Logger-Wrapper + optionales ?debug=1-Overlay.
// Keine three/DOM-Szenen-Logik hier — nur Diagnose. Andere Module importieren
// `log` (Level + Modul-Präfix) und schieben Live-Zähler in `debugOverlay`.
//
// Design: das Overlay ist reines DOM/CSS (Graphit-Tokens aus palette.js),
// updatet sich selbst per rAF-gedrosseltem Takt und ist komplett passiv, wenn
// ?debug nicht gesetzt ist (kein Node im Baum → null Kosten).

import { BASE } from '../palette.js';

// ?debug=1 (oder ?debug) schaltet das Overlay + ausführlichere Logs frei.
function debugEnabled() {
  try { return new URLSearchParams(location.search).has('debug'); } catch { return false; }
}

const DEBUG = debugEnabled();
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = DEBUG ? LEVELS.debug : LEVELS.info;

// Fabriziert einen gebundenen Logger mit festem Präfix `[aos.<mod>]`.
// `log.mod('scene')` → eigener Sub-Logger, damit jede Quelle erkennbar bleibt.
function makeLogger(mod) {
  const tag = `[aos.${mod}]`;
  const emit = (level, fn, args) => {
    if (LEVELS[level] < THRESHOLD) return;
    try { fn(tag, ...args); } catch { /* console kann in Sandboxes fehlen */ }
    if (level === 'error') debugOverlay.setError(args.map(String).join(' '));
  };
  return {
    debug: (...a) => emit('debug', console.debug || console.log, a),
    info:  (...a) => emit('info', console.info || console.log, a),
    warn:  (...a) => emit('warn', console.warn || console.log, a),
    error: (...a) => emit('error', console.error || console.log, a),
    mod: makeLogger,  // verketteter Sub-Logger
  };
}

export const log = makeLogger('app');

// ── Debug-Overlay: FPS, Event-/Flow-Zähler, letzter Fehler, Pro-Quelle-Health ──
// Hält nur Zahlen; die Module rufen die set*-Setter auf. Rendert gedrosselt.
export const debugOverlay = (() => {
  const state = {
    fps: 0, events: 0, flows: 0, particles: 0,
    error: '', health: {}, extra: {},
  };
  let el = null, body = null;
  let lastPaint = 0;

  // Sichtbar bei ?debug ODER wenn der Burger-Toggle "Diagnose" die Body-Klasse setzt.
  // So ist es ein BEWUSST geschaltetes Entwickler-Panel, nie ein Zufalls-Overlay fuer Nutzer.
  function overlayOn() {
    if (DEBUG) return true;
    try { return !!(document.body && document.body.classList.contains('aos-debug')); }
    catch { return false; }
  }

  // Integriertes Graphit-Panel (gleiche Tokens wie das HUD) statt roher schwarzer
  // Box. Header "DIAGNOSE · dev" kennzeichnet es klar als Entwickler-Telemetrie.
  function ensureEl() {
    if (el) return el;
    el = document.createElement('div');
    el.id = 'aos-debug';
    Object.assign(el.style, {
      // unten-RECHTS, Unterkante dynamisch knapp ueber die Infrastruktur-Leiste gehoben
      // (siehe paint) → keine Ueberlappung mit "Details", folgt dem Aus-/Einklappen.
      position: 'fixed', bottom: '72px', right: '14px', left: 'auto', zIndex: '40',
      width: '244px', background: BASE.panel, color: BASE.muted,
      border: `1px solid ${BASE.line}`, borderRadius: '6px',
      boxShadow: '0 10px 26px -10px rgba(0,0,0,0.7)',
      font: '11px ui-monospace,Menlo,Consolas,monospace',
      overflow: 'hidden', pointerEvents: 'none', opacity: '0.97',
    });
    const head = document.createElement('div');
    Object.assign(head.style, {
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '5px 9px', borderBottom: `1px solid ${BASE.line}`,
      color: BASE.dim, fontSize: '10px', letterSpacing: '0.09em', textTransform: 'uppercase',
    });
    const title = document.createElement('span'); title.textContent = 'Diagnose';
    const tag = document.createElement('span'); tag.textContent = 'dev'; tag.style.opacity = '0.7';
    head.append(title, tag);
    body = document.createElement('pre');
    Object.assign(body.style, {
      margin: '0', padding: '7px 9px', whiteSpace: 'pre', color: BASE.text, lineHeight: '1.5',
    });
    el.append(head, body);
    document.body.appendChild(el);
    return el;
  }

  function paint(now) {
    if (!overlayOn()) { if (el) el.style.display = 'none'; return; }   // Toggle aus → verstecken
    ensureEl();
    el.style.display = 'block';
    // Unterkante ~10px ueber die Oberkante der Infrastruktur-Leiste legen (lift).
    try {
      const bar = document.getElementById('hud-bottom');
      if (bar) { const r = bar.getBoundingClientRect(); el.style.bottom = `${Math.round(Math.max(12, innerHeight - r.top + 10))}px`; }
    } catch { /* ignore */ }
    if (now - lastPaint < 250) return;  // 4x/s reicht
    lastPaint = now;
    const ex = state.extra || {};
    // Ausfuehrliche Quellen-Health lebt jetzt im HUD (aufklappbarer Chip); hier nur 1-Zeilen-Summary.
    const vals = Object.values(state.health || {});
    const stale = vals.filter((v) => v && v.status && v.status !== 'ok').length;
    const src = vals.length ? `quellen ${vals.length - stale}/${vals.length} ok` : 'quellen -';
    body.textContent =
      `fps ${state.fps.toFixed(0)}      nodes ${ex.nodes ?? '-'}\n` +
      `partikel ${state.particles}   flows ${state.flows}\n` +
      `ambient ${ex.ambient ?? '-'}   skipped ${ex.skipped ?? '-'}\n` +
      `events ${state.events}   ${src}` +
      (state.error ? `\n! ${state.error}` : '');
  }

  return {
    get enabled() { return overlayOn(); },   // dynamisch → Burger-Toggle wirkt sofort
    setFps: (v) => { state.fps = v; },
    setEvents: (v) => { state.events = v; },
    setFlows: (v) => { state.flows = v; },
    setParticles: (v) => { state.particles = v; },
    setError: (msg) => { state.error = msg; },
    setHealth: (h) => { state.health = h || {}; },
    setExtra: (k, v) => { state.extra[k] = v; },
    // vom Haupt-Loop JE FRAME gerufen (auch wenn aus) → regelt Sichtbarkeit selbst.
    tick: (now) => paint(now),
  };
})();
