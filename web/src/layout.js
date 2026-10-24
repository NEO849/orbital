// AOS-1 Observatory — src/layout.js
// Verantwortung: deterministisches ZONEN-Layout. KEINE Physik, KEIN three.
// Reine Pure-Function: entities[] → Map<id,{x,y,z}>.
//
// Prinzip (Enterprise-lesbar, Ergebnis des Design-Arbeitskreises):
//  - Die alte Vollkugel-Schalen-Lösung war unlesbar ("Kugel-Suppe"): Radius als
//    Typ-Code ist per Auge nicht ablesbar, weil sich die Schalen auf der Kugel
//    durchdringen → jeder Typ erscheint "überall".
//  - NEU: jeder Typ bekommt einen FESTEN WINKEL-SEKTOR der Scheibe (fester Platz)
//    UND ein Radius-Band. "Was für ein Ding" ist aus RICHTUNG + ABSTAND gemeinsam
//    ablesbar. Memory bleibt der zentrale Hub (drehbare Wolke).
//  - DISK-FLATTEN: Y wird mit Y_SQUASH gestaucht → aus der Kugel wird eine flache
//    Galaxie-Scheibe. 0.55 (nicht 0.35) → klar lesbar, aber bewusst noch 3D
//    (Tiefe + Fog bleiben, drehbar bleibt der Kernwunsch).
//
// STABIL: Position hängt nur von (type, sortierter Index, Typ-Anzahl) ab →
// gleiche id ⇒ gleiche Position über Ticks, solange der Typ-Bestand gleich bleibt.

const DEG = Math.PI / 180;

// Vertikale Stauchung: 1.0 = Vollkugel, 0 = exakt flach. 0.55 = lesbare Scheibe mit Tiefe.
const Y_SQUASH = 0.55;

// Zonen je Typ: [Azimut-Zentrum°, Halbwinkel°, rMin, rMax]. Die Sektoren kacheln
// den Kreis (Blick von oben), session liegt vorn (zur Default-Kamera). Memory ist
// der zentrale Hub und wird separat als Fibonacci-Wolke gelegt.
const ZONE = {
  session:   [180, 46, 5.0, 8.4],    // VORN — Protagonist, kameranah; weiter Fächer + breites Radius-Band → die großen Kugeln stehen klar getrennt (kein Blob)
  agent:     [330, 30, 6.5, 8.0],    // RECHTS — die "Arbeiter"
  professor: [330, 30, 6.5, 8.0],    // bei den Agenten (Unterfamilie)
  pipeline:  [ 85, 25, 7.5, 9.0],    // LINKS-HINTEN — Infrastruktur
  brett:     [135, 15, 5.5, 6.5],    // LINKS — wenige, Eck-Platz
  tool:      [255, 45, 9.5, 11.5],   // AUSSENRING — viele, Peripherie
  server:    [ 30, 30, 11.0, 13.0],  // FERNER RAND — reiner Rahmen
};
const DEFAULT_ZONE = [0, 40, 8.0, 9.0];

const MEM_RADIUS = 2.3;   // zentrale Gedächtnis-Wolke (leicht größer gg. Flatten-Überlappung)

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// Ein Punkt i von n auf der Einheitskugel (Fibonacci-Spirale) — nur für den Memory-Hub.
function fibDir(i, n) {
  if (n <= 1) return { x: 0, y: 0, z: 0, single: true };
  const y = 1 - (i / (n - 1)) * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const phi = i * GOLDEN_ANGLE;
  return { x: Math.cos(phi) * r, y, z: Math.sin(phi) * r, single: false };
}

// entities: Entity[] (SCHEMA.md). Rückgabe: Map<id, {x,y,z}>.
export function computeLayout(entities) {
  const pos = new Map();
  if (!Array.isArray(entities) || !entities.length) return pos;

  // 1) Nach Typ gruppieren, je Gruppe nach id sortieren (stabile Reihenfolge).
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

    // Memory = zentraler Hub: dichte Fibonacci-Wolke, vertikal gestaucht.
    if (type === 'memory') {
      for (let i = 0; i < n; i++) {
        const d = fibDir(i, n);
        if (d.single) { pos.set(list[i].id, { x: 0.4, y: 0, z: 0.4 }); continue; }
        pos.set(list[i].id, {
          x: d.x * MEM_RADIUS,
          y: d.y * MEM_RADIUS * Y_SQUASH,
          z: d.z * MEM_RADIUS,
        });
      }
      continue;
    }

    // Alle anderen: FÄCHER im eigenen Winkel-Sektor + Radius-Band, 3 Radius-Reihen
    // für Volumen, leichte vertikale Streuung (deterministisch), dann Y gestaucht.
    const [cDeg, halfDeg, rMin, rMax] = ZONE[type] || DEFAULT_ZONE;
    const aMin = (cDeg - halfDeg) * DEG;
    const span = 2 * halfDeg * DEG;
    const rSpan = rMax - rMin;
    for (let i = 0; i < n; i++) {
      const t = n <= 1 ? 0.5 : i / (n - 1);
      const az = aMin + span * t;                 // über den Sektor sweepen (sortierter Index)
      const row = n <= 2 ? 1 : i % 3;             // 3 Radius-Reihen → gefüllter Fleck statt dünner Bogen
      const r = rMin + rSpan * ((row + 0.5) / 3);
      // vertikale Streuung aus dem goldenen Winkel (deterministisch, kein Zufall)
      const yv = (((i * 0.6180339887) % 1) - 0.5) * rSpan * 0.6;
      pos.set(list[i].id, {
        x: Math.cos(az) * r,
        y: yv * Y_SQUASH,
        z: Math.sin(az) * r,
      });
    }
  }
  return pos;
}

// Für HUD/Debug: Zonen-Mitten (read-only). Nutzbar später für Zonen-Anker-Labels.
export const zones = { ...ZONE, _memRadius: MEM_RADIUS, _ySquash: Y_SQUASH };
