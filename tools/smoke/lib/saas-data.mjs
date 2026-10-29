// The people and organisations of the SaaS end-to-end run (Milestone 2 plan K.6, M2-S13), shared by run-saas.mjs and
// tests/saas.spec.mjs. Every address is invented; the email domains are answered by the mock DNS of the run only.

/** The password every local account of the run chooses (the operator and the administrators). */
export const PASSWORD = 'Saas-Run-2026!';

/** The platform operator, created by saas-ops.sh create-operator. */
export const OPERATOR = { key: 'operator', name: 'Oki Pratama', email: 'oki.pratama@mscd-operator.test' };

/**
 * Alpha (plan preset standard) verifies its email domain, so its people find it by their work email; Beta (plan
 * preset trial) does not. Each has two Tenant Admins: the first creates the system and asks for the Management System
 * Manager role, which needs the approval of the second (four eyes, D2-12), and then uploads a file.
 */
export const ORGS = {
  alpha: {
    key: 'alpha',
    slug: 'alpha',
    name: 'PT Alpha Solusi Digital',
    preset: 'standard',
    domain: 'alphasolusi.co.id',
    timeZone: 'Asia/Jakarta',
    sites: 2,
    system: {
      code: 'ISMS', slug: 'isms', name: 'Information security management system', edition: 'ISO27001-2022', framework: 'ISO/IEC 27001', colour: 'Teal',
      scope: 'Hosting and support of the Alpha customer portal at the Jakarta office', target: 'A.5.1',
    },
    admin: { key: 'ayu', name: 'Ayu Lestari', email: 'ayu.lestari@alphasolusi.co.id', jobTitle: 'IT Manager' },
    second: { key: 'dimas', name: 'Dimas Saputra', email: 'dimas.saputra@alphasolusi.co.id', jobTitle: 'Head of Compliance' },
    // Invited after the operator lowered Alpha's user limit to the members it has: refused with LIC-USERS.
    extra: { key: 'eka', name: 'Eka Putra', email: 'eka.putra@alphasolusi.co.id', jobTitle: 'Security Analyst' },
  },
  beta: {
    key: 'beta',
    slug: 'beta',
    name: 'CV Beta Mandiri',
    preset: 'trial',
    domain: 'betamandiri.co.id',
    timeZone: 'Asia/Makassar',
    sites: 1,
    system: {
      code: 'QMS', slug: 'qms', name: 'Quality management system', edition: 'ISO9001-2015', framework: 'ISO 9001', colour: 'Purple',
      scope: 'Design and delivery of printed packaging at the Makassar workshop', target: '4.3',
    },
    admin: { key: 'budi', name: 'Budi Santoso', email: 'budi.santoso@betamandiri.co.id', jobTitle: 'Operations Manager' },
    second: { key: 'citra', name: 'Citra Dewi', email: 'citra.dewi@betamandiri.co.id', jobTitle: 'Quality Lead' },
  },
};
