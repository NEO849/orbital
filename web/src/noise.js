// AOS-1 Observatory — src/noise.js
// Verantwortung: die REINE Mathematik hinter organischer Bewegung — ein 3D-Simplex-
// Rauschfeld plus ein deterministischer ID-Hash. Keine Abhängigkeit, kein DOM, kein three.
// Gedacht als Treibstoff für ein Partikel-System: statt Zufall-pro-Frame (= Flackern) liefert
// Simplex-Noise ein GLATTES, zusammenhängendes, deterministisches Feld — fragt man zwei nahe
// Punkte ab, liegen die Werte nahe beieinander. Genau das lässt Partikel "strömen" statt zittern.
//
// Was ist Simplex-Noise (Kurz-Lehre)?
//  - Perlin-Noise (1985) legt ein Gitter aus WÜRFELN über den Raum und interpoliert zwischen
//    Zufalls-Gradienten an den Ecken. In 3D sind das 8 Ecken pro Zelle → teuer, und die
//    Achsen-Ausrichtung erzeugt sichtbare Richtungs-Artefakte.
//  - Simplex-Noise (Perlin 2001, hier der gemeinfreie Port à la Stefan Gustavson / Ashima)
//    kachelt den Raum stattdessen mit SIMPLICES — der einfachsten Form je Dimension. In 3D ist
//    das der Tetraeder: nur 4 statt 8 Ecken je Zelle → günstiger und ohne Gitter-Artefakte.
//
// Die drei Kern-Schritte (das "skew / grad / perm"-Rezept):
//  1) SKEW (Verzerrung): Das schräge Simplex-Gitter wird per F3 so verzerrt, dass es auf ein
//     normales ganzzahliges Würfel-Gitter fällt — dort findet man die umgebende Zelle mit
//     simplem Math.floor. Danach macht G3 die Verzerrung rückgängig ("unskew").
//  2) GRADIENT: Jeder Ecke wird über die Permutations-Tabelle ein Pseudo-Zufalls-Gradient aus
//     12 fest gewählten Kanten-Richtungen zugewiesen. Der Beitrag einer Ecke = (Abstands-
//     Abfall)^4 · (Gradient · Distanzvektor) → nahe Ecken zählen stark, ferne gar nicht.
//  3) PERMUTATION: Eine fest eingebaute, gemischte 0..255-Tabelle ersetzt echten Zufall durch
//     deterministisches Hashing der Ecken-Koordinaten → dasselbe (x,y,z) ergibt immer denselben
//     Wert, über Reloads und Maschinen hinweg. Keine Seed-Pflege, kein globaler Zustand.
//
// Robustheit (Senior-Stil, wie der Rest des Repos):
//  - Nicht-endliche Eingabe (NaN/±Infinity) → Rückgabe 0 statt NaN-Verseuchung des Feldes.
//  - Endausgabe hart auf [-1, 1] geklemmt (der 32er-Skalierungsfaktor kann minimal überschießen).
//  - Keine Globals, keine Seiteneffekte, keine Exceptions im heißen Pfad.

// Die 12 Gradient-Richtungen = die Kanten-Mittelpunkte eines Würfels. Bewusst NICHT die
// Ecken-Diagonalen (0,0,0)/(1,1,1): gleichmäßiger verteilte Richtungen → isotroperes Rauschen.
const GRAD3 = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

// Eingebaute Permutations-Tabelle (Perlins kanonische 256er-Reihe, gemeinfrei). Fest = das
// Feld ist ohne jede Seed-Verwaltung reproduzierbar. Sie ersetzt "echten" Zufall durch einen
// deterministischen Hash der Ecken-Indizes.
const P = [
  151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225,
  140, 36, 103, 30, 69, 142, 8, 99, 37, 240, 21, 10, 23, 190, 6, 148,
  247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32,
  57, 177, 33, 88, 237, 149, 56, 87, 174, 20, 125, 136, 171, 168, 68, 175,
  74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229, 122,
  60, 211, 133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54,
  65, 25, 63, 161, 1, 216, 80, 73, 209, 76, 132, 187, 208, 89, 18, 169,
  200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186, 3, 64,
  52, 217, 226, 250, 124, 123, 5, 202, 38, 147, 118, 126, 255, 82, 85, 212,
  207, 206, 59, 227, 47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170, 213,
  119, 248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43, 172, 9,
  129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232, 178, 185, 112, 104,
  218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12, 191, 179, 162, 241,
  81, 51, 145, 235, 249, 14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157,
  184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150, 254, 138, 236, 205, 93,
  222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215, 61, 156, 180,
];

// Doppelte Tabellen (512 Einträge) → der Wrap-around beim Indizieren (ii+1, jj+1, …) spart
// ein Modulo im heißen Pfad. permMod12 cached den 0..11-Index in GRAD3 pro Ecke.
const PERM = new Uint8Array(512);
const PERM_MOD12 = new Uint8Array(512);
for (let i = 0; i < 512; i++) {
  PERM[i] = P[i & 255];
  PERM_MOD12[i] = PERM[i] % 12;
}

// Skew-/Unskew-Konstanten für 3D: F3 verzerrt Raum → Gitter, G3 macht es rückgängig.
const F3 = 1 / 3;
const G3 = 1 / 6;

// Ecken-Beitrag: (Abstands-Abfall)^4 · (Gradient · Distanz). Außerhalb des Radius → 0.
// Der ^4-Abfall (t*t*t*t) macht die Übergänge zwischen Ecken C2-glatt (keine sichtbaren Kanten).
function corner(gi, x, y, z) {
  let t = 0.6 - x * x - y * y - z * z;   // 0.6 = Radius² des Ecken-Einflusses
  if (t < 0) return 0;
  t *= t;
  const g = GRAD3[gi];
  return t * t * (g[0] * x + g[1] * y + g[2] * z);
}

/**
 * simplex3(x, y, z) → float in [-1, 1].
 * Klassisches 3D-Simplex-Noise: glatt, zusammenhängend, deterministisch. Nicht-endliche
 * Eingabe ergibt 0; die Ausgabe ist hart auf [-1, 1] geklemmt und nie NaN.
 */
export function simplex3(x, y, z) {
  // Robustheit: ein einziges NaN/Infinity würde sonst das ganze Partikel-Feld vergiften.
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return 0;

  // (1) SKEW: Eingabe ins verzerrte Gitter heben, umgebende Zelle per floor finden.
  const s = (x + y + z) * F3;
  const i = Math.floor(x + s);
  const j = Math.floor(y + s);
  const k = Math.floor(z + s);
  // UNSKEW: Zellen-Ursprung zurück in den normalen Raum, Distanz zur ersten Ecke (x0,y0,z0).
  const t = (i + j + k) * G3;
  const x0 = x - (i - t);
  const y0 = y - (j - t);
  const z0 = z - (k - t);

  // (2) Welcher der 6 Tetraeder? Reihenfolge der Koordinaten-Größen x0/y0/z0 bestimmt den
  // "Treppen-Pfad" durch die Simplex-Ecken — i1/j1/k1 = erster Schritt, i2/j2/k2 = zweiter.
  let i1, j1, k1, i2, j2, k2;
  if (x0 >= y0) {
    if (y0 >= z0)      { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; } // X Y Z
    else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; } // X Z Y
    else               { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; } // Z X Y
  } else {
    if (y0 < z0)       { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; } // Z Y X
    else if (x0 < z0)  { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; } // Y Z X
    else               { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; } // Y X Z
  }

  // Distanzvektoren zu den übrigen 3 Ecken (jeweils um G3 "unskewed" verschoben).
  const x1 = x0 - i1 + G3,     y1 = y0 - j1 + G3,     z1 = z0 - k1 + G3;
  const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
  const x3 = x0 - 1 + 3 * G3,  y3 = y0 - 1 + 3 * G3,  z3 = z0 - 1 + 3 * G3;

  // (3) PERMUTATION: Ecken-Koordinaten durch die Tabelle hashen → Gradient-Index je Ecke.
  const ii = i & 255, jj = j & 255, kk = k & 255;
  const gi0 = PERM_MOD12[ii      + PERM[jj      + PERM[kk]]];
  const gi1 = PERM_MOD12[ii + i1 + PERM[jj + j1 + PERM[kk + k1]]];
  const gi2 = PERM_MOD12[ii + i2 + PERM[jj + j2 + PERM[kk + k2]]];
  const gi3 = PERM_MOD12[ii + 1  + PERM[jj + 1  + PERM[kk + 1]]];

  // Summe der 4 Ecken-Beiträge; 32 bringt den Wertebereich grob auf [-1, 1].
  const n = corner(gi0, x0, y0, z0) + corner(gi1, x1, y1, z1)
          + corner(gi2, x2, y2, z2) + corner(gi3, x3, y3, z3);
  const out = 32 * n;

  // Harte Garantie des Vertrags: nie NaN, nie außerhalb [-1, 1].
  if (!Number.isFinite(out)) return 0;
  return out < -1 ? -1 : out > 1 ? 1 : out;
}

/**
 * hash01(id) → float in [0, 1).
 * Deterministischer Hash einer (ganzzahligen oder Gleitkomma-) ID, z.B. um pro Partikel einen
 * festen Jitter/Phase/Offset zu "seeden": gleiche ID → gleicher Wert, verschiedene IDs →
 * gut gestreut. Nicht-endliche Eingabe ergibt 0. Reine Ganzzahl-Bit-Mischung (triple32-Stil).
 */
export function hash01(id) {
  if (!Number.isFinite(id)) return 0;
  // Float → uint32-Seed: Multiplikation mit einer großen Primzahl zieht auch Nachkommastellen
  // in die oberen Bits, damit nahe IDs (0.0 vs 0.1) verschieden hashen. >>>0 erzwingt uint32.
  let h = (Math.floor(id * 2654435761) >>> 0) ^ 0x9e3779b9;
  // Avalanche: xor-shift + Multiplikation mischt jedes Eingangs-Bit über die ganze Ausgabe.
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296; // /2^32 → [0, 1)
}

// --- SELF-TEST ---------------------------------------------------------------
// Läuft NUR, wenn die Datei direkt per `node src/noise.js` gestartet wird (nicht beim Import).
// Prüft den Vertrag mechanisch: Endlichkeit, Wertebereich, Glattheit (Kontinuität),
// Robustheit gegen Müll-Eingabe und den hash01-Bereich.
if (typeof process !== 'undefined' && process.argv && import.meta.url === `file://${process.argv[1]}`) {
  let fail = null;

  // (A) Endlichkeit + Bereich [-1, 1] auf einem 3D-Raster.
  const N = 24, step = 0.37;
  for (let a = 0; a < N && !fail; a++) {
    for (let b = 0; b < N && !fail; b++) {
      for (let c = 0; c < N && !fail; c++) {
        const v = simplex3(a * step, b * step, c * step);
        if (!Number.isFinite(v)) fail = `nicht-endlich @(${a * step},${b * step},${c * step}) = ${v}`;
        else if (v < -1 || v > 1) fail = `außerhalb [-1,1] @(${a * step},${b * step},${c * step}) = ${v}`;
      }
    }
  }

  // (B) Kontinuität: zwei um eps benachbarte Punkte dürfen sich nur minimal unterscheiden
  // (glattes Feld = kleine Lipschitz-Konstante). Großer Sprung ⇒ das Feld wäre unbrauchbar.
  const eps = 1e-3, maxDelta = 0.05;
  for (let s = 0; s < 4000 && !fail; s++) {
    const x = (s * 0.123) % 17, y = (s * 0.321) % 13, z = (s * 0.213) % 11;
    const d = Math.abs(simplex3(x, y, z) - simplex3(x + eps, y, z));
    if (d > maxDelta) fail = `Unstetigkeit @(${x},${y},${z}): Δ=${d} > ${maxDelta}`;
  }

  // (C) Robustheit: Müll-Eingabe ⇒ 0, nie NaN.
  if (!fail) {
    for (const bad of [NaN, Infinity, -Infinity]) {
      if (simplex3(bad, 0, 0) !== 0) { fail = `simplex3 behandelt ${bad} nicht`; break; }
      if (hash01(bad) !== 0) { fail = `hash01 behandelt ${bad} nicht`; break; }
    }
  }

  // (D) hash01-Vertrag: endlich und in [0, 1).
  for (let i = 0; i < 10000 && !fail; i++) {
    const h = hash01(i);
    if (!Number.isFinite(h) || h < 0 || h >= 1) fail = `hash01 außerhalb [0,1) @${i} = ${h}`;
  }

  if (fail) {
    console.error('noise.js self-test: FAIL —', fail);
    process.exit(1);
  }
  console.log('noise.js self-test: PASS');
}
