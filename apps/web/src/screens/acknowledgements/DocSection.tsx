// The section "Read confirmation" of a document's detail (MILESTONE-3 M3-05, D.7, C.5): the read confirmation settings
// of the document for whoever manages documents in the system (`document.manage`), with the dialog that changes them
// (`documents.update`, the BR-22 confirmation for a shared document), and the confirmed count of the document's latest
// request for whoever sees the register's totals, with a link to "Policy read confirmations".
//
// Until the snapshot carries the stored settings (the `acknowledgement` member of the document record, D.2), an API
// build knows them only after they were saved in this page session. When they are unknown the section says so, and the
// dialog shows no current value for "ask for confirmation": it says that the fields start from the defaults and that
// saving replaces the stored settings, and it saves only after the manager chose yes or no.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MsId } from '../../data/types';
import type { DetailProps, HostContext, TextPair } from '../types';
import { Alert, Button, Checkbox, Field, Modal, Radio, TextInput, UI_TEXT } from '../ui';
import { adapterFor } from './adapter';
import type { AcknowledgementRole, AcknowledgementScope, AcknowledgementsAdapter, RequestRow, Settings } from './model';
import {
  AUDIENCE_ROLES, DEFAULT_SETTINGS, DOCUMENT_PERM, SCOPES, SCREEN_ID, SCREEN_PERMS, audienceText, errorText, requestsOf, roleLabel, settled,
} from './model';
import { TEXT } from './text';

/**
 * The checks of the settings form before it is saved; null when it can be saved. `required` is null while the stored
 * settings are unknown and the manager has not chosen yet.
 */
export function settingsBlock(s: { required: boolean | null; scope: AcknowledgementScope; roles: readonly AcknowledgementRole[]; dueDays: string }): TextPair | null {
  if (s.required === null) return TEXT.chooseRequired;
  if (s.scope === 'roles' && s.roles.length === 0) return TEXT.chooseRoles;
  const days = Number(s.dueDays);
  if (!/^\d+$/.test(s.dueDays.trim()) || days < 1 || days > 90) return TEXT.badDays;
  return null;
}

/**
 * The settings dialog of a document; after a 409 `confirmation-required` (BR-22) it asks before saving again. `initial`
 * is null when the stored settings are unknown: no current value is shown for "ask for confirmation", a notice says
 * that saving replaces the stored settings, and Save asks for a choice first.
 */
export function SettingsDialog({ ctx, adapter, ms, code, initial, onCancel, onSaved }: {
  ctx: HostContext;
  adapter: AcknowledgementsAdapter;
  ms: MsId;
  code: string;
  initial: Settings | null;
  onCancel(): void;
  onSaved(settings: Settings): void;
}) {
  const known = initial !== null;
  const start = initial ?? DEFAULT_SETTINGS;
  const [required, setRequired] = useState<boolean | null>(known ? start.required : null);
  const [scope, setScope] = useState<AcknowledgementScope>(start.scope);
  const [roles, setRoles] = useState<AcknowledgementRole[]>(start.roles ?? []);
  const [days, setDays] = useState(String(start.dueDays));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<TextPair | string | null>(null);
  const [shared, setShared] = useState<TextPair | null>(null);
  const toggle = (role: AcknowledgementRole, on: boolean) => setRoles((list) => (on ? [...list, role] : list.filter((r) => r !== role)));
  const save = (confirm: boolean) => {
    const block = settingsBlock({ required, scope, roles, dueDays: days });
    if (block) {
      setError(block);
      return;
    }
    const settings: Settings = { required: required === true, scope, roles: scope === 'roles' ? AUDIENCE_ROLES.filter((r) => roles.includes(r)) : null, dueDays: Number(days) };
    setBusy(true);
    setError(null);
    void ctx.track(settled(adapter.saveSettings(ms, code, settings, confirm))).then((res) => {
      setBusy(false);
      if (!res.ok) {
        if (res.error.slug === 'confirmation-required') {
          setShared(res.error.message);
          return;
        }
        setShared(null);
        setError(errorText(ctx, res.error));
        return;
      }
      setShared(null);
      ctx.toast(ctx.fill(TEXT.saved, { code }));
      if (res.data.changed.length) ctx.reload(res.data.changed).catch(() => undefined);
      onSaved(settings);
    });
  };
  if (shared) {
    return (
      <Modal
        open
        title={TEXT.sharedTitle}
        onClose={() => setShared(null)}
        layer={ctx.layer()}
        footer={(
          <>
            <Button onClick={() => setShared(null)}>{ctx.li(UI_TEXT.cancel)}</Button>
            <Button variant="primary" busy={busy} onClick={() => save(true)}>{ctx.li(TEXT.applyAll)}</Button>
          </>
        )}
      >
        <div className="mx-muted">{ctx.li(shared)}</div>
      </Modal>
    );
  }
  return (
    <Modal
      open
      title={ctx.fill(TEXT.settingsTitle, { code })}
      sub={TEXT.settingsSub}
      onClose={onCancel}
      layer={ctx.layer()}
      footer={(
        <>
          <Button onClick={onCancel}>{ctx.li(UI_TEXT.cancel)}</Button>
          <Button variant="primary" busy={busy} onClick={() => save(false)}>{ctx.li(TEXT.save)}</Button>
        </>
      )}
    >
      <div className="mx-stack" data-acknowledgement-settings={code} data-settings-known={known ? 'true' : 'false'}>
        {known ? (
          <Checkbox name="required" checked={required === true} onChange={(on) => { setRequired(on); setError(null); }} label={TEXT.required} />
        ) : (
          <>
            <Alert tone="warn">{ctx.li(TEXT.settingsUnknown)}</Alert>
            <Radio
              legend={TEXT.requiredLegend}
              name="required"
              value={required === null ? '' : required ? 'yes' : 'no'}
              onChange={(v) => { setRequired(v === 'yes'); setError(null); }}
              options={[{ value: 'yes', label: TEXT.required }, { value: 'no', label: TEXT.notRequired }]}
            />
          </>
        )}
        <Radio
          legend={TEXT.audience}
          name="scope"
          value={scope}
          onChange={(v) => { setScope(v as AcknowledgementScope); setError(null); }}
          options={SCOPES.map((s) => ({ value: s, label: s === 'roles' ? TEXT.scopeRoles : s === 'organisation' ? TEXT.scopeOrganisation : TEXT.scopeSystemRoles }))}
        />
        {scope === 'roles' ? (
          <fieldset className="mx-radios">
            <legend className="mx-label">{ctx.li(TEXT.roles)}</legend>
            <div className="mx-ack-roles">
              {AUDIENCE_ROLES.map((r) => <Checkbox key={r} name={`role-${r}`} checked={roles.includes(r)} onChange={(on) => toggle(r, on)} label={roleLabel(r)} />)}
            </div>
            <span className="mx-hint">{ctx.li(TEXT.rolesHint)}</span>
          </fieldset>
        ) : null}
        <div style={{ maxWidth: 220 }}>
          <Field label={TEXT.dueDays} hint={TEXT.dueDaysHint}>
            <TextInput type="number" value={days} onChange={(v) => { setDays(v); setError(null); }} name="dueDays" />
          </Field>
        </div>
        {error ? <div className="mx-error" role="alert">{typeof error === 'string' ? error : ctx.li(error)}</div> : null}
      </div>
    </Modal>
  );
}

/** The latest request of a document as one line: version, confirmed of the audience, overdue people. */
export function latestLine(ctx: Pick<HostContext, 'fill' | 'li'>, request: RequestRow): string {
  const t = request.totals;
  const line = ctx.fill(TEXT.sectionLatest, { version: request.version.label, confirmed: t.confirmed, audience: t.audience });
  return t.overdue > 0 ? `${line}, ${ctx.fill(TEXT.sectionOverdue, { n: t.overdue })}` : line;
}

export default function DocSection({ ctx, ms, record }: DetailProps) {
  const code = (record as { id?: string } | null)?.id ?? '';
  const adapter = adapterFor(ctx);
  const manager = ctx.can(ms, DOCUMENT_PERM);
  const seesTotals = ctx.can(ms, [...SCREEN_PERMS]);
  const [requests, setRequests] = useState<RequestRow[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(() => adapter.settingsOf(ms, code, record));
  const [editing, setEditing] = useState(false);
  const live = useRef(true);
  useEffect(() => () => {
    live.current = false;
  }, []);
  const load = useCallback(() => {
    if (!seesTotals || !code) return;
    void settled(adapter.list(ms)).then((res) => {
      if (!live.current) return;
      setRequests(res.ok ? requestsOf(res.data, code) : []);
      setSettings(adapter.settingsOf(ms, code, record));
    });
  }, [adapter, ms, code, seesTotals]);
  useEffect(() => load(), [load]);
  if (!code) return null;
  const latest = requests?.[0] ?? null;
  const settingText = settings
    ? settings.required
      ? ctx.fill(TEXT.sectionOn, { audience: audienceText(ctx, settings.scope, settings.roles), days: settings.dueDays })
      : ctx.li(TEXT.sectionOff)
    // The sample adapter knows every setting once its module has loaded (a moment after the first render).
    : manager && !adapter.sample ? ctx.li(TEXT.sectionUnknown) : null;
  return (
    <section className="mx-ack-section" data-read-confirmation={code} aria-label={ctx.li(TEXT.sectionTitle)}>
      <h3 className="mx-ack-section-title">{ctx.li(TEXT.sectionTitle)}</h3>
      {settingText ? <p data-setting="">{settingText}</p> : null}
      {seesTotals && requests ? <p className="mx-ack-latest" data-latest="">{latest ? latestLine(ctx, latest) : ctx.li(TEXT.sectionNone)}</p> : null}
      <div className="mx-ack-actions">
        {manager ? <Button onClick={() => setEditing(true)}>{ctx.li(TEXT.settings)}</Button> : null}
        {seesTotals ? <Button variant="link" onClick={() => ctx.go(SCREEN_ID, { ms, params: latest ? { request: latest.id } : {} })}>{ctx.li(TEXT.openRegister)}</Button> : null}
      </div>
      {editing ? (
        <SettingsDialog
          ctx={ctx}
          adapter={adapter}
          ms={ms}
          code={code}
          initial={settings}
          onCancel={() => setEditing(false)}
          onSaved={(next) => {
            setSettings(next);
            setEditing(false);
          }}
        />
      ) : null}
    </section>
  );
}
