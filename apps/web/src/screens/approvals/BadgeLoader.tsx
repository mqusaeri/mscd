// Loads the sidebar badge of Pending approvals (badge.ts) and renders nothing. A changed number asks the controller to
// render again through `ctx.track`, the only host call that renders the shell without other effects.
import { useEffect, useRef } from 'react';
import type { ScreenProps } from '../types';
import { loadPendingCount, setBadgeCount } from './badge';

/** At most one background count per this many milliseconds, except on the screens that change the number. */
export const BADGE_REFRESH_MS = 30_000;
const EAGER = new Set(['users', 'approvals']);

export function BadgeLoader({ ctx }: ScreenProps) {
  const context = useRef(ctx);
  context.current = ctx;
  const last = useRef<{ key: string; at: number } | null>(null);
  const seq = useRef(0);
  const key = `${ctx.mode}:${ctx.org?.id ?? ''}:${ctx.me?.user.id ?? ctx.person.handle}`;
  useEffect(() => {
    const now = Date.now();
    const prev = last.current;
    if (prev && prev.key === key && now - prev.at < BADGE_REFRESH_MS && !EAGER.has(ctx.screen)) return undefined;
    last.current = { key, at: now };
    // Only the newest count applies, so a slow answer for an earlier organisation never replaces a newer one.
    const mine = ++seq.current;
    loadPendingCount(context.current).then((n) => {
      if (mine !== seq.current || n === null) return;
      if (setBadgeCount(n)) context.current.track(Promise.resolve()).catch(() => undefined);
    });
    return undefined;
  }, [key, ctx.screen]);
  return null;
}
