// The banner of the host layer (MILESTONE-3 M3-05, D.7 "Confirming"): "You have N policies to confirm" while the session
// person has open confirmations, with "Open Policies to confirm" and "Later" (put off for the rest of the page session,
// until another confirmation is asked). It renders nothing on the screen itself and while nothing waits. It also keeps
// the sidebar badge of "Policies to confirm" current: when the number of open confirmations changes, it asks the
// controller to render again through `ctx.track`, as the badge of Required documented information does.
import { useEffect, useRef } from 'react';
import type { ScreenProps } from '../types';
import { Button } from '../ui';
import { pendingOf } from '../invitations/model';
import { SCREEN_ID, openOf } from './model';
import { putOffBanner, useConfirmations } from './store';
import { TEXT } from './text';
import './my-confirmations.css';

export function ConfirmationBanner({ ctx }: ScreenProps) {
  const list = useConfirmations(ctx);
  const open = openOf(list.items ?? []);
  const badge = useRef(0);
  const track = useRef(ctx.track);
  track.current = ctx.track;
  useEffect(() => {
    if (badge.current === open.length) return;
    badge.current = open.length;
    track.current(Promise.resolve()).catch(() => undefined);
  }, [open.length]);
  if (!open.length || list.later || ctx.screen === SCREEN_ID) return null;
  const overdue = open.filter((c) => c.overdue).length;
  // The invitation banner takes the same corner in API builds; this one moves above it.
  const stacked = ctx.mode === 'api' && pendingOf(ctx).length > 0;
  return (
    <section className="mx-myc-banner" role="region" aria-label={ctx.li(TEXT.region)} data-confirmation-banner={open.length} data-stacked={stacked}>
      <h2 className="mx-myc-banner-title">{open.length === 1 ? ctx.li(TEXT.bannerOne) : ctx.fill(TEXT.bannerMany, { n: open.length })}</h2>
      <span className="mx-myc-banner-text">
        {ctx.li(TEXT.bannerText)}
        {overdue ? ` ${ctx.fill(TEXT.bannerOverdue, { n: overdue })}` : ''}
      </span>
      <span className="mx-btn-group" style={{ justifyContent: 'flex-end' }}>
        <Button variant="link" onClick={putOffBanner}>{ctx.li(TEXT.later)}</Button>
        <Button variant="primary" onClick={() => ctx.go(SCREEN_ID)}>{ctx.li(TEXT.bannerOpen)}</Button>
      </span>
    </section>
  );
}
