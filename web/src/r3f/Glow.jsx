import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { EffectComposer, Bloom, Vignette, ToneMapping } from '@react-three/postprocessing';
import { NoToneMapping } from 'three';
import { ToneMappingMode } from 'postprocessing';

const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

// Bloom nur fuer helle Quellen (Kern + Signale): hoher Luminanz-Schwellwert, matte Knoten bleiben darunter.
// Renderer-Tonemapping aus; ACES als LETZTER Effekt (kein Doppel-Tonemapping).
export function Glow() {
  const gl = useThree((s) => s.gl);
  useEffect(() => { gl.toneMapping = NoToneMapping; }, [gl]);
  return (
    <EffectComposer multisampling={0}>
      <Bloom luminanceThreshold={0.6} luminanceSmoothing={0.2} intensity={coarse ? 0.7 : 0.9} mipmapBlur radius={0.6} />
      <Vignette eskil={false} offset={0.32} darkness={0.55} />
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
    </EffectComposer>
  );
}
