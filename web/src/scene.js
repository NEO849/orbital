// AOS-1 Observatory — src/scene.js
// Verantwortung: three-Grundgerüst (Renderer/Szene/Licht/Env/Fog/Kamera) +
// ein SELBSTGEROLLTER Orbit-Controller (keine OrbitControls-Dep). Kennt die
// Daten NICHT — nur Rendering + Kamerasteuerung. nodes/flows hängen sich an
// `scene` an; main treibt `tick(dt)`.
//
// Ästhetik-Rezepte aus graph3d.js (NICHT importiert, nachgebaut):
//   ACESFilmic + SRGB, prozedurale PMREM-Studio-Env für Metall-Reflexe,
//   Fog, Hemisphere+Key+Rim-Lichter. Graphit-Grund aus palette.
//
// Orbit-Mathe: Kamera sitzt in SPHÄRISCHEN Koordinaten (radius, yaw, pitch) um
// ein Ziel. Drag ändert yaw/pitch, Wheel den radius (geclamped). Im Leerlauf
// dreht der yaw sanft weiter (Auto-Orbit); jede Interaktion pausiert das für 3s.
// reduced-motion / Automation → kein Auto-Orbit.

import * as THREE from 'three';
import { BASE, hex0x } from '../palette.js';
import { log } from './log.js';

const l = log.mod('scene');

function reducedMotion() {
  try { return matchMedia('(prefers-reduced-motion:reduce)').matches; } catch { return false; }
}
function isAutomation() {
  try { return !!navigator.webdriver; } catch { return false; }
}

// Prozedurale Studio-Env (dunkle Box + Softbox-Streifen) → Metall-Reflexionen.
// Direkt aus dem Referenz-Rezept übernommen, Farben an Graphit angepasst.
function makeEnvTexture(renderer) {
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 256;
  const g = cv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#171d1a'); grad.addColorStop(0.55, '#0c0f0e'); grad.addColorStop(1, '#050706');
  g.fillStyle = grad; g.fillRect(0, 0, 512, 256);
  // helle Softbox-Streifen = Glanzlichter auf den Metall-Knoten
  g.fillStyle = 'rgba(190,208,222,0.50)'; g.fillRect(56, 36, 130, 26);
  g.fillStyle = 'rgba(150,170,185,0.42)'; g.fillRect(320, 58, 120, 20);
  g.fillStyle = 'rgba(225,234,242,0.34)'; g.fillRect(170, 150, 170, 14);
  const tex = new THREE.CanvasTexture(cv);
  tex.mapping = THREE.EquirectangularReflectionMapping; tex.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromEquirectangular(tex);
  tex.dispose(); pmrem.dispose();
  return rt.texture;
}

export function createScene(container) {
  let renderer;
  // ?capture -> Zeichenpuffer behalten, damit WebGL-Screenshots nicht schwarz werden
  // (Standard false = beste Performance; nur fuer Showcase/Screenshots einschalten).
  const captureMode = new URLSearchParams(location.search).has('capture');
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true, alpha: true, powerPreference: 'high-performance',
      preserveDrawingBuffer: captureMode,
    });
  } catch (e) {
    l.error('WebGL nicht verfügbar:', e.message);
    return null;   // main zeigt dann nur das HUD (graceful)
  }

  const sizeOf = () => [container.clientWidth || 1, container.clientHeight || 1];
  let [W, H] = sizeOf();
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(W, H);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;   // leicht runter → der weißglühende Strom-Spine blüht nicht aus
  Object.assign(renderer.domElement.style, { display: 'block', width: '100%', height: '100%' });
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.environment = makeEnvTexture(renderer);
  // Fog in Graphit → Tiefenstaffelung, äußere Schalen verblassen sanft.
  // 18/56: Außenzonen bei radius 26 sichtbar UND Zoom-out bis maxR 46 blendet nicht
  // die ganze Szene weg (Fog-Ferne > max Kamera+Graph-Radius).
  scene.fog = new THREE.Fog(hex0x(BASE.bg), 18, 56);

  const camera = new THREE.PerspectiveCamera(46, W / H, 0.1, 200);

  // Lichter: Hemisphere (Grundhelligkeit) + Key (Metall-Sheen) + 2 Rim-Punkte.
  scene.add(new THREE.HemisphereLight(0xaebecd, 0x0a0c10, 0.95));
  scene.add(new THREE.AmbientLight(0x6b7480, 0.35));
  const key = new THREE.DirectionalLight(0xffffff, 2.1); key.position.set(6, 10, 12); scene.add(key);
  const fill = new THREE.DirectionalLight(0xcdd6e0, 0.6); fill.position.set(-8, -3, 6); scene.add(fill);
  const rim = new THREE.PointLight(0x9fb4c4, 60, 50); rim.position.set(-8, 4, 6); scene.add(rim);

  // ── Orbit-Controller (sphärisch) ──────────────────────────────────────────
  const target = new THREE.Vector3(0, 0, 0);
  const orbit = {
    // Zentriertes „Zifferblatt"-Framing: radius 26 fasst die ganze Scheibe (r≈13 + Labels),
    // pitch 0.60 (~34°) balanciert Scheibe+Zonen mit Tiefe, yaw −1.57 holt die Session-Zone
    // (az 180°) nach vorn-unten → links/rechts ausgewogen statt links-lastig/schief.
    radius: 26, yaw: -1.57, pitch: 0.60,
    minR: 9, maxR: 46,
    minPitch: -1.35, maxPitch: 1.35,        // nie exakt über/unter den Pol (Gimbal)
    autoSpeed: 0.035,                        // rad/s Leerlauf-Drift um yaw (ruhiger → verweilt länger)
    pausedUntil: 0,                          // timestamp(ms), bis zu dem Auto-Orbit ruht
  };
  const AUTO = !reducedMotion() && !isAutomation();

  // Kameraposition aus (radius, yaw, pitch) setzen.
  function applyOrbit() {
    const cp = Math.cos(orbit.pitch), sp = Math.sin(orbit.pitch);
    camera.position.set(
      target.x + orbit.radius * cp * Math.sin(orbit.yaw),
      target.y + orbit.radius * sp,
      target.z + orbit.radius * cp * Math.cos(orbit.yaw),
    );
    camera.lookAt(target);
  }
  applyOrbit();

  // Drag-Rotation. pointer events decken Maus + Touch ab.
  let dragging = false, lastX = 0, lastY = 0;
  const DRAG_K = 0.005;   // rad pro px
  function onDown(e) { dragging = true; lastX = e.clientX; lastY = e.clientY; orbit.pausedUntil = performance.now() + 3000; }
  function onMove(e) {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    orbit.yaw -= dx * DRAG_K;
    orbit.pitch += dy * DRAG_K;
    // Pitch clampen → Kamera kippt nie über den Pol (sonst springt die Sicht).
    orbit.pitch = Math.max(orbit.minPitch, Math.min(orbit.maxPitch, orbit.pitch));
    orbit.pausedUntil = performance.now() + 3000;
    applyOrbit();
  }
  function onUp() { dragging = false; }
  function onWheel(e) {
    e.preventDefault();
    // multiplikativer Zoom → gefühlt gleichmäßig über den ganzen Bereich.
    const f = Math.exp(e.deltaY * 0.0012);
    orbit.radius = Math.max(orbit.minR, Math.min(orbit.maxR, orbit.radius * f));
    orbit.pausedUntil = performance.now() + 3000;
    applyOrbit();
  }
  const el = renderer.domElement;
  el.style.touchAction = 'none';
  el.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  el.addEventListener('wheel', onWheel, { passive: false });

  // Resize: Container-Maße → Renderer + Kamera-Aspekt.
  function resize() {
    [W, H] = sizeOf();
    renderer.setSize(W, H);
    camera.aspect = W / H; camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize); ro.observe(container);

  // Sichtbarkeits-Pause: Tab versteckt ODER Container aus dem Viewport → kein Render.
  let visible = true;
  const io = new IntersectionObserver((es) => es.forEach(e => (visible = e.isIntersecting)), { threshold: 0.01 });
  io.observe(container);
  const onVis = () => { /* document.hidden wird im tick abgefragt */ };
  document.addEventListener('visibilitychange', onVis);

  // tick(dt): Auto-Orbit fortschreiben + rendern. dt in Sekunden.
  // Gibt false zurück, wenn dieser Frame bewusst übersprungen wurde (Pause).
  function tick(dt) {
    if (!visible || document.hidden) return false;
    const now = performance.now();
    if (AUTO && !dragging && now >= orbit.pausedUntil) {
      orbit.yaw += orbit.autoSpeed * dt;    // sanfte Leerlauf-Drift
      applyOrbit();
    }
    renderer.render(scene, camera);
    return true;
  }

  l.info('Szene bereit', `${W}x${H}`, AUTO ? 'auto-orbit' : 'still');

  return {
    THREE, scene, camera, renderer, target, orbit, tick,
    get visible() { return visible; },
    destroy() {
      ro.disconnect(); io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      el.removeEventListener('wheel', onWheel);
      renderer.dispose();
      if (el.parentNode) el.parentNode.removeChild(el);
    },
  };
}
