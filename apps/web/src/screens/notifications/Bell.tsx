// The notification bell of the top bar (MILESTONE-2 M2-16, hostTopbar slot): the unread count of
// `GET /notifications?unread=true&pageSize=1`, read when the app opens, every minute while the page is visible and the
// person used it in the last five minutes (poll.ts: a timer alone would keep an unattended session from expiring), on
// the first input after a quiet spell, after an organisation switch and after the panel closes (after "Open" once its
// Mark read is answered, so the count no longer holds the opened notification). The panel (Panel.tsx) loads on first
// open.
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ScreenProps } from '../types';
import { adapterFor } from './adapter';
import { startPolling } from './poll';
import { TEXT } from './text';
import './topbar.css';

const Panel = lazy(() => import('./Panel'));
const BELL = 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0';

/** The text of the count badge: the number, or 99+ above 99. */
export const countLabel = (n: number): string => (n > 99 ? '99+' : String(n));

/** Reads the unread count once `after` settles (the Mark read request of a notification opened from the panel), else at once. */
export function refreshAfter(after: Promise<unknown> | null | undefined, refresh: () => void): void {
  if (after) void after.then(refresh, refresh);
  else refresh();
}

export function NotificationBell({ ctx }: ScreenProps) {
  const data = useRef(ctx.D);
  data.current = ctx.D;
  const { client } = ctx;
  const adapter = useMemo(() => adapterFor(client, () => data.current), [client]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const live = useRef(true);
  const refresh = useCallback(() => {
    void adapter.unreadCount().then((res) => {
      if (live.current && res.ok) setUnread(res.data);
    });
  }, [adapter]);
  const org = ctx.org?.id ?? null;
  useEffect(() => {
    live.current = true;
    refresh();
    const stop = startPolling(refresh);
    return () => {
      live.current = false;
      stop();
    };
  }, [refresh, org]);
  const label = ctx.li(TEXT.bell);
  return (
    <>
      <button
        type="button"
        className="mx-topbtn"
        title={label}
        aria-label={unread ? ctx.fill(TEXT.bellUnread, { n: unread }) : label}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-topbar="notifications"
        onClick={() => setOpen(true)}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d={BELL} />
        </svg>
        {unread ? <span className="mx-topbtn-count" data-unread={unread} aria-hidden="true">{countLabel(unread)}</span> : null}
      </button>
      {open ? (
        <Suspense fallback={null}>
          <Panel ctx={ctx} adapter={adapter} onClose={(after) => { setOpen(false); refreshAfter(after, refresh); }} onUnread={setUnread} />
        </Suspense>
      ) : null}
    </>
  );
}
