// Dialogs of the My account screen (MILESTONE-2 M2-16): change password, and new recovery codes shown once with
// "Copy" and "Download".
import { useCallback, useEffect, useState } from 'react';
import type { ApiResult } from '../../data/api/ApiClient';
import { fieldErrors, useMutation } from '../api';
import type { HostContext, TextPair } from '../types';
import { Alert, Button, Checkbox, Field, Modal, TextInput, UI_TEXT } from '../ui';
import { copyText } from '../organization/InstallationPanel';
import { codesFile, passwordErrors } from './model';
import type { AccountAdapter, Result } from './model';
import { TEXT } from './text';

const asApi = <T,>(r: Result<T>): ApiResult<T> => (r.ok ? { ok: true, status: 200, data: r.data } : { ok: false, status: r.error.status, error: r.error });

/** "Change password": current password, new password (12 characters or more) and the repeat. */
export function PasswordDialog({ ctx, adapter, open, onClose }: { ctx: HostContext; adapter: AccountAdapter; open: boolean; onClose(): void }) {
  const [form, setForm] = useState({ current: '', next: '', repeat: '' });
  const [shown, setShown] = useState<Partial<Record<'current' | 'next' | 'repeat', TextPair>>>({});
  const run = useCallback((f: { current: string; next: string }) => adapter.changePassword(f.current, f.next).then(asApi), [adapter]);
  const mutation = useMutation<{ current: string; next: string }, null>(run);
  const { reset } = mutation;
  useEffect(() => {
    if (!open) {
      setForm({ current: '', next: '', repeat: '' });
      setShown({});
      reset();
    }
  }, [open]);
  const set = (key: keyof typeof form) => (value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setShown((s) => ({ ...s, [key]: undefined }));
  };
  const submit = () => {
    const errors = passwordErrors(form);
    setShown(errors);
    if (Object.keys(errors).length) return;
    void ctx.track(mutation.submit({ current: form.current, next: form.next })).then((res) => {
      if (!res.ok) return;
      ctx.toast(ctx.li(TEXT.passwordChanged));
      onClose();
    }, () => undefined);
  };
  const error = mutation.error;
  const server = fieldErrors(error);
  // A wrong current password is 401 auth.password_invalid; the new password's policy errors come as field errors.
  const currentError = shown.current ?? (error?.messageKey === 'auth.password_invalid' ? TEXT.currentWrong : null);
  const nextError = shown.next ?? server.newPassword ?? null;
  const general = error && !currentError && !nextError ? error.message : null;
  return (
    <Modal
      open={open}
      title={TEXT.passwordTitle}
      sub={TEXT.passwordSub}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(TEXT.changePassword)}</Button>
        </>
      )}
    >
      <form className="mx-stack" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        <Field label={TEXT.currentPassword} error={currentError} required>
          <TextInput type="password" value={form.current} onChange={set('current')} autoComplete="current-password" />
        </Field>
        <Field label={TEXT.newPassword} hint={TEXT.newPasswordHint} error={nextError} required>
          <TextInput type="password" value={form.next} onChange={set('next')} autoComplete="new-password" maxLength={256} />
        </Field>
        <Field label={TEXT.repeatPassword} error={shown.repeat ?? null} required>
          <TextInput type="password" value={form.repeat} onChange={set('repeat')} autoComplete="new-password" maxLength={256} />
        </Field>
        {general ? <Alert tone="bad">{ctx.li(general)}</Alert> : null}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

/** Saves a text as a file through a link the browser follows. */
export function saveText(text: string, fileName: string): boolean {
  if (typeof document === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return false;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

/** The ten new codes, shown once, with Copy, Download and the confirmation that they were saved. */
export function CodesList({ ctx, codes, email, onDone }: { ctx: HostContext; codes: string[]; email: string; onDone(): void }) {
  const [saved, setSaved] = useState(false);
  const file = codesFile(codes, ctx.fill(TEXT.codesFileHeader, { email }));
  return (
    <div className="mx-stack" data-recovery-codes="">
      <Alert tone="warn" title={TEXT.codesShown}>{ctx.li(TEXT.codesOnce)}</Alert>
      <ul className="mx-mono" style={{ margin: 0, padding: '12px 16px', listStyle: 'none', display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px 16px', background: 'var(--sur2)', border: '1px solid var(--bd)', borderRadius: 8, color: 'var(--tx)', fontSize: 14 }}>
        {codes.map((c) => <li key={c}>{c}</li>)}
      </ul>
      <div className="mx-btn-group">
        <Button onClick={() => { void copyText(codes.join('\n')).then((ok) => ctx.toast(ctx.li(ok ? TEXT.codesCopied : TEXT.codesNotCopied))); }}>{ctx.li(TEXT.copyCodes)}</Button>
        <Button onClick={() => saveText(file, 'mscd-recovery-codes.txt')}>{ctx.li(TEXT.downloadCodes)}</Button>
      </div>
      <Checkbox checked={saved} onChange={setSaved} label={TEXT.codesSaved} />
      <div className="mx-btn-group" style={{ justifyContent: 'flex-end' }}>
        <Button variant="primary" disabled={!saved} onClick={onDone}>{ctx.li(TEXT.done)}</Button>
      </div>
    </div>
  );
}

/** "Get new recovery codes": the current authenticator code, then the codes shown once. */
export function CodesDialog({ ctx, adapter, open, email, onClose }: { ctx: HostContext; adapter: AccountAdapter; open: boolean; email: string; onClose(changed: boolean): void }) {
  const [code, setCode] = useState('');
  const [shown, setShown] = useState<TextPair | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const run = useCallback((c: string | null) => adapter.recoveryCodes(c).then(asApi), [adapter]);
  const mutation = useMutation<string | null, string[]>(run);
  const { reset } = mutation;
  useEffect(() => {
    if (!open) {
      setCode('');
      setShown(null);
      setCodes(null);
      reset();
    }
  }, [open]);
  const submit = () => {
    const value = code.trim();
    if (value && !/^\d{6}$/.test(value)) {
      setShown(TEXT.codeInvalid);
      return;
    }
    void ctx.track(mutation.submit(value || null)).then((res) => {
      if (res.ok) setCodes(res.data);
    }, () => undefined);
  };
  const error = mutation.error;
  const close = () => onClose(Boolean(codes));
  return (
    <Modal
      open={open}
      title={TEXT.codesTitle}
      sub={TEXT.codesSub}
      onClose={close}
      footer={codes ? undefined : (
        <>
          <Button onClick={close}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={mutation.busy} onClick={submit}>{ctx.li(TEXT.getCodes)}</Button>
        </>
      )}
    >
      {codes ? (
        <CodesList ctx={ctx} codes={codes} email={email} onDone={close} />
      ) : (
        <form className="mx-stack" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
          <Field label={TEXT.currentCode} hint={TEXT.currentCodeHint} error={shown ?? (error ? error.message : null)}>
            <TextInput value={code} onChange={(v) => { setCode(v.replace(/\D/g, '').slice(0, 6)); setShown(null); }} autoComplete="one-time-code" maxLength={6} />
          </Field>
          <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
        </form>
      )}
    </Modal>
  );
}
