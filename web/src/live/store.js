// Orbital — live/store.js
// Framework-neutraler Mutable-Singleton: haelt den juengsten State + abgeleitete Daten
// (Layout, heat/byteHeat). KEIN React, KEIN three. Konsumenten lesen in useFrame direkt
// (kein Re-Render pro Tick); subscribe() nur fuer seltene Struktur-Aenderungen.
import { computeLayout } from '../layout.js';

const MAX_EVENTS = 200;
const MAX_PER_ACTOR = 40;
const subs = new Set();

function entitySig(entities) {
  return entities.map((e) => (e && e.id ? e.id + ':' + (e.type || '') : '')).sort().join('|');
}

export const liveStore = {
  state: null,
  layout: new Map(),
  heat: new Map(),
  byteHeat: new Map(),
  events: [],
  byActor: new Map(),   // id -> letzte ~40 Events, in denen id Akteur ODER Ziel ist
  topoVersion: 0,
  _sig: '',

  subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },

  setState(s) {
    const entities = (s && s.entities) || [];
    this.state = s;
    this.layout = computeLayout(entities);
    const heat = new Map(), byteHeat = new Map();
    for (const e of entities) if (e && e.id) {
      heat.set(e.id, e.heat || 0);
      byteHeat.set(e.id, e.byteHeat || (e.meta && e.meta.byteHeat) || 0);
    }
    this.heat = heat; this.byteHeat = byteHeat;
    const sig = entitySig(entities);
    if (sig !== this._sig) { this._sig = sig; this.topoVersion++; }
    for (const fn of subs) { try { fn(this); } catch (_) { /* Subscriber darf Store nie killen */ } }
  },

  pushEvents(evs) {
    if (!evs || !evs.length) return;
    this.events.push(...evs);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    for (const ev of evs) {
      if (!ev) continue;
      this._index(ev.actor, ev);
      if (ev.target && ev.target !== ev.actor) this._index(ev.target, ev);
    }
  },

  _index(id, ev) {
    if (!id) return;
    let a = this.byActor.get(id);
    if (!a) { a = []; this.byActor.set(id, a); }
    a.push(ev);
    if (a.length > MAX_PER_ACTOR) a.splice(0, a.length - MAX_PER_ACTOR);
  },

  // Letzte Events zu einer Entitaet (aeltestes zuerst). Leer, nie null.
  eventsFor(id) { return (id && this.byActor.get(id)) || []; },
};
