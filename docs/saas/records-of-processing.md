# Records of processing: MSCD SaaS

**Draft for review by a lawyer qualified in Indonesian law. Not legal advice.** Every entry marked "the lawyer decides" or "to confirm" needs that review before go-live.

| | |
|---|---|
| Kept by | `<legal name of the company that runs MSCD SaaS>` (the provider), as processor for its customers and as controller for its own activities |
| Why this record exists | UU PDP (Law No. 27 of 2022) Article 31 asks for a record of all processing activities. The lawyer confirms how it applies to the provider as processor |
| Version | Draft 3, 2 November 2026: draft 2 (1 November 2026, package M3-11) updated after the ISO and UU PDP review of Milestone 3 (packages M3-13 and M3-14): disposals delete content, erasure receipts, the retention gaps and the same-day forwarding of requests |
| Reviewed by the lawyer | Name: `____` Date: `____` |
| Next review | After every release that changes what data is collected or where it goes, and at least once a year |

The facts behind each record, with the field names from the code, are in [legal-inputs.md](legal-inputs.md). The provider's contact for this record is the owner until the DPO decision is made (UU PDP Article 53, go-live checklist GL-45).

## Record 1: Account and sign-in data

| Field | Entry |
|---|---|
| Provider's role | Processor for the customer. Possibly controller of the shared sign-in account and its security data (legal inputs, question 1) |
| Purpose | Let invited people sign in safely, give each person the right access per organisation and management system, protect accounts from takeover |
| Possible basis (the lawyer decides, Article 20) | The customer's contract with the provider for the service; legitimate interest for account security |
| People | Customer staff, guest auditors, platform operators |
| Data | Email, display name, optional job title, generated handle, account status; password hash (argon2id); TOTP secret (encrypted) and hashed recovery codes; failed sign-in and second-factor counts and lock times; SSO link (provider and the person's id there); memberships, administrator roles and business roles; invitations (email, inviter, times); sessions (network address, browser description, times); language and screen preferences; guest grants (email, system, end date) |
| Specific personal data (Article 4) | None by design |
| Source | The customer's administrators (invitations), the person (password, second factor, preferences), the customer's own sign-in provider (person's id and verified email) |
| Recipients | The customer's Tenant Admins (their own organisation's members only); platform operators (member counts, and the person's email when resetting a second factor); mail provider (invitation and security emails); server host and backup storage provider |
| Location | Production server and off-site backups ([data locations](legal-inputs.md#data-locations)) |
| Retention | See [Retention periods](#retention-periods): accounts while they exist, anonymised when the person is erased in their last organisation or that organisation is deleted; ended sessions 90 days; used or expired invitations and reset tokens 30 days; sign-in events in the audit log for the life of the organisation, with personal values redacted at erasure and deletion |
| Safeguards | MFA for every account, hashed passwords and tokens, encrypted second-factor secrets, account and second-factor locks, rate limits, session timeouts, security emails on every change, separate memberships per organisation, audit log of every sign-in, a periodic access review of every membership, role and guest grant (every 3 months by default), each part of its report filed as evidence of ISO/IEC 27001 control A.5.18: each system's part in the evidence item named at its sign-off, and the organisation part (memberships, administrator roles and linked company sign-in, with the summary and the warnings of the review) in the item the Tenant Admin chooses when completing it |
| Transfer abroad | Mail provider when it is abroad; GitHub during the weekly restore test (legal inputs, question 5) |

## Record 2: Customer compliance content

| Field | Entry |
|---|---|
| Provider's role | Processor for the customer |
| Purpose | Run the customer's ISO programme: registers, risks, controls, documents register, audits, findings, corrective actions, management reviews, tasks and reminders |
| Possible basis (the lawyer decides, Article 20) | Decided by the customer as controller. For the provider: the contract with the customer |
| People | Customer staff named as owners, holders or assignees of records; people named in free text, for example contacts of interested parties or business associates who are individuals (ISO 37001) |
| Data | Record titles and descriptions, owners and assignees, due dates, status, decisions such as residual risk acceptance (who and when), due diligence results on business associates (country, bribery risk level, outcome), audit trail of every change with values before and after |
| Specific personal data (Article 4) | None by design. Free text can still hold it, for example notes about an alleged offence in a due diligence record (legal inputs, question 12) |
| Source | The customer's users |
| Recipients | Users of the same organisation according to their roles; external auditors for the audited system during their grant; server host and backup storage provider |
| Location | Production server and off-site backups |
| Retention | While the organisation exists. Deleting a record marks it deleted and keeps it for the audit trail. A retention rule for eight kinds of record (36 months by default; the others are a gap, see [Retention periods](#retention-periods)) leads to a disposal review with a second person's approval. The disposal deletes the record's content: its text and personal details are cleared, its audit entries are redacted under an attestation, it is left out of exports and personal data copies, and only its line in the disposal register stays. A person erased in the organisation shows under a pseudonym in every record. After a contract ends: 30 days read-only with the final export, then archived, then deleted with the whole database schema 30 days later (D-S5, Milestone 3 D.5) |
| Safeguards | One database schema per organisation with row-level security, role checks on every request, owner-only rows for some roles, classification limits for restricted and confidential items, hash-chained audit trail with attested redaction of personal values, read confirmation of policies (for MSCD users with a business role; other staff confirm another way), a disposal register |
| Transfer abroad | GitHub during the weekly restore test |

## Record 3: Evidence files and documents

| Field | Entry |
|---|---|
| Provider's role | Processor for the customer |
| Purpose | Keep the files that prove each control works and each document's approved versions, and give auditors the evidence they ask for |
| Possible basis (the lawyer decides, Article 20) | Decided by the customer. For the provider: the contract with the customer |
| People | Anyone named or shown in an uploaded file; the person who last changed a file in the customer's own drive |
| Data | File content in the Managed Vault; file name, folder, size, type, fingerprint, version, uploader and times; for files kept in the customer's Microsoft 365 or Google Drive, the same details plus the link and the name of the last editor as the drive reports it; evidence pack copies; exports (PDF, spreadsheet, CSV); organisation exports (every table, the audit trail and every vault file, in parts with SHA-256 fingerprints); copies of one person's data (JSON) |
| Specific personal data (Article 4) | Possible in file content, which MSCD does not read (legal inputs, question 12) |
| Source | The customer's users; the customer's drive |
| Recipients | Users of the organisation according to their roles; external auditors (pack copies only); the customer's drive provider when the customer connects it; server host and backup storage provider |
| Location | Managed Vault on the production server and off-site backups; files in the customer's own drive stay in the customer's tenant |
| Retention | While the record exists and after it is marked deleted, until a disposal under the retention rule removes the content from the Managed Vault (unless another live record still uses the file), or the organisation is deleted. An evidence pack built before a disposal keeps its copy until the pack itself is disposed of under its own period. Exports, organisation exports and copies of a person's data are deleted when their download period ends (7 days; the final export of a contract when the organisation closes). After a contract ends: the files stay readable for the 30 read-only days and go into the final export, then the purge deletes every vault object and the data key of the organisation 30 days after it closed; older encrypted backup copies remain until the end date on the deletion certificate. Files in the customer's own Microsoft 365 or Google Drive are never deleted by MSCD |
| Safeguards | Each vault file encrypted with its own key (AES-256-GCM) under keys kept outside the database, drive credentials encrypted, file type detected by the server, downloads sandboxed, upload limit of 100 MiB, every file opened or downloaded recorded in the audit trail, optional metadata minimisation for drive file names; a full organisation export needs the approval of a second Tenant Admin when the organisation has one at the moment of the request (decision H.2, kept by the product owner on 2 November 2026), every Tenant Admin and primary Management System Manager is told of each request and download, and the audit trail shows any change of the Tenant Admin roles next to the export |
| Transfer abroad | GitHub during the weekly restore test (a sample of vault files); the customer's drive when it is abroad (the customer's own choice) |

## Record 4: Notification emails

| Field | Entry |
|---|---|
| Provider's role | Processor for the customer. Controller for operator emails and possibly for account security emails (legal inputs, question 1) |
| Purpose | Tell people about invitations, reminders, due and overdue items, document reviews, audit date changes, warnings and changes to their own sign-in security |
| Possible basis (the lawyer decides, Article 20) | The customer's contract for the service; legitimate interest for security emails |
| People | Customer staff, guest auditors, platform operators |
| Data | Email address, name, organisation, message title and text in English and Indonesian (often with record titles), link to the app, one-time codes and sign-in links in account emails, delivery status and attempts |
| Specific personal data (Article 4) | None by design |
| Source | Generated by the service from records and events |
| Recipients | The person; the mail provider (SMTP relay) |
| Location | Production server (in-app notifications); the mail provider's systems while sending and in its delivery logs |
| Retention | Read in-app notifications 365 days after reading (unread ones stay until they are read or the organisation is deleted; those a reminder record refers to stay with that record); the notifications of a person erased in the organisation are deleted at the erasure; the mail provider's own log period (the owner fills in: `____`) |
| Safeguards | TLS to the mail provider (STARTTLS on port 587), SPF, DKIM and DMARC on the sending domain, links in emails expire (invitations 72 hours, password reset 30 minutes, guest codes 10 minutes) and work once, notifications only for members of the organisation |
| Transfer abroad | When the mail provider is abroad |

## Record 5: Logs and backups

| Field | Entry |
|---|---|
| Provider's role | Processor for the customer's audit trail and backups. Possibly controller of security and access logs (legal inputs, question 1) |
| Purpose | Keep the service secure and working, prove who did what, detect and investigate incidents, recover from loss |
| Possible basis (the lawyer decides, Article 20) | Legitimate interest in security and integrity; the customer's contract for backups and the audit trail |
| People | Everyone who uses the service or reaches its address |
| Data | Platform audit log and organisation audit trail (actor, action, record, changed values, network address, browser, request id); access logs (network address, time, path without sensitive values, status, referring page, browser); application logs without cookies, passwords or tokens; metrics per organisation id with no names; encrypted backups of the database, vault files and secrets |
| Specific personal data (Article 4) | Only what the backed-up content holds (records 2 and 3) |
| Source | Generated by the service |
| Recipients | Management System Managers and time-limited external auditors read the audit trail of their system; Tenant Admins read its metadata only; the provider's server administrators; backup storage provider; GitHub during the weekly restore test |
| Location | Production server; off-site backup bucket; GitHub-hosted runner for the length of the weekly restore test |
| Retention | See [Retention periods](#retention-periods): audit trail for the life of the organisation (personal values redacted at erasure and deletion), access logs rotate by size, metrics 30 days, backups until the end date of the deletion certificate (about 26 months after a deletion with the recommended bucket settings, which the owner confirms) |
| Safeguards | Redaction of secrets in logs and audit entries, hash chain with signed anchors, backups encrypted before leaving the server, separate credentials for the secrets backup, weekly restore test, off-site bucket at a second provider with versioning or object lock |
| Transfer abroad | GitHub-hosted restore test (a full copy of the latest database backup); the backup bucket when it is abroad |

## Record 6: Support and operator access

| Field | Entry |
|---|---|
| Provider's role | Controller for its operator and support activities; processor when it acts on a customer's instruction |
| Purpose | Create and manage customer organisations, answer support requests, run approved operator commands, handle incidents, forward requests from people to their organisation, run the end of a contract (final export, deletion date, deletion certificate) |
| Possible basis (the lawyer decides, Article 20) | The contract with the customer; legitimate interest for incident handling |
| People | Customer administrators and users who ask for help; platform operators; people affected by an incident or who make a request |
| Data | Organisation slug, name, status, plan, member count, verified domains and last sign-in; first administrator's email and name; the email of a person whose second factor is reset, with the reason; diagnostics archive (recent log lines with secrets removed, health data); support emails; incident log entries; the forwarding log of requests from people (date, organisation and request type, no details of the person); the status and sizes of organisation exports (never their content); deletion records and signed deletion certificates (no personal data apart from the organisation's name) |
| Specific personal data (Article 4) | None by design |
| Source | Customers, users, the service |
| Recipients | Platform operators; GitHub (job summaries and logs of operator commands, which can hold organisation names and invited emails, and which anyone can read while the repository is public: go-live checklist GL-50); the lawyer when an incident or request needs advice |
| Location | Production server (operator command logs and diagnostics archives in `/opt/mscd/logs`); GitHub; the provider's mailbox |
| Retention | Operator actions in the audit log for the life of the installation; operator command logs on the server 90 days and diagnostics archives 14 days, removed by the next operator command after that; GitHub workflow logs for the repository's log retention period (90 days by default, adjustable by the owner); the deletion record and certificate of a deleted organisation for the life of the installation (the certificate also stays in the operators' mailbox, because a restore from an older backup needs it); support emails, the incident log and the forwarding log as the provider decides (the owner fills in: `____`) |
| Safeguards | Named operators with TOTP, every operator action in the audit log, operators cannot read business records or files in the app, operator commands only through an approved workflow with an allow-list, owner approval for every production run |
| Transfer abroad | GitHub (job summaries and logs) |

## Retention periods

Times are what the code does today. "Gap" marks a place where data stays longer than it needs to. Milestone 3 closed the gaps of draft 1 (the full export and verified deletion of D.4 and D.5, the anonymisation of D.6, and the clean-up of sessions, tokens, notifications and export files of D.6.7); the column "Set by" names the package that built each period. The privacy notice and the DPA must describe the real behaviour, including the backups.

| Data | Kept for | Set by | Gap |
|---|---|---|---|
| Account (email, name, job title, status) | As long as the account exists. Disabling it keeps the row. When the person is erased in their last organisation, or that organisation is deleted, the account is anonymised: email `<handle>@erased.invalid`, name "Former user", job title, password, second factors, linked sign-ins and preferences removed; the empty row stays because records and audit entries refer to it | Built (M3-03, M3-04) | Changing the email address of an account is not built |
| Memberships and business roles | As long as the organisation exists. A removed role is marked deleted. An erasure removes the membership; the deletion of the organisation removes every membership row | Built (M3-03, M3-04) | |
| A person erased in an organisation (`erased_person`) | The pseudonym ("Former user 7F3A") that the organisation shows instead of the name, for the life of the organisation. A person invited again after an erasure rejoins with a fresh account; the pseudonym stays on the records from before the erasure | Built (M3-04) | |
| Business records | As long as the organisation exists. Deleting marks the record deleted. The deletion of the organisation drops its database schema with every record | Built (build plan C.1: soft delete; M3-03) | Only the eight kinds of the next row have a retention period |
| Records with a retention period: earlier document versions, earlier evidence files, evidence packs, audit events with a result, closed findings, closed corrective actions, closed management reviews and lapsed competence records | The period of the system's retention rule (36 months by default, one certification cycle), then a disposal review. An approved disposal deletes the content: the text and personal details of the record are cleared, its audit entries are redacted under an attestation (values cleared; action, actor and time kept; the chain still verifies), it is left out of organisation exports and personal data copies, the Managed Vault content of its files is deleted unless another live record uses the file, and only its line in the disposal register stays. Records under a legal hold are not disposed of | Built (M3-06, M3-13) | A restore from a backup older than a disposal brings the record's content back: disposals have no receipt yet, so the managers approve the disposal again; receipts come before the production go-live (GL-69) |
| Records without a retention period in MSCD: risks, interested parties and their contacts, business associates and their due diligence (personal data under ISO 37001), incidents, business impact analyses, and the last version of a withdrawn document | As long as the organisation exists | Not built | **Gap.** The customer keeps and disposes of them under its own procedure until MSCD covers them; the screen Retention and disposal says so |
| Retention rules, disposal reviews, holds and the disposal register | As long as the organisation exists: the register is the evidence of each disposal for the auditor | Built (M3-06) | |
| Vault files and evidence pack copies | As long as the organisation exists. A disposal deletes the content of the disposed record's files. The deletion of the organisation removes every vault object of it | Built (M3-03, M3-06) | Files in the customer's own drive are never deleted by MSCD; the disposal asks the owner to delete them |
| Export files and copies of a person's data | Download ends after 7 days; the next hourly clean-up deletes the stored file | Built (`EXPORT_RETENTION_DAYS`, M3-02) | |
| Organisation exports | 7 days after they are ready (`lifecycle.export_link_days`); the final export of a contract until the organisation closes; then the parts and the manifest are deleted | Built (M3-02) | |
| Sessions with network address and browser | The session ends after 60 minutes idle or 8 hours (12 hours with "Keep me signed in"; guests 30 minutes and 4 hours). The ended row is deleted 90 days after it ended (`privacy.session_retention_days`) | Built (M3-04) | |
| Sign-in and link transactions, SAML assertion ids | Removed every hour after they expire (10 minutes) | Built (`cleanup.expired`) | |
| Rate limit counters (network address, email) | Removed every hour after their window ends | Built (`cleanup.expired`) | |
| Repeat-request keys (idempotency) | 24 hours | Built (`cleanup.expired`) | |
| Invitations | Valid 72 hours; the row (email, inviter) is deleted 30 days after it was used, revoked or expired (`privacy.token_retention_days`) | Built (M3-04) | |
| Password reset tokens (hash only) | Valid 30 minutes; the row is deleted 30 days after use or expiry | Built (M3-04) | |
| Guest auditor access | 1 to 30 days, then closed; the guest account stays disabled | Built | **Gap.** The guest auditor account (email and name) has no end date and is never cleaned up after its last grant ends |
| In-app notifications | Read ones are deleted 365 days after reading (`privacy.notification_retention_days`), except those a reminder record refers to; unread ones stay | Built (M3-04) | |
| Read confirmations of policies | As long as the organisation exists; the closed register is filed as a file of an evidence item (one item per policy keeps each register in the evidence pack) | Built (M3-05, M3-14) | |
| Access reviews | As long as the organisation exists; each part of the report of a completed review is filed as evidence of ISO/IEC 27001 control A.5.18 (the systems' parts and the organisation part, with the summary), and the full report is also kept in the Managed Vault when the organisation has one | Built (M3-07, M3-14) | |
| Personal data requests | The request record, with the name and email as entered, stays as proof that the request was answered, for the life of the organisation | Built (M3-04) | The lawyer confirms how long (legal inputs, question 13) |
| Platform audit log and organisation audit trail | For the life of the installation or organisation. No entry is removed; personal values are redacted under an attestation when a person is erased or the organisation is deleted, and the values of a disposed record's entries are cleared. The organisation's audit trail goes with its schema at the deletion | Built (M3-03, M3-04, M3-13) | Needs the lawyer's view (legal inputs, question 7). **Gap.** The platform audit log keeps the network address and browser of every sign-in for the life of the installation, while ended sessions are deleted after 90 days; a scheduled redaction after a set period needs a period the lawyer confirms |
| Access and application logs on the server | Rotated by size: 20 MB times 10 files per service. The number of days this covers depends on traffic; measure it after the first month and write it here: `____ days` | Built (M2-S02) | |
| Server system journal | Up to 1 GB | Built (M2-S03) | |
| Metrics | 30 days (at most 8 GB) | Built (M2-S08) | |
| Off-site backups | 14 daily, 8 weekly and 12 monthly copies (decision D-S6), plus the old versions the bucket keeps: with versioning and the recommended lifecycle rule of 400 days, deleted data leaves the backups at the latest about 26 months after the deletion. The deletion certificate states the end date: the deletion date plus `lifecycle.backup_copies_end_days` (780 days by default) | Built (M2-S07, decision D-S6); certificate date built (M3-03) | The owner installs the backup timer after the first deploy (GL-27); until then no backup runs. The owner confirms the real bucket settings (versioning, lifecycle rule or object lock); without a lifecycle rule old versions never leave the bucket. Deleted data cannot be removed from backups before they age out |
| Pre-deploy database copies on the server | The last 3 deploys | Built (M2-S05) | |
| Restore test copy | Removed when the weekly GitHub job ends | Built (M2-S07, `restore-test.yml`) | |
| GitHub workflow logs and job summaries | The repository's log retention period (90 days by default) | GitHub setting | The owner may shorten it in Settings, Actions |
| Operator command logs and diagnostics archives on the server (emails and names of first administrators, organisation names, reasons) | Run logs 90 days, diagnostics archives 14 days; removed by the next operator command after that | Built (M2-S09, `saas-ops.sh`) | Removed only when a later command runs |
| Mail provider delivery logs | The provider's setting: `____` | Owner | |
| After a contract ends | 30 days read-only (`offboarding`, `lifecycle.offboarding_days`) with the final export; then `archived` by the hourly job `org.lifecycle`; then the deletion 30 days later (`lifecycle.deletion_grace_days`), which the operator may move when the customer asks in writing but never to less than 7 days after archiving (`lifecycle.deletion_min_grace_days`). What remains afterwards is listed on the deletion certificate: the organisation's name, slug and status history, the deletion record, the redacted platform audit entries and the signed audit anchors (no personal data), the files in the customer's own drive (the customer's), and the backups until the certificate's end date | Built (M2-S09, M3-02, M3-03) | |

## Requests from data subjects

Requests from people about their own data (to see, copy, correct, delete or restrict it, or to object to its processing; UU PDP gives these rights in its chapter on the rights of data subjects) are answered by the customer in MSCD itself since Milestone 3 (D.6, package M3-04). This section replaces the manual procedure of draft 1, under which the provider ran database queries for the customer: the provider no longer does that. **Draft for review by a lawyer qualified in Indonesian law.**

### Who answers

- The customer organisation is the controller. Its Tenant Admins record the request, check who is asking, decide and answer the person. Its Management System Managers check their own systems for the person.
- The provider is the processor. It forwards a request it receives and does not answer it.
- Each request gets a due time: the time it was received plus the profile value `privacy.request_due_hours`, 72 hours (3 x 24 hours) by default for every type. That value is a product default: no article in this repository is its source. The lawyer names the article and the deadline of each type and when the clock starts (question 13 of [legal-inputs.md](legal-inputs.md)), and the provider changes the profile value if needed. The daily job `privacy.deadlines` tells the Tenant Admins of every request due within 24 hours and of every overdue one, and the screens show the time left.

### A request that reaches the provider

1. On the day it arrives, reply that the person's organisation will answer, and forward the request to the Tenant Admins of that organisation, with the date and time the provider received it. Ask them to record that time as the time received when they record the request in MSCD, so the due time counts from then. Never confirm or deny that the person has an account in any other organisation.
2. Add one line to the forwarding log below. It holds the date and time received, the organisation and the type of request, and no details of the person.
3. Do nothing else. The provider runs no database query and changes no data for a request; the customer answers it in the app. If a Tenant Admin asks the provider for help, point them to the screens below.

### What the customer does in MSCD

A Tenant Admin records the request in **Personal data requests** (Administration): a member of the organisation, or a person without an account by name and email, what they ask for, when and how it arrived. For a request the provider forwarded, the time received is the time the provider received it. A member can also ask from **My account**, section "My data", which tells the Tenant Admins. For a copy or an erasure, MSCD opens one **system check** per management system for its primary Management System Manager (screen **Personal data checks**): it lists the records whose text names the person, links to the screen that edits each record, and links to Handover for the person's open items; the manager edits what must change and marks the check done with a note.

| Request | What the Tenant Admin does on screen | Result for the person |
|---|---|---|
| See or get a copy | "Prepare a copy of the data", then "Download the copy" after every system check is done, and send it through a channel agreed with the person. The JSON file (format `mscd-personal-data-v2`) holds the account fields this organisation sees, membership and roles, linked company sign-in, sessions and sign-in events in this organisation, audit entries where the person acted, the audit entries about the account, the membership and the business roles (action, record type, system and time, without values), the records the person holds, the mentions of the person in the records of every system (record kind, code, field and a short excerpt), read confirmations, competence records (not those disposed of), notifications and the person's requests; secrets and other people's data are left out. A member can download the same file in "My account" without a request | A copy within the deadline |
| Correct | "Correct name or job title" when the account belongs to this organisation alone; otherwise the person corrects them in "My account", because the account is shared. Text in records is corrected by the record owner or the Management System Manager | Correct data |
| Restrict or object | "Stop using the data": the membership is disabled, the person can no longer sign in to this organisation, gets no notifications and no new work there | Processing stops; records stay |
| Delete | "Erase personal data", after every system check is done and once the person holds no open items, confirmed with the word ERASE. Before it, the dialog shows how many audit entries change and any legal hold on records about the person. It cannot be undone | A member loses their roles and membership in this organisation; lists, records and audit entries show "Former user" with a short code instead of the account; the email and handle leave every audit entry of the organisation, and the name leaves the person's own entries and those of the records the managers edited for the request; when the person has no other organisation, the account is anonymised. For a person without an account, the email leaves every audit entry and the name leaves the entries of the records the managers edited for the request. Each erasure sends the operators and the Tenant Admins a signed erasure receipt that names no person, which the operator applies again after a restore from an older backup |

Each request is closed with the answer given to the person ("Close with the answer"), or refused or withdrawn with a reason. The steps taken stay with the request.

**What stays after an erasure, and why.** The organisation's records stay under the pseudonym, because they are its ISO evidence (who verified a control, who accepted a risk). The pseudonym is pseudonymised data, which stays personal data under UU PDP (legal inputs, question 7). Audit entries stay with action, time and record, without the person's network address, browser, email or name, because removing entries would break the integrity chain (legal inputs, question 7). Competence records about the person stay under the pseudonym until a disposal under retention deletes their content. An account the person still uses in another organisation stays, because that organisation holds it. The request record itself, with the name as entered, stays as proof that the request was answered; the lawyer confirms how long. The content of uploaded files, which MSCD does not search, and files in the customer's own drive stay as they are. Backups keep older copies until they age out ([Retention periods](#retention-periods)); after a restore from such a copy the operator applies the erasure receipts again, so the person is erased again under the same pseudonym ([backup-restore.md](backup-restore.md#erased-people-and-the-backups)).

**A person invited again after an erasure.** A person erased in an organisation who is invited there again later, for example when rehired, rejoins with a fresh account and membership (product owner decision H.13 of 1 November 2026). The erased account, its removed membership and the pseudonym stay as they were, so every record from before the erasure keeps the pseudonym, and the new account shows no link to it. When the erased account was anonymised, the same email address can be invited again. When the erased account is still used in another organisation, MSCD refuses an invitation of the same email address in this organisation and says why; the Tenant Admin invites the person with another email address, which gives the fresh account. Nothing is revived and nothing is linked.

MSCD makes no automated decision with a legal or similar effect on a person. Readiness scores rate the progress of controls and documents.

### Forwarding log

Copy this table into the provider's forwarding log (kept outside the repository). It holds no details of the person.

| Received by the provider (date, time WIB) | Organisation (slug) | Request type | Forwarded to the Tenant Admins, the same day (date, time WIB) | By |
|---|---|---|---|---|
| | | | | |

## Read-only queries for the provider's part

The provider runs no query for a person's request (see above). It runs read-only queries only for its own work, for example to find the affected organisations and people during an incident ([incident-response.md](incident-response.md#finding-the-affected-organisations-and-people)). These steps keep a query result as a file on the host. Run them as a named server administrator on the production server; agents never do (rule S-1 of the plan).

psql runs inside the `postgres` container. A file written from inside psql (with `\copy ... TO 'file'` or `\o file`) would therefore stay inside the container, where nobody checks or deletes it. The commands below send each result as CSV text to the administrator's shell on the host instead, and the shell writes it into a folder that only that administrator can read. Every query runs in a read-only transaction (`default_transaction_read_only=on`), so leave out the `BEGIN TRANSACTION READ ONLY;` line of the on-screen session.

1. Make a folder named after the incident, as in its log. `umask 077` makes the folder mode 0700 and every file in it mode 0600.

   ```bash
   umask 077
   mkdir -p ~/incidents/<incident number> && cd ~/incidents/<incident number>
   ```

2. Define a short helper. The Compose files are those of the running release (`docs/saas/deploy.md`, M2-S05). The helper passes its arguments to psql, so each query gets its variables with `-v`.

   ```bash
   query() {
     sudo docker compose <files of the running release> exec -T -e PGOPTIONS='-c default_transaction_read_only=on' postgres \
       psql -U postgres -d mscd -X -q --csv -v ON_ERROR_STOP=1 "$@"
   }
   ```

3. Run each query into one CSV file. The quotes around `'SQL'` stop the shell from changing the text, and psql fills in the variables such as `:'ip'`.

   ```bash
   query -v ip='203.0.113.7' -v from='2026-11-02 00:00+07' -v to='2026-11-03 00:00+07' > by-address.csv <<'SQL'
   SELECT occurred_at, organization_id, actor_user_id, actor_kind, action, entity_type, entity_code, request_id
   FROM platform.audit_log
   WHERE source_ip = :'ip' AND occurred_at BETWEEN :'from' AND :'to'
   ORDER BY seq;
   SQL
   ```

4. Open each file (for example `less by-address.csv`) and check that it holds only the rows the incident needs. Send a file only through an encrypted channel agreed with the receiver.
5. When the incident log is closed, delete the folder with `rm -r ~/incidents/<incident number>` and write the date in the incident log. Nothing was written inside the container, so nothing needs to be deleted there.

## Changes to this record

| Date | Change | By |
|---|---|---|
| 27 October 2026 | Draft 1 written from the code and the Milestone 2 plan | M2-S04 |
| 1 November 2026 | Draft 2 from the code of Milestone 3: retention of each record updated, the retention table with the gaps Milestone 3 closed and the new periods, the end of a contract with export and deletion, the backup statement with the end date of the deletion certificate, the request procedure replaced by the screens of the customer and the provider's forwarding log, the read-only query steps kept for incident use, and the periods built by Milestone 2 (logs, journal, metrics, pre-deploy copies, backups, restore test) marked built | M3-11 |
| 2 November 2026 | Draft 3 after the ISO and UU PDP review: a disposal deletes the content of a record (product owner decision 18); the eight kinds of record with a retention period, and the others, the guest auditor accounts and the network addresses of the platform audit log marked as gaps; each part of an access review filed as evidence; the erasure of a person without an account, erasure receipts and their re-apply after a restore; 72 hours named as a product default without a legal source; a forwarded request sent on the day it arrives, with the time the provider received it | M3-14 |
