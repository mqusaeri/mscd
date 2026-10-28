// The sidebar badge of Required documented information (MILESTONE-2 M2-12): the number of items with nothing in place
// (state `missing`) in the selected system. `count()` of the screen definition is synchronous, so the number is kept
// here per organisation and system: the layer item of actions.ts reads it when a system opens and again when the person
// moves between screens (at most every 30 seconds, at once on Document register and on this screen), and the screen
// sets it after each load and link. The read is one `documented-info.list` in API builds; the sample build counts the
// sample rows of this browser session.
import type { HostContext } from '../types';
import { adapterFor } from './adapter';
import { missingCount } from './model';

const counts = new Map<string, number>();

/** The key of the count: organisation and system. */
export function badgeKey(ctx: Pick<HostContext, 'org' | 'msObj'>): string | null {
  return ctx.msObj ? `${ctx.org?.id ?? ''}:${ctx.msObj.id}` : null;
}

/** The count of the selected system, 0 before it is known. */
export function badgeCount(ctx: Pick<HostContext, 'org' | 'msObj'>): number {
  const key = badgeKey(ctx);
  return key ? counts.get(key) ?? 0 : 0;
}

/** Sets the count of a key; true when the number changed. */
export function setBadgeCount(key: string, n: number): boolean {
  const next = Math.max(0, Math.floor(n) || 0);
  if (counts.get(key) === next) return false;
  counts.set(key, next);
  return true;
}

/** Forgets every count (unit tests). */
export function resetBadges(): void {
  counts.clear();
}

/** The number of missing items of the selected system; null when it could not be read. */
export async function loadMissingCount(ctx: HostContext): Promise<number | null> {
  const ms = ctx.msObj?.id;
  if (!ms) return null;
  const D = ctx.D;
  const res = await adapterFor(ctx.client, () => D).list(ms);
  return res.ok ? missingCount(res.data) : null;
}
