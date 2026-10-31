// A change counter of Retention and disposal (MILESTONE-3 M3-06): every successful command bumps it, so the tabs and the
// detail extensions of documents and evidence read their lists again.
let version = 0;
const listeners = new Set<() => void>();

export function subscribeRetention(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const retentionVersion = (): number => version;

export function noteRetentionChanged(): void {
  version += 1;
  for (const l of [...listeners]) l();
}
