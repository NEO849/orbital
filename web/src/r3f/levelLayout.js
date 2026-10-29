// Orbital — r3f/levelLayout.js
// Reine Geometrie des Tiefen-Flugs (kein React, kein three): wo steht die Kamera je Ebene,
// wo stehen die Karten. Jede Ebene hat ihr eigenes Zentrum, gestaffelt entlang -Z; die Kamera
// fliegt von Ebene zu Ebene (hinein = -Z, heraus = +Z).
export const LEVEL_DZ = 46;
export const centerZ = (level) => -LEVEL_DZ * level;

const R0 = 7.5;          // L0: Karten-Ring um den Kern
const R_ARC = 9.5;        // L1/L2: Bogen-Radius
const PER_ROW = 5;
const STEP = 28 * (Math.PI / 180);   // Winkelabstand der Karten im Bogen
const ROW_DY = 2.5;

// Kamera-Pose je Ebene. Abstand so, dass der Bogen/Ring auch bei schmalem Aspekt (Mobile)
// komplett im Bild liegt (Halbbreite ~10 Einheiten, fov 60).
export function poseFor(level, aspect) {
  const a = Math.max(0.4, aspect || 1.5);
  if (level <= 0) return { pos: [0, 4.5, Math.max(17, 20.5 / a)], look: [0, 0, 0] };
  const cz = centerZ(level);
  return { pos: [0, 2.5, cz + Math.max(16.5, 5.2 + 17.5 / a)], look: [0, 0, cz] };
}

// Position + Groesse der i-ten von n Karten. Rueckgabe: {x,y,z,w,h}.
export function cardSlot(i, n, level) {
  if (level >= 3) return { x: 0, y: 0, z: centerZ(3), w: 9, h: 7.5 };
  if (level <= 0) {
    const th = (2 * Math.PI * i) / Math.max(1, n);
    const w = Math.min(3.2, Math.max(2.2, ((2 * Math.PI * R0) / Math.max(1, n)) * 0.85));
    return { x: R0 * Math.sin(th), y: 0, z: R0 * Math.cos(th), w, h: w / 2 };
  }
  const cz = centerZ(level);
  const rows = Math.ceil(n / PER_ROW);
  const row = Math.floor(i / PER_ROW);
  const inRow = Math.min(PER_ROW, n - row * PER_ROW);
  const idx = i - row * PER_ROW;
  const span = (inRow - 1) * STEP;
  const a = inRow === 1 ? 0 : -span / 2 + idx * STEP;
  return {
    x: R_ARC * Math.sin(a),
    y: ((rows - 1) / 2 - row) * ROW_DY,
    z: cz + R_ARC * (1 - Math.cos(a)),
    w: 4.2, h: 2.1,
  };
}
