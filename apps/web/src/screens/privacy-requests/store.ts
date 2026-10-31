// A change counter of Personal data requests and Personal data checks (MILESTONE-3 M3-04): every successful command
// bumps it, so the lists and the open request read their data again.
import { useEffect, useState } from 'react';

let version = 0;
const listeners = new Set<() => void>();

export function subscribePrivacy(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const privacyVersion = (): number => version;

export function notePrivacyChanged(): void {
  version += 1;
  for (const l of [...listeners]) l();
}

/** The change counter as React state. */
export function usePrivacyVersion(): number {
  const [v, setV] = useState(privacyVersion());
  useEffect(() => subscribePrivacy(() => setV(privacyVersion())), []);
  return v;
}
