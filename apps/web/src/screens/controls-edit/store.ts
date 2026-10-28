// Requests of the controls and requirements forms (MILESTONE-2 C.5, M2-11). A claim receives no component state, and
// the entry panel lives in a drawer that closes when its row leaves the list after a save, so both set this small
// store and the layer item of actions.ts renders the form outside the drawer.
import type { MsId } from '../../data/types';
import type { EntryRecord } from './common';

export type ControlsRequest =
  | { kind: 'add'; ms: MsId; at: number }
  | { kind: 'edit' | 'reject' | 'na' | 'delete'; ms: MsId; entry: EntryRecord; assessable: boolean; at: number };

let current: ControlsRequest | null = null;
const listeners = new Set<() => void>();

/** Opens a form (a time stamp in `at`, so a second click opens a fresh one), or closes it (null). */
export function requestControls(request: ControlsRequest | null): void {
  current = request;
  for (const listener of [...listeners]) listener();
}

export function controlsRequest(): ControlsRequest | null {
  return current;
}

export function subscribeControls(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
