// Orbital — src/zones.js
// Verantwortung: die Saturn-RING-Ebene — pro vorhandenem Typ eine feine Laser-Ring-Linie
// (die „Bahn", auf der die Knoten sitzen) + ein Orientierungs-Label je Ring („BRAIN"/
// „SESSIONS"/…). Macht „jeder Typ auf seinem Ring" selbsterklärend.
//
// Die Ring-Linie kommt aus layout.ringPath() — GLEICHE Formel wie die Knoten-Platzierung →
// die Linie läuft garantiert genau durch die Knoten des Typs. Feine additive Linie =
// Hausstil „feine Laser-Ringe" (Machined Graphite), kein dicker Deko-Reif.
//
// Vertrag: createZones(scene) → { group, rebuild(zones, counts), tick(camDist),
//          setVisible(bool), destroy() }. main.js ruft rebuild bei Entity-Typ-Diff.
// Label-Fade invers zum Zoom: fern = Labels an (Orientierung), nah = aus (Detail).

import * as THREE from 'three';
import { BASE, NODE } from '../palette.js';
import { ringPath } from './layout.js';
import { log } from './log.js';

const l = log.mod('zones');

// Ein Label je Ring (memory = „BRAIN", Betreiber-Wunsch). professor teilt die agent-Bahn →
// kein eigenes Label (Count fließt in AGENTEN).
const TEXT = {
  memory:   'BRAIN',
  session:  'SESSIONS',
  agent:    'AGENTEN',
  pipeline: 'PIPELINES',
  brett:    'BRETT',
  tool:     'TOOLS',
  server:   'SERVER',
};

// Schalen-Label als billboarded CanvasTexture-Sprite (mono, uppercase, gedämpft).
function makeLabel(text) {
  const W = 256, H = 64, dpr = 2;
  const cv = document.createElement('canvas');
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.textBaseline = 'middle';
  g.font = '600 26px ui-monospace,Menlo,Consolas,monospace';
  g.shadowColor = 'rgba(0,0,0,0.85)'; g.shadowBlur = 5;
  g.fillStyle = BASE.text;
  g.fillText(text, 4, H / 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4; tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(2.2, 0.6, 1);
  sp.userData.tex = tex;
  return sp;
}

// Feine Ring-Linie (LineLoop) aus layout.ringPath(type), eingefärbt in der Typ-Identität.
function makeRing(type) {
  const arr = ringPath(type, 180);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  const mat = new THREE.LineBasicMaterial({
    color: new THREE.Color(NODE[type] || BASE.zoneLine),
    transparent: true, opacity: 0.30,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const loop = new THREE.LineLoop(geo, mat);
  loop.renderOrder = 0;   // hinter die Knoten
  return loop;
}

export function createZones(scene) {
  const group = new THREE.Group();
  scene.add(group);

  const labels = [];     // Sprites
  const rings = [];      // LineLoops

  function clear() {
    for (const lab of labels) { group.remove(lab); lab.userData.tex.dispose(); lab.material.dispose(); }
    for (const r of rings) { group.remove(r); r.geometry.dispose(); r.material.dispose(); }
    labels.length = 0; rings.length = 0;
  }

  // Ring-Linien + Labels aus den layout-Ring-Parametern (zones) neu aufbauen.
  // Nur für Typen mit tatsächlich vorhandenen Knoten (counts[type] > 0).
  function rebuild(zones, counts) {
    try {
      clear();
      if (!zones) return;
      const anchors = zones._anchors || {};
      const cnt = counts || {};
      const types = (zones._order || Object.keys(zones)).filter((t) => t[0] !== '_');

      for (const type of types) {
        if (!(cnt[type] > 0)) continue;              // leerer Typ → kein Ring/Label
        const ring = makeRing(type); group.add(ring); rings.push(ring);

        if (!TEXT[type]) continue;                   // professor etc. → kein eigenes Label
        const a = anchors[type]; if (!a) continue;
        let count = cnt[type] || 0;
        if (type === 'agent') count += cnt.professor || 0;   // Professoren teilen die Agenten-Bahn
        const label = makeLabel(count ? `${TEXT[type]} · ${count}` : TEXT[type]);
        label.position.set(a.x, a.y, a.z);
        group.add(label); labels.push(label);
      }
      l.debug('Ringe + Labels neu gebaut:', rings.length, '/', labels.length);
    } catch (e) {
      l.warn('rebuild übersprungen:', e.message);
    }
  }

  // Inverser Fade der Labels: beim RAUSzoomen ein (Orientierung), beim REINzoomen aus.
  // Ring-Linien bleiben konstant dezent (strukturelle Bahn, immer sichtbar).
  function tick(camDist) {
    const f = Math.max(0, Math.min(1, ((camDist || 24) - 16) / 14));
    for (const lab of labels) lab.material.opacity = 0.80 * f;
  }

  function setVisible(b) { group.visible = !!b; }

  function destroy() { clear(); scene.remove(group); }

  return { group, rebuild, tick, setVisible, destroy };
}
