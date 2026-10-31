// The tab of a host screen in the address (MILESTONE-2 M2-20): `tab=<id>`. The controller keeps the tab of the open
// screen and builds the host context with it (screens/host.tsx `createHostContext`); a screen reads and changes it
// with `useScreenTab`. Choosing a tab replaces the current history entry, so Back still leaves the screen.
//
// A context without the tab (a test context built by hand, or a context of another host) keeps the tab in the
// component, as the screens did before.
import { useCallback, useEffect, useState } from 'react';
import type { HostContext } from '../screens/types';

/** What the controller adds to the host context of the open screen. */
export interface ScreenTabAccess {
  /** The tab of the open screen named in the address, or null for the screen's first tab. */
  readonly tab: string | null;
  /** Shows a tab of the open screen and writes it to the address (null: the screen's first tab). */
  setTab(id: string | null): void;
}

export type RoutedHostContext = HostContext & ScreenTabAccess;

/** The tab access of a context, or null when the context has none. */
export function screenTabOf(ctx: HostContext): ScreenTabAccess | null {
  const c = ctx as Partial<ScreenTabAccess>;
  return typeof c.setTab === 'function' ? { tab: typeof c.tab === 'string' ? c.tab : null, setTab: c.setTab } : null;
}

/** The context with the tab access added (the same object). */
export function withScreenTab(ctx: HostContext, access: ScreenTabAccess): RoutedHostContext {
  return Object.assign(ctx, { tab: access.tab, setTab: access.setTab });
}

/**
 * The tab to show: `named` when the session may open it, else `fallback`. `stale` is true when a tab was named that
 * the session may not open (or that the screen does not have).
 */
export function tabChoice<T extends string>(named: string | null, ids: readonly T[], fallback: T): { current: T; stale: boolean } {
  const known = named !== null && (ids as readonly string[]).includes(named);
  return { current: known ? (named as T) : fallback, stale: named !== null && !known };
}

/**
 * The tab of a host screen and the function that changes it. `ids` are the tabs the session may open; `fallback`
 * is shown when the address names no tab, or one of another screen or one the session may not open. An address
 * with such a tab is corrected (replaced) once the screen shows.
 */
export function useScreenTab<T extends string>(ctx: HostContext, ids: readonly T[], fallback: T): [T, (id: T) => void] {
  const access = screenTabOf(ctx);
  const [local, setLocal] = useState<T>(fallback);
  const { current, stale } = tabChoice(access ? access.tab : local, ids, fallback);
  const routed = access !== null && stale;
  const set = access ? access.setTab : null;
  useEffect(() => {
    if (routed && set) set(null);
  }, [routed, set]);
  const choose = useCallback((id: T) => {
    if (set) set(id);
    else setLocal(id);
  }, [set]);
  return [current, choose];
}
