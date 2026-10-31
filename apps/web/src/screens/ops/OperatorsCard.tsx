// Platform operators of the operator console (MILESTONE-2 M2-19): the accounts with the operator role
// (`ops.operators.list`), whether each has set up its second factor and its password, its last sign-in and who granted
// the role; "Add operator" (email, name and reason, `ops.operators.add`) and "Remove" (with a reason,
// `ops.operators.remove`) for `ops.users.manage`. The operator's own row has no Remove: another operator removes it.
import { useCallback, useEffect, useState } from 'react';
import { newIdempotencyKey, useMutation } from '../api';
import { copyText } from '../organization/InstallationPanel';
import type { HostContext, TextPair } from '../types';
import { Alert, Badge, Button, Card, Field, Modal, Table, TextInput, Textarea, UI_TEXT } from '../ui';
import type { Column } from '../ui';
import { EMPTY_OPERATOR_FORM, accountName, accountRefusal, operatorErrors, reasonError } from './account-model';
import type { OperatorAdded, OperatorForm, OperatorItem, OperatorRemoved } from './account-model';
import { ACCOUNT_TEXT } from './account-text';
import { LoadState, asApi, useLoad } from './Health';
import type { OpsAdapter, Result } from './model';
import { dayText, whenText } from './org-model';

/** "Add operator": the form, then the answer (the email sent, or the one-time link to pass on). */
export function AddOperatorDialog({ ctx, adapter, open, onClose, onAdded }: {
  ctx: HostContext;
  adapter: OpsAdapter;
  open: boolean;
  onClose(): void;
  onAdded(added: OperatorAdded): void;
}) {
  const [form, setForm] = useState<OperatorForm>(EMPTY_OPERATOR_FORM);
  const [shown, setShown] = useState<Partial<Record<keyof OperatorForm, TextPair>>>({});
  const [added, setAdded] = useState<OperatorAdded | null>(null);
  const [key, setKey] = useState(() => newIdempotencyKey());
  const run = useCallback((input: { body: OperatorForm; key: string }) => adapter.addOperator(input.body, input.key).then(asApi), [adapter]);
  const mutation = useMutation<{ body: OperatorForm; key: string }, OperatorAdded>(run);
  const { reset } = mutation;
  useEffect(() => {
    if (open) return;
    setForm(EMPTY_OPERATOR_FORM);
    setShown({});
    setAdded(null);
    setKey(newIdempotencyKey());
    reset();
  }, [open]);
  const set = (field: keyof OperatorForm) => (value: string) => {
    setForm((f) => ({ ...f, [field]: value }));
    setShown((s) => ({ ...s, [field]: undefined }));
    setKey(newIdempotencyKey());
    mutation.reset();
  };
  const submit = () => {
    const errors = operatorErrors(form);
    setShown(errors);
    if (Object.keys(errors).length) return;
    const body = { email: form.email.trim(), name: form.name.trim(), reason: form.reason.trim() };
    void ctx.track(mutation.submit({ body, key })).then((res) => {
      if (!res.ok) return;
      setAdded(res.data);
      onAdded(res.data);
      ctx.toast(ctx.fill(ACCOUNT_TEXT.added, { email: res.data.email }));
    }, () => undefined);
  };
  const server = mutation.fields;
  const err = (field: keyof OperatorForm) => shown[field] ?? server[field] ?? null;
  const general = mutation.error && !server.email && !server.name && !server.reason ? accountRefusal(mutation.error) : null;
  return (
    <Modal
      open={open}
      title={ACCOUNT_TEXT.addTitle}
      sub={ACCOUNT_TEXT.addSub}
      onClose={onClose}
      footer={added ? <Button variant="primary" onClick={onClose}>{ctx.li(ACCOUNT_TEXT.close)}</Button> : (
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(ACCOUNT_TEXT.add)}</Button>
        </>
      )}
    >
      {added ? (
        <div className="mx-stack" data-operator-added={added.email}>
          <Alert tone={added.link ? 'warn' : 'ok'} title={added.message ?? [ctx.fill(ACCOUNT_TEXT.added, { email: added.email }), ctx.fill(ACCOUNT_TEXT.added, { email: added.email })]} />
          {added.link ? (
            <>
              <span>{ctx.li(ACCOUNT_TEXT.linkShown)}</span>
              <code className="mx-mono" style={{ overflowWrap: 'anywhere', color: 'var(--tx)', userSelect: 'all' }}>{added.link}</code>
              <div>
                <Button onClick={() => { void copyText(added.link ?? '').then((ok) => ctx.toast(ctx.li(ok ? ACCOUNT_TEXT.linkCopied : ACCOUNT_TEXT.linkNotCopied))); }}>{ctx.li(ACCOUNT_TEXT.copyLink)}</Button>
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <form className="mx-stack" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate data-operator-form="">
          <Field label={ACCOUNT_TEXT.operatorEmail} error={err('email')} required>
            <TextInput type="email" value={form.email} onChange={set('email')} maxLength={254} autoComplete="off" />
          </Field>
          <Field label={ACCOUNT_TEXT.operatorName} error={err('name')} required>
            <TextInput value={form.name} onChange={set('name')} maxLength={150} autoComplete="off" />
          </Field>
          <Field label={ACCOUNT_TEXT.reason} hint={ACCOUNT_TEXT.reasonHint} error={err('reason')} required>
            <Textarea value={form.reason} onChange={set('reason')} rows={3} maxLength={500} />
          </Field>
          {general ? <Alert tone="bad">{ctx.li(general)}</Alert> : null}
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </form>
      )}
    </Modal>
  );
}

/** "Remove" of one operator: what happens and the reason. */
export function RemoveOperatorDialog({ ctx, adapter, operator, onClose, onRemoved }: {
  ctx: HostContext;
  adapter: OpsAdapter;
  operator: OperatorItem | null;
  onClose(): void;
  onRemoved(operator: OperatorItem, removed: OperatorRemoved): void;
}) {
  const [reason, setReason] = useState('');
  const [shown, setShown] = useState<TextPair | null>(null);
  const run = useCallback((input: { id: string; reason: string }) => adapter.removeOperator(input.id, input.reason).then(asApi), [adapter]);
  const mutation = useMutation<{ id: string; reason: string }, OperatorRemoved>(run);
  const { reset } = mutation;
  useEffect(() => {
    setReason('');
    setShown(null);
    reset();
  }, [operator]);
  if (!operator) return null;
  const submit = () => {
    const error = reasonError(reason);
    setShown(error);
    if (error) return;
    void ctx.track(mutation.submit({ id: operator.id, reason: reason.trim() })).then((res) => {
      if (!res.ok) return;
      ctx.toast(ctx.fill(ACCOUNT_TEXT.removed, { email: operator.email }));
      onRemoved(operator, res.data);
    }, () => undefined);
  };
  const refusal = mutation.error && !mutation.fields.reason ? accountRefusal(mutation.error) : null;
  return (
    <Modal
      open
      title={ctx.fill(ACCOUNT_TEXT.removeTitle, { name: operator.displayName })}
      sub={accountName(operator)}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="danger" busy={mutation.busy} onClick={submit}>{ctx.li(ACCOUNT_TEXT.remove)}</Button>
        </>
      )}
    >
      <form className="mx-stack" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate data-operator-remove={operator.id}>
        <div>
          <div className="mx-label">{ctx.li(ACCOUNT_TEXT.effectsTitle)}</div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 20, color: 'var(--tx)' }}>
            <li style={{ marginTop: 4 }}>{ctx.li(ACCOUNT_TEXT.removeEffect1)}</li>
            <li style={{ marginTop: 4 }}>{ctx.li(ACCOUNT_TEXT.removeEffect2)}</li>
          </ul>
        </div>
        <Field label={ACCOUNT_TEXT.reason} hint={ACCOUNT_TEXT.reasonHint} error={shown ?? mutation.fields.reason ?? null} required>
          <Textarea value={reason} onChange={(v) => { setReason(v); setShown(null); mutation.reset(); }} rows={3} maxLength={500} />
        </Field>
        {refusal ? <Alert tone="bad">{ctx.li(refusal)}</Alert> : null}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

export function OperatorsTable({ ctx, operators, canManage, onRemove }: { ctx: HostContext; operators: OperatorItem[]; canManage: boolean; onRemove(o: OperatorItem): void }) {
  const columns: Column<OperatorItem>[] = [
    {
      key: 'operator',
      label: ACCOUNT_TEXT.colOperator,
      render: (o) => (
        <>
          <div style={{ fontWeight: 600 }}>
            {o.displayName}
            {o.self ? <> <Badge tone="acc">{ctx.li(ACCOUNT_TEXT.you)}</Badge></> : null}
          </div>
          <div className="mx-small" style={{ overflowWrap: 'anywhere' }}>{o.email}</div>
        </>
      ),
    },
    {
      key: 'factor',
      label: ACCOUNT_TEXT.colFactor,
      render: (o) => (
        <span className="mx-stack" style={{ gap: 4 }}>
          <span>{ctx.li(o.mfaEnrolled ? ACCOUNT_TEXT.factorOn : ACCOUNT_TEXT.factorOff)}</span>
          {!o.passwordSet ? <span><Badge tone="warn">{ctx.li(ACCOUNT_TEXT.waitingPassword)}</Badge></span> : null}
        </span>
      ),
    },
    { key: 'last', label: ACCOUNT_TEXT.colLastSignIn, render: (o) => (o.lastSignInAt ? whenText(ctx, o.lastSignInAt) : ctx.li(ACCOUNT_TEXT.never)) },
    {
      key: 'granted',
      label: ACCOUNT_TEXT.colGranted,
      render: (o) => (
        <>
          <div style={{ whiteSpace: 'nowrap' }}>{dayText(ctx, o.grantedAt)}</div>
          <div className="mx-small">{o.grantedBy ? ctx.fill(ACCOUNT_TEXT.grantedBy, { name: o.grantedBy.displayName }) : ctx.fill(ACCOUNT_TEXT.grantedBy, { name: ctx.li(ACCOUNT_TEXT.byCommandLine) })}</div>
        </>
      ),
    },
    ...(canManage
      ? [{
        key: 'actions',
        label: ACCOUNT_TEXT.colActions,
        render: (o: OperatorItem) => (o.self ? <span className="mx-muted">-</span> : (
          <Button title={ctx.fill(ACCOUNT_TEXT.removeTitle, { name: o.displayName })} onClick={() => onRemove(o)}>{ctx.li(ACCOUNT_TEXT.remove)}</Button>
        )),
      }]
      : []),
  ];
  return <Table columns={columns} rows={operators} rowKey={(o) => o.id} />;
}

export function OperatorsCard({ ctx, adapter, result, reload }: {
  ctx: HostContext;
  adapter: OpsAdapter;
  result: Result<OperatorItem[]> | null;
  reload(): void;
}) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<OperatorItem | null>(null);
  const canManage = ctx.platformCan('ops.users.manage');
  let body;
  if (!result || !result.ok) body = <div style={{ padding: 'var(--pad)' }}><LoadState ctx={ctx} result={result} failed={ACCOUNT_TEXT.operatorsFailed} retry={reload} /></div>;
  else body = <OperatorsTable ctx={ctx} operators={result.data} canManage={canManage} onRemove={setRemoving} />;
  return (
    <>
      <Card
        title={ACCOUNT_TEXT.operators}
        sub={ACCOUNT_TEXT.operatorsSub}
        flush
        actions={canManage ? <Button variant="primary" onClick={() => setAdding(true)}>{ctx.li(ACCOUNT_TEXT.addOperator)}</Button> : null}
      >
        <div data-ops-operators="">{body}</div>
      </Card>
      <AddOperatorDialog ctx={ctx} adapter={adapter} open={adding} onClose={() => setAdding(false)} onAdded={() => reload()} />
      <RemoveOperatorDialog ctx={ctx} adapter={adapter} operator={removing} onClose={() => setRemoving(null)} onRemoved={() => { setRemoving(null); reload(); }} />
    </>
  );
}

/** The operator list read once for the tab: the card shows it, and its `self` row names the signed-in operator. */
export function useOperators(adapter: OpsAdapter): { result: Result<OperatorItem[]> | null; reload(): void; selfId: string | null } {
  const load = useCallback(() => adapter.operators(), [adapter]);
  const { result, reload } = useLoad<OperatorItem[]>(load);
  const selfId = result && result.ok ? result.data.find((o) => o.self)?.id ?? null : null;
  return { result, reload, selfId };
}
