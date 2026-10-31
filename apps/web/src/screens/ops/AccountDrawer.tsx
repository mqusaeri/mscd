// The account drawer of the operator console (MILESTONE-2 M2-19): who the account is (`ops.accounts.get`), its
// memberships with the admin roles (never the roles inside an organisation), its open sessions with the network cut
// to its first part and the browser, its recent audit entries, and the actions of `ops.users.manage`: reset the second
// factor, send a password link, send an invitation again, end all sessions, disable or enable. Each action names the
// account, lists what happens and asks for a reason before it runs; the answer's message, and a one-time link where
// the server shows one, stay in the dialog. The system account takes no action, and the operator's own account never
// ends its sessions or is disabled here.
import { useCallback, useEffect, useState } from 'react';
import { newIdempotencyKey, useMutation } from '../api';
import { copyText } from '../organization/InstallationPanel';
import type { HostContext, TextPair } from '../types';
import { Alert, Badge, Button, Card, Drawer, Facts, Field, Modal, Table, Textarea, UI_TEXT } from '../ui';
import type { Column } from '../ui';
import {
  ACTION_EFFECTS, ACTION_LABEL, ACTION_TONE, AUDIT_LABEL, KIND_LABEL, METHOD_LABEL, STATUS_LABEL, STATUS_TONE, accountName, accountRefusal, actionsFor,
  reasonError, resendable, rolesText,
} from './account-model';
import type { AccountAction, AccountAuditEntry, AccountDetail, AccountItem, AccountSession, ActionDone, ActionTarget, Membership } from './account-model';
import { ACCOUNT_TEXT } from './account-text';
import { LoadState, asApi, useLoad } from './Health';
import type { OpsAdapter } from './model';
import { whenText } from './org-model';

/** Runs one action through the adapter. */
function runAction(adapter: OpsAdapter, account: AccountItem, target: ActionTarget, reason: string, key: string) {
  switch (target.action) {
    case 'reset-mfa':
      return adapter.resetMfa(account.id, reason, key);
    case 'password':
      return adapter.sendPasswordLink(account.id, reason, key);
    case 'resend':
      return adapter.resendInvitation(account.id, target.org?.org ?? '', reason, key);
    case 'sessions':
      return adapter.endSessions(account.id, reason, key);
    case 'disable':
      return adapter.setAccountStatus(account.id, 'disabled', reason, account.etag);
    case 'enable':
      return adapter.setAccountStatus(account.id, 'active', reason, account.etag);
  }
}

/** The label of an action, with the organisation for an invitation sent again. */
function actionTitle(ctx: HostContext, target: ActionTarget): string {
  return target.action === 'resend' && target.org ? ctx.fill(ACCOUNT_TEXT.resendTitle, { org: target.org.orgName }) : ctx.li(ACTION_LABEL[target.action]);
}

/** The confirmation of one action: the account named, what happens, the reason; then the answer. */
export function ActionDialog({ ctx, adapter, account, target, onClose, onDone }: {
  ctx: HostContext;
  adapter: OpsAdapter;
  account: AccountItem;
  target: ActionTarget | null;
  onClose(): void;
  onDone(done: ActionDone): void;
}) {
  const [reason, setReason] = useState('');
  const [shown, setShown] = useState<TextPair | null>(null);
  const [done, setDone] = useState<ActionDone | null>(null);
  const [key, setKey] = useState(() => newIdempotencyKey());
  const run = useCallback(
    (input: { target: ActionTarget; reason: string; key: string }) => runAction(adapter, account, input.target, input.reason, input.key).then(asApi),
    [adapter, account],
  );
  const mutation = useMutation<{ target: ActionTarget; reason: string; key: string }, ActionDone>(run);
  const { reset } = mutation;
  useEffect(() => {
    setReason('');
    setShown(null);
    setDone(null);
    setKey(newIdempotencyKey());
    reset();
  }, [target]);
  if (!target) return null;
  const submit = () => {
    const error = reasonError(reason);
    setShown(error);
    if (error) return;
    void ctx.track(mutation.submit({ target, reason: reason.trim(), key })).then((res) => {
      if (!res.ok) return;
      setDone(res.data);
      onDone(res.data);
      if (res.data.message) ctx.toast(ctx.li(res.data.message));
    }, () => undefined);
  };
  const fields = mutation.fields;
  const refusal = mutation.error && !fields.reason ? accountRefusal(mutation.error) : null;
  const title = ctx.fill(ACCOUNT_TEXT.confirmTitle, { action: actionTitle(ctx, target), name: account.displayName });
  const tone = ACTION_TONE[target.action];
  return (
    <Modal
      open
      title={title}
      sub={accountName(account)}
      onClose={onClose}
      footer={done ? <Button variant="primary" onClick={onClose}>{ctx.li(ACCOUNT_TEXT.close)}</Button> : (
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant={tone === 'default' ? 'primary' : tone} busy={mutation.busy} onClick={submit}>{actionTitle(ctx, target)}</Button>
        </>
      )}
    >
      {done ? (
        <div className="mx-stack" data-action-done={target.action}>
          <Alert tone={done.emailed || !done.link ? 'ok' : 'warn'} title={done.message ?? ACCOUNT_TEXT.done}>
            {done.sessionsRevoked > 0 ? <div>{ctx.fill(ACCOUNT_TEXT.sessionsEnded, { n: done.sessionsRevoked })}</div> : null}
          </Alert>
          {done.link ? (
            <>
              <span>{ctx.li(ACCOUNT_TEXT.linkShown)}</span>
              <code className="mx-mono" style={{ overflowWrap: 'anywhere', color: 'var(--tx)', userSelect: 'all' }}>{done.link}</code>
              <div>
                <Button onClick={() => { void copyText(done.link ?? '').then((ok) => ctx.toast(ctx.li(ok ? ACCOUNT_TEXT.linkCopied : ACCOUNT_TEXT.linkNotCopied))); }}>{ctx.li(ACCOUNT_TEXT.copyLink)}</Button>
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <form className="mx-stack" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate data-account-action={target.action}>
          <div>
            <div className="mx-label">{ctx.li(ACCOUNT_TEXT.effectsTitle)}</div>
            <ul style={{ margin: '6px 0 0', paddingLeft: 20, color: 'var(--tx)' }}>
              {ACTION_EFFECTS[target.action].map((e) => <li key={e[0]} style={{ marginTop: 4 }}>{ctx.li(e)}</li>)}
            </ul>
          </div>
          <Field label={ACCOUNT_TEXT.reason} hint={ACCOUNT_TEXT.reasonHint} error={shown ?? fields.reason ?? null} required>
            <Textarea value={reason} onChange={(v) => { setReason(v); setShown(null); mutation.reset(); }} rows={3} maxLength={500} />
          </Field>
          {refusal ? <Alert tone="bad">{ctx.li(refusal)}</Alert> : null}
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </form>
      )}
    </Modal>
  );
}

/** The badges of an account: status, kind other than a person, lock and operator role. */
export function AccountBadges({ ctx, account }: { ctx: HostContext; account: AccountItem }) {
  return (
    <span className="mx-row" style={{ flexWrap: 'wrap', gap: 6 }}>
      <Badge tone={STATUS_TONE[account.status]}>{ctx.li(STATUS_LABEL[account.status])}</Badge>
      {account.kind !== 'person' ? <Badge tone="mute">{ctx.li(KIND_LABEL[account.kind])}</Badge> : null}
      {account.locked ? <Badge tone="warn" title={ctx.li(ACCOUNT_TEXT.lockedTitle)}>{ctx.li(ACCOUNT_TEXT.locked)}</Badge> : null}
      {account.platformOperator ? <Badge tone="acc">{ctx.li(ACCOUNT_TEXT.operatorBadge)}</Badge> : null}
    </span>
  );
}

export function SessionsTable({ ctx, sessions }: { ctx: HostContext; sessions: AccountSession[] }) {
  const columns: Column<AccountSession>[] = [
    {
      key: 'when',
      label: ACCOUNT_TEXT.colLastActive,
      render: (s) => (
        <>
          <div style={{ whiteSpace: 'nowrap' }}>{whenText(ctx, s.lastSeenAt)}</div>
          <div className="mx-small">{ctx.li(ACCOUNT_TEXT.colStarted)} {whenText(ctx, s.startedAt)}</div>
        </>
      ),
    },
    { key: 'method', label: ACCOUNT_TEXT.colMethod, render: (s) => (METHOD_LABEL[s.method] ? ctx.li(METHOD_LABEL[s.method]) : s.method) },
    { key: 'network', label: ACCOUNT_TEXT.colNetwork, render: (s) => (s.network ? <span className="mx-mono" style={{ overflowWrap: 'anywhere' }}>{s.network}</span> : ctx.li(ACCOUNT_TEXT.unknown)) },
    {
      key: 'browser',
      label: ACCOUNT_TEXT.colBrowser,
      render: (s) => (
        <>
          <div>{s.browser ?? ctx.li(ACCOUNT_TEXT.unknown)}</div>
          {s.org ? <div className="mx-small mx-mono">{s.org}</div> : null}
        </>
      ),
    },
  ];
  return <Table columns={columns} rows={sessions} rowKey={(s) => `${s.startedAt}-${s.network ?? ''}-${s.browser ?? ''}`} />;
}

export function ActivityTable({ ctx, entries }: { ctx: HostContext; entries: AccountAuditEntry[] }) {
  const by = (e: AccountAuditEntry): string => {
    if (e.actor) return e.actor.displayName;
    if (e.actorKind === 'operator') return ctx.li(ACCOUNT_TEXT.byCommandLine);
    if (e.actorKind === 'system') return ctx.li(ACCOUNT_TEXT.bySystem);
    return ctx.li(ACCOUNT_TEXT.bySelf);
  };
  const columns: Column<AccountAuditEntry>[] = [
    { key: 'when', label: ACCOUNT_TEXT.colWhen, render: (e) => <span style={{ whiteSpace: 'nowrap' }}>{whenText(ctx, e.at)}</span> },
    {
      key: 'what',
      label: ACCOUNT_TEXT.colWhat,
      render: (e) => (
        <>
          <div>{AUDIT_LABEL[e.action] ? ctx.li(AUDIT_LABEL[e.action]) : <span className="mx-mono">{e.action}</span>}</div>
          {e.org ? <div className="mx-small mx-mono">{e.org}</div> : null}
        </>
      ),
    },
    { key: 'by', label: ACCOUNT_TEXT.colBy, render: by },
    { key: 'reason', label: ACCOUNT_TEXT.colReason, render: (e) => (e.reason ? <span style={{ overflowWrap: 'anywhere' }}>{e.reason}</span> : <span className="mx-muted">-</span>) },
  ];
  return <Table columns={columns} rows={entries} rowKey={(e) => `${e.at}-${e.action}`} />;
}

export function MembershipsTable({ ctx, memberships }: { ctx: HostContext; memberships: Membership[] }) {
  const columns: Column<Membership>[] = [
    {
      key: 'org',
      label: ACCOUNT_TEXT.colOrg,
      render: (m) => (
        <>
          <div style={{ fontWeight: 600 }}>{m.orgName}</div>
          <div className="mx-small mx-mono">{m.org}</div>
        </>
      ),
    },
    { key: 'status', label: ACCOUNT_TEXT.colMembership, render: (m) => <Badge tone={STATUS_TONE[m.status]}>{ctx.li(STATUS_LABEL[m.status])}</Badge> },
    { key: 'roles', label: ACCOUNT_TEXT.colAdminRoles, render: (m) => rolesText(ctx, m.adminRoles) },
  ];
  return <Table columns={columns} rows={memberships} rowKey={(m) => m.org} />;
}

/** The facts, memberships, sessions, activity and actions of one account. */
export function AccountView({ ctx, detail, selfId, onAction }: {
  ctx: HostContext;
  detail: AccountDetail;
  selfId: string | null;
  onAction(target: ActionTarget): void;
}) {
  const canManage = ctx.platformCan('ops.users.manage');
  const self = detail.id === selfId;
  const actions = actionsFor(detail, selfId);
  const invited = resendable(detail);
  const yesNo = (v: boolean) => ctx.li(v ? ACCOUNT_TEXT.yes : ACCOUNT_TEXT.no);
  let actionBody;
  if (detail.kind === 'system') actionBody = <span className="mx-muted">{ctx.li(ACCOUNT_TEXT.systemNote)}</span>;
  else if (!canManage) actionBody = <span className="mx-muted">{ctx.li(ACCOUNT_TEXT.readOnlyRights)}</span>;
  else if (!actions.length && !invited.length) actionBody = <span className="mx-muted">{ctx.li(ACCOUNT_TEXT.noActions)}</span>;
  else {
    actionBody = (
      <div className="mx-stack">
        {self ? <Alert tone="info">{ctx.li(ACCOUNT_TEXT.selfNote)}</Alert> : null}
        {detail.status === 'invited' ? <Alert tone="info">{ctx.li(ACCOUNT_TEXT.invitedNote)}</Alert> : null}
        <div className="mx-btn-group" style={{ flexWrap: 'wrap' }}>
          {actions.map((a: AccountAction) => (
            <Button key={a} variant={ACTION_TONE[a] === 'danger' ? 'danger' : 'default'} onClick={() => onAction({ action: a })}>{ctx.li(ACTION_LABEL[a])}</Button>
          ))}
          {invited.map((m) => (
            <Button key={`resend-${m.org}`} onClick={() => onAction({ action: 'resend', org: m })}>{ctx.fill(ACCOUNT_TEXT.resendTitle, { org: m.orgName })}</Button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <>
      <Card>
        <Facts
          items={[
            { label: ACCOUNT_TEXT.factEmail, value: <span style={{ overflowWrap: 'anywhere' }}>{detail.email}</span> },
            { label: ACCOUNT_TEXT.factHandle, value: detail.handle, mono: true },
            { label: ACCOUNT_TEXT.factKind, value: ctx.li(KIND_LABEL[detail.kind]) },
            { label: ACCOUNT_TEXT.factStatus, value: <Badge tone={STATUS_TONE[detail.status]}>{ctx.li(STATUS_LABEL[detail.status])}</Badge> },
            { label: ACCOUNT_TEXT.factFactor, value: ctx.li(detail.mfaEnrolled ? ACCOUNT_TEXT.factorOn : ACCOUNT_TEXT.factorOff) },
            { label: ACCOUNT_TEXT.factLocked, value: detail.locked ? <Badge tone="warn">{ctx.li(ACCOUNT_TEXT.locked)}</Badge> : ctx.li(ACCOUNT_TEXT.notLocked) },
            { label: ACCOUNT_TEXT.factLastSignIn, value: detail.lastSignInAt ? whenText(ctx, detail.lastSignInAt) : ctx.li(ACCOUNT_TEXT.never) },
            { label: ACCOUNT_TEXT.factCreated, value: whenText(ctx, detail.createdAt) },
            { label: ACCOUNT_TEXT.factOperator, value: yesNo(detail.platformOperator) },
          ]}
        />
      </Card>
      <Card title={ACCOUNT_TEXT.actions} sub={detail.kind === 'system' || !canManage ? undefined : ACCOUNT_TEXT.actionsSub}>{actionBody}</Card>
      <Card title={ACCOUNT_TEXT.memberships} sub={ACCOUNT_TEXT.membershipsSub} flush>
        {detail.memberships.length
          ? <MembershipsTable ctx={ctx} memberships={detail.memberships} />
          : <div style={{ padding: 'var(--pad)' }}><span className="mx-muted">{ctx.li(ACCOUNT_TEXT.noMemberships)}</span></div>}
      </Card>
      <Card title={ACCOUNT_TEXT.sessions} sub={ACCOUNT_TEXT.sessionsSub} flush>
        {detail.sessions.length
          ? <SessionsTable ctx={ctx} sessions={detail.sessions} />
          : <div style={{ padding: 'var(--pad)' }}><span className="mx-muted">{ctx.li(ACCOUNT_TEXT.noSessions)}</span></div>}
      </Card>
      <Card title={ACCOUNT_TEXT.activity} sub={ACCOUNT_TEXT.activitySub} flush>
        {detail.audit.length
          ? <ActivityTable ctx={ctx} entries={detail.audit} />
          : <div style={{ padding: 'var(--pad)' }}><span className="mx-muted">{ctx.li(ACCOUNT_TEXT.noActivity)}</span></div>}
      </Card>
    </>
  );
}

export function AccountDrawer({ ctx, adapter, account, selfId, onClose, onChanged }: {
  ctx: HostContext;
  adapter: OpsAdapter;
  account: AccountItem;
  /** The signed-in operator's account id, when known. */
  selfId: string | null;
  onClose(): void;
  /** The account changed: the list reads it again. */
  onChanged(): void;
}) {
  const [tick, setTick] = useState(0);
  const [target, setTarget] = useState<ActionTarget | null>(null);
  const load = useCallback(() => adapter.account(account.id), [adapter, account.id, tick]);
  const { result, reload } = useLoad<AccountDetail>(load);
  // Keeps the last detail on screen while it is read again after an action.
  const [shown, setShown] = useState<AccountDetail | null>(null);
  useEffect(() => {
    if (result && result.ok) setShown(result.data);
  }, [result]);
  const detail = result && result.ok ? result.data : shown;
  const done = () => {
    setTick((t) => t + 1);
    onChanged();
  };
  return (
    <Drawer open title={detail?.displayName ?? account.displayName} crumb={ACCOUNT_TEXT.crumb} onClose={onClose}>
      <div className="mx-stack" data-account-drawer={account.id}>
        <div className="mx-stack" style={{ gap: 6 }}>
          <span className="mx-mono mx-small" style={{ overflowWrap: 'anywhere' }}>{detail?.email ?? account.email}</span>
          <AccountBadges ctx={ctx} account={detail ?? account} />
        </div>
        {detail ? <AccountView ctx={ctx} detail={detail} selfId={selfId} onAction={setTarget} /> : <LoadState ctx={ctx} result={result} failed={ACCOUNT_TEXT.detailFailed} retry={reload} />}
      </div>
      {detail ? <ActionDialog ctx={ctx} adapter={adapter} account={detail} target={target} onClose={() => setTarget(null)} onDone={done} /> : null}
    </Drawer>
  );
}
