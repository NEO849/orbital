// AOS-1 Observatory — src/flows.js
// Verantwortung: die FLÜCHTIGE Schicht — die Partikel-DATENSTRÖME, der visuelle
// Held des Dashboards (Vorbild: Neuro.mov). Ein Strom zeigt Aktivität entlang einer
// Kante: actor→target bei Events, source→target dauerhaft auf aktiven Topologie-Kanten.
//
// Lesbarkeits-Regeln (Design-Arbeitskreis — gegen "diffuser Staub"):
//  R1 HOT-KONZENTRATION: Ambient-Rate ∝ heat² → wenige DICKE Flüsse statt Flächen-Staub.
//  R2 GEORDNETE RIBBONS: zwei flache Bänder mit Rechteck-Querschnitt (BAND_W×BAND_H),
//     feste Hälften (±LANE·perpA, ±LANE_B·perpB) → Dichte liest als Partikel-pro-Länge;
//     weißer Spine je Band aus Nähe zur Band-Mittellinie (|wA|) → Referenz-Signatur.
//  R3 TOKEN vs DATA über DREI Kanäle (nicht nur Farbe, CVD-sicher):
//     - Farbe: token amber / data cyan
//     - Bahn (Position): feste Hälften ±0.40·perpA + ±0.10·perpB → nie voll überlagert
//     - Bewegung: data sparser (×0.6) + schneller (×1.4) → an Tempo+Lane unterscheidbar
//  RICHTUNG: Helligkeit kopf-gewichtet (heller am Ziel-Ende) → das Auge liest den Fluss-Vektor.
//
// Umsetzung: EIN THREE.Points-Pool (additive Glow-Textur), per-Partikel Farbe/Helligkeit
// über Vertex-Colors, Ring-Cursor statt Alive-Suche. Jede Methode fail-open (try/catch).

import * as THREE from 'three';
import { flowColor, hex0x, FLOW } from '../palette.js';
import { log } from './log.js';

const l = log.mod('flows');

const MAX = 11000;         // Pool-Obergrenze — GPU-Points tragen das; Wucht aus Menge
const LIFE = 1.7;          // Sekunden actor→target (lesbare Spur, aber zügig → Richtung sichtbar)
const BASE_SIZE = 0.19;    // kleine Punkte — Wirkung aus Dichte, nicht Blob-Größe
// Zwei GEORDNETE Ribbons statt Sprüh-Kegel: feste Hälften der Verbindung + Rechteck-
// Querschnitt (konstant, keine runde Bell über die Breite) → Dichte liest als Partikel-
// pro-Länge. Token = +perpA-Hälfte, Daten = −perpA-Hälfte; zusätzlicher perpB-Versatz.
const LANE = 0.40;         // Quer-Versatz der Rail entlang perpA (Token +, Daten −) — klarer Gap
const LANE_B = 0.10;       // zweiter Trenn-Versatz entlang perpB → Bänder überlagern aus keinem Winkel voll
const BAND_W = 0.14;       // Band-Dicke quer (perpA) — dünnes Ribbon, Bänder bleiben getrennt
const BAND_H = 0.50;       // Band-Höhe (perpB) — Sheet-Volumen bei konstantem Querschnitt
const AMBIENT_RATE = 26;   // Partikel/s je Kante bei heat=1 (Rate ∝ heat² → hot-konzentriert)
const AMBIENT_CAP = 90;    // max. Ambient-Spawns pro Frame

// Runde, weich auslaufende Glow-Textur (einmal gebaut, geteilt).
function makeGlowTexture() {
  const s = 64;
  const cv = document.createElement('canvas'); cv.width = cv.height = s;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.6)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true;
  return tex;
}

const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);

export function createFlows(scene, getPosition) {
  // Partikel-Zustand in JS; perpA/perpB = orthonormale Basis quer zur Kante,
  // theta/rad = Streuung im Querschnitt, lane = +1 token-Rail / −1 data-Rail.
  const part = new Array(MAX);
  for (let i = 0; i < MAX; i++) part[i] = {
    alive: false, t: 0, speed: 0, bright: 1, lane: 1,
    from: new THREE.Vector3(), to: new THREE.Vector3(), col: new THREE.Color(),
    perpA: new THREE.Vector3(), perpB: new THREE.Vector3(), wA: 0, wB: 0,
  };
  let cursor = 0;

  // Instrumentierung (Fehler-Management): Skips sind EREIGNISSE, keine Stille.
  let spawnedTotal = 0, ambientTotal = 0, skippedNoPos = 0, lastSkipLog = 0;

  const posAttr = new Float32Array(MAX * 3);
  const colAttr = new Float32Array(MAX * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(posAttr, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colAttr, 3));
  geo.setDrawRange(0, 0);

  const mat = new THREE.PointsMaterial({
    size: BASE_SIZE, map: makeGlowTexture(), vertexColors: true,
    transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, sizeAttenuation: true,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  scene.add(points);

  let activeEdges = [];
  const _d = new THREE.Vector3();

  // Ein Partikel in einen Slot legen + Quer-Basis für Streuung/Rail berechnen.
  function emit(a, b, col, bright, t0, metric) {
    const i = cursor; cursor = (cursor + 1) % MAX;
    const p = part[i];
    p.alive = true;
    p.t = t0;
    const sp = (1 / LIFE) * (0.85 + Math.random() * 0.3);
    p.speed = metric === 'bytes' ? sp * 1.4 : sp;   // Daten schneller → an Tempo erkennbar
    p.bright = bright;
    p.lane = metric === 'bytes' ? -1 : 1;           // Daten-Rail links, Token-Rail rechts
    p.from.copy(a); p.to.copy(b);
    p.col.copy(col);
    _d.subVectors(b, a);
    if (_d.lengthSq() < 1e-9) { p.perpA.set(1, 0, 0); p.perpB.set(0, 0, 1); }
    else {
      _d.normalize();
      const ref = Math.abs(_d.dot(UP)) > 0.95 ? RIGHT : UP;
      p.perpA.crossVectors(_d, ref).normalize();
      p.perpB.crossVectors(_d, p.perpA).normalize();
    }
    // Rechteck-Querschnitt (gleichverteilt, keine Bell über die Breite) → Dichte = Partikel/Länge.
    p.wA = (Math.random() - 0.5) * BAND_W;   // quer (perpA): dünn, hält die Bänder getrennt
    p.wB = (Math.random() - 0.5) * BAND_H;   // hoch (perpB): gibt dem Band Sheet-Volumen
  }

  // Dichte-Mapping Event: Magnitude → Partikelzahl + Grundhelligkeit (log-skaliert).
  function burstSize(ev) {
    const metric = ev.metric === 'bytes' ? 'bytes' : 'tokens';
    const raw = metric === 'bytes' ? Number(ev.bytes) : Number(ev.tokens);
    const mag = Number.isFinite(raw) && raw > 0 ? raw : 0;
    let count = Math.max(28, Math.min(120, Math.round(34 + Math.log10(1 + mag) * 22)));
    if (metric === 'bytes') count = Math.round(count * 0.6);   // Daten sparser → an Dichte erkennbar
    const bright = 0.9 + Math.min(1, Math.log10(1 + mag) / 5) * 0.8;
    return { metric, count, bright };
  }

  // Ein Event → ein heller, dichter, gerichteter Burst. Nie werfen.
  function spawn(ev) {
    try {
      if (!ev || !ev.actor || !ev.target) return;
      const a = getPosition(ev.actor), b = getPosition(ev.target);
      if (!a || !b) {
        skippedNoPos++;
        const now = performance.now();
        if (now - lastSkipLog > 2000) {
          l.debug('Event übersprungen — Knoten (noch) ohne Position:', !a ? ev.actor : ev.target);
          lastSkipLog = now;
        }
        return;
      }
      const { metric, count, bright } = burstSize(ev);
      const col = new THREE.Color(hex0x(flowColor(metric)));
      for (let n = 0; n < count; n++) emit(a, b, col, bright, -(n / count) * 0.5, metric);
      spawnedTotal++;
    } catch (e) {
      l.warn('spawn übersprungen (kaputtes Event):', e.message);
    }
  }

  // Kanten-Heat = max(Heat beider Endknoten), 0..1. heatOf fehlt/kein-fn → 0.
  function edgeHeat(e, heatOf) {
    if (typeof heatOf !== 'function') return 0;
    const hs = Math.max(0, Math.min(1, Number(heatOf(e.source)) || 0));
    const ht = Math.max(0, Math.min(1, Number(heatOf(e.target)) || 0));
    return Math.max(hs, ht);
  }

  // Aktive Topologie-Kanten setzen (aus onState). BEIDE Metriken, jede in ihre Rail:
  // tokenHeatOf → amber-Rail (+perpA), byteHeatOf → cyan-Rail (−perpA). Rate ∝ heat².
  // So zeigt eine token-lastige Kante ein fettes amber + dünnes cyan Band = Metrik-Mix.
  function setActive(edges, tokenHeatOf, byteHeatOf) {
    try {
      const next = [];
      const amber = new THREE.Color(hex0x(FLOW.tokens));
      const cyan = new THREE.Color(hex0x(FLOW.bytes));
      for (const e of edges || []) {
        if (!e || !e.source || !e.target) continue;
        const th = edgeHeat(e, tokenHeatOf);
        const bh = edgeHeat(e, byteHeatOf);
        if (th <= 0.05 && bh <= 0.05) continue;
        const a = getPosition(e.source), b = getPosition(e.target);
        if (!a || !b) continue;
        next.push({
          from: a.clone(), to: b.clone(),
          colTok: amber.clone(), colByte: cyan.clone(),
          rateTok: AMBIENT_RATE * th * th, rateByte: AMBIENT_RATE * bh * bh,
          accTok: Math.random(), accByte: Math.random(),
        });
      }
      activeEdges = next;
    } catch (e) {
      l.warn('setActive übersprungen:', e.message);
      activeEdges = [];
    }
  }

  const _v = new THREE.Vector3();
  let aliveCount = 0;

  // je Frame: (1) Dauer-Emission auf aktiven Kanten, (2) Partikel vorrücken + Buffer.
  function tick(dt) {
    try {
      let budget = AMBIENT_CAP;
      for (const edge of activeEdges) {
        // Token-Rail (+perpA)
        edge.accTok += edge.rateTok * dt;
        while (edge.accTok >= 1 && budget > 0) {
          edge.accTok -= 1; budget--;
          emit(edge.from, edge.to, edge.colTok, 0.55, -Math.random() * 0.4, 'tokens');
          ambientTotal++;
        }
        // Daten-Rail (−perpA) — leer solange kein byteHeat vom Backend kommt
        edge.accByte += edge.rateByte * dt;
        while (edge.accByte >= 1 && budget > 0) {
          edge.accByte -= 1; budget--;
          emit(edge.from, edge.to, edge.colByte, 0.55, -Math.random() * 0.4, 'bytes');
          ambientTotal++;
        }
        if (budget <= 0) break;
      }
    } catch (e) { l.warn('ambient-emit:', e.message); }

    let write = 0;
    for (let i = 0; i < MAX; i++) {
      const p = part[i];
      if (!p.alive) continue;
      p.t += p.speed * dt;
      if (p.t >= 1) { p.alive = false; continue; }
      if (p.t < 0) continue;
      // Kernposition = lerp(from→to). Feste Rail-Hälfte (±LANE·perpA, ±LANE_B·perpB) bleibt
      // über die ganze Länge konstant → die beiden Bänder trennen durchgängig. Nur die
      // Band-EIGENbreite (wA/wB) tapert längs (bell) → saubere Enden, konstanter Querschnitt.
      _v.lerpVectors(p.from, p.to, p.t);
      const bell = Math.sin(p.t * Math.PI);
      const ax = p.lane * LANE + p.wA * bell;
      const bx = p.lane * LANE_B + p.wB * bell;
      const o = write * 3;
      posAttr[o]     = _v.x + p.perpA.x * ax + p.perpB.x * bx;
      posAttr[o + 1] = _v.y + p.perpA.y * ax + p.perpB.y * bx;
      posAttr[o + 2] = _v.z + p.perpA.z * ax + p.perpB.z * bx;
      // Helligkeit KOPF-GEWICHTET (heller am Ziel) → Richtung sichtbar.
      const s = p.t * p.t * (3 - 2 * p.t);           // smoothstep(t)
      const b = p.bright * (0.25 + 0.75 * s);
      // Weißer Spine PRO BAND: Nähe zur Band-Mittellinie (|wA| klein) → additiver Weiß-Boost
      // → jedes Ribbon hat seinen eigenen hellen Kern (Referenz-Signatur, je Metrik).
      const core = 1 - Math.min(1, Math.abs(p.wA) / (BAND_W * 0.5));
      const wb = b * core * core * core * 1.3;
      colAttr[o]     = p.col.r * b + wb;
      colAttr[o + 1] = p.col.g * b + wb;
      colAttr[o + 2] = p.col.b * b + wb;
      write++;
    }
    aliveCount = write;
    geo.setDrawRange(0, write);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }

  return {
    spawn,
    setActive,
    tick,
    alive: () => aliveCount,
    spawned: () => spawnedTotal,
    ambient: () => ambientTotal,
    skipped: () => skippedNoPos,
    destroy() { scene.remove(points); geo.dispose(); mat.map.dispose(); mat.dispose(); },
  };
}
