// Organisation (MILESTONE-2 M2-16, `/admin/organization`): the settings of the organisation for the Tenant Admin with
// `org.settings.manage`: name, time zone (IANA list), number of sites, the slug read-only ("cannot be changed"), and
// the installation id with "Copy" for licence requests. A save sends `If-Match` with the ETag of the read; a 412
// (someone else saved first) keeps the form and offers to load the settings again.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApiError, ApiResult } from '../../data/api/ApiClient';
import { useMutation } from '../api';
import { canOpenHost, hostById } from '../host';
import type { HostContext, ScreenProps, TextPair } from '../types';
import { Alert, Button, Card, Facts, Field, Select, TextInput } from '../ui';
import { adapterFor, settle } from './adapter';
import { InstallationPanel } from './InstallationPanel';
import { LOCAL_LOGIN_TEXT, changesSnapshot, formErrors, formOf, patchOf, timeZones } from './model';
import type { Loaded, OrgAdapter, OrgForm, OrgPatch, OrgSettings } from './model';
import { TEXT } from './text';

/** The settings form; `onSaved` gets the settings after a save. */
export function SettingsForm({ ctx, adapter, settings, onSaved, onReload }: {
  ctx: HostContext;
  adapter: OrgAdapter;
  settings: OrgSettings;
  onSaved(settings: OrgSettings): void;
  onReload(): void;
}) {
  const [form, setForm] = useState<OrgForm>(() => formOf(settings));
  const [shown, setShown] = useState<Partial<Record<keyof OrgForm, TextPair>>>({});
  const [note, setNote] = useState<TextPair | null>(null);
  useEffect(() => setForm(formOf(settings)), [settings]);
  const zones = useMemo(() => timeZones(settings.timeZone), [settings.timeZone]);
  const run = useCallback(
    ({ patch, etag }: { patch: OrgPatch; etag: string }): Promise<ApiResult<OrgSettings>> => settle(adapter.save(patch, etag))
      .then((r) => (r.ok ? { ok: true, status: 200, data: r.settings } : { ok: false, status: r.error.status, error: r.error })),
    [adapter],
  );
  const mutation = useMutation<{ patch: OrgPatch; etag: string }, OrgSettings>(run);
  const set = (key: keyof OrgForm) => (value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setShown((s) => ({ ...s, [key]: undefined }));
    setNote(null);
    mutation.reset();
  };
  const submit = () => {
    const errors = formErrors(form);
    setShown(errors);
    if (Object.keys(errors).length) return;
    const patch = patchOf(form, settings);
    if (!Object.keys(patch).length) {
      setNote(TEXT.nothingChanged);
      return;
    }
    void ctx.track(mutation.submit({ patch, etag: settings.etag })).then((res) => {
      if (res.ok) {
        ctx.toast(ctx.li(TEXT.saved));
        onSaved(res.data);
      }
    }, () => undefined);
  };
  const error: ApiError | null = mutation.error;
  const stale = error?.status === 412;
  const fieldError = (key: keyof OrgForm) => shown[key] ?? mutation.fields[key] ?? null;
  return (
    <Card title={TEXT.settings} sub={TEXT.settingsSub}>
      <form className="mx-stack" style={{ maxWidth: 560 }} onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        <Field label={TEXT.name} hint={TEXT.nameHint} error={fieldError('name')} required>
          <TextInput value={form.name} onChange={set('name')} maxLength={220} autoComplete="organization" />
        </Field>
        <Field label={TEXT.timeZone} hint={TEXT.timeZoneHint} error={fieldError('timeZone')} required>
          <Select value={form.timeZone} onChange={set('timeZone')} options={zones.map((z) => ({ value: z, label: z }))} />
        </Field>
        <Field label={TEXT.sites} hint={TEXT.sitesHint} error={fieldError('siteCount')} required>
          <TextInput type="number" value={form.siteCount} onChange={set('siteCount')} />
        </Field>
        <Field label={TEXT.slug} hint={TEXT.slugHint}>
          <TextInput value={ctx.fill(TEXT.slugValue, { slug: settings.slug })} onChange={() => undefined} disabled />
        </Field>
        {stale ? (
          <Alert tone="warn">
            <div>{ctx.li(TEXT.stale)}</div>
            <div style={{ marginTop: 8 }}><Button onClick={() => { mutation.reset(); onReload(); }}>{ctx.li(TEXT.loadAgain)}</Button></div>
          </Alert>
        ) : null}
        {error && !stale && !Object.keys(mutation.fields).some((k) => k in form) ? <Alert tone="bad">{ctx.li(error.message)}</Alert> : null}
        {note ? <span className="mx-small" role="status">{ctx.li(note)}</span> : null}
        <div className="mx-btn-group">
          <Button type="submit" variant="primary" busy={mutation.busy}>{ctx.li(TEXT.save)}</Button>
        </div>
      </form>
    </Card>
  );
}

/** Facts about the organisation: administrators, the sign-in policy and the installation type. */
export function AboutCard({ ctx, settings }: { ctx: HostContext; settings: OrgSettings }) {
  const idp = hostById('identity-providers');
  const canIdp = Boolean(idp && canOpenHost('identity-providers', ctx, ctx.role));
  return (
    <Card title={TEXT.about}>
      <Facts
        items={[
          {
            label: TEXT.admins,
            value: (
              <>
                <span>{settings.activeAdminCount}</span>
                {settings.activeAdminCount < 2 ? <span className="mx-small" style={{ display: 'block', marginTop: 4 }}>{ctx.li(TEXT.oneAdmin)}</span> : null}
              </>
            ),
          },
          {
            label: TEXT.localLogin,
            value: (
              <span className="mx-row">
                <span>{ctx.li(LOCAL_LOGIN_TEXT[settings.localLogin])}</span>
                {canIdp && idp ? <Button variant="link" onClick={() => ctx.go('identity-providers')}>{ctx.fill(TEXT.changeSignIn, { screen: ctx.li(idp.label) })}</Button> : null}
              </span>
            ),
          },
          { label: TEXT.tenancy, value: ctx.li(settings.tenancyMode === 'multi' ? TEXT.tenancyMulti : TEXT.tenancySingle) },
        ]}
      />
    </Card>
  );
}

export default function OrganizationScreen({ ctx }: ScreenProps) {
  const org = useRef(ctx.org);
  org.current = ctx.org;
  const { client } = ctx;
  const adapter = useMemo(() => adapterFor(client, () => org.current), [client]);
  const [result, setResult] = useState<Loaded | null>(null);
  const load = useCallback(() => {
    setResult(null);
    void settle(adapter.load()).then(setResult);
  }, [adapter]);
  useEffect(() => load(), [load]);
  if (!result) return <div className="mx-small" role="status">{ctx.li(TEXT.loading)}</div>;
  if (!result.ok) {
    return (
      <Alert tone="bad" title={TEXT.loadFailed}>
        <div>{ctx.li(result.error.message)}</div>
        <div style={{ marginTop: 8 }}><Button onClick={load}>{ctx.li(TEXT.tryAgain)}</Button></div>
      </Alert>
    );
  }
  const settings = result.settings;
  return (
    <>
      <SettingsForm
        ctx={ctx}
        adapter={adapter}
        settings={settings}
        onSaved={(next) => {
          setResult({ ok: true, settings: next });
          // The sidebar shows the organisation's name and number of sites: read the snapshot again when one changed.
          if (changesSnapshot(settings, next)) void ctx.reload();
        }}
        onReload={load}
      />
      <InstallationPanel ctx={ctx} installationId={settings.installationId} tenancyMode={settings.tenancyMode} />
      <AboutCard ctx={ctx} settings={settings} />
    </>
  );
}
