// The invitation banner of the host layer (MILESTONE-2 M2-16): "You were invited to <organisation>" with "Accept"
// (refused with the LIC-USERS message when that organisation is at its licence user limit), "Decline" (after a
// confirmation) and "Later". It shows the oldest invitation of `Me.pendingMemberships` and how many more wait.
import { useMemo, useState } from 'react';
import type { HostContext, ScreenProps } from '../types';
import { Alert, Button, ConfirmDialog } from '../ui';
import { createApiAdapter } from './api';
import { markHandled, pendingOf } from './model';
import type { Invitation } from './model';
import { TEXT } from './text';
import './banner.css';

function dayOf(ctx: HostContext, instant: string): string {
  const iso = instant.slice(0, 10);
  return ctx.D ? ctx.D.fmt(iso, ctx.lang) : iso;
}

export function InvitationBanner({ ctx }: ScreenProps) {
  const { client } = ctx;
  const adapter = useMemo(() => createApiAdapter(client), [client]);
  const [, setVersion] = useState(0);
  const [busy, setBusy] = useState<'accept' | 'decline' | null>(null);
  const [error, setError] = useState<{ org: string; message: readonly [string, string] } | null>(null);
  const [confirm, setConfirm] = useState<Invitation | null>(null);
  const list = pendingOf(ctx);
  const first = list[0];
  if (!first) return null;
  const done = (inv: Invitation) => {
    markHandled(ctx, inv.org);
    setError(null);
    setVersion((v) => v + 1);
  };
  const accept = (inv: Invitation) => {
    setBusy('accept');
    setError(null);
    void ctx.track(adapter.accept(inv.org)).then((res) => {
      setBusy(null);
      if (!res.ok) {
        setError({ org: inv.org, message: res.error.message });
        return;
      }
      done(inv);
      ctx.toast(ctx.fill(TEXT.accepted, { organisation: inv.name }));
      // The organisation menu reads the organisations of the snapshot again.
      void ctx.reload();
    });
  };
  const decline = (inv: Invitation) => {
    setBusy('decline');
    void ctx.track(adapter.decline(inv.org)).then((res) => {
      setBusy(null);
      setConfirm(null);
      if (!res.ok) {
        setError({ org: inv.org, message: res.error.message });
        return;
      }
      done(inv);
      ctx.toast(ctx.fill(TEXT.declined, { organisation: inv.name }));
    });
  };
  const when = dayOf(ctx, first.invitedAt);
  return (
    <>
      <section className="mx-invite" role="region" aria-label={ctx.li(TEXT.region)} data-invitation={first.org}>
        <h2 className="mx-invite-title">{ctx.fill(TEXT.invited, { organisation: first.name })}</h2>
        <span className="mx-invite-text">
          {first.invitedBy ? ctx.fill(TEXT.invitedBy, { name: first.invitedBy, date: when }) : ctx.fill(TEXT.invitedOn, { date: when })}
          {' '}
          {ctx.li(TEXT.explain)}
        </span>
        {error && error.org === first.org ? <Alert tone="bad">{ctx.li(error.message)}</Alert> : null}
        <div className="mx-row" style={{ justifyContent: 'space-between' }}>
          <span className="mx-small">{list.length === 2 ? ctx.li(TEXT.moreOne) : list.length > 2 ? ctx.fill(TEXT.moreMany, { n: list.length - 1 }) : ''}</span>
          <span className="mx-btn-group">
            <Button variant="link" onClick={() => done(first)}>{ctx.li(TEXT.later)}</Button>
            <Button onClick={() => setConfirm(first)} disabled={busy !== null}>{ctx.li(TEXT.decline)}</Button>
            <Button variant="primary" busy={busy === 'accept'} onClick={() => accept(first)}>{ctx.li(TEXT.accept)}</Button>
          </span>
        </div>
      </section>
      <ConfirmDialog
        open={Boolean(confirm)}
        title={TEXT.declineTitle}
        body={confirm ? ctx.fill(TEXT.declineBody, { organisation: confirm.name }) : ''}
        confirmLabel={TEXT.decline}
        tone="bad"
        busy={busy === 'decline'}
        onConfirm={() => { if (confirm) decline(confirm); }}
        onCancel={() => setConfirm(null)}
      />
    </>
  );
}
