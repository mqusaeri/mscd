// The layer item of the repository administration (MILESTONE-2 C.5, M2-09): renders the drawer a claim asked for
// (store.ts) in the host layer, so "Connect repository" and "Settings" of the Storage repositories screen open over
// that screen. The drawers and adapters are a lazy chunk, loaded on the first request only.
import { Suspense, lazy, useSyncExternalStore } from 'react';
import type { ScreenProps } from '../types';
import { requestStorage, storageRequest, subscribeStorage } from './store';

const LayerHost = lazy(() => import('./LayerHost'));

const none = () => null;

export function StorageLayer({ ctx }: ScreenProps) {
  const request = useSyncExternalStore(subscribeStorage, storageRequest, none);
  if (!request) return null;
  return (
    <Suspense fallback={null}>
      <LayerHost key={request.at} ctx={ctx} request={request} onClose={() => requestStorage(null)} />
    </Suspense>
  );
}
