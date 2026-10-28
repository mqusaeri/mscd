// Sign-in page `/login` (BUILD-PLAN H.6), ported from project/MSCD Login.dc.html: identity provider buttons from
// `GET /auth/providers`, the "or with email" divider when both kinds exist, email and password, "Keep me signed in",
// Continue, the second-factor note, the auditor guest note and the "Forgot?" link. Errors of `/login?error=<code>` and
// of the api appear in a red note above the form; an organisation switch that needs a new sign-in (D-26) lists the
// accepted methods.
//
// Organisation discovery (Milestone 2 M2-S11, D-S3: one host for every organisation):
// - "Work email" and the password show together from the start, so filling both and pressing Continue signs in at
//   once, as in Milestone 1. While the person types, the domain of the email is looked up (debounced, once per
//   domain); a domain verified for an organisation adds that organisation's sign-in buttons.
// - The organisation is preselected by `?org=<slug>`, else by the organisation of the last sign-in in this browser
//   (`localStorage`, guarded; "Use a different organisation" forgets it). An email whose domain names an organisation
//   with sign-in buttons takes over from the preselection. "Use a different organisation" also shows when the
//   organisation of `?org=` hides the password, so a person of another organisation without single sign-on can still
//   sign in with a password; it drops the preselection of this page and leaves the remembered organisation alone.
// - The password field is hidden only when the organisation found disables local sign-in and offers single sign-on.
// - The footer links to the privacy notice and the terms of `system.profile.legal`, each hidden when not set.
import React, { useEffect, useRef, useState } from 'react';
import type { AuthProviders } from '@mscd/shared';
import { looksLikeEmail } from './api';
import { continueSignIn, useMountedRef } from './context';
import type { AuthEnv } from './context';
import { TEXT, errorMessage, fill, li, loginErrorMessage, methodsText } from './i18n';
import { AUTH_PATHS, readLastOrg, ssoStartUrl, storeLastOrg, validSlug } from './routes';
import type { PendingReauth } from './routes';
import {
  Alert, AuthLayout, Divider, EmailField, LegalLinks, NoticeView, PageHead, PasswordField, ProviderButtons, SecondFactorNote, SubmitButton,
} from './ui';
import type { Notice, ProviderChoice } from './ui';

export interface LoginPageProps {
  env: AuthEnv;
  /** Message on arrival: session ended, signed out, password changed, or the `?error=` code. */
  notice?: Notice | null;
  /** `?error=<code>` of an identity provider callback (F.8 step 6). */
  errorCode?: string | null;
  /** `?org=<slug>`: the organisation whose providers to offer in multi-tenant mode (D.2). */
  org?: string | null;
  /** An organisation switch asked for a new sign-in with these methods (D-26). */
  reauth?: PendingReauth | null;
  onCancelReauth?: () => void;
  /** Debounce of the provider lookup by email, in milliseconds. */
  lookupDelay?: number;
}

/** Domain of an email address in lower case, or ''. */
export function emailDomain(email: string): string {
  const at = email.trim().lastIndexOf('@');
  return at < 0 ? '' : email.trim().slice(at + 1).toLowerCase();
}

/** The organisation the page starts with: `?org=` of the address, else the one of the last sign-in. */
export interface Preselection {
  slug: string;
  /** True when it comes from the last sign-in in this browser (the page offers to forget it). */
  remembered: boolean;
}

/** The preselection of a page: a valid `?org=` slug wins over the remembered one; null without either. */
export function preselectionOf(org: string | null | undefined, remembered: string | null): Preselection | null {
  const fromUrl = validSlug(org);
  if (fromUrl) return { slug: fromUrl, remembered: false };
  return remembered ? { slug: remembered, remembered: true } : null;
}

/**
 * The sign-in methods to offer: the answer for the email's domain when it names sign-in buttons (a verified domain of an
 * organisation with single sign-on), else the answer for the preselected organisation (or for none), else whatever is
 * known. Null until an answer arrived.
 */
export function offeredMethods(base: AuthProviders | null, byDomain: AuthProviders | null | undefined): AuthProviders | null {
  if (byDomain && byDomain.providers.length > 0) return byDomain;
  return base ?? byDomain ?? null;
}

/** True when the password field is hidden: the organisation found disables local sign-in and offers single sign-on. */
export function passwordHidden(found: AuthProviders | null): boolean {
  return found !== null && !found.local && found.providers.length > 0;
}

/**
 * True when the page offers "Use a different organisation": always for a remembered organisation, and for one named by
 * `?org=` while its answer hides the password (an email of another organisation without sign-in buttons keeps that
 * answer, so the person could not reach the password field otherwise).
 */
export function offersOtherOrganisation(preselected: Preselection | null, found: AuthProviders | null, base: AuthProviders | null): boolean {
  if (!preselected) return false;
  return preselected.remembered || (found !== null && found === base && passwordHidden(found));
}

export function LoginPage({ env, notice = null, errorCode = null, org = null, reauth = null, onCancelReauth, lookupDelay = 450 }: LoginPageProps) {
  const { api, lang } = env;
  const memory = env.memory ?? null;
  const mounted = useMountedRef();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Notice | null>(errorCode ? { kind: 'error', text: loginErrorMessage(errorCode) } : null);
  const [invalid, setInvalid] = useState<{ email?: boolean; password?: boolean }>({});
  const [preselected, setPreselected] = useState<Preselection | null>(() => preselectionOf(org, readLastOrg(memory)));
  // The answer for the preselected organisation (or for none), and the answers of the email lookups by domain.
  const [base, setBase] = useState<AuthProviders | null>(null);
  const [byDomain, setByDomain] = useState<Readonly<Record<string, AuthProviders>>>({});
  // Providers named by an `auth.sso_required` answer (F.4): the ones to use instead of the password.
  const [ssoMethods, setSsoMethods] = useState<ProviderChoice[] | null>(null);
  const asked = useRef(new Set<string>());
  const emailNow = useRef(email);
  emailNow.current = email;

  // Providers of the preselected organisation, or of the installation when none is preselected.
  const preselectedSlug = preselected?.slug ?? null;
  useEffect(() => {
    if (reauth) return undefined;
    let live = true;
    setBase(null);
    void api.providers(preselectedSlug ? { org: preselectedSlug } : {}).then((r) => {
      if (live && r.ok) setBase(r.data);
    });
    return () => {
      live = false;
    };
  }, [api, preselectedSlug, reauth]);

  // The providers follow the domain of the email (D.2): one lookup per domain, after a pause in typing.
  const domain = looksLikeEmail(email) ? emailDomain(email) : '';
  useEffect(() => {
    if (reauth || !domain || asked.current.has(domain)) return undefined;
    const timer = setTimeout(() => {
      asked.current.add(domain);
      void api.providers({ email: emailNow.current.trim() }).then((r) => {
        if (!mounted.current) return;
        if (r.ok) setByDomain((known) => ({ ...known, [domain]: r.data }));
        else asked.current.delete(domain);
      });
    }, lookupDelay);
    return () => clearTimeout(timer);
  }, [api, domain, reauth, lookupDelay, mounted]);

  const found = reauth ? null : offeredMethods(base, domain ? byDomain[domain] : undefined);
  const providers: ProviderChoice[] = reauth ? reauth.methods.providers : ssoMethods ?? found?.providers ?? [];
  // Only a switch that names the accepted methods hides the whole form when local sign-in is not one of them.
  const showForm = reauth ? reauth.methods.local || providers.length === 0 : true;
  const hidePassword = !reauth && ssoMethods === null && passwordHidden(found);

  function changeEmail(value: string) {
    setEmail(value);
    if (ssoMethods) setSsoMethods(null);
  }

  function forgetOrganisation() {
    // The organisation of a link (`?org=`) is never remembered, so only a remembered one is forgotten.
    if (preselected?.remembered) storeLastOrg(memory, null);
    setPreselected(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || hidePassword) return;
    const bad = { email: !looksLikeEmail(email), password: password.length === 0 };
    setInvalid(bad);
    if (bad.email || bad.password) {
      setProblem({ kind: 'error', text: bad.email ? TEXT.enterEmail : TEXT.enterPassword });
      return;
    }
    setBusy(true);
    setProblem(null);
    const result = await api.login(email, password, remember);
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) {
      continueSignIn(env, result.data);
      return;
    }
    const error = result.error;
    if (error.messageKey === 'auth.sso_required' && error.methods) {
      setSsoMethods(error.methods.providers);
    } else {
      setPassword('');
    }
    setProblem({ kind: 'error', text: errorMessage(error) });
  }

  const hrefOf = (p: ProviderChoice) => ssoStartUrl(p, { returnTo: env.returnTo });
  const demo = Boolean(env.profile?.demo.enabled);

  return (
    <AuthLayout lang={lang} theme={env.theme} facts={env.facts}>
      <PageHead eyebrow={li(TEXT.signInEyebrow, lang)} title={li(TEXT.signInTitle, lang)} lead={li(TEXT.signInLead, lang)} />
      {reauth ? <Alert kind="info">{li(fill(TEXT.reauthLead, { methods: methodsText(reauth.methods, lang) }), lang)}</Alert> : null}
      {problem ? <NoticeView notice={problem} lang={lang} /> : <NoticeView notice={notice} lang={lang} />}
      <ProviderButtons providers={providers} hrefOf={hrefOf} />
      {hidePassword ? <Alert kind="info">{li(TEXT.ssoOnly, lang)}</Alert> : null}
      {providers.length > 0 && showForm ? <Divider text={li(TEXT.orWithEmail, lang)} /> : null}
      {showForm ? (
        <form className="au-form" onSubmit={submit} noValidate>
          <EmailField id="au-email" lang={lang} value={email} onChange={changeEmail} invalid={invalid.email} autoFocus demo={demo} />
          {hidePassword ? null : (
            <>
              <PasswordField
                id="au-password" label={li(TEXT.password, lang)} value={password} onChange={setPassword} autoComplete="current-password"
                invalid={invalid.password} placeholder={li(TEXT.passwordPlaceholder, lang)}
                extra={<a href={AUTH_PATHS.forgot} onClick={(e) => { e.preventDefault(); env.navigate('forgot'); }}>{li(TEXT.forgot, lang)}</a>}
              />
              <label className="au-check">
                <input type="checkbox" name="remember" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                {li(TEXT.remember, lang)}
              </label>
              <SubmitButton busy={busy} label={li(TEXT.continue, lang)} busyLabel={li(TEXT.working, lang)} />
            </>
          )}
        </form>
      ) : (
        <p className="au-lead">{li(TEXT.ssoOnly, lang)}</p>
      )}
      {!reauth && offersOtherOrganisation(preselected, found, base) ? (
        <div className="au-org-switch">
          <button type="button" className="au-link-btn" onClick={forgetOrganisation}>{li(TEXT.otherOrganisation, lang)}</button>
        </div>
      ) : null}
      <SecondFactorNote lang={lang} />
      <div className="au-foot">
        <span>
          {li(TEXT.guestQuestion, lang)}{' '}
          <a href={AUTH_PATHS.guest} onClick={(e) => { e.preventDefault(); env.navigate('guest'); }}>{li(TEXT.guestLink, lang)}</a>
        </span>
        {reauth && onCancelReauth ? (
          <button type="button" className="au-link-btn" onClick={onCancelReauth}>{li(TEXT.reauthCancel, lang)}</button>
        ) : null}
      </div>
      <LegalLinks legal={env.profile?.legal} lang={lang} />
    </AuthLayout>
  );
}
