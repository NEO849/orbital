// Orbital — nav/navStore.js
// Navigations-Zustand des Tiefen-Flugs. Mutable-Singleton (wie liveStore), React liest ueber
// useSyncExternalStore(subscribe, getSnapshot). Level 0 = Ueberblick (path leer),
// 1 = Session, 2 = Knoten (Agent/Pipeline/...), 3 = Detail. level === path.length (max 3).
// Der Pfad lebt in location.hash: #path=session:alpha/agent:crawler  (Deep-Link, Back-Button).
// Segment-Escape: nur '%' und '/' (ids enthalten ':' und bleiben lesbar).
const MAX_LEVEL = 3;
const subs = new Set();

const esc = (s) => String(s).replace(/%/g, '%25').replace(/\//g, '%2F');
const dec = (s) => { try { return decodeURIComponent(s); } catch (_) { return s; } };
// Typ = Praefix vor dem ersten ':' (session|agent|...|event). Ohne Praefix: 'event'.
const typeOf = (id) => { const i = id.indexOf(':'); return i > 0 ? id.slice(0, i) : 'event'; };

function parseHash() {
  try {
    const m = /(?:^#|&)path=([^&]*)/.exec(location.hash || '');
    if (!m || !m[1]) return [];
    return m[1].split('/').filter(Boolean).slice(0, MAX_LEVEL)
      .map((seg) => { const id = dec(seg); return { id, type: typeOf(id) }; });
  } catch (_) { return []; }
}

const samePath = (a, b) => a.length === b.length && a.every((x, i) => x.id === b[i].id);
const makeSnap = (path) => ({ level: path.length, path });

let snap = makeSnap(parseHash());

function writeHash(path) {
  try {
    const h = '#path=' + path.map((p) => esc(p.id)).join('/');
    if (location.hash !== h) location.hash = h;   // erzeugt History-Eintrag -> Browser-Back geht
  } catch (_) { /* kein DOM / gesperrt */ }
}
function emit() { for (const fn of subs) { try { fn(snap); } catch (_) { /* Subscriber darf nie killen */ } } }

function set(path, { hash = true } = {}) {
  if (samePath(path, snap.path)) return;
  snap = makeSnap(path);
  if (hash) writeHash(path);
  emit();
}

function onExternal() { set(parseHash(), { hash: false }); }
try {
  window.addEventListener('hashchange', onExternal);
  window.addEventListener('popstate', onExternal);
} catch (_) { /* kein window */ }

export const navStore = {
  subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  getSnapshot() { return snap; },
  focusInto(id, type) {
    if (!id || snap.level >= MAX_LEVEL) return;
    set([...snap.path, { id, type: type || typeOf(id) }]);
  },
  back() { if (snap.level > 0) set(snap.path.slice(0, -1)); },
  // Auf Tiefe n springen (Breadcrumb-Klick); 0 = Ueberblick.
  goTo(n) { if (n >= 0 && n < snap.level) set(snap.path.slice(0, n)); },
  reset() { set([]); },
};
