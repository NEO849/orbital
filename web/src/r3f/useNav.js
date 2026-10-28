// Orbital — r3f/useNav.js
// React-Anbindung an navStore + (selten) liveStore/visibility: Items der aktuellen Ebene.
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { navStore } from '../nav/navStore.js';
import { childrenAt } from '../nav/hierarchy.js';
import { liveStore } from '../live/store.js';
import { visibility } from '../nav/visibility.js';

export function useNavSnapshot() {
  return useSyncExternalStore(navStore.subscribe, navStore.getSnapshot, navStore.getSnapshot);
}

export function useNavItems() {
  const nav = useNavSnapshot();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    const u1 = liveStore.subscribe(bump);   // ~alle 2 s (State-Poll)
    const u2 = visibility.subscribe(bump);
    return () => { u1(); u2(); };
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const items = useMemo(() => childrenAt(nav.path), [nav, tick]);
  return { nav, items };
}
