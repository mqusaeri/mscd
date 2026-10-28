// The edition transition drawer the Framework library page action asked for (MILESTONE-2 C.5, M2-09). Page actions
// receive no component state, so the action sets this small store and the layer item of actions.ts renders it.

let openedAt: number | null = null;
const listeners = new Set<() => void>();

/** Opens the drawer (a time stamp) or closes it (null). */
export function requestTransition(at: number | null): void {
  openedAt = at;
  for (const listener of [...listeners]) listener();
}

export function transitionRequest(): number | null {
  return openedAt;
}

export function subscribeTransition(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
