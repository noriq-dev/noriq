/// <reference lib="webworker" />
import { computeConstellation3DLayout, type Constellation3DLayoutInput } from './constellation-3d-layout';

self.onmessage = (event: MessageEvent<Constellation3DLayoutInput>) => {
  self.postMessage(computeConstellation3DLayout(event.data));
};
