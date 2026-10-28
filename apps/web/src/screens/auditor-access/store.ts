// The grant form opened from Audit readiness ("Auditor access", claim `audit.auditorAccess`), rendered by the layer
// item of actions.ts, and a counter of grants made, so the Auditor access screen reads its list again (MILESTONE-2
// M2-15).
import type { MsId } from '../../data/types';

let open: { ms: MsId; at: number } | null = null;
let granted = 0;
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of [...listeners]) l();
};

export function subscribeGrant(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const grantRequest = (): { ms: MsId; at: number } | null => open;
export const grantsMade = (): number => granted;

export function openGrant(ms: MsId | null): void {
  open = ms ? { ms, at: Date.now() } : null;
  notify();
}

export function noteGranted(): void {
  granted += 1;
  notify();
}
