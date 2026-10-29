import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { nodeColor, FLOW, BASE, LEGEND } from '../../palette.js';
import { makeLabelTexture } from './labelTexture.js';
import { liveStore } from '../live/store.js';
import { INSTANT } from './motion.js';

const KICKER = Object.fromEntries(LEGEND.nodes.map((n) => [n.type, n.label]));
KICKER.event = 'Aktivität';

export function colorFor(item) {
  if (item.type === 'event') return item.tokens > 0 ? FLOW.tokens : (item.bytes > 0 ? FLOW.bytes : BASE.dim);
  return nodeColor(item.type, item.meta);
}

// Platzhalter-Karte: eckige Box in Typ-Farbe + beschriftete Front (CanvasTexture).
// Billboard (Kamera-parallel), Hover-Skalierung, Einblend-Animation (ausser INSTANT).
export function Card({ item, slot, onPick, dim = false, kickerOverride }) {
  const color = colorFor(item);
  const kicker = kickerOverride || (item.type === 'event' && item.verb ? `Aktivität · ${item.verb}` : (KICKER[item.type] || item.type));
  const detailKey = item.detail ? item.detail.map((d) => d.join('=')).join('|') : '';
  const tex = useMemo(
    () => makeLabelTexture({ w: slot.w, h: slot.h, kicker, label: item.label, sub: item.sub, detail: item.detail, color }),
    // detail ueber detailKey stabil gehalten
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slot.w, slot.h, kicker, item.label, item.sub, detailKey, color],
  );
  useEffect(() => () => tex.dispose(), [tex]);

  const camera = useThree((s) => s.camera);
  const grp = useRef(null);
  const border = useRef(null);
  const [hover, setHover] = useState(false);
  const s = useRef(INSTANT ? 1 : 0.001);

  useFrame((_, dt) => {
    const g = grp.current; if (!g) return;
    g.quaternion.copy(camera.quaternion);
    const target = hover ? 1.07 : 1;
    s.current = INSTANT ? target : s.current + (target - s.current) * (1 - Math.exp(-Math.min(dt, 0.1) * 8));
    g.scale.setScalar(s.current);
    const m = border.current;
    if (m) m.emissiveIntensity = 0.12 + Math.min(1, liveStore.heat.get(item.id) || 0) * 0.9 + (hover ? 0.25 : 0);
  });

  const over = (e) => { e.stopPropagation(); setHover(true); document.body.style.cursor = 'pointer'; };
  const out = () => { setHover(false); document.body.style.cursor = ''; };
  useEffect(() => () => { document.body.style.cursor = ''; }, []);

  return (
    <group ref={grp} position={[slot.x, slot.y, slot.z]}
      onClick={(e) => { e.stopPropagation(); onPick && onPick(item); }}
      onPointerOver={over} onPointerOut={out}>
      <mesh>
        <boxGeometry args={[slot.w + 0.12, slot.h + 0.12, 0.2]} />
        <meshStandardMaterial ref={border} color={color} emissive={color} emissiveIntensity={0.12}
          roughness={0.6} metalness={0.1} transparent={dim} opacity={dim ? 0.5 : 1} />
      </mesh>
      <mesh position={[0, 0, 0.11]}>
        <planeGeometry args={[slot.w, slot.h]} />
        <meshBasicMaterial map={tex} toneMapped={false} transparent={dim} opacity={dim ? 0.55 : 1} />
      </mesh>
    </group>
  );
}
