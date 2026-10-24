// AOS-1 Observatory — src/main.js
// Verantwortung: Bootstrap + Verdrahtung. Hält KEINE eigene Darstellungslogik —
// instanziiert die Module, verbindet den StateClient mit scene/nodes/flows/hud/
// carousel und treibt EINE requestAnimationFrame-Schleife. Ein Fehler in einem
// Modul darf die Szene NIE killen → der ganze Frame läuft in try/catch.
//
// Datenfluss:
//   StateClient.onState  → layout neu rechnen → nodes/edges/hud/carousel updaten
//   StateClient.onEvents → flows.spawn(ev) + HUD-Ticker + Debug-Zähler
//   StateClient.onHealth → HUD-Transport-Indikator + Debug-Overlay-Health

import * as THREE from 'three';
import { createScene } from './scene.js';
import { createNodes } from './nodes.js';
import { createFlows } from './flows.js';
import { createStreamLines } from './streamlines.js';
import { createZones } from './zones.js';
import { createHud } from './hud.js';
import { createCarousel } from './carousel.js';
import { StateClient } from './data.js';
import { computeLayout, zones as zoneDefs } from './layout.js';
import { log, debugOverlay } from './log.js';

const l = log.mod('main');

function boot() {
  const sceneHost = document.getElementById('scene');
  const hud = createHud({
    top: document.getElementById('hud-top'),
    left: document.getElementById('hud-left'),
    right: document.getElementById('hud-right'),
    bottom: document.getElementById('hud-bottom'),
  });
  const carousel = createCarousel(document.getElementById('spotlight'));

  const sc = createScene(sceneHost);
  let nodes = null, flows = null, streams = null, zonesViz = null;
  if (sc) {
    nodes = createNodes(sc.scene);
    flows = createFlows(sc.scene, (id) => (nodes ? nodes.getPosition(id) : null));
    streams = createStreamLines(sc.scene);   // kontinuierliche Adern UNTER den Partikeln
    zonesViz = createZones(sc.scene);
  } else {
    // Kein WebGL → HUD/Spotlight funktionieren trotzdem (graceful degrade).
    l.warn('ohne 3D-Szene weiter (nur HUD)');
  }

  // Zähler für Debug-Overlay.
  let totalEvents = 0;
  let lastEntities = [];   // letzter Entity-Satz (für Klick-Auswahl → Detail-Panel)
  let lastZoneSig = '';    // Zonen nur bei geänderter Typ-Zählung neu bauen (Textur-Churn sparen)

  // ── Daten verdrahten ────────────────────────────────────────────────────
  const client = new StateClient('', {
    onState: (state) => {
      try {
        lastEntities = state.entities || [];
        const layout = computeLayout(state.entities || []);
        if (nodes) { nodes.update(state.entities || [], layout); nodes.updateEdges(state.edges || [], layout); }
        if (flows) {
          // heat je Entität → aktive Kanten tragen den Dauerstrom (Rate ∝ heat²).
          // tokenHeat → amber-Rail, byteHeat → cyan-Rail (fehlt → 0, Daten-Rail bleibt leer).
          const heat = new Map();
          const byteHeat = new Map();
          for (const e of state.entities || []) if (e && e.id) {
            heat.set(e.id, e.heat || 0);
            byteHeat.set(e.id, e.byteHeat || (e.meta && e.meta.byteHeat) || 0);
          }
          flows.setActive(state.edges || [], (id) => heat.get(id) || 0, (id) => byteHeat.get(id) || 0);
          if (streams) {
            streams.rebuild(state.edges || [], (id) => (nodes ? nodes.getPosition(id) : null));
            streams.setActive(state.edges || [], (id) => heat.get(id) || 0, (id) => byteHeat.get(id) || 0);
          }
        }
        if (zonesViz) {
          // Zonen-Boxen/Labels nur bei geänderter Typ-Zählung neu bauen (sonst Textur-Churn).
          const counts = {};
          for (const e of state.entities || []) if (e && e.type) counts[e.type] = (counts[e.type] || 0) + 1;
          const sig = Object.keys(counts).sort().map((k) => k + counts[k]).join(',');
          if (sig !== lastZoneSig) { zonesViz.rebuild(zoneDefs, counts); lastZoneSig = sig; }
        }
        hud.update(state);
        carousel.update(state);
        if (debugOverlay.enabled) {
          debugOverlay.setExtra('nodes', nodes ? nodes.count() : 0);
          debugOverlay.setHealth(state.health || {});
        }
      } catch (e) {
        l.error('onState-Verarbeitung:', e.message);
      }
    },
    onEvents: (events) => {
      try {
        for (const ev of events) { if (flows) flows.spawn(ev); }
        hud.pushEvents(events);
        totalEvents += events.length;
        debugOverlay.setEvents(totalEvents);
      } catch (e) {
        l.error('onEvents-Verarbeitung:', e.message);
      }
    },
    onHealth: (h) => {
      try { hud.setHealth(h); } catch (e) { l.error('onHealth:', e.message); }
    },
  });
  client.start();

  // ── Knoten-Auswahl: Klick auf einen Knoten → Detail-Panel links (hud.showDetail) ──
  // Drag (Orbit-Rotation) wird von echtem Klick unterschieden (Bewegung < 6px),
  // sonst würde jedes Loslassen nach dem Drehen eine Auswahl auslösen.
  if (sc && nodes && hud && typeof hud.showDetail === 'function') {
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const elc = sc.renderer.domElement;
    let downX = 0, downY = 0;
    elc.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; });
    elc.addEventListener('pointerup', (e) => {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;   // war ein Drag
      const rect = elc.getBoundingClientRect();
      ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1,
              -((e.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, sc.camera);
      const id = nodes.raycast(raycaster);
      const ent = id ? (lastEntities.find((x) => x.id === id) || null) : null;
      try { hud.showDetail(ent); } catch (err) { l.warn('showDetail:', err.message); }
    });
  }

  // ── EINE Render-/Update-Schleife ──────────────────────────────────────────
  let last = performance.now();
  let fpsAcc = 0, fpsN = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);   // dt clampen (Tab-Rückkehr)
    last = now;
    try {
      if (sc) {
        const rendered = sc.tick(dt);     // Auto-Orbit + render (false = pausiert)
        if (rendered) {
          const camDist = sc.orbit.radius;              // Kamera-Abstand → Distanz-Scale + Zonen-Fade
          if (nodes) nodes.tick(dt, camDist);
          if (flows) flows.tick(dt);
          if (streams) streams.tick(dt);
          if (zonesViz) zonesViz.tick(camDist);
        }
      }
      carousel.tick(dt);
      // FPS mitteln (nur fürs Overlay).
      if (debugOverlay.enabled) {
        fpsAcc += dt; fpsN++;
        if (fpsAcc >= 0.5) { debugOverlay.setFps(fpsN / fpsAcc); fpsAcc = 0; fpsN = 0;
          debugOverlay.setFlows(flows ? flows.spawned() : 0);     // kumulative Bursts
          debugOverlay.setParticles(flows ? flows.alive() : 0);   // jetzt lebend
          if (flows) { debugOverlay.setExtra('ambient', flows.ambient());
            debugOverlay.setExtra('skipped', flows.skipped()); } }
      }
      // tick() IMMER (auch wenn aus) → regelt Sichtbarkeit selbst, versteckt bei Toggle-off.
      debugOverlay.tick(now);
    } catch (e) {
      // letzte Verteidigungslinie: Frame-Fehler loggen, Loop läuft weiter.
      l.error('Frame-Fehler (Loop lebt weiter):', e.message);
    }
  }
  requestAnimationFrame(frame);

  l.info('AOS-1 Observatory bereit', debugOverlay.enabled ? '(debug)' : '');
}

// DOM bereit? Sonst auf DOMContentLoaded warten.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
