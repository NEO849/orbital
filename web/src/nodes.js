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
import { humanLabel } from './entity.js';
import { log } from './log.js';

const l = log.mod('nodes');

const WHITE = new THREE.Color(hex0x(BASE.white));
const GREY = new THREE.Color(hex0x(BASE.dim));   // inaktiv = 12% Richtung dim entsättigt (nie transparent)

// Geometrie je Typ (einmal gebaut, geteilt). Größe kodiert Wichtigkeit:
// session (Protagonist) am größten, tool/server am kleinsten/zurückhaltend.
// Größe kodiert Wichtigkeit (Referenz-Prinzip): Session groß (Protagonist),
// Tool/Server klein (viele/Backdrop → treten zurück). Spreizung macht Hierarchie.
// Box-Maße je Würfel-Typ — EINE Quelle, geteilt von Körper-Geometrie (rund) UND
// der scharfen Blueprint-Kontur (die braucht echte Kanten, s.u.). Größe wie zuvor.
const BOX_DIMS = {
  pipeline: [0.74, 0.46, 0.46],   // größer → Blueprint-Kontur gut lesbar
  tool:     [0.42, 0.42, 0.42],   // deutlich größer → kleine Tools klar erkennbar
  brett:    [0.54, 0.54, 0.12],
  server:   [0.46, 0.50, 0.46],   // größer, Rahmen-Boxen lesbar
};
// Eck-Radius je Typ: kleine Fasen → die PMREM-Studio-Env-Highlights fangen sich an
// den Kanten, die Würfel lesen als BELEUCHTETE Massiv-Körper statt flacher Paneele.
const BOX_RADIUS = { pipeline: 0.09, tool: 0.08, brett: 0.05, server: 0.08 };

// Kompakte Rund-Würfel-Geometrie (RoundedBoxGeometry ist NICHT gevendort): einen
// segmentierten Würfel bauen, jeden Vertex auf eine innere Box klemmen und um
// `radius` nach außen drücken → echte runde Kanten + Ecken. Gesamtmaß bleibt (w,h,d)
// (Flächenmitten erreichen weiter ±halbe Kante). Fail-open → im Fehlerfall flache Box.
function roundedBoxGeometry(w, h, d, radius, segments = 8) {
  try {
    const r = Math.max(0, Math.min(radius, Math.min(w, h, d) / 2 - 1e-3));
    const geo = new THREE.BoxGeometry(w, h, d, segments, segments, segments);
    if (r <= 0) return geo;   // zu dünn für eine Fase → flach lassen
    const pos = geo.attributes.position;
    const ex = w / 2 - r, ey = h / 2 - r, ez = d / 2 - r;
    const v = new THREE.Vector3(), c = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      // nächster Punkt auf der inneren Box (Klemmen je Achse) …
      c.set(
        Math.max(-ex, Math.min(ex, v.x)),
        Math.max(-ey, Math.min(ey, v.y)),
        Math.max(-ez, Math.min(ez, v.z)),
      );
      // … und um genau `radius` nach außen drücken (Fläche→flach, Kante/Ecke→rund).
      v.sub(c);
      const len = v.length();
      if (len > 1e-6) v.multiplyScalar(r / len).add(c); else v.copy(c);
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();   // Normalen neu → Lack/Env gleiten sauber über die Rundung
    return geo;
  } catch (err) {
    l.warn('roundedBoxGeometry fehlgeschlagen, nutze flache Box:', err);
    return new THREE.BoxGeometry(w, h, d);
  }
}

// W5 — Sci-Fi Orbit-Ringe: EINE geteilte Unit-Torus-Geometrie (Radius 1, dünnes Rohr),
// pro Ring nur Transform + eigenes Material. Additiv geblendet + auf dem Bloom-Layer (W6).
const RING_GEO = new THREE.TorusGeometry(1, 0.015, 3, 120);
const SHOCK_GEO = new THREE.TorusGeometry(1, 0.05, 3, 72);   // W7: Fokus-Shockwave (expandierender Ring)
const BLOOM_LAYER = 1;

// Ringe um einen Knoten legen (Energiekern + Orbit-Ringe). specs: {r, opacity, white, rx,ry,rz,
// axis, speed}. Rückgabe: [{mesh, mat, axis, speed, baseOpacity}] zum Rotieren/Pulsen im tick.
function addRings(mesh, col, specs) {
  const rings = [];
  for (const s of specs) {
    const mat = new THREE.MeshBasicMaterial({
      color: col.clone().lerp(WHITE, s.white ?? 0.35),
      transparent: true, opacity: s.opacity ?? 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    const ring = new THREE.Mesh(RING_GEO, mat);
    ring.scale.setScalar(s.r);
    ring.rotation.set(s.rx || 0, s.ry || 0, s.rz || 0);
    ring.layers.enable(BLOOM_LAYER);   // selektiver Bloom (W6) greift hier; rendert jetzt schon normal
    ring.renderOrder = 2;
    mesh.add(ring);
    rings.push({ mesh: ring, mat, axis: s.axis || 'y', speed: s.speed || 0.4, baseOpacity: s.opacity ?? 0.55 });
  }
  return rings;
}

// ALLE Knoten = Energie-Sphären (User: weg von den Billard-/Würfel-Formen). Typ wird über
// FARBE (palette NODE.*) + GRÖSSE kodiert, nicht mehr über Form: Session groß (Protagonist),
// tool/server klein (viele/Peripherie). (Würfel-/Oktaeder-Helfer bleiben ungenutzt im Modul.)
const GEO = {
  session:   () => new THREE.SphereGeometry(0.62, 40, 28),   // Protagonist, größter Orb
  memory:    () => new THREE.SphereGeometry(0.46, 36, 24),
  agent:     () => new THREE.SphereGeometry(0.40, 32, 22),
  professor: () => new THREE.SphereGeometry(0.40, 32, 22),
  pipeline:  () => new THREE.SphereGeometry(0.44, 32, 22),
  tool:      () => new THREE.SphereGeometry(0.34, 28, 20),
  brett:     () => new THREE.SphereGeometry(0.40, 30, 20),
  server:    () => new THREE.SphereGeometry(0.38, 30, 20),
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
  // machined: tool/server bekommen einen "gefrästes-Metall"-Read (zwischen backdrop und mid):
  // mehr Clearcoat/Env → die Env-Highlights fangen sich an den neuen runden Kanten,
  // höherer Emissive-Sockel + kräftigerer Rim → die Schiefer-Würfel lesen als solide
  // beleuchtete Körper, nicht mehr als flache graue Paneele. Slate-Identität bleibt.
  machined: { metalness: 0.14, roughness: 0.38, clearcoat: 0.6, clearcoatRoughness: 0.22, env: 0.45, floor: 0.20, activeMax: 0.75, rim: 0.36 },
  backdrop: { metalness: 0.06, roughness: 0.55, clearcoat: 0.4, clearcoatRoughness: 0.35, env: 0.35, floor: 0.16, activeMax: 0.6, rim: 0.18 },
};
function bandFor(type) {
  if (type === 'session') return BAND.heroWarm;
  if (type === 'memory') return BAND.hero;
  if (type === 'tool' || type === 'server') return BAND.machined;   // war backdrop (flach) → machined
  return BAND.mid;   // pipeline/brett bleiben mid (schon glänzend → Hierarchie kohärent)
}
const geoCache = {};
function geoFor(type) {
  if (!geoCache[type]) geoCache[type] = (GEO[type] || GEO.tool)();
  return geoCache[type];
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
  g.fillText(humanLabel(e), 4, 60);   // GEMEINSAMER Name mit der HUD-Liste (entity.js)
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
  let selectedId = null;       // aktuell im HUD/Klick ausgewählter Knoten (W3a: Liste↔3D)
  const shocks = [];           // W7: aktive Fokus-Shockwave-Ringe (expandieren + verblassen)

  // Einmaliger Shockwave-Ring am gewählten Knoten (additiv, Bloom-Layer) → kinematischer Klick.
  function spawnShock(rec) {
    const mat = new THREE.MeshBasicMaterial({
      color: WHITE, transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    });
    const m = new THREE.Mesh(SHOCK_GEO, mat);
    m.layers.enable(BLOOM_LAYER); m.renderOrder = 3; m.scale.setScalar(0.6);
    rec.mesh.add(m);
    shocks.push({ mesh: m, mat, parent: rec.mesh, t: 0 });
  }

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
    // Energie-Sphäre statt Lack-Billardkugel: transluzent-glühender Körper. Identität = Typ-
    // Farbe (Diffuse), Zustand = Helligkeit (Emissive). Nahezu solide (opacity 0.85), damit der
    // matte Typ-Ton klar liest; die leichte Transluzenz gibt Tiefe ohne Farbverwässerung.
    const mat = new THREE.MeshStandardMaterial({
      color: col,
      emissive: col.clone(),
      emissiveIntensity: 0.15,
      roughness: 0.5, metalness: 0.0,
      transparent: true, opacity: 0.85, depthWrite: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    // Energie-Halo: additive BackSide-Hülle = dünnes Kantenlicht (Fresnel-artig), kein Flare.
    const rimMat = new THREE.MeshBasicMaterial({
      color: col.clone(), transparent: true, opacity: 0.10,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide,
    });
    const rim = new THREE.Mesh(geo, rimMat);
    rim.scale.setScalar(1.18);
    mesh.add(rim);
    const rings = null;   // (W5-Orbit-Ringe entfernt — würden mit den Saturn-Ringen clashen)
    const edgeGeo = null, edgeMat = null;   // (Würfel-Blueprint-Konturen entfallen — alles Sphären)
    let label = null;
    if (LABELED.has(e.type)) { label = makeLabel(e); mesh.add(label); }
    mesh.userData.baseColor = col.clone();
    mesh.userData.entityId = e.id;   // für Picking (Klick → Detail-Panel)
    group.add(mesh);
    return { mesh, mat, rim, rimMat, edgeGeo, edgeMat, label, band, type: e.type, rings };
  }

  // heat → Helligkeit (Energie-Sphäre, Design-Spezialist-Kalibrierung, dezent):
  // Identität = Typ-Farbe (Diffuse/Emissive), Zustand = Helligkeit + Körper-Dichte.
  function applyHeat(rec, heat, active) {
    const h = Math.max(0, Math.min(1, Number(heat) || 0));
    rec._heat = h; rec._active = active;   // cachen → setSelected kann ohne State neu anwenden
    const base = rec.mesh.userData.baseColor;
    // Emissive = Typ-Farbe; nur bei Extrem-Last ein Hauch Weiß (Typ bleibt immer lesbar).
    rec.mat.emissive.copy(base).lerp(WHITE, h * h * 0.18);
    // Floor 0.15 (gerade sichtbar im Graphit), aktiv bis 0.65 (energetisiert, typ-farbig,
    // ~0.80 Luminanz = knapp an der Bloom-Schwelle 0.78 → zarter Schimmer, kein Grell).
    rec.mat.emissiveIntensity = active ? (0.15 + h * 0.50) : 0.06;
    // Körper fast solide (0.85) → matter Typ-Ton liest klar; aktiv minimal dichter (bis 0.95).
    rec.mat.opacity = active ? (0.85 + h * 0.10) : 0.80;
    if (active) rec.mat.color.copy(base);
    else rec.mat.color.copy(base).lerp(GREY, 0.22);   // inaktiv = stärker entsättigt → tritt als Backdrop zurück, aber nicht transparent
    // Energie-Halo: idle 0.10, aktiv bis 0.25 (dünnes Kantenlicht, kein Flare).
    // WICHTIG: JEDEN Call für ALLE Typen frisch setzen → der Fokus-Dim unten (×0.5)
    // akkumuliert sonst gegen 0 und der Rim bliebe dauerhaft gefadet.
    if (rec.rimMat) rec.rimMat.opacity = active ? (0.10 + h * 0.15) : 0.08;
    // ── Auswahl-Hervorhebung (W3a) GANZ am Ende — dezenter, premium (kein Weißbrand).
    const isSel = rec.mesh.userData.entityId === selectedId;
    if (isSel) {
      rec.mat.emissiveIntensity = Math.min(1.1, rec.mat.emissiveIntensity * 1.5 + 0.2);
      rec.mat.opacity = 0.95;
      if (rec.rimMat) rec.rimMat.opacity = Math.min(0.5, (rec.rimMat.opacity || 0) + 0.25);
      if (rec.rim) rec.rim.scale.setScalar(1.28);
    } else if (rec.rim) {
      rec.rim.scale.setScalar(1.18);   // Normal-Halo
      // W7: ist IRGENDEIN Knoten fokussiert, treten die übrigen dezent zurück.
      if (selectedId) {
        rec.mat.emissiveIntensity *= 0.45;
        if (rec.rimMat) rec.rimMat.opacity *= 0.5;
      }
    }
  }

  // Auswahl setzen (von main.js via aos:detail getrieben → Liste↔3D bidirektional).
  // Re-rendert alle Knoten mit ihren gecachten heat/active-Werten, damit der Boost
  // sofort greift (nicht erst beim nächsten State-Update).
  function setSelected(id) {
    const next = id || null;
    if (next === selectedId) return;
    selectedId = next;
    for (const rec of nodes.values()) applyHeat(rec, rec._heat || 0, rec._active !== false);
    if (next) { const rec = nodes.get(next); if (rec) spawnShock(rec); }   // W7: Shockwave am neuen Fokus
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
      if (rec.rings) for (const r of rec.rings) r.mat.dispose();   // Ring-Material (Geo ist geteilt → bleibt)
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
  let ringT = 0;
  function tick(dt, camDist) {
    const s = Math.max(0.9, Math.min(1.8, (camDist || 24) / 24));
    ringT += dt;
    for (const rec of nodes.values()) {
      rec.mesh.scale.setScalar(s);
      if (rec.label) rec.label.scale.set(1.8 / s, 0.5 / s, 1);
      // Orbit-Ringe drehen (gegenläufig) + dezent atmen → lebendiger Sci-Fi-Knoten.
      if (rec.rings) for (const r of rec.rings) {
        r.mesh.rotation[r.axis] += r.speed * dt;
        r.mat.opacity = r.baseOpacity * (0.78 + 0.22 * Math.sin(ringT * 1.6 * (r.speed > 0 ? 1 : -1.3)));
      }
    }
    // W7: Shockwave-Ringe expandieren + verblassen, dann sauber entfernen.
    for (let i = shocks.length - 1; i >= 0; i--) {
      const sh = shocks[i];
      sh.t += dt * 1.7;
      const k = Math.min(1, sh.t);
      sh.mesh.scale.setScalar(0.6 + k * 2.8);
      sh.mat.opacity = 0.7 * (1 - k) * (1 - k);
      if (sh.t >= 1) { sh.parent.remove(sh.mesh); sh.mat.dispose(); shocks.splice(i, 1); }
    }
  }

  return {
    group,
    update,
    updateEdges,
    tick,
    setSelected,
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
