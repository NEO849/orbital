// Orbital — src/layout.js
// Verantwortung: deterministisches SATURN-RING-Layout. KEINE Physik, KEIN three.
// Reine Pure-Function: entities[] → Map<id,{x,y,z,ring}>.
//
// Modell (Design-Arbeitskreis 2026-10-27, Enterprise/UX-recherche-gestützt):
//  - Das Zentrum (0,0,0) ist dem Erdkern-Reaktor vorbehalten (= das System/Claude, R2).
//  - Jeder Entitäts-TYP bekommt GENAU EINEN Ring (Guardrail: „ein Ring = ein Typ" →
//    Ring-Zugehörigkeit ist sofort lesbar). Kritikalität/Kern-Nähe über den RADIUS ρ
//    (innen = kognitiv/zentral, außen = Peripherie), nicht über Ring-Mischung.
//  - Für den volumetrischen „Saturn"-Look sitzt jeder Ring zusätzlich auf einem kleinen
//    Y-Versatz (yc) und einer dezenten Achsneigung (alpha). Radien sind so separiert,
//    dass sich Knoten verschiedener Ringe nicht durchdringen.
//  - Memory = innerster Ring (Brain-Layer um den Kern). professor teilt die agent-Bahn
//    (gleiche Familie, nur minimal weiter außen).
//  - Rotation (R6) dreht NUR die visuelle Phase (theta0 + speed·t); die LOGISCHE Position
//    bleibt stabil → Wiedererkennung/Vergleich über Zeit bleibt möglich. Darum trägt jeder
//    Positions-Record seine Ring-Parameter mit (rho, yc, alpha, theta0, speed), damit nodes
//    + Ströme dieselbe Live-Position berechnen und nie voneinander abkoppeln.
//
// STABIL: Position hängt nur von (type, sortierter Index, Typ-Anzahl) ab → gleiche id ⇒
// gleiche Basis-Position/Phase über Ticks, solange der Typ-Bestand gleich bleibt.

const DEG = Math.PI / 180;

// Ring je Typ: rho=Radius, yc=Y-Versatz, alpha=Neigung(°) um die X-Achse, phase0=Winkel-
// Startversatz (damit Ring-„Nähte" nicht fluchten), speed=rel. Rotationsgeschwindigkeit (R6).
// Radien bewusst ENG & gleichmäßig separiert (Design-Arbeitskreis 2026-10-28): die alte
// Spreizung (bis ρ12) ließ eine Leere zwischen Hirn-Kern und den Außen-Ringen → äußere Knoten
// wirkten am Orbit als losgelöste Riesen-Ballons. Jetzt max ρ9,7 → EIN kohäsiver Organismus,
// „ein Ring = ein Typ" + Radius-Ordnung innen→außen bleiben, Mindestabstand ≥0,6 (keine Durchdringung).
const RING = {
  memory:    { rho:  3.4, yc:  0.0, alpha:   6, phase0: 0.00, speed:  0.9 },  // innerster Brain-Ring
  session:   { rho:  5.0, yc:  0.0, alpha:   0, phase0: 0.12, speed:  1.0 },  // Äquator-Hauptring (Protagonist)
  agent:     { rho:  6.2, yc:  0.6, alpha:  12, phase0: 0.20, speed: -0.8 },  // Arbeiter-Band
  professor: { rho:  6.9, yc:  0.6, alpha:  12, phase0: 0.35, speed: -0.8 },  // selbe Familie, knapp außen
  pipeline:  { rho:  7.7, yc: -0.6, alpha: -10, phase0: 0.05, speed:  0.7 },  // Infrastruktur
  tool:      { rho:  8.5, yc:  0.3, alpha:  11, phase0: 0.27, speed: -0.6 },  // viele
  brett:     { rho:  9.1, yc: -0.35, alpha: -7, phase0: 0.50, speed:  0.65 }, // wenige
  server:    { rho:  9.7, yc: -0.5, alpha: -10, phase0: 0.15, speed:  0.5 },  // äußerste Peripherie (flach in der Scheibe)
};
const DEFAULT_RING = { rho: 9.0, yc: 0.0, alpha: 0, phase0: 0, speed: 0.6 };

// Ein Knoten-Punkt auf einem geneigten Ring. theta = Umlaufwinkel; Grundkreis in XZ,
// dann um die X-Achse um alpha gekippt (y' = -sin·z, z' = cos·z).
function ringPointAt(r, theta) {
  const ca = Math.cos(r.alpha * DEG), sa = Math.sin(r.alpha * DEG);
  const bx = r.rho * Math.cos(theta), bz = r.rho * Math.sin(theta);
  return { x: bx, y: (r.yc || 0) - sa * bz, z: ca * bz };
}

// entities: Entity[] (SCHEMA.md). Rückgabe: Map<id, {x,y,z,ring}>.
export function computeLayout(entities) {
  const pos = new Map();
  if (!Array.isArray(entities) || !entities.length) return pos;

  // Nach Typ gruppieren, je Gruppe nach id sortieren (stabile Reihenfolge).
  const byType = new Map();
  for (const e of entities) {
    if (!e || !e.id) continue;
    const t = e.type || 'other';
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push(e);
  }
  for (const list of byType.values()) list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const [type, list] of byType) {
    const n = list.length;
    const r = RING[type] || DEFAULT_RING;
    for (let i = 0; i < n; i++) {
      // Gleichverteilung auf dem Ring (Winkel 2π·(i+phase0)/n).
      const theta = 2 * Math.PI * ((i + (r.phase0 || 0)) / Math.max(1, n));
      const p = ringPointAt(r, theta);
      pos.set(list[i].id, {
        x: p.x, y: p.y, z: p.z,
        ring: { rho: r.rho, yc: r.yc || 0, alpha: r.alpha || 0, theta0: theta, speed: r.speed || 0 },
      });
    }
  }
  return pos;
}

// Ring-Linien-Pfad (für zones.js: feine Laser-Ring-Linie je Typ). GARANTIERT deckungsgleich
// mit den Knoten-Positionen, weil dieselbe ringPointAt-Formel. Rückgabe: Float32Array (LineLoop).
export function ringPath(type, segments = 160) {
  const r = RING[type] || DEFAULT_RING;
  const out = new Float32Array(segments * 3);
  for (let i = 0; i < segments; i++) {
    const p = ringPointAt(r, 2 * Math.PI * (i / segments));
    out[i * 3] = p.x; out[i * 3 + 1] = p.y; out[i * 3 + 2] = p.z;
  }
  return out;
}

// Label-Anker je Ring = fester Welt-Punkt an der „Vorderseite" (theta=−90°), leicht nach
// außen + über den Ring gerückt. Bleibt fix, auch wenn der Ring später rotiert (benennt
// weiter korrekt den Typ, dessen Identität sich ja nicht dreht).
function ringAnchor(r) {
  const p = ringPointAt(r, -Math.PI / 2);
  return { x: p.x * 1.06, y: p.y + 0.7, z: p.z * 1.06 };
}
const ANCHORS = {};
for (const t of Object.keys(RING)) ANCHORS[t] = ringAnchor(RING[t]);

// Für zones.js (Ring-Linien + Labels) + HUD/Debug (read-only). Top-Level-Keys = Typen mit
// Ring-Parametern; _-Präfix = Meta. _order = Zeichen-/Iterations-Reihenfolge innen→außen.
export const zones = { ...RING, _anchors: ANCHORS, _order: Object.keys(RING) };
