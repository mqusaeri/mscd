// The parts of the document control package that actions.ts registers (MILESTONE-2 C.5, M2-12): the panel of the `doc`
// detail and the layer item that renders the open form. Both load their code as a lazy chunk on first use, so the main
// bundle holds only these wrappers and the small stylesheet.
import { Suspense, lazy, useSyncExternalStore } from 'react';
import type { DetailProps, ScreenProps } from '../types';
import { formRequest, subscribeForms } from './store';
import './docs-edit.css';

const DocPanel = lazy(() => import('./DocPanel'));
const Forms = lazy(() => import('./Forms'));

export function DocExtension(props: DetailProps) {
  return (
    <Suspense fallback={null}>
      <DocPanel {...props} />
    </Suspense>
  );
}

const none = () => null;

export function DocsLayer({ ctx }: ScreenProps) {
  const request = useSyncExternalStore(subscribeForms, formRequest, none);
  if (!request) return null;
  return (
    <Suspense fallback={null}>
      <Forms key={request.at} ctx={ctx} request={request} />
    </Suspense>
  );
}
