// The drawer a claim of the Storage repositories screen asked for (MILESTONE-2 C.5, M2-09): "Connect repository"
// opens the wizard and a card's "Settings" opens the settings of that repository, over the screen the person is on.
// Claims receive no component state, so they set this small store and the layer item of actions.ts renders the drawer.

export type StorageRequest =
  | { kind: 'connect'; at: number }
  | { kind: 'settings'; ref: string | null; slug: string | null; at: number };

let current: StorageRequest | null = null;
const listeners = new Set<() => void>();

/** Asks for a drawer (or closes it with null). */
export function requestStorage(request: StorageRequest | null): void {
  current = request;
  for (const listener of [...listeners]) listener();
}

/** The drawer asked for, or null. */
export function storageRequest(): StorageRequest | null {
  return current;
}

export function subscribeStorage(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
