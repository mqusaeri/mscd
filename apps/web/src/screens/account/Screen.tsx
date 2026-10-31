// My account (MILESTONE-2 M2-16, `/account`, no sidebar entry; opened from the top bar): profile, "Change password"
// (hidden for accounts that sign in only through a company provider), "Replace authenticator" (the `reenrol` mode of
// the enrolment page in src/auth, which returns to the app), recovery codes left with "Get new recovery codes",
// linked company sign-in identities with "Link", one "Revoke calendar feed" per readable system, and the preferences
// language, theme and density, saved with `PUT /me/preferences` and applied at once. "My data" (M3-04, my-data.tsx)
// downloads a copy of one's own data, corrects the name and job title, and asks the organisation about the data.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiResult } from '../../data/api/ApiClient';
import { useMutation } from '../api';
import type { HostContext, ScreenProps, TextPair } from '../types';
import { Alert, Badge, Button, Card, Facts, Field, Select, Table } from '../ui';
import type { Column } from '../ui';
import { adapterFor } from './adapter';
import { CodesDialog, PasswordDialog } from './dialogs';
import { appRoot, applyDisplay, currentDensity } from './display';
import { MyDataCard } from './my-data';
import {
  DENSITIES, DENSITY_TEXT, LANGUAGES, LANGUAGE_TEXT, THEMES, THEME_TEXT, linkable, methodText, preferencesOf, rememberSaved, savedFor,
} from './model';
import type { AccountAdapter, LinkedIdentity, Preferences, ProfileCorrection, ProviderModel, Result, SecurityModel } from './model';
import { TEXT } from './text';

/** Date of an instant in the interface language, through the controller's date helper when there is one. */
function dayOf(ctx: HostContext, instant: string | null): string {
  if (!instant) return '-';
  const iso = instant.slice(0, 10);
  return ctx.D ? ctx.D.fmt(iso, ctx.lang) : iso;
}

/**
 * Name, email and job title of the session user: API from `Me`; sample from the persona's person, with the email the
 * sample adapter gives (`AccountAdapter.personEmail`, kept in sample.ts so an API build holds no sample data).
 */
export function profileOf(ctx: HostContext, personEmail: string | null = null, corrected: ProfileCorrection | null = null): { name: string; email: string | null; jobTitle: string | null } {
  const base = ctx.me
    ? { name: ctx.me.user.displayName, email: ctx.me.user.email, jobTitle: ctx.me.user.jobTitle }
    : { name: ctx.person.name, email: personEmail, jobTitle: ctx.person.jobTitle && ctx.person.jobTitle !== '-' ? ctx.person.jobTitle : null };
  // A correction saved on this page shows at once; `Me` is read again only at the next start.
  return corrected ? { ...base, name: corrected.displayName, jobTitle: corrected.jobTitle } : base;
}

export function ProfileCard({ ctx, personEmail = null, corrected = null }: { ctx: HostContext; personEmail?: string | null; corrected?: ProfileCorrection | null }) {
  const p = profileOf(ctx, personEmail, corrected);
  const method = methodText(ctx.me?.session.authMethod);
  return (
    <Card title={TEXT.profile} sub={TEXT.profileSub}>
      <Facts
        items={[
          { label: TEXT.name, value: p.name },
          { label: TEXT.email, value: p.email ?? '-', mono: true },
          { label: TEXT.jobTitle, value: p.jobTitle ?? '-' },
          { label: TEXT.organisation, value: ctx.org?.name ?? '-' },
          ...(method ? [{ label: TEXT.signedInWith, value: ctx.li(method) }] : []),
        ]}
      />
    </Card>
  );
}

export function SecurityCard({ ctx, adapter, security, onChanged, personEmail = null }: {
  ctx: HostContext;
  adapter: AccountAdapter;
  security: SecurityModel;
  onChanged(): void;
  personEmail?: string | null;
}) {
  const [dialog, setDialog] = useState<'password' | 'codes' | null>(null);
  const [problem, setProblem] = useState<TextPair | null>(null);
  const replace = () => {
    const res = adapter.replaceAuthenticator();
    if (!res.ok) setProblem([res.error.message[0], res.error.message[1]]);
  };
  const low = security.authenticatorSetUpAt !== null && security.recoveryCodesLeft <= 3;
  return (
    <Card title={TEXT.security} sub={TEXT.securitySub}>
      <Facts
        items={[
          {
            label: TEXT.password,
            value: (
              <span className="mx-row">
                <span>{ctx.li(security.passwordSet ? TEXT.passwordSet : TEXT.passwordNone)}</span>
                {security.ssoOnly ? null : <Button onClick={() => setDialog('password')}>{ctx.li(TEXT.changePassword)}</Button>}
              </span>
            ),
          },
          {
            label: TEXT.authenticator,
            value: (
              <span className="mx-stack" style={{ gap: 6 }}>
                <span className="mx-row">
                  <span>{security.authenticatorSetUpAt ? ctx.fill(TEXT.authenticatorSince, { date: dayOf(ctx, security.authenticatorSetUpAt) }) : ctx.li(TEXT.authenticatorNone)}</span>
                  <Button onClick={replace}>{ctx.li(TEXT.replaceAuthenticator)}</Button>
                </span>
                <span className="mx-small">{ctx.li(TEXT.replaceNote)}</span>
              </span>
            ),
          },
          {
            label: TEXT.recoveryCodes,
            value: (
              <span className="mx-stack" style={{ gap: 6 }}>
                <span className="mx-row">
                  <span>{ctx.fill(TEXT.recoveryLeft, { n: security.recoveryCodesLeft })}</span>
                  {security.authenticatorSetUpAt ? <Button onClick={() => setDialog('codes')}>{ctx.li(TEXT.newCodes)}</Button> : null}
                </span>
                {low ? <span className="mx-small">{ctx.li(TEXT.recoveryLow)}</span> : null}
              </span>
            ),
          },
        ]}
      />
      {problem ? <div style={{ marginTop: 12 }}><Alert tone="info">{ctx.li(problem)}</Alert></div> : null}
      <PasswordDialog ctx={ctx} adapter={adapter} open={dialog === 'password'} onClose={() => setDialog(null)} />
      <CodesDialog
        ctx={ctx}
        adapter={adapter}
        open={dialog === 'codes'}
        email={profileOf(ctx, personEmail).email ?? ''}
        onClose={(changed) => { setDialog(null); if (changed) onChanged(); }}
      />
    </Card>
  );
}

export function IdentitiesCard({ ctx, adapter, security, providers }: { ctx: HostContext; adapter: AccountAdapter; security: SecurityModel; providers: ProviderModel[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<TextPair | null>(null);
  const open = linkable(providers, security);
  const link = (slug: string) => {
    setBusy(slug);
    setProblem(null);
    void ctx.track(adapter.linkIdentity(slug)).then((res) => {
      setBusy(null);
      if (res.ok) return;
      setProblem(res.error.messageKey === 'auth.proof_required' ? TEXT.linkProof : [res.error.message[0], res.error.message[1]]);
    }, () => setBusy(null));
  };
  type Row = { slug: string; label: string; kind: string; linked: LinkedIdentity | null };
  const rows: Row[] = [
    ...security.identities.map((i) => ({ slug: i.provider, label: i.label, kind: i.kind, linked: i })),
    ...open.map((p) => ({ slug: p.slug, label: p.label, kind: p.kind, linked: null })),
  ];
  const columns: Column<Row>[] = [
    { key: 'provider', label: TEXT.colProvider, render: (r) => <span style={{ fontWeight: 600 }}>{r.label}</span> },
    { key: 'kind', label: TEXT.colKind, render: (r) => r.kind.toUpperCase() },
    {
      key: 'state',
      label: TEXT.colState,
      render: (r) => (r.linked
        ? <span className="mx-row"><Badge tone="ok">{ctx.li(TEXT.linked)}</Badge><span className="mx-small">{ctx.fill(TEXT.linkedOn, { date: dayOf(ctx, r.linked.linkedAt) })}</span></span>
        : <Button busy={busy === r.slug} onClick={() => link(r.slug)}>{ctx.li(TEXT.link)}</Button>),
    },
  ];
  return (
    <Card title={TEXT.identities} sub={TEXT.identitiesSub} flush={rows.length > 0}>
      {rows.length ? <Table columns={columns} rows={rows} rowKey={(r) => r.slug} /> : <span className="mx-muted">{ctx.li(TEXT.noProviders)}</span>}
      {problem ? <div style={{ padding: rows.length ? '0 var(--pad) var(--pad)' : '12px 0 0' }}><Alert tone="warn">{ctx.li(problem)}</Alert></div> : null}
    </Card>
  );
}

export function CalendarCard({ ctx, adapter }: { ctx: HostContext; adapter: AccountAdapter }) {
  const [busy, setBusy] = useState<string | null>(null);
  const systems = (ctx.D?.MS ?? []).filter((m) => ctx.can(m.id, 'ms.read'));
  const revoke = (ms: string, name: string) => {
    setBusy(ms);
    void ctx.track(adapter.revokeCalendarFeed(ms)).then((res) => {
      setBusy(null);
      if (res.ok) ctx.toast(res.data ? ctx.li(res.data) : ctx.fill(TEXT.feedRevoked, { system: name }));
      else ctx.toast(ctx.li(res.error.message));
    }, () => setBusy(null));
  };
  return (
    <Card title={TEXT.calendar} sub={TEXT.calendarSub}>
      {systems.length ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {systems.map((m) => (
            <li key={m.id} className="mx-row" style={{ justifyContent: 'space-between' }}>
              <span><span style={{ fontWeight: 600 }}>{m.short}</span> <span className="mx-muted">{m.code}</span></span>
              <Button busy={busy === m.id} onClick={() => revoke(m.id, m.short)}>{ctx.li(TEXT.revokeFeed)}</Button>
            </li>
          ))}
        </ul>
      ) : <span className="mx-muted">{ctx.li(TEXT.noSystems)}</span>}
    </Card>
  );
}

export function PreferencesCard({ ctx, adapter }: { ctx: HostContext; adapter: AccountAdapter }) {
  const user = ctx.me?.user.id ?? ctx.person.handle;
  const initial = useMemo(
    () => savedFor(user) ?? preferencesOf(ctx.me?.preferences, { language: ctx.lang, theme: ctx.theme, density: currentDensity(appRoot(ctx)) }),
    // The form starts from the saved values once; later changes of the display do not reset it.
    [user],
  );
  const [prefs, setPrefs] = useState<Preferences>(initial);
  const run = useCallback((p: Preferences): Promise<ApiResult<null>> => adapter.savePreferences(p).then(asResult), [adapter]);
  const mutation = useMutation<Preferences, null>(run);
  const save = () => {
    const chosen = prefs;
    void ctx.track(mutation.submit(chosen)).then((res) => {
      if (!res.ok) return;
      rememberSaved(user, chosen);
      applyDisplay(appRoot(ctx), chosen, { lang: ctx.lang, theme: ctx.theme });
      ctx.toast(chosen.language === 'id' ? TEXT.preferencesSaved[1] : TEXT.preferencesSaved[0]);
    }, () => undefined);
  };
  const set = <K extends keyof Preferences>(key: K) => (value: string) => setPrefs((p) => ({ ...p, [key]: value as Preferences[K] }));
  return (
    <Card title={TEXT.preferences} sub={TEXT.preferencesSub}>
      <div className="mx-stack" style={{ maxWidth: 420 }}>
        <Field label={TEXT.language}>
          <Select value={prefs.language} onChange={set('language')} options={LANGUAGES.map((l) => ({ value: l, label: LANGUAGE_TEXT[l] }))} />
        </Field>
        <Field label={TEXT.theme}>
          <Select value={prefs.theme} onChange={set('theme')} options={THEMES.map((t) => ({ value: t, label: THEME_TEXT[t] }))} />
        </Field>
        <Field label={TEXT.density}>
          <Select value={prefs.density} onChange={set('density')} options={DENSITIES.map((d) => ({ value: d, label: DENSITY_TEXT[d] }))} />
        </Field>
        {mutation.error ? <Alert tone="bad">{ctx.li(mutation.error.message)}</Alert> : null}
        <div className="mx-btn-group">
          <Button variant="primary" busy={mutation.busy} onClick={save}>{ctx.li(TEXT.savePreferences)}</Button>
        </div>
      </div>
    </Card>
  );
}

function asResult<T>(r: Result<T>): ApiResult<T> {
  return r.ok ? { ok: true, status: 200, data: r.data } : { ok: false, status: r.error.status, error: r.error };
}

/** The account page; the screen and the top bar's drawer (sessions without a system) both render it. */
export function AccountPage({ ctx }: { ctx: HostContext }) {
  const { client } = ctx;
  const adapter = useMemo(() => adapterFor(client), [client]);
  const [security, setSecurity] = useState<Result<SecurityModel> | null>(null);
  const [providers, setProviders] = useState<ProviderModel[]>([]);
  const org = ctx.me?.org?.slug ?? null;
  const load = useCallback(() => {
    setSecurity(null);
    void adapter.security().then(setSecurity);
  }, [adapter]);
  useEffect(() => load(), [load]);
  useEffect(() => {
    let live = true;
    void adapter.providers(org).then((list) => { if (live) setProviders(list); });
    return () => { live = false; };
  }, [adapter, org]);
  // Without `Me` (the sample build) the persona's email comes from the sample adapter.
  const [personEmail, setPersonEmail] = useState<string | null>(null);
  const hasMe = Boolean(ctx.me);
  const personName = ctx.person.name;
  const [corrected, setCorrected] = useState<ProfileCorrection | null>(null);
  useEffect(() => {
    if (hasMe) return undefined;
    let live = true;
    void adapter.personEmail(personName).then((email) => { if (live) setPersonEmail(email); });
    return () => { live = false; };
  }, [adapter, hasMe, personName]);
  let securityBody;
  if (!security) securityBody = <div className="mx-small" role="status">{ctx.li(TEXT.loading)}</div>;
  else if (!security.ok) {
    securityBody = (
      <Alert tone="bad" title={TEXT.loadFailed}>
        <div>{ctx.li(security.error.message)}</div>
        <div style={{ marginTop: 8 }}><Button onClick={load}>{ctx.li(TEXT.tryAgain)}</Button></div>
      </Alert>
    );
  } else {
    securityBody = (
      <>
        <SecurityCard ctx={ctx} adapter={adapter} security={security.data} onChanged={load} personEmail={personEmail} />
        <IdentitiesCard ctx={ctx} adapter={adapter} security={security.data} providers={providers} />
      </>
    );
  }
  return (
    <>
      <ProfileCard ctx={ctx} personEmail={personEmail} corrected={corrected} />
      {securityBody}
      <CalendarCard ctx={ctx} adapter={adapter} />
      <PreferencesCard ctx={ctx} adapter={adapter} />
      <MyDataCard
        ctx={ctx}
        adapter={adapter}
        profile={profileOf(ctx, personEmail, corrected)}
        handle={ctx.me?.user.handle ?? ctx.person.handle}
        onCorrected={setCorrected}
      />
    </>
  );
}

export default function AccountScreen({ ctx }: ScreenProps) {
  return <AccountPage ctx={ctx} />;
}
