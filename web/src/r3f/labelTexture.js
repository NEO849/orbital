// Orbital — r3f/labelTexture.js
// Karten-Beschriftung als CanvasTexture (KEIN troika/drei-<Text>: laedt externe Fonts, verboten).
// Nur System-Fonts. Farben aus palette.js. Fail-open: ohne 2D-Context -> leere Textur.
import { CanvasTexture, SRGBColorSpace } from 'three';
import { BASE } from '../../palette.js';

const SANS = '-apple-system, "Segoe UI", Helvetica, Arial, sans-serif';
const MONO = 'ui-monospace, Menlo, Consolas, monospace';

// Text auf maxW einkuerzen (Auslassungszeichen), damit nichts ueber den Rand laeuft.
function fit(ctx, text, maxW) {
  let s = String(text || '');
  if (ctx.measureText(s).width <= maxW) return s;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

// spec: { w, h (Karten-Aspekt), kicker, label, sub, detail:[[k,v]], color }
export function makeLabelTexture(spec) {
  const CW = 512;
  const CH = Math.max(64, Math.round(CW * (spec.h / spec.w)));
  const cv = document.createElement('canvas');
  cv.width = CW; cv.height = CH;
  const ctx = cv.getContext('2d');
  if (ctx) {
    ctx.fillStyle = BASE.panel; ctx.fillRect(0, 0, CW, CH);
    ctx.fillStyle = spec.color; ctx.fillRect(0, 0, 10, CH);          // Typ-Akzent links
    const x = 30, maxW = CW - x - 20;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = BASE.muted; ctx.font = `600 26px ${SANS}`;
    ctx.fillText(fit(ctx, String(spec.kicker || '').toUpperCase(), maxW), x, 46);
    ctx.fillStyle = BASE.text; ctx.font = `700 ${spec.detail ? 44 : 58}px ${SANS}`;
    ctx.fillText(fit(ctx, spec.label, maxW), x, spec.detail ? 100 : 118);
    if (spec.detail) {
      ctx.font = `500 26px ${MONO}`;
      let y = 152;
      for (const [k, v] of spec.detail) {
        if (y > CH - 14) break;
        ctx.fillStyle = BASE.muted; ctx.fillText(k, x, y);
        ctx.fillStyle = BASE.text; ctx.fillText(fit(ctx, v, maxW - 190), x + 190, y);
        y += 36;
      }
    } else if (spec.sub) {
      ctx.fillStyle = BASE.muted; ctx.font = `500 32px ${MONO}`;
      ctx.fillText(fit(ctx, spec.sub, maxW), x, 118 + 50);
    }
  }
  const tex = new CanvasTexture(cv);
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
