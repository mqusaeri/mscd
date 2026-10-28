// The parts of the activity forms that actions.ts registers (MILESTONE-2 C.5, M2-11): the activity panel of the
// `activity` detail and the layer item that renders Record blocker when the claim asked for it. The forms load as a
// lazy chunk on first use.
import { Suspense, lazy, useSyncExternalStore } from 'react';
import type { DetailProps, ScreenProps } from '../types';
import { blockerRequest, requestBlocker, subscribeBlocker } from './store';

const ActivityPanel = lazy(() => import('./forms').then((m) => ({ default: m.ActivityPanel })));
const BlockerDialog = lazy(() => import('./forms').then((m) => ({ default: m.BlockerDialog })));

export function ActivityExtension(props: DetailProps) {
  return (
    <Suspense fallback={null}>
      <ActivityPanel {...props} />
    </Suspense>
  );
}

const none = () => null;

export function BlockerLayer({ ctx }: ScreenProps) {
  const request = useSyncExternalStore(subscribeBlocker, blockerRequest, none);
  if (!request) return null;
  return (
    <Suspense fallback={null}>
      <BlockerDialog key={request.at} ctx={ctx} ms={request.ms} activity={request.activity} onClose={() => requestBlocker(null)} />
    </Suspense>
  );
}
