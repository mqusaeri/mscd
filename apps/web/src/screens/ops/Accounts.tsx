// Operator console, Accounts (MILESTONE-2 M2-16): "Reset sign-in factor" (email and reason, `ops.users.reset-mfa`)
// for an account with several memberships, which no single Tenant Admin may reset. A confirmation names the account.
import { useCallback, useState } from 'react';
import { useMutation } from '../api';
import type { HostContext, TextPair } from '../types';
import { Alert, Button, Card, ConfirmDialog, Field, TextInput, Textarea } from '../ui';
import { asApi } from './Health';
import type { OpsAdapter } from './model';
import { TEXT } from './text';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ResetMfaCard({ ctx, adapter }: { ctx: HostContext; adapter: OpsAdapter }) {
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [shown, setShown] = useState<Partial<Record<'email' | 'reason', TextPair>>>({});
  const [confirming, setConfirming] = useState(false);
  const run = useCallback((input: { email: string; reason: string }) => adapter.resetMfa(input.email, input.reason).then(asApi), [adapter]);
  const mutation = useMutation<{ email: string; reason: string }, null>(run);
  const check = () => {
    const errors: Partial<Record<'email' | 'reason', TextPair>> = {};
    if (!EMAIL.test(email.trim())) errors.email = TEXT.emailInvalid;
    if (reason.trim().length < 10) errors.reason = TEXT.reasonShort;
    setShown(errors);
    if (!Object.keys(errors).length) {
      mutation.reset();
      setConfirming(true);
    }
  };
  const reset = () => {
    const target = email.trim();
    void ctx.track(mutation.submit({ email: target, reason: reason.trim() })).then((res) => {
      setConfirming(false);
      if (!res.ok) return;
      ctx.toast(ctx.fill(TEXT.resetDone, { email: target }));
      setEmail('');
      setReason('');
    }, () => setConfirming(false));
  };
  const error = mutation.error;
  const fields = mutation.fields;
  return (
    <Card title={TEXT.resetMfa} sub={TEXT.resetMfaSub}>
      <form className="mx-stack" style={{ maxWidth: 520 }} onSubmit={(e) => { e.preventDefault(); check(); }} noValidate>
        <Field label={TEXT.accountEmail} error={shown.email ?? fields.email ?? null} required>
          <TextInput type="email" value={email} onChange={(v) => { setEmail(v); setShown((s) => ({ ...s, email: undefined })); }} autoComplete="off" maxLength={254} />
        </Field>
        <Field label={TEXT.reason} hint={TEXT.reasonHint} error={shown.reason ?? fields.reason ?? null} required>
          <Textarea value={reason} onChange={(v) => { setReason(v); setShown((s) => ({ ...s, reason: undefined })); }} rows={3} maxLength={500} />
        </Field>
        {error && !fields.email && !fields.reason ? <Alert tone="bad">{ctx.li(error.message)}</Alert> : null}
        <div><Button type="submit" variant="danger">{ctx.li(TEXT.reset)}</Button></div>
      </form>
      <ConfirmDialog
        open={confirming}
        title={TEXT.resetConfirmTitle}
        body={ctx.fill(TEXT.resetConfirmBody, { email: email.trim() })}
        confirmLabel={TEXT.reset}
        tone="bad"
        busy={mutation.busy}
        onConfirm={reset}
        onCancel={() => setConfirming(false)}
      />
    </Card>
  );
}
