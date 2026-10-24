// AOS-1 Observatory — src/nodes.js
// Verantwortung: das PERSISTENTE Graph-Skelett — Knoten-Meshes aus entities[]
// (+ die statischen Topologie-Kanten, die laut SCHEMA "immer sichtbar" sind).
// Die flüchtigen Event-Partikel macht flows.js; hier liegt nur, was stehen bleibt.
//
// Regeln (Brief + palette):
//  - Material-Farbe = nodeColor(type,meta) → IDENTITÄT, ändert sich NIE.
//  - Aktivität (heat) ändert NUR Helligkeit: emissive wandert Richtung
//    PALETTE.base.white, emissiveIntensity ∝ heat → aktive Knoten glühen weiß,
//    behalten aber ihre Grundfarbe (lesbare Identität).
//  - Label = CanvasTexture-Sprite (Typ + Kurzname), billboarded (immer zur Kamera).
//  - DIFF-Update: neue Knoten rein, verschwundene raus, Rest nur aktualisiert —
//    kein Full-Rebuild je Tick (sonst flackern Labels/Reflexe).

import * as THREE from 'three';
import { nodeColor, hex0x, BASE } from '../palette.js';
import { log } from './log.js';

const l = log.mod('nodes');

const WHITE = new THREE.Color(hex0x(BASE.white));
const GREY = new THREE.Color(hex0x(BASE.dim));   // inaktiv = 12% Richtung dim entsättigt (nie transparent)

// Geometrie je Typ (einmal gebaut, geteilt). Größe kodiert Wichtigkeit:
// session (Protagonist) am größten, tool/server am kleinsten/zurückhaltend.
// Größe kodiert Wichtigkeit (Referenz-Prinzip): Session groß (Protagonist),
// Tool/Server klein (viele/Backdrop → treten zurück). Spreizung macht Hierarchie.
const GEO = {
  session:   () => new THREE.SphereGeometry(0.70, 44, 30),   // glatte Leucht-Portale (war facettiert, wirkte billig)
  memory:    () => new THREE.SphereGeometry(0.40, 40, 26),
  agent:     () => new THREE.OctahedronGeometry(0.40, 0),
  professor: () => new THREE.OctahedronGeometry(0.40, 0),
  pipeline:  () => new THREE.BoxGeometry(0.74, 0.46, 0.46),   // größer → Blueprint-Kontur gut lesbar
  tool:      () => new THREE.BoxGeometry(0.42, 0.42, 0.42),   // deutlich größer → kleine Tools klar erkennbar
  brett:     () => new THREE.BoxGeometry(0.54, 0.54, 0.12),
  server:    () => new THREE.BoxGeometry(0.46, 0.50, 0.46),   // größer, Rahmen-Boxen lesbar
};

// 3-Band-Material (Graphit-Look in 3D): Farbe in der DIFFUSE (metalness ~0.1),
// nicht als Chrom-Tint. Clearcoat legt einen dünnen Lackglanz ÜBER den soliden Körper
// ("nasser Graphit-Lack"), envMapIntensity niedrig → Env glänzt nur im Lack, ersetzt
// nie die Identitätsfarbe. floor/activeMax = Emissive-Sockel (Hue trägt immer, auch fern).
const BAND = {
  hero:     { metalness: 0.12, roughness: 0.33, clearcoat: 1.0, clearcoatRoughness: 0.18, env: 0.55, floor: 0.28, activeMax: 1.1, rim: 0.50 },
  // Session-Kugeln: bewusst MATTER (weniger Lack/Env) → voller, EINHEITLICHER Korall-Körper
  // statt harter weißer Glanz-Hotspots, die den Cluster "uneinheitlich" wirken ließen.
  heroWarm: { metalness: 0.06, roughness: 0.52, clearcoat: 0.35, clearcoatRoughness: 0.4, env: 0.22, floor: 0.30, activeMax: 1.05, rim: 0.50 },
  mid:      { metalness: 0.10, roughness: 0.42, clearcoat: 0.7, clearcoatRoughness: 0.25, env: 0.45, floor: 0.22, activeMax: 0.9, rim: 0.34 },
  backdrop: { metalness: 0.06, roughness: 0.55, clearcoat: 0.4, clearcoatRoughness: 0.35, env: 0.35, floor: 0.16, activeMax: 0.6, rim: 0.18 },
};
function bandFor(type) {
  if (type === 'session') return BAND.heroWarm;
  if (type === 'memory') return BAND.hero;
  if (type === 'tool' || type === 'server') return BAND.backdrop;
  return BAND.mid;
}
const geoCache = {};
function geoFor(type) {
  if (!geoCache[type]) geoCache[type] = (GEO[type] || GEO.tool)();
  return geoCache[type];
}

// Kurzname fürs Label: id-Präfix abschneiden, auf Länge kappen.
function shortName(e) {
  const raw = e.label || (e.id || '').split(':').slice(1).join(':') || e.id || '?';
  return raw.length > 22 ? raw.slice(0, 21) + '…' : raw;
}

// Billboard-Label als CanvasTexture-Sprite (Typ klein + Kurzname groß).
function makeLabel(e) {
  const W = 320, Hh = 96, dpr = 2;
  const cv = document.createElement('canvas');
  cv.width = W * dpr; cv.height = Hh * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.textBaseline = 'middle';
  // Dunkler Schatten gegen den hellen Strom-Hintergrund → Text hebt sich klar ab.
  g.shadowColor = 'rgba(0,0,0,0.9)'; g.shadowBlur = 6;
  // Typ-Kicker (Großbuchstaben) — heller als zuvor, besser lesbar
  g.fillStyle = 'rgba(206,214,226,0.95)';
  g.font = '600 18px ui-monospace,Menlo,Consolas,monospace';
  g.fillText((e.type || '').toUpperCase(), 4, 20);
  // Kurzname (nahezu weiß → maximale Lesbarkeit)
  g.fillStyle = '#f4f7fb';
  g.font = '700 30px -apple-system,Segoe UI,Helvetica,Arial,sans-serif';
  g.fillText(shortName(e), 4, 60);
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4; tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true;
  // depthTest:false → Label wird NIE hinter einer Kugel/Geometrie versteckt (immer-oben-Overlay,
  // Enterprise-Standard für Beschriftungen). renderOrder hoch → zeichnet nach Knoten/Adern/Partikeln.
  const mat = new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, depthTest: false, opacity: 1.0,
  });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(1.8, 0.5, 1);         // kleiner (Referenz-Stil, weniger Dominanz)
  sp.position.set(1.0, 0.55, 0);     // klar SEITLICH+leicht ÜBER dem Knoten → frei neben der Kugel
  sp.renderOrder = 20;               // über allem → immer lesbar
  sp.userData.tex = tex;
  return sp;
}

export function createNodes(scene) {
  const group = new THREE.Group();
  const edgeGroup = new THREE.Group();   // statische Kanten hinter die Knoten
  scene.add(edgeGroup);
  scene.add(group);

  const nodes = new Map();   // id -> { mesh, mat, label, type }
  const positions = new Map(); // id -> THREE.Vector3 (für flows geteilt)

  // Welche Typen tragen ein EINZEL-Label? Tool/Server (viele/Backdrop) und Memory
  // (Cluster — Zonen-Anker separat) NICHT → beseitigt den Zentrums-Label-Stapel.
  const LABELED = new Set(['session', 'agent', 'professor', 'pipeline', 'brett']);

  // Würfel-Typen bekommen eine FARBIGE GESTRICHELTE Kanten-Kontur (Blueprint-Look) —
  // hebt die sonst grauen, flachen Box-Knoten (v.a. tool/server) klar hervor und macht
  // ihre Form aus jeder Distanz lesbar. Farbe = aufgehellte Identitätsfarbe (poppt gegen
  // den dunklen Körper); Strich via LineDashedMaterial (braucht computeLineDistances).
  const BOXY = new Set(['pipeline', 'tool', 'brett', 'server']);

  // Ein Knoten-Mesh bauen. Metall-Glanz nur für die Hero-Typen; Backdrop leuchtet
  // leicht aus sich (flache Marke statt reflektierender Klotz). Farbe = Identität.
  function build(e) {
    const col = new THREE.Color(hex0x(nodeColor(e.type, e.meta)));
    const band = bandFor(e.type);
    const geo = geoFor(e.type);
    const mat = new THREE.MeshPhysicalMaterial({
      color: col,
      metalness: band.metalness,
      roughness: band.roughness,
      clearcoat: band.clearcoat,
      clearcoatRoughness: band.clearcoatRoughness,
      envMapIntensity: band.env,
      emissive: col.clone(),
      emissiveIntensity: band.floor,
      transparent: false,       // NIE transparent — „transparent"-Eindruck war der Hauptfehler
      opacity: 1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    // Premium-Rim: zweite Schale (gleiche Geometrie, BackSide, additiv) = farbige
    // Identitäts-Kontur, die aus JEDER Distanz poppt (Graphit-Lichtring in 3D).
    const rimMat = new THREE.MeshBasicMaterial({
      color: col.clone(), transparent: true, opacity: band.rim,   // Backdrop dezent, Hero kräftig
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide,
    });
    const rim = new THREE.Mesh(geo, rimMat);
    rim.scale.setScalar(1.06);
    mesh.add(rim);
    // Farbige gestrichelte Kanten-Kontur für Würfel-Typen (Blueprint-Look, bessere Lesbarkeit).
    let edgeGeo = null, edgeMat = null;
    if (BOXY.has(e.type)) {
      edgeGeo = new THREE.EdgesGeometry(geo);
      edgeMat = new THREE.LineDashedMaterial({
        color: col.clone().lerp(WHITE, 0.65),   // stark aufgehellt → klar glühende Kontur
        transparent: true, opacity: 1.0, depthWrite: false,
        blending: THREE.AdditiveBlending,        // additiv → Kontur leuchtet gegen den dunklen Grund
        dashSize: 0.1, gapSize: 0.04,
      });
      const outline = new THREE.LineSegments(edgeGeo, edgeMat);
      outline.computeLineDistances();            // Pflicht für gestrichelte Linien
      outline.scale.setScalar(1.05);             // minimal außen, saubere Kontur
      mesh.add(outline);
    }
    let label = null;
    if (LABELED.has(e.type)) { label = makeLabel(e); mesh.add(label); }
    mesh.userData.baseColor = col.clone();
    mesh.userData.entityId = e.id;   // für Picking (Klick → Detail-Panel)
    group.add(mesh);
    return { mesh, mat, rim, rimMat, edgeGeo, edgeMat, label, band, type: e.type };
  }

  // heat → Helligkeit: emissive = lerp(baseColor → weiß, heat), Intensität ∝ heat.
  // Material-color bleibt unverändert = Identität bleibt lesbar.
  function applyHeat(rec, heat, active) {
    const h = Math.max(0, Math.min(1, Number(heat) || 0));
    const base = rec.mesh.userData.baseColor;
    // heat hebt NUR die Emissive (Farbe bleibt in der Diffuse → Identität nie ausgewaschen).
    // Weiß-Lerp bis 0.40 gekappt: heiße Knoten glühen, behalten aber kräftige Chroma.
    rec.mat.emissive.copy(base).lerp(WHITE, h * 0.40);
    const fl = rec.band.floor, mx = rec.band.activeMax;
    // Sockel trägt die Identitätsfarbe immer (auch fern/ruhig); aktiv steigt bis activeMax.
    rec.mat.emissiveIntensity = active ? (fl + h * (mx - fl)) : fl * 0.5;
    // Zustand „inaktiv" = dunkleres Emissive + 12% entsättigte Farbe — NICHT Transparenz.
    if (active) rec.mat.color.copy(base);
    else rec.mat.color.copy(base).lerp(GREY, 0.12);
    // Gestrichelte Kontur bei Aktivität etwas kräftiger (dezente Heat-Reaktion).
    if (rec.edgeMat) rec.edgeMat.opacity = active ? (0.6 + h * 0.35) : 0.45;
  }

  // DIFF-Update gegen die aktuelle Entity-Liste + Positions-Map aus layout.js.
  function update(entities, layout) {
    const seen = new Set();
    for (const e of entities || []) {
      if (!e || !e.id) continue;
      seen.add(e.id);
      let rec = nodes.get(e.id);
      if (!rec) { rec = build(e); nodes.set(e.id, rec); }
      const p = layout.get(e.id);
      if (p) {
        rec.mesh.position.set(p.x, p.y, p.z);
        let v = positions.get(e.id);
        if (!v) { v = new THREE.Vector3(); positions.set(e.id, v); }
        v.set(p.x, p.y, p.z);
      }
      applyHeat(rec, e.heat, e.active !== false);
      // Label-Sichtbarkeit: feste Typen IMMER; andere (Tool/Server/Memory) NUR wenn AKTUELL
      // in Gebrauch (aktiv + heiß) → man sieht live, welches Werkzeug/Element gerade benutzt wird.
      const inUse = (e.active !== false) && (Number(e.heat) || 0) > 0.4;
      const wantLabel = LABELED.has(e.type) || inUse;
      if (wantLabel && !rec.label) { rec.label = makeLabel(e); rec.mesh.add(rec.label); }  // lazy bauen
      if (rec.label) rec.label.visible = wantLabel;
    }
    // verschwundene Knoten entfernen (sauber dispose)
    for (const [id, rec] of nodes) {
      if (seen.has(id)) continue;
      group.remove(rec.mesh);
      if (rec.label) { rec.label.userData.tex.dispose(); rec.label.material.dispose(); }
      rec.mat.dispose();
      if (rec.rimMat) rec.rimMat.dispose();   // Rim-Schale teilt die Geometrie (nicht disposen), nur das Material
      if (rec.edgeGeo) rec.edgeGeo.dispose();  // EdgesGeometry ist EIGENE Geometrie → disposen
      if (rec.edgeMat) rec.edgeMat.dispose();
      nodes.delete(id);
      positions.delete(id);
    }
  }

  // Statische Topologie-Kanten (static:true) als dezente additive Linien.
  // Rebuild nur, wenn sich die statische Kantenmenge ändert (Signatur-Vergleich).
  let edgeSig = '';
  function updateEdges(edges, layout) {
    const stat = (edges || []).filter((e) => e && e.static);
    const sig = stat.map((e) => e.source + '>' + e.target).sort().join('|');
    if (sig === edgeSig) return;   // nichts Neues → teure Line-Rebuilds sparen
    edgeSig = sig;
    while (edgeGroup.children.length) {
      const c = edgeGroup.children.pop();
      c.geometry.dispose(); c.material.dispose();
    }
    for (const e of stat) {
      const a = layout.get(e.source), b = layout.get(e.target);
      if (!a || !b) continue;
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(a.x, a.y, a.z), new THREE.Vector3(b.x, b.y, b.z),
      ]);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
        color: hex0x(BASE.dim), transparent: true, opacity: 0.18,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      edgeGroup.add(line);
    }
    l.debug('statische Kanten neu gebaut:', edgeGroup.children.length);
  }

  // Distanz-Skalierung: beim RAUSzoomen werden Knoten größer (bis 1.8×), damit sie nie
  // unter Lesbarkeit fallen; nah bleiben sie normal (0.9×). Rim folgt (Kind, 1.06× lokal);
  // das Label gegen-skaliert → Weltgröße konstant. camDist = Kamera-Abstand (orbit.radius).
  function tick(dt, camDist) {
    const s = Math.max(0.9, Math.min(1.8, (camDist || 24) / 24));
    for (const rec of nodes.values()) {
      rec.mesh.scale.setScalar(s);
      if (rec.label) rec.label.scale.set(1.8 / s, 0.5 / s, 1);
    }
  }

  return {
    group,
    update,
    updateEdges,
    tick,
    // flows.js fragt Positionen per id ab (geteilte, lebende Vector3-Referenzen).
    getPosition: (id) => positions.get(id) || null,
    count: () => nodes.size,
    // Picking: nächster Knoten unter dem Strahl → Entity-id (für Detail-Panel).
    raycast: (raycaster) => {
      const hits = raycaster.intersectObjects(group.children, false);
      for (const h of hits) { const id = h.object.userData && h.object.userData.entityId; if (id) return id; }
      return null;
    },
  };
}
