// Orbital — src/core.js
// Verantwortung: der ERDKERN-REAKTOR im Zentrum (0,0,0) = das System/Claude. Alles geht von
// hier aus. Aufbau (nach dem Neural-Graph-Referenz-Rezept, in echtes 3D übersetzt):
//   1) Innen-Sphäre mit Noise-Displacement → Oberfläche "kocht" (organischer Reaktor),
//      Emissive-Gradient kühl→heiß entlang der Displacement-Höhe.
//   2) Additive Fresnel-Glow-Hülle (~1.5×, BackSide) → Rand leuchtet, Bloom-Ziel.
//   3) Gestrichelter, langsam rotierender Lock-Ring + weiter Faint-Ring (HUD-Portal-Optik).
//   4) Atmung + Helligkeit = AKTUELLE SYSTEMLAST (setLoad 0..1), nicht frei → Salience=Signal.
// Bloom-Layer 1 (selektiver Bloom greift). Fail-open: Konstruktion in try/catch beim Aufrufer.

import * as THREE from 'three';
import { BASE, FLOW } from '../palette.js';
import { log } from './log.js';

const l = log.mod('core');
const BLOOM_LAYER = 1;

// Ashima/Gustavson simplex noise (webgl-noise, public domain) — Standard für Displacement.
const SNOISE = `
  vec3 mod289(vec3 x){return x - floor(x*(1.0/289.0))*289.0;}
  vec4 mod289(vec4 x){return x - floor(x*(1.0/289.0))*289.0;}
  vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
  vec4 taylorInvSqrt(vec4 r){return 1.79284291400159 - 0.85373472095314*r;}
  float snoise(vec3 v){
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0,0.5,1.0,2.0);
    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 ll = 1.0 - g;
    vec3 i1 = min(g.xyz, ll.zxy);
    vec3 i2 = max(g.xyz, ll.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute( permute( permute(
               i.z + vec4(0.0, i1.z, i2.z, 1.0))
             + i.y + vec4(0.0, i1.y, i2.y, 1.0))
             + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ *ns.x + ns.yyyy;
    vec4 y = y_ *ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0)*2.0 + 1.0;
    vec4 s1 = floor(b1)*2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
    vec3 p0 = vec3(a0.xy,h.x);
    vec3 p1 = vec3(a0.zw,h.y);
    vec3 p2 = vec3(a1.xy,h.z);
    vec3 p3 = vec3(a1.zw,h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }`;

const CORE_VERT = `
  uniform float uTime; uniform float uAmp;
  varying float vN; varying vec3 vVN; varying vec3 vVP;
  ${SNOISE}
  void main(){
    float n = snoise(normalize(position) * 2.1 + vec3(0.0, uTime * 0.22, 0.0));
    vN = n;
    vec3 p = position + normal * n * uAmp;
    vVN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vVP = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }`;

const CORE_FRAG = `
  precision highp float;
  uniform vec3 uHot; uniform vec3 uWarm; uniform float uGlow;
  varying float vN; varying vec3 vVN; varying vec3 vVP;
  void main(){
    float h = smoothstep(-0.5, 0.65, vN);          // Täler kühl, Grate heiß
    vec3 N = normalize(vVN); vec3 V = normalize(-vVP);
    float fres = pow(1.0 - abs(dot(N, V)), 1.6);    // Rand zusätzlich aufheizen
    vec3 col = mix(uWarm, uHot, max(h, fres * 0.6)) * uGlow;
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }`;

const SHELL_VERT = `
  varying vec3 vVN; varying vec3 vVP;
  void main(){
    vVN = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vVP = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }`;

const SHELL_FRAG = `
  precision highp float;
  uniform vec3 uColor; uniform float uStrength;
  varying vec3 vVN; varying vec3 vVP;
  void main(){
    vec3 N = normalize(vVN); vec3 V = normalize(-vVP);
    float f = pow(1.0 - abs(dot(N, V)), 2.4);
    gl_FragColor = vec4(uColor * f * uStrength, f * 0.65);
    #include <colorspace_fragment>
  }`;

// Flacher Kreis (XZ-Ebene) als LineLoop-Geometrie, Radius r.
function circleGeo(r, segs) {
  const a = new Float32Array(segs * 3);
  for (let i = 0; i < segs; i++) {
    const t = (i / segs) * Math.PI * 2;
    a[i * 3] = Math.cos(t) * r; a[i * 3 + 1] = 0; a[i * 3 + 2] = Math.sin(t) * r;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(a, 3));
  return g;
}

const R_CORE = 1.35;   // etwas kompakter → gibt den Orbit-Knoten Luft (Design-Spezialist)

export function createCore(scene) {
  const group = new THREE.Group();
  scene.add(group);

  const amber = new THREE.Color(FLOW.tokens);   // #ffb000
  const hot = new THREE.Color(BASE.white);      // #fff3d6 — weißglühender Grat
  let load = 0;                                 // 0..1 Systemlast (setLoad)
  let t = 0;

  // 1) Innen-Reaktor (Noise-Displacement + Emissive-Gradient).
  const coreMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uAmp: { value: 0.14 },
      uHot: { value: hot }, uWarm: { value: amber }, uGlow: { value: 1.0 },
    },
    vertexShader: CORE_VERT, fragmentShader: CORE_FRAG,
  });
  const coreMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(R_CORE, 6), coreMat);
  coreMesh.layers.enable(BLOOM_LAYER); coreMesh.renderOrder = 1;
  group.add(coreMesh);

  // 2) Fresnel-Glow-Hülle (additiv, BackSide → Halo um den Kern).
  const shellMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: amber.clone() }, uStrength: { value: 0.9 } },
    vertexShader: SHELL_VERT, fragmentShader: SHELL_FRAG,
    transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, side: THREE.BackSide,
  });
  const shellMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(R_CORE * 1.4, 3), shellMat);
  shellMesh.layers.enable(BLOOM_LAYER); shellMesh.renderOrder = 2;
  group.add(shellMesh);

  // 3) Gestrichelter Lock-Ring (dreht langsam) + weiter Faint-Ring.
  const lockMat = new THREE.LineDashedMaterial({
    color: amber.clone(), transparent: true, opacity: 0.7,
    dashSize: 0.3, gapSize: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const lockRing = new THREE.LineLoop(circleGeo(R_CORE * 1.9, 128), lockMat);
  lockRing.computeLineDistances();
  lockRing.rotation.x = Math.PI * 0.5 * 0.0;   // bleibt in XZ (flach); kleine Neigung optional
  lockRing.layers.enable(BLOOM_LAYER); lockRing.renderOrder = 3;
  group.add(lockRing);

  const faintMat = new THREE.LineBasicMaterial({
    color: amber.clone(), transparent: true, opacity: 0.12,
    blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
  });
  const faintRing = new THREE.LineLoop(circleGeo(R_CORE * 2.0, 128), faintMat);
  faintRing.rotation.x = 0.35;   // leicht gekippt → 3D-Portal-Andeutung
  faintRing.renderOrder = 3;
  group.add(faintRing);

  l.info('Erdkern-Reaktor montiert');

  return {
    group,
    // Systemlast setzen (0..1): treibt Helligkeit + Atmungstiefe.
    setLoad(x) { load = Math.max(0, Math.min(1, Number(x) || 0)); },
    tick(dt) {
      t += dt;
      coreMat.uniforms.uTime.value = t;
      // Atmung: ruhiger Grundpuls, Amplitude + Helligkeit steigen mit der Last.
      // Deutlich gedämpft (User: nicht grell) — ruhig glühendes Zentrum, keine blendende Sonne.
      const pulse = 0.5 + 0.5 * Math.sin(t * 1.1);
      const lvl = 0.40 + 0.33 * load;                     // Idle 0.40, Voll-Last 0.73 → glüht, blendet nie
      coreMat.uniforms.uGlow.value = lvl * (0.9 + 0.1 * pulse);
      coreMat.uniforms.uAmp.value = 0.09 + 0.05 * load + 0.015 * pulse;
      // Halo-Bleed gedämpft (Design 2026-10-28): die additive Hülle fraß sonst die inneren
      // Memory-Neuronen → Kern bleibt hell, Glut-Fußabdruck enger, Nachbarn atmen.
      shellMat.uniforms.uStrength.value = (0.28 + 0.30 * load) * (0.85 + 0.15 * pulse);
      const sc = 1.0 + 0.03 * pulse + 0.04 * load;
      shellMesh.scale.setScalar(sc);
      lockRing.rotation.z += dt * 0.24;                   // langsame Dauerdrehung
      faintRing.rotation.z -= dt * 0.14;
      lockMat.opacity = 0.35 + 0.25 * load;
    },
    setVisible(b) { group.visible = !!b; },
    destroy() {
      coreMesh.geometry.dispose(); coreMat.dispose();
      shellMesh.geometry.dispose(); shellMat.dispose();
      lockRing.geometry.dispose(); lockMat.dispose();
      faintRing.geometry.dispose(); faintMat.dispose();
      scene.remove(group);
    },
  };
}
