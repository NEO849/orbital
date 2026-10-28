// AOS-1 Observatory — src/rates.js
// Verantwortung: EINZIG die Live-Token-/Daten-RATE je Entität (Session/Agent/…) aus
// dem Event-Strom ableiten. Reine Zustands-/Rechen-Einheit, KEIN DOM, KEIN Three.
//
// Prinzip: jedes eingehende Event trägt actor + tokens + bytes (siehe demo/collector).
// Wir summieren pro actor über ein gleitendes Zeitfenster und rechnen auf /Minute hoch.
// → echte Zahlen, kein Backend-Umbau, kein Fabrizieren.
//
//   rate = Σ(fenster) · (60000 / WINDOW_MS)
//
// Fail-open: ein kaputtes Event darf die Schleife nie brechen (Werte werden gefiltert).

const WINDOW_MS = 12000;   // gleitendes Fenster: kurz genug für „Echtzeit", lang genug für ruhige Zahlen

export function createRates(windowMs = WINDOW_MS) {
  const buckets = new Map();   // actorId -> Array<{ t, tok, byt }> (chronologisch)

  function add(ev) {
    if (!ev) return;
    const actor = ev.actor;
    if (!actor) return;
    const tok = Number(ev.tokens) || 0;
    const byt = Number(ev.bytes) || 0;
    if (!tok && !byt) return;               // reine Kontroll-Events tragen keine Last
    let arr = buckets.get(actor);
    if (!arr) { arr = []; buckets.set(actor, arr); }
    arr.push({ t: Date.now(), tok, byt });
  }

  function _prune(arr, now) {
    const cut = now - windowMs;
    let i = 0;
    while (i < arr.length && arr[i].t < cut) i++;
    if (i) arr.splice(0, i);                // alte Einträge vorne abschneiden
  }

  // Rate EINER Entität. Fehlt sie / ist das Fenster leer → {0,0} (nie null).
  function rateOf(actorId) {
    const arr = actorId ? buckets.get(actorId) : null;
    if (!arr || !arr.length) return { tokPerMin: 0, bytPerMin: 0 };
    const now = Date.now();
    _prune(arr, now);
    if (!arr.length) { buckets.delete(actorId); return { tokPerMin: 0, bytPerMin: 0 }; }
    let tok = 0, byt = 0;
    for (const e of arr) { tok += e.tok; byt += e.byt; }
    const f = 60000 / windowMs;
    return { tokPerMin: Math.round(tok * f), bytPerMin: Math.round(byt * f) };
  }

  return { add, rateOf };
}
