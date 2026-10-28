# Records of processing: MSCD SaaS

**Draft for review by a lawyer qualified in Indonesian law. Not legal advice.** Every entry marked "the lawyer decides" or "to confirm" needs that review before go-live.

| | |
|---|---|
| Kept by | `<legal name of the company that runs MSCD SaaS>` (the provider), as processor for its customers and as controller for its own activities |
| Why this record exists | UU PDP (Law No. 27 of 2022) Article 31 asks for a record of all processing activities. The lawyer confirms how it applies to the provider as processor |
| Version | Draft 1, 27 October 2026, written from the code and the Milestone 2 plan (package M2-S04) |
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
| Retention | See [Retention periods](#retention-periods): accounts while they exist, sessions and sign-in history without an end date today |
| Safeguards | MFA for every account, hashed passwords and tokens, encrypted second-factor secrets, account and second-factor locks, rate limits, session timeouts, security emails on every change, separate memberships per organisation, audit log of every sign-in |
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
| Retention | While the organisation exists. Deleting a record marks it deleted and keeps it for the audit trail. After a contract ends: 30 days read-only, then archived (D-S5) |
| Safeguards | One database schema per organisation with row-level security, role checks on every request, owner-only rows for some roles, classification limits for restricted and confidential items, hash-chained audit trail |
| Transfer abroad | GitHub during the weekly restore test |

## Record 3: Evidence files and documents

| Field | Entry |
|---|---|
| Provider's role | Processor for the customer |
| Purpose | Keep the files that prove each control works and each document's approved versions, and give auditors the evidence they ask for |
| Possible basis (the lawyer decides, Article 20) | Decided by the customer. For the provider: the contract with the customer |
| People | Anyone named or shown in an uploaded file; the person who last changed a file in the customer's own drive |
| Data | File content in the Managed Vault; file name, folder, size, type, fingerprint, version, uploader and times; for files kept in the customer's Microsoft 365 or Google Drive, the same details plus the link and the name of the last editor as the drive reports it; evidence pack copies; exports (PDF, spreadsheet, CSV) |
| Specific personal data (Article 4) | Possible in file content, which MSCD does not read (legal inputs, question 12) |
| Source | The customer's users; the customer's drive |
| Recipients | Users of the organisation according to their roles; external auditors (pack copies only); the customer's drive provider when the customer connects it; server host and backup storage provider |
| Location | Managed Vault on the production server and off-site backups; files in the customer's own drive stay in the customer's tenant |
| Retention | While the record exists and after it is marked deleted. Export downloads end after 7 days; the stored export file is not removed yet |
| Safeguards | Each vault file encrypted with its own key (AES-256-GCM) under keys kept outside the database, drive credentials encrypted, file type detected by the server, downloads sandboxed, upload limit of 100 MiB, every file opened or downloaded recorded in the audit trail, optional metadata minimisation for drive file names |
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
| Retention | In-app notifications and their delivery status without an end date today; the mail provider's own log period (the owner fills in: `____`) |
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
| Recipients | MS Managers and time-limited external auditors read the audit trail of their system; Tenant Admins read its metadata only; the provider's server administrators; backup storage provider; GitHub during the weekly restore test |
| Location | Production server; off-site backup bucket; GitHub-hosted runner for the length of the weekly restore test |
| Retention | See [Retention periods](#retention-periods): audit trail for the life of the organisation, access logs rotate by size, metrics 30 days, backups up to about 12 months |
| Safeguards | Redaction of secrets in logs and audit entries, hash chain with signed anchors, backups encrypted before leaving the server, separate credentials for the secrets backup, weekly restore test, off-site bucket at a second provider with versioning or object lock |
| Transfer abroad | GitHub-hosted restore test (a full copy of the latest database backup); the backup bucket when it is abroad |

## Record 6: Support and operator access

| Field | Entry |
|---|---|
| Provider's role | Controller for its operator and support activities; processor when it acts on a customer's instruction |
| Purpose | Create and manage customer organisations, answer support requests, run approved operator commands, handle incidents and requests from data subjects |
| Possible basis (the lawyer decides, Article 20) | The contract with the customer; legitimate interest for incident handling |
| People | Customer administrators and users who ask for help; platform operators; people affected by an incident or who make a request |
| Data | Organisation slug, name, status, plan, member count, verified domains and last sign-in; first administrator's email and name; the email of a person whose second factor is reset, with the reason; diagnostics archive (recent log lines with secrets removed, health data); support emails; incident log and request log entries |
| Specific personal data (Article 4) | None by design |
| Source | Customers, users, the service |
| Recipients | Platform operators; GitHub (job summaries and logs of operator commands, which can hold organisation names and invited emails, and which anyone can read while the repository is public: go-live checklist GL-50); the lawyer when an incident or request needs advice |
| Location | Production server (operator command logs and diagnostics archives in `/opt/mscd/logs`); GitHub; the provider's mailbox |
| Retention | Operator actions in the audit log for the life of the installation; operator command logs on the server 90 days and diagnostics archives 14 days, removed by the next operator command after that; GitHub workflow logs for the repository's log retention period (90 days by default, adjustable by the owner); support emails and the incident and request logs as the provider decides (the owner fills in: `____`) |
| Safeguards | Named operators with TOTP, every operator action in the audit log, operators cannot read business records or files in the app, operator commands only through an approved workflow with an allow-list, owner approval for every production run |
| Transfer abroad | GitHub (job summaries and logs) |

## Retention periods

Times are what the code and the plan do today. "Gap" marks a place where data stays longer than it needs to because a clean-up does not exist yet. Each gap is a follow-up for a later package, and the privacy notice and the DPA must describe the real behaviour until it is fixed.

| Data | Kept for | Set by | Gap |
|---|---|---|---|
| Account (email, name, job title, status) | As long as the account exists. Disabling it keeps the row | Built | No deletion or anonymisation feature (K.8) |
| Memberships and business roles | As long as the organisation exists. A removed role is marked deleted | Built | |
| Business records | As long as the organisation exists. Deleting marks the record deleted | Built (build plan C.1: soft delete only) | No purge (K.8) |
| Vault files and evidence pack copies | As long as the organisation exists | Built | No purge (K.8) |
| Export files | Download ends after 7 days | Built (`EXPORT_RETENTION_DAYS`) | The stored file is not removed |
| Sessions with network address and browser | The session ends after 60 minutes idle or 8 hours (12 hours with "Keep me signed in"; guests 30 minutes and 4 hours). The ended row is kept | Built | Ended session rows are never removed |
| Sign-in and link transactions, SAML assertion ids | Removed every hour after they expire (10 minutes) | Built (`cleanup.expired`) | |
| Rate limit counters (network address, email) | Removed every hour after their window ends | Built (`cleanup.expired`) | |
| Repeat-request keys (idempotency) | 24 hours | Built (`cleanup.expired`) | |
| Invitations | Valid 72 hours; the row (email, inviter) is kept | Built | Old rows are never removed |
| Password reset tokens (hash only) | Valid 30 minutes; the row is kept | Built | Old rows are never removed |
| Guest auditor access | 1 to 30 days, then closed; the guest account stays disabled | Built | |
| In-app notifications | Kept | Built | No clean-up |
| Platform audit log and organisation audit trail | For the life of the installation or organisation. The hash chain breaks if rows are removed | Built | Needs the lawyer's view (legal inputs, question 7) |
| Access and application logs on the server | Rotated by size: 20 MB times 10 files per service. The number of days this covers depends on traffic; measure it after the first month and write it here: `____ days` | Planned (M2-S02) | |
| Server system journal | Up to 1 GB | Planned (M2-S03) | |
| Metrics | 30 days | Planned (M2-S08) | |
| Off-site backups | 14 daily, 8 weekly and 12 monthly copies, so a deleted item can stay in a backup for about 12 months | Planned (M2-S07, decision D-S6) | |
| Pre-deploy database copies on the server | The last 3 deploys | Planned (M2-S05) | |
| Restore test copy | Removed when the weekly GitHub job ends | Planned (M2-S07) | |
| GitHub workflow logs and job summaries | The repository's log retention period (90 days by default) | GitHub setting | The owner may shorten it in Settings, Actions |
| Operator command logs and diagnostics archives on the server (emails and names of first administrators, organisation names, reasons) | Run logs 90 days, diagnostics archives 14 days; removed by the next operator command after that | Built (M2-S09, `saas-ops.sh`) | Removed only when a later command runs |
| Mail provider delivery logs | The provider's setting: `____` | Owner | |
| After a contract ends | 30 days read-only (`offboarding`), then `archived`. The data stays in the database and backups | Built (M2-S09, decision D-S5): the operator moves the organisation to `archived` by hand at the end of the 30 days | No automatic move at the end of the 30 days; full export and verified deletion not built (K.8) |

## Requests from data subjects

This is the manual procedure until a feature exists (K.8 of the Milestone 2 plan). It covers requests to see, copy, correct, delete or restrict a person's data, or to object to its processing (UU PDP gives these rights in its chapter on the rights of data subjects). **Draft for review by a lawyer qualified in Indonesian law.**

### Who answers

- The customer organisation is the controller. It decides and answers the person. The provider helps the customer on its written instruction.
- UU PDP gives controllers short deadlines for several requests, for example 3 x 24 hours for access and correction requests. The lawyer confirms each deadline. The provider therefore finishes its part within 1 working day of the customer's instruction.
- Until the lawyer answers question 1 of [legal-inputs.md](legal-inputs.md) (the shared sign-in account), the provider handles account data as processor of each organisation separately.

### Steps

1. **A request reaches the provider directly** (for example at the support email). Within 1 working day, reply that the person's organisation will answer, and forward the request to the Tenant Admins of that organisation. Never confirm or deny that the person has an account in any other organisation.
2. **Check the instruction.** Act only on a written instruction from a Tenant Admin of the organisation, sent from the address MSCD knows for that admin, and confirmed by a reply or a call. The customer checks the identity of the person who asked.
3. **Log it.** Add a line to the request log below before doing anything else.
4. **Do the work** for the request type in the table below. A server administrator runs the provider's queries; agents never do (rule S-1 of the plan).
5. **Answer the customer** in writing with what was done, what data stays and why. Send files only through an encrypted channel agreed with the customer.
6. **Close the log line** with the date.

| Request | What the customer's administrators can do in MSCD | What the provider does |
|---|---|---|
| See or get a copy | Tenant Admin: the user list shows the person's name, email, status and roles. MS Manager: the audit trail export of each system shows the person's actions; the registers show the records the person owns | Runs the read-only queries below for the person's account, membership, sessions and sign-in events in that organisation, and sends the result as a CSV file |
| Correct | The owner of a record or an MS Manager edits record text. A Tenant Admin changes the display name and job title when the person has no other active membership | When the person has other memberships, the provider changes the name only after each organisation agrees. Changing an email address is not built: the customer invites the new address, reassigns the records and disables the old membership |
| Delete or anonymise | Tenant Admin: disable the membership and remove the business roles. MS Manager: reassign the records the person owns and edit free text that names the person. When the person has no other active membership, a Tenant Admin also disables the account and replaces the display name with a neutral text such as "Former user" and clears the job title | Tells the customer in writing what stays and why: the email address on the account (no change route yet), the audit trail entries (the hash chain and the ISO evidence depend on them), ended sessions, and backups for up to about 12 months. Full removal of an account is not built (K.8) |
| Restrict or object | Tenant Admin: disable the membership, which stops all processing for that organisation | Confirms that the membership is disabled and that no email goes to the person from that organisation |

MSCD makes no automated decision with a legal or similar effect on a person. Readiness scores rate the progress of controls and documents.

### Read-only queries for the provider's part

Run them as a named server administrator on the production server, only after steps 2 and 3. Try them first on staging with a test person.

psql runs inside the `postgres` container. A file written from inside psql (with `\copy ... TO 'file'` or `\o file`) would therefore stay inside the container, where nobody checks or deletes it. The commands below send each result as CSV text to the administrator's shell on the host instead, and the shell writes it into a folder that only that administrator can read. Every query runs in a read-only transaction (`default_transaction_read_only=on`).

1. Make the folder, named after the line of the request log. `umask 077` makes the folder mode 0700 and every file in it mode 0600.

   ```bash
   umask 077
   mkdir -p ~/requests/<request number> && cd ~/requests/<request number>
   ```

2. Set the person and the organisation, and define a short helper. The Compose files are those of the running release (`docs/saas/deploy.md`, M2-S05).

   ```bash
   EMAIL='person@customer.example'
   ORG='customer-slug'
   query() {
     sudo docker compose <files of the running release> exec -T -e PGOPTIONS='-c default_transaction_read_only=on' postgres \
       psql -U postgres -d mscd -X -q --csv -v ON_ERROR_STOP=1 -v email="$EMAIL" -v org="$ORG"
   }
   ```

3. Run the three queries. Each one writes one CSV file on the host. The quotes around `'SQL'` stop the shell from changing the text, and psql fills in `:'email'` and `:'org'`.

   ```bash
   # The account and the membership in the requesting organisation only
   query > account.csv <<'SQL'
   SELECT u.email, u.display_name, u.job_title, u.kind, u.status, u.created_at, u.last_login_at,
          m.status AS membership_status, m.admin_roles, m.accepted_at
   FROM platform.app_user u
   JOIN platform.org_membership m ON m.user_id = u.id
   JOIN platform.organization o ON o.id = m.organization_id
   WHERE lower(u.email) = lower(:'email') AND o.slug = :'org';
   SQL

   # Sessions in that organisation
   query > sessions.csv <<'SQL'
   SELECT s.created_at, s.last_seen_at, s.revoked_at, s.revoke_reason, s.auth_method, s.ip, s.user_agent
   FROM platform.session s
   JOIN platform.app_user u ON u.id = s.user_id
   JOIN platform.organization o ON o.id IN (s.organization_id, s.auth_org_id)
   WHERE lower(u.email) = lower(:'email') AND o.slug = :'org'
   ORDER BY s.created_at;
   SQL

   # Sign-in and account events recorded for that organisation
   query > events.csv <<'SQL'
   SELECT a.occurred_at, a.action, a.entity_type, a.source_ip, a.user_agent
   FROM platform.audit_log a
   JOIN platform.app_user u ON u.id = a.actor_user_id
   JOIN platform.organization o ON o.id = a.organization_id
   WHERE lower(u.email) = lower(:'email') AND o.slug = :'org'
   ORDER BY a.seq;
   SQL
   ```

4. Open each file (for example `less account.csv`) and check that it holds only that person's rows in that organisation. Then send the files through the encrypted channel agreed with the customer.
5. After the customer confirms receipt, delete the folder with `rm -r ~/requests/<request number>` and write the date in the request log. Nothing was written inside the container, so nothing needs to be deleted there.

### Request log

Copy this table into the provider's request log (kept outside the repository, because it holds personal data).

| Received (date, time WIB) | Organisation | Request type | Instruction from (Tenant Admin) | Done by | Answered to the customer | Closed |
|---|---|---|---|---|---|---|
| | | | | | | |

## Changes to this record

| Date | Change | By |
|---|---|---|
| 27 October 2026 | Draft 1 written from the code and the Milestone 2 plan | M2-S04 |
