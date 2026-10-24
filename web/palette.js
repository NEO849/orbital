// AOS-1 Observatory — Farb-System (Single Source of Truth).
// Zwei unabhängige Achsen (Enterprise-Prinzip gegen "Regenbogen-Chaos"):
//   1) KNOTEN-Farbe = IDENTITÄT (was für ein Ding ist das) — matte Material-Töne.
//   2) STROM-Farbe  = TREIBSTOFF (was fließt)              — helle, additive Glows.
// Aktivität ändert NIE den Farbton eines Knotens, nur seine Helligkeit (Bloom →
// weißglühend). Identität bleibt dadurch immer lesbar.
//
// Diese Datei ist die EINZIGE Hex-Quelle der Web-App (token-guard: ERLAUBT).
// Für three.js: hex0x(PALETTE.node.memory). Für CSS/HUD: PALETTE.node.memory direkt.
// Der Remotion-Showcase zieht dieselben Werte (konsistent Live ↔ Kino).

export const BASE = {
  bg:     '#0b0d0c',   // Graphit-Grund (dunkles Graphit-Thema)
  panel:  '#121614',
  raised: '#1a1f1c',
  line:   'rgba(255,255,255,0.08)',
  text:   '#e8ecf2',
  muted:  '#9aa3b0',
  dim:    '#5b6472',
  white:  '#fff3d6',   // "weißglühend"-Ziel für Bloom auf aktiven Knoten
  zoneLine: '#6b7682', // Zonen-Box-Strichlinie — gedämpftes Hell-Graphit (hebt sich vom dunklen Grund ab; dunkle Töne wären bei jeder Opacity unsichtbar)
};

// --- Achse 2: Knoten-Identität (je Entitätstyp aus SCHEMA.md) ---------------
// 3-Band-System (Glance-Priorität): HERO poppt zuerst, MID ist nah/in-Legende
// unterscheidbar, BACKDROP tritt zurück. Identität = gedämpfter Tint + Form + ZONE;
// Sättigung/Helligkeit tragen ZUSTAND & STROM, nicht die Typ-Identität.
export const NODE = {
  session:   '#ef7d6e',  // HERO — Protagonist, einziger WARME Knoten; sauberes luminöses Korall (weg vom matten Braun; gleiche Helligkeits-/Luminanz-Register wie das Memory-Violett → beide lesen als Hero-Paar warm/kühl)
  memory:    '#a082ff',  // HERO — kognitives Zentrum (mehr Chroma → solider Violett-Körper, nicht Tint)
  agent:     '#4fd49a',  // MID — "Arbeiter" (heller → liest als solides Grün, nicht Grau-Grün)
  professor: '#4fd49a',  // MID — erbt Agent-Farbe; Unterfamilie nur via hellen Ring am Mesh
  pipeline:  '#5a8fd6',  // MID — Infrastruktur (Stahlblau, klar WEG vom Memory-Violett)
  tool:      '#8793a0',  // BACKDROP — viele, zurückhaltend (Luminanz rauf → kleine Tools lesbar)
  brett:     '#c9a24e',  // MID — Notizen (entsättigt, WEG vom Token-Amber)
  server:    '#5a6670',  // BACKDROP — reiner Rahmen (Schiefer, dim aber solide)
};

// Memory-Subtypen: EIN Violett-Fächer (gleiche Identität, feine Abstufung),
// damit die 6 memcluster unterscheidbar bleiben, ohne eine neue Hauptfarbe.
// Von 6 kaum trennbaren Violetten auf 3 reduziert (verlorene Komplexität vermeiden).
export const MEMORY_SUB = {
  feedback:  '#a082ff',
  project:   '#a082ff',
  reference: '#a082ff',
  user:      '#bfa8ff',
  profile:   '#bfa8ff',
  other:     '#7d70cc',
};

// --- Achse 1: Strom-Treibstoff (Flow-Farben, hell + additiv) ----------------
export const FLOW = {
  tokens: '#ffb000',   // Token-Strom (LLM denkt)       — Dichte = Token/s
  bytes:  '#19d3e6',   // Daten-Strom (Bytes/Durchsatz) — Dichte = MB/s
};

// Legende (für das HUD rechts): Reihenfolge = Anzeige-Reihenfolge.
export const LEGEND = {
  flows: [
    { key: 'tokens', label: 'Token-Strom', unit: 'tok/s', color: FLOW.tokens },
    { key: 'bytes',  label: 'Daten-Strom', unit: 'MB/s',  color: FLOW.bytes  },
  ],
  nodes: [
    { type: 'session',   label: 'Claude / Session', color: NODE.session },
    { type: 'memory',    label: 'Gedächtnis',        color: NODE.memory },
    { type: 'agent',     label: 'Agent',             color: NODE.agent },
    { type: 'professor', label: 'Professor',         color: NODE.professor },
    { type: 'pipeline',  label: 'Pipeline',          color: NODE.pipeline },
    { type: 'tool',      label: 'Tool',              color: NODE.tool },
    { type: 'brett',     label: 'Schwarzes Brett',   color: NODE.brett },
    { type: 'server',    label: 'Server',            color: NODE.server },
  ],
};

export const PALETTE = { base: BASE, node: NODE, memorySub: MEMORY_SUB, flow: FLOW, legend: LEGEND };

// '#rrggbb' -> 0xRRGGBB (für three.js Material/Color).
export const hex0x = (s) => parseInt(String(s).replace('#', ''), 16);

// Knotenfarbe nach Typ (+ Memory-Subtyp), mit sicherem Fallback.
export function nodeColor(type, meta) {
  if (type === 'memory' && meta && meta.memtype && MEMORY_SUB[meta.memtype]) {
    return MEMORY_SUB[meta.memtype];
  }
  return NODE[type] || BASE.muted;
}

// Flow-Farbe nach Metrik ('tokens' | 'bytes'), Fallback = Token-Bernstein.
export function flowColor(metric) {
  return FLOW[metric] || FLOW.tokens;
}
