// The code of the Registers screen (MILESTONE-2 M2-13), a lazy chunk. `preloadScreen` loads it ahead (Prefetch.tsx);
// once it is loaded, `screenModule` hands it to React.lazy at once through a thenable that resolves synchronously, so
// opening the screen shows its body on the first render instead of the loading line.
import type { ComponentType } from 'react';
import type { ScreenProps } from '../types';

type ScreenModule = { default: ComponentType<ScreenProps> };

let loaded: ScreenModule | null = null;
let pending: Promise<ScreenModule> | null = null;

export function preloadScreen(): Promise<ScreenModule> {
  pending ??= import('./Screen').then(
    (m) => {
      loaded = m;
      return m;
    },
    (e: unknown) => {
      pending = null;
      throw e;
    },
  );
  return pending;
}

/** The screen module for React.lazy: synchronous once loaded, else the import. */
export function screenModule(): Promise<ScreenModule> {
  if (loaded) {
    const module = loaded;
    return { then: (resolve: (m: ScreenModule) => unknown) => resolve(module) } as unknown as Promise<ScreenModule>;
  }
  return preloadScreen();
}
