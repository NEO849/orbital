// Orbital — src/boot.jsx (Single-Entry)
// Verdrahtung wie fruehere main.js: DOM-HUD booten + EINE StateClient, Callbacks fanen auf
// (a) DOM-HUD/Carousel/Rates, (b) liveStore fuer die R3F-Szene. Alles fail-open.
import { createRoot } from 'react-dom/client';
import { createHud } from './hud.js';
import { createRates } from './rates.js';
import { createCarousel } from './carousel.js';
import { StateClient } from './data.js';
import { log } from './log.js';
import { liveStore } from './live/store.js';
import { navStore } from './nav/navStore.js';
import { visibility } from './nav/visibility.js';
import { Scene } from './r3f/Scene.jsx';

const l = log.mod('boot');

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch (_) { return false; }
}

function boot() {
  const rates = createRates();
  const hud = createHud({
    top: document.getElementById('hud-top'),
    left: document.getElementById('hud-left'),
    right: document.getElementById('hud-right'),
    bottom: document.getElementById('hud-bottom'),
    rates,
  });
  const carousel = createCarousel(document.getElementById('spotlight'));

  const client = new StateClient('', {
    onState: (state) => {
      try { liveStore.setState(state); } catch (e) { l.error('liveStore.setState:', e.message); }
      try { hud.update(state); carousel.update(state); } catch (e) { l.error('onState:', e.message); }
    },
    onEvents: (events) => {
      try { liveStore.pushEvents(events); } catch (e) { l.error('liveStore.pushEvents:', e.message); }
      try { for (const ev of events) rates.add(ev); hud.pushEvents(events); } catch (e) { l.error('onEvents:', e.message); }
    },
    onHealth: (h) => {
      try { hud.setHealth(h); } catch (e) { l.error('onHealth:', e.message); }
    },
  });
  client.start();
  // Debug-/Test-Zugriff (read-only Werkzeug, keine Daten): window.__orbital
  try { window.__orbital = { nav: navStore, visibility, liveStore }; } catch (_) { /* egal */ }

  // Carousel braucht seinen tick (frueher in main.js' rAF-Schleife).
  let last = performance.now();
  const loop = (now) => {
    requestAnimationFrame(loop);
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    try { carousel.tick(dt); } catch (e) { l.error('carousel.tick:', e.message); }
  };
  requestAnimationFrame(loop);

  if (hasWebGL()) {
    try { createRoot(document.getElementById('scene')).render(<Scene />); }
    catch (e) { l.warn('3D-Mount fehlgeschlagen, nur HUD:', e.message); }
  } else {
    l.warn('kein WebGL: nur HUD');
  }
}

try {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
} catch (e) { l.error('boot:', e.message); }
