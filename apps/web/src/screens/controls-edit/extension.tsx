// The parts of the controls and requirements forms that actions.ts registers (MILESTONE-2 C.5, M2-11): the entry
// panel of the `req` detail and the layer item that renders the form a claim or the entry panel asked for (store.ts).
// They load their code as lazy chunks on first use, so the main bundle holds only these wrappers.
import { Suspense, lazy, useSyncExternalStore } from 'react';
import type { DetailProps, ScreenProps } from '../types';
import { controlsRequest, requestControls, subscribeControls } from './store';

const EntryPanel = lazy(() => import('./EntryPanel'));
const AddDialog = lazy(() => import('./AddDialog'));
const EntryForms = lazy(() => import('./dialogs').then((m) => ({ default: m.EntryForms })));

export function EntryExtension(props: DetailProps) {
  return (
    <Suspense fallback={null}>
      <EntryPanel {...props} />
    </Suspense>
  );
}

const none = () => null;

export function ControlsLayer({ ctx }: ScreenProps) {
  const request = useSyncExternalStore(subscribeControls, controlsRequest, none);
  if (!request) return null;
  const close = () => requestControls(null);
  return (
    <Suspense fallback={null}>
      {request.kind === 'add'
        ? <AddDialog key={request.at} ctx={ctx} ms={request.ms} onClose={close} />
        : <EntryForms key={request.at} ctx={ctx} request={request} onClose={close} />}
    </Suspense>
  );
}
