// Organisation discovery on the sign-in page (MILESTONE-2 M2-S11): the preselected organisation (`?org=` or the last
// sign-in kept in localStorage), the methods offered from the answers by organisation and by email domain, the
// password hidden only for an organisation that signs in with single sign-on only, the generic email placeholder
// (the demo address on demo installations), and the footer links to the privacy notice and the terms.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AuthProviders } from '@mscd/shared';
import { DEMO_EMAIL_PLACEHOLDER, TEXT, emailPlaceholder, li } from '../../src/auth/i18n';
import { LoginPage, offeredMethods, offersOtherOrganisation, passwordHidden, preselectionOf } from '../../src/auth/LoginPage';
import type { LoginPageProps } from '../../src/auth/LoginPage';
import { ORG_SLUG, localStore, readLastOrg, storeLastOrg, validSlug } from '../../src/auth/routes';
import type { StorageLike } from '../../src/auth/routes';
import { LegalLinks } from '../../src/auth/ui';
import { PROFILE, fakeEnv, makeApi, memoryStore } from './helpers';

const FORBIDDEN = /[—·]/;
const SSO: AuthProviders = { local: true, providers: [{ slug: 'entra', kind: 'oidc', label: 'Sign in with Microsoft', icon: 'microsoft' }] };
const SSO_ONLY: AuthProviders = { local: false, providers: SSO.providers };
const NONE: AuthProviders = { local: true, providers: [] };

function textOf(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');
}

function login(props: Partial<LoginPageProps> & { lang?: 'en' | 'id'; memory?: StorageLike | null; profile?: typeof PROFILE & { legal?: unknown } } = {}): string {
  const { api } = makeApi({});
  const { lang = 'en', memory = null, profile = PROFILE, ...rest } = props;
  const { env } = fakeEnv(api, { lang, memory, profile: profile as never });
  return renderToStaticMarkup(createElement(LoginPage, { env, ...rest }));
}

describe('the organisation the sign-in page starts with', () => {
  it('takes a valid ?org= first, then the organisation of the last sign-in, else none', () => {
    expect(preselectionOf('ndt', 'bsd')).toEqual({ slug: 'ndt', remembered: false });
    expect(preselectionOf(null, 'bsd')).toEqual({ slug: 'bsd', remembered: true });
    // A slug the server would refuse is ignored, so it neither preselects nor hides the remembered one.
    expect(preselectionOf('NDT', 'bsd')).toEqual({ slug: 'bsd', remembered: true });
    expect(preselectionOf('<script>', null)).toBeNull();
    expect(preselectionOf(undefined, null)).toBeNull();
  });

  it('remembers the last organisation in a storage that may be missing, blocked or full', () => {
    const store = memoryStore();
    expect(readLastOrg(store)).toBeNull();
    storeLastOrg(store, 'ndt');
    expect(store.data.get('mscd.auth.lastOrg')).toBe('ndt');
    expect(readLastOrg(store)).toBe('ndt');
    // Only slugs: anything else is neither stored nor read back.
    storeLastOrg(store, 'Not A Slug');
    expect(readLastOrg(store)).toBe('ndt');
    store.data.set('mscd.auth.lastOrg', 'javascript:alert(1)');
    expect(readLastOrg(store)).toBeNull();
    storeLastOrg(store, 'bsd');
    storeLastOrg(store, null);
    expect(store.data.has('mscd.auth.lastOrg')).toBe(false);

    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    };
    expect(() => storeLastOrg(throwing, 'ndt')).not.toThrow();
    expect(() => storeLastOrg(throwing, null)).not.toThrow();
    expect(readLastOrg(throwing)).toBeNull();
    expect(readLastOrg(null)).toBeNull();
    // The test runtime has no localStorage: the guarded accessor answers null instead of throwing.
    expect(() => localStore()).not.toThrow();
    expect(validSlug('rmn')).toBe('rmn');
    expect(validSlug('r')).toBeNull();
    expect(ORG_SLUG.test('a_b9')).toBe(true);
  });
});

describe('the sign-in methods offered', () => {
  it('uses the email domain when it names sign-in buttons, else the preselected organisation, else what is known', () => {
    expect(offeredMethods(NONE, SSO)).toBe(SSO);
    expect(offeredMethods(SSO, NONE)).toBe(SSO);
    expect(offeredMethods(SSO, undefined)).toBe(SSO);
    expect(offeredMethods(null, NONE)).toBe(NONE);
    expect(offeredMethods(null, undefined)).toBeNull();
    // A domain without sign-in buttons never hides the buttons of the preselected organisation.
    expect(offeredMethods(SSO_ONLY, NONE)).toBe(SSO_ONLY);
  });

  it('hides the password only when the organisation found disables local sign-in and offers single sign-on', () => {
    expect(passwordHidden(SSO_ONLY)).toBe(true);
    expect(passwordHidden(SSO)).toBe(false);
    expect(passwordHidden(NONE)).toBe(false);
    expect(passwordHidden({ local: false, providers: [] })).toBe(false);
    expect(passwordHidden(null)).toBe(false);
  });

  it('offers another organisation for a remembered one, and for a linked one only while its answer hides the password', () => {
    const remembered = { slug: 'ndt', remembered: true };
    const linked = { slug: 'onlysso', remembered: false };
    expect(offersOtherOrganisation(remembered, SSO, SSO)).toBe(true);
    expect(offersOtherOrganisation(remembered, null, null)).toBe(true);
    // A link (`?org=`) of an organisation that allows single sign-on only, also after an email without sign-in buttons.
    expect(offersOtherOrganisation(linked, SSO_ONLY, SSO_ONLY)).toBe(true);
    expect(offersOtherOrganisation(linked, offeredMethods(SSO_ONLY, NONE), SSO_ONLY)).toBe(true);
    // The password shows, or an email of another organisation took over: nothing to offer.
    expect(offersOtherOrganisation(linked, SSO, SSO)).toBe(false);
    expect(offersOtherOrganisation(linked, NONE, NONE)).toBe(false);
    expect(offersOtherOrganisation(linked, SSO, SSO_ONLY)).toBe(false);
    expect(offersOtherOrganisation(linked, null, null)).toBe(false);
    expect(offersOtherOrganisation(null, SSO_ONLY, SSO_ONLY)).toBe(false);
  });
});

describe('sign-in page', () => {
  it('shows the work email and the password together from the start', () => {
    for (const lang of ['en', 'id'] as const) {
      const html = login({ lang });
      expect(html).toContain('id="au-email"');
      expect(html).toContain('id="au-password"');
      expect(html.indexOf('id="au-email"')).toBeLessThan(html.indexOf('id="au-password"'));
      expect(html).toContain('type="submit"');
      expect(FORBIDDEN.test(textOf(html))).toBe(false);
    }
  });

  it('shows a generic example address, and the demo persona only on a demo installation', () => {
    expect(login({ lang: 'en' })).toContain('placeholder="name@company.com"');
    expect(login({ lang: 'id' })).toContain('placeholder="nama@perusahaan.co.id"');
    const demo = { ...PROFILE, demo: { enabled: true, personas: true } };
    expect(login({ profile: demo })).toContain(`placeholder="${DEMO_EMAIL_PLACEHOLDER}"`);
    expect(emailPlaceholder('id', true)).toBe(DEMO_EMAIL_PLACEHOLDER);
    for (const html of [login(), login({ lang: 'id' })]) expect(html).not.toContain('nusantaradigital');
  });

  it('offers to forget a remembered organisation, and not one named in the address before its answer arrives', () => {
    const remembered = memoryStore();
    storeLastOrg(remembered, 'ndt');
    expect(textOf(login({ memory: remembered }))).toContain(li(TEXT.otherOrganisation, 'en'));
    expect(textOf(login({ memory: remembered, lang: 'id' }))).toContain('Gunakan organisasi lain');
    expect(textOf(login({ memory: remembered, org: 'bsd' }))).not.toContain(li(TEXT.otherOrganisation, 'en'));
    expect(textOf(login({ memory: memoryStore() }))).not.toContain(li(TEXT.otherOrganisation, 'en'));
  });

  it('links the privacy notice and the terms from the system profile, each hidden when not set', () => {
    const both = login({ profile: { ...PROFILE, legal: { privacyUrl: 'https://mscd.example.id/privacy', termsUrl: 'https://mscd.example.id/terms' } } });
    expect(both).toContain('<nav class="au-legal" aria-label="Privacy and terms">');
    expect(both).toContain('href="https://mscd.example.id/privacy"');
    expect(both).toContain('href="https://mscd.example.id/terms"');
    expect(textOf(both)).toContain('Privacy notice');
    expect(textOf(both)).toContain('Terms of service');
    const id = login({ lang: 'id', profile: { ...PROFILE, legal: { privacyUrl: 'https://mscd.example.id/privasi', termsUrl: 'https://mscd.example.id/ketentuan' } } });
    expect(textOf(id)).toContain('Pemberitahuan privasi');
    expect(textOf(id)).toContain('Ketentuan layanan');
    const privacyOnly = login({ profile: { ...PROFILE, legal: { privacyUrl: 'https://mscd.example.id/privacy', termsUrl: null } } });
    expect(privacyOnly).toContain('Privacy notice');
    expect(privacyOnly).not.toContain('Terms of service');
    expect(login({ profile: { ...PROFILE, legal: { privacyUrl: null, termsUrl: null } } })).not.toContain('au-legal');
    // A profile of an older server has no legal member.
    expect(login()).not.toContain('au-legal');
    // Only web addresses become links.
    expect(renderToStaticMarkup(createElement(LegalLinks, { legal: { privacyUrl: 'javascript:alert(1)', termsUrl: null }, lang: 'en' }))).toBe('');
  });
});
