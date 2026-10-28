// The notification panel (MILESTONE-2 M2-16): a drawer with the session user's notifications, newest first, paged,
// "Mark read" per notification, "Mark all read", "Open" to the screen of the record (which also marks it read), and
// the "all caught up" picture when nothing is left to read.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Illustration } from '../../illustrations';
import { canOpenHost, hostById } from '../host';
import type { HostContext } from '../types';
import { Alert, Badge, Button, Checkbox, Drawer, EmptyState, Pager } from '../ui';
import { PAGE_SIZE, linkOf, whenOf } from './model';
import type { Link, NotificationModel, NotificationPage, NotificationsAdapter, Result } from './model';
import { TEXT } from './text';

/** The link of a notification when the session may open its screen (host screens through the registry's rule). */
export function openableLink(ctx: HostContext, n: NotificationModel): Link | null {
  const link = linkOf(ctx, n);
  if (!link) return null;
  if (hostById(link.screen)) return canOpenHost(link.screen, ctx, ctx.role) ? link : null;
  return link;
}

export function NotificationItem({ ctx, n, busy, onRead, onOpen }: {
  ctx: HostContext;
  n: NotificationModel;
  busy: boolean;
  onRead(n: NotificationModel): void;
  onOpen(n: NotificationModel, link: Link): void;
}) {
  const link = openableLink(ctx, n);
  const system = n.ms ? (ctx.D?.MS ?? []).find((m) => m.id === n.ms)?.short ?? n.ms.toUpperCase() : null;
  return (
    <li
      data-notification={n.id}
      data-unread={n.readAt ? undefined : ''}
      style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 14px', border: '1px solid var(--bd)', borderRadius: 'var(--r)', background: n.readAt ? 'var(--sur)' : 'var(--sur2)' }}
    >
      <div className="mx-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <span style={{ fontWeight: 600, color: 'var(--tx)', minWidth: 0, overflowWrap: 'anywhere' }}>{ctx.li(n.title)}</span>
        {n.readAt ? null : <Badge tone="acc">{ctx.li(TEXT.unread)}</Badge>}
      </div>
      <span style={{ color: 'var(--tx)', overflowWrap: 'anywhere' }}>{ctx.li(n.body)}</span>
      <span className="mx-small">{system ? `${system}, ${whenOf(ctx, n.createdAt)}` : whenOf(ctx, n.createdAt)}</span>
      {link || !n.readAt ? (
        <div className="mx-btn-group">
          {link ? <Button variant="primary" onClick={() => onOpen(n, link)}>{ctx.li(TEXT.open)}</Button> : null}
          {n.readAt ? null : <Button busy={busy} onClick={() => onRead(n)}>{ctx.li(TEXT.markRead)}</Button>}
        </div>
      ) : null}
    </li>
  );
}

/**
 * Turns of the panel's reads: each read takes a turn, and only the answer of the newest turn may be applied, so an
 * older read that answers late (the full list asked just before "Show unread only") never replaces a newer one.
 */
export function readTurns(): () => () => boolean {
  let newest = 0;
  return () => {
    const mine = ++newest;
    return () => mine === newest;
  };
}

export default function NotificationsPanel({ ctx, adapter, onClose, onUnread }: {
  ctx: HostContext;
  adapter: NotificationsAdapter;
  /** Closes the panel; `after` is the Mark read request of an opened notification, which the unread count waits for. */
  onClose(after?: Promise<unknown> | null): void;
  onUnread(n: number): void;
}) {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Result<NotificationPage> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<Result<null> | null>(null);
  const [unreadTotal, setUnreadTotal] = useState<number | null>(null);
  const [nextTurn] = useState(readTurns);
  const load = useCallback(() => {
    const newest = nextTurn();
    void adapter.list({ page, pageSize: PAGE_SIZE, unreadOnly }).then((res) => { if (newest()) setResult(res); });
    void adapter.unreadCount().then((res) => {
      if (!newest() || !res.ok) return;
      setUnreadTotal(res.data);
      onUnread(res.data);
    });
  }, [adapter, page, unreadOnly, onUnread, nextTurn]);
  useEffect(() => { load(); }, [load]);
  // Closing the panel takes a turn, so no read still on its way changes the count after the bell read it.
  useEffect(() => () => { nextTurn(); }, [nextTurn]);
  // A Mark read or Mark all read answer reloads the page and filter shown now, not the ones of the click.
  const latest = useRef(load);
  latest.current = load;
  const pageNow = useRef(page);
  pageNow.current = page;
  const markRead = (n: NotificationModel) => {
    setBusy(n.id);
    setProblem(null);
    void adapter.markRead(n.id).then((res) => {
      setBusy(null);
      if (!res.ok) setProblem(res);
      latest.current();
    });
  };
  const markAll = () => {
    setBusy('all');
    setProblem(null);
    void ctx.track(adapter.markAllRead()).then((res) => {
      setBusy(null);
      if (res.ok) ctx.toast(ctx.li(TEXT.allMarked));
      else setProblem(res);
      if (pageNow.current !== 1) setPage(1);
      else latest.current();
    });
  };
  const open = (n: NotificationModel, link: Link) => {
    onClose(n.readAt ? null : adapter.markRead(n.id));
    ctx.go(link.screen, link.extra);
  };
  const data = result && result.ok ? result.data : null;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  let body;
  if (!result) body = <div className="mx-small" role="status">{ctx.li(TEXT.loading)}</div>;
  else if (!result.ok) {
    body = (
      <Alert tone="bad" title={TEXT.loadFailed}>
        <div>{ctx.li(result.error.message)}</div>
        <div style={{ marginTop: 8 }}><Button onClick={load}>{ctx.li(TEXT.tryAgain)}</Button></div>
      </Alert>
    );
  } else if (!result.data.items.length) {
    body = (
      <EmptyState
        title={TEXT.emptyTitle}
        text={unreadOnly ? TEXT.emptyUnread : TEXT.emptyText}
        illustration={<Illustration scene="all-done" size="sm" decorative />}
      />
    );
  } else {
    body = (
      <>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {result.data.items.map((n) => (
            <NotificationItem key={n.id} ctx={ctx} n={n} busy={busy === n.id} onRead={markRead} onOpen={open} />
          ))}
        </ul>
        <Pager page={page} pages={pages} onPage={setPage} />
      </>
    );
  }
  return (
    <Drawer
      open
      title={TEXT.title}
      crumb={TEXT.crumb}
      onClose={() => onClose()}
    >
      <div className="mx-row" style={{ justifyContent: 'space-between' }}>
        <Checkbox checked={unreadOnly} onChange={(v) => { setUnreadOnly(v); setPage(1); }} label={TEXT.unreadOnly} />
        <Button busy={busy === 'all'} disabled={!data || unreadTotal === 0} onClick={markAll}>{ctx.li(TEXT.markAllRead)}</Button>
      </div>
      {problem && !problem.ok ? <Alert tone="bad">{ctx.li(problem.error.message)}</Alert> : null}
      {body}
    </Drawer>
  );
}
