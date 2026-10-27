# What the owner provides

This is the owner's checklist for sections K.2 and K.3 of the [Milestone 2 plan](../platform/MILESTONE-2.md#k2-what-the-owner-provides). AI agents cannot buy, sign, register or approve any of these items. Each item says which step needs it first. Tick an item when it is done, and write decisions in the last section.

## How the commands work

- The commands use the GitHub command line tool `gh`, signed in as the owner (`gh auth login`). Each command names the repository with `--repo mqusaeri/mscd`, so it works from any folder, also from the key folder, which must be outside any git work tree. `export GH_REPO=mqusaeri/mscd` does the same for every later command in that shell.
- `gh secret set ... < file` reads the value from a file, so it never shows on screen or in the shell history. `gh secret set` without `< file` and without `--body` asks for the value and hides it while you paste.
- `gh variable set ... --body '<value>'` sets a value that is not secret. Variables can be read by anyone who can see the repository settings.
- Secrets cannot be read back from GitHub. Keep an offline copy of every key in a password manager.
- Set each name in every environment the table lists. Replace `<...>` with the real value.
- The repository `mqusaeri/mscd` is **public**. Anyone can read its workflow logs and job summaries. Secrets stay hidden, but anything a workflow prints is public (see the recorded decision "Repository visibility" in the [go-live checklist](go-live-checklist.md#recorded-decisions)).

Check what is set at any time (names only, never values):

```bash
for E in release staging production restore-test; do
  echo "== $E"; gh secret list --env "$E" --repo mqusaeri/mscd; gh variable list --env "$E" --repo mqusaeri/mscd
done
```

## 1. GitHub settings

Needed before the first release (M2-S01). Do this first, because the other commands write into these environments.

- [ ] Environments `release`, `staging`, `production` and `restore-test` exist.
- [ ] The owner is a required reviewer on `release` and `production`.
- [ ] `restore-test` may be used only from the default branch (`main`).
- [ ] Release tags `v*.*.*` are protected.
- [ ] The GHCR packages `mscd-server` and `mscd-web` stay private, and this repository has Actions read access to both, so the job token `GITHUB_TOKEN` of `deploy-prod.yml` and `restore-test.yml` can pull them. GitHub makes that token for each job; there is nothing to set.
- [ ] The log retention of Actions is set (Settings, Actions, General, "Artifact and log retention"); 30 days is enough for the deploy history and keeps less data.

```bash
R=mqusaeri/mscd
OWNER_ID=$(gh api user --jq .id)
# release and production: the owner approves every run. The owner starts some runs, so self-review stays allowed.
for E in release production; do
  printf '{"reviewers":[{"type":"User","id":%s}],"prevent_self_review":false}' "$OWNER_ID" \
    | gh api --method PUT "repos/$R/environments/$E" --input -
done
gh api --method PUT "repos/$R/environments/staging" --silent
# restore-test: only the default branch
printf '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' \
  | gh api --method PUT "repos/$R/environments/restore-test" --input -
gh api --method POST "repos/$R/environments/restore-test/deployment-branch-policies" \
  -f name="$(gh api "repos/$R" --jq .default_branch)" -f type=branch
# Protect release tags: only repository admins may create, move or delete v*.*.* tags
printf '%s' '{"name":"release tags","target":"tag","enforcement":"active",
  "conditions":{"ref_name":{"include":["refs/tags/v*.*.*"],"exclude":[]}},
  "rules":[{"type":"creation"},{"type":"update"},{"type":"deletion"}],
  "bypass_actors":[{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}]}' \
  | gh api --method POST "repos/$R/rulesets" --input -
```

The same in the browser: Settings, Environments, New environment (tick "Required reviewers" and add yourself); Settings, Rules, Rulesets, New tag ruleset (target pattern `v*.*.*`, rules "Restrict creations", "Restrict updates" and "Restrict deletions", bypass list "Repository admin").

The package settings have no command. After the first release has pushed the images, open each package (your profile, Packages, `mscd-server`, then Package settings), keep its visibility private, and under "Manage Actions access" check that `mqusaeri/mscd` is listed with the role Read or higher. Repeat for `mscd-web`.

Required reviewers work on every plan for a public repository. If the repository is made private, GitHub offers required reviewers only on some paid plans. Check that the option is still there, because every production approval of the plan depends on it.

## 2. Release key set

Needed before the first release (M2-S01). Made on the owner's own computer, never on a server and never by an agent.

- [ ] On your own computer, in a clone of the repository at the release version, run `npm ci`, then `bash deploy/scripts/saas-keys.sh --out <new folder outside any git work tree>`. The script needs Node.js 22; `docs/saas/release.md` (M2-S01) has the details.
- [ ] Run the lines that the script prints. They start with `export GH_REPO=mqusaeri/mscd`, so every `gh` line after it goes to this repository, and they use the exact file names. The table shows what they set. When the printed lines and this table differ, the printed lines are right.
- [ ] Check again that `release` and `production` still show you as required reviewer (Settings, Environments). If not, run the commands of section 1 again.
- [ ] Store a copy of every `.key` file and of `KEYS.txt` in a password manager, open the copy once to check it, then delete the folder (go-live checklist GL-10 and GL-21).

| Name | Kind | Environments | Command (after `export GH_REPO=mqusaeri/mscd`) |
|---|---|---|---|
| `MSCD_PACK_SIGNING_KEY` | secret | `release` | `gh secret set --env release MSCD_PACK_SIGNING_KEY < <keys>/pack-signing.key` |
| `MSCD_RELEASE_SIGNING_KEY` | secret | `release` | `gh secret set --env release MSCD_RELEASE_SIGNING_KEY < <keys>/bundle-signing.key` |
| `MSCD_TRUSTED_KEYS_LICENCE_PUB` | variable | `release` | `gh variable set --env release MSCD_TRUSTED_KEYS_LICENCE_PUB < <keys>/trusted/licence-release.pub` |
| `MSCD_TRUSTED_KEYS_PACK_PUB` | variable | `release` | `gh variable set --env release MSCD_TRUSTED_KEYS_PACK_PUB < <keys>/trusted/pack-release.pub` |
| `MSCD_TRUSTED_KEYS_ANCHOR_PUB` | variable | `release` | `cat <keys>/trusted/anchor-production.pub <keys>/trusted/anchor-staging.pub \| gh variable set --env release MSCD_TRUSTED_KEYS_ANCHOR_PUB` |
| `PLATFORM_KEY` | secret | `production`, `staging`, `restore-test` | `gh secret set --env production PLATFORM_KEY < <keys>/production/platform.key`; the same file with `--env restore-test`; `<keys>/staging/platform.key` with `--env staging` |
| `STORAGE_KEY` | secret | `production`, `staging`, `restore-test` | `gh secret set --env production STORAGE_KEY < <keys>/production/storage.key`; the same file with `--env restore-test`; `<keys>/staging/storage.key` with `--env staging` |
| `AUDIT_ANCHOR_KEY` | secret | `production`, `staging` | `gh secret set --env production AUDIT_ANCHOR_KEY < <keys>/production/audit-anchor.key`; `<keys>/staging/audit-anchor.key` with `--env staging` |

Production and staging get separate key sets, so a problem found on staging during the penetration test never exposes production keys. The release image trusts both audit anchor public keys. `restore-test` gets copies of the production `PLATFORM_KEY` and `STORAGE_KEY` (decision D-S12), because the weekly restore test opens production backups. `licence-signing.key` stays offline only: it signs customer licences and goes into no GitHub environment. Losing a `platform.key` or `storage.key` makes every backup of that environment unreadable.

## 3. Production server and staging server

Needed before the first run of `bootstrap-prod.yml` (M2-S03).

- [ ] Production: Ubuntu 24.04 LTS VPS, 4 vCPU or more, 16 GB RAM, 80 GB system disk, a separate block volume of 200 GB or more for Docker data, public IPv4 (and IPv6 when offered), in the location of decision D-S2.
- [ ] Staging (recommended): a smaller VPS with 8 GB RAM and the same system, separate from the demo server.
- [ ] Copy each server's host key fingerprint from the provider console. `bootstrap-prod.yml` asks for it.
- [ ] After bootstrap: delete `BOOTSTRAP_SSH_KEY`, and remove the provider's first root key from the server as `docs/saas/bootstrap.md` (M2-S03) says.

| Name | Kind | Environments | Command |
|---|---|---|---|
| `BOOTSTRAP_SSH_KEY` | secret | `production`, `staging` | `gh secret set --env production BOOTSTRAP_SSH_KEY --repo mqusaeri/mscd < mscd-bootstrap-production` (the private half of the bootstrap key that you gave the provider for root, as `docs/saas/bootstrap.md` explains). Delete after bootstrap: `gh secret delete --env production BOOTSTRAP_SSH_KEY --repo mqusaeri/mscd` |
| `DEPLOY_HOST` | secret | `production`, `staging` | `gh secret set --env production DEPLOY_HOST --repo mqusaeri/mscd --body '<server address>'` |

## 4. Domain and DNS

Needed before the first deploy (M2-S05).

- [ ] A host name for the service, for example `app.<domain>`, and one for staging, for example `staging.<domain>`.
- [ ] DNS records for each: `A` (and `AAAA`) pointing to the server, and a `CAA` record `0 issue "letsencrypt.org"` on the domain. Optionally `ops.<domain>` for the dashboards.

| Name | Kind | Environments | Command |
|---|---|---|---|
| `MSCD_DOMAIN` | variable | `production`, `staging` | `gh variable set --env production MSCD_DOMAIN --body 'app.<domain>' --repo mqusaeri/mscd` |
| `ACME_EMAIL` | variable | `production`, `staging` | `gh variable set --env production ACME_EMAIL --body '<address for certificate notices>' --repo mqusaeri/mscd` |

## 5. Mail provider

Needed before the first deploy. With `mail.required`, SaaS creates no organisation and no operator without mail (M2-06, M2-S09).

- [ ] An account with a transactional SMTP provider (for example Amazon SES, Mailgun, Brevo or Postmark) that accepts port 587. Note its data location for the lawyer ([legal-inputs.md](legal-inputs.md#data-locations)).
- [ ] SPF, DKIM and DMARC records for the sending domain (go-live checklist GL-08).

| Name | Kind | Environments | Command |
|---|---|---|---|
| `SMTP_HOST` | variable | `production`, `staging` | `gh variable set --env production SMTP_HOST --body '<smtp host>' --repo mqusaeri/mscd` |
| `SMTP_PORT` | variable | `production`, `staging` | `gh variable set --env production SMTP_PORT --body '587' --repo mqusaeri/mscd` |
| `MAIL_FROM` | variable | `production`, `staging` | `gh variable set --env production MAIL_FROM --body 'MSCD <no-reply@<domain>>' --repo mqusaeri/mscd` |
| `SMTP_USER` | secret | `production`, `staging` | `gh secret set --env production SMTP_USER --repo mqusaeri/mscd` (paste when asked) |
| `SMTP_PASSWORD` | secret | `production`, `staging` | `gh secret set --env production SMTP_PASSWORD --repo mqusaeri/mscd` (paste when asked) |

## 6. Off-site backup storage

Needed before the first scheduled backup (M2-S07).

- [ ] An S3-compatible bucket at a different provider or region from the server, with versioning or object lock. Staging is better given a bucket of its own, so it can never touch production backups.
- [ ] Three access keys: one limited to the bucket, one limited to the secrets prefix, and one read-only key for the restore test.
- [ ] A restic password, made once and kept offline: `openssl rand -base64 32 > restic.password`. Losing it makes every backup unreadable.

| Name | Kind | Environments | Command |
|---|---|---|---|
| `BACKUP_S3_ENDPOINT` | secret | `production`, `staging`, `restore-test` | `gh secret set --env production BACKUP_S3_ENDPOINT --repo mqusaeri/mscd --body '<https endpoint>'` |
| `BACKUP_S3_BUCKET` | secret | `production`, `staging`, `restore-test` | `gh secret set --env production BACKUP_S3_BUCKET --repo mqusaeri/mscd --body '<bucket name>'` |
| `BACKUP_S3_ACCESS_KEY` | secret | `production`, `staging`; in `restore-test` the read-only key | `gh secret set --env production BACKUP_S3_ACCESS_KEY --repo mqusaeri/mscd` (paste when asked) |
| `BACKUP_S3_SECRET_KEY` | secret | `production`, `staging`; in `restore-test` the read-only key | `gh secret set --env production BACKUP_S3_SECRET_KEY --repo mqusaeri/mscd` (paste when asked) |
| `BACKUP_SECRETS_ACCESS_KEY` | secret | `production`, `staging` | `gh secret set --env production BACKUP_SECRETS_ACCESS_KEY --repo mqusaeri/mscd` (paste when asked) |
| `BACKUP_SECRETS_SECRET_KEY` | secret | `production`, `staging` | `gh secret set --env production BACKUP_SECRETS_SECRET_KEY --repo mqusaeri/mscd` (paste when asked) |
| `BACKUP_RESTIC_PASSWORD` | secret | `production`, `staging`, `restore-test` | `gh secret set --env production BACKUP_RESTIC_PASSWORD --repo mqusaeri/mscd < restic.password` |

## 7. Monitoring accounts

Needed before the first deploy with monitoring (M2-S08).

- [ ] A heartbeat service (for example healthchecks.io) with three checks: watchdog, backup and restore test.
- [ ] An external uptime check of `https://<domain>/healthz`.
- [ ] An alert email address.
- [ ] Optional: a Telegram bot token and chat id, and a hosted status page (go-live checklist GL-35).

| Name | Kind | Environments | Command |
|---|---|---|---|
| `HEARTBEAT_WATCHDOG_URL` | secret | `production`, `staging` | `gh secret set --env production HEARTBEAT_WATCHDOG_URL --repo mqusaeri/mscd` (paste when asked) |
| `HEARTBEAT_BACKUP_URL` | secret | `production`, `staging` | `gh secret set --env production HEARTBEAT_BACKUP_URL --repo mqusaeri/mscd` (paste when asked) |
| `HEARTBEAT_RESTORE_URL` | secret | `restore-test` | `gh secret set --env restore-test HEARTBEAT_RESTORE_URL --repo mqusaeri/mscd` (paste when asked) |
| `TELEGRAM_BOT_TOKEN` | secret (optional) | `production`, `staging` | `gh secret set --env production TELEGRAM_BOT_TOKEN --repo mqusaeri/mscd` (paste when asked) |
| `ALERT_EMAIL_TO` | variable | `production`, `staging` | `gh variable set --env production ALERT_EMAIL_TO --body '<alert address>' --repo mqusaeri/mscd` |
| `TELEGRAM_CHAT_ID` | variable (optional) | `production`, `staging` | `gh variable set --env production TELEGRAM_CHAT_ID --body '<chat id>' --repo mqusaeri/mscd` |

## 8. SSH access after bootstrap

Needed before the first deploy (M2-S05). The bootstrap run prints the host key lines in its job summary; `docs/saas/bootstrap.md` (M2-S03) explains the three keys (bootstrap, deploy and your own admin key, all different).

| Name | Kind | Environments | Command |
|---|---|---|---|
| `DEPLOY_USER` | secret | `production`, `staging` | `gh secret set --env production DEPLOY_USER --repo mqusaeri/mscd --body 'deploy'` |
| `DEPLOY_SSH_KEY` | secret | `production`, `staging` | `gh secret set --env production DEPLOY_SSH_KEY --repo mqusaeri/mscd < mscd-deploy-production` (the private half of the deploy key whose public half went to `bootstrap-prod.yml`) |
| `DEPLOY_SSH_KNOWN_HOSTS` | secret | `production`, `staging` | `gh secret set --env production DEPLOY_SSH_KNOWN_HOSTS --repo mqusaeri/mscd < known_hosts` (the lines from the job summary of the bootstrap run) |
| `DEPLOY_SSH_PORT` | variable | `production`, `staging` | `gh variable set --env production DEPLOY_SSH_PORT --body '22' --repo mqusaeri/mscd` |

## 9. Legal documents

Needed before go-live. A lawyer qualified in Indonesian law drafts or reviews each one, starting from [legal-inputs.md](legal-inputs.md).

- [ ] Privacy notice in Indonesian and English, published.
- [ ] Data processing agreement (DPA) for customers.
- [ ] Terms of service in Indonesian and English (Law No. 24 of 2009), published.
- [ ] DPO decision (UU PDP Article 53).
- [ ] PSE Lingkup Privat registration through OSS.
- [ ] Written position on data location and cross-border transfer (UU PDP Article 56).
- [ ] Confirmation of the breach notice duties (UU PDP Article 46) and of the authority that receives notices today.

| Name | Kind | Environments | Command |
|---|---|---|---|
| `LEGAL_PRIVACY_URL` | variable | `production`, `staging` | `gh variable set --env production LEGAL_PRIVACY_URL --body 'https://<public address of the privacy notice>' --repo mqusaeri/mscd` |
| `LEGAL_TERMS_URL` | variable | `production`, `staging` | `gh variable set --env production LEGAL_TERMS_URL --body 'https://<public address of the terms>' --repo mqusaeri/mscd` |

The service shows the two links on the sign-in page (`legal.privacy_url` and `legal.terms_url`) after the next deploy.

## 10. Penetration test vendor

Needed before go-live. Booking takes 2 to 3 weeks.

- [ ] Book a grey-box web and API test of the staging stack, a report, a retest after fixes and a summary letter for customers.
- [ ] Send the vendor [pentest-scope.md](pentest-scope.md) and agree the dates and rules of engagement.
- [ ] Write the report and letter references in the go-live checklist (GL-24 and GL-66).

## 11. Incident contacts

Needed before go-live.

- [ ] A named person and a deputy for each incident role, a 24/7 phone number and the support email, written in the provider's incident contact list. Keep the list in the provider's protected document storage, next to the incident log, and never in this repository: the repository is public. The roles and the entries the list needs are in [incident-response.md](incident-response.md#roles-and-contacts).
- [ ] The date the list was last checked, written in the go-live checklist (GL-37).
- [ ] The names of the platform operators kept in the same protected storage. Only their number and the date of the list go into the "Operator accounts" row of the go-live checklist (GL-18).
- [ ] One exercise run with the script in [incident-response.md](incident-response.md#exercise-script) (go-live checklist GL-47).

## 12. Decisions

Each decision has a default, which is built when no answer arrives in time. Write the answer and the date, and tell the agents when an answer differs from the default.

| # | Decision | Default built | Needed by | Answer and date |
|---|---|---|---|---|
| D-S1 | Onboarding: the operator creates each organisation (sales-led), or customers sign up themselves | Sales-led. Self-service is in K.8 | M2-S09 | |
| D-S2 | Hosting location of the server, backups and mail provider: in Indonesia or abroad. Some regulated customers (for example under OJK) may need data kept in Indonesia | Server in Indonesia; backup bucket at a second provider, also in Indonesia when available | Owner purchase | |
| D-S3 | Public address | One host name `app.<domain>` for every organisation, with `?org=` and email discovery at sign-in | M2-S02 | |
| D-S4 | Plans and their limits | Presets `trial` (30 days, 10 users, 1 system) and `standard` (50 users, 3 systems, 12 months), editable in `saas.yaml` | M2-S10 | |
| D-S5 | Read-only period after a contract ends | 30 days in `offboarding`, then `archived` | M2-S09, DPA | |
| D-S6 | Backup retention and recovery point | 14 daily, 8 weekly, 12 monthly; recovery point 24 hours | M2-S07, DPA | |
| D-S7 | Uptime target and maintenance window | 99.5 percent monthly, announced maintenance excluded; window Sunday 22:00 to 24:00 WIB | M2-S04 | |
| D-S8 | CDN or web application firewall in front of the server | None at start; reviewed after the penetration test | M2-S02 | |
| D-S9 | Operational telemetry export in SaaS | Off until a collector exists | none | |
| D-S10 | May strangers find out which organisations are customers through the sign-in page | No: the same answer for unknown slugs and domains | M2-S11 | |
| D-S11 | Key management | Key files on the server with offline copies (deviation X-03); cloud key management in K.8 | M2-S05 | |
| D-S12 | Copies of the encryption keys in environment `restore-test`, so the weekly restore test can open the backups | Yes, with the environment limited to the default branch | M2-S07 | |
| Support hours | The hours in which support answers, published with D-S7 (go-live checklist GL-36) | No default | Go-live | |
