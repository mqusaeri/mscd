# Facts for the lawyer. Not legal advice.

| | |
|---|---|
| Service | MSCD (Management System Compliance Dashboard) run as a multi-tenant SaaS service |
| For | A lawyer qualified in Indonesian law, who drafts or reviews the privacy notice, the data processing agreement (DPA), the terms of service, the DPO decision, the PSE registration and the position on data location and cross-border transfer |
| Written | 27 October 2026, from the source code of the platform (Milestone 1, built) and the Milestone 2 plan (`docs/platform/MILESTONE-2.md`, section K, being built) |
| Updated | 1 November 2026, from the code of Milestone 3 as built (`docs/platform/MILESTONE-3.md`, work package M3-11): the end of a contract with the organisation export and the verified deletion, requests from one person, the retention periods and the backups. Questions 7, 8 and 13 carry the built facts |
| Status | Facts only. The suggestions in this document are starting points for the lawyer. Every legal conclusion, and every reading of a law, needs the lawyer's confirmation |

How to read the "Built" marks: **built** means the code exists today; the package in brackets (M2-Sxx of the Milestone 2 plan, M3-xx of the Milestone 3 plan) built it. Some built parts still need a step by the owner before go-live, for example installing the backup timer or the penetration test; the go-live checklist ([go-live-checklist.md](go-live-checklist.md)) tracks each of them.

## What the lawyer is asked to produce

| Document | Facts in this pack |
|---|---|
| Privacy notice in Indonesian and English, published on a public address and linked from the sign-in page | [Processing activities](#processing-activities), [Cookies and browser storage](#cookies-and-browser-storage), [Retention](#retention) |
| DPA template for customers, with the security measures as an annex | [Who is who](#who-is-who), [Recipients and subprocessors](#recipients-and-subprocessors), [Security measures for the DPA annex](#security-measures-for-the-dpa-annex), [End of contract and what is not built yet](#end-of-contract-and-what-is-not-built-yet) |
| Terms of service in Indonesian and English (Law No. 24 of 2009 asks for Indonesian in agreements with Indonesian parties) | [The service in short](#the-service-in-short), service levels in [owner-inputs.md](owner-inputs.md) (decision D-S7) |
| DPO decision (UU PDP Article 53) | [Questions for the lawyer](#questions-for-the-lawyer), question 3 |
| PSE Lingkup Privat registration through OSS | [The service in short](#the-service-in-short), question 9 |
| Written position on data location and cross-border transfer (UU PDP Article 56) | [Data locations](#data-locations), question 5 |
| Confirmation of the breach notice duties and of the authority that receives notices today | [incident-response.md](incident-response.md), question 6 |
| Review of the draft records of processing | [records-of-processing.md](records-of-processing.md) |

## The service in short

- MSCD helps an organisation reach and keep ISO certification for ISO/IEC 27001 (information security), ISO 9001 (quality), ISO 22301 (business continuity) and ISO 37001 (anti-bribery). It links each risk to its controls, documents and evidence, and tracks progress toward the certification audit.
- On SaaS, one installation on one rented server (VPS) serves many customer organisations. Each organisation has its own database schema, and database rules stop one organisation from reading another's rows.
- Customers are businesses. Sales are led by the provider: a platform operator creates each customer organisation and invites its first administrator by email. There is no self-service sign-up and no payment in the app (decision D-S1).
- Users are the customer's staff, invited by the customer's administrators. External certification auditors can get a guest account limited to one management system for 1 to 30 days.
- The provider is `<legal name of the company that runs MSCD SaaS>`, with its address and company registration number. The owner fills this in.
- The service is an electronic system offered to the public in Indonesia through the internet, so the PSE Lingkup Privat rules are likely to apply (question 9).
- The same software is also sold for on-premise installation, where the customer runs everything on its own servers. This pack covers SaaS only.

## Who is who

| Party | What it does in the service | Likely role under UU PDP (the lawyer confirms) |
|---|---|---|
| Customer organisation | Buys the service, decides who gets an account, enters its compliance records and files, chooses where its files are stored | Controller of its users' data and of its compliance content |
| Provider (the company that runs MSCD SaaS) | Runs the server, the backups, mail and monitoring, creates organisations, gives support | Processor for the customer's data. Controller of its own operator accounts, of customer contact and billing data kept outside the app, and possibly of the shared sign-in account and the security logs (question 1) |
| Customer staff | Sign in and work on records | Data subjects |
| External auditors (guests) | Read one management system for a limited time | Data subjects |
| People named in records without an account | For example contacts of interested parties, business associates under ISO 37001 who are individuals, or people named in uploaded documents | Data subjects |
| Platform operators | Provider staff who create and manage customer organisations | Data subjects (provider staff) |
| Subprocessors | Server host, backup storage, mail provider, GitHub and the monitoring services | Other processors engaged by the provider (UU PDP Article 51) |

## Questions for the lawyer

1. **Shared sign-in account.** One person has one sign-in account (email, password hash, MFA factor) even when several customer organisations invite them. Each organisation sees only its own membership and roles. Who is the controller of the account itself and of its sign-in security data (password hash, MFA, sessions, sign-in history)?
2. **Basis for each activity (Article 20).** Possible bases are listed per activity in [records-of-processing.md](records-of-processing.md): the contract with the customer for the service itself, and a legitimate interest for security logs and fraud prevention. Which basis applies, and is consent needed anywhere?
3. **DPO (Article 53).** Must the provider, as processor, appoint a data protection officer? MSCD records which user did what in the audit trail and shows pending work per person to managers. It holds no specific personal data by design (question 12).
4. **Impact assessment (Article 34).** Is a data protection impact assessment needed before go-live?
5. **Data location and transfer abroad (Article 56).** The facts are in [Data locations](#data-locations). The weekly restore test runs on a GitHub-hosted runner outside Indonesia with a full copy of the production database. GitHub also stores the logs of operator commands, which can contain organisation names and invited email addresses, and the repository is public, so anyone can read those logs unless the workflows hide such values or the repository becomes private (go-live checklist GL-50). The mail provider may be abroad. Which of these are transfers, and what is needed for each (equal protection, binding safeguards or consent)?
6. **Breach notice (Article 46).** The plan has the provider tell the customer within 24 hours of becoming aware. The customer as controller then gives written notice within 3 x 24 hours to the people affected and to the authority, and in some cases to the public. When does the 3 x 24 hour period start? Which authority receives notices today, given that the institution of Article 58 is set by the President? What must the provider do when the customer asks for help?
7. **Audit trail kept for the life of the organisation.** The audit trail is a hash chain: removing old entries breaks the integrity check that customers and certification auditors rely on. It holds who did what, with the network address and browser of each request. MSCD therefore never deletes an audit entry. Instead it removes the personal values inside entries by *attested redaction* (built): the network address and the browser are cleared, and every email, handle and name in the entry is replaced by a pseudonym such as "Former user 7F3A". Action, time and record stay. A new chained entry lists every redacted entry with its stored fingerprint, so the integrity check still proves that no entry was added, removed or reordered, and the redaction itself stays visible. This happens in three cases: when a person is erased in an organisation (that organisation's audit trail, and the provider's audit log entries of that organisation about the person; for a person without an account, their email in every entry and their name in the entries of the records the managers edited for the request), when an organisation is deleted at the end of its contract (its own audit trail goes with its database schema; the provider's audit log entries about it are redacted and kept), and when a record is disposed of after its retention review (every value inside its entries is cleared without a pseudonym; the record's code, its type and id stay with the action, who did it and when). The pseudonym is *pseudonymised* data, which differs from anonymous data: the organisation's erasure table links the pseudonym to the account, and the request keeps the name as proof of the answer, so whoever holds both can tell who it was. Pseudonymised data stays personal data under UU PDP. Is keeping the audit trail for the life of the organisation, with this redaction, justified, and what must the notice say?
8. **End of contract.** Built (Milestone 3, M3-02 and M3-03): when the contract ends, the organisation is read-only for 30 days and its final export is prepared at once for its Tenant Admins to download. Then MSCD closes the organisation by itself and deletes it for good 30 days later: its database schema, its vault files, its data key, the accounts that belonged to it only (anonymised, the rows kept as an empty shell) and the personal values in the provider's audit entries about it. The provider receives a signed deletion certificate, which also goes to the customer's Tenant Admins. The deletion does not reach into the backups at once: older encrypted copies stay until they age out, at the latest by the end date that the certificate states (details in [Retention](#retention)). What may the DPA promise about the dates, the export, the certificate and the backups?
9. **PSE registration.** Must the provider register as a PSE Lingkup Privat under Government Regulation (PP) No. 71 of 2019 and the ministry's rules for private-scope operators (Permenkominfo No. 5 of 2020, as amended by No. 10 of 2021, or newer rules)? Under which business classification?
10. **Regulated customers.** Some customers (for example under OJK supervision) may need their data kept in Indonesia. What should the terms say about data location and about the customer's own duty to check its sector rules?
11. **Language of the terms (Law No. 24 of 2009).** Is an Indonesian version required for every customer, and which version prevails when the two differ?
12. **Specific personal data (Article 4).** MSCD has no fields for health, biometric, genetic, criminal, children's or financial data. Customers can still upload any file or write free text, for example an emergency contact list with health notes, or due diligence notes on a business associate that mention an alleged offence. How should the terms and the DPA handle this?
13. **Requests from data subjects.** Built (Milestone 3, M3-04): the customer's Tenant Admins record each request in the app, see its due time and answer it on screen: a copy of the person's data as a file, a correction of the name and job title, a stop to the use (the membership is disabled) or an erasure under a pseudonym, after each Management System Manager has checked their system for the person. The due time is 72 hours (3 x 24 hours) after the request was received, for every type of request, by default; the provider can change the value. This repository holds no article of UU PDP for these deadlines: the 72 hours are a product default without a legal source. Each member can download their own data and correct their own name and job title in "My account". The provider forwards a request it receives to the customer's Tenant Admins on the day it arrives and keeps a short forwarding log, and the Tenant Admins record the time the provider received it, so the due time counts from then ([records-of-processing.md](records-of-processing.md#requests-from-data-subjects)).
    An erasure keeps the organisation's records and audit entries under a pseudonym: this is pseudonymised data, which stays personal data under UU PDP (question 7). For a person without an account, for example a supplier contact, the erasure removes their email from every audit entry of the organisation and their name from the entries of the records the managers edited for the request. Each erasure writes an erasure receipt that names no person (the organisation, the request number, the pseudonym, the time and the ids of the redactions), signed with the service's audit anchor key and emailed within minutes of the erasure to the platform operators and the organisation's active Tenant Admins. After a failed send the worker tries again every hour (once a day in an on-premise installation), and only one run per organisation sends at a time, so a receipt is not sent twice. When email does not work or a receipt email was lost, the operator prints the signed receipts with `mscd-server tenant erasure --print-receipts <slug>`. After a restore from a backup older than the erasure, the operator applies the receipt again, so the person is erased again under the same pseudonym ([backup-restore.md](backup-restore.md#erased-people-and-the-backups)). Disposals have no receipt yet: a restore from a backup older than a disposal brings that record's content back until the Management System Managers approve its disposal again; receipts for disposals come before the production go-live (go-live checklist GL-69).
    A person erased in an organisation who is later invited there again, for example when rehired, rejoins with a fresh account and membership: the records from before the erasure keep the pseudonym, and the new account shows no link to them (product owner decision of 1 November 2026, built in Milestone 3). When the erased account is still used in another organisation, the same email address cannot be invited again in this organisation, and the person is invited with another email address.
    **Questions for the lawyer:** for each right of a data subject (access, correction, stop to the use, erasure), which article of UU PDP or of its implementing regulation gives the right and its deadline, and when does the clock start: when the person asks the customer, or when the provider receives a request meant for the customer? Is 72 hours right for each type? May the organisation keep its records and audit entries under a pseudonym when a person asks to be erased, and how long may the request record, which keeps the name as proof of the answer, stay?
14. **Work monitoring.** Managers see each person's pending work, and the audit trail shows who changed what. Must the privacy notice tell users about this, and does it count as monitoring of employees?
15. **Age of users.** The service is for business users, and there is no age check. Is a statement in the terms enough?

## Processing activities

Each activity has one record in [records-of-processing.md](records-of-processing.md), with purpose, data, people, recipients, location, retention and safeguards.

| Activity | Purpose | People | Main data |
|---|---|---|---|
| Account and sign-in data | Let invited people sign in safely and give each one the right access | Customer staff, guest auditors, platform operators | Email, name, job title, password hash, MFA factor, memberships and roles, sessions with network address and browser |
| Customer compliance content | Run the customer's ISO programme: registers, risks, controls, audits, findings, reviews, tasks | Customer staff and people named in records | Names of record owners and assignees, and whatever the customer writes in free text |
| Evidence files and documents | Keep the files that prove each control works, and their versions | Anyone named in a file | File content in the Managed Vault, or file details for files kept in the customer's Microsoft 365 or Google Drive |
| Notification emails | Tell people about invitations, reminders, due dates and security changes | Customer staff, guest auditors, operators | Email address, name, message text with record titles, links |
| Logs and backups | Keep the service secure and working, prove what happened, recover from loss | Everyone who uses the service | Audit entries, access logs with network address and browser, metrics, encrypted backups |
| Support and operator access | Create and manage customer organisations, answer support requests, handle incidents | Customer administrators, users who ask for help, operators | Organisation details, member counts, invited emails, diagnostics, messages |

## Data in detail

### Account and sign-in data

| Data | Detail | Built |
|---|---|---|
| Account | Email, display name, optional job title, a generated short name (handle), account kind (person, guest or system), status, created and changed times and by whom, last sign-in time | built |
| Password | Only an argon2id hash, the time of the last change, the count of failed sign-ins and the lock time | built |
| Second factor | TOTP secret encrypted with the platform key, its label and confirmation time, the last code step used; 10 recovery codes stored as hashes; the count of failed codes and the lock level | built |
| Sign-in through the customer's own provider (SSO) | The provider, the person's id at that provider, the email at the time of linking, how the link was made and the last sign-in through it | built |
| Memberships and roles | Organisation, administrator roles, membership status, default organisation, who invited the person and when they accepted; business roles per management system with an optional end date | built |
| Invitations | The invited email, the organisation, who invited, the times. The invitation link is valid 72 hours and only its hash is stored | built |
| Password reset | Only a hash of the reset token, valid 30 minutes | built |
| Sessions | A hash of the session id, the organisation, the sign-in method, the network (IP) address, the browser description (user agent), start, last activity, expiry and the reason it ended | built |
| Preferences | Language and screen preferences of the user | built |
| Guest auditors | The guest's email, the management system, the end date (1 to 30 days), when the link was used and last used; one-time codes sent by email, stored as hashes | built |
| Sign-in limits | Counters keyed by network address and by email address, deleted when the time window ends | built |
| Verified email domains | The customer's email domains, proven by a DNS record, so sign-in can find the organisation | built (M2-S11) |

### Customer compliance content

- Registers of the management systems: context issues, interested parties, assets with their owner and classification, risks with owners, treatments and residual risk acceptance (who accepted and when), metrics and their values, quality objectives, processes, business impact analyses, business continuity plans and exercises, business associates and their due diligence under ISO 37001 (category, country, bribery risk level, outcome, conditions).
- Programme records: the statement of applicability, controls and their status, implementation activities, document register entries, audit events, preparation tasks, findings, corrective actions, self-assessments, management reviews, reminders (who sent one to whom), tasks and certification cycles.
- People appear in these records mainly as the owner, holder or assignee of a record (a link to their account) and in free text written by users.
- Deleting a record in the app marks it deleted. The row stays in the database, because the application's own database role has no right to remove business rows (build plan C.1). This keeps the audit trail complete.
- Every change is written to the organisation's audit trail with the values before and after the change.

### Evidence files and documents

- **Managed Vault (built).** Files uploaded by users are stored in the object store on the same server, each file encrypted with its own key (AES-256-GCM), and that key is protected by a key of the organisation, which is protected by a key-encryption key kept outside the database. The database keeps the file name, size, type found by the server, SHA-256 fingerprint, folder, uploader and times.
- **The customer's Microsoft 365 or Google Drive (built).** When the customer connects its own drive, files are written to and read from that drive through MSCD's storage gateway. MSCD keeps file details only: name, folder path, link, version, size, fingerprint, modified time and the name of the person who last changed the file as the drive reports it. The drive credential is stored encrypted. An option, "metadata minimisation", names the files written to the drive after their evidence or document code, so titles that may name people stay out of the drive.
- **Evidence packs (built).** When a manager prepares the evidence for an auditor, copies of the chosen files are placed in the Managed Vault for the auditor.
- **Exports (built).** Reports and registers exported as PDF, spreadsheet or CSV are stored in the Managed Vault. The download link stops working after 7 days, and the next hourly clean-up deletes the stored file.
- **Organisation export (built, Milestone 3).** A Tenant Admin can download everything the organisation keeps in MSCD: every table as CSV and JSON Lines files, the audit trail with its signed anchors, and every Managed Vault file, in parts with a list of SHA-256 fingerprints (the manifest). A second Tenant Admin approves the request first when the organisation has one, and every Tenant Admin and primary Management System Manager is told of each request and download. The parts stay downloadable for 7 days and are then deleted; the final export made when a contract ends stays until the organisation closes. The platform operator can start an export and see its status, never download it. Secrets (password hashes, second-factor secrets, token hashes, sealed credentials, keys) are left out.
- **Personal data copies (built, Milestone 3).** A copy of one person's data as a JSON file, for that person or for a Tenant Admin answering an access request. It is stored and expires like the other exports.
- MSCD does not read file contents, apart from finding the real file type. A file can hold any kind of personal data (question 12). The upload limit is 100 MiB per file.

### Notification emails

- In-app notifications and emails for reminders, due and overdue items, review dates, new document versions, audit date changes, licence and storage warnings, role grants waiting for approval, and finished exports (built).
- Each holds the recipient, the organisation, the title and text in English and Indonesian (often with the title of a record), a link to the app, and the delivery status and attempts (built).
- Account emails: invitations, password reset links and one-time codes for guest auditors (built). Security emails: a new or replaced second factor, a used recovery code, a locked second factor, a changed or reset password, a newly linked SSO account (built).
- Status change notices to the administrators of an organisation (built, M2-S09) and plan expiry notices (built, M2-S10).
- Emails leave through the mail provider's SMTP relay, which keeps its own delivery logs.

### Logs and backups

- **Platform audit log (built):** sign-ins and failed sign-ins, account changes, operator actions, licence and pack events. Each entry holds who, what, which record, the changed fields, a request id, the network address and the browser description. Secrets and tokens are replaced by `[redacted]` before writing.
- **Organisation audit trail (built):** every change to business records with the values before and after, every file opened or downloaded, every read by an external auditor and every refused access.
- **Audit anchors (built):** signed fingerprints of the newest audit entry, with no personal data. They prove that nobody rewrote the audit trail.
- **Access logs (built, extended by M2-S02):** one line per web request with the network address, time, path (with sensitive values removed from the address), status, size, referring page, browser description and request id. The TLS front (Caddy) writes its own access log with the query string removed. Application logs hold the request id, path and status, and never cookies, passwords or tokens.
- **Metrics (built, M2-S08):** counts and timings per service and per organisation id, kept 30 days, with no names or emails.
- **Backups (built, M2-S07):** every night an encrypted copy of the whole database (all organisations), the vault files (already encrypted per file) and, under a separate key, the server's secrets folder go to an off-site bucket. The nightly run starts once the owner installs its timer after the first deploy (go-live checklist GL-27). A copy of the database is also taken on the server before each deploy (the last 3 are kept, M2-S05).
- **Restore test (built, M2-S07):** every week the latest database copy and a sample of vault files are restored on a temporary GitHub-hosted machine to prove the backup works. The machine and its data are removed when the job ends.

### Support and operator access

- **Platform operators (built, extended by M2-S09 to M2-S12):** sign in with TOTP and see a list of organisations with slug, name, status, plan, member count, verified domains and last sign-in. They create organisations and the first administrator invitation, change an organisation's status, set its plan, verify its email domains, reset a person's second factor with a reason, run allow-listed jobs and download a diagnostics archive with secrets removed. Operators have no right to read business records or files in the app.
- **Operator commands from GitHub (built, M2-S09):** the owner runs operator commands through an approved GitHub workflow. The command output, for example an organisation list or "Invitation sent to `<email>`", is shown in the job summary, which GitHub keeps for the repository's log retention period. In a public repository anyone can read it, so the output must hide personal data and customer names, or the repository must become private (go-live checklist GL-50).
- **Server administrators:** named SSH accounts of the owner. Like any server administrator, they could technically read the database and files on the server, because the encryption keys are on the same server. SSH sign-ins are logged by the server. Session recording is not built (K.8).
- **Support requests:** customers write to the support email address. The messages are kept in the provider's mailbox.
- **Incidents and requests from data subjects:** incidents follow [incident-response.md](incident-response.md). Requests from people are answered by the customer in the app; the provider only forwards a request it receives ([records-of-processing.md](records-of-processing.md#requests-from-data-subjects)).
- **End of contract (built, Milestone 3):** the operator moves the organisation to read-only, can start an export for the Tenant Admins without being able to download it, can move the date of the deletion (never earlier than 7 days after the organisation closed) or reopen a closed organisation for 7 days when the customer forgot its export, and downloads the signed deletion certificate. The purge itself runs only on its date.

## Cookies and browser storage

MSCD sets only cookies that the service needs to work. All are set by MSCD's own address, carry a random value and are unreadable by page scripts (`HttpOnly`). There are no analytics, advertising or social media cookies, and no third-party scripts.

| Cookie | Set when | What it does | How long it lasts |
|---|---|---|---|
| `__Host-mscd_session` | After a successful sign-in | Keeps the person signed in. The server stores only a hash of the value | Until the browser closes, or up to 12 hours with "Keep me signed in". The server ends the session after 60 minutes without activity or 8 hours in total (guests: 30 minutes and 4 hours) |
| `mscd_auth_tx` | When sign-in through the customer's own provider (OpenID Connect) starts | Ties the provider's answer to the same browser | 10 minutes, removed after use |
| `mscd_saml_tx` | When sign-in through a SAML provider starts | Same purpose, for SAML providers | 10 minutes |
| `mscd_guest_tx` | When a guest auditor asks for a one-time code | Ties the code to the same browser | 10 minutes |
| `mscd_repo_tx` | When an administrator connects a Microsoft 365 or Google Drive repository | Ties the provider's consent answer to the same browser | 10 minutes |

Browser storage:

- The sign-in pages keep three short values in the tab's session storage (`mscd.auth.returnTo`, `mscd.auth.step`, `mscd.auth.reauth`): the page to return to and the current sign-in step. The browser removes them when the tab closes.
- The sign-in page remembers the last organisation slug in local storage so the person does not type it again (built, M2-S11).
- Fonts are served by MSCD itself. The optional Google Fonts links are off unless `MSCD_EXTERNAL_FONTS=true`, which stays off on SaaS.
- When a person signs in through the customer's own provider (for example Microsoft Entra ID), that provider sets its own cookies on its own address, under the customer's agreement with that provider.

## Recipients and subprocessors

| Recipient | What it receives | Why | Location |
|---|---|---|---|
| Server host (VPS provider) | Everything on the production server: database, vault files, logs, secrets | Runs the service | Indonesia by default (decision D-S2). The owner names the provider and city |
| Backup storage provider (S3-compatible bucket) | Encrypted backups of the database, vault files and secrets | Off-site recovery | A second provider, in Indonesia when available (D-S2). The owner names it |
| Mail provider (transactional SMTP, for example Amazon SES, Mailgun, Brevo or Postmark) | Recipient address and name, subject and text of every email | Sends invitations, reminders, security notices and alerts | Depends on the provider and region the owner picks |
| GitHub (Microsoft) | Source code, release images, encrypted repository secrets (including the keys that unlock the data), workflow logs and job summaries with operator command output, and, during the weekly restore test, a full copy of the latest database backup. The repository is public today, so its workflow logs and job summaries can be read by anyone | Builds and signs releases, runs approved deploys and operator commands, tests restores | United States and other countries (GitHub-hosted runners) |
| Heartbeat service (for example healthchecks.io) | Pings from the server with no personal data | Alerts the owner when the server stops reporting | Depends on the service the owner picks |
| External uptime check | Answers of the public health address, with no personal data | Alerts the owner when the site is down | Depends on the service |
| Telegram (optional) | Alert texts: alert names, server and organisation ids, with no names or emails | Alerts the owner on a phone | Telegram's servers, abroad |
| Let's Encrypt | The host name of the service | Issues the TLS certificate | United States |
| Penetration test vendor | Access to the staging server with test accounts and test data only | Independent security test | The vendor's country |
| The customer's own Microsoft 365, Google Drive or sign-in provider | Files and sign-in requests, when the customer connects them | The customer's choice, under the customer's own contract with that provider | The customer's tenant |

The customer's own providers in the last row are chosen and contracted by the customer. MSCD connects to them only on the customer's instruction.

## Data locations

| Data | Where it is | Country |
|---|---|---|
| Live database, vault files, logs, metrics and secrets | Production server, Docker data on its block volume | Indonesia by default. Owner fills in: `____` |
| Off-site backups | Backup bucket | Owner fills in: `____` |
| Pre-deploy database copies (last 3) | Production server | Same as the server |
| Staging server | Test organisations and test data only. Production data is never copied there | Owner fills in: `____` |
| Weekly restore test copy | GitHub-hosted runner, removed when the job ends | Outside Indonesia |
| Operator command output, workflow logs | GitHub | Outside Indonesia |
| Emails in transit and the provider's delivery logs | Mail provider | Owner fills in: `____` |
| Offline copies of the encryption keys | The owner's password manager | Owner fills in: `____` |

## Retention

The full table is in [records-of-processing.md](records-of-processing.md#retention-periods). In short:

- Accounts, memberships, business records and files stay while the organisation exists. Deleting a record marks it deleted and keeps it, until a disposal under a retention rule (below) or the deletion of the whole organisation.
- **Retention rules for records (built, Milestone 3).** Each management system keeps a retention period for eight kinds of record (36 months by default, one certification cycle); other records have no retention period in MSCD yet ([records-of-processing.md](records-of-processing.md#retention-periods) lists them as a gap). When the period ends, a Management System Manager decides to keep, extend or dispose of the record, and a second person approves a disposal. A disposal really deletes the record's content (product owner decision of 2 November 2026): it deletes the file content held in the Managed Vault unless another live record still uses the file, clears the record's text and personal details, redacts its audit entries under an attestation (every value inside them is cleared; the record's code, its type and id, the action, who did it and when stay, and the audit chain still verifies), leaves the record out of every organisation export and personal data copy, and asks the owner to delete files kept in the customer's own Microsoft 365 or Google Drive. Only its line in the disposal register stays, showing what happened and why. An evidence pack built before the disposal keeps its copy of the record until the pack itself is disposed of under its own retention period. Records under a legal hold are never disposed of.
- The audit log and audit trail are kept for the life of the organisation, with personal values removed by attested redaction when a person is erased, when a record is disposed of after its retention review, or when the organisation is deleted (question 7).
- Ended sessions, with their network address and browser, are deleted 90 days after they end. Used or expired invitations and password reset tokens are deleted 30 days after use or expiry. Read in-app notifications are deleted 365 days after reading, except those a reminder record refers to. These periods are profile values the provider can change.
- Export files, organisation exports and personal data copies are deleted when their download period ends (7 days; a final export when the organisation closes).
- Logs on the server rotate by size (20 MB times 10 files per service). Metrics are kept 30 days.
- **After a contract ends (built, Milestone 3):** 30 days read-only with the final export, then the organisation closes by itself, and 30 days later MSCD deletes it for good. The operator may move the deletion date when the customer asks in writing, but never to less than 7 days after closing, and the Tenant Admins are emailed 7 days and 1 day before each date.
- **Backups, in honest words.** Deleting an organisation, a person or a record does not reach into the backups at once. The off-site backups keep 14 daily, 8 weekly and 12 monthly copies (D-S6), so the last monthly copy that holds deleted data leaves the backup set about 12 months after the deletion. The backup bucket also keeps old versions of removed backup files: with the setting `backup-restore.md` recommends, versioning with a lifecycle rule that removes old versions after 400 days, the last copy is gone at the latest about 12 months, plus 7 days, plus 400 days after the deletion: about 26 months. The deletion certificate states this end date as the deletion date plus the profile value `lifecycle.backup_copies_end_days` (780 days by default), names the bucket settings it assumes, and says the date holds only while the bucket keeps them. The owner still has to confirm the real versioning, lifecycle rule or object lock of the production bucket (an open owner question of Milestone 3); with object lock or another lifecycle period the end date moves, and without a lifecycle rule old versions never leave the bucket. MSCD never promises that deleted data leaves the backups at once. The backups are encrypted, kept at a second provider and used only to rebuild the service after a disaster and by the weekly restore test. When the service is rebuilt from a backup older than a deletion, the operator runs the deletion again from the certificates before anyone uses the service ([backup-restore.md](backup-restore.md#deleted-organisations-and-the-backups)), and erases again every person whose erasure receipt is newer than the backup ([backup-restore.md](backup-restore.md#erased-people-and-the-backups)). A restore from a backup older than a disposal brings that record's content back: disposals have no receipt yet, so the Management System Managers approve the disposal again; receipts for disposals come before the production go-live (GL-69).

## Security measures for the DPA annex

| Area | Measures | Built |
|---|---|---|
| Encryption in transit | HTTPS only with HSTS. Certificates from Let's Encrypt renewed by Caddy. Mutual TLS between the application and the storage gateway | built (HSTS and Caddy: M2-S02) |
| Encryption at rest | Vault files encrypted per file with AES-256-GCM. TOTP secrets, SSO client secrets and drive credentials sealed with a key-encryption key kept outside the database. Passwords hashed with argon2id. Session ids, invitation and reset tokens and recovery codes stored only as hashes. Backups encrypted before they leave the server | built (backups: M2-S07) |
| Separation of customers | One database schema per organisation, row-level security bound to the organisation, checks on every request, tests that try to cross between organisations | built (multi-tenancy tests: M2-S13) |
| Access control | Roles per management system and per organisation (build plan F.6), owner-only rows, time-limited guest access for auditors, a second administrator must approve grants to administrators | built |
| Sign-in | MFA for every account, account and second-factor locks after repeated failures, limits per address and per email, sessions that end after inactivity, email notice of every security change | built |
| Audit | Hash-chained audit trail and audit log, signed anchors kept outside the database, every refused access and every auditor read recorded | built |
| Web security | Content-Security-Policy, frame blocking, no referrer, file downloads sandboxed and sent with safe types, upload size limit, rate limits at the front | built (front rate limits: M2-S02) |
| Server | Key-only SSH for named accounts, root login off, firewall, fail2ban, automatic security updates, only the TLS front reachable from the internet | built (M2-S02, M2-S03) |
| Software supply chain | Signed release images, verified at deploy, scans for known holes and leaked secrets (Trivy, CodeQL, gitleaks, OSV), pinned workflow actions, development keys refused in releases | built (M2-S01, M2-S05) |
| Change control | Production changes only through an approved GitHub workflow, with staging first and automatic rollback | built (M2-S05) |
| Availability and recovery | Nightly off-site backups, a weekly restore test with the restore time measured, a restore runbook for a new server | built (M2-S07); the owner installs the backup timer after the first deploy and confirms the bucket settings (GL-27) |
| Monitoring | Alerts for outages, errors, broken audit chain, sign-in and access-denied spikes, disk, certificates and backup age; an outside heartbeat | built (M2-S08) |
| People and process | Named operators with TOTP, incident procedure with notice templates, penetration test before go-live, requests from people answered on screen by the customer with due times and reminders | Operators with TOTP built; incident procedure written (M2-S04); penetration test open until go-live (GL-24); request screens built (M3-04) |
| End of contract | Read-only period with a final export in open formats and SHA-256 fingerprints, verified deletion of the organisation with checks, a signed deletion certificate that can be checked offline, and a re-run of the deletion after any restore from an older backup | built (M3-02, M3-03) |

## End of contract and what is not built yet

- **End of contract (built, D-S5, M2-S09 and M3-03):** the operator moves the organisation to `offboarding`. For 30 days its users can sign in, read and export, and cannot change anything. The final export of the whole organisation is prepared at once, and the Tenant Admins are reminded 7 days and 1 day before the end. Then MSCD moves the organisation to `archived` by itself: every session ends and nobody can sign in to it. Users who belong to other organisations keep those.
- **Exports available (built):** the full organisation export in open formats with a manifest of SHA-256 fingerprints (M3-02), the statement of applicability, the readiness and portfolio reports, the document register, the audit trail export (for Management System Managers), evidence packs, and each person's own data.
- **Deletion (built, M3-03):** 30 days after the organisation closed, MSCD deletes its database schema with every record, its vault files, its data key and the accounts that belonged to it only, removes the personal values from the provider's audit entries about it, checks that nothing is left, and issues a deletion certificate signed with the service's audit key. Anyone who has the checking tool and the public anchor key can check the certificate offline: the tool is the command `mscd-server tenant verify-certificate` of the MSCD release (the provider runs it for the customer, or gives the customer's IT team the release image), and the public anchor key is the one built into that release or the `audit-anchor.pub` file the provider hands over with the certificate. The check proves that the provider signed this text and that nobody changed it since; the certificate is the provider's own statement about the deletion, and no third party has checked it. The certificate lists what remains and why: the organisation's name and slug with its status history (so the slug is never reused and the certificate can name the customer), the redacted audit entries, the signed audit anchors (no personal data), the files in the customer's own Microsoft 365 or Google Drive, which belong to the customer, and the backups until the end date of [Retention](#retention).
- **Requests from one person (built, M3-04):** the screens of question 13.
- **Not built yet:**
  - removing deleted data from the backups before the backups age out, and a key-encryption key per organisation that would make destroying the key effective at once (both come with cloud key management, below);
  - cloud key management for the encryption keys (the keys are files on the server with offline copies);
  - a central log store and SSH session recording;
  - emergency (break-glass) access with a second approver, which the go-live checklist records as a decision;
  - changing the email address of an account (the customer invites the new address, hands over the records and disables the old membership).

## Laws this pack refers to

The lawyer confirms the current text of each law and any implementing regulation issued after these notes were written.

| Law | What this pack uses it for |
|---|---|
| Law No. 27 of 2022 on Personal Data Protection (Undang-Undang Nomor 27 Tahun 2022 tentang Pelindungan Data Pribadi, UU PDP). In force since 17 October 2022; the two-year adjustment period of Article 74 ended in October 2024 | General and specific personal data (Article 4), bases for processing (Article 20), record of processing (Article 31), impact assessment (Article 34), security (Article 35), written breach notice within 3 x 24 hours (Article 46), processors (Article 51), data protection officer (Article 53), transfer outside Indonesia (Article 56), administrative sanctions (Article 57), the institution set by the President (Article 58) |
| Government Regulation No. 71 of 2019 on the Operation of Electronic Systems and Transactions (PP 71/2019), with the ministry rules for private-scope electronic system operators | PSE Lingkup Privat registration through OSS |
| Law No. 24 of 2009 on the Flag, Language, State Emblem and National Anthem | Indonesian language in agreements with Indonesian parties (terms of service, DPA) |
| Sector rules of customers (for example OJK rules for financial institutions) | Data location needs of some customers |
