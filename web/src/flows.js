// AOS-1 Observatory — src/flows.js
// Verantwortung: die FLÜCHTIGE Schicht — die Partikel-DATENSTRÖME, der visuelle
// Held des Dashboards (Vorbild: Neuro.mov). Ein Strom zeigt Aktivität entlang einer
// Kante: actor→target bei Events, source→target dauerhaft auf aktiven Topologie-Kanten.
//
// Lesbarkeits-Regeln (Design-Arbeitskreis — gegen "diffuser Staub"):
//  R1 HOT-KONZENTRATION: Ambient-Rate ∝ heat² → wenige DICKE Flüsse statt Flächen-Staub.
//  R2 SANDUHR-FÄCHER: zwei Ströme mit festem Rail-Versatz (±LANE·perpA, ±LANE_B·perpB) und
//     einer Quer-Streuung, die mit sin(π·t) atmet — tight rope an den Knoten, dichter
//     gefiederter Fächer mittig; warm-weißer Kern aus Nähe zur Rail-Mitte → Referenz-Signatur.
//  R3 TOKEN vs DATA über DREI Kanäle (nicht nur Farbe, CVD-sicher):
//     - Farbe: token amber / data cyan
//     - Bahn (Position): feste Hälften ±0.40·perpA + ±0.10·perpB → nie voll überlagert
//     - Bewegung: data sparser (×0.6) + schneller (×1.4) → an Tempo+Lane unterscheidbar
//  RICHTUNG: Helligkeit an BEIDEN Knoten hell (tight rope), mittig gedämpft; leichte Kopf-
//     Gewichtung erhält den lesbaren Fluss-Vektor (actor→target).
//
// Umsetzung: EIN THREE.Points-Pool (additive Glow-Textur), per-Partikel Farbe/Helligkeit
// über Vertex-Colors, Ring-Cursor statt Alive-Suche. Jede Methode fail-open (try/catch).

import * as THREE from 'three';
import { flowColor, hex0x, FLOW } from '../palette.js';
import { log } from './log.js';

const l = log.mod('flows');

const MAX = 12000;         // Pool-Obergrenze (war 16000) — Dichte-Überschuss zurück, weniger Überlagerung
const LIFE = 2.1;          // Sekunden actor→target (war 1.7) — etwas länger → mehr Partikel gleichzeitig
                           // lebendig = dichterer STEHENDER Fluss, sanftere Bewegung (nicht „schnell geschossen")
const BASE_SIZE = 0.15;    // feiner (war 0.21) → seidiger Fluss wie Neuro.mov statt grobe Körner;
                           // der additive Glow hält die Punkte trotzdem präsent, Dichte liest als Strom
// SANDUHR-FÄCHER statt Rechteck-Band: fester Rail-Versatz (±LANE·perpA, ±LANE_B·perpB) +
// eine Quer-Streuung, die über die Länge mit sin(π·t) atmet — NULL an beiden Knoten (tight
// rope), MAX in der Kantenmitte (dichter gefiederter Sprüh). Streuung zentrumsgewichtet
// (Mittel aus 3 Uniformen → heller Kern, dünne Ausläufer), NICHT flach (= Staub).
const LANE = 0.26;         // Quer-Versatz der Rail entlang perpA (Token +, Daten −) — enger gepackt (war 0.40),
                           // damit ein DÜNNER Glas-Schlauch (tubes.js) beide Rails eng umschließen kann
const LANE_B = 0.10;       // zweiter Trenn-Versatz entlang perpB → Rails überlagern aus keinem Winkel voll
const MAX_SPREAD = 0.14;   // max. Fächer-Halbbreite quer (perpA) in der Mitte (war 0.20) — engeres Bündel,
                           // damit der Glas-Schlauch dicht herum sitzt (eng-herum-Wunsch); Envelope ~0.40
const MAX_SPREAD_B = 0.15; // max. Fächer-Halbhöhe (perpB) (war 0.22) — flacherer Ribbon-Fächer → gerichteter Fluss statt Volumen-Staub
const CORE_WHITE = 1.3;    // Kern-Boost nahe der Rail-Mitte (war 2.2 + neutral-weiß = wusch alles weiß);
                           // jetzt hue-erhaltend → verstärkt Gold/Cyan statt zu entfärben
const AMBIENT_RATE = 15;   // Partikel/s je Kante bei heat=1 (Enterprise-Tuning 2026-10-28: war 32) — gebändigt:
                           // gerichtete, ruhige Dauer-Flüsse statt horizontaler Laser-Explosion
const AMBIENT_CAP = 55;    // max. Ambient-Spawns pro Frame (war 120) — deckelt die Gesamt-Dichte hart
// STRUKTUR-HEBEL (Neuro.mov = wenige, getrennte Seile): nur Kanten mit ECHTER Hitze streamen.
// Enterprise-Tuning: Gate deutlich höher (war 0.28) → nur die paar HEISSESTEN Kanten streamen,
// viel ruhiges Schwarz dazwischen = kontrolliert, nicht reizüberflutet. Dial: höher = strenger/leerer.
const HEAT_GATE = 0.46;

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

// Zentrumsgewichtete Streuung in [-1,1]: Mittel aus 3 Uniformen ≈ Glocken-/Dreiecks-
// Verteilung → Masse nahe 0 (heller dichter Kern), dünne gefiederte Ausläufer. Bewusst
// KEINE breite rohe Gauß-Streuung (das war der abgelehnte „Staub"-Look).
function centerBiased() {
  return ((Math.random() + Math.random() + Math.random()) / 3 - 0.5) * 2;
}

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
  points.renderOrder = 1;   // NACH der Glas-Hülle (tubes.js, renderOrder 0) → Partikel leuchten DURCHS Glas
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
    // Normierte, zentrumsgewichtete Fächer-Faktoren in [-1,1] (einmal je Partikel, KEIN
    // Per-Frame-Jitter) — die Längs-Atmung via sin(π·t) kommt erst beim Rendern dazu.
    p.wA = centerBiased();   // quer (perpA): Fächer-Faktor, hält die Rails zentriert/getrennt
    p.wB = centerBiased();   // hoch (perpB): Fächer-Faktor, gibt dem Sprüh Volumen
  }

  // Dichte-Mapping Event: Magnitude → Partikelzahl + Grundhelligkeit (log-skaliert).
  function burstSize(ev) {
    const metric = ev.metric === 'bytes' ? 'bytes' : 'tokens';
    const raw = metric === 'bytes' ? Number(ev.bytes) : Number(ev.tokens);
    const mag = Number.isFinite(raw) && raw > 0 ? raw : 0;
    // DICHTE wie Neuro.mov: mehr Partikel pro Burst (war 48..200) → der über die ganze Kante
    // gestaffelte Strom wird ein DICHTES Seil statt vereinzelter Sternchen. Enger Fächer hält
    // die Mehrmenge gebündelt (= Dichte), nicht breit (= Staub).
    let count = Math.max(40, Math.min(150, Math.round(48 + Math.log10(1 + mag) * 40)));
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
      // SEIL statt GESCHOSS: die Start-t über eine VOLLE Kantenlänge staffeln (Spanne 1.0,
      // war 0.5). So besetzt der Burst im Peak die GANZE Strecke gleichzeitig = durchgehendes
      // Seil, das sich füllt und wieder leert — statt ein Klumpen, der als Projektil A→B wandert
      // („eine Seite schießt auf die andere"). Geschwindigkeits-Varianz verschmiert zusätzlich.
      for (let n = 0; n < count; n++) emit(a, b, col, bright, -(n / count) * 1.0, metric);
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
        if (th < HEAT_GATE && bh < HEAT_GATE) continue;   // nur echte Hitze streamt → wenige getrennte Seile
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
      // Kernposition = lerp(from→to) (gerade Bahn beibehalten). Fester Rail-Versatz
      // (±LANE·perpA, ±LANE_B·perpB) bleibt über die ganze Länge konstant → die zwei Kanäle
      // (Token +perpA / Daten −perpA) trennen durchgängig.
      _v.lerpVectors(p.from, p.to, p.t);
      // SANDUHR-FÄCHER: Bell-Hüllkurve sin(π·t) ist 0 an beiden Knoten, 1 in der Mitte.
      // Quer-Streuung = Fächer-Faktor × MAX_SPREAD × bell → schmaler Strang an BEIDEN Enden,
      // dichter gefiederter Sprüh zur Kantenmitte. Faktor ist zentrumsgewichtet (heller Kern).
      const bell = Math.sin(p.t * Math.PI);
      const ax = p.lane * LANE + p.wA * MAX_SPREAD * bell;
      const bx = p.lane * LANE_B + p.wB * MAX_SPREAD_B * bell;
      const px = _v.x + p.perpA.x * ax + p.perpB.x * bx;
      const py = _v.y + p.perpA.y * ax + p.perpB.y * bx;
      const pz = _v.z + p.perpA.z * ax + p.perpB.z * bx;
      // Helligkeit END-KONZENTRIERT: (1−bell) ist an BEIDEN Knoten max, mittig gedämpft →
      // helle tight rope an den Enden, weicher Fächer in der Mitte. Leichte Kopf-Gewichtung
      // (dir) erhält die Richtungs-Lesbarkeit. (Punkt-Größe ist global in PointsMaterial; der
      // additive Glow lässt die hellen End-Punkte optisch größer blühen = „tighter rope".)
      const ends = 1 - bell;
      const dir = 0.85 + 0.30 * (p.t * p.t * (3 - 2 * p.t));   // smoothstep → sanfter Kopf-Bias
      const b = p.bright * (0.75 + 0.70 * ends) * dir;   // heller gesamt + hellere Mitte (Fächer leuchtet)
      // Warm-weißer Kern: nahe der Rail-Mitte (|wA| klein) → additiver Boost, warm gewichtet
      // (R>G>B) → Kern liest weiß-heiß-zu-gold, Fächer-Ränder behalten Amber/Cyan-Tint (CVD-sicher).
      const core = 1 - Math.min(1, Math.abs(p.wA));
      // HUE-ERHALTEND: der Kern-Boost verstärkt die EIGENE Farbe (Gold bleibt Gold, Cyan
      // bleibt Cyan) statt neutrales Weiß draufzulegen (das wusch alles zu Weiß). Nur ein
      // kleiner warmer Weiß-Anteil (0.16, R>G>B) gibt den heiß-glühenden Kern. → Neuro-Gold-Fächer.
      const wb = b * core * core * CORE_WHITE;
      const warm = wb * 0.16;
      const cr = p.col.r * (b + wb) + warm;
      const cg = p.col.g * (b + wb) + warm * 0.86;
      const cb = p.col.b * (b + wb) + warm * 0.55;
      // HÄRTEN: jeder geschriebene Wert endlich — sonst Partikel überspringen (nie den Draw brechen).
      if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz) ||
          !Number.isFinite(cr) || !Number.isFinite(cg) || !Number.isFinite(cb)) continue;
      const o = write * 3;
      posAttr[o]     = px;
      posAttr[o + 1] = py;
      posAttr[o + 2] = pz;
      colAttr[o]     = cr;
      colAttr[o + 1] = cg;
      colAttr[o + 2] = cb;
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
