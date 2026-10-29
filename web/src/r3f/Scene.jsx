import { Component } from 'react';
import { Canvas } from '@react-three/fiber';
import { BASE } from '../../palette.js';
import { log } from '../log.js';
import { FrameReady } from './FrameReady.jsx';
import { CameraRig } from './CameraRig.jsx';
import { CoreRig } from './CoreRig.jsx';
import { NeuralField } from './NeuralField.jsx';
import { Glow } from './Glow.jsx';
import { Levels } from './Levels.jsx';
import { NavOverlay } from './NavOverlay.jsx';

const l = log.mod('scene');

class ErrorBoundary extends Component {
  constructor(p) { super(p); this.state = { failed: false }; }
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e) { l.error('3D-Szene abgestuerzt (HUD laeuft weiter):', e && e.message); }
  render() { return this.state.failed ? null : this.props.children; }
}

function onCreated({ gl }) {
  const c = gl.domElement;
  c.addEventListener('webglcontextlost', (e) => { e.preventDefault(); l.warn('webglcontextlost'); });
  c.addEventListener('webglcontextrestored', () => l.info('webglcontextrestored'));
}

export function Scene() {
  const capture = new URLSearchParams(location.search).has('capture');
  return (
    <ErrorBoundary>
      <Canvas
        camera={{ fov: 60, near: 0.1, far: 400, position: [0, 7, 21] }}
        gl={{ preserveDrawingBuffer: capture }}
        style={{ position: 'absolute', inset: 0 }}
        onCreated={onCreated}
      >
        <color attach="background" args={[BASE.bg]} />
        <fogExp2 attach="fog" args={[BASE.bg, 0.022]} />
        <ambientLight intensity={0.6} />
        <directionalLight position={[3, 4, 5]} intensity={2} />
        <CameraRig />
        <CoreRig />
        <NeuralField />
        <Levels />
        <FrameReady />
        <Glow />
      </Canvas>
      <NavOverlay />
    </ErrorBoundary>
  );
}
