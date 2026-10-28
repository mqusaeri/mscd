// The layer item of the Registers screen (MILESTONE-2 M2-13): the prefetch of Prefetch.tsx, a lazy chunk shared with the
// screen, rendered in the host layer on every screen except the Registers screen itself.
import { Suspense, lazy } from 'react';
import type { ScreenProps } from '../types';

const Prefetch = lazy(() => import('./Prefetch'));

export function RegistersLayer({ ctx }: ScreenProps) {
  return (
    <Suspense fallback={null}>
      <Prefetch ctx={ctx} />
    </Suspense>
  );
}
