// The caller's confirmations, shared by "Policies to confirm" and its banner in the host layer (MILESTONE-3 M3-05,
// D.7): one list per session person and organisation, loaded once and again after a confirmation or a request that may
// add one (`invalidateConfirmations`, which "Policy read confirmations" calls after "Ask for confirmation").
import { useEffect, useSyncExternalStore } from 'react';
import type { ApiError } from '../../data/api/ApiClient';
import type { HostContext } from '../types';
import { adapterFor } from './adapter';
import type { Confirmation } from './model';
import { settled } from './model';

export interface ConfirmationsState {
  /** `<person>:<organisation>` of the list; null before the first load. */
  key: string | null;
  items: Confirmation[] | null;
  loading: boolean;
  error: ApiError | null;
  /** Bumped by `invalidateConfirmations`: the next render loads again. */
  version: number;
  /** The version the items were loaded at. */
  loadedAt: number;
  /** The banner was put off ("Later") for this key in this page session. */
  later: boolean;
}

const EMPTY: ConfirmationsState = { key: null, items: null, loading: false, error: null, version: 0, loadedAt: -1, later: false };
let state: ConfirmationsState = EMPTY;
const listeners = new Set<() => void>();

function set(next: Partial<ConfirmationsState>): void {
  state = { ...state, ...next };
  for (const l of [...listeners]) l();
}

export function confirmationsState(): ConfirmationsState {
  return state;
}

export function subscribeConfirmations(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Forgets the list (unit tests). */
export function resetConfirmations(): void {
  state = EMPTY;
  seenData = null;
  for (const l of [...listeners]) l();
}

/** Marks the list stale, so the banner and the screen load it again. */
export function invalidateConfirmations(): void {
  set({ version: state.version + 1 });
}

/** Puts the banner off for the rest of the page session (until the list changes). */
export function putOffBanner(): void {
  set({ later: true });
}

/** The key of the session person and organisation. */
export function keyOf(ctx: Pick<HostContext, 'me' | 'person' | 'org'>): string {
  return `${ctx.me?.user.handle ?? ctx.person.handle}:${ctx.org?.id ?? ''}`;
}

/** Loads the list of the session through the build's adapter. */
export function loadConfirmations(ctx: HostContext): Promise<void> {
  const key = keyOf(ctx);
  const version = state.version;
  if (state.key !== key) set({ key, items: null, error: null, later: false });
  set({ loading: true });
  return settled(adapterFor(ctx).mine()).then((res) => {
    if (state.key !== key) return;
    if (res.ok) {
      const before = (state.items ?? []).filter((c) => c.status === 'pending').length;
      const after = res.data.filter((c) => c.status === 'pending').length;
      set({ items: res.data, loading: false, error: null, loadedAt: version, later: state.later && after <= before });
    } else {
      set({ loading: false, error: res.error, loadedAt: version });
    }
  });
}

/** The snapshot the list was last checked against: a new one (after a reload) may come with a new confirmation. */
let seenData: unknown = null;

/**
 * The list of the session, loaded when it is missing, stale or of another person or organisation, and checked again
 * after the controller loads a new snapshot (an approval by the session person may have asked them to confirm).
 */
export function useConfirmations(ctx: HostContext): ConfirmationsState {
  const current = useSyncExternalStore(subscribeConfirmations, confirmationsState, confirmationsState);
  const key = keyOf(ctx);
  const stale = current.key !== key || current.loadedAt !== current.version;
  useEffect(() => {
    if (!ctx.D || seenData === ctx.D) return;
    const first = seenData === null;
    seenData = ctx.D;
    if (!first) invalidateConfirmations();
  }, [ctx.D]);
  useEffect(() => {
    if (stale && !current.loading && ctx.org) void loadConfirmations(ctx);
  }, [stale, key, current.version, current.loading]);
  return current.key === key ? current : { ...EMPTY, key };
}
