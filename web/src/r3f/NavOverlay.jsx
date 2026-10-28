import { useEffect } from 'react';
import { BASE } from '../../palette.js';
import { navStore } from '../nav/navStore.js';
import { labelOf } from '../nav/hierarchy.js';
import { useNavItems } from './useNav.js';

const btn = {
  background: BASE.panel, color: BASE.text, border: `1px solid ${BASE.line}`, borderRadius: 0,
  font: '12px ui-monospace, Menlo, Consolas, monospace', padding: '3px 8px', cursor: 'pointer',
  pointerEvents: 'auto',
};

// Breadcrumb + Zurueck (DOM ueber dem Canvas) und Esc -> navStore.back().
export function NavOverlay() {
  const { nav, items } = useNavItems();
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const t = e.target && e.target.tagName;
      if (t === 'INPUT' || t === 'TEXTAREA') return;
      navStore.back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div data-nav-overlay style={{ position: 'absolute', left: 8, top: 8, right: 8, pointerEvents: 'none',
      display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
      {nav.level > 0 && (
        <button type="button" style={btn} onClick={() => navStore.back()} aria-label="Eine Ebene zurück" title="Zurück (Esc)">
          ‹ Zurück
        </button>
      )}
      <button type="button" style={{ ...btn, color: nav.level === 0 ? BASE.text : BASE.muted }}
        onClick={() => navStore.reset()}>Orbital</button>
      {nav.path.map((seg, i) => (
        <span key={seg.id + i} style={{ display: 'inline-flex', gap: 6, alignItems: 'center', pointerEvents: 'none', color: BASE.dim }}>
          ›
          <button type="button" style={{ ...btn, color: i === nav.level - 1 ? BASE.text : BASE.muted }}
            onClick={() => navStore.goTo(i + 1 === nav.level ? nav.level : i + 1)}>
            {labelOf(seg)}
          </button>
        </span>
      ))}
      {nav.level === 0 && (
        <div id="orbital-core-label" style={{ position: 'fixed', left: 0, top: 0, opacity: 0, pointerEvents: 'none',
          color: BASE.text, font: '600 11px ui-monospace, Menlo, Consolas, monospace', letterSpacing: '0.28em',
          padding: '2px 9px', background: 'rgba(11,13,12,0.55)', border: `1px solid ${BASE.line}`,
          textShadow: `0 0 6px ${BASE.bg}`, whiteSpace: 'nowrap' }}>CLAUDE CODE</div>
      )}
      {items.length === 0 && (
        <span style={{ color: BASE.muted, font: '12px ui-monospace, Menlo, Consolas, monospace', pointerEvents: 'none' }}>
          {nav.level === 0 ? 'keine sichtbaren Sessions' : 'keine Daten auf dieser Ebene'}
        </span>
      )}
    </div>
  );
}
