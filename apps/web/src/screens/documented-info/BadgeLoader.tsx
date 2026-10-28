// Loads the sidebar badge of Required documented information (badge.ts) and renders nothing. A changed number asks the
// controller to render again through `ctx.track`, the only host call that renders the shell without other effects.
// Requests are never cancelled: an answer that comes after a newer one started is dropped instead.
import { useEffect, useRef } from 'react';
import type { ScreenProps } from '../types';
import { badgeKey, loadMissingCount, setBadgeCount } from './badge';

/** At most one background count per this many milliseconds and system, except on the screens that change the number. */
export const BADGE_REFRESH_MS = 30_000;
const EAGER = new Set(['docs', 'documented-info']);

export function BadgeLoader({ ctx }: ScreenProps) {
  const context = useRef(ctx);
  context.current = ctx;
  const last = useRef<{ key: string; at: number } | null>(null);
  const seq = useRef(0);
  const key = badgeKey(ctx);
  const generated = ctx.D?.generatedAt ?? '';
  useEffect(() => {
    if (!key) return undefined;
    const now = Date.now();
    const prev = last.current;
    if (prev && prev.key === key && now - prev.at < BADGE_REFRESH_MS && !EAGER.has(ctx.screen)) return undefined;
    last.current = { key, at: now };
    const mine = ++seq.current;
    void loadMissingCount(context.current).then((n) => {
      if (mine !== seq.current || n === null) return;
      if (setBadgeCount(key, n)) context.current.track(Promise.resolve()).catch(() => undefined);
    });
    return undefined;
  }, [key, ctx.screen, generated]);
  return null;
}
