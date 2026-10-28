// Orbital — nav/visibility.js
// Welche Sessions sind in der 3D-Ansicht sichtbar? Persistiert die AUSGEBLENDETEN ids in
// localStorage (Default: nichts ausgeblendet -> alle sichtbar, auch neue Sessions).
// Fail-open: localStorage kann fehlen/werfen -> In-Memory-Set reicht, nie ein Crash.
const KEY = 'orbital.hidden';
const subs = new Set();
const hidden = new Set();

try {
  const raw = localStorage.getItem(KEY);
  const arr = raw ? JSON.parse(raw) : [];
  if (Array.isArray(arr)) for (const id of arr) if (typeof id === 'string') hidden.add(id);
} catch (_) { /* leer starten */ }

function persist() {
  try { localStorage.setItem(KEY, JSON.stringify([...hidden])); } catch (_) { /* Quota/Privatmodus */ }
}
function emit() { for (const fn of subs) { try { fn(); } catch (_) { /* Subscriber darf nie killen */ } } }

export const visibility = {
  isVisible(id) { return !hidden.has(id); },
  toggle(id) {
    if (!id) return;
    if (hidden.has(id)) hidden.delete(id); else hidden.add(id);
    persist(); emit();
  },
  hiddenIds() { return [...hidden]; },
  subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
};
