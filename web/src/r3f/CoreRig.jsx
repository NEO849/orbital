import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { createCore } from '../core.js';
import { liveStore } from '../live/store.js';
import { navStore } from '../nav/navStore.js';
import { log } from '../log.js';

const l = log.mod('corerig');

// Erdkern-Reaktor (core.js) per Imperativ-Wrap. Nur auf L0 sichtbar. Fail-open: Konstruktion
// in try/catch -> ohne Kern laeuft der Rest weiter. Volle L0-Optik (Bloom etc.) = W3.
export function CoreRig() {
  const scene = useThree((s) => s.scene);
  const core = useRef(null);
  useEffect(() => {
    try { core.current = createCore(scene); } catch (e) { l.warn('Kern uebersprungen:', e.message); }
    return () => { try { core.current && core.current.destroy(); } catch (_) { /* egal */ } core.current = null; };
  }, [scene]);
  useFrame((_, dt) => {
    const c = core.current; if (!c) return;
    try {
      c.setVisible(navStore.getSnapshot().level === 0);
      let mx = 0;
      for (const v of liveStore.heat.values()) if (v > mx) mx = v;
      c.setLoad(mx);
      c.tick(Math.min(dt, 0.1));
    } catch (_) { /* nie die Szene killen */ }
  });
  return null;
}
