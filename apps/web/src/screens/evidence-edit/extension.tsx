// The parts of the evidence forms that actions.ts registers (MILESTONE-2 C.5, M2-11): the evidence panel of the `ev`
// detail, "Define evidence" of the `req` detail, and the layer item that renders the form a page action or a panel
// asked for (store.ts). The forms load as lazy chunks on first use.
import { Suspense, lazy, useSyncExternalStore } from 'react';
import type { DetailProps, ScreenProps } from '../types';
import { DefinePanel } from './DefinePanel';
import { evidenceRequest, requestEvidence, subscribeEvidence } from './store';

const EvidencePanel = lazy(() => import('./EvidencePanel'));
const NewEvidenceDialog = lazy(() => import('./dialogs').then((m) => ({ default: m.NewEvidenceDialog })));
const ThresholdsDialog = lazy(() => import('./ThresholdsDialog').then((m) => ({ default: m.ThresholdsDialog })));
const EvidenceForms = lazy(() => import('./dialogs').then((m) => ({ default: m.EvidenceForms })));

export function EvidenceExtension(props: DetailProps) {
  return (
    <Suspense fallback={null}>
      <EvidencePanel {...props} />
    </Suspense>
  );
}

export function DefineExtension(props: DetailProps) {
  return <DefinePanel {...props} />;
}

const none = () => null;

export function EvidenceLayer({ ctx }: ScreenProps) {
  const request = useSyncExternalStore(subscribeEvidence, evidenceRequest, none);
  if (!request) return null;
  const close = () => requestEvidence(null);
  return (
    <Suspense fallback={null}>
      {request.kind === 'new' ? <NewEvidenceDialog key={request.at} ctx={ctx} ms={request.ms} target={request.target} onClose={close} /> : null}
      {request.kind === 'limits' ? <ThresholdsDialog key={request.at} ctx={ctx} ms={request.ms} onClose={close} /> : null}
      {request.kind === 'edit' || request.kind === 'addTarget' || request.kind === 'removeTarget'
        ? <EvidenceForms key={request.at} ctx={ctx} request={request} onClose={close} />
        : null}
    </Suspense>
  );
}
