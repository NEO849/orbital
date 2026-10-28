import { useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Vector3 } from 'three';
import { poseFor } from './levelLayout.js';
import { navStore } from '../nav/navStore.js';
import { INSTANT } from './motion.js';

// Flug zwischen den Ebenen: Kamera gleitet (exp. Daempfung) zur Pose der aktuellen Ebene.
// Liest navStore direkt im Frame (kein Re-Render). Erster Frame + INSTANT setzen sofort.
export function CameraRig() {
  const { camera, size } = useThree();
  const look = useRef(new Vector3());
  const want = useRef(new Vector3());
  const first = useRef(true);
  const orbit = useRef(0);   // akkumulierter Auto-Rotations-Winkel (nur L0)
  useFrame((_, dt) => {
    const level = navStore.getSnapshot().level;
    const pose = poseFor(level, size.width / Math.max(1, size.height));
    // Sanfte Auto-Rotation nur im Ueberblick: das Netz lebt, ohne Interaktion. ~0.05 rad/s.
    if (level === 0) orbit.current += Math.min(dt, 0.1) * 0.05;
    const [px, py, pz] = pose.pos;
    const a = level === 0 ? orbit.current : 0;
    const ca = Math.cos(a), sa = Math.sin(a);
    want.current.set(px * ca + pz * sa, py, -px * sa + pz * ca);
    if (INSTANT || first.current) {
      camera.position.copy(want.current);
      look.current.set(...pose.look);
      first.current = false;
    } else {
      const k = 1 - Math.exp(-Math.min(dt, 0.1) * 2.6);
      camera.position.lerp(want.current, k);
      look.current.lerp(new Vector3(...pose.look), k);
    }
    camera.lookAt(look.current);
  });
  return null;
}
