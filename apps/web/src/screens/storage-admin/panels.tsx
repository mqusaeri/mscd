// The drawers of the repository administration (MILESTONE-2 M2-09): the "Connect repository" wizard (storage type,
// settings, credential, connection test) and the settings drawer of one repository (the same form with PATCH, the
// credential and the connection test). The Repository administration screen and the Storage repositories screen
// (through the claims of actions.ts) open them. Forms use `useMutation`, so Save is disabled while it runs and the
// form stays open with the server's field errors next to the fields after a refusal.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ApiError, ApiResult } from '../../data/api/ApiClient';
import { newIdempotencyKey, useMutation } from '../api';
import type { HostContext, TextPair } from '../types';
import { Alert, Badge, Button, Checkbox, Drawer, Facts, Field, Radio, TextInput, Textarea, UI_TEXT } from '../ui';
import { settled } from './adapter';
import {
  ADAPTER_HELP, ADAPTER_LABELS, CONNECTION_LABELS, CONNECTION_TONE, MODE_HELP, MODE_LABELS, OWNERSHIP_LABELS, PROVIDER_MODES, WIZARD_ADAPTERS, labelOf,
} from './labels';
import type { ModeCode, WizardAdapter } from './labels';
import {
  changesConfig, createBody, credentialBody, credentialErrors, credentialKinds, emptyCredential, emptyForm, formErrors, formOf, isDelegated,
  oauthClientOf, patchBody, serverFieldErrors, suggestSlug, vaultPrefix, wizardAdapters,
} from './model';
import type { AdminData, CredentialForm, FormErrors, RepoForm, RepoModel, Result, StorageAdminAdapter, SystemRef, TestOutcome } from './model';
import { TEXT } from './text';

/** An adapter call as the `ApiResult` that `useMutation` keeps (status, error and field errors). */
export function asApi<T>(promise: Promise<Result<T>>): Promise<ApiResult<{ data: T; message?: TextPair }>> {
  return settled(promise).then((r) => (r.ok
    ? { ok: true as const, status: 200, data: { data: r.data, ...(r.message ? { message: r.message } : {}) } }
    : { ok: false as const, status: r.error.status, error: r.error }));
}

/** The text of a refusal: the server's message, with its detail when it carries no translated message. */
export function errorText(ctx: HostContext, error: ApiError): string {
  const message = ctx.li(error.message);
  return error.detail && error.message[0] === error.message[1] && !error.messageKey ? `${message}: ${error.detail}` : message;
}

/** An instant (ISO) as a date and time in the interface language. */
export function formatInstant(iso: string | null | undefined, lang: 'en' | 'id'): string {
  if (!iso) return '-';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(lang === 'id' ? 'id-ID' : 'en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
}

/** An instant as a date in the interface language. */
export function formatDay(ctx: HostContext, iso: string | null | undefined): string {
  if (!iso) return '-';
  const day = iso.slice(0, 10);
  return ctx.D ? ctx.D.fmt(day, ctx.lang) : day;
}

/** The connection badge of a repository. */
export function ConnectionBadge({ ctx, status }: { ctx: HostContext; status: keyof typeof CONNECTION_LABELS }) {
  return <Badge tone={CONNECTION_TONE[status]}>{ctx.li(CONNECTION_LABELS[status])}</Badge>;
}

/**
 * The buttons of a drawer footer, kept clear of the Tera button that floats at the bottom right corner of the shell
 * (fixed, 24px from the edges, 54px wide), so it never covers the primary action.
 */
export function DrawerFoot({ children }: { children: ReactNode }) {
  return <div className="mx-btn-group" style={{ marginRight: 72, justifyContent: 'flex-end' }}>{children}</div>;
}

function Section({ title, children, sub }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="mx-stack" style={{ gap: 10 }}>
      <div>
        <h3 className="mx-card-title" style={{ margin: 0, fontSize: '1em' }}>{title}</h3>
        {sub ? <div className="mx-small" style={{ marginTop: 2 }}>{sub}</div> : null}
      </div>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The settings form
// ---------------------------------------------------------------------------------------------------------------

export interface RepoFieldsProps {
  ctx: HostContext;
  form: RepoForm;
  onChange(form: RepoForm): void;
  errors: FormErrors;
  systems: SystemRef[];
  mode: 'create' | 'edit';
  orgId: string | null;
  /** The Managed Vault prefix of a saved vault (fixed after creation). */
  prefix?: string;
}

/** The settings of a repository: name, short id, ownership, modes and the provider's site, drive and folders. */
export function RepoFields({ ctx, form, onChange, errors, systems, mode, orgId, prefix }: RepoFieldsProps) {
  const hintId = useId();
  const set = <K extends keyof RepoForm>(key: K, value: RepoForm[K]) => onChange({ ...form, [key]: value });
  const err = (key: string) => errors[key] ?? null;
  const provider = form.adapter !== 'managed_vault';
  const myDrive = form.adapter === 'google_drive' && form.driveKind === 'my';
  const setRoot = (ms: string, part: 'folderId' | 'path', value: string) => {
    const before = form.roots[ms] ?? { folderId: '', path: '' };
    onChange({ ...form, roots: { ...form.roots, [ms]: { ...before, [part]: value } } });
  };
  const onName = (value: string) => {
    const follow = mode === 'create' && (!form.slug || form.slug === suggestSlug(form.name));
    onChange({ ...form, name: value, ...(follow ? { slug: suggestSlug(value) } : {}) });
  };
  const toggleMode = (m: ModeCode, on: boolean) => set('modes', on ? [...new Set([...form.modes, m])] : form.modes.filter((x) => x !== m));
  const idHint = form.adapter === 'm365' ? TEXT.graphIdHint : TEXT.driveIdHint;
  return (
    <>
      <Field label={TEXT.name} hint={TEXT.nameHint} error={err('name')} required>
        <TextInput value={form.name} onChange={onName} maxLength={150} name="name" />
      </Field>
      {mode === 'create' ? (
        <Field label={TEXT.slug} hint={TEXT.slugHint} error={err('slug')} required>
          <TextInput value={form.slug} onChange={(v) => set('slug', v.trim().toLowerCase())} maxLength={20} name="slug" autoComplete="off" />
        </Field>
      ) : (
        <Facts items={[{ label: TEXT.slug, value: form.slug, mono: true }]} />
      )}

      {form.adapter === 'managed_vault' ? (
        <>
          <Facts items={[{ label: TEXT.vaultPrefix, value: mode === 'create' ? vaultPrefix(orgId, form.slug) : prefix ?? '-', mono: true }]} />
          <div className="mx-small">{ctx.li(TEXT.vaultPrefixHint)}</div>
          <Alert tone="info">{ctx.li(TEXT.vaultMode)}</Alert>
        </>
      ) : null}

      {form.adapter === 'm365' ? (
        <>
          {mode === 'create' ? (
            <Field label={TEXT.tenantId} hint={TEXT.tenantHint} error={err('tenantId')}>
              <TextInput value={form.tenantId} onChange={(v) => set('tenantId', v)} maxLength={36} name="tenantId" autoComplete="off" />
            </Field>
          ) : null}
          <Field label={TEXT.siteId} hint={TEXT.siteHint} error={err('siteId')} required>
            <TextInput value={form.siteId} onChange={(v) => set('siteId', v)} maxLength={300} name="siteId" autoComplete="off" />
          </Field>
          <Field label={TEXT.libraryId} hint={TEXT.graphIdHint} error={err('driveId')} required>
            <TextInput value={form.driveId} onChange={(v) => set('driveId', v)} maxLength={300} name="driveId" autoComplete="off" />
          </Field>
        </>
      ) : null}

      {form.adapter === 'google_drive' ? (
        <>
          <Radio
            legend={TEXT.driveKind}
            name="driveKind"
            value={form.driveKind}
            onChange={(v) => onChange({ ...form, driveKind: v as RepoForm['driveKind'], ...(v === 'my' ? { ownershipType: 'personal' as const } : {}) })}
            options={[{ value: 'shared', label: TEXT.sharedDrive }, { value: 'my', label: TEXT.myDrive }]}
          />
          {myDrive ? <Alert tone="warn">{ctx.li(TEXT.myDriveWarn)}</Alert> : (
            <Field label={TEXT.driveId} hint={TEXT.driveIdHint} error={err('driveId')} required>
              <TextInput value={form.driveId} onChange={(v) => set('driveId', v)} maxLength={300} name="driveId" autoComplete="off" />
            </Field>
          )}
        </>
      ) : null}

      {provider ? (
        <>
          <Field label={TEXT.rootFolderId} hint={[`${TEXT.rootHint[0]} ${idHint[0]}`, `${TEXT.rootHint[1]} ${idHint[1]}`]} error={err('rootFolderId')} required>
            <TextInput value={form.rootFolderId} onChange={(v) => set('rootFolderId', v)} maxLength={300} name="rootFolderId" autoComplete="off" />
          </Field>
          {form.adapter === 'google_drive' ? (
            <Field label={TEXT.oauthClientId} hint={TEXT.oauthHint} error={err('oauthClientId')}>
              <TextInput value={form.oauthClientId} onChange={(v) => set('oauthClientId', v)} maxLength={300} name="oauthClientId" autoComplete="off" />
            </Field>
          ) : null}
          {!myDrive ? (
            <Radio
              legend={TEXT.ownership}
              name="ownership"
              value={form.ownershipType}
              onChange={(v) => set('ownershipType', v as RepoForm['ownershipType'])}
              options={(['organizational', 'personal'] as const).map((o) => ({ value: o, label: OWNERSHIP_LABELS[o] }))}
            />
          ) : null}
          {form.ownershipType === 'personal' && !myDrive ? <Alert tone="warn">{ctx.li(TEXT.personalWarn)}</Alert> : null}
          <fieldset className="mx-radios" aria-describedby={hintId}>
            <legend className="mx-label">{ctx.li(TEXT.modes)}</legend>
            {PROVIDER_MODES.map((m) => (
              <div key={m} className="mx-stack" style={{ gap: 2 }}>
                <Checkbox checked={form.modes.includes(m)} onChange={(on) => toggleMode(m, on)} label={MODE_LABELS[m]} name={`mode-${m}`} />
                <span className="mx-hint" style={{ paddingLeft: 24 }}>{ctx.li(MODE_HELP[m])}</span>
              </div>
            ))}
            <span id={hintId} className="mx-hint">{ctx.li(TEXT.modesHint)}</span>
            {err('modes') ? <span className="mx-error" role="alert">{ctx.li(err('modes'))}</span> : null}
          </fieldset>
          <Section title={ctx.li(TEXT.roots)} sub={ctx.li(TEXT.rootsHint)}>
            {systems.length ? systems.map((s) => {
              const root = form.roots[s.slug] ?? { folderId: '', path: '' };
              return (
                <div key={s.slug} style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 10 }}>
                  <Field label={ctx.fill(TEXT.rootFolderOf, { code: s.code })} error={err(`root:${s.slug}`)}>
                    <TextInput value={root.folderId} onChange={(v) => setRoot(s.slug, 'folderId', v)} maxLength={300} name={`root-${s.slug}-id`} autoComplete="off" />
                  </Field>
                  <Field label={ctx.fill(TEXT.rootPathOf, { code: s.code })} hint={ctx.fill(TEXT.rootPathHint, { code: s.code })}>
                    <TextInput value={root.path} onChange={(v) => setRoot(s.slug, 'path', v)} maxLength={1024} name={`root-${s.slug}-path`} autoComplete="off" />
                  </Field>
                </div>
              );
            }) : <div className="mx-small">{ctx.li(TEXT.noSystems)}</div>}
          </Section>
        </>
      ) : null}

      <Checkbox checked={form.retentionConfirmed} onChange={(v) => set('retentionConfirmed', v)} label={TEXT.retention} name="retentionConfirmed" />
      <Checkbox checked={form.metadataMinimization} onChange={(v) => set('metadataMinimization', v)} label={TEXT.minimisation} name="metadataMinimization" />
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Credential and connection test
// ---------------------------------------------------------------------------------------------------------------

export interface CredentialSectionProps {
  ctx: HostContext;
  adapter: StorageAdminAdapter;
  repo: RepoModel;
  /** Tenant id typed in the wizard, offered again for the Microsoft 365 credential. */
  tenantId?: string;
  onSaved(delegated: boolean): void;
}

/** Set or replace the credential of a provider repository; the secret is sent once and never shown again (D-08). */
export function CredentialSection({ ctx, adapter, repo, tenantId = '', onSaved }: CredentialSectionProps) {
  const kinds = credentialKinds(repo.adapter);
  const [form, setForm] = useState<CredentialForm>(() => emptyCredential(repo.adapter, tenantId));
  const [local, setLocal] = useState<FormErrors>({});
  const [delegatedSaved, setDelegatedSaved] = useState(false);
  const save = useMutation((body: ReturnType<typeof credentialBody>) => asApi(adapter.setCredential(repo.ref, body)));
  const consent = useMutation((_: null) => asApi(adapter.consent(repo.ref)));
  if (!kinds.length) return <div className="mx-small">{ctx.li(TEXT.credVault)}</div>;
  const errors: FormErrors = { ...serverFieldErrors(save.error), ...local };
  const set = <K extends keyof CredentialForm>(key: K, value: CredentialForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setLocal((l) => ({ ...l, [key]: undefined }));
  };
  const submit = () => {
    const problems = credentialErrors(form, repo);
    setLocal(problems);
    if (Object.values(problems).some(Boolean)) return;
    save.submit(credentialBody(form, repo)).then((res) => {
      if (!res.ok) return;
      ctx.toast(ctx.li(TEXT.credentialSaved));
      const delegated = form.kind === 'oauth_refresh_token';
      setDelegatedSaved(delegated);
      // The secret is never kept on screen after it was sent (D-08).
      setForm((f) => ({ ...emptyCredential(repo.adapter, f.tenantId), kind: f.kind, clientId: f.kind === 'm365_certificate' ? f.clientId : '' }));
      onSaved(delegated);
    });
  };
  const grant = () => {
    consent.submit(null).then((res) => {
      if (!res.ok) return;
      const url = res.data.data.redirectUrl;
      if (url && typeof window !== 'undefined') {
        window.location.assign(url);
        return;
      }
      ctx.toast(ctx.li(res.data.message ?? TEXT.consentNoPage));
      onSaved(true);
    });
  };
  const err = (key: string) => errors[key] ?? null;
  const expiry = repo.credentialExpiresAt ? ctx.fill(TEXT.credStateExpiry, { date: formatDay(ctx, repo.credentialExpiresAt) }) : '';
  const delegated = form.kind === 'oauth_refresh_token';
  const canConsent = delegated && (delegatedSaved || isDelegated(repo));
  return (
    <div className="mx-stack">
      <Alert tone={repo.credentialSet ? 'ok' : 'warn'}>
        <div>{repo.credentialSet ? ctx.fill(TEXT.credStateSet, { expiry }) : ctx.li(TEXT.credStateNotSet)}</div>
        <div className="mx-small" style={{ marginTop: 4 }}>{ctx.li(TEXT.credSealed)}</div>
      </Alert>
      {kinds.length > 1 ? (
        <Radio
          legend={TEXT.credKind}
          name={`credential-kind-${repo.slug}`}
          value={form.kind}
          onChange={(v) => { setForm((f) => ({ ...f, kind: v as CredentialForm['kind'] })); setLocal({}); }}
          options={kinds.map((k) => ({ value: k, label: k === 'google_service_account' ? TEXT.kindServiceAccount : TEXT.kindConsent }))}
        />
      ) : null}
      {err('kind') ? <Alert tone="bad">{ctx.li(err('kind'))}</Alert> : null}
      {form.kind === 'm365_certificate' ? (
        <>
          <Field label={TEXT.tenantId} hint={TEXT.tenantHint} error={err('tenantId')} required>
            <TextInput value={form.tenantId} onChange={(v) => set('tenantId', v)} maxLength={36} name="credential-tenantId" autoComplete="off" />
          </Field>
          <Field label={TEXT.clientId} hint={TEXT.clientIdHint} error={err('clientId')} required>
            <TextInput value={form.clientId} onChange={(v) => set('clientId', v)} maxLength={200} name="credential-clientId" autoComplete="off" />
          </Field>
          <Field label={TEXT.certificate} hint={TEXT.certificateHint} error={err('certificatePem')} required>
            <Textarea value={form.certificatePem} onChange={(v) => set('certificatePem', v)} rows={5} mono name="credential-certificate" />
          </Field>
        </>
      ) : null}
      {form.kind === 'google_service_account' ? (
        <Field label={TEXT.clientEmail} error={err('clientEmail')} required>
          <TextInput type="email" value={form.clientEmail} onChange={(v) => set('clientEmail', v)} maxLength={254} name="credential-clientEmail" autoComplete="off" />
        </Field>
      ) : null}
      {form.kind !== 'oauth_refresh_token' ? (
        <Field label={TEXT.privateKey} hint={TEXT.privateKeyHint} error={err('privateKeyPem')} required>
          <Textarea value={form.privateKeyPem} onChange={(v) => set('privateKeyPem', v)} rows={5} mono name="credential-privateKey" />
        </Field>
      ) : (
        <>
          <Facts items={[{ label: TEXT.oauthClientId, value: oauthClientOf(repo) ?? '-', mono: true }]} />
          <Field label={TEXT.clientSecret} hint={TEXT.clientSecretHint} error={err('clientSecret')} required>
            <TextInput type="password" value={form.clientSecret} onChange={(v) => set('clientSecret', v)} maxLength={1024} name="credential-clientSecret" autoComplete="new-password" />
          </Field>
        </>
      )}
      {save.error ? <Alert tone="bad">{errorText(ctx, save.error)}</Alert> : null}
      <div className="mx-btn-group">
        <Button variant="primary" busy={save.busy} onClick={submit}>{ctx.li(repo.credentialSet ? TEXT.replaceCredential : TEXT.saveCredential)}</Button>
        {canConsent ? <Button busy={consent.busy} onClick={grant}>{ctx.li(TEXT.grantConsent)}</Button> : null}
      </div>
      {canConsent ? <div className="mx-small">{ctx.li(TEXT.consentHint)}</div> : null}
      {consent.error ? <Alert tone="bad">{errorText(ctx, consent.error)}</Alert> : null}
    </div>
  );
}

/** The connection of a repository and "Test connection" with its result (`RepositoryTestResult`). */
export function TestSection({ ctx, adapter, repo, onTested, primary }: {
  ctx: HostContext;
  adapter: StorageAdminAdapter;
  repo: RepoModel;
  onTested(outcome: TestOutcome): void;
  primary?: boolean;
}) {
  const [result, setResult] = useState<TestOutcome | null>(null);
  const run = useMutation((_: null) => asApi(adapter.test(repo.ref)));
  const test = () => {
    run.submit(null).then((res) => {
      if (!res.ok) return;
      setResult(res.data.data);
      onTested(res.data.data);
    });
  };
  const tone = result ? CONNECTION_TONE[result.status] : 'info';
  return (
    <div className="mx-stack">
      <div className="mx-row">
        <ConnectionBadge ctx={ctx} status={result?.status ?? repo.connectionStatus} />
        {repo.last && repo.last !== '-' ? <span className="mx-small">{ctx.fill(TEXT.lastCheck, { at: repo.last })}</span> : null}
      </div>
      {!result && repo.message ? <div className="mx-muted">{ctx.li(repo.message)}</div> : null}
      <div className="mx-btn-group">
        <Button variant={primary ? 'primary' : 'default'} busy={run.busy} onClick={test}>{ctx.li(TEXT.test)}</Button>
        <span className="mx-small">{ctx.li(TEXT.testHint)}</span>
      </div>
      {run.error ? <Alert tone="bad">{errorText(ctx, run.error)}</Alert> : null}
      {result ? (
        <Alert tone={tone === 'ok' ? 'ok' : tone === 'warn' ? 'warn' : 'bad'} title={CONNECTION_LABELS[result.status]} role="status">
          <div>{ctx.li(result.message)}</div>
          <div style={{ marginTop: 8 }}>
            <Facts
              items={[
                { label: TEXT.testPermissions, value: result.permissions.length ? result.permissions.join(', ') : '-' },
                { label: TEXT.testReferences, value: String(result.references) },
                { label: TEXT.testNext, value: formatInstant(result.nextCheckAt, ctx.lang) },
              ]}
            />
          </div>
        </Alert>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The wizard
// ---------------------------------------------------------------------------------------------------------------

type Step = 'type' | 'settings' | 'credential' | 'test';

export interface WizardProps {
  ctx: HostContext;
  adapter: StorageAdminAdapter;
  data: AdminData;
  open: boolean;
  onClose(): void;
  /** A repository was added or changed: reload the lists. */
  onChanged(): void;
}

/** The steps of an adapter: the Managed Vault needs no credential. */
export function stepsOf(adapter: WizardAdapter): Step[] {
  return adapter === 'managed_vault' ? ['type', 'settings', 'test'] : ['type', 'settings', 'credential', 'test'];
}

const STEP_NAMES: Readonly<Record<Step, TextPair>> = { type: TEXT.stepType, settings: TEXT.stepSettings, credential: TEXT.stepCredential, test: TEXT.stepTest };

/** "Connect repository": storage type, settings (POST), credential (PUT) and the connection test (D.2, D-08). */
export function ConnectWizard({ ctx, adapter, data, open, onClose, onChanged }: WizardProps) {
  const offered = useMemo(() => wizardAdapters(data.licensed), [data.licensed]);
  const firstChoice = offered[0] ?? 'm365';
  const [step, setStep] = useState<Step>('type');
  const [form, setForm] = useState<RepoForm>(() => emptyForm(firstChoice));
  const [local, setLocal] = useState<FormErrors>({});
  const [created, setCreated] = useState<RepoModel | null>(null);
  const key = useRef(newIdempotencyKey());
  const create = useMutation((body: ReturnType<typeof createBody>) => asApi(adapter.create(body, key.current)));
  const { reset } = create;
  useEffect(() => {
    if (open) return;
    setStep('type');
    setForm(emptyForm(firstChoice));
    setLocal({});
    setCreated(null);
    key.current = newIdempotencyKey();
    reset();
    // Runs when the drawer closes. `reset` clears the error through a stable state setter, so it is no dependency.
  }, [open, firstChoice]);
  const steps = stepsOf(form.adapter);
  const at = steps.indexOf(step) + 1;
  const server = serverFieldErrors(create.error);
  if (create.error?.slug === 'conflict' && /slug/i.test(create.error.detail ?? '')) server.slug = create.error.detail;
  const errors: FormErrors = { ...server, ...Object.fromEntries(Object.entries(local).filter(([, v]) => v)) };
  const unmapped = create.error && !Object.keys(server).length;
  const chooseAdapter = (a: WizardAdapter) => setForm((f) => ({ ...emptyForm(a), name: f.name, slug: f.slug }));
  const onForm = (next: RepoForm) => {
    setForm(next);
    if (Object.keys(local).length) setLocal(formErrors(next, 'create'));
  };
  const save = () => {
    const problems = formErrors(form, 'create');
    setLocal(problems);
    if (Object.values(problems).some(Boolean)) return;
    create.submit(createBody(form, data.orgId)).then((res) => {
      if (!res.ok) return;
      setCreated(res.data.data);
      ctx.toast(ctx.fill(TEXT.created, { name: res.data.data.name }));
      onChanged();
      setStep(form.adapter === 'managed_vault' ? 'test' : 'credential');
    });
  };
  let body: ReactNode = null;
  let footer: ReactNode = null;
  const cancel = <Button onClick={onClose}>{ctx.li(created ? UI_TEXT.close : UI_TEXT.cancel)}</Button>;
  if (step === 'type') {
    body = (
      <fieldset className="mx-radios">
        <legend className="mx-label">{ctx.li(TEXT.chooseType)}</legend>
        <span className="mx-hint">{ctx.li(data.licensed ? TEXT.typesFromLicence : TEXT.typesUnknown)}</span>
        {WIZARD_ADAPTERS.map((a) => {
          const allowed = offered.includes(a);
          return (
            <div key={a} className="mx-stack" style={{ gap: 2, paddingTop: 6 }}>
              <label className="mx-check">
                <input type="radio" name="wizard-adapter" value={a} checked={form.adapter === a} disabled={!allowed} onChange={() => chooseAdapter(a)} />
                <span style={{ fontWeight: 600 }}>{ctx.li(ADAPTER_LABELS[a])}</span>
              </label>
              <span className="mx-hint" style={{ paddingLeft: 24 }}>{ctx.li(allowed ? ADAPTER_HELP[a] : TEXT.typeNotLicensed)}</span>
            </div>
          );
        })}
      </fieldset>
    );
    footer = <DrawerFoot>{cancel}<Button variant="primary" disabled={!offered.includes(form.adapter)} onClick={() => setStep('settings')}>{ctx.li(TEXT.next)}</Button></DrawerFoot>;
  } else if (step === 'settings') {
    body = (
      <>
        <Facts items={[{ label: TEXT.stepType, value: ctx.li(ADAPTER_LABELS[form.adapter]) }]} />
        <RepoFields ctx={ctx} form={form} onChange={onForm} errors={errors} systems={data.systems} mode="create" orgId={data.orgId} />
        {unmapped && create.error ? <Alert tone="bad">{errorText(ctx, create.error)}</Alert> : null}
      </>
    );
    footer = <DrawerFoot>{cancel}<Button onClick={() => { create.reset(); setLocal({}); setStep('type'); }}>{ctx.li(TEXT.back)}</Button><Button variant="primary" busy={create.busy} onClick={save}>{ctx.li(TEXT.saveContinue)}</Button></DrawerFoot>;
  } else if (created && step === 'credential') {
    body = (
      <>
        <Alert tone="ok">{ctx.li(TEXT.createdNote)}</Alert>
        <CredentialSection ctx={ctx} adapter={adapter} repo={created} tenantId={form.tenantId} onSaved={(delegated) => { onChanged(); setCreated((c) => (c ? { ...c, credentialSet: true, actions: delegated ? [...new Set([...c.actions, 'reauthorise'])] : c.actions } : c)); if (!delegated) setStep('test'); }} />
      </>
    );
    footer = <DrawerFoot>{cancel}<Button onClick={() => setStep('test')}>{ctx.li(created.credentialSet ? TEXT.next : TEXT.skip)}</Button></DrawerFoot>;
  } else if (created) {
    body = (
      <>
        {form.adapter === 'managed_vault' ? <Alert tone="ok">{ctx.li(TEXT.createdNote)}</Alert> : null}
        <TestSection ctx={ctx} adapter={adapter} repo={created} primary onTested={(o) => { setCreated((c) => (c ? { ...c, connectionStatus: o.status } : c)); onChanged(); }} />
      </>
    );
    footer = <DrawerFoot><Button variant="primary" onClick={onClose}>{ctx.li(TEXT.done)}</Button></DrawerFoot>;
  }
  return (
    <Drawer open={open} title={TEXT.wizardTitle} crumb={TEXT.crumb} onClose={onClose} footer={footer}>
      <div className="mx-small" aria-live="polite">{step === 'type' ? ctx.fill(TEXT.stepFirst, { name: ctx.li(STEP_NAMES[step]) }) : ctx.fill(TEXT.stepOf, { n: at, total: steps.length, name: ctx.li(STEP_NAMES[step]) })}</div>
      {data.sample ? <Alert tone="info">{ctx.li(TEXT.sampleNote)}</Alert> : null}
      {body}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The settings drawer
// ---------------------------------------------------------------------------------------------------------------

export interface PanelProps {
  ctx: HostContext;
  adapter: StorageAdminAdapter;
  data: AdminData;
  repo: RepoModel | null;
  open: boolean;
  onClose(): void;
  onChanged(): void;
  /** Opens the Repository administration screen (given when the drawer opens over another screen). */
  onOpenAdmin?(): void;
}

/** "Settings" of one repository: connection test, the settings form (PATCH) and the credential. */
export function RepositoryPanel({ ctx, adapter, data, repo: given, open, onClose, onChanged, onOpenAdmin }: PanelProps) {
  const [repo, setRepo] = useState<RepoModel | null>(given);
  const [form, setForm] = useState<RepoForm | null>(() => (given ? formOf(given) : null));
  const [local, setLocal] = useState<FormErrors>({});
  const [note, setNote] = useState<TextPair | null>(null);
  const update = useMutation((body: NonNullable<ReturnType<typeof patchBody>>) => asApi(adapter.update(given?.ref ?? '', body)));
  const { reset } = update;
  useEffect(() => {
    setRepo(given);
    setForm(given ? formOf(given) : null);
    setLocal({});
    setNote(null);
    reset();
    // Only a different repository, or opening the drawer again, starts the form again (not every new snapshot).
  }, [given?.ref, open]);
  if (!repo || !form) {
    return (
      <Drawer open={open} title={TEXT.settings} crumb={TEXT.crumb} onClose={onClose}>
        <Alert tone="bad">{ctx.li(TEXT.notFound)}</Alert>
      </Drawer>
    );
  }
  const errors: FormErrors = { ...serverFieldErrors(update.error), ...Object.fromEntries(Object.entries(local).filter(([, v]) => v)) };
  const save = () => {
    const problems = formErrors(form, 'edit');
    setLocal(problems);
    setNote(null);
    if (Object.values(problems).some(Boolean)) return;
    const patch = patchBody(form, repo);
    if (!patch) {
      setNote(TEXT.nothingChanged);
      return;
    }
    update.submit(patch).then((res) => {
      if (!res.ok) return;
      const next = res.data.data;
      setRepo(next);
      setForm(formOf(next));
      ctx.toast(ctx.fill(TEXT.saved, { name: next.name }));
      if (changesConfig(patch) && next.adapter !== 'managed_vault' && !next.credentialSet) setNote(TEXT.credentialRevoked);
      onChanged();
    });
  };
  return (
    <Drawer
      open={open}
      title={repo.name}
      crumb={[`${TEXT.crumb[0]}, ${TEXT.settings[0]}`, `${TEXT.crumb[1]}, ${TEXT.settings[1]}`]}
      onClose={onClose}
      footer={<DrawerFoot><Button onClick={onClose}>{ctx.li(UI_TEXT.close)}</Button><Button variant="primary" busy={update.busy} onClick={save}>{ctx.li(UI_TEXT.save)}</Button></DrawerFoot>}
    >
      {data.sample ? <Alert tone="info">{ctx.li(TEXT.sampleNote)}</Alert> : null}
      {onOpenAdmin ? <div><Button variant="link" onClick={onOpenAdmin}>{ctx.li(TEXT.openAdmin)}</Button></div> : null}
      <Section title={ctx.li(TEXT.testTitle)}>
        <TestSection ctx={ctx} adapter={adapter} repo={repo} onTested={(o) => { setRepo((r) => (r ? { ...r, connectionStatus: o.status, message: o.status === 'ok' ? null : o.message } : r)); onChanged(); }} />
      </Section>
      <Section title={ctx.li(TEXT.settings)} sub={ctx.li(labelOf(ADAPTER_LABELS, repo.adapter))}>
        {repo.adapter !== 'managed_vault' ? <Alert tone="info">{ctx.li(TEXT.configNote)}</Alert> : null}
        <RepoFields ctx={ctx} form={form} prefix={String(repo.config.prefix ?? '-')} onChange={(f) => { setForm(f); if (Object.keys(local).length) setLocal(formErrors(f, 'edit')); }} errors={errors} systems={data.systems} mode="edit" orgId={data.orgId} />
        {update.error && !Object.keys(serverFieldErrors(update.error)).length ? <Alert tone="bad">{errorText(ctx, update.error)}</Alert> : null}
        {note ? <Alert tone={note === TEXT.credentialRevoked ? 'warn' : 'info'}>{ctx.li(note)}</Alert> : null}
      </Section>
      {repo.adapter !== 'managed_vault' ? (
        <Section title={ctx.li(TEXT.credTitle)}>
          <CredentialSection ctx={ctx} adapter={adapter} repo={repo} onSaved={(delegated) => { setRepo((r) => (r ? { ...r, credentialSet: true, actions: delegated ? [...new Set([...r.actions, 'reauthorise'])] : r.actions } : r)); onChanged(); }} />
        </Section>
      ) : null}
    </Drawer>
  );
}
