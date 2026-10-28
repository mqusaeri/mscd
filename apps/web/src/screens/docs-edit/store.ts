// The open form of the document control package (MILESTONE-2 M2-12). Claims, the detail extension and Required
// documented information ask for a form here; the layer item of actions.ts renders it in the host layer (C.5), so a form
// stays open while the drawer or the screen behind it renders again. One form at a time.
import type { MsId } from '../../data/types';
import type { PickedFile } from '../types';
import type { Outcome, Prefill } from './model';

export type DocsRequest =
  | { type: 'new'; ms: MsId; prefill?: Prefill; onDone?: (outcome: Outcome, code: string) => void; at: number }
  | { type: 'review'; ms: MsId; code: string; at: number }
  | { type: 'edit'; ms: MsId; code: string; at: number }
  | { type: 'owner'; ms: MsId; code: string; at: number }
  | { type: 'reassign'; ms: MsId; code: string; at: number }
  | { type: 'upload'; ms: MsId; code: string; file: PickedFile; first: boolean; at: number };

/** A request without its time stamp (`openForm` adds it). */
export type DocsRequestInput = DocsRequest extends infer R ? (R extends DocsRequest ? Omit<R, 'at'> : never) : never;

let current: DocsRequest | null = null;
const listeners = new Set<() => void>();

export function formRequest(): DocsRequest | null {
  return current;
}

export function subscribeForms(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Opens a form (replacing the one that is open); null closes it. */
export function openForm(request: DocsRequestInput | null): void {
  current = request ? ({ ...request, at: Date.now() } as DocsRequest) : null;
  for (const l of [...listeners]) l();
}

export const closeForm = (): void => openForm(null);
