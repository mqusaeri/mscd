// Policies to confirm (MILESTONE-3 M3-05, D.7 "Confirming", `/my-confirmations`): the session person's open read
// confirmations, each with "Open document" (a short-lived address of the version, opened in a new tab), the statement
// "I have read and understood this document" and "Confirm" (H.7: open first, a checkbox and a button, no typed name),
// and the confirmations of the last months. The server refuses a confirmation before the version was opened
// (ACK-OPEN-FIRST); the screen keeps "Confirm" disabled until then and says why.
import { useState } from 'react';
import type { ApiError } from '../../data/api/ApiClient';
import { Illustration } from '../../illustrations';
import type { HostContext, ScreenProps } from '../types';
import { Alert, Badge, Button, Card, Checkbox, EmptyState, Table, UI_TEXT } from '../ui';
import type { Column } from '../ui';
import { invalidateConfirmations as invalidate, useConfirmations } from './store';
import { adapterFor } from './adapter';
import type { Confirmation, ConfirmationsAdapter } from './model';
import { confirmBlock, dayOf, doneOf, errorText, openOf, settled } from './model';
import { TEXT } from './text';
import './my-confirmations.css';

/**
 * Opens a version in a new tab: the tab opens during the click (so a popup blocker lets it through) and goes to the
 * short-lived address once it is known; a refusal closes it again. The sample build has no stored files.
 */
export function openVersion(ctx: HostContext, adapter: ConfirmationsAdapter, item: Confirmation, done: (ok: boolean, error?: ApiError) => void): void {
  const tab = !adapter.sample && typeof window !== 'undefined' ? window.open('', '_blank') : null;
  void ctx.track(settled(adapter.open(item.id))).then((res) => {
    if (!res.ok) {
      tab?.close();
      done(false, res.error);
      return;
    }
    if (res.data.url) {
      if (tab) {
        tab.opener = null;
        tab.location.replace(res.data.url);
      } else if (typeof window !== 'undefined') window.open(res.data.url, '_blank', 'noopener');
    } else {
      tab?.close();
      ctx.toast(ctx.li(TEXT.sampleOpened));
    }
    done(true);
  });
}

/** One open confirmation: the document, the dates, "Open document", the statement and "Confirm". */
export function OpenItem({ ctx, adapter, item, onChanged }: { ctx: HostContext; adapter: ConfirmationsAdapter; item: Confirmation; onChanged(): void }) {
  const [opened, setOpened] = useState(Boolean(item.openedAt));
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState<'open' | 'confirm' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = () => {
    setBusy('open');
    setError(null);
    openVersion(ctx, adapter, item, (ok, e) => {
      setBusy(null);
      if (ok) {
        setOpened(true);
        onChanged();
      } else if (e) setError(errorText(ctx, e));
    });
  };
  const confirm = () => {
    setBusy('confirm');
    setError(null);
    void ctx.track(settled(adapter.confirm(item.id))).then((res) => {
      setBusy(null);
      if (!res.ok) {
        setError(errorText(ctx, res.error));
        return;
      }
      ctx.toast(res.data.message ? ctx.li(res.data.message) : ctx.fill(TEXT.confirmed, { code: item.document.code }));
      if (res.data.changed.length) ctx.reload(res.data.changed).catch(() => undefined);
      onChanged();
    });
  };
  const block = confirmBlock(item, opened, ticked);
  return (
    <li className="mx-myc-item" data-confirmation={item.document.code} data-overdue={item.overdue}>
      <div className="mx-myc-head">
        <span className="mx-myc-doc">
          <span className="mx-myc-code">{item.document.code}</span>
          <span className="mx-myc-title">{item.document.title}</span>
        </span>
        <Badge tone={item.overdue ? 'bad' : 'warn'}>{ctx.fill(TEXT.version, { version: item.versionLabel })}</Badge>
      </div>
      <div className="mx-myc-meta">
        <span data-tone={item.overdue ? 'bad' : undefined}>{ctx.fill(item.overdue ? TEXT.overdue : TEXT.dueOn, { date: dayOf(ctx, item.dueOn) })}</span>
        <span data-opened={opened}>{item.openedAt ? ctx.fill(TEXT.openedOn, { date: dayOf(ctx, item.openedAt) }) : opened ? ctx.fill(TEXT.openedOn, { date: dayOf(ctx, ctx.D?.TODAY_S ?? null) }) : ctx.li(TEXT.notOpened)}</span>
      </div>
      <div className="mx-myc-actions">
        <Button busy={busy === 'open'} disabled={busy === 'confirm'} onClick={open}>{ctx.li(opened ? TEXT.openAgain : TEXT.openDocument)}</Button>
        <Checkbox name={`statement-${item.id}`} checked={ticked} disabled={!opened} onChange={setTicked} label={TEXT.statement} />
        <Button variant="primary" busy={busy === 'confirm'} disabledReason={busy ? null : block} onClick={confirm}>{ctx.li(TEXT.confirm)}</Button>
      </div>
      {error ? <Alert tone="bad">{error}</Alert> : null}
    </li>
  );
}

/** The confirmations that are done: confirmed (with the date) or no longer asked. */
export function DoneTable({ ctx, items }: { ctx: HostContext; items: Confirmation[] }) {
  const columns: Column<Confirmation>[] = [
    {
      key: 'document',
      label: TEXT.colDocument,
      render: (c) => (
        <span className="mx-myc-doc">
          <span className="mx-myc-code">{c.document.code}</span>
          <span className="mx-small">{c.document.title}</span>
        </span>
      ),
    },
    { key: 'version', label: TEXT.colVersion, render: (c) => <span className="mx-mono">v{c.versionLabel}</span> },
    {
      key: 'result',
      label: TEXT.colResult,
      render: (c) => (c.status === 'confirmed'
        ? <Badge tone="ok">{ctx.fill(TEXT.confirmedOn, { date: dayOf(ctx, c.confirmedAt) })}</Badge>
        : <Badge tone="mute">{ctx.li(TEXT.excused)}</Badge>),
    },
  ];
  return <Table columns={columns} rows={items} rowKey={(c) => c.id} />;
}

export function ConfirmationsBody({ ctx, adapter }: { ctx: HostContext; adapter: ConfirmationsAdapter }) {
  const list = useConfirmations(ctx);
  const items = list.items ?? [];
  const open = openOf(items);
  const done = doneOf(items);
  return (
    <div className="mx-stack" data-confirmations="">
      <p className="mx-myc-note">{ctx.li(TEXT.intro)}</p>
      {adapter.sample ? <Alert tone="info">{ctx.li(TEXT.sampleNote)}</Alert> : null}
      {list.error && !list.items ? (
        <Alert tone="bad" title={TEXT.loadFailed}>
          <div>{errorText(ctx, list.error)}</div>
          <div style={{ marginTop: 8 }}><Button onClick={invalidate}>{ctx.li(TEXT.tryAgain)}</Button></div>
        </Alert>
      ) : !list.items ? (
        <div className="mx-small" role="status">{ctx.li(UI_TEXT.loading)}</div>
      ) : (
        <>
          <Card title={TEXT.openTitle} sub={TEXT.openSub}>
            {open.length ? (
              <ul className="mx-myc-list">
                {open.map((item) => <OpenItem key={item.id} ctx={ctx} adapter={adapter} item={item} onChanged={invalidate} />)}
              </ul>
            ) : (
              <EmptyState illustration={<Illustration scene="all-done" size="sm" decorative />} title={TEXT.allDone} text={TEXT.allDoneText} />
            )}
          </Card>
          {done.length ? (
            <Card title={TEXT.doneTitle} sub={TEXT.doneSub} flush>
              <DoneTable ctx={ctx} items={done} />
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}

export default function MyConfirmationsScreen({ ctx }: ScreenProps) {
  return <ConfirmationsBody ctx={ctx} adapter={adapterFor(ctx)} />;
}
