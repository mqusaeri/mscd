// The host context of the screen being rendered (MILESTONE-2 C.4), for components and hooks below a host screen or a
// detail extension. The controller builds the value once per render (`createHostContext` in host.tsx).
import { createContext, useContext } from 'react';
import type { HostContext } from '../types';

export const HostCtx = createContext<HostContext | null>(null);

/** The host context; throws outside a host screen, where no context exists. */
export function useHost(): HostContext {
  const ctx = useContext(HostCtx);
  if (!ctx) throw new Error('useHost: no host context (render inside a host screen or pass ctx)');
  return ctx;
}
