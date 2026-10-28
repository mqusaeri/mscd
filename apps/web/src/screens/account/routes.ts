// Routes of the My account screen (MILESTONE-2 M2-16): `[method, path]` constants for `call()` of screens/api.ts and
// the shared route ids, which test/screens/account.test.tsx compares with the route table of @mscd/shared.
import type { RouteRef } from '../api';

export const ROUTES = {
  security: ['GET', '/api/v1/me/security'],
  recoveryCodes: ['POST', '/api/v1/me/mfa/recovery-codes'],
  preferences: ['PUT', '/api/v1/me/preferences'],
  passwordChange: ['POST', '/api/v1/auth/password/change'],
  providers: ['GET', '/api/v1/auth/providers'],
  identityLink: ['POST', '/api/v1/me/identities/:slug/link'],
  calendarRevoke: ['POST', '/api/v1/ms/:ms/calendar-feed/revoke'],
} as const satisfies Record<string, RouteRef>;

export const ROUTE_IDS: Record<keyof typeof ROUTES, string> = {
  security: 'me.security',
  recoveryCodes: 'me.recovery-codes',
  preferences: 'me.preferences',
  passwordChange: 'auth.password.change',
  providers: 'auth.providers',
  identityLink: 'me.identity.link',
  calendarRevoke: 'calendar-feed.revoke',
};

/** The enrolment page in its `reenrol` mode (src/auth, M2-S11): replaces the authenticator and returns to the app. */
export const REENROL_PATH = '/login/enrol';
