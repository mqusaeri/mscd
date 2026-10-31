// The parts of read confirmation that actions.ts registers (MILESTONE-3 M3-05, C.5): the section of the `doc` detail.
// It loads its code as a lazy chunk on first use, so the main bundle holds only this wrapper and the small stylesheet.
import { Suspense, lazy } from 'react';
import type { DetailProps } from '../types';
import './acknowledgements.css';

const DocSection = lazy(() => import('./DocSection'));

export function AcknowledgementDocExtension(props: DetailProps) {
  return (
    <Suspense fallback={null}>
      <DocSection {...props} />
    </Suspense>
  );
}
