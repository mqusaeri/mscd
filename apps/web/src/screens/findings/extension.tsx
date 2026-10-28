// The wrapper actions.ts registers for the `req` detail (MILESTONE-2 C.5, M2-14): it loads the Open findings panel as a
// lazy chunk on first use, so the main bundle holds only this wrapper.
import { Suspense, lazy } from 'react';
import type { DetailProps } from '../types';

const OpenFindings = lazy(() => import('./OpenFindings'));

export function OpenFindingsExtension(props: DetailProps) {
  return (
    <Suspense fallback={null}>
      <OpenFindings {...props} />
    </Suspense>
  );
}
