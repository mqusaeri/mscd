// The Record blocker request of the claim `phases.recordBlocker` (MILESTONE-2 C.5, M2-11). A claim receives no
// component state, so it sets this small store and the layer item of actions.ts renders the form.
import type { Activity, MsId } from '../../data/types';

export interface BlockerRequest {
  ms: MsId;
  activity: Activity;
  at: number;
}

let current: BlockerRequest | null = null;
const listeners = new Set<() => void>();

export function requestBlocker(request: BlockerRequest | null): void {
  current = request;
  for (const listener of [...listeners]) listener();
}

export function blockerRequest(): BlockerRequest | null {
  return current;
}

export function subscribeBlocker(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
