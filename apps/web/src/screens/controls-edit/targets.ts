// The targets of a system (`applicability.targets`, D.1), read once a minute at most for the badges of the entry panel
// (Written record required, Always applicable) and read again whenever the Add form opens. A write that adds an entry
// forgets the system's list.
import { useEffect, useState } from 'react';
import type { MsId } from '../../data/types';
import type { Result } from './common';
import type { ControlsAdapter, TargetItem } from './model';

const MAX_AGE_MS = 60_000;
const cache = new Map<string, { at: number; promise: Promise<Result<TargetItem[]>> }>();

/** The targets of a system: the cached list when it is fresh enough, else a new read. A failed read is not kept. */
export function loadTargets(adapter: Pick<ControlsAdapter, 'targets'>, scope: string, ms: MsId, fresh = false): Promise<Result<TargetItem[]>> {
  const key = `${scope}|${ms}`;
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < MAX_AGE_MS) return hit.promise;
  const promise = adapter.targets(ms).then((res) => {
    if (!res.ok && cache.get(key)?.promise === promise) cache.delete(key);
    return res;
  });
  cache.set(key, { at: Date.now(), promise });
  return promise;
}

/** Forgets the cached targets of a system (every system without one). */
export function forgetTargets(ms?: MsId): void {
  if (!ms) {
    cache.clear();
    return;
  }
  for (const key of [...cache.keys()]) if (key.endsWith(`|${ms}`)) cache.delete(key);
}

/** The targets of a system for a component; null while they load or when they could not be read. */
export function useTargets(adapter: Pick<ControlsAdapter, 'targets'>, scope: string, ms: MsId | null | undefined): TargetItem[] | null {
  const [state, setState] = useState<{ key: string; list: TargetItem[] | null }>({ key: '', list: null });
  const key = ms ? `${scope}|${ms}` : '';
  useEffect(() => {
    if (!ms) return undefined;
    let live = true;
    void loadTargets(adapter, scope, ms).then((res) => {
      if (live) setState({ key: `${scope}|${ms}`, list: res.ok ? res.data : null });
    });
    return () => {
      live = false;
    };
  }, [adapter, scope, ms]);
  return state.key === key ? state.list : null;
}
