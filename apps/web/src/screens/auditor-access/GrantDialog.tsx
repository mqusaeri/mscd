// "Grant auditor access" (MILESTONE-2 M2-15): the auditor's email and "Valid for (days)" from 1 to 30
// (`auditor-access.grant`, F.14). It replaces the email prompt of Audit readiness (claim `audit.auditorAccess`, C.5) and
// opens from the Auditor access screen. The link goes to the auditor by email and is never shown.
import { useState } from 'react';
import type { MsId } from '../../data/types';
import { fieldErrors, newIdempotencyKey, useMutation } from '../api';
import type { HostContext } from '../types';
import { Alert, Button, Field, Modal, TextInput, UI_TEXT } from '../ui';
import { adapterFor } from './adapter';
import { asApiResult, emptyGrant, grantBody, grantErrors } from './model';
import type { GrantBody, GrantForm } from './model';
import { TEXT } from './text';

export function GrantDialog({ ctx, ms, onClose, onGranted }: { ctx: HostContext; ms: MsId; onClose(): void; onGranted(text: string): void }) {
  const adapter = adapterFor(ctx);
  const [form, setForm] = useState<GrantForm>(emptyGrant);
  const [errors, setErrors] = useState<ReturnType<typeof grantErrors>>({});
  const [key] = useState(newIdempotencyKey);
  const mutation = useMutation((body: GrantBody) => asApiResult(adapter.grant(ms, body, key)));
  const submit = () => {
    const found = grantErrors(form);
    setErrors(found);
    if (Object.keys(found).length) return;
    const body = grantBody(form);
    ctx.track(mutation.submit(body)).then((res) => {
      if (res.ok) onGranted(ctx.fill(TEXT.granted, { n: body.expiresInDays, email: body.email }));
    }, () => undefined);
  };
  const f = fieldErrors(mutation.error);
  const general = mutation.error && !f.email && !f.expiresInDays ? mutation.error : null;
  return (
    <Modal
      open
      title={TEXT.grantTitle}
      sub={TEXT.grantSub}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(TEXT.grantAction)}</Button>
        </>
      )}
    >
      {general ? <Alert tone="bad">{ctx.li(general.message)}</Alert> : null}
      <Field label={TEXT.fEmail} error={errors.email ?? f.email ?? null} required>
        <TextInput name="email" type="email" autoComplete="off" value={form.email} onChange={(v) => { setForm((c) => ({ ...c, email: v })); setErrors((e) => ({ ...e, email: undefined })); }} maxLength={254} />
      </Field>
      <Field label={TEXT.fDays} hint={TEXT.fDaysHint} error={errors.days ?? f.expiresInDays ?? null} required>
        <TextInput name="days" type="number" value={form.days} onChange={(v) => { setForm((c) => ({ ...c, days: v })); setErrors((e) => ({ ...e, days: undefined })); }} />
      </Field>
    </Modal>
  );
}

export default GrantDialog;
