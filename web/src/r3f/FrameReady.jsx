import { useFrame } from '@react-three/fiber';

// Signal fuer die Screenshot-Harness: true erst nach dem ersten wirklich gerenderten Frame.
export function FrameReady() {
  useFrame(() => { if (!window.__frameReady) window.__frameReady = true; });
  return null;
}
