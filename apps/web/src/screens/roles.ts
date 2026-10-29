// Role labels (MILESTONE-2 M2-01, D2-06): one label pair per business role and per administration role, in the
// current product words. The top bar and the role menu show the label of the role the person holds, so a Programme
// Owner no longer reads "MS Manager" and an External Auditor no longer reads "Internal Auditor" (the UI roles of F.7
// group several business roles under one persona). M2-17 applied the renames of H.1 (product decision 10): the
// role `ms_manager` reads "Management System Manager" in English and Indonesian; every other label keeps its words.
import type { BusinessRole, OrgRole, PlatformRole } from '@mscd/shared';
import type { Pair, UiRole } from '../data/types';

export const BUSINESS_ROLE_LABELS: Readonly<Record<BusinessRole, Pair>> = {
  ms_manager: ['Management System Manager', 'Management System Manager'],
  programme_owner: ['Programme Owner', 'Pemilik Program'],
  domain_owner: ['Domain Owner', 'Pemilik Domain'],
  risk_owner: ['Risk Owner', 'Pemilik Risiko'],
  internal_auditor: ['Internal Auditor', 'Auditor Internal'],
  top_management: ['Top Management', 'Manajemen Puncak'],
  external_auditor: ['External Auditor', 'Auditor Eksternal'],
  compliance_investigator: ['Compliance Investigator', 'Investigator Kepatuhan'],
};

export const ADMIN_ROLE_LABELS: Readonly<Record<OrgRole, Pair>> = {
  tenant_admin: ['Tenant Admin', 'Admin Tenant'],
  storage_admin: ['Storage Admin', 'Admin Penyimpanan'],
};

export const PLATFORM_ROLE_LABELS: Readonly<Record<PlatformRole, Pair>> = {
  platform_operator: ['Platform Operator', 'Operator Platform'],
};

/**
 * The business role a person is shown with when they hold several in one system: the order of the UI role rule of
 * F.7 (`uiRoleFor`), with each business role after the one it shares a persona with.
 */
export const ROLE_PRECEDENCE: readonly BusinessRole[] = [
  'ms_manager', 'programme_owner', 'internal_auditor', 'external_auditor', 'top_management', 'domain_owner', 'risk_owner',
  'compliance_investigator',
];

/** The persona label of each UI role (the sample personas and the demo persona menu). */
export const UI_ROLE_LABEL: Readonly<Record<UiRole, Pair>> = {
  manager: BUSINESS_ROLE_LABELS.ms_manager,
  owner: BUSINESS_ROLE_LABELS.domain_owner,
  auditor: BUSINESS_ROLE_LABELS.internal_auditor,
  top: BUSINESS_ROLE_LABELS.top_management,
};

/** The first business role of `roles` in ROLE_PRECEDENCE; null when none is a business role. */
export function primaryBusinessRole(roles: readonly string[] | null | undefined): BusinessRole | null {
  if (!roles) return null;
  return ROLE_PRECEDENCE.find((r) => roles.includes(r)) ?? null;
}

/**
 * The label of the role a person holds: the business role in the system, else an administration role, else the
 * platform role; null when the person holds none.
 */
export function heldRoleLabel(
  businessRoles: readonly string[] | null | undefined,
  adminRoles: readonly string[] = [],
  platformRoles: readonly string[] = [],
): Pair | null {
  const business = primaryBusinessRole(businessRoles);
  if (business) return BUSINESS_ROLE_LABELS[business];
  const admin = (['tenant_admin', 'storage_admin'] as const).find((r) => adminRoles.includes(r));
  if (admin) return ADMIN_ROLE_LABELS[admin];
  if (platformRoles.includes('platform_operator')) return PLATFORM_ROLE_LABELS.platform_operator;
  return null;
}
