// The people, the organisation and the licence of the fresh-organisation journey (MILESTONE-2 M2-18), shared by
// run-journey.mjs and tests/fresh-org.spec.mjs.
//
// The team signs in through company sign-in: rina, hendra, bagus and maya are the users of the development Keycloak
// realm (deploy/compose/dev/keycloak/realm-mscd.json), with the demo password of every development user. Their email
// addresses are the ones the realm sends, so an invitation is redeemed through Keycloak (F.8: the token's email must be
// the invited address). The two Tenant Admins and the platform operator are local accounts.
import { createHash } from 'node:crypto';

/** The password the local accounts of the journey choose: the two Tenant Admins and the platform operator. */
export const LOCAL_PASSWORD = 'Nusantara-Mitra-2026!';
/** The password of the development Keycloak users (G.3): rina, hendra, bagus and maya keep the realm's password. */
export const KEYCLOAK_PASSWORD = 'Mscd-Demo-2026!';

export const ORGANISATION = {
  slug: 'nusantara',
  name: 'PT Nusantara Mitra Solusi',
  timeZone: 'Asia/Jakarta',
  sites: 2,
};

export const PEOPLE = {
  // First Tenant Admin, invited by the installer (admin create-user) or by the operator console.
  ana: { key: 'ana', name: 'Ana Wijaya', email: 'ana.wijaya@nusantaradigital.co.id', jobTitle: 'IT Manager' },
  // Second Tenant Admin: approves the role grants that need four eyes.
  dewi: { key: 'dewi', name: 'Dewi Lestari', email: 'dewi.lestari@nusantaradigital.co.id', jobTitle: 'Head of Legal' },
  // Management System Manager (primary) of the ISMS.
  rina: { key: 'rina', name: 'Rina Kusuma', email: 'rina.kusuma@nusantaradigital.co.id', jobTitle: 'ISMS Manager', keycloak: 'rina' },
  // Top Management and Programme Owner (Management System Sponsor): the second person who can verify.
  hendra: { key: 'hendra', name: 'Hendra Wijaya', email: 'hendra.wijaya@nusantaradigital.co.id', jobTitle: 'Chief Operating Officer', keycloak: 'hendra' },
  // Domain Owner of the controls and Storage Admin of the repositories (an administrator, so his grant waits for a
  // second Tenant Admin).
  bagus: { key: 'bagus', name: 'Bagus Prasetyo', email: 'bagus.prasetyo@nusantaradigital.co.id', jobTitle: 'Infrastructure Lead', keycloak: 'bagus' },
  // Internal Auditor.
  maya: { key: 'maya', name: 'Maya Putri', email: 'maya.putri@nusantaradigital.co.id', jobTitle: 'Internal Auditor', keycloak: 'maya' },
};

/** The platform operator of the SaaS variant (admin create-operator). */
export const OPERATOR = { key: 'operator', name: 'Oki Pratama', email: 'oki.pratama@mscd-operator.test' };

/**
 * The SharePoint library of the mock provider (tools/mock-providers/fixtures/demo.json): the tenant, the site, the
 * library and the root folders. The journey's app (client id) is registered with a new certificate when the run
 * starts; the demo's own app is not used.
 */
export const SHAREPOINT = {
  tenantId: '6d3f1a2b-4c5d-4e6f-8a7b-9c0d1e2f3a4b',
  clientId: '5c4b3a29-1807-4f6e-9d5c-4b3a29180716',
  siteId: 'nusantaradigital.sharepoint.com,compliance',
  driveId: 'drive-sp-compliance',
  rootFolderId: 'demo-sp-compliance',
  ismsFolderId: 'demo-sp-isms',
  ismsPath: 'Compliance/ISMS',
};

/** Today in a time zone as YYYY-MM-DD (throws for an unknown zone). */
export function isoDateIn(timeZone, at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** An ISO date moved by whole days. */
export function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The unsigned licence of the organisation: bound to its id, one year from the journey's first day (D-15). */
export function licenceDocument({ orgId, orgName, today }) {
  const tag = createHash('sha256').update(orgId).digest('hex').slice(0, 8).toUpperCase();
  return {
    license_id: `LIC-JOURNEY-${tag}`,
    organization: orgName,
    organization_id: orgId,
    valid_from: today,
    valid_until: addDays(today, 365),
    grace_days: 30,
    frameworks: ['ISO27001', 'ISO9001', 'ISO22301', 'ISO37001'],
    max_management_systems: 4,
    max_users: 25,
    storage_adapters: ['managed_vault', 'm365', 'google_drive'],
    features: ['integrated_mode', 'edition_transition', 'link_health_monitor', 'auditor_guest_access'],
  };
}
