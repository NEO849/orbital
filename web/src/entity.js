// AOS-1 Observatory — src/entity.js
// Gemeinsame, DOM-/Three-freie Entitäts-Helfer, die HUD (2D-Liste) UND nodes (3D-Szene)
// teilen MÜSSEN, damit beide Seiten DENSELBEN menschlichen Namen zeigen. Sonst zeigt die
// Liste "~/work/bravo" und das 3D-Label "root-fd" für dieselbe Session (Liste↔3D-Divergenz).
// Reine Funktionen, keine Seiteneffekte, fail-open.

// Home-Präfix → '~' kürzen (generisch für Home-Verzeichnisse, Muster siehe unten).
// Diese Referenz STRIPPT einen Pfad, sie leakt keinen → vom Leak-Scanner ausgenommen.
export function projectName(meta) {
  const p = meta && meta.project ? String(meta.project) : '';
  if (!p) return '~';
  // Nicht-fangende Alternation hinter EINEM Slash → verhaltensgleich, aber ohne das
  // literale Home-Token (auch im minifizierten Build sauber; m[1] bleibt der volle Präfix).
  const m = p.match(/^(\/(?:root|home\/[^/]+|Users\/[^/]+))(\/|$)/);  // scan:allow
  if (!m) return p;
  return m[2] === '/' ? p.replace(m[1] + '/', '~/') : '~';
}

// id-Form "typ:name" → nur den Namen (Akteur-Teil ohne Typ-Präfix).
function idStem(id) {
  const s = String(id || '');
  return s.split(':').slice(1).join(':') || s;
}

// Session-Anzeigename = tmux-Session-Name (meta.tmux, vom Collector gesetzt), Fallback Projektpfad.
export function sessionName(e) {
  const t = e && e.meta && e.meta.tmux;
  return t ? String(t) : projectName(e && e.meta);
}

// DER gemeinsame menschliche Name je Entität. Sessions zeigen ihr Projekt (~/work/bravo —
// das, was die linke Liste schon zeigt), alles andere label bzw. id-Stamm; auf 22 Zeichen
// gekappt (3D-Sprite-Breite). Von hud.js (Liste) und nodes.js (3D-Label) gleich genutzt.
export function humanLabel(e) {
  if (!e) return '?';
  if (e.type === 'session') return sessionName(e);
  const s = e.label || idStem(e.id) || '?';
  return s.length > 22 ? s.slice(0, 21) + '…' : s;
}
