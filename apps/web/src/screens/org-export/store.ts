// The read-only period of the current organisation, shared by Organisation export and its banner in the host layer
// (MILESTONE-3 M3-09, D.2, D.5.1): `admin.organization.get` read once per session person and organisation, again when
// the screen reads it, and in the sample build again on every change of screen, so a move the sample operator makes in
// the operator console shows on the next screen. "Later" puts the banner off for the rest of the page session.
import { useEffect, useSyncExternalStore } from 'react';
import type { HostContext } from '../types';
import { adapterFor } from './adapter';
import type { Lifecycle } from './model';
import { settled } from './model';

export interface LifecycleState {
  /** `<person>:<organisation>` of the value; null before the first read. */
  key: string | null;
  data: Lifecycle | null;
  loading: boolean;
  /** The screen the value was read on (the sample build reads it again on another screen). */
  screen: string | null;
  /** The banner was put off ("Later") for this key in this page session. */
  later: boolean;
}

const EMPTY: LifecycleState = { key: null, data: null, loading: false, screen: null, later: false };
let state: LifecycleState = EMPTY;
const listeners = new Set<() => void>();

function set(next: Partial<LifecycleState>): void {
  state = { ...state, ...next };
  for (const l of [...listeners]) l();
}

export const lifecycleState = (): LifecycleState => state;

export function subscribeLifecycle(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Forgets the value (unit tests). */
export function resetLifecycle(): void {
  state = EMPTY;
  for (const l of [...listeners]) l();
}

/** The key of the session person and organisation. */
export function keyOf(ctx: Pick<HostContext, 'me' | 'person' | 'org'>): string {
  return `${ctx.me?.user.handle ?? ctx.person.handle}:${ctx.org?.id ?? ''}`;
}

/** Puts the banner off for the rest of the page session. */
export function putOffBanner(): void {
  set({ later: true });
}

/** The value the screen read: the banner and the screen show the same dates. */
export function noteLifecycle(ctx: Pick<HostContext, 'me' | 'person' | 'org' | 'screen'>, data: Lifecycle): void {
  const key = keyOf(ctx);
  set({ key, data, loading: false, screen: ctx.screen, later: state.key === key ? state.later : false });
}

/** Reads the value of the session through the build's adapter; a failed read keeps no value (no banner). */
export function loadLifecycle(ctx: HostContext): Promise<void> {
  const key = keyOf(ctx);
  if (state.key !== key) set({ key, data: null, later: false });
  set({ loading: true, screen: ctx.screen });
  return settled(adapterFor(ctx).lifecycle()).then((res) => {
    if (state.key !== key) return;
    set({ data: res.ok ? res.data : null, loading: false });
  });
}

/** The read-only period of the session, read when missing, of another person or organisation, or (sample) of another screen. */
export function useLifecycle(ctx: HostContext): LifecycleState {
  const current = useSyncExternalStore(subscribeLifecycle, lifecycleState, lifecycleState);
  const key = keyOf(ctx);
  const stale = current.key !== key || (ctx.mode === 'sample' && current.screen !== ctx.screen);
  useEffect(() => {
    if (stale && !current.loading && ctx.org) void loadLifecycle(ctx);
  }, [stale, key, ctx.screen, current.loading]);
  return current.key === key ? current : { ...EMPTY, key };
}
