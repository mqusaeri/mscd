# MSCD roadmap

The order of work after Milestone 2. Details of Milestone 2 are in `docs/platform/MILESTONE-2.md`; the items below come from its out-of-scope lists (sections B and K.8).

## 1. Go-live, right after Milestone 2

Mostly owner work, with agents fixing what comes up.

1. The owner provides the production and staging servers, the domain, the mail provider and the backup bucket, and makes the release keys with `deploy/scripts/saas-keys.sh` (section K.2 of the plan).
2. A lawyer qualified in Indonesian law prepares the privacy notice, the terms of service and the data processing agreement (DPA), and the PSE Lingkup Privat registration through OSS (`docs/saas/`).
3. Deploy to staging, run the external penetration test, fix the findings, retest.
4. Deploy to production and onboard the first pilot customer from the operator console.

## 2. Milestone 3, before or soon after the first paying customers

- Full tenant export in open formats and verified deletion after offboarding. The DPA promises it; needed before the first customer leaves (estimate 11 to 17 working days).
- Requests from one person (export, anonymise or delete) as a feature, replacing the manual operator procedure.
- Read confirmation of policies, retention periods and disposal review for documents and records.
- Periodic access review task (ISO/IEC 27001 Annex A 5.18) and the Top Management totals panel.
- Demo personas for Programme Owner, Risk Owner and Compliance Investigator; terminology renames if not approved earlier.

## 3. Growth, driven by customer demand

- Self-service sign-up and billing (for example an Indonesian payment provider).
- LDAP and Active Directory sign-in; SMB, S3 and WebDAV repositories; direct browser upload to Microsoft 365 and Google Drive.
- Edition transitions with mapping files (ISO 9001:2026, ISO 37001:2025) after a lead auditor check.
- High availability: a second node with the Helm chart, WAL archiving for a recovery point of minutes, a central log store, cloud KMS, a mail provider API with bounce handling.
- Deep links for every screen; audit findings in the Golden Thread Viewer.

## Outside the code

- Have a human lead auditor review the framework pack content and `docs/product/USER-FLOWS.md` before customers rely on them.
- Certify the provider's own company to ISO/IEC 27001, using MSCD for its own programme. Larger and regulated customers (for example under OJK) will ask for it, and it becomes the first case study.
