// AOS-1 Observatory — src/tubes.js
// Verantwortung: die GLAS-SCHLAUCH-Ebene — pro AKTIVER Kante EIN transparenter, grüner
// 3D-Schlauch (Fresnel-Glas) ZENTRIERT auf der Kanten-Achse, ENG um das Partikel-Bündel.
// Die Gold/Cyan-Partikel aus flows.js fließen INNEN hindurch (sichtbar durchs Glas).
// „Wasserschlauch, aber statt Wasser unsere beiden Ströme." User-Wunsch 2026-10-26.
//
// AKTIVITÄTS-GETRIEBEN (User: „nur da wo wirklich die Ströme angezeigt werden"):
//  Ein Schlauch erscheint auf einer Kante, wenn dort WIRKLICH etwas fließt —
//   (a) Dauerfluss: Kanten-Heat ≥ HEAT_GATE (= flows.js-Ambient-Gate), ODER
//   (b) Event-Burst: ein Event actor→target innerhalb der letzten DWELL_MS (vom Event-Strom).
//  DWELL (Nachlauf) hält den Schlauch nach dem letzten Burst kurz stehen → KEIN Flackern,
//  und er verschwindet erst, wenn dort wirklich nichts mehr fließt.
//
// Glas OHNE transmission (recherche-gehärtet gg. three.js r186): MeshPhysicalMaterial.transmission
//  bricht nur den OPAKEN Buffer → transparente Partikel erschienen GAR NICHT im Glas, bei vollem
//  Extra-Pass/Frame. Stattdessen Fresnel-ShaderMaterial (View-Space): Rand leuchtet (Silhouette +
//  Innenwand via abs(dot)), Mitte durchsichtig → runde, hohle 3D-Röhre. 0 Extra-Pässe → 60fps.
//
// Sortierung: Hülle renderOrder 0, Partikel (flows.js THREE.Points) renderOrder 1 → Partikel
//  leuchten DURCHS Glas. Zero-Churn: EIN geteilter offener Einheits-Zylinder, pro Kante nur
//  Transform (Position + Quaternion + Scale), Meshes gepoolt (zeigen/verstecken).

import * as THREE from 'three';
import { BASE } from '../palette.js';
import { log } from './log.js';

const l = log.mod('tubes');

const RADIUS = 0.40;        // ENG um das gepackte Rail-Bündel (flows LANE 0.26 + Fächer 0.14 ≈ 0.40)
const HEAT_GATE = 0.28;     // Dauerfluss-Gate = flows.js → Schlauch wo stetig geströmt wird
const MAX_TUBES = 16;       // Pool/Deckel — dünne Arterien, kein Tangle
const DWELL_MS = 2000;      // Nachlauf nach letztem Burst → Schlauch bleibt kurz stehen (Anti-Flacker)
const RECOMPUTE_MS = 180;   // Aktiv-Set-Neubewertung zwischen State-Updates (damit Bursts prompt greifen)

const VERT = `
  varying vec3 vViewNormal;
  varying vec3 vViewPos;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vViewNormal = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vViewPos = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }`;

const FRAG = `
  precision highp float;
  uniform vec3  uColor;         // neutrales Glas (dunkel, aus Palette) — kein Farb-Clash
  uniform vec3  uRimColor;      // dezenter Rand-Schimmer
  uniform vec3  uCoreColor;     // Farbe des wandernden Licht-Pulses (weißglühend)
  uniform float uPower;
  uniform float uRimStrength;
  uniform float uCoreStrength;
  uniform float uBodyAlpha;
  uniform float uTime;
  varying vec3 vViewNormal;
  varying vec3 vViewPos;
  varying vec2 vUv;
  void main() {
    vec3 N = normalize(vViewNormal);
    vec3 V = normalize(-vViewPos);
    float fres = pow(1.0 - abs(dot(N, V)), uPower);
    // Lichtwellenleiter: schmale, helle Pulse laufen ENTLANG der Achse durch den Leiter
    // (uv.y = Längsachse). Das trägt das "Licht fließt im Leiter"-Bild — dezent, nicht grell.
    float flow = pow(max(0.0, sin((vUv.y * 3.0 - uTime * 1.3) * 3.14159265)), 11.0);
    vec3  col   = uColor + uRimColor * fres * uRimStrength + uCoreColor * flow * uCoreStrength;
    float alpha = clamp(uBodyAlpha + fres * 0.20 + flow * 0.26, 0.0, 1.0);
    gl_FragColor = vec4(col, alpha);
    #include <colorspace_fragment>
  }`;

// Richtungs-unabhängiger Kanten-Schlüssel (Schlauch ist ungerichtet; Burst actor→target und
// Topologie source→target sollen dieselbe Kante treffen, egal wie herum gespeichert).
function normKey(a, b) { return a < b ? a + '\u0001' + b : b + '\u0001' + a; }

export function createTubes(scene, getPosition) {
  const group = new THREE.Group();
  scene.add(group);

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(BASE.zoneLine) },   // dunkles Graphit-Glas (Palette, neutral)
      uRimColor: { value: new THREE.Color(BASE.muted) },   // gedämpfter Rand-Schimmer
      uCoreColor: { value: new THREE.Color(BASE.white) },  // weißglühender Licht-Puls (Bloom-Ziel)
      uPower: { value: 2.6 },
      uRimStrength: { value: 0.22 },     // war 1.05 → Rand nur noch zart andeuten
      uCoreStrength: { value: 0.5 },     // dezenter Puls statt grellem Band
      uBodyAlpha: { value: 0.025 },      // Glas fast unsichtbar, nur der Puls trägt
      uTime: { value: 0 },
    },
    vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, blending: THREE.AdditiveBlending,   // additiv → leuchtet statt zu verdecken
    depthWrite: false, depthTest: true, side: THREE.DoubleSide,
  });

  const UNIT = new THREE.CylinderGeometry(1, 1, 1, 14, 1, true);
  UNIT.translate(0, 0.5, 0);

  const pool = [];
  for (let i = 0; i < MAX_TUBES; i++) {
    const m = new THREE.Mesh(UNIT, mat);
    m.frustumCulled = false; m.visible = false; m.renderOrder = 0;
    group.add(m); pool.push(m);
  }

  let activeSig = '';
  let visible = true;
  let getPos = typeof getPosition === 'function' ? getPosition : null;
  let _edges = [], _tokFn = null, _byteFn = null;   // letzter State (für Neubewertung zwischen Updates)
  const burstAt = new Map();   // normKey -> letzter Burst-Zeitpunkt (ms)
  let _acc = 0;                // Recompute-Throttle

  const _up = new THREE.Vector3(0, 1, 0), _dir = new THREE.Vector3(), _q = new THREE.Quaternion();

  function placeTube(mesh, a, b) {
    _dir.subVectors(b, a); const len = _dir.length();
    if (len < 1e-6) { mesh.visible = false; return; }
    _dir.normalize();
    mesh.position.copy(a);
    _q.setFromUnitVectors(_up, _dir); mesh.quaternion.copy(_q);
    mesh.scale.set(RADIUS, len, RADIUS);
    mesh.visible = true;
  }

  function hideFrom(i) { for (; i < pool.length; i++) pool[i].visible = false; }

  function edgeHeat(e, heatOf) {
    if (typeof heatOf !== 'function') return 0;
    const hs = Math.max(0, Math.min(1, Number(heatOf(e.source)) || 0));
    const ht = Math.max(0, Math.min(1, Number(heatOf(e.target)) || 0));
    return Math.max(hs, ht);
  }

  // Event-Strom (aus main.js onEvents): markiert die Kante actor→target als eben aktiv.
  function add(ev) {
    try {
      if (!ev || !ev.actor || !ev.target) return;
      burstAt.set(normKey(ev.actor, ev.target), Date.now());
    } catch (e) { /* fail-open */ }
  }

  // Aktiv-Set neu bestimmen: Dauerfluss (heat) ODER frischer Burst (dwell). Bei Mengen-Wechsel
  // die Pool-Meshes neu platzieren (sonst nichts — Positionen statisch).
  function recompute() {
    if (!visible || !getPos) { if (!visible) { hideFrom(0); activeSig = ''; } return; }
    const now = Date.now();
    // alte Bursts vergessen (Map klein halten)
    for (const [k, t] of burstAt) if (now - t > DWELL_MS) burstAt.delete(k);
    const chosen = [];
    for (const e of _edges) {
      if (!e || !e.source || !e.target) continue;
      const heat = Math.max(edgeHeat(e, _tokFn), edgeHeat(e, _byteFn));
      const bt = burstAt.get(normKey(e.source, e.target));
      const recency = bt ? Math.max(0, 1 - (now - bt) / DWELL_MS) : 0;   // 1 frisch … 0 abgelaufen
      if (heat < HEAT_GATE && recency <= 0) continue;                    // weder Dauerfluss noch Burst
      chosen.push({ key: e.source + '>' + e.target, src: e.source, dst: e.target, rank: Math.max(heat, recency) });
    }
    chosen.sort((a, b) => b.rank - a.rank);
    const top = chosen.slice(0, MAX_TUBES);
    const sig = top.map((r) => r.key).sort().join(',');
    if (sig === activeSig) return;
    let used = 0;
    for (const r of top) {
      const a = getPos(r.src), b = getPos(r.dst);
      if (!a || !b) continue;
      placeTube(pool[used], a, b); used++;
    }
    hideFrom(used);
    activeSig = sig;
  }

  function rebuild(_e, getPosition) { if (typeof getPosition === 'function') getPos = getPosition; }

  function setActive(edges, tokenHeatOf, byteHeatOf) {
    try {
      _edges = edges || []; _tokFn = tokenHeatOf; _byteFn = byteHeatOf;
      recompute();
    } catch (e) { l.warn('setActive übersprungen:', e.message); activeSig = ''; }
  }

  function tick(dt) {
    try {
      mat.uniforms.uTime.value += dt;
      _acc += dt;
      if (_acc >= RECOMPUTE_MS / 1000) { _acc = 0; recompute(); }   // Bursts prompt aufnehmen/auslaufen
    } catch (e) { l.warn('tick:', e.message); }
  }

  l.info('Glas-Schlauch-Ebene montiert (aktivitäts-getrieben, Pool', MAX_TUBES + ')');
  return {
    rebuild, setActive, add, tick,
    setVisible: (b) => { visible = !!b; group.visible = visible; if (!visible) { hideFrom(0); activeSig = ''; } },
    count: () => pool.filter((m) => m.visible).length,
    destroy() { UNIT.dispose(); mat.dispose(); scene.remove(group); },
  };
}
