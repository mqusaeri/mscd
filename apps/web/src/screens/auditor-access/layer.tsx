// The layer item of the "Auditor access" claim (MILESTONE-2 M2-15): the grant form opened from Audit readiness, loaded
// as a lazy chunk on first use.
import { Suspense, lazy, useSyncExternalStore } from 'react';
import type { ScreenProps } from '../types';
import { grantRequest, noteGranted, openGrant, subscribeGrant } from './store';

const GrantDialog = lazy(() => import('./GrantDialog'));
const none = () => null;

export function GrantLayer({ ctx }: ScreenProps) {
  const request = useSyncExternalStore(subscribeGrant, grantRequest, none);
  if (!request) return null;
  return (
    <Suspense fallback={null}>
      <GrantDialog
        key={request.at}
        ctx={ctx}
        ms={request.ms}
        onClose={() => openGrant(null)}
        onGranted={(text) => {
          openGrant(null);
          ctx.toast(text);
          noteGranted();
        }}
      />
    </Suspense>
  );
}
