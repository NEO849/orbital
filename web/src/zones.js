// AOS-1 Observatory — src/zones.js
// Verantwortung: die ZONEN-GRENZEN — pro Typ-Zone eine dezente Wireframe-Box + ein
// Text-Label ("BRAIN"/"AGENTEN"/…). Macht "jeder Typ an seinem Platz" selbsterklärend,
// ohne den Graphen zuzukleistern (Graphit-Look: scharfe Hairlines, kein Glow).
//
// Modular: kennt nur den `zones`-Export aus layout.js (Sektor-Geometrie) + palette.
// Vertrag: createZones(scene) → { group, rebuild(zones, counts), tick(camDist),
//          setVisible(bool), destroy() }. main.js ruft rebuild bei Entity-Diff, tick je Frame.
//
// Fade (invers zu Node-Labels): fern = Orientierung über Zonen (Boxen/Labels ein),
// nah = Detail über Node-Labels (Zonen aus). camDist = Kamera-Abstand (orbit.radius).

import * as THREE from 'three';
import { BASE, hex0x } from '../palette.js';
import { log } from './log.js';

const l = log.mod('zones');
const DEG = Math.PI / 180;

// Ein Label je Zone (7 statt N). memory = "BRAIN" (Betreiber-Wunsch). professor teilt
// die Agenten-Zone → kein eigenes Label (Count wird in AGENTEN mitgezählt).
const TEXT = {
  memory:   'BRAIN',
  session:  'SESSIONS',
  agent:    'AGENTEN',
  pipeline: 'PIPELINES',
  brett:    'BRETT',
  tool:     'TOOLS',
  server:   'SERVER',
};

// Zonen-Label als billboarded CanvasTexture-Sprite (mono, uppercase, gedämpft).
function makeLabel(text) {
  const W = 256, H = 64, dpr = 2;
  const cv = document.createElement('canvas');
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.textBaseline = 'middle';
  g.font = '600 26px ui-monospace,Menlo,Consolas,monospace';
  // Dunkler Schatten gegen den hellen Strom-Hintergrund → Text hebt sich ab (Lesbarkeit).
  g.shadowColor = 'rgba(0,0,0,0.85)'; g.shadowBlur = 5;
  g.fillStyle = BASE.text;   // heller (war gedämpftes Grau) → besser lesbar
  g.fillText(text, 4, H / 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4; tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(2.2, 0.6, 1);
  sp.userData.tex = tex;
  return sp;
}

export function createZones(scene) {
  const group = new THREE.Group();
  scene.add(group);

  const lines = [];    // LineSegments (Box-Kanten)
  const labels = [];   // Sprites

  function clear() {
    for (const seg of lines) { group.remove(seg); seg.geometry.dispose(); seg.material.dispose(); }
    for (const lab of labels) { group.remove(lab); lab.userData.tex.dispose(); lab.material.dispose(); }
    lines.length = 0; labels.length = 0;
  }

  // Eine achsenparallele Wireframe-Box (12 Kanten) um die Box3 legen.
  function addBox(box) {
    const size = new THREE.Vector3(); box.getSize(size);
    const center = new THREE.Vector3(); box.getCenter(center);
    const bg = new THREE.BoxGeometry(Math.max(0.1, size.x), Math.max(0.1, size.y), Math.max(0.1, size.z));
    const geo = new THREE.EdgesGeometry(bg);
    bg.dispose();
    // GESTRICHELT statt durchgezogen: liest als „Zone/Grenze" (wie ein Auswahl-Rahmen),
    // nicht als solides Objekt — kräftiger erlaubt, ohne den Graphen zuzukleistern.
    const mat = new THREE.LineDashedMaterial({
      color: hex0x(BASE.zoneLine), transparent: true, opacity: 0, depthWrite: false,
      dashSize: 0.35, gapSize: 0.22,
    });
    const seg = new THREE.LineSegments(geo, mat);
    seg.computeLineDistances();   // Pflicht für LineDashedMaterial (sonst durchgezogen)
    seg.position.copy(center);
    group.add(seg);
    lines.push(seg);
  }

  // Box + Label je Zone aus dem layout.js-`zones`-Export neu aufbauen.
  function rebuild(zones, counts) {
    try {
      clear();
      if (!zones) return;
      const ySquash = zones._ySquash || 0.55;
      const memR = zones._memRadius || 2.3;
      const cnt = counts || {};

      for (const type of Object.keys(TEXT)) {
        let box, labelPos;

        if (type === 'memory') {
          // zentraler Würfel um Origin (Y gestaucht wie die Memory-Wolke).
          box = new THREE.Box3(
            new THREE.Vector3(-memR, -memR * ySquash, -memR),
            new THREE.Vector3(memR, memR * ySquash, memR),
          );
          labelPos = new THREE.Vector3(memR, memR * ySquash + 0.3, memR);
        } else {
          const z = zones[type];
          if (!z) continue;
          const [cDeg, halfDeg, rMin, rMax] = z;
          const aMin = (cDeg - halfDeg) * DEG, aMax = (cDeg + halfDeg) * DEG;
          const rSpan = rMax - rMin;
          const yExt = rSpan * 0.3 * ySquash + 0.2;   // entspricht der vertikalen Streuung in layout.js
          // Sektor-Hülle samplen (mehrere Winkel → AABB fängt die Krümmung).
          let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
          for (let k = 0; k <= 4; k++) {
            const a = aMin + (aMax - aMin) * (k / 4);
            for (const r of [rMin, rMax]) {
              const x = Math.cos(a) * r, zz = Math.sin(a) * r;
              if (x < minX) minX = x; if (x > maxX) maxX = x;
              if (zz < minZ) minZ = zz; if (zz > maxZ) maxZ = zz;
            }
          }
          box = new THREE.Box3(
            new THREE.Vector3(minX, -yExt, minZ),
            new THREE.Vector3(maxX, yExt, maxZ),
          );
          const ca = cDeg * DEG;
          labelPos = new THREE.Vector3(Math.cos(ca) * rMax, yExt + 0.3, Math.sin(ca) * rMax);
        }

        addBox(box);

        let count = cnt[type] || 0;
        if (type === 'agent') count += cnt.professor || 0;   // Professoren teilen die Agenten-Zone
        const label = makeLabel(count ? `${TEXT[type]} · ${count}` : TEXT[type]);
        label.position.copy(labelPos);
        group.add(label);
        labels.push(label);
      }
      l.debug('Zonen neu gebaut:', lines.length);
    } catch (e) {
      l.warn('rebuild übersprungen:', e.message);
    }
  }

  // Inverser Fade: beim RAUSzoomen ein (Orientierung), beim REINzoomen aus (Detail).
  function tick(camDist) {
    const f = Math.max(0, Math.min(1, ((camDist || 24) - 16) / 14));
    for (const seg of lines) seg.material.opacity = 0.30 * f;   // kräftiger als Hairline (gestrichelt trägt mehr)
    for (const lab of labels) lab.material.opacity = 0.80 * f;   // heller lesbar (war 0.55)
  }

  function setVisible(b) { group.visible = !!b; }

  function destroy() { clear(); scene.remove(group); }

  return { group, rebuild, tick, setVisible, destroy };
}
