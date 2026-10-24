// AOS-1 Observatory — src/data.js
// Verantwortung: NUR Daten-Transport. Holt /state (alle 2s) + tailt
// /events?since=<offset> und ruft Callbacks. Kennt KEIN three, KEIN DOM.
//
// Robustheit (Vertrag aus dem Brief):
//  - Reconnect bei fetch-Fehler: letzten guten State behalten, Health-Indikator
//    auf "reconnecting" setzen, nie nach außen werfen.
//  - Event-Offset mitführen (Byte-Offset vom Server) → kein Doppel-Lesen.
//  - Fail-soft: eine kaputte Antwort pausiert nur diesen Tick.

import { log } from './log.js';

const l = log.mod('data');

const STATE_MS = 2000;   // /state-Poll-Takt
const EVENT_MS = 1000;   // /events-Tail-Takt (häufiger → flüssigere Flows)
const FETCH_TIMEOUT = 4000;

// fetch mit hartem Timeout (AbortController), gibt immer ein Result oder wirft.
async function getJSON(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT);
  try {
    const r = await fetch(url, { signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

export class StateClient {
  // base: z.B. '' (gleiche Origin). callbacks: {onState, onEvents, onHealth}
  constructor(base = '', { onState, onEvents, onHealth } = {}) {
    this.base = base.replace(/\/$/, '');
    this.onState = onState || (() => {});
    this.onEvents = onEvents || (() => {});
    this.onHealth = onHealth || (() => {});
    this.offset = 0;             // Byte-Offset ins events.jsonl (vom Server geführt)
    this.lastState = null;       // letzter GUTER State (bleibt bei Reconnect stehen)
    this.connected = false;
    this._timers = [];
    this._stopped = false;
    this._firstEvents = true;    // erster Event-Tail: Offset setzen, nicht alles replayen
  }

  start() {
    this._stopped = false;
    this._pollState();           // sofort einmal, dann im Intervall
    this._pollEvents();
    this._timers.push(setInterval(() => this._pollState(), STATE_MS));
    this._timers.push(setInterval(() => this._pollEvents(), EVENT_MS));
    l.info('StateClient gestartet', this.base || '(same-origin)');
  }

  stop() {
    this._stopped = true;
    this._timers.forEach(clearInterval);
    this._timers = [];
  }

  // Health-Status nach außen melden: 'ok' | 'reconnecting'. Wenn der State ein
  // eigenes health-dict trägt, wird es durchgereicht; sonst Transport-Status.
  _emitHealth(status) {
    this.connected = status === 'ok';
    const sources = (this.lastState && this.lastState.health) || {};
    this.onHealth({ transport: status, sources });
  }

  async _pollState() {
    if (this._stopped) return;
    try {
      const st = await getJSON(`${this.base}/state`);
      this.lastState = st;                // guter State → merken
      this._emitHealth('ok');
      this.onState(st);
    } catch (e) {
      // Reconnect: nichts werfen, letzten guten State NICHT verwerfen.
      l.warn('state-fetch fehlgeschlagen → reconnecting:', e.message);
      this._emitHealth('reconnecting');
    }
  }

  async _pollEvents() {
    if (this._stopped) return;
    try {
      const data = await getJSON(`${this.base}/events?since=${this.offset}`);
      // Server führt den neuen Byte-Offset zurück → den nächsten Tail dort starten.
      const nextOffset = typeof data.offset === 'number' ? data.offset : this.offset;
      const events = Array.isArray(data.events) ? data.events : [];
      if (this._firstEvents) {
        // Beim ersten Mal nur den Offset übernehmen (kein Burst alter Events beim Laden).
        this._firstEvents = false;
        this.offset = nextOffset;
        l.debug('Event-Offset initialisiert auf', nextOffset);
        return;
      }
      this.offset = nextOffset;
      if (events.length) this.onEvents(events);
    } catch (e) {
      l.warn('events-fetch fehlgeschlagen:', e.message);
      // Offset bleibt stehen → nächster Tick holt denselben Bereich erneut nach.
    }
  }
}
