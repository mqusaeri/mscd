// The banner of the host layer for Tenant Admins during the read-only period after a contract ends (MILESTONE-3 M3-09,
// D.2, D.5.1): "Read-only until <date>" with the planned deletion date, "Open Organisation export" and "Later" (put off
// for the rest of the page session). It renders nothing outside the read-only period and on Organisation export itself,
// which shows the same note at the top of the page. Nobody signs in to an archived organisation, so the reminders of the
// grace period go out by email (D.5.1). Its left edge follows the page column, so it never covers the sidebar.
import { useEffect, useState } from 'react';
import type { ScreenProps } from '../types';
import { Button } from '../ui';
import { SCREEN_ID, dayOf, inReadOnlyPeriod } from './model';
import { putOffBanner, useLifecycle } from './store';
import { TEXT } from './text';
import './org-export.css';

/** The left edge of the page column (`.mscd > main`), followed when the sidebar or the window changes size. */
function useColumnLeft(): number | null {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const main = document.querySelector('.mscd > main');
    if (!main) return undefined;
    const measure = () => setLeft(Math.max(0, Math.round(main.getBoundingClientRect().left)));
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(main);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
  return left;
}

export function ReadOnlyBanner({ ctx }: ScreenProps) {
  const state = useLifecycle(ctx);
  const left = useColumnLeft();
  const data = state.data;
  if (!data || !inReadOnlyPeriod(data) || state.later || ctx.screen === SCREEN_ID) return null;
  return (
    <section
      className="mx-oe-banner"
      role="region"
      aria-label={ctx.li(TEXT.region)}
      data-read-only-banner={data.offboardingEndsAt}
      style={left !== null ? { left: left + 24 } : undefined}
    >
      <h2 className="mx-oe-banner-title">{ctx.fill(TEXT.bannerTitle, { date: dayOf(ctx, data.offboardingEndsAt) })}</h2>
      <span className="mx-oe-banner-text">
        {ctx.li(TEXT.bannerText)}
        {' '}
        {data.deletionScheduledFor ? ctx.fill(TEXT.bannerDeletion, { date: dayOf(ctx, data.deletionScheduledFor) }) : ctx.li(TEXT.bannerNoDate)}
      </span>
      <span className="mx-btn-group" style={{ justifyContent: 'flex-end' }}>
        <Button variant="link" onClick={putOffBanner}>{ctx.li(TEXT.later)}</Button>
        <Button variant="primary" onClick={() => ctx.go(SCREEN_ID)}>{ctx.li(TEXT.bannerOpen)}</Button>
      </span>
    </section>
  );
}
