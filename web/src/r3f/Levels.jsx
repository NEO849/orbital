import { useMemo } from 'react';
import { useNavItems } from './useNav.js';
import { cardSlot, centerZ } from './levelLayout.js';
import { Card } from './Card.jsx';
import { navStore } from '../nav/navStore.js';
import { labelOf } from '../nav/hierarchy.js';

// Rendert die Kinder der aktuellen Ebene als Platzhalter-Karten (Bogen/Ring/Detail).
// Klick auf Karte -> tiefer; Klick auf das Eltern-Geist-Karte oben -> zurueck.
export function Levels() {
  const { nav, items } = useNavItems();
  const level = nav.level;
  const n = items.length;
  const key = (it) => it.id;

  const parent = useMemo(() => {
    if (level === 0) return null;
    const seg = nav.path[level - 1];
    return { id: 'parent:' + seg.id, type: seg.type, label: labelOf(seg), sub: 'zurück', meta: {} };
  }, [nav, level, items]); // items: Label kann sich mit State aendern

  const pick = (it) => { if (level < 3) navStore.focusInto(it.id, it.type); };

  return (
    <group>
      {level >= 1 && items.map((it, i) => (
        // level in der key: beim Ebenenwechsel frisch montieren (Einblend-Animation)
        <Card key={level + ':' + key(it)} item={it} slot={cardSlot(i, n, level)} onPick={pick} />
      ))}
      {parent && (
        <Card key={'parent:' + level} item={parent} dim
          slot={{ x: 0, y: 5.6, z: centerZ(level), w: 3, h: 1.5 }}
          onPick={() => navStore.back()} />
      )}
    </group>
  );
}
