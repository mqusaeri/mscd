// Area `ops-domains` (Milestone 2 D.1, SaaS track, built by M2-S11): email domains of an organisation, verified by a
// DNS TXT record `_mscd-verify.<domain>` with the value `mscd-verify=<token>`. Only the token's hash is stored. A
// verified domain belongs to one organisation only (409 `conflict`, messageKey `domain_taken`); free mail domains are
// refused (422 `business-rule`, messageKey `domain_not_allowed`). In single tenancy every route answers 409
// `conflict` with messageKey `single_tenancy` (J.6); on-premise keeps the operator command `tenant verify-domain`.
import { z } from 'zod';
import { DomainStatus, DomainVerificationMethod } from '../enums.js';
import { Instant, NoBody, OrgSlug, defineRoute, named } from './common.js';
import type { RouteDef } from './common.js';
import { OrgParams } from './ops.js';

/** A normalised domain name as `platform.verified_domain.domain` stores it: lower case, IDN in punycode. */
export const DomainName = named(
  'DomainName',
  z.string().max(253).regex(/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/),
  'Email domain in lower case, IDN labels in punycode (platform.verified_domain.domain and its CHECK)',
  { valid: ['nusantaradigital.co.id', 'xn--bcher-kva.example'], invalid: ['Nusantara.co.id', 'localhost', 'a..b.id', '-x.id'] },
);
export type DomainName = z.infer<typeof DomainName>;

export const OrgDomainParams = named('OrgDomainParams', z.strictObject({ org: OrgSlug, domain: DomainName }), 'Path parameters {org} and {domain}', {
  valid: [{ org: 'ndt', domain: 'nusantaradigital.co.id' }],
  invalid: [{ org: 'ndt', domain: 'NUSANTARA.CO.ID' }, { org: 'ndt' }],
});
export type OrgDomainParams = z.infer<typeof OrgDomainParams>;

const EXAMPLE_DOMAIN = {
  domain: 'nusantaradigital.co.id', status: 'verified', method: 'dns', requestedAt: '2026-10-20T03:00:00Z', verifiedAt: '2026-10-20T04:00:00Z',
  lastCheckedAt: '2026-10-27T04:00:00Z', txtName: '_mscd-verify.nusantaradigital.co.id',
} as const;

export const OrgDomain = named(
  'OrgDomain',
  z.object({
    domain: DomainName,
    status: DomainStatus,
    method: DomainVerificationMethod,
    requestedAt: Instant.nullable(),
    verifiedAt: Instant.nullable(),
    lastCheckedAt: Instant.nullable(),
    txtName: z.string(),
  }),
  'Email domain of an organisation with its verification state, method and the requested, verified and last checked times',
  {
    valid: [EXAMPLE_DOMAIN, { ...EXAMPLE_DOMAIN, status: 'pending', verifiedAt: null, lastCheckedAt: null }, { ...EXAMPLE_DOMAIN, method: 'manual', requestedAt: null }],
    invalid: [{ ...EXAMPLE_DOMAIN, status: 'ok' }, { ...EXAMPLE_DOMAIN, method: 'email' }],
  },
);
export type OrgDomain = z.infer<typeof OrgDomain>;

export const OrgDomainAdd = named(
  'OrgDomainAdd',
  z.strictObject({ domain: z.string().trim().min(4).max(253) }),
  'POST /ops/organizations/{org}/domains body: the domain as typed; the server normalises it (lower case, IDN to punycode)',
  { valid: [{ domain: 'nusantaradigital.co.id' }, { domain: 'Bücher.example' }], invalid: [{}, { domain: 'a.b' }, { domain: 'x.id', method: 'manual' }] },
);
export type OrgDomainAdd = z.infer<typeof OrgDomainAdd>;

export const OrgDomainAdded = named(
  'OrgDomainAdded',
  z.object({ domain: DomainName, txtName: z.string(), txtValue: z.string().regex(/^mscd-verify=[A-Za-z0-9_-]{20,}$/), status: DomainStatus }),
  'The TXT record the customer adds to DNS; txtValue is shown once (only its hash is stored)',
  {
    valid: [{ domain: 'nusantaradigital.co.id', txtName: '_mscd-verify.nusantaradigital.co.id', txtValue: 'mscd-verify=3q2-7wEVxk0bU9fBvYkTfQbgWm8nC4cN6r1dJQ_zLhA', status: 'pending' }],
    invalid: [{ domain: 'nusantaradigital.co.id', txtName: '_mscd-verify.nusantaradigital.co.id', txtValue: 'token', status: 'pending' }],
  },
);
export type OrgDomainAdded = z.infer<typeof OrgDomainAdded>;

const ops = { owner: 'M2-S11' as const, auth: 'session' as const, scope: 'platform' as const };

export const opsDomainsListRoute = defineRoute({
  ...ops, id: 'ops.domains.list', method: 'GET', path: '/api/v1/ops/organizations/:org/domains',
  summary: 'Email domains of an organisation with status, method and the requested, verified and last checked times',
  permission: 'ops.read', params: OrgParams, response: z.array(OrgDomain), errors: [404, 409],
});
export const opsDomainsAddRoute = defineRoute({
  ...ops, id: 'ops.domains.add', method: 'POST', path: '/api/v1/ops/organizations/:org/domains',
  summary: 'Add an email domain and return its TXT record (409 domain_taken, 422 domain_not_allowed; audited ops.domain_added)',
  permission: 'ops.tenants.manage', params: OrgParams, body: OrgDomainAdd, response: OrgDomainAdded, status: 201, errors: [404, 409, 422],
});
export const opsDomainsVerifyRoute = defineRoute({
  ...ops, id: 'ops.domains.verify', method: 'POST', path: '/api/v1/ops/organizations/:org/domains/:domain/verify',
  summary: 'Check the TXT record now (audited ops.domain_verified or ops.domain_verification_failed)',
  permission: 'ops.tenants.manage', params: OrgDomainParams, response: OrgDomain, errors: [404, 409, 503],
});
export const opsDomainsRemoveRoute = defineRoute({
  ...ops, id: 'ops.domains.remove', method: 'DELETE', path: '/api/v1/ops/organizations/:org/domains/:domain',
  summary: 'Remove an email domain of the organisation (audited ops.domain_removed)',
  permission: 'ops.tenants.manage', params: OrgDomainParams, response: NoBody, status: 204, errors: [404, 409],
});

export const routes: RouteDef[] = [opsDomainsListRoute, opsDomainsAddRoute, opsDomainsVerifyRoute, opsDomainsRemoveRoute];
