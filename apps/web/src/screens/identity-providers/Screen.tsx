// Company sign-in (MILESTONE-2 M2-10, `/admin/sign-in`): the OIDC and SAML identity providers of the organisation
// (name, protocol, short id, state, last test), "Add OIDC provider" and "Add SAML provider" (with "Paste metadata XML",
// read in the browser into the fields of `admin.idp.create`), "Test" with the discovery result, "Disable" with the
// warning that its sessions end, the SP metadata address of a SAML provider, and the local sign-in policy (allowed,
// administrators only, disabled) with the warning to test company sign-in first.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ApiError, ApiResult } from '../../data/api/ApiClient';
import { newIdempotencyKey, useMutation } from '../api';
import type { HostContext, ScreenProps, TextPair } from '../types';
import {
  Alert, Badge, Button, Card, Checkbox, ConfirmDialog, Drawer, EmptyState, Facts, Field, Modal, Radio, Select, Table, TextInput, Textarea, UI_TEXT, useText,
} from '../ui';
import type { Column } from '../ui';
import { Illustration } from '../../illustrations';
import { adapterFor, settled } from './adapter';
import {
  ICONS, POLICIES, emptyOidc, emptySaml, endpointLabel, fillFromMetadata, iconLabel, lastTest, oidcErrors, oidcRequest, parseSamlMetadata, policyLabel,
  rememberTest, samlErrors, samlRequest, serverFieldErrors, suggestSlug,
} from './model';
import type { FormErrors, IdpAdapter, OidcForm, PolicyCode, PolicyModel, ProviderModel, Result, SamlForm, TestOutcome } from './model';
import { ROUTES, pathOf } from './routes';
import { TEXT } from './text';

/** The text of a refusal: the server's message, with its detail when it carries no translated message. */
export function errorText(ctx: HostContext, error: ApiError): string {
  const message = ctx.li(error.message);
  return error.detail && error.message[0] === error.message[1] && !error.messageKey ? `${message}: ${error.detail}` : message;
}

/** An instant as a date and time in the interface language. */
export function formatInstant(iso: string, lang: 'en' | 'id'): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(lang === 'id' ? 'id-ID' : 'en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
}

/** An adapter call as the `ApiResult` that `useMutation` keeps. */
function asApi<T>(promise: Promise<Result<T>>): Promise<ApiResult<T>> {
  return settled(promise).then((r) => (r.ok ? { ok: true as const, status: 200, data: r.data } : { ok: false as const, status: r.error.status, error: r.error }));
}

/** Absolute address of an api path on this installation (the SP metadata and the OIDC redirect address). */
function absolute(path: string): string {
  return typeof window !== 'undefined' && window.location ? `${window.location.origin}${path}` : path;
}

/** Footer buttons of a drawer, kept clear of the floating Tera button at the bottom right corner of the shell. */
function DrawerFoot({ children }: { children: ReactNode }) {
  return <div className="mx-btn-group" style={{ marginRight: 72, justifyContent: 'flex-end' }}>{children}</div>;
}

function Section({ title, children }: { title: TextPair; children: ReactNode }) {
  const t = useText();
  return (
    <section className="mx-stack" style={{ gap: 10, paddingTop: 4 }}>
      <h3 className="mx-card-title" style={{ margin: 0, fontSize: '1em' }}>{t(title)}</h3>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The providers table
// ---------------------------------------------------------------------------------------------------------------

export function testText(ctx: HostContext, outcome: TestOutcome | null): string {
  if (!outcome) return ctx.li(TEXT.notTested);
  return ctx.fill(outcome.ok ? TEXT.testPassed : TEXT.testFailedAt, { at: formatInstant(outcome.at, ctx.lang) });
}

export function ProvidersTable({ ctx, providers, busy, onTest, onDisable, onEnable }: {
  ctx: HostContext;
  providers: ProviderModel[];
  busy: string | null;
  onTest(p: ProviderModel): void;
  onDisable(p: ProviderModel): void;
  onEnable(p: ProviderModel): void;
}) {
  const columns: Column<ProviderModel>[] = [
    {
      key: 'name',
      label: TEXT.colName,
      render: (p) => (
        <div className="mx-stack" style={{ gap: 2 }}>
          <span style={{ fontWeight: 600 }}>{p.displayName}</span>
          <span className="mx-small mx-mono">{p.slug}</span>
          {p.jitProvisioning && p.allowedEmailDomains.length ? <span className="mx-small">{ctx.fill(TEXT.jitOn, { domains: p.allowedEmailDomains.join(', ') })}</span> : null}
        </div>
      ),
    },
    {
      key: 'protocol',
      label: TEXT.colProtocol,
      render: (p) => (
        <div className="mx-stack" style={{ gap: 2 }}>
          <span>{p.kind === 'oidc' ? 'OpenID Connect' : 'SAML 2.0'}</span>
          <span className="mx-small" style={{ overflowWrap: 'anywhere' }}>{p.oidc?.issuer ?? p.saml?.idpIssuer ?? ''}</span>
          {p.kind === 'saml' ? (
            <a className="mx-small" href={pathOf(ROUTES.samlMetadata, p.slug)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--acc)' }}>{ctx.li(TEXT.spMetadata)}</a>
          ) : null}
        </div>
      ),
    },
    {
      key: 'state',
      label: TEXT.colState,
      render: (p) => (
        <div className="mx-stack" style={{ gap: 4 }}>
          <span><Badge tone={p.enabled ? 'ok' : 'mute'}>{ctx.li(p.enabled ? TEXT.enabled : TEXT.disabled)}</Badge></span>
          <span className="mx-small">{ctx.li(!p.requireMfaClaim ? TEXT.mfaLocal : p.mfaFallback === 'reject' ? TEXT.mfaReject : TEXT.mfaClaim)}</span>
        </div>
      ),
    },
    {
      key: 'test',
      label: TEXT.colTest,
      render: (p) => {
        const t = lastTest(p.id);
        return <span className={t && !t.ok ? undefined : 'mx-small'} style={t && !t.ok ? { color: 'var(--bad)', fontSize: 12, fontWeight: 600 } : undefined}>{testText(ctx, t)}</span>;
      },
    },
    {
      key: 'actions',
      label: TEXT.colActions,
      width: 220,
      render: (p) => (
        <div className="mx-btn-group">
          <Button busy={busy === `test:${p.id}`} onClick={() => onTest(p)}>{ctx.li(TEXT.test)}</Button>
          {p.enabled
            ? <Button variant="danger" disabled={busy === `state:${p.id}`} onClick={() => onDisable(p)}>{ctx.li(TEXT.disable)}</Button>
            : <Button busy={busy === `state:${p.id}`} onClick={() => onEnable(p)}>{ctx.li(TEXT.enable)}</Button>}
        </div>
      ),
    },
  ];
  return <Table columns={columns} rows={providers} rowKey={(p) => p.id} />;
}

/** The result of a test: the endpoints found, or why it failed. */
export function TestResultDialog({ ctx, provider, outcome, onClose }: { ctx: HostContext; provider: ProviderModel | null; outcome: TestOutcome | null; onClose(): void }) {
  return (
    <Modal
      open={Boolean(provider && outcome)}
      title={provider ? ctx.fill(TEXT.testTitle, { name: provider.displayName }) : ''}
      onClose={onClose}
      footer={<Button variant="primary" onClick={onClose}>{ctx.li(UI_TEXT.close)}</Button>}
    >
      {outcome ? (
        <>
          <Alert tone={outcome.ok ? 'ok' : 'bad'}>{outcome.ok ? ctx.li(TEXT.testOk) : `${ctx.li(TEXT.testFailed)}${outcome.message ? ` ${outcome.message}` : ''}`}</Alert>
          <Facts
            items={[
              { label: TEXT.issuer, value: <span style={{ overflowWrap: 'anywhere' }}>{outcome.issuer || '-'}</span> },
              ...Object.entries(outcome.endpoints).map(([name, url]) => ({ label: endpointLabel(name), value: <span style={{ overflowWrap: 'anywhere' }}>{url}</span> })),
            ]}
          />
        </>
      ) : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Add OIDC provider and Add SAML provider
// ---------------------------------------------------------------------------------------------------------------

const OIDC_FIELDS: readonly (keyof OidcForm)[] = ['slug', 'displayName', 'icon', 'issuer', 'clientId', 'clientSecret', 'scopes', 'subjectMode', 'entraTenantId', 'requireMfaClaim', 'mfaFallback', 'jitProvisioning', 'domains'];
const SAML_FIELDS: readonly (keyof SamlForm)[] = ['slug', 'displayName', 'icon', 'entryPoint', 'idpIssuer', 'idpCerts', 'spEntityId', 'mfaAuthnContexts', 'requireMfaClaim', 'mfaFallback'];

/** Button label, icon and short id of both forms. */
function CommonFields<F extends OidcForm | SamlForm>({ form, set, err }: {
  form: F;
  set<K extends keyof F>(k: K, v: F[K]): void;
  err(k: keyof F): TextPair | string | null;
}) {
  return (
    <>
      <Field label={TEXT.buttonLabel} hint={TEXT.buttonLabelHint} error={err('displayName')} required>
        <TextInput value={form.displayName} onChange={(v) => set('displayName', v as F['displayName'])} name="displayName" maxLength={100} />
      </Field>
      <Field label={TEXT.slug} hint={TEXT.slugHint} error={err('slug')} required>
        <TextInput value={form.slug} onChange={(v) => set('slug', v.toLowerCase() as F['slug'])} name="slug" maxLength={40} autoComplete="off" />
      </Field>
      <Field label={TEXT.icon}>
        <Select value={form.icon} onChange={(v) => set('icon', v as F['icon'])} options={ICONS.map((i) => ({ value: i, label: iconLabel(i) }))} name="icon" />
      </Field>
    </>
  );
}

/** The second factor settings of both forms (F.5). */
function MfaFields<F extends OidcForm | SamlForm>({ form, set, err, name }: {
  form: F;
  set<K extends keyof F>(k: K, v: F[K]): void;
  err(k: keyof F): TextPair | string | null;
  name: string;
}) {
  const t = useText();
  const fallbackError = err('mfaFallback');
  return (
    <Section title={TEXT.mfaTitle}>
      <Field label={TEXT.mfaTitle} hint={TEXT.requireMfaHint}>
        <Checkbox checked={form.requireMfaClaim} onChange={(v) => set('requireMfaClaim', v as F['requireMfaClaim'])} label={TEXT.requireMfa} name="requireMfaClaim" />
      </Field>
      <Radio
        legend={TEXT.mfaFallback}
        name={`${name}-fallback`}
        value={form.mfaFallback}
        onChange={(v) => set('mfaFallback', v as F['mfaFallback'])}
        options={[{ value: 'local_totp', label: TEXT.fallback_local_totp }, { value: 'reject', label: TEXT.fallback_reject }]}
      />
      {fallbackError ? <div className="mx-error" role="alert">{t(fallbackError)}</div> : null}
    </Section>
  );
}

function useForm<F extends OidcForm | SamlForm>(initial: () => F, check: (f: F) => FormErrors<F>) {
  const [form, setForm] = useState<F>(initial);
  const [local, setLocal] = useState<FormErrors<F>>({});
  // Once Save was pressed, every change checks the form again, so errors appear and go as the person types.
  const [tried, setTried] = useState(false);
  // The short id follows the button label until the person types one.
  const slugEdited = useRef(false);
  const set = <K extends keyof F>(k: K, v: F[K]) => setForm((f) => ({ ...f, [k]: v }));
  useEffect(() => {
    if (tried) setLocal(check(form));
  }, [form, tried]);
  const reset = (next: F) => {
    setForm(next);
    setLocal({});
    setTried(false);
    slugEdited.current = false;
  };
  /** Checks the form for Save; true when it may be sent. */
  const validate = () => {
    const problems = check(form);
    setTried(true);
    setLocal(problems);
    return Object.keys(problems).length === 0;
  };
  return { form, setForm, local, set, reset, validate, slugEdited };
}

export function OidcDrawer({ ctx, adapter, open, onClose, onAdded }: { ctx: HostContext; adapter: IdpAdapter; open: boolean; onClose(): void; onAdded(p: ProviderModel): void }) {
  const { form, local, set, reset: resetForm, validate, slugEdited } = useForm<OidcForm>(emptyOidc, oidcErrors);
  const key = useRef(newIdempotencyKey());
  const save = useMutation((body: ReturnType<typeof oidcRequest>) => asApi(adapter.create(body, key.current)));
  const { reset } = save;
  useEffect(() => {
    if (open) {
      resetForm(emptyOidc());
      key.current = newIdempotencyKey();
      reset();
    }
  }, [open]);
  const server = serverFieldErrors<OidcForm>(save.error, OIDC_FIELDS);
  const errors: FormErrors<OidcForm> = { ...server, ...local };
  const err = (k: keyof OidcForm) => errors[k] ?? null;
  const submit = () => {
    if (!validate()) return;
    save.submit(oidcRequest(form)).then((res) => {
      if (res.ok) onAdded(res.data);
    });
  };
  const refused = save.error && !Object.keys(server).length ? save.error : null;
  const redirect = absolute(pathOf(ROUTES.oidcCallback, form.slug.trim()));
  return (
    <Drawer
      open={open}
      title={TEXT.oidcTitle}
      crumb={TEXT.title}
      onClose={onClose}
      footer={<DrawerFoot><Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button><Button variant="primary" busy={save.busy} onClick={submit}>{ctx.li(TEXT.add)}</Button></DrawerFoot>}
    >
      <div className="mx-small" style={{ overflowWrap: 'anywhere' }}>{ctx.fill(TEXT.oidcSub, { redirect })}</div>
      <CommonFields form={form} set={(k, v) => {
        set(k, v);
        if (k === 'slug') slugEdited.current = true;
        if (k === 'displayName' && !slugEdited.current) set('slug', suggestSlug(String(v)));
      }} err={err} />
      <Field label={TEXT.oidcIssuer} hint={TEXT.oidcIssuerHint} error={err('issuer')} required>
        <TextInput type="url" value={form.issuer} onChange={(v) => set('issuer', v)} name="issuer" autoComplete="off" />
      </Field>
      <Field label={TEXT.clientId} error={err('clientId')} required>
        <TextInput value={form.clientId} onChange={(v) => set('clientId', v)} name="clientId" autoComplete="off" maxLength={200} />
      </Field>
      <Field label={TEXT.clientSecret} hint={TEXT.clientSecretHint} error={err('clientSecret')} required>
        <TextInput type="password" value={form.clientSecret} onChange={(v) => set('clientSecret', v)} name="clientSecret" autoComplete="new-password" maxLength={1024} />
      </Field>
      <Field label={TEXT.scopes} hint={TEXT.scopesHint} error={err('scopes')} required>
        <TextInput value={form.scopes} onChange={(v) => set('scopes', v)} name="scopes" autoComplete="off" />
      </Field>
      <Field label={TEXT.subjectMode}>
        <Select value={form.subjectMode} onChange={(v) => set('subjectMode', v as OidcForm['subjectMode'])} name="subjectMode" options={[{ value: 'sub', label: TEXT.subject_sub }, { value: 'entra', label: TEXT.subject_entra }]} />
      </Field>
      {form.subjectMode === 'entra' ? (
        <Field label={TEXT.entraTenant} hint={TEXT.entraTenantHint} error={err('entraTenantId')} required>
          <TextInput value={form.entraTenantId} onChange={(v) => set('entraTenantId', v)} name="entraTenantId" autoComplete="off" />
        </Field>
      ) : null}
      <MfaFields form={form} set={set} err={err} name="oidc" />
      <Section title={TEXT.jitTitle}>
        <Field label={TEXT.jitTitle} hint={TEXT.jitHint}>
          <Checkbox checked={form.jitProvisioning} onChange={(v) => set('jitProvisioning', v)} label={TEXT.jit} name="jitProvisioning" />
        </Field>
        {form.jitProvisioning ? (
          <Field label={TEXT.domains} hint={TEXT.domainsHint} error={err('domains')} required>
            <TextInput value={form.domains} onChange={(v) => set('domains', v)} name="domains" autoComplete="off" />
          </Field>
        ) : null}
      </Section>
      {refused ? <Alert tone="bad">{errorText(ctx, refused)}</Alert> : null}
    </Drawer>
  );
}

export function SamlDrawer({ ctx, adapter, open, onClose, onAdded }: { ctx: HostContext; adapter: IdpAdapter; open: boolean; onClose(): void; onAdded(p: ProviderModel): void }) {
  const { form, setForm, local, set, reset: resetForm, validate, slugEdited } = useForm<SamlForm>(emptySaml, samlErrors);
  const [read, setRead] = useState<{ ok: boolean; text: string } | null>(null);
  const key = useRef(newIdempotencyKey());
  const save = useMutation((body: ReturnType<typeof samlRequest>) => asApi(adapter.create(body, key.current)));
  const { reset } = save;
  useEffect(() => {
    if (open) {
      resetForm(emptySaml());
      setRead(null);
      key.current = newIdempotencyKey();
      reset();
    }
  }, [open]);
  const server = serverFieldErrors<SamlForm>(save.error, SAML_FIELDS);
  const errors: FormErrors<SamlForm> = { ...server, ...local };
  const err = (k: keyof SamlForm) => errors[k] ?? null;
  const defaultSp = (slug: string) => absolute(pathOf(ROUTES.samlMetadata, slug));
  const setSlug = (slug: string) => {
    // The SP entity id follows the short id while it is the default address.
    if (!form.spEntityId || form.spEntityId === defaultSp(form.slug)) set('spEntityId', slug ? defaultSp(slug) : '');
    set('slug', slug);
  };
  const readMetadata = () => {
    const meta = parseSamlMetadata(form.metadataXml);
    if (!meta) {
      setRead({ ok: false, text: ctx.li(TEXT.metadataBad) });
      return;
    }
    const { form: next, filled } = fillFromMetadata(form, meta);
    setForm(next);
    setRead({ ok: true, text: ctx.fill(TEXT.metadataRead, { fields: filled.map((f) => ctx.li(f)).join(', ') }) });
  };
  const submit = () => {
    if (!validate()) return;
    save.submit(samlRequest(form)).then((res) => {
      if (res.ok) onAdded(res.data);
    });
  };
  const refused = save.error && !Object.keys(server).length ? save.error : null;
  return (
    <Drawer
      open={open}
      title={TEXT.samlTitle}
      crumb={TEXT.title}
      onClose={onClose}
      footer={<DrawerFoot><Button onClick={onClose}>{ctx.li(UI_TEXT.cancel)}</Button><Button variant="primary" busy={save.busy} onClick={submit}>{ctx.li(TEXT.add)}</Button></DrawerFoot>}
    >
      <div className="mx-small">{ctx.li(TEXT.samlSub)}</div>
      <CommonFields form={form} set={(k, v) => {
        if (k === 'slug') {
          slugEdited.current = true;
          setSlug(String(v));
          return;
        }
        set(k, v);
        if (k === 'displayName' && !slugEdited.current) setSlug(suggestSlug(String(v)));
      }} err={err} />
      <Field label={TEXT.metadataXml} hint={TEXT.metadataHint}>
        <Textarea value={form.metadataXml} onChange={(v) => { set('metadataXml', v); setRead(null); }} rows={5} mono name="metadataXml" />
      </Field>
      <div className="mx-row">
        <Button onClick={readMetadata} disabled={!form.metadataXml.trim()}>{ctx.li(TEXT.readMetadata)}</Button>
        {read ? <span className={read.ok ? 'mx-small' : 'mx-error'} role={read.ok ? 'status' : 'alert'}>{read.text}</span> : null}
      </div>
      <Field label={TEXT.entryPoint} error={err('entryPoint')} required>
        <TextInput type="url" value={form.entryPoint} onChange={(v) => set('entryPoint', v)} name="entryPoint" autoComplete="off" />
      </Field>
      <Field label={TEXT.idpIssuer} error={err('idpIssuer')} required>
        <TextInput value={form.idpIssuer} onChange={(v) => set('idpIssuer', v)} name="idpIssuer" autoComplete="off" maxLength={500} />
      </Field>
      <Field label={TEXT.idpCerts} hint={TEXT.idpCertsHint} error={err('idpCerts')} required>
        <Textarea value={form.idpCerts} onChange={(v) => set('idpCerts', v)} rows={5} mono name="idpCerts" />
      </Field>
      <Field label={TEXT.spEntityId} hint={TEXT.spEntityIdHint} error={err('spEntityId')} required>
        <TextInput value={form.spEntityId} onChange={(v) => set('spEntityId', v)} name="spEntityId" autoComplete="off" maxLength={500} />
      </Field>
      <Field label={TEXT.authnContexts} hint={TEXT.authnContextsHint} error={err('mfaAuthnContexts')}>
        <Textarea value={form.mfaAuthnContexts} onChange={(v) => set('mfaAuthnContexts', v)} rows={3} mono name="mfaAuthnContexts" />
      </Field>
      <MfaFields form={form} set={set} err={err} name="saml" />
      <Alert tone="info">{ctx.li(TEXT.samlNoJit)}</Alert>
      {refused ? <Alert tone="bad">{errorText(ctx, refused)}</Alert> : null}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Local sign-in
// ---------------------------------------------------------------------------------------------------------------

export function PolicyCard({ ctx, adapter, providers }: { ctx: HostContext; adapter: IdpAdapter; providers: ProviderModel[] }) {
  const [state, setState] = useState<{ loading: boolean; policy: PolicyModel | null; error: ApiError | null }>({ loading: true, policy: null, error: null });
  const [choice, setChoice] = useState<PolicyCode>('allowed');
  const [note, setNote] = useState<TextPair | null>(null);
  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    settled(adapter.policy()).then((res) => {
      if (res.ok) {
        setState({ loading: false, policy: res.data, error: null });
        setChoice(res.data.localLogin);
      } else setState({ loading: false, policy: null, error: res.error });
    });
  }, [adapter]);
  useEffect(() => load(), [load]);
  const save = useMutation((input: { policy: PolicyCode; etag: string | null }) => asApi(adapter.setPolicy(input.policy, input.etag)));
  const submit = () => {
    if (!state.policy) return;
    setNote(null);
    if (choice === state.policy.localLogin) {
      setNote(TEXT.policyNoChange);
      return;
    }
    save.submit({ policy: choice, etag: state.policy.etag }).then((res) => {
      if (res.ok) {
        setState({ loading: false, policy: res.data, error: null });
        setChoice(res.data.localLogin);
        ctx.toast(ctx.li(TEXT.policySaved));
      } else if (res.status === 412) {
        setNote(TEXT.policyStale);
        load();
      }
    });
  };
  const tested = providers.some((p) => p.enabled && lastTest(p.id)?.ok);
  const refused = save.error && save.error.status !== 412 ? save.error : null;
  return (
    <Card title={TEXT.policyTitle} sub={TEXT.policySub}>
      {state.loading && !state.policy ? <div className="mx-small" role="status">{ctx.li(UI_TEXT.loading)}</div> : state.error || !state.policy ? (
        <Alert tone="bad" title={TEXT.policyFailed}>
          <div>{state.error ? errorText(ctx, state.error) : null}</div>
          <div style={{ marginTop: 8 }}><Button onClick={load}>{ctx.li(TEXT.tryAgain)}</Button></div>
        </Alert>
      ) : (
        <div className="mx-stack">
          <Radio legend={TEXT.policyLegend} name="localLogin" value={choice} onChange={(v) => { setChoice(v as PolicyCode); setNote(null); }} options={POLICIES.map((p) => ({ value: p, label: policyLabel(p) }))} />
          {choice !== 'allowed' ? (
            <Alert tone="warn">
              <div>{ctx.li(TEXT.policyWarn)}</div>
              {!tested ? <div style={{ marginTop: 6 }}>{ctx.li(TEXT.policyNoProvider)}</div> : null}
              {choice === 'disabled' ? <div style={{ marginTop: 6 }}>{ctx.li(TEXT.policyDisabledAdmins)}</div> : null}
            </Alert>
          ) : null}
          {note ? <Alert tone="info">{ctx.li(note)}</Alert> : null}
          {refused ? <Alert tone="bad">{errorText(ctx, refused)}</Alert> : null}
          <div className="mx-row"><Button variant="primary" busy={save.busy} onClick={submit}>{ctx.li(TEXT.policySave)}</Button></div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------------------------------------------

type LoadState = { loading: boolean; providers: ProviderModel[] | null; error: ApiError | null };

export default function IdentityProvidersScreen({ ctx }: ScreenProps) {
  const context = useRef(ctx);
  context.current = ctx;
  const { client } = ctx;
  const adapter = useMemo(() => adapterFor(client), [client]);
  const [state, setState] = useState<LoadState>({ loading: true, providers: null, error: null });
  const [adding, setAdding] = useState<'oidc' | 'saml' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tested, setTested] = useState<{ provider: ProviderModel; outcome: TestOutcome } | null>(null);
  const [disabling, setDisabling] = useState<ProviderModel | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [, setTick] = useState(0);
  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }));
    settled(adapter.list()).then((res) => setState(res.ok ? { loading: false, providers: res.data, error: null } : { loading: false, providers: null, error: res.error }));
  }, [adapter]);
  useEffect(() => load(), [load]);
  // The page actions "Add OIDC provider" and "Add SAML provider" open the forms through the screen params (index.tsx).
  const request = ctx.params.add;
  const at = ctx.params.at;
  useEffect(() => {
    if (request === 'oidc' || request === 'saml') setAdding(request);
  }, [request, at]);
  const runTest = (p: ProviderModel) => {
    setBusy(`test:${p.id}`);
    setFailure(null);
    settled(adapter.test(p.id)).then((res) => {
      setBusy(null);
      if (res.ok) {
        rememberTest(p.id, res.data);
        setTested({ provider: p, outcome: res.data });
        setTick((t) => t + 1);
      } else setFailure(res.error);
    });
  };
  const setEnabled = (p: ProviderModel, enabled: boolean) => {
    setBusy(`state:${p.id}`);
    setFailure(null);
    settled(adapter.update(p.id, { enabled })).then((res) => {
      setBusy(null);
      setDisabling(null);
      if (res.ok) {
        context.current.toast(context.current.fill(enabled ? TEXT.enabledDone : TEXT.disabledDone, { name: p.displayName }));
        load();
      } else setFailure(res.error);
    });
  };
  const providers = state.providers ?? [];
  const canPolicy = ctx.orgCan('org.settings.manage');
  let body;
  if (state.loading && !state.providers) body = <div className="mx-small" role="status">{ctx.li(UI_TEXT.loading)}</div>;
  else if (state.error) {
    body = (
      <Alert tone="bad" title={TEXT.loadFailed}>
        <div>{errorText(ctx, state.error)}</div>
        <div style={{ marginTop: 8 }}><Button onClick={load}>{ctx.li(TEXT.tryAgain)}</Button></div>
      </Alert>
    );
  } else {
    body = (
      <Card title={TEXT.providers} sub={TEXT.providersSub} flush>
        {providers.length ? (
          <ProvidersTable ctx={ctx} providers={providers} busy={busy} onTest={runTest} onDisable={setDisabling} onEnable={(p) => setEnabled(p, true)} />
        ) : (
          <EmptyState
            illustration={<Illustration scene="no-documents" size="sm" decorative />}
            title={TEXT.none}
            text={TEXT.noneText}
            action={(
              <>
                <Button variant="primary" onClick={() => setAdding('oidc')}>{ctx.li(TEXT.addOidc)}</Button>
                <Button onClick={() => setAdding('saml')}>{ctx.li(TEXT.addSaml)}</Button>
              </>
            )}
          />
        )}
      </Card>
    );
  }
  const others = disabling ? providers.filter((p) => p.enabled && p.id !== disabling.id).length : 0;
  return (
    <>
      {ctx.mode === 'sample' ? <Alert tone="info">{ctx.li(TEXT.sampleNote)}</Alert> : null}
      {failure ? <Alert tone="bad">{errorText(ctx, failure)}</Alert> : null}
      {body}
      {canPolicy && state.providers ? <PolicyCard ctx={ctx} adapter={adapter} providers={providers} /> : null}
      <OidcDrawer ctx={ctx} adapter={adapter} open={adding === 'oidc'} onClose={() => setAdding(null)} onAdded={(p) => { setAdding(null); ctx.toast(ctx.fill(TEXT.added, { name: p.displayName })); load(); }} />
      <SamlDrawer ctx={ctx} adapter={adapter} open={adding === 'saml'} onClose={() => setAdding(null)} onAdded={(p) => { setAdding(null); ctx.toast(ctx.fill(TEXT.added, { name: p.displayName })); load(); }} />
      <TestResultDialog ctx={ctx} provider={tested?.provider ?? null} outcome={tested?.outcome ?? null} onClose={() => setTested(null)} />
      <ConfirmDialog
        open={Boolean(disabling)}
        title={disabling ? ctx.fill(TEXT.disableTitle, { name: disabling.displayName }) : ''}
        body={(
          <>
            <div>{disabling ? ctx.fill(TEXT.disableBody, { name: disabling.displayName }) : null}</div>
            {disabling && others === 0 ? <div style={{ marginTop: 8 }}>{ctx.li(TEXT.disableLast)}</div> : null}
          </>
        )}
        confirmLabel={TEXT.disable}
        tone="bad"
        busy={Boolean(disabling && busy === `state:${disabling.id}`)}
        onConfirm={() => disabling && setEnabled(disabling, false)}
        onCancel={() => setDisabling(null)}
      />
    </>
  );
}
