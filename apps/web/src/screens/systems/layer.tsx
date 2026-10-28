// The layer item of the edition transition (MILESTONE-2 C.5, M2-09): renders the drawer the Framework library page
// action asked for (store.ts) in the host layer. The drawer is a lazy chunk, loaded on the first request only.
import { Suspense, lazy, useSyncExternalStore } from 'react';
import type { ScreenProps } from '../types';
import { requestTransition, subscribeTransition, transitionRequest } from './store';

const TransitionDrawer = lazy(() => import('./Transition'));

const none = () => null;

export function TransitionLayer({ ctx }: ScreenProps) {
  const at = useSyncExternalStore(subscribeTransition, transitionRequest, none);
  if (at === null) return null;
  return (
    <Suspense fallback={null}>
      <TransitionDrawer key={at} ctx={ctx} onClose={() => requestTransition(null)} />
    </Suspense>
  );
}
