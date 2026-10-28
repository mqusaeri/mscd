// Requests of the evidence forms (MILESTONE-2 C.5, M2-11). A page action receives no component state, and the
// evidence panel lives in a drawer that closes when its row leaves the list after a save, so both set this small store
// and the layer item of actions.ts renders the form outside the drawer. `targetsVersion` tells an open evidence panel
// to read its targets again after a target was added or removed.
import { useSyncExternalStore } from 'react';
import type { Evidence, MsId } from '../../data/types';
import type { EvidenceTarget } from './model';

export type EvidenceRequest =
  | { kind: 'new'; ms: MsId; at: number; target?: string }
  | { kind: 'limits'; ms: MsId; at: number }
  | { kind: 'edit'; ms: MsId; at: number; evidence: Evidence }
  | { kind: 'addTarget'; ms: MsId; at: number; evidence: Evidence; existing: EvidenceTarget[] }
  | { kind: 'removeTarget'; ms: MsId; at: number; evidence: Evidence; target: EvidenceTarget };

let current: EvidenceRequest | null = null;
let version = 0;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of [...listeners]) listener();
};

/** Opens a form (a time stamp in `at`, so a second click opens a fresh one), or closes it (null). */
export function requestEvidence(request: EvidenceRequest | null): void {
  current = request;
  notify();
}

export function evidenceRequest(): EvidenceRequest | null {
  return current;
}

export function subscribeEvidence(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Marks the targets of evidence as changed, so open panels read them again. */
export function targetsChanged(): void {
  version += 1;
  notify();
}

export function useTargetsVersion(): number {
  return useSyncExternalStore(subscribeEvidence, () => version, () => 0);
}
