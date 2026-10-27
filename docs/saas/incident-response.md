# Incident response plan: MSCD SaaS

**Draft for legal review by a lawyer qualified in Indonesian law. Not legal advice.** The deadlines, the notice contents and the authority that receives notices must be confirmed by that lawyer before go-live (go-live checklist GL-47 and GL-65).

This plan is for the provider of the MSCD SaaS service (`<legal name of the company that runs MSCD SaaS>`). Use it for every security incident, every suspected personal data breach (UU PDP calls it a "failure of personal data protection", *kegagalan Pelindungan Data Pribadi*) and every major outage. Incident records hold personal data, so keep the incident log and evidence outside this repository, in the provider's protected document storage.

## Deadlines

| Clock | Deadline | Who | Basis |
|---|---|---|---|
| Provider tells each affected customer | Within 24 hours of becoming aware | Provider | The DPA (go-live checklist GL-42) |
| Customer gives written notice to the people affected and to the authority | At the latest 3 x 24 hours | The customer as controller, with the provider's help when asked | UU PDP Article 46(1) |
| What the written notice holds | At least: the personal data disclosed; when and how it was disclosed; the steps to handle it and to recover | The customer | UU PDP Article 46(2) |
| Notice to the public | In certain cases | The customer | UU PDP Article 46(3) |

The lawyer confirms when the 3 x 24 hours start. Until then, plan as if they start when the provider first knows about the incident, and write that time in the incident log at once. The lawyer also confirms which authority receives notices today (UU PDP Article 58 leaves its set-up to the President).

## Roles and contacts

This repository is public, so the names, phone numbers and personal email addresses of the people below never go into it. The owner keeps them in the provider's **incident contact list**, in the provider's protected document storage next to the incident log. Each person in a role also keeps an offline copy (printed, or in a password manager), so the list can still be reached when the server, the mail or the usual accounts are down. The owner checks the list every 6 months and after every change of staff, and writes the date of the check in the go-live checklist (GL-37).

| Role | What the role does | Who can hold it |
|---|---|---|
| Incident lead | Sets the severity, calls the team, approves every notice and the closing of the incident | The owner, unless the contact list names someone else |
| Technical lead | Preserves evidence, investigates, contains and restores | A named server administrator |
| Communications lead | Writes the customer notices and the status page updates, keeps contact with the customers' administrators | A named person who knows the customers |
| Legal adviser | Reviews notices and advises on the duties of Article 46 | A lawyer qualified in Indonesian law |
| Scribe | Keeps the incident log with times in WIB and UTC | Anyone in the team who is not leading |

The contact list names one person and one deputy for each role.

AI agents may help analyse logs that the technical lead has exported to the build host. They never connect to staging or production, and never hold their secrets (rule S-1 of the plan).

The contact list also holds these entries:

| Entry | Notes |
|---|---|
| 24/7 incident phone | A number someone answers at any hour, for example a shared on-call phone. It is given to customers in the DPA or the support terms |
| Support email | A shared role address such as `support@<domain>`, not a personal mailbox |
| Address for security reports from outsiders | `security@<domain>` (to set up), forwarded to the incident lead and the technical lead |
| Lawyer | Name, firm, phone and email |
| Server host support | Support address and the account reference |
| Backup storage provider support | Support address and the account reference |
| Mail provider support | Support address and the account reference |
| Penetration test vendor | Vendor lead and phone, agreed at booking |
| Authority for breach notices | To be confirmed by the lawyer |

## Severity levels

| Level | Meaning | Examples | Response |
|---|---|---|---|
| SEV-1 Critical | Customer personal data exposed or likely exposed, data of one organisation reached by another, data lost, or the service down for everyone | Access across organisations, server compromise, a leaked key-encryption key or backup credential, ransomware, a deleted backup bucket | Incident lead on duty within 15 minutes at any hour; customer notice within 24 hours |
| SEV-2 High | A serious weakness or a partial outage with no sign of exposure yet | Alert on a spike of refused access or second-factor locks from one address, the broken audit chain alert, a critical hole in a deployed image with a public exploit, one customer unable to sign in, a single account that may be taken over | Within 1 hour at any hour |
| SEV-3 Medium | Limited effect with a workaround | One missed nightly backup, a certificate that expires in under 14 days, slow pages for one organisation | Within 4 working hours |
| SEV-4 Low | No effect on customers | A failed job that retried fine, a scan finding without a fix yet | Normal work |

Any incident that may touch personal data starts at SEV-2 or higher until the assessment shows otherwise.

Where alerts come from: the alert rules of `docs/saas/monitoring.md` (M2-S08, including spikes of `mscd_authz_denied_total` and `mscd_mfa_locks_total`, the early signs of a breach), the external heartbeat and uptime checks, customers and users, outside security reports, the penetration test vendor and GitHub security alerts.

## Steps

1. **Open the log.** Start an incident log (template below). Write the time the provider first knew, in WIB and UTC.
2. **Set the severity** within 30 minutes, and call the roles the level needs.
3. **Preserve evidence before changing anything.** Logs on the server rotate by size, and a deploy, rollback or container restart starts new containers with empty logs. So copy first, on the production server as the technical lead (the Compose files are those of the running release, `docs/saas/deploy.md`):
   ```bash
   D=/opt/mscd/logs/incident-<id> && sudo mkdir -p "$D"
   sudo docker compose <files of the running release> logs --no-color --timestamps --since <start time> > "$D/compose.log"
   sudo journalctl --since "<start time>" > "$D/journal.log"      # SSH sign-ins and system events
   sudo sha256sum "$D"/* > "$D/SHA256SUMS"
   ```
   When files or records may have been changed, also take a database copy to `/opt/mscd/backup/` the way the deploy script does (`pg_dump --format=custom`). It holds every organisation's data, so protect it like a backup.
4. **Contain.** Pick the smallest step that stops the harm, and log each one:
   - suspend the organisation from the operator console, which ends its sessions (M2-S09), or disable one account or membership;
   - reset a person's second factor (`ops.users.reset-mfa`);
   - rotate a credential: the gateway token (`mscd-server keys rotate-gateway-token`), the SMTP password, a backup key, a GitHub secret;
   - block an address with ufw;
   - roll back a release with `deploy-prod.yml` and `action=rollback` (only after step 3);
   - as a last resort, stop the `caddy` service so nothing reaches the site.
5. **Find the affected organisations and people** (next section). Write the list in the log.
6. **Notify.** Send template A to each affected customer within 24 hours, even when facts are still missing, and send updates as they come. When a customer asks, prepare templates B and C for it. Update the status page with template D.
7. **Recover.** Fix the cause, restore from the backup when needed (`deploy/backup/restore.sh`, M2-S07), and run the audit chain check (job `audit.verify-chain` from the operator console, or `GET /api/v1/admin/audit-trail/verify`).
8. **Review** within 10 working days: what happened, what worked, what to change. Each change becomes a follow-up with an owner. Close the log.

## Finding the affected organisations and people

| Source | What it shows |
|---|---|
| Platform audit log (`platform.audit_log`) | Sign-ins and failed sign-ins, account changes and operator actions, with time, organisation, account, network address, browser and request id |
| Organisation audit trail (`<organisation schema>.audit_trail`) | Every change to records, every file opened or downloaded (`file.opened`, `file.downloaded`), export and evidence pack downloads, reads by external auditors (`auditor.read`) and refused access (`authz.denied`) |
| Sessions (`platform.session`) | Network address and browser of every session, with start, last activity and end |
| Access logs of Caddy and NGINX | Every web request with client address, path, status and request id. The request id links a log line to its audit entry |

Run the queries as the technical lead on the production server. Open the database session with the Compose files of the running release (`docs/saas/deploy.md`, M2-S05), for example `sudo docker compose <files of the running release> exec postgres psql -U postgres -d mscd`. Set the variables first, for example `\set ip '203.0.113.7'`, `\set from '2026-11-02 00:00+07'`, `\set to '2026-11-03 00:00+07'` and `\set org 'alpha'`. The results show on screen. To keep a result as a file, write it on the host as in [records-of-processing.md](records-of-processing.md#read-only-queries-for-the-providers-part). Never use `\copy ... TO` or `\o` in this session: psql runs inside the database container, so the file would stay inside the container.

```sql
BEGIN TRANSACTION READ ONLY;

-- 1. Everything recorded at platform level from one address in the time window
SELECT occurred_at, organization_id, actor_user_id, actor_kind, action, entity_type, entity_code, request_id
FROM platform.audit_log
WHERE source_ip = :'ip' AND occurred_at BETWEEN :'from' AND :'to'
ORDER BY seq;

-- 2. Accounts with a session from that address
SELECT s.user_id, u.email, s.organization_id, s.auth_method, s.created_at, s.last_seen_at, s.revoked_at
FROM platform.session s JOIN platform.app_user u ON u.id = s.user_id
WHERE s.ip = :'ip' AND s.last_seen_at >= :'from'
ORDER BY s.created_at;

-- 3. Actions in an organisation by an account without an active membership there today:
--    no membership at all, an invitation never accepted, or a membership that is disabled or deleted.
--    stopped_at is when the membership last stopped being active (from its membership.updated entry).
WITH stopped AS (
  SELECT organization_id, entity_id AS user_id, max(occurred_at) AS stopped_at
  FROM platform.audit_log
  WHERE action = 'membership.updated'
    AND before_data->>'status' = 'active' AND after_data->>'status' <> 'active'
  GROUP BY organization_id, entity_id
)
SELECT a.occurred_at, a.organization_id, a.actor_user_id, a.action, a.request_id,
       m.status AS membership_status, m.deleted_at AS membership_deleted_at, s.stopped_at
FROM platform.audit_log a
LEFT JOIN platform.org_membership m ON m.user_id = a.actor_user_id AND m.organization_id = a.organization_id
LEFT JOIN stopped s ON s.user_id = a.actor_user_id AND s.organization_id = a.organization_id
WHERE a.occurred_at BETWEEN :'from' AND :'to' AND a.organization_id IS NOT NULL
  AND a.actor_kind = 'user'
  AND (m.user_id IS NULL OR m.status <> 'active' OR m.deleted_at IS NOT NULL)
ORDER BY a.seq;

-- 4. Files and exports read in one organisation, and refused access there
SELECT schema_name AS schema FROM platform.organization WHERE slug = :'org' \gset
SELECT occurred_at, actor_user_id, actor_kind, action, entity_type, entity_code, source_ip, request_id
FROM :"schema".audit_trail
WHERE occurred_at BETWEEN :'from' AND :'to'
  AND action IN ('file.opened', 'file.downloaded', 'export.downloaded', 'evidence_pack.downloaded', 'auditor.read', 'authz.denied')
ORDER BY seq;

-- 5. Members of an affected organisation, for the customer's own notice to its people
SELECT u.display_name, u.email, m.status, m.admin_roles
FROM platform.org_membership m
JOIN platform.app_user u ON u.id = m.user_id
JOIN platform.organization o ON o.id = m.organization_id
WHERE o.slug = :'org' AND m.deleted_at IS NULL
ORDER BY u.email;

COMMIT;
```

How to read query 3: a row with no membership (`membership_status` is empty) is a red flag. For a membership that is disabled, deleted or only invited, compare `occurred_at` with `stopped_at` and `membership_deleted_at`. An action after either time was made by a former member and is a red flag. An action before them is normal past work. A membership that was disabled and then enabled again within the window does not appear here: for a named account, read its `membership.updated` entries in `platform.audit_log` instead.

Access logs, from the copy made in step 3:

```bash
grep '203.0.113.7' /opt/mscd/logs/incident-<id>/compose.log     # every request from one address
grep 'rid=<request id>' /opt/mscd/logs/incident-<id>/compose.log  # the NGINX line of one audit entry
```

Give each customer only the list of its own people. The customer, as controller, decides whom to notify.

## Notice templates

Each template is a draft for the lawyer's review. Fill every `<...>` and remove lines that do not apply. Write times in WIB.

### A. To the customer (provider to controller)

**English**

> Subject: [MSCD] Security incident notice for `<organisation name>` (`<incident id>`)
>
> Dear `<name of the administrator>`,
>
> We are writing to tell you about a security incident in the MSCD service that may affect personal data your organisation keeps in MSCD. Under our data processing agreement, your organisation is the controller of this data and we act as your processor.
>
> - What happened: `<short description>`
> - When: it started on `<date and time>` and we became aware of it on `<date and time>`
> - Data that may be affected: `<categories, for example names and email addresses of users, evidence files of one management system>`
> - People who may be affected: `<number and groups>`
> - What we have done: `<steps to stop it and to recover>`
> - What we ask you to do: `<for example ask users to change their password, check the attached list>`
>
> Under Article 46 of Law No. 27 of 2022 (UU PDP), a controller must give written notice to the people affected and to the authority at the latest 3 x 24 hours. We can help you prepare these notices, and drafts are attached.
>
> We will send the next update by `<date and time>`.
>
> `<name of the incident lead>`, `<phone>`, `<email>`. Incident number: `<incident id>`.

**Bahasa Indonesia**

> Subjek: [MSCD] Pemberitahuan insiden keamanan untuk `<nama organisasi>` (`<nomor insiden>`)
>
> Yth. `<nama administrator>`,
>
> Kami menyampaikan pemberitahuan tentang insiden keamanan pada layanan MSCD yang dapat berdampak pada data pribadi yang disimpan organisasi Anda di MSCD. Berdasarkan perjanjian pemrosesan data pribadi, organisasi Anda adalah Pengendali Data Pribadi atas data tersebut, dan kami bertindak sebagai Prosesor Data Pribadi Anda.
>
> - Apa yang terjadi: `<uraian singkat>`
> - Kapan: dimulai pada `<tanggal dan jam>` dan kami mengetahuinya pada `<tanggal dan jam>`
> - Data yang mungkin terdampak: `<kategori data, misalnya nama dan alamat email pengguna, berkas bukti satu sistem manajemen>`
> - Orang yang mungkin terdampak: `<jumlah dan kelompok>`
> - Tindakan yang sudah kami lakukan: `<langkah untuk menghentikan dan memulihkan>`
> - Yang kami minta dari Anda: `<misalnya meminta pengguna mengganti kata sandi, memeriksa daftar terlampir>`
>
> Berdasarkan Pasal 46 Undang-Undang Nomor 27 Tahun 2022 (UU PDP), Pengendali Data Pribadi wajib menyampaikan pemberitahuan tertulis kepada Subjek Data Pribadi dan lembaga paling lambat 3 x 24 jam. Kami dapat membantu menyiapkan pemberitahuan tersebut, dan drafnya kami lampirkan.
>
> Kabar terbaru berikutnya kami kirim paling lambat `<tanggal dan jam>`.
>
> `<nama pimpinan penanganan insiden>`, `<telepon>`, `<email>`. Nomor insiden: `<nomor insiden>`.

### B. To the authority (prepared for the controller when it asks)

**English**

> To: `<authority confirmed by the lawyer>`
>
> Subject: Notice of a failure of personal data protection under Article 46 of Law No. 27 of 2022
>
> 1. Controller: `<name, address, contact person>`. Processor involved: `<legal name of the provider>`, which runs the MSCD service.
> 2. Personal data disclosed: `<categories, approximate number of records and of people>`
> 3. When and how the personal data was disclosed: `<when it started, when the controller became aware, how it happened>`
> 4. Steps to handle it and to recover: `<steps taken and planned>`
> 5. Notice to the people affected: `<date sent or planned, and how>`
> 6. Contact for questions: `<name, phone, email>`
>
> `<place and date>`, `<name and position>`, `<signature>`

**Bahasa Indonesia**

> Kepada: `<lembaga yang dikonfirmasi oleh penasihat hukum>`
>
> Perihal: Pemberitahuan kegagalan Pelindungan Data Pribadi berdasarkan Pasal 46 Undang-Undang Nomor 27 Tahun 2022
>
> 1. Pengendali Data Pribadi: `<nama, alamat, narahubung>`. Prosesor Data Pribadi yang terlibat: `<nama badan hukum penyedia>`, penyelenggara layanan MSCD.
> 2. Data Pribadi yang terungkap: `<kategori, perkiraan jumlah data dan jumlah orang>`
> 3. Kapan dan bagaimana Data Pribadi terungkap: `<kapan dimulai, kapan Pengendali mengetahuinya, bagaimana terjadinya>`
> 4. Upaya penanganan dan pemulihan: `<langkah yang sudah dan akan dilakukan>`
> 5. Pemberitahuan kepada Subjek Data Pribadi: `<tanggal dikirim atau rencana, dan caranya>`
> 6. Narahubung: `<nama, telepon, email>`
>
> `<tempat dan tanggal>`, `<nama dan jabatan>`, `<tanda tangan>`

### C. To the people affected (prepared for the controller when it asks)

**English**

> Subject: Important: a security incident involving your personal data
>
> Dear `<name>`,
>
> `<Name of the controller>` uses the MSCD service to run its ISO management system. On `<date>` we learned of a security incident in which some of your personal data may have been disclosed.
>
> - Which data: `<list>`
> - When and how: `<short description>`
> - What we have done: `<steps>`
> - What you can do: `<for example change your MSCD password and set up your authenticator app again>`. Be careful with messages that ask for your password or codes. MSCD never asks for them by email or phone.
>
> Questions: `<contact of the controller>`

**Bahasa Indonesia**

> Subjek: Penting: insiden keamanan yang melibatkan data pribadi Anda
>
> Yth. `<nama>`,
>
> `<Nama Pengendali>` menggunakan layanan MSCD untuk menjalankan sistem manajemen ISO-nya. Pada `<tanggal>` kami mengetahui adanya insiden keamanan yang dapat menyebabkan sebagian data pribadi Anda terungkap.
>
> - Data apa saja: `<daftar>`
> - Kapan dan bagaimana: `<uraian singkat>`
> - Tindakan yang sudah kami lakukan: `<langkah>`
> - Yang dapat Anda lakukan: `<misalnya mengganti kata sandi MSCD dan mendaftarkan ulang aplikasi autentikator>`. Berhati-hatilah terhadap pesan yang meminta kata sandi atau kode Anda. MSCD tidak pernah memintanya melalui email atau telepon.
>
> Pertanyaan: `<kontak Pengendali>`

### D. Status page update

| Language | Text |
|---|---|
| English | We are investigating a problem with `<sign-in / the service / file downloads>`. Next update by `<time>` WIB. |
| Bahasa Indonesia | Kami sedang menyelidiki gangguan pada `<proses masuk / layanan / pengunduhan berkas>`. Kabar berikutnya paling lambat pukul `<jam>` WIB. |

## Incident log template

Copy this into the provider's protected storage for each incident.

| Field | Value |
|---|---|
| Incident number | |
| Severity (and changes, with times) | |
| Provider first knew (WIB and UTC). The 24 hour and 3 x 24 hour clocks start here until the lawyer says otherwise | |
| Incident lead | |
| Organisations affected | |
| Personal data involved (yes, no, not known yet) | |
| Customer notices sent (organisation, time) | |
| Notices by customers under Article 46 (organisation, time, if known) | |
| Closed (date) and review date | |

| Time (WIB) | Time (UTC) | Who | What happened or was done | Evidence (file, hash, link) |
|---|---|---|---|---|
| | | | | |

| Decision | Made by | Time | Reason |
|---|---|---|---|
| | | | |

## Exercise script

Run this exercise once before go-live (go-live checklist GL-47), then once a year and after a big change to the service. It takes about 90 minutes, uses only the staging server, and every role takes part. Mark the log of the exercise with the word EXERCISE.

**Scenario.** Two test organisations, Alpha and Beta, are on staging. A Beta user's account is used to try Alpha's files.

| Time | What the facilitator says | What the team must do |
|---|---|---|
| Start | "The alert for refused access fired: 4,000 refused requests in 10 minutes from one address, made with a Beta account against Alpha's management system addresses." | Open the log, write the time, set the severity, call the roles |
| +15 minutes | "Among the refused requests, the access log shows three answers with status 200 for Alpha file downloads." | Preserve the evidence (step 3) on staging; run queries 1 to 4 on staging; decide whether personal data was disclosed |
| +35 minutes | "Alpha's administrator calls: a staff member heard that a salary review file leaked." | Contain: disable the Beta account and decide whether to suspend Beta; agree what to tell Alpha |
| +50 minutes | "It is now 20 hours since the alert." | Finish template A for Alpha; prepare templates B and C for Alpha with the three contents of Article 46(2) |
| +70 minutes | "A journalist emails the support address asking about a leak." | Agree who answers and what, with the legal adviser; update the status page text |
| +80 minutes | Close | Review: what was slow, what was missing, three or more changes with an owner each |

**Technical drill on staging.** The technical lead also runs every command of step 3 and every query of the section above against staging, and writes down how long each took and any query that failed.

**Passed when:**

- the severity was set within 15 minutes;
- the evidence was copied before any change;
- template A for Alpha was ready within the exercise (it stands for the 24 hour limit);
- templates B and C held the three contents that Article 46(2) asks for;
- the incident log was complete, with times in WIB and UTC;
- at least three changes were written down, each with an owner and a date.

Write the date and the result in the go-live checklist (GL-47).
