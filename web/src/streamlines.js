// AOS-1 Observatory — src/streamlines.js
// Verantwortung: die KONTINUIERLiche Strom-Ebene — glühende, gerichtete Energie-"Adern"
// zwischen heißen Knoten (Vorbild Neuro.mov) + ein heller Portal-Ring am Memory-Hub.
// ERGÄNZT flows.js (THREE.Points-Bursts): die Partikel reißen zwischen Bursts ab, die
// Tube-Ader DARUNTER (renderOrder -1) füllt die Lücke mit stetigem Fluss.
//
// Prinzip (gespiegelt an flows.js, damit Ader & Partikel-Rail deckungsgleich sitzen):
//  - Je heißer Kante zwei parallele TubeGeometry-Adern: Token amber auf +LANE·perpA,
//    Daten cyan auf −LANE·perpA (exakt das LANE/perpA-System aus flows.js).
//  - EINE geteilte ShaderMaterial, additiv: scrollende Kämme (Kopf hell → Schweif dunkel,
//    weißer Spine), Helligkeit ∝ heat² (hot-konzentriert wie flows R1), bei 1.25 gekappt
//    → glüht, blüht aber bei ACES-exposure 0.95 nicht aus.
//  - Nur heiße Kanten (>0.05), Cap MAX_TUBES; Rebuild NUR wenn sich die aktive Menge
//    ändert (Positionen sind statisch), pro Frame nur 1 Uniform (uTime).
//
// WICHTIG (Live-Abnahme vs. Rezept): three.js TubeGeometry legt uv.x ENTLANG der Länge
// und uv.y um den QUERSCHNITT — umgekehrt zur Rezept-Annahme. Der Shader nutzt daher
// vUv.x für Fluss/Richtung und vUv.y für den Spine-Kern.

import * as THREE from 'three';
import { hex0x, FLOW } from '../palette.js';
import { log } from './log.js';

const l = log.mod('streamlines');

const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);
const LANE = 0.40;          // identisch zu flows.js → Ader liegt unter der Partikel-Rail
const MAX_TUBES = 40;       // ≈ 20 heißeste Kanten × 2 Rails
const TUBULAR = 24, RADIUS = 0.06, RADSEG = 5;

// Weiche Radial-Glow-Textur (läuft zum Rand transparent aus → KEINE sichtbare Kreis-Kante;
// genau das unterscheidet den dezenten Warm-Glow vom entfernten grauen Ring).
function makeGlowTexture() {
  const s = 64;
  const cv = document.createElement('canvas'); cv.width = cv.height = s;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.4)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true;
  return tex;
}

const VERT = `
  attribute vec3 aColor;
  attribute float aHeat;
  attribute float aSpeed;
  attribute float aSeed;
  varying vec2 vUv; varying vec3 vCol; varying float vHeat; varying float vSpeed; varying float vSeed;
  void main() {
    vUv = uv; vCol = aColor; vHeat = aHeat; vSpeed = aSpeed; vSeed = aSeed;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

// uv.x = Länge (Quelle 0 → Ziel 1), uv.y = Querschnitt (0..1) — three.js-TubeGeometry-Layout.
const FRAG = `
  uniform float uTime; uniform float uExposureCap;
  varying vec2 vUv; varying vec3 vCol; varying float vHeat; varying float vSpeed; varying float vSeed;
  void main() {
    float repeat = 2.0 + vHeat * 4.0;                 // hotter = dichtere Kämme
    float flow   = fract(vUv.x * repeat - uTime * vSpeed + vSeed);  // Kämme Quelle→Ziel
    float crest  = pow(flow, 4.0);                    // scharfer Kopf, langer dunkler Schweif
    float head   = smoothstep(0.15, 1.0, vUv.x);      // zum Ziel hin heller (Richtung)
    float core   = sin(vUv.y * 3.14159265);           // Querschnitt-Mitte hell → weißer Spine
    float heat2  = vHeat * vHeat;                      // hot-konzentriert (wie flows R1)
    float base   = 0.06;                              // leise Ruhe-Ader, immer sichtbar
    float glow   = base + crest * heat2 * (0.45 + 0.55 * head);
    vec3  col    = vCol * glow * core;
    float white  = min(0.5, crest * core * heat2 * 0.6);   // weißer Spine, hart gekappt
    col += vec3(white);
    col  = min(col, vec3(uExposureCap));              // kein Ausblühen bei exposure 0.95
    gl_FragColor = vec4(col, 1.0);
  }`;

export function createStreamLines(scene, opts) {
  const center = (opts && opts.center) || new THREE.Vector3(0, 0, 0);

  const group = new THREE.Group(); group.renderOrder = -1;
  const tubeGroup = new THREE.Group();
  group.add(tubeGroup);
  scene.add(group);

  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uExposureCap: { value: 1.25 } },
    vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, depthTest: true, side: THREE.FrontSide,
  });

  // Dezenter WARMER Zentrums-Glow (amber, additiv, sehr niedrige Opacity): ein weicher
  // Radial-Schein am Memory-Hub statt des entfernten grauen Rings. Durch die auslaufende
  // Textur hat er KEINE Kreis-Kante → liest als Energie-Kern, nicht als „grauer Kreis".
  const haloTex = makeGlowTexture();
  const haloMat = new THREE.SpriteMaterial({
    map: haloTex, color: hex0x(FLOW.tokens), transparent: true, opacity: 0.14,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const halo = new THREE.Sprite(haloMat);
  halo.scale.set(6.5, 6.5, 1); halo.position.copy(center); halo.renderOrder = -2;
  group.add(halo);

  // Tube-Register: id → { mesh, geo, aHeat, aSpeed, n }
  let tubes = [];
  let activeSig = '';
  let getPos = null;
  // Tube-Ebene AUS (User-Wunsch): nur die filigranen Partikel-Ströme (flows.js) sollen zu sehen
  // sein, nicht die groben Tubes. Der warme Portal-Glow (Halo) bleibt — er ist kein Strom.
  let tubesVisible = false;

  // temp-Vektoren (keine Allokation pro Frame/Build)
  const _dir = new THREE.Vector3(), _perpA = new THREE.Vector3(), _off = new THREE.Vector3();
  const _f = new THREE.Vector3(), _t = new THREE.Vector3(), _mid = new THREE.Vector3();
  const _bow = new THREE.Vector3(), _ctrl = new THREE.Vector3();

  function disposeTubes() {
    for (const tb of tubes) { tubeGroup.remove(tb.mesh); tb.geo.dispose(); }
    tubes = [];
  }

  // Eine Ader (ein Rail einer Kante) als TubeGeometry entlang einer leichten Bezier-Kurve.
  function buildRail(from, to, color, metric, seed) {
    _dir.subVectors(to, from);
    const len = _dir.length();
    if (len < 1e-3) return null;
    _dir.normalize();
    const ref = Math.abs(_dir.dot(UP)) > 0.95 ? RIGHT : UP;
    _perpA.crossVectors(_dir, ref).normalize();
    const lane = metric === 'bytes' ? -LANE : LANE;
    _off.copy(_perpA).multiplyScalar(lane);
    _f.copy(from).add(_off); _t.copy(to).add(_off);
    _mid.copy(_f).add(_t).multiplyScalar(0.5);
    // Bogen leicht NACH AUSSEN (weg vom Portal) + minimaler Auftrieb aus der Scheibe.
    _bow.copy(_mid).sub(center);
    if (_bow.lengthSq() < 1e-6) _bow.copy(_perpA);
    _bow.normalize().multiplyScalar(len * 0.10);
    _ctrl.copy(_mid).add(_bow); _ctrl.y += len * 0.04;
    const curve = new THREE.QuadraticBezierCurve3(_f.clone(), _ctrl.clone(), _t.clone());
    const geo = new THREE.TubeGeometry(curve, TUBULAR, RADIUS, RADSEG, false);
    const n = geo.attributes.position.count;
    const aColor = new Float32Array(n * 3), aHeat = new Float32Array(n);
    const aSpeed = new Float32Array(n), aSeed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      aColor[i * 3] = color.r; aColor[i * 3 + 1] = color.g; aColor[i * 3 + 2] = color.b;
      aSeed[i] = seed;
    }
    geo.setAttribute('aColor', new THREE.BufferAttribute(aColor, 3));
    const hAttr = new THREE.BufferAttribute(aHeat, 1); hAttr.setUsage(THREE.DynamicDrawUsage);
    const sAttr = new THREE.BufferAttribute(aSpeed, 1); sAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aHeat', hAttr);
    geo.setAttribute('aSpeed', sAttr);
    geo.setAttribute('aSeed', new THREE.BufferAttribute(aSeed, 1));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false; mesh.renderOrder = -1;
    tubeGroup.add(mesh);
    return { mesh, geo, aHeat: hAttr, aSpeed: sAttr, n };
  }

  // getPosition aus main.js merken (Positionen sind statisch → Build nur bei Mengen-Wechsel).
  function rebuild(_edges, getPosition) { if (typeof getPosition === 'function') getPos = getPosition; }

  const amber = new THREE.Color(hex0x(FLOW.tokens));
  const cyan = new THREE.Color(hex0x(FLOW.bytes));

  // heiße Rails bestimmen, bei Mengen-Wechsel Geometrie neu bauen, sonst nur heat/speed updaten.
  function setActive(edges, tokenHeatOf, byteHeatOf) {
    try {
      if (!tubesVisible) { if (tubes.length) disposeTubes(); activeSig = ''; return; }  // Tubes aus → nichts bauen
      if (!getPos) return;
      const heatOf = (fn, id) => (typeof fn === 'function' ? Math.max(0, Math.min(1, Number(fn(id)) || 0)) : 0);
      const edgeHeat = (e, fn) => Math.max(heatOf(fn, e.source), heatOf(fn, e.target));
      // Kandidaten-Rails sammeln (beide Metriken je Kante)
      const rails = [];
      for (const e of edges || []) {
        if (!e || !e.source || !e.target) continue;
        const th = edgeHeat(e, tokenHeatOf), bh = edgeHeat(e, byteHeatOf);
        const key = e.source + '>' + e.target;
        if (th > 0.05) rails.push({ key: key + '|t', metric: 'tokens', heat: th, color: amber, src: e.source, dst: e.target });
        if (bh > 0.05) rails.push({ key: key + '|b', metric: 'bytes', heat: bh, color: cyan, src: e.source, dst: e.target });
      }
      rails.sort((a, b) => b.heat - a.heat);
      const chosen = rails.slice(0, MAX_TUBES);
      const sig = chosen.map((r) => r.key).sort().join(',');

      if (sig !== activeSig) {
        // Menge hat sich geändert → Geometrie neu bauen (mit aktuellen, statischen Positionen).
        disposeTubes();
        for (const r of chosen) {
          const a = getPos(r.src), b = getPos(r.dst);
          if (!a || !b) continue;
          const tb = buildRail(a, b, r.color, r.metric, Math.random());
          if (tb) { tb.key = r.key; tb.metric = r.metric; tubes.push(tb); }
        }
        activeSig = sig;
      }
      // heat/speed je Tube aktualisieren (auch ohne Rebuild — Werte ändern sich laufend).
      const byKey = new Map(chosen.map((r) => [r.key, r.heat]));
      for (const tb of tubes) {
        const h = byKey.get(tb.key) || 0;
        const sp = (0.35 + h * 0.9) * (tb.metric === 'bytes' ? 1.4 : 1.0);
        const ha = tb.aHeat.array, sa = tb.aSpeed.array;
        for (let i = 0; i < tb.n; i++) { ha[i] = h; sa[i] = sp; }
        tb.aHeat.needsUpdate = true; tb.aSpeed.needsUpdate = true;
      }
    } catch (e) {
      l.warn('setActive übersprungen:', e.message);
    }
  }

  function tick(dt) {
    try {
      const u = (mat.uniforms.uTime.value += dt);   // pro Frame nur das Zeit-Uniform (Adern scrollen)
      haloMat.opacity = 0.11 + 0.04 * Math.sin(u * 1.2);   // sehr sanfter Warm-Puls (0.07..0.15)
    } catch (e) { l.warn('tick:', e.message); }
  }

  l.info('Strom-Wellen-Ebene montiert (Portal + Adern)');
  return {
    rebuild, setActive, tick,
    setVisible: (b) => { group.visible = !!b; },
    setTubesVisible: (b) => { tubesVisible = !!b; if (!tubesVisible) disposeTubes(); activeSig = ''; },
    tubeCount: () => tubes.length,
    destroy() {
      disposeTubes();
      haloTex.dispose(); haloMat.dispose();
      mat.dispose(); scene.remove(group);
    },
  };
}
