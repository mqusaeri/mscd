// The people and organisations of the data lifecycle run (MILESTONE-3 M3-11), built on those of the SaaS end-to-end
// run (saas-data.mjs). Every person and address is invented (R-19); the email domains are answered by the mock DNS of
// the run only.
import { ORGS, OPERATOR, PASSWORD } from './saas-data.mjs';

export { OPERATOR, PASSWORD };

/**
 * Alpha keeps its records in MSCD from its first policy until the end of its contract: Ayu (Tenant Admin, primary
 * Management System Manager of the ISMS), Dimas (Tenant Admin, second Management System Manager: the second person of
 * the approvals), Eka (Domain Owner, later also a member of Beta) and Fajar (Domain Owner who leaves and asks to be
 * erased).
 */
export const ALPHA = {
  ...ORGS.alpha,
  member: ORGS.alpha.extra,
  leaver: { key: 'fajar', name: 'Fajar Nugroho', email: 'fajar.nugroho@alphasolusi.co.id', jobTitle: 'Network Engineer' },
  /** The policy that needs read confirmation (a template of the ISO/IEC 27001 pack). */
  policy: 'POL-01',
  /** The lapsed competence record whose retention period of 1 month has ended (Eka's training, ended 60 days ago). */
  competence: { role: 'Security analyst', required: 'Incident handling training for the security operations rota', achievedDaysAgo: 430, validUntilDaysAgo: 60 },
};

/** Beta keeps working after Alpha is deleted; Eka, a member of both, keeps her account and works in Beta. */
export const BETA = ORGS.beta;

/** Every person of the run by key. */
export const PEOPLE = {
  operator: OPERATOR,
  [ALPHA.admin.key]: { ...ALPHA.admin, org: ALPHA },
  [ALPHA.second.key]: { ...ALPHA.second, org: ALPHA },
  [ALPHA.member.key]: { ...ALPHA.member, org: ALPHA },
  [ALPHA.leaver.key]: { ...ALPHA.leaver, org: ALPHA },
  [BETA.admin.key]: { ...BETA.admin, org: BETA },
};
