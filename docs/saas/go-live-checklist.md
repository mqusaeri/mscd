# MSCD SaaS go-live checklist

This list holds everything that must be true before the first paying customer uses the MSCD SaaS service. It covers security, operations, the Indonesian personal data protection law (UU PDP, Law No. 27 of 2022, in Indonesian "Undang-Undang Nomor 27 Tahun 2022 tentang Pelindungan Data Pribadi") and the legal documents. The order of the go-live steps is in [section K.7 of the Milestone 2 plan](../platform/MILESTONE-2.md#k7-order-of-going-live).

Every legal point in this list is general information. Each one needs the advice of a lawyer qualified in Indonesian law before go-live.

## How to use this list

Each area has one table. The columns mean:

| Column | Meaning |
|---|---|
| ID | `GL-nn`, never reused. A new row takes the next free number, so a table is not always in number order |
| Item | What must be true |
| Why it matters | The reason, in plain words |
| Who | `agent`: an AI agent can prove it on the build host or in CI. `owner`: it needs the owner, for example a purchase, a setting in GitHub, a lawyer, a vendor or a check on the real servers |
| Evidence | The command, CI job or document that proves the item |
| Status | `open`, `done` or `n/a` (not applicable, with the reason in the evidence column) |

Agents update agent rows through normal work packages (M2-S13 sets their status and evidence in wave 6). The owner updates owner rows. `<domain>` stands for the public host name of the service, for example `app.example.co.id`.

Three checks read this file:

| Command | Use |
|---|---|
| `node tools/scripts/check-golive.mjs docs/saas/go-live-checklist.md` | Every row has an id, who, evidence and a valid status, and every link to a repository file works. Runs in CI |
| `node tools/scripts/check-golive.mjs --agent-items-done docs/saas/go-live-checklist.md` | Also fails while any agent row is open (M2-S13) |
| `node tools/scripts/check-golive.mjs --require-done docs/saas/go-live-checklist.md` | Also fails while any row is open. Run it on the go-live day, then sign off below |

## Security

| ID | Item | Why it matters | Who | Evidence | Status |
|---|---|---|---|---|---|
| GL-01 | HSTS is on, and Caddy gets and renews the TLS certificates by itself | Browsers then always use an encrypted connection, and a certificate never expires by surprise | agent | `bash deploy/scripts/test/saas-stack.sh check` (HSTS header and Caddy certificate, M2-S02); CI job `saas-smoke` | open |
| GL-02 | The production certificate comes from the Let's Encrypt production service: `ACME_CA` points to the production directory, and the staging default of the first run is replaced | Browsers do not trust a staging certificate, so every customer would see a warning page | owner | `curl -svo /dev/null https://<domain>/healthz 2>&1 \| grep -i issuer` shows a Let's Encrypt issuer without the word STAGING | open |
| GL-03 | NGINX rate limits are on: sign-in 10 per second (burst 20), API 50 per second (burst 100), 50 connections per address, answered with 429 | Slows down password guessing and floods from one address | agent | `bash deploy/scripts/test/saas-stack.sh check` (429 answer, M2-S02) | open |
| GL-04 | Only Caddy publishes ports. The database, object store, api, worker and storage gateway have no public port | Nothing inside the stack can be reached from the internet except through the TLS front | agent | M2-S02 acceptance: `docker compose ... config --format json` lists ports for `caddy` only; `saas-stack.sh check` | open |
| GL-05 | Tenant isolation is proven with tenancy `multi`: one organisation cannot read or change the records, files or exports of another | Keeping customers apart is the core promise of a shared service. A leak between customers is a personal data breach | agent | `npm run test:int:saas -w @mscd/server` (CI job `int-saas`); step 5 of `npm run saas -w @mscd/smoke` (M2-S13) | open |
| GL-06 | MFA is required for every account: TOTP, or the MFA proof of the customer's own SSO provider | A stolen password alone is not enough to sign in | agent | `identity.local.mfa_required: true` in [saas.yaml](../../apps/server/profiles/saas.yaml); `npm run test:int -w @mscd/server -- test/int/identity` | open |
| GL-07 | Mail works on SaaS, and invitation and set-password links are only emailed. They are never shown on screen or printed by a command (`mail.required: true`) | A link shown on screen can reach the wrong person. Without mail nobody can join | agent | `npm run test:int -w @mscd/server -- test/int/onboarding` (409 `mail_required`, M2-06); mail check of `bash deploy/scripts/test/saas-rehearsal.sh` (M2-S05) | open |
| GL-08 | The sending domain has SPF, DKIM and DMARC records, and a test email from production passes all three | Without them, invitations and alerts land in spam or are refused | owner | Headers of a test email show `spf=pass`, `dkim=pass` and `dmarc=pass` | open |
| GL-09 | The release tools refuse development keys and demo images | Development keys are public. Anything signed with them can be forged by anyone | agent | M2-S01 acceptance (`saas-keys.sh` refuses a folder inside a git work tree and every id of `dev-key-ids.json`; `build-release-images.sh` refuses `-demo` names); `deploy/scripts/check-release-artefacts.sh` on both release images | open |
| GL-10 | The owner made the release key set with `deploy/scripts/saas-keys.sh` on the owner's own computer and stored it in the GitHub environments. No key file is in the repository, a chat or a shared drive | Whoever holds these keys can sign software or read every backup | owner | Section "Release key set" of [owner-inputs.md](owner-inputs.md) ticked; owner's confirmation in the sign-off table | open |
| GL-11 | `release.yml` signs the release images with keyless cosign and verifies both signatures right after signing, and `deploy-prod.yml` has a `cosign verify` step for both digests that runs before it deploys | Only images built by the project's own release workflow can run in production | agent | `node tools/scripts/check-workflows.mjs --saas --require-all`; `grep -n 'cosign verify' .github/workflows/release.yml .github/workflows/deploy-prod.yml` shows the verify steps with the `release.yml` certificate identity and the GitHub OIDC issuer (M2-S01, M2-S05) | open |
| GL-67 | The signature checks passed in real runs: the `release.yml` run of the go-live version and its staging run of `deploy-prod.yml` | A check that is written but never ran on the real images may be skipped or set up wrongly. These runs need the owner's approval and the real staging server, so an agent cannot prove them | owner | Links to both runs; each log shows `cosign verify` passing for the server and web digests | open |
| GL-12 | Every third-party GitHub Action is pinned to a full commit SHA, secrets reach steps only through `env`, and each workflow sets `permissions` | A changed third-party action, or a secret printed in a log, could take over the release path | agent | `node tools/scripts/check-workflows.mjs --saas --require-all` (CI job `saas-static`) | open |
| GL-13 | Security scans are clean: Trivy (images and configuration), CodeQL, gitleaks and OSV. Dependabot updates are on | Known holes and leaked secrets are found before attackers find them | agent | Latest run of `security-scan.yml` on the default branch is green with no open high or critical alert; `.github/dependabot.yml` exists (M2-S01) | open |
| GL-14 | Production deploys run only through `deploy-prod.yml`, and the GitHub environment `production` needs the owner's approval for every run | No change reaches customers without a person checking it first | owner | Settings, Environments, `production` shows the owner as required reviewer; section "GitHub settings" of [owner-inputs.md](owner-inputs.md) | open |
| GL-15 | SSH accepts only named accounts with keys: root login and password login are off, ufw allows only 22 (rate limited), 80 and 443, and fail2ban watches SSH | Closes the most common ways into a server | agent | `bootstrap-host.sh --render-only` and `--dry-run` checks (M2-S03 acceptance) | open |
| GL-16 | Bootstrap is done on staging and production, the bootstrap root key `BOOTSTRAP_SSH_KEY` is deleted from GitHub and from the owner's computer, and the host key line is set in `DEPLOY_SSH_KNOWN_HOSTS` | A left-over root key is a back door. A pinned host key stops a fake server from receiving the secrets | owner | Job summary of `bootstrap-prod.yml` for both targets; `gh secret list --env production --repo mqusaeri/mscd` shows no `BOOTSTRAP_SSH_KEY` | open |
| GL-17 | Automatic security updates are on for the server, and a "reboot needed" marker raises an alert | Most attacks use holes that already have a fix | agent | `unattended-upgrades` step of `bootstrap-host.sh` (M2-S03); reboot rule in `deploy/ops/prometheus/rules/` tested by promtool (M2-S08) | open |
| GL-18 | Every platform operator account belongs to a named person who signs in with TOTP, and the list of operators is written down | Operators can create, suspend and archive customer organisations | owner | `ops-cli.yml` run `create-operator` with the owner's own email (link); the operator list in the provider's protected storage (names stay out of this public repository), with the number of operators and the date of the list in the "Operator accounts" row of the recorded decisions below | open |
| GL-19 | The break-glass decision is recorded: whether anyone may open a customer's data in an emergency, and with whose approval | Operators cannot read customer data in the app today. Customers and the DPA need a clear answer | owner | "Break-glass access" row of the recorded decisions below | open |
| GL-20 | The audit chain and its signed anchors verify, and the anchor key on the server matches the key built into the release | The audit trail is evidence for customers and auditors. Any change to it must be caught | agent | Anchor checks of `saas-stack.sh check` (M2-S02) and `saas-rehearsal.sh` (M2-S05); `backup verify` in `restore-test.yml` (M2-S07) | open |
| GL-21 | The owner has offline copies of every key file that `saas-keys.sh` made (the production and staging `platform.key`, `storage.key` and audit anchor keys, and the pack, licence and bundle signing keys) in a password manager, and has opened them once to check they are readable | GitHub secrets cannot be read back, and losing a KEK (key-encryption key) makes every backup unreadable | owner | Owner's confirmation with date in the sign-off table (never the keys themselves) | open |
| GL-22 | Staging and production refuse the demo stack: demo images, the demo and test profiles and the demo files | The demo uses public development keys and sample people | agent | `saas-deploy.sh check-only` refusals "demo images are refused", "demo and test profiles are refused" and "demo files are refused" (M2-S05 acceptance) | open |
| GL-23 | The demo server of `deploy-demo.yml` (secrets `VPS_*`) is a different machine from staging and production | Keeps public demo keys and sample data away from customer data | owner | The `VPS_HOST` secret differs from the `DEPLOY_HOST` secret of `staging` and of `production` | open |
| GL-24 | The penetration test of staging is done, every high and critical finding is fixed and retested, and the summary letter is received | An outside tester finds what the project's own tests miss, and customers ask for the letter | owner | Vendor report and retest letter (reference and date); scope in [pentest-scope.md](pentest-scope.md) | open |
| GL-25 | Security headers are set on every page and API answer (Content-Security-Policy, nosniff, frame blocking, no referrer), and file downloads are sandboxed | Stops common browser attacks such as clickjacking and scripts hidden in uploaded files | agent | `npm run test:int -w @mscd/server -- test/int/security` (API answers and file downloads); `curl -sI --cacert /tmp/mscd-saas-test/caddy-root.crt https://localhost:18443/` on the stack of `saas-stack.sh up` shows `Content-Security-Policy` with `frame-ancestors 'none'` and `X-Frame-Options: DENY` (pages) | open |

## Operations

| ID | Item | Why it matters | Who | Evidence | Status |
|---|---|---|---|---|---|
| GL-26 | Off-site backups run every night at 02:00 UTC: the database dump, the vault files and the secrets folder, kept 14 daily, 8 weekly and 12 monthly (D-S6) | A fire, an attack or a mistake on the server must not lose customer data | agent | `bash deploy/backup/restore-test.sh --local` (M2-S07 acceptance); `mscd-backup.timer` | open |
| GL-27 | The backup bucket is at a second provider or region, has versioning or object lock, and the first scheduled backup has pinged its heartbeat | Backups at the same provider can be lost together. Object lock stops an attacker from deleting them | owner | Bucket settings (reference); heartbeat check "backup" green | open |
| GL-28 | A restore test passed in the last 8 days, and the measured restore time is written here | A backup counts only when a restore has worked. The restore time is what customers can be promised | owner | Latest `restore-test.yml` run (date and link) and the restore time from its job summary: `____ minutes` | open |
| GL-29 | The full restore onto a new server is written as a runbook and rehearsed | If the server is lost, it is rebuilt from the backup without guessing | agent | `deploy/backup/restore.sh` and `docs/saas/backup-restore.md` (M2-S07); `restore-test.sh --local` | open |
| GL-30 | Deploy, upgrade, automatic rollback and manual rollback are rehearsed | A bad release must be undone in minutes | agent | `bash deploy/scripts/test/saas-rehearsal.sh` (M2-S05 acceptance) | open |
| GL-31 | The go-live version runs on staging first, and the restore-test migration rehearsal with `target_version` has passed | Finds a slow or broken database change before customers feel it | owner | Staging run of `deploy-prod.yml` and `restore-test.yml` run with `target_version` (links and dates) | open |
| GL-32 | Every alert rule has a test: services down, 5xx errors, audit chain broken, licence days left, stuck jobs, sign-in lock and access-denied spikes, disk, memory, reboot, certificates, backup age and the watchdog | An alert that never fired in a test may not fire for real | agent | `promtool test rules` of `deploy/ops/prometheus/tests/alerts.test.yml`; `bash deploy/ops/test-ops.sh` (M2-S08 acceptance) | open |
| GL-33 | A test alert from production reached the alert email, and Telegram when it is set up | Proves the owner hears about a problem at night | owner | Date and time the test alert arrived | open |
| GL-34 | The external heartbeat and uptime checks are active: watchdog, backup and restore-test heartbeats, and an uptime check of `https://<domain>/healthz` | A server that is fully down cannot send an alert itself, so an outside service must notice | owner | The heartbeat service shows three green checks, and the uptime service shows its check green | open |
| GL-35 | A public status page is published | Customers can see an outage without calling | owner | Status page address: `____` | open |
| GL-36 | The uptime target (99.5 percent per month, announced maintenance excluded), the maintenance window (Sunday 22:00 to 24:00 WIB) and the support hours are published in the terms or the service description | Customers know what to expect, and the promise fits what one server can give | owner | Link to the published text; decision D-S7 and support hours in [owner-inputs.md](owner-inputs.md) | open |
| GL-37 | The incident roles are named, each with a deputy, and the 24/7 phone number is set | Someone must answer when a customer reports a breach at night | owner | The incident contact list in the provider's protected storage covers every role and entry of [incident-response.md](incident-response.md#roles-and-contacts). Names and numbers stay out of this public repository. Date the list was last checked: `____` | open |
| GL-38 | The first platform operator exists on production with the owner's email, and the operator console opens | Without an operator nobody can create customer organisations | owner | `ops-cli.yml` run `create-operator` on production (link) | open |
| GL-39 | The production server matches K.2 of the plan: Ubuntu 24.04 LTS, 4 vCPU or more, 16 GB RAM, Docker data on a separate block volume of 200 GB or more | A server that is too small, or a full disk, stops every customer at once | owner | `bootstrap-prod.yml` job summary; provider console | open |

## Personal data protection (UU PDP, Law No. 27 of 2022)

In most of the service the customer organisation is the controller (it decides why and how its people's data is used) and MSCD is the processor (it handles the data on the customer's instructions). The facts behind each row are in [legal-inputs.md](legal-inputs.md). Every row here needs the advice of a lawyer qualified in Indonesian law.

| ID | Item | Why it matters | Who | Evidence | Status |
|---|---|---|---|---|---|
| GL-40 | The privacy notice is published in Indonesian and English, and `LEGAL_PRIVACY_URL` is set so the sign-in page links to it | People must be told what is collected, why, for how long and what their rights are | owner | Public address of the notice; `curl -s https://<domain>/api/v1/system/profile` shows `legal.privacyUrl` | open |
| GL-41 | The sign-in page shows the privacy notice and terms links from `system.profile.legal` in both languages, and hides them when they are not set | The notice must be easy to find where the data is collected | agent | `npm test -w @mscd/web -- test/auth` and `e2e/api-only/sign-in-discovery.spec.js` (M2-S11) | open |
| GL-42 | The DPA is ready. It says the customer is the controller and MSCD the processor, MSCD tells the customer about a breach within 24 hours, and it lists the subprocessors, the security measures and what happens to the data at the end | The controller is answerable for its processors (Article 51), and customers will not sign without a DPA | owner | DPA template approved by the lawyer (version and date); facts in [legal-inputs.md](legal-inputs.md) | open |
| GL-43 | The records of processing are complete and reviewed by the lawyer | The law asks for a record of all processing (Article 31), and auditors and customers ask to see it | owner | [records-of-processing.md](records-of-processing.md) with the lawyer's review date | open |
| GL-44 | The draft records of processing and the facts for the lawyer are written from the code | The lawyer needs correct facts to write correct documents | agent | [records-of-processing.md](records-of-processing.md) and [legal-inputs.md](legal-inputs.md) (M2-S04) | done |
| GL-45 | The DPO decision is recorded: whether MSCD must appoint a data protection officer under Article 53, and who it is | Article 53 makes an officer mandatory in some cases, for example large-scale regular monitoring of personal data. A written decision shows the question was checked | owner | Lawyer's note or appointment letter (reference and date) | open |
| GL-46 | The breach procedure meets the written notice within 3 x 24 hours of Article 46, with notice templates in Indonesian and English and an incident log | A late or incomplete notice is itself a breach of the law | agent | [incident-response.md](incident-response.md) (M2-S04) | done |
| GL-47 | The lawyer has reviewed the breach procedure and templates and confirmed which authority receives notices today, and one exercise has been run with its result in the incident log | A procedure that was never tried fails under pressure | owner | Exercise date and incident log entry; lawyer's review date | open |
| GL-48 | The position on data location and cross-border transfer is written (Article 56). It covers the server, the backups, the mail provider, GitHub and the monitoring services | Personal data may leave Indonesia only with equal protection, binding safeguards or the person's consent | owner | Lawyer's note (reference and date) | open |
| GL-49 | The weekly restore test runs on a GitHub-hosted runner with a full copy of the production database. The lawyer accepts this, or the test moves to a runner in Indonesia | GitHub-hosted runners are outside Indonesia, so this is a cross-border transfer of customer data every week | owner | "Restore test location" row of the recorded decisions below; lawyer's note | open |
| GL-50 | Workflow logs and job summaries show no customer names, email addresses or other personal data, because the repository is public and anyone can read them. The other way is to make the repository private before go-live | Anything a workflow prints in a public repository is published to the whole internet | owner | "Repository visibility" row of the recorded decisions below; a review of the logs of one staging run each of `ops-cli.yml`, `deploy-prod.yml` and `restore-test.yml` | open |
| GL-51 | The PSE Lingkup Privat registration (private-scope electronic system operator) is done through OSS, as Government Regulation (PP) 71/2019 and the ministry rules require | An unregistered electronic system operator can be blocked in Indonesia | owner | Registration number and date | open |
| GL-52 | Retention periods are written for accounts, logs, backups and offboarding, together with the gaps that still need a feature | People must be told how long their data is kept, and data that is no longer needed must be deleted | agent | Retention section of [records-of-processing.md](records-of-processing.md#retention-periods) (M2-S04) | done |
| GL-53 | The approved retention periods appear in the privacy notice and the DPA | The written promise must match what the system does | owner | Sections of the published notice and of the DPA | open |
| GL-54 | A manual procedure answers requests from data subjects (access, correction, deletion, objection) until a feature exists (K.8) | People have the right to see, correct and delete their data, and the customer must answer within short deadlines | agent | [Manual procedure](records-of-processing.md#requests-from-data-subjects) (M2-S04) | done |
| GL-55 | The subprocessor list is published with the location of each one: server host, backup storage, mail provider, heartbeat and uptime services, GitHub, and Telegram when used | Customers must know and approve who else handles their data | owner | Public address of the list | open |
| GL-56 | Only essential cookies are used: the session cookie and the short sign-in binding cookies. There is no analytics or advertising, and external fonts stay off (`MSCD_EXTERNAL_FONTS=false`) | Cookies that are not essential, and requests to other sites, would need consent and a cookie banner | agent | Cookie list in [legal-inputs.md](legal-inputs.md#cookies-and-browser-storage); the page served by `saas-stack.sh up` contains no `fonts.googleapis.com` | open |
| GL-57 | The lawyer has decided whether a data protection impact assessment is needed (Article 34) | Processing with a high risk to people needs an assessment before it starts | owner | Lawyer's note (reference and date) | open |
| GL-58 | The DPA and the terms promise only what is built at the end of a contract: 30 days read-only (`offboarding`), then `archived`. A full export and a verified deletion are not built yet (K.8) | A promise of deletion that the system cannot keep is a legal risk | owner | Return and deletion section of the DPA | open |

## Legal documents the owner provides

Each document is drafted or reviewed by a lawyer qualified in Indonesian law. [legal-inputs.md](legal-inputs.md) holds the facts the lawyer needs.

| ID | Item | Why it matters | Who | Evidence | Status |
|---|---|---|---|---|---|
| GL-59 | Privacy notice in Indonesian and English | Tells users and customers what MSCD does with personal data | owner | Final text approved by the lawyer (version, date and where it is stored) | open |
| GL-60 | Data processing agreement (DPA) template for customers, with the security annex | The contract that makes MSCD the customer's processor | owner | Final template approved by the lawyer (version and date) | open |
| GL-61 | Terms of service in Indonesian and English, published, with `LEGAL_TERMS_URL` set | Law No. 24 of 2009 requires Indonesian in agreements with Indonesian parties | owner | Public address; `system.profile` shows `legal.termsUrl` | open |
| GL-62 | DPO appointment letter, or the written decision that no DPO is needed (Article 53) | Shows who handles personal data questions | owner | Letter or decision (reference and date) | open |
| GL-63 | Proof of the PSE Lingkup Privat registration | Customers and authorities may ask for it | owner | Registration certificate (reference and date) | open |
| GL-64 | Lawyer's note on data location and cross-border transfer (Article 56) | Decides where data may be kept and which transfers need safeguards or consent | owner | Note (reference and date) | open |
| GL-65 | Lawyer's confirmation of the breach notice duties (Article 46) and of the authority that receives notices today | The notice must reach the right authority in time | owner | Note (reference and date) | open |
| GL-66 | Penetration test summary letter from the vendor | Customers ask for proof of an independent test | owner | Letter (reference and date) | open |

## Recorded decisions

The owner writes each answer here. A decision without an answer keeps its default.

| Decision | Default | Answer | Date |
|---|---|---|---|
| Break-glass access: may anyone open a customer's data in an emergency, and who approves it | No break-glass access at go-live. Operators cannot read customer data in the app (K.8 of the plan) | | |
| Restore test location: GitHub-hosted runner, or a runner in Indonesia | GitHub-hosted runner with the KEK copies in environment `restore-test` (D-S12) | | |
| Repository visibility: keep `mqusaeri/mscd` public, or make it private | Public, as today. No workflow prints personal data or customer names (GL-50). A private repository needs a GitHub plan that offers required reviewers | | |
| Operator accounts: who holds the platform operator role. The names are kept in the provider's protected storage; write here only the number of operators and the date of the list | The owner only | | |
| Data location (D-S2) | Server in Indonesia, backup bucket at a second provider, also in Indonesia when available | | |
| Support hours | No default. The owner sets them before go-live | | |

## Sign-off

| Field | Value |
|---|---|
| Version going live | |
| `check-golive.mjs --require-done` passed on | |
| Release key set made outside the repository and offline copies checked (GL-10, GL-21) | |
| Owner's name | |
| Date | |
