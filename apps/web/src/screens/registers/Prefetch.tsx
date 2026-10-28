// The layer item of the Registers screen (MILESTONE-2 M2-13): renders nothing; when a system opens it loads the screen's
// code and reads the first page of the first register into cache.ts, so the screen shows its rows on its first render.
// The answer is kept even when the person has moved on (cache.ts is per organisation, person, persona and system).
import { useEffect, useRef } from 'react';
import type { ScreenProps } from '../types';
import { adapterFor, settled } from './adapter';
import { FIRST_KIND, PAGE_SIZE, PREFETCH_MAX_AGE_MS, cacheAge, cacheFirstPage, firstPageKey } from './cache';
import { preloadScreen } from './load';

/** Keys being read now, so a system that opens twice in a row is read once. */
const READING = new Set<string>();

export default function RegistersPrefetch({ ctx }: ScreenProps) {
  const context = useRef(ctx);
  context.current = ctx;
  const ms = ctx.msObj?.id ?? null;
  const key = ms ? firstPageKey(ctx, ms, FIRST_KIND) : null;
  useEffect(() => {
    if (!ms || !key) return;
    preloadScreen().catch(() => undefined);
    const age = cacheAge(key);
    if ((age !== null && age < PREFETCH_MAX_AGE_MS) || READING.has(key)) return;
    READING.add(key);
    void settled(adapterFor(() => context.current).list(ms, FIRST_KIND, { page: 1, pageSize: PAGE_SIZE })).then((res) => {
      READING.delete(key);
      if (res.ok) cacheFirstPage(key, res.data);
    });
  }, [key]);
  return null;
}
