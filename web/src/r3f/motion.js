// Orbital — r3f/motion.js
// Soll animiert werden? Nein bei ?capture, prefers-reduced-motion oder navigator.webdriver
// (headless-sicher: Screenshots sehen sofort den End-Zustand).
export const INSTANT = (() => {
  try {
    return /[?&]capture(=|&|$)/.test(location.search)
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches
      || navigator.webdriver === true;
  } catch (_) { return true; }
})();
