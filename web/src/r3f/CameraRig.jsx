import { useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Vector3 } from 'three';
import { poseFor } from './levelLayout.js';
import { navStore } from '../nav/navStore.js';
import { INSTANT } from './motion.js';

// Kamera-Besitz hat zu JEDEM Zeitpunkt genau EINER (sonst flackern zwei Controller gegeneinander):
//  - L0 (Überblick): sobald die Kamera an ihrer Überblick-Pose eingeschwungen ist, übernimmt
//    OrbitControls → freie Rotation um die eigenen Achsen (Drag) + Zoom (Rad), sanfte Auto-Rotation.
//  - L1..L3 (Tiefen-Flug): OrbitControls ist ABGEHÄNGT (nicht gemountet); CameraRig fliegt die
//    Kamera per exp. Dämpfung zur Pose der Ebene. Zurück/Esc fliegt heraus, dann greift wieder L0.
// So gibt es nie einen Frame, in dem Nav-Flug UND OrbitControls dieselbe Kamera setzen.
export function CameraRig() {
  const { camera, size } = useThree();
  const controls = useThree((s) => s.controls);   // von OrbitControls makeDefault gesetzt
  const look = useRef(new Vector3());
  const want = useRef(new Vector3());
  const first = useRef(true);
  // orbitReady steuert das MOUNTEN von OrbitControls: erst wenn die L0-Pose erreicht ist, damit
  // der Heraus-Flug (L1→L0) nicht mit OrbitControls kämpft. Bei L>0 sofort zurückgesetzt.
  const [orbitReady, setOrbitReady] = useState(false);

  useFrame((_, dt) => {
    const lvl = navStore.getSnapshot().level;
    const pose = poseFor(lvl, size.width / Math.max(1, size.height));

    // Kamera gehört OrbitControls? → Rig weicht komplett.
    if (lvl === 0 && orbitReady && controls) return;

    const [px, py, pz] = pose.pos;
    want.current.set(px, py, pz);

    if (INSTANT || first.current) {
      camera.position.copy(want.current);
      look.current.set(...pose.look);
      camera.lookAt(look.current);
      first.current = false;
      if (lvl === 0 && !orbitReady) setOrbitReady(true);
      return;
    }

    const k = 1 - Math.exp(-Math.min(dt, 0.1) * 2.6);
    camera.position.lerp(want.current, k);
    look.current.lerp(new Vector3(...pose.look), k);
    camera.lookAt(look.current);

    // Übergabe-Schwelle: an L0 nah genug → OrbitControls mounten. Weg von L0 → wieder abhängen.
    if (lvl === 0 && !orbitReady && camera.position.distanceTo(want.current) < 0.5) setOrbitReady(true);
    if (lvl !== 0 && orbitReady) setOrbitReady(false);
  });

  return orbitReady ? (
    <OrbitControls
      makeDefault
      enablePan={false}
      enableDamping
      dampingFactor={0.08}
      rotateSpeed={0.6}
      zoomSpeed={0.8}
      minDistance={5}
      maxDistance={70}
      autoRotate
      autoRotateSpeed={0.35}
      target={[0, 0, 0]}
    />
  ) : null;
}
