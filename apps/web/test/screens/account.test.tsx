// My account (MILESTONE-2 M2-16): routes against the shared table, the API adapter over a fake fetch (a 401 of the
// password change or the identity link stays in the form and never ends the session), the preferences applied at
// once through the controller's own header controls, the page parts in both languages and themes, the top bar entry
// and the sample adapter. My data (MILESTONE-3 M3-04, D.6.6): the copy of one's own data, the correction of name and
// job title, and the requests to the organisation, through both adapters and in both languages and themes.
import { readFileSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { routeById } from '@mscd/shared';
import type { MeSecurity } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import screen from '../../src/screens/account/index';
import { REENROL_PATH, ROUTES, ROUTE_IDS } from '../../src/screens/account/routes';
import { createApiAdapter, fromSecurity } from '../../src/screens/account/api';
import { adapterFor, deferredAdapter } from '../../src/screens/account/adapter';
import { applyDisplay, currentDensity } from '../../src/screens/account/display';
import type { ButtonLike, RootLike } from '../../src/screens/account/display';
import { ASK_TEXT, MY_STATUS_TEXT, MY_TYPE_TEXT, codesFile, linkable, methodText, myDataFileName, passwordErrors, preferencesOf, rememberSaved, resetSaved, savedFor } from '../../src/screens/account/model';
import { AskDialog, CorrectDialog, MyDataCard, MyRequestsTable } from '../../src/screens/account/my-data';
import { createSampleAdapter, resetSampleAccount, sampleEmail } from '../../src/screens/account/sample';
import { CalendarCard, IdentitiesCard, PreferencesCard, ProfileCard, SecurityCard, profileOf } from '../../src/screens/account/Screen';
import { CodesList, PasswordDialog } from '../../src/screens/account/dialogs';
import { AccountEntry, mayOpenScreen } from '../../src/screens/account/Entry';
import { topbarItems } from '../../src/screens/account/actions';
import { TEXT } from '../../src/screens/account/text';
import type { Lang } from '../../src/screens/types';
import { fakeFetch, json, problem } from '../auth/helpers';
import { ctxOf, esc, loadSampleD, render, t, textProblems } from './ctx-m2-16';

const SECURITY: MeSecurity = {
  passwordSet: true, ssoOnly: false, authenticatorSetUpAt: '2026-02-03T04:05:06Z', recoveryCodesLeft: 2,
  identities: [{ provider: 'keycloak', kind: 'oidc', label: 'Sign in with Keycloak', linkedAt: '2026-03-01T02:00:00Z' }],
};
const PROVIDERS = [{ slug: 'keycloak', kind: 'oidc' as const, label: 'Sign in with Keycloak' }, { slug: 'adfs', kind: 'saml' as const, label: 'Sign in with ADFS' }];
const ME = {
  user: { id: '9d1e2f3a-4b5c-4d6e-8f7a-8b9c0d1e2f3a', handle: 'rina', email: 'rina.kusuma@nusantaradigital.co.id', displayName: 'Rina Kusuma', jobTitle: 'ISMS Manager' },
  org: { id: '00000000-0000-4000-8000-00000000a001', slug: 'ndt', name: 'PT Nusantara Digital Teknologi' },
  session: { authMethod: 'local', idleExpiresAt: '2026-10-28T10:00:00Z', absoluteExpiresAt: '2026-10-28T18:00:00Z' },
  preferences: { language: 'id', theme: 'dark', density: 'airy' },
};

function client(routes: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(routes);
  const c = new ApiClient({ fetch: f.fetch });
  c.setCsrfToken('csrf-token-0123456789');
  const ended = vi.fn();
  c.onUnauthenticated(ended);
  return { ...f, client: c, ended };
}

beforeAll(async () => {
  await loadSampleD();
});
beforeEach(() => {
  resetSampleAccount();
  resetSaved();
});

describe('My account routes and definition', () => {
  it('match the shared route table', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    expect(routeById(ROUTE_IDS.calendarRevoke).permission).toBe('ms.read');
    expect(REENROL_PATH).toBe('/login/enrol');
  });

  it('has no sidebar entry, opens for every sample persona and with ms.read in API mode', () => {
    expect(screen).toMatchObject({ id: 'account', path: '/account', nav: false, scope: 'ms', perm: 'ms.read' });
    expect([...screen.roles].sort()).toEqual(['auditor', 'manager', 'owner', 'top']);
    expect(mayOpenScreen(ctxOf())).toBe(true);
    expect(mayOpenScreen(ctxOf({ mode: 'api', ms: { isms: ['ms.read'] } }))).toBe(true);
    // An administrator without a business role: the drawer of the top bar entry.
    expect(mayOpenScreen(ctxOf({ mode: 'api', org: ['user.manage'] }))).toBe(false);
    expect(mayOpenScreen(ctxOf({ mode: 'api', org: ['ops.read'], D: null }))).toBe(false);
  });

  it('every text has both languages, Indonesian that differs, and no em dash or centre dot', () => {
    expect(textProblems(TEXT, ['email', 'colStatus'])).toEqual([]);
  });
});

describe('My account API adapter', () => {
  it('reads the security overview and the providers of the organisation', async () => {
    const f = client({ 'GET /api/v1/me/security': json(SECURITY), 'GET /api/v1/auth/providers': json({ local: true, providers: PROVIDERS.map((p) => ({ ...p, icon: 'generic' })) }) });
    const adapter = createApiAdapter(f.client);
    expect(await adapter.security()).toEqual({ ok: true, data: fromSecurity(SECURITY) });
    expect(await adapter.providers('ndt')).toEqual(PROVIDERS);
    expect(f.calls[1].url).toBe('/api/v1/auth/providers?org=ndt');
    const none = createApiAdapter(client({}).client);
    expect(await none.providers('ndt')).toEqual([]);
  });

  it('a wrong current password stays in the form: 401 auth.password_invalid does not end the session', async () => {
    const f = client({ 'POST /api/v1/auth/password/change': [problem(401, 'unauthenticated', { messageKey: 'auth.password_invalid' }), { status: 204 }] });
    const adapter = createApiAdapter(f.client);
    const wrong = await adapter.changePassword('old', 'a much longer passphrase');
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.messageKey).toBe('auth.password_invalid');
    expect(f.ended).not.toHaveBeenCalled();
    expect(await adapter.changePassword('Mscd-Old-2026!', 'a much longer passphrase')).toEqual({ ok: true, data: null });
    expect(f.calls[1]).toMatchObject({ method: 'POST', body: { currentPassword: 'Mscd-Old-2026!', newPassword: 'a much longer passphrase' } });
    expect(f.calls[1].headers['x-csrf-token']).toBe('csrf-token-0123456789');
  });

  it('new recovery codes: the code in the body, or none to rely on a recent proof', async () => {
    const codes = Array.from({ length: 10 }, (_, i) => `abcd-efg${i % 8}-hj`);
    const f = client({ 'POST /api/v1/me/mfa/recovery-codes': [json({ codes }), problem(422, 'business-rule', { messageKey: 'auth.proof_required', messages: { en: 'Enter your code', id: 'Masukkan kode' } })] });
    const adapter = createApiAdapter(f.client);
    expect(await adapter.recoveryCodes('492039')).toEqual({ ok: true, data: codes });
    const refused = await adapter.recoveryCodes(null);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.message).toEqual(['Enter your code', 'Masukkan kode']);
    expect(f.calls.map((c) => c.body)).toEqual([{ code: '492039' }, {}]);
  });

  it('saves the preferences with PUT /me/preferences', async () => {
    const f = client({ 'PUT /api/v1/me/preferences': { status: 204 } });
    expect(await createApiAdapter(f.client).savePreferences({ language: 'id', theme: 'dark', density: 'dense' })).toEqual({ ok: true, data: null });
    expect(f.calls[0]).toMatchObject({ method: 'PUT', path: '/api/v1/me/preferences', body: { language: 'id', theme: 'dark', density: 'dense' } });
  });

  it('a link starts at the provider; a missing recent proof is kept without ending the session', async () => {
    const f = client({ 'POST /api/v1/me/identities/adfs/link': [json({ redirectUrl: 'https://adfs.example/ls?SAMLRequest=x' }), problem(401, 'unauthenticated', { messageKey: 'auth.proof_required' })] });
    const navigate = vi.fn();
    const adapter = createApiAdapter(f.client, navigate);
    expect(await adapter.linkIdentity('adfs')).toEqual({ ok: true, data: 'https://adfs.example/ls?SAMLRequest=x' });
    expect(navigate).toHaveBeenCalledWith('https://adfs.example/ls?SAMLRequest=x');
    const refused = await adapter.linkIdentity('adfs');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.messageKey).toBe('auth.proof_required');
    expect(f.ended).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('revokes the calendar feed of a system and opens the re-enrolment page', async () => {
    const f = client({ 'POST /api/v1/ms/isms/calendar-feed/revoke': json({ ok: true, changed: [], message: ['Calendar feed revoked', 'Umpan kalender dicabut'] }) });
    const navigate = vi.fn();
    const adapter = createApiAdapter(f.client, navigate);
    expect(await adapter.revokeCalendarFeed('isms')).toEqual({ ok: true, data: ['Calendar feed revoked', 'Umpan kalender dicabut'] });
    expect(adapter.replaceAuthenticator()).toEqual({ ok: true, data: null });
    expect(navigate).toHaveBeenCalledWith('/login/enrol');
  });
});

describe('My account model', () => {
  it('preferences: the saved ones, else what the app shows', () => {
    const current = { language: 'en' as const, theme: 'light' as const, density: 'comfortable' as const };
    expect(preferencesOf({ language: 'id', theme: 'dark', density: 'airy' }, current)).toEqual({ language: 'id', theme: 'dark', density: 'airy' });
    expect(preferencesOf({ lang: 'id', theme: 'blue' }, current)).toEqual({ language: 'id', theme: 'light', density: 'comfortable' });
    expect(preferencesOf(null, current)).toEqual(current);
  });

  it('preferences saved in this page session win over the older Me, per user', () => {
    expect(savedFor('rina')).toBeNull();
    rememberSaved('rina', { language: 'id', theme: 'dark', density: 'dense' });
    expect(savedFor('rina')).toEqual({ language: 'id', theme: 'dark', density: 'dense' });
    expect(savedFor('bagus')).toBeNull();
    const ctx = ctxOf({ mode: 'api', me: { ...ME, preferences: { language: 'en', theme: 'light', density: 'comfortable' } } as never });
    const html = render(<PreferencesCard ctx={ctx} adapter={createSampleAdapter()} />, ctx);
    // ctx.me.user.id is the key in API mode: nothing was saved for that id, so Me's values show.
    expect(html).toContain('<option value="en" selected="">');
    rememberSaved(ME.user.id, { language: 'id', theme: 'dark', density: 'airy' });
    expect(render(<PreferencesCard ctx={ctx} adapter={createSampleAdapter()} />, ctx)).toContain('<option value="id" selected="">');
  });

  it('password checks before sending', () => {
    expect(passwordErrors({ current: '', next: 'short', repeat: '' })).toEqual({ current: TEXT.currentRequired, next: TEXT.tooShort });
    expect(passwordErrors({ current: 'x', next: 'a much longer passphrase', repeat: 'other' })).toEqual({ repeat: TEXT.mismatch });
    expect(passwordErrors({ current: 'x', next: 'a much longer passphrase', repeat: 'a much longer passphrase' })).toEqual({});
  });

  it('sign-in methods, linkable providers and the codes file', () => {
    expect(methodText('local')).toBe(TEXT.methodLocal);
    expect(methodText('saml')).toBe(TEXT.methodSaml);
    expect(methodText('test')).toBe(TEXT.methodOther);
    expect(methodText(null)).toBeNull();
    expect(linkable(PROVIDERS, fromSecurity(SECURITY)).map((p) => p.slug)).toEqual(['adfs']);
    expect(codesFile(['a', 'b'], 'Header')).toBe('Header\n\na\nb\n');
  });
});

/** A fake app root with the header controls the controller renders. */
function fakeRoot(density = 'comfortable') {
  const clicks: string[] = [];
  const attrs: Record<string, string> = { 'data-density': density };
  const button = (text: string, title?: string): ButtonLike & { title?: string } => ({ textContent: text, title, click: () => clicks.push(title ?? text) });
  const buttons = [button('EN'), button('ID'), button('', 'Theme')];
  const header = {
    querySelectorAll: () => buttons,
    querySelector: (selector: string) => (selector.includes('Theme') ? buttons[2] : null),
  };
  const root: RootLike = {
    getAttribute: (name) => attrs[name] ?? null,
    setAttribute: (name, value) => { attrs[name] = value; },
    querySelector: (selector) => (selector === 'header' ? header : null),
  };
  return { root, clicks, attrs };
}

describe('preferences apply at once', () => {
  it('through the theme and language controls of the header and the density of the root', () => {
    const f = fakeRoot();
    applyDisplay(f.root, { language: 'id', theme: 'dark', density: 'dense' }, { lang: 'en', theme: 'light' });
    expect(f.clicks).toEqual(['Theme', 'ID']);
    expect(f.attrs['data-density']).toBe('dense');
    expect(currentDensity(f.root)).toBe('dense');
    const same = fakeRoot('airy');
    applyDisplay(same.root, { language: 'en', theme: 'light', density: 'airy' }, { lang: 'en', theme: 'light' });
    expect(same.clicks).toEqual([]);
    expect(currentDensity(null)).toBe('comfortable');
    expect(() => applyDisplay(null, { language: 'en', theme: 'light', density: 'airy' }, { lang: 'en', theme: 'light' })).not.toThrow();
  });
});

describe('My account page parts', () => {
  for (const lang of ['en', 'id'] as Lang[]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`shows the profile, security, identities, calendar feeds and preferences in ${lang}, ${theme} theme`, () => {
        const ctx = ctxOf({ lang, theme, mode: 'api', me: ME as never, ms: { isms: ['ms.read'], qms: ['ms.read'] } });
        const adapter = createSampleAdapter();
        const security = fromSecurity(SECURITY);
        const html = render(
          <>
            <ProfileCard ctx={ctx} />
            <SecurityCard ctx={ctx} adapter={adapter} security={security} onChanged={() => undefined} />
            <IdentitiesCard ctx={ctx} adapter={adapter} security={security} providers={PROVIDERS} />
            <CalendarCard ctx={ctx} adapter={adapter} />
            <PreferencesCard ctx={ctx} adapter={adapter} />
          </>,
          ctx,
          theme,
        );
        for (const text of [TEXT.changePassword, TEXT.replaceAuthenticator, TEXT.newCodes, TEXT.recoveryLow, TEXT.methodLocal, TEXT.linked, TEXT.link, TEXT.savePreferences]) {
          expect(html, text[0]).toContain(esc(t(text, lang)));
        }
        expect(html).toContain('rina.kusuma@nusantaradigital.co.id');
        expect(html).toContain(esc(ctx.fill(TEXT.recoveryLeft, { n: 2 })));
        expect(html).toContain('Sign in with ADFS');
        // One revoke button per system the user reads (ISMS and QMS here).
        expect(html.split(esc(t(TEXT.revokeFeed, lang))).length - 1).toBe(2);
        // The saved preferences are selected.
        expect(html).toContain('<option value="id" selected="">');
        expect(html).toContain('<option value="dark" selected="">');
        expect(html).toContain('<option value="airy" selected="">');
        expect(html).not.toMatch(/[—·]/);
      });
    }
  }

  it('hides Change password for an account that signs in only through a company provider', () => {
    const ctx = ctxOf({ mode: 'api', me: ME as never });
    const html = render(<SecurityCard ctx={ctx} adapter={createSampleAdapter()} security={{ ...fromSecurity(SECURITY), passwordSet: false, ssoOnly: true }} onChanged={() => undefined} />, ctx);
    expect(html).not.toContain(esc(t(TEXT.changePassword)));
    expect(html).toContain(esc(t(TEXT.passwordNone)));
  });

  it('without providers and identities the company sign-in card says so; without systems no feed', () => {
    const ctx = ctxOf({ mode: 'api', me: ME as never });
    expect(render(<IdentitiesCard ctx={ctx} adapter={createSampleAdapter()} security={{ ...fromSecurity(SECURITY), identities: [] }} providers={[]} />, ctx)).toContain(esc(t(TEXT.noProviders)));
    expect(render(<CalendarCard ctx={ctx} adapter={createSampleAdapter()} />, ctx)).toContain(esc(t(TEXT.noSystems)));
  });

  it('the new codes show once with Copy, Download and Done after the confirmation', () => {
    const ctx = ctxOf();
    const codes = Array.from({ length: 10 }, (_, i) => `abcd-efg${i % 8}-h${i}`);
    const html = render(<CodesList ctx={ctx} codes={codes} email="rina@x.id" onDone={() => undefined} />, ctx);
    for (const code of codes) expect(html).toContain(code);
    expect(html).toContain(esc(t(TEXT.copyCodes)));
    expect(html).toContain(esc(t(TEXT.downloadCodes)));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Done<\/button>/);
  });

  it('the password dialog renders its three fields when open', () => {
    const ctx = ctxOf();
    const html = render(<PasswordDialog ctx={ctx} adapter={createSampleAdapter()} open onClose={() => undefined} />, ctx);
    expect(html).toContain('role="dialog"');
    expect(html.match(/type="password"/g)).toHaveLength(3);
  });

  it('profile of a sample persona: the email comes from the sample adapter, which only the sample build loads', async () => {
    expect(profileOf(ctxOf())).toEqual({ name: 'Rina Kusuma', email: null, jobTitle: 'ISMS Manager' });
    const email = await createSampleAdapter().personEmail('Rina Kusuma');
    expect(email).toBe('rina.kusuma@nusantaradigital.co.id');
    expect(sampleEmail('Bagus Pratama')).toBe('bagus.pratama@nusantaradigital.co.id');
    expect(profileOf(ctxOf(), email)).toEqual({ name: 'Rina Kusuma', email: 'rina.kusuma@nusantaradigital.co.id', jobTitle: 'ISMS Manager' });
    const ctx = ctxOf();
    expect(render(<ProfileCard ctx={ctx} personEmail={email} />, ctx)).toContain('rina.kusuma@nusantaradigital.co.id');
    // An API session takes the email of Me; the API adapter has no persona email.
    expect(profileOf(ctxOf({ mode: 'api', me: ME as never }), 'other@example.id').email).toBe('rina.kusuma@nusantaradigital.co.id');
    expect(await createApiAdapter(null).personEmail('Rina Kusuma')).toBeNull();
    expect(await deferredAdapter(() => Promise.reject(new Error('chunk'))).personEmail('Rina Kusuma')).toBeNull();
    // The sample domain lives in sample.ts only, which an API build never loads (R-13).
    for (const file of ['Screen.tsx', 'api.ts', 'adapter.ts', 'model.ts', 'dialogs.tsx', 'Entry.tsx']) {
      expect(readFileSync(new URL(`../../src/screens/account/${file}`, import.meta.url), 'utf8'), file).not.toContain('nusantaradigital');
    }
  });
});

describe('My account entry of the top bar', () => {
  it('shows for sample personas and signed-in sessions, with its label in both languages', () => {
    const item = topbarItems![0];
    expect(item.visible!(ctxOf())).toBe(true);
    expect(item.visible!(ctxOf({ mode: 'api', me: ME as never }))).toBe(true);
    expect(item.visible!(ctxOf({ mode: 'api', me: null }))).toBe(false);
    for (const lang of ['en', 'id'] as Lang[]) {
      const ctx = ctxOf({ lang });
      expect(render(<AccountEntry ctx={ctx} />, ctx)).toContain(`title="${t(TEXT.entry, lang)}"`);
    }
  });
});

describe('My account sample adapter', () => {
  it('follows the server checks and keeps the changes of the session', async () => {
    const adapter = createSampleAdapter();
    expect((await adapter.changePassword('anything', 'short')).ok).toBe(false);
    expect(await adapter.changePassword('anything', 'a much longer passphrase')).toEqual({ ok: true, data: null });
    const wrong = await adapter.changePassword('not the new one', 'another long passphrase');
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.messageKey).toBe('auth.password_invalid');
    expect((await adapter.recoveryCodes(null)).ok).toBe(false);
    const codes = await adapter.recoveryCodes('123456');
    expect(codes.ok && codes.data).toHaveLength(10);
    if (codes.ok) for (const c of codes.data) expect(c).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{2}$/);
    const security = await adapter.security();
    expect(security.ok && security.data.recoveryCodesLeft).toBe(10);
    expect(adapter.replaceAuthenticator().ok).toBe(false);
    expect((await adapter.linkIdentity('entra')).ok).toBe(false);
  });

  it('the build chooses the sample adapter outside the api build', async () => {
    const adapter = adapterFor(null);
    expect((await adapter.security()).ok).toBe(true);
    expect(await adapter.providers(null)).toEqual([{ slug: 'entra', kind: 'oidc', label: 'Sign in with Microsoft' }]);
  });
});

describe('My data (M3-04)', () => {
  const REQUEST = { id: '6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e', requestNo: 'PR-2026-004', type: 'rectification', status: 'received', receivedAt: '2026-10-30T09:00:00Z', dueAt: '2026-11-02T09:00:00Z', closedAt: null } as const;
  const TASK = '8e9f0a1b-2c3d-4e4f-9a5b-6c7d8e9f0a1b';

  it('the routes need an active session only', () => {
    for (const name of ['myRequests', 'askOrganisation', 'myDataExport', 'profile'] as const) {
      const route = routeById(ROUTE_IDS[name]);
      expect(route.permission, name).toBeUndefined();
      expect(route.auth, name).toBe('session');
    }
    expect(routeById(ROUTE_IDS.askOrganisation).idempotent).toBe(true);
    expect(myDataFileName('Bagus Prasetyo', '2026-10-31')).toBe('personal-data-bagus-prasetyo-2026-10-31.json');
  });

  it('API adapter: the requests, a new request with an Idempotency-Key, the export and its state, the profile correction', async () => {
    const twice = problem(409, 'conflict', { messageKey: 'privacy.open_request', messages: { en: 'You already have an open request of this type.', id: 'Anda sudah memiliki permintaan terbuka dengan jenis ini.' } });
    const { client: c, calls, ended } = client({
      'GET /api/v1/me/privacy-requests': json([REQUEST]),
      'POST /api/v1/me/privacy-requests': [json({ ok: true, changed: [], data: { id: REQUEST.id, requestNo: 'PR-2026-004' } }, 201), twice],
      'POST /api/v1/me/data-export': json({ ok: true, changed: [], taskId: TASK }, 202),
      [`GET /api/v1/exports/${TASK}`]: [json({ id: TASK, kind: 'export', status: 'queued', progress: 0 }), json({ id: TASK, kind: 'export', status: 'succeeded', progress: 100, downloadUrl: `/api/v1/exports/${TASK}/download` })],
      'PATCH /api/v1/me/profile': { status: 204 },
    });
    const adapter = createApiAdapter(c, vi.fn());
    expect(await adapter.myRequests()).toEqual({ ok: true, data: [REQUEST] });
    expect(await adapter.askOrganisation('rectification', 'My surname is Prasetyo')).toEqual({ ok: true, data: { requestNo: 'PR-2026-004' } });
    const post = calls.find((x) => x.path === '/api/v1/me/privacy-requests' && x.method === 'POST')!;
    expect(post.body).toEqual({ type: 'rectification', note: 'My surname is Prasetyo' });
    expect(post.headers['idempotency-key']).toBeTruthy();
    expect(await adapter.askOrganisation('rectification', null)).toMatchObject({ ok: false, error: { status: 409, messageKey: 'privacy.open_request' } });
    expect(calls.at(-1)!.body).toEqual({ type: 'rectification' });
    expect(await adapter.requestMyData({ name: 'Rina Kusuma', email: null, jobTitle: null })).toEqual({ ok: true, data: { taskId: TASK } });
    expect(await adapter.myDataState(TASK)).toEqual({ ok: true, data: { status: 'queued', downloadUrl: null } });
    expect(await adapter.myDataState(TASK)).toEqual({ ok: true, data: { status: 'succeeded', downloadUrl: `/api/v1/exports/${TASK}/download` } });
    expect(await adapter.correctProfile({ displayName: 'Rina Kusuma', jobTitle: null })).toEqual({ ok: true, data: null });
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', body: { displayName: 'Rina Kusuma', jobTitle: null } });
    expect(ended).not.toHaveBeenCalled();
  });

  it('sample adapter: one open request per type, a copy made in the browser, a name is needed', async () => {
    const adapter = createSampleAdapter();
    expect(await adapter.myRequests()).toEqual({ ok: true, data: [] });
    const sent = await adapter.askOrganisation('erasure', null);
    expect(sent.ok && sent.data.requestNo).toMatch(/^PR-\d{4}-041$/);
    expect(await adapter.askOrganisation('erasure', null)).toMatchObject({ ok: false, error: { status: 409, messageKey: 'privacy.open_request' } });
    expect(await adapter.askOrganisation('restriction', 'Stop the newsletter')).toMatchObject({ ok: true });
    const mine = await adapter.myRequests();
    expect(mine.ok && mine.data.map((r) => [r.type, r.status])).toEqual([['restriction', 'received'], ['erasure', 'received']]);
    const copy = await adapter.requestMyData({ name: 'Rina Kusuma', email: 'rina.kusuma@nusantaradigital.co.id', jobTitle: 'ISMS Manager' });
    if (!copy.ok || !('file' in copy.data)) throw new Error('no file');
    expect(copy.data.file.fileName).toMatch(/^personal-data-rina\.kusuma-\d{4}-\d{2}-\d{2}\.json$/);
    expect(JSON.parse(copy.data.file.text)).toMatchObject({ format: 'mscd-personal-data-v1', account: { displayName: 'Rina Kusuma', jobTitle: 'ISMS Manager' } });
    expect(await adapter.myDataState('x')).toEqual({ ok: true, data: { status: 'succeeded', downloadUrl: null } });
    expect(await adapter.correctProfile({ displayName: ' ', jobTitle: null })).toMatchObject({ ok: false, error: { status: 400 } });
    expect(await adapter.correctProfile({ displayName: 'Rina K.', jobTitle: null })).toEqual({ ok: true, data: null });
    resetSampleAccount();
    expect(await adapter.myRequests()).toEqual({ ok: true, data: [] });
    const deferred = deferredAdapter(async () => createSampleAdapter());
    expect(await deferred.myRequests()).toEqual({ ok: true, data: [] });
    const broken = deferredAdapter(() => Promise.reject(new Error('chunk')));
    expect(await broken.myRequests()).toMatchObject({ ok: false, error: { status: 0 } });
  });

  it('a correction saved on the page shows at once in the profile', () => {
    const ctx = ctxOf({ me: ME as never });
    expect(profileOf(ctx, null, { displayName: 'Rina K. Kusuma', jobTitle: null })).toEqual({ name: 'Rina K. Kusuma', email: ME.user.email, jobTitle: null });
    expect(render(<ProfileCard ctx={ctx} corrected={{ displayName: 'Rina K. Kusuma', jobTitle: 'Lead' }} />, ctx)).toContain('Rina K. Kusuma');
  });

  for (const lang of ['en', 'id'] as Lang[]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`the My data card, its forms and the requests in ${lang}, ${theme} theme`, () => {
        const ctx = ctxOf({ lang, theme });
        const adapter = createSampleAdapter();
        const tr = (p: readonly [string, string]) => esc(t(p, lang));
        const profile = { name: 'Rina Kusuma', email: 'rina.kusuma@nusantaradigital.co.id', jobTitle: 'ISMS Manager' };
        const card = render(<MyDataCard ctx={ctx} adapter={adapter} profile={profile} handle="rina" onCorrected={() => undefined} />, ctx, theme);
        for (const p of [TEXT.myData, TEXT.myDataSub, TEXT.downloadData, TEXT.downloadDataNote, TEXT.correctProfile, TEXT.askOrganisation, TEXT.myRequests]) expect(card, p[0]).toContain(tr(p));
        expect(card).toContain('data-section="my-data"');
        const correct = render(<CorrectDialog ctx={ctx} adapter={adapter} open profile={profile} onClose={() => undefined} onSaved={() => undefined} />, ctx, theme);
        for (const p of [TEXT.correctTitle, TEXT.correctSub, TEXT.name, TEXT.jobTitle, TEXT.correctSave]) expect(correct, p[0]).toContain(tr(p));
        expect(correct).toContain('value="Rina Kusuma"');
        const ask = render(<AskDialog ctx={ctx} adapter={adapter} open onClose={() => undefined} onSent={() => undefined} />, ctx, theme);
        for (const p of [TEXT.askTitle, TEXT.askSub, TEXT.askType, ASK_TEXT.rectification, ASK_TEXT.restriction, ASK_TEXT.erasure, TEXT.askNote, TEXT.askSend]) expect(ask, p[0]).toContain(tr(p));
        const rows = [REQUEST, { ...REQUEST, id: 'b', requestNo: 'PR-2026-002', type: 'access' as const, status: 'completed' as const, closedAt: '2026-10-31T02:00:00Z' }];
        const table = render(<MyRequestsTable ctx={ctx} rows={rows} />, ctx, theme);
        for (const p of [TEXT.colRequest, TEXT.colType, TEXT.colStatus, TEXT.colReceived, TEXT.colDue, MY_TYPE_TEXT.rectification, MY_TYPE_TEXT.access, MY_STATUS_TEXT.received, MY_STATUS_TEXT.completed]) expect(table, p[0]).toContain(tr(p));
        expect(table).toContain('PR-2026-004');
        expect(card + correct + ask + table).not.toMatch(/[—·]/);
      });
    }
  }
});
