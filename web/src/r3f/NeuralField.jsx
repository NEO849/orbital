import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Raycaster, Vector2, Vector3 } from 'three';
import { createNodes } from '../nodes.js';
import { createStreamLines } from '../streamlines.js';
import { createFlows } from '../flows.js';
import { computeLayout } from '../layout.js';
import { liveStore } from '../live/store.js';
import { navStore } from '../nav/navStore.js';
import { log } from '../log.js';

const l = log.mod('neural');
const CLICK_DRAG_PX = 6;
const heatFn = (id) => liveStore.heat.get(id) || 0;
const byteHeatFn = (id) => liveStore.byteHeat.get(id) || 0;

// L0 als lebendes neuronales Netz: Neuronen (nodes), Synapsen-Adern (streams), feuernde
// Signal-Partikel (flows). Imperativ-Wrap wie CoreRig; nur auf Ebene 0 sichtbar.
// Jeder Schritt in try/catch -> ein Fehler darf nie die Szene (oder das DOM-HUD) killen.
export function NeuralField() {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const mods = useRef(null);       // { nodes, streams, flows, objs }
  const lastEv = useRef(null);     // zuletzt verarbeitetes Event (Identitaet) -> keine Duplikate
  const tmp = useRef(new Vector3());

  useEffect(() => {
    let nodes = null, streams = null, flows = null;
    const before = new Set(scene.children);
    try {
      nodes = createNodes(scene);
      streams = createStreamLines(scene);
      flows = createFlows(scene, (id) => (nodes ? nodes.getPosition(id) : null));
    } catch (e) { l.warn('Neuralfeld unvollstaendig:', e.message); }
    // Alles, was die Module in die Szene gehaengt haben -> gemeinsam ein-/ausblenden.
    const objs = scene.children.filter((c) => !before.has(c));
    mods.current = { nodes, streams, flows, objs };
    const evs = liveStore.events;
    lastEv.current = evs.length ? evs[evs.length - 1] : null;   // Historie nicht nachspielen

    const rebuild = () => {
      try {
        const st = liveStore.state; if (!st) return;
        const ents = st.entities || [], edges = st.edges || [];
        const layout = computeLayout(ents);
        const getPos = (id) => (nodes ? nodes.getPosition(id) : null);
        if (nodes) { nodes.update(ents, layout); nodes.updateEdges(edges, layout); }
        if (streams) { streams.rebuild(edges, getPos); streams.setActive(edges, heatFn, byteHeatFn); }
        if (flows) flows.setActive(edges, heatFn, byteHeatFn);
      } catch (e) { l.warn('rebuild:', e.message); }
    };
    let seenTopo = -1;
    const onStore = () => { if (liveStore.topoVersion !== seenTopo) { seenTopo = liveStore.topoVersion; rebuild(); } };
    const onHeat = () => {   // heat aendert sich ohne Topologie-Wechsel -> Adern neu gewichten
      try {
        const st = liveStore.state; if (!st) return;
        if (streams) streams.setActive(st.edges || [], heatFn, byteHeatFn);
        if (flows) flows.setActive(st.edges || [], heatFn, byteHeatFn);
      } catch (_) { /* egal */ }
    };
    const unsub = liveStore.subscribe(() => { onStore(); onHeat(); });
    onStore();

    return () => {
      unsub();
      for (const m of [flows, streams]) { try { m && m.destroy(); } catch (_) { /* egal */ } }
      try { nodes && nodes.group && scene.remove(nodes.group); } catch (_) { /* egal */ }
      for (const o of objs) { try { scene.remove(o); } catch (_) { /* egal */ } }
      mods.current = null;
    };
  }, [scene]);

  // Klick auf Neuron -> Drilldown (Drag < 6px = Klick, wie main.js). Nur auf L0.
  useEffect(() => {
    const el = gl.domElement;
    const rc = new Raycaster(), ndc = new Vector2();
    let dx = 0, dy = 0;
    const down = (e) => { dx = e.clientX; dy = e.clientY; };
    const up = (e) => {
      try {
        if (navStore.getSnapshot().level !== 0) return;
        if (Math.hypot(e.clientX - dx, e.clientY - dy) > CLICK_DRAG_PX) return;
        const m = mods.current; if (!m || !m.nodes) return;
        const r = el.getBoundingClientRect();
        ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
        rc.setFromCamera(ndc, camera);
        const id = m.nodes.raycast(rc);
        if (!id) return;
        const ent = ((liveStore.state && liveStore.state.entities) || []).find((x) => x && x.id === id);
        if (ent) navStore.focusInto(ent.id, ent.type);
      } catch (err) { l.warn('Klick:', err.message); }
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    return () => { el.removeEventListener('pointerdown', down); el.removeEventListener('pointerup', up); };
  }, [gl, camera]);

  useFrame((_, dt0) => {
    const m = mods.current; if (!m) return;
    const dt = Math.min(dt0, 0.1);
    const on = navStore.getSnapshot().level === 0;
    try {
      for (const o of m.objs) o.visible = on;
      if (m.streams) m.streams.setVisible(on);
    } catch (_) { /* egal */ }

    // Events -> Signale (immer Cursor vorschieben; nur auf L0 tatsaechlich spawnen)
    try {
      const evs = liveStore.events;
      if (evs.length) {
        let i = lastEv.current ? evs.lastIndexOf(lastEv.current) : -1;
        const fresh = evs.slice(i + 1);
        lastEv.current = evs[evs.length - 1];
        if (on && m.flows) for (const ev of fresh) { try { m.flows.spawn(ev); } catch (_) { /* egal */ } }
      }
    } catch (_) { /* egal */ }

    if (!on) return;
    try {
      const camDist = camera.position.length();
      if (m.nodes) m.nodes.tick(dt, camDist);
      if (m.streams) m.streams.tick(dt);
      if (m.flows) m.flows.tick(dt);
    } catch (e) { l.warn('tick:', e.message); }
  });
  return null;
}
