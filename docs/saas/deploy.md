# Deploys, rehearsals and rollback

This guide explains how a release of MSCD reaches the staging and production servers, what happens during a deploy, how a deploy goes back by itself when something fails, and how to roll back by hand. It belongs to work package M2-S05 of the [Milestone 2 plan](../platform/MILESTONE-2.md#m2-s05-deploy-script-and-deploy-workflow).

In short: nobody copies files to the server or types deploy commands there. An agent or the owner starts the workflow `deploy-prod.yml`, the owner approves it in GitHub, and the workflow does the rest.

## The files

| File | What it is |
|---|---|
| `.github/workflows/deploy-prod.yml` | The deploy workflow. It checks the release signatures, copies the release to the server over one SSH connection and runs the deploy script there |
| `deploy/scripts/saas-deploy.sh` | The deploy script on the server: `deploy`, `rollback` and `check-only` |
| `deploy/scripts/lib/saas.sh` | Its helpers. It uses `lib/common.sh` of the on-premise installer and changes nothing in it |
| `deploy/scripts/test/saas-rehearsal.sh` | The rehearsal on a build machine: deploy, upgrade, automatic rollback and manual rollback (see [The rehearsal](#the-rehearsal)) |

The other guides of this folder explain the parts a deploy uses: [release.md](release.md) (how a release is built and signed), [stack.md](stack.md) (the Compose stack and its settings), [bootstrap.md](bootstrap.md) (the server), [monitoring.md](monitoring.md) (the alerts) and `backup-restore.md` (the backups, M2-S07).

## Before the first deploy

The server is bootstrapped with `bootstrap-prod.yml` ([bootstrap.md](bootstrap.md)), a release exists ([release.md](release.md)), and the GitHub environment of the server (`staging` or `production`) holds these values. [owner-inputs.md](owner-inputs.md) gives the command that sets each one.

| Name | Kind | Needed | Where it goes on the server |
|---|---|---|---|
| `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_SSH_KNOWN_HOSTS` | secrets | yes | Only the SSH connection uses them |
| `DEPLOY_SSH_PORT` | variable | no (22) | Only the SSH connection uses it |
| `PLATFORM_KEY`, `STORAGE_KEY`, `AUDIT_ANCHOR_KEY` | secrets | yes | `/opt/mscd/secrets/platform.key`, `storage.key`, `audit-anchor.key` (see [Keys](#keys)) |
| `SMTP_USER`, `SMTP_PASSWORD` | secrets | yes | `MSCD_SMTP_USER` in `.env`; `/opt/mscd/secrets/smtp.password` |
| `MSCD_DOMAIN`, `SMTP_HOST`, `SMTP_PORT`, `MAIL_FROM` | variables | yes | `MSCD_DOMAIN`, `MSCD_SMTP_HOST`, `MSCD_SMTP_PORT`, `MSCD_MAIL_FROM` in `.env` |
| `ACME_EMAIL` | variable | advised | `ACME_EMAIL` in `.env` (Let's Encrypt account; may be empty) |
| `ACME_CA` | variable | no | `ACME_CA` in `.env`. Without it the Let's Encrypt staging CA is used (see [First deploy](#first-deploy)) |
| `MSCD_SITE_DOMAIN` | variable | no | The marketing site of `apps/site` on that host name ([stack.md](stack.md)) |
| `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY`, `BACKUP_SECRETS_ACCESS_KEY`, `BACKUP_SECRETS_SECRET_KEY`, `BACKUP_RESTIC_PASSWORD`, `HEARTBEAT_BACKUP_URL` | secrets | before the first backup | One file each in `/opt/mscd/secrets/backup/` |
| `HEARTBEAT_WATCHDOG_URL`, `TELEGRAM_BOT_TOKEN`, `OPS_BASIC_AUTH_HASH` | secrets | see [monitoring.md](monitoring.md) | One file each in `/opt/mscd/secrets/ops/` |
| `ALERT_EMAIL_TO`, `TELEGRAM_CHAT_ID`, `OPS_DOMAIN`, `OPS_BASIC_AUTH_USER` | variables | see [monitoring.md](monitoring.md) | One file each in `/opt/mscd/secrets/ops/` |

Every deploy writes all of them again, so the GitHub environment is the only place to change them. A value that is not set becomes an empty file. The backup and monitoring files have mode 0400 and belong to the deploy account; the backup and monitoring services read them there.

The monitoring stops a deploy when `ALERT_EMAIL_TO` is missing, once the release holds the monitoring parts. Set it before that release.

## Starting a deploy

An agent starts a run only when the owner asks for it (rule S-1 of the plan):

```bash
gh workflow run deploy-prod.yml -f version=v1.1.0 -f target=staging
gh run list --workflow deploy-prod.yml --limit 1      # the run waits for approval
```

The owner approves it: GitHub, Actions, the run, "Review deployments", tick the environment and "Approve and deploy". GitHub also sends the owner an email with a link. Nothing reaches the server before the approval. Only one run per server goes at a time: a second run waits until the first one ends (the concurrency group `deploy-<target>`, shared with `bootstrap-prod.yml`).

The inputs:

| Input | Meaning |
|---|---|
| `version` | The release tag, for example `v1.1.0` or `v1.1.0-rc.2`. For a rollback, the release to return to |
| `action` | `deploy` (default) or `rollback` |
| `target` | `staging` or `production` |
| `skip_backup` | Leaves out the pre-deploy database dump. Use it only when the dump itself fails and the deploy cannot wait |

## What a deploy does

The workflow, on a GitHub runner:

1. Checks out the tag and checks that the commit is the tag's commit.
2. Downloads `digests.json` of the GitHub Release and checks that it names `ghcr.io/mqusaeri/mscd-server` and `ghcr.io/mqusaeri/mscd-web` with `sha256` digests.
3. Runs `cosign verify` for both digests. The signature must come from `release.yml` of this repository at that tag (`https://github.com/mqusaeri/mscd/.github/workflows/release.yml@refs/tags/<tag>`, issuer `https://token.actions.githubusercontent.com`).
4. Opens one SSH connection to the server with the deploy key and the pinned host key. Every later command and copy shares it, because the firewall refuses the 6th new SSH connection from one address within 30 seconds. The deploy key may not open a terminal, so the workflow never asks for one.
5. Copies the release with `rsync` to `/opt/mscd/releases/<tag>`: the Compose files, `.env.saas.example`, `config/postgres` and `config/caddy`, `deploy/scripts`, `deploy/backup` and `deploy/ops` when the release has them, the marketing site, and `digests.json`. The demo files are left out twice: the copy never picks them, and `rsync` excludes `config/demo-secrets`, `docker-compose.demo.yml` and `dev` again. It also copies its `cosign` to `/opt/mscd/bin/cosign`.
6. Logs the server in to `ghcr.io` with the job's own token, which expires with the job, then runs `saas-deploy.sh` with every secret and setting on standard input, and logs the server out again.
7. Checks `https://<domain>/healthz` and the version from outside.

`saas-deploy.sh deploy`, on the server, as the deploy account:

1. Locks `/opt/mscd`, so two deploys never overlap.
2. Refuses anything of the demo stack before any other check: an image name ending in `-demo` ("demo images are refused"), the `demo.yaml` or `test.yaml` profile or any `MSCD_DEMO` setting ("demo and test profiles are refused"), and a release folder or install folder that holds `config/demo-secrets` or `docker-compose.demo.yml` ("demo files are refused"). Then it checks Docker, memory and free disk.
3. Reads `digests.json` and refuses a version older than the one running (use a rollback for that).
4. Reads the values on standard input and writes the new `.env` from `.env.saas.example` of the release. `docker compose config` must accept it before anything changes.
5. Checks both signatures again with `cosign verify`, pulls both images by digest while the old containers keep running, checks that the server image is a release build, and starts it once with `--help`.
6. Puts the key files in place (see [Keys](#keys)), then writes the generated secrets that are missing (database passwords, gateway token, S3 identity, internal certificates), `smtp.password`, and the backup and monitoring files.
7. Takes a pre-deploy dump of the database with `pg_dump --format=custom` to `/opt/mscd/backup/pre-deploy` (the last 3 are kept). When the release has `deploy/backup/backup.sh` (M2-S07), it also sends an off-site copy.
8. Saves the files in place (the rollback point) and installs the release's files and `.env`.
9. Runs the database migrations alone, with `docker compose run --rm --no-deps migrate`, while the old services keep serving. The time limit is 10 minutes plus 20 seconds per organisation. The log goes to `/opt/mscd/logs/migrate-<version>-<time>.log` and is printed in the workflow log with organisation names hidden.
10. Restarts the services one at a time and waits until each is healthy: PostgreSQL and SeaweedFS (only when their settings changed), storage-gateway, api, worker, web and Caddy, then the monitoring services when the release has them.
11. Checks that api, worker and storage-gateway report ready (`/readyz`), that `/healthz` answers through Caddy, and that `/api/v1/system/profile` through Caddy reports the new version.
12. Records the release in `/opt/mscd/state` and removes the images of releases older than the last 3.

The server keeps the whole output in `/opt/mscd/logs/deploy-<time>.log`, and the output of the Compose commands next to it.

### First deploy

Caddy gets the certificate from Let's Encrypt when Caddy first starts. Do the first deploy of each server with the Let's Encrypt staging CA, which is the default while the variable `ACME_CA` is not set: it has high rate limits, so a wrong DNS record cannot lock the domain out for a week. Browsers do not trust its certificates, so the workflow's check from outside skips the certificate check and says so.

When the first deploy has passed:

1. Set the variable `ACME_CA` of the environment to `https://acme-v02.api.letsencrypt.org/directory`.
2. Run the deploy of the same version again. It changes only the settings and gets a trusted certificate.
3. The check from outside now checks the certificate too.

The DNS records must point at the server before the first deploy ([bootstrap.md](bootstrap.md)). Caddy keeps the certificates in the volume `caddy_data`; a deploy never removes it.

## Release order

Every release goes through these steps, each one started by an agent or the owner and approved by the owner:

1. **Staging.** `deploy-prod.yml` with `target=staging`. Check the app on staging.
2. **Migration rehearsal.** `restore-test.yml` with `target_version` set to the new version (M2-S07): it restores last night's production backup on a GitHub runner and runs the new migrations against it. This finds a slow or broken migration on real data before customers feel it.
3. **Production.** `deploy-prod.yml` with `target=production`, best in the maintenance window (Sunday 22:00 to 24:00 WIB, D-S7).

## What users see during a deploy

| Moment | Duration | What users see |
|---|---|---|
| Copy, checks, image pull, dump, migrations | most of the deploy | Nothing; the old release keeps serving |
| api and storage-gateway restart | a few seconds each | Pages stay. A screen that saves or loads data in that moment gets "The MSCD API is not reachable" or waits a little; repeating the action works |
| web restarts | a few seconds | Caddy holds requests for up to 30 seconds and retries, so pages load slowly instead of failing |
| Caddy restarts (only when its settings changed) | 1 to 3 seconds | The browser shows a connection error once; a reload works |

In the rehearsal, requests to the API every half second during the upgrade went unanswered for a few seconds in a row at most (see [The rehearsal](#the-rehearsal)). Expect slow or refused requests for up to 20 seconds in total. A POST that a client repeats with the same `Idempotency-Key` is stored once: the api answers the repeat with the first result.

## Automatic rollback

A deploy goes back to the previous release by itself when:

- the migrations fail or run out of time;
- a service does not become healthy;
- a check of step 11 fails.

It puts the saved files and `.env` back, starts the previous digests again (pulling them when they are no longer on the server) and checks them the same way. The workflow run then ends as failed with "The deploy of <version> failed (...) and was rolled back automatically. <old version> is running and healthy."

The database is not rolled back. There are no down migrations:

- When the migrations failed, the failed folder ran in one transaction, so the database keeps the schema of the old release.
- When a later step failed, the database keeps the new migrations. The old release works with them, because every migration only adds to the schema and removals come one release later (expand and contract, as in `upgrade.sh`).

A deploy that is refused before step 8 (wrong key, demo image, failed signature, unhealthy database) changes nothing; the run says "Nothing was changed."

## Rolling back by hand

To return to the release that ran before:

```bash
gh workflow run deploy-prod.yml -f action=rollback -f version=v1.0.2 -f target=production
```

`version` is the release to return to. The workflow verifies its signatures like a deploy, and the server refuses when its previous release is another version. The rollback puts back the files and `.env` of that release, starts its images and checks them. It runs no migrations and takes a pre-rollback dump first. Each rollback goes one release further back; the server keeps the files of the last 3 releases (`/opt/mscd/state/saved`) and their images. After a rollback, a later deploy of a newer version works as usual.

### Restoring the database

Needed only when a migration damaged data, which a rollback cannot undo. Every change made after the dump is lost, so a fix in a new release is usually better. Decide with the technical lead, then on the server as the admin account:

```bash
cd /opt/mscd/deploy/compose
ls -lt /opt/mscd/backup/pre-deploy/        # <time>-<old version>-to-<new version>.dump
sudo docker compose stop caddy web api worker storage-gateway
sudo docker compose exec -T postgres pg_restore -U postgres --clean --if-exists --single-transaction \
  -d mscd < /opt/mscd/backup/pre-deploy/<file>.dump
```

Then roll back to the old version with `deploy-prod.yml`, which starts the services again. The off-site backups of M2-S07 hold older copies (`backup-restore.md`).

### When a rollback fails

When neither the new nor the old release becomes healthy, the run ends with "did not finish" and names the folder with the saved files. Nothing more happens by itself. Then:

1. Read the end of `/opt/mscd/logs/deploy-<time>.log` or `rollback-<time>.log`, and `sudo docker compose ps -a` in `/opt/mscd/deploy/compose`.
2. Fix the cause (for example free disk space, or a service that cannot reach the database).
3. Run the rollback of the workflow again, or a deploy of the version that should run.

Follow [incident-response.md](incident-response.md) when customers cannot work.

## Keys

`PLATFORM_KEY` and `STORAGE_KEY` are the two key-encryption keys (base64 of 32 bytes), and `AUDIT_ANCHOR_KEY` is the Ed25519 key that signs the audit chain anchors. The owner made them with `saas-keys.sh` and keeps offline copies (decision D-S11: key files on the server with offline copies).

On every deploy and rollback the script reads them from standard input before any other secret is written:

- A key file that is missing is written with the value from GitHub (mode 0400, readable only by the server user).
- A key file that exists must hold the same key. A difference stops the deploy, and the file is never overwritten. The usual causes are a secret of the wrong environment or a secret that was replaced by mistake. Compare it with the offline copy; never "fix" it by deleting the file on the server, because data sealed with the old key would become unreadable.
- `audit-anchor.pub` is made from `audit-anchor.key` in the format of `mscd-server keys generate`. The anchor key must be one of the anchor keys built into the release (M2-S01); otherwise the worker logs "not among the anchor keys compiled into this build".

The script never uses `ensure_secrets` or `ensure_anchor_key` of the installer, because both would write a random key or a new anchor key pair that the release does not trust. Changing a key is a separate procedure and not part of a deploy.

## The server folder

| Path | What it holds |
|---|---|
| `/opt/mscd/.env` | The settings of the stack (mode 0600). Every deploy writes it from `.env.saas.example` of the release and the values of the GitHub environment |
| `/opt/mscd/deploy/` | The `deploy/` folder of the running release. `deploy/compose` is the Compose project folder; its `.env` is a link to `/opt/mscd/.env` |
| `/opt/mscd/site/` | The marketing site |
| `/opt/mscd/secrets/` | Secret files, and `backup/` and `ops/` with the backup and monitoring values |
| `/opt/mscd/releases/<tag>/` | The releases as the workflow copied them; the last 3 are kept |
| `/opt/mscd/state/` | `current.env` (running release and digests), `previous.env` (the rollback target), `history.log` (every deploy and rollback), `saved/` (the files of earlier releases) |
| `/opt/mscd/backup/pre-deploy/` | The last 3 pre-deploy dumps (mode 0600) |
| `/opt/mscd/logs/` | Deploy, rollback and migrate logs |
| `/opt/mscd/bin/cosign` | The cosign of the last workflow run |

`/opt/mscd/state/ssh-known-hosts` belongs to the bootstrap and stays as it is.

## Commands on the server

Normal work never needs them. For reading and fixing, as the admin account:

```bash
cd /opt/mscd/deploy/compose
sudo docker compose ps                 # Compose reads .env, which names the files and the project
sudo docker compose logs --since 15m api
cat /opt/mscd/state/current.env /opt/mscd/state/history.log
sudo -u deploy bash /opt/mscd/deploy/scripts/saas-deploy.sh check-only --target production
```

`check-only` runs the refusals and the checks of a deploy against the files in place and changes nothing. It reads no standard input.

Running `saas-deploy.sh deploy` by hand is possible for an emergency (as the deploy account, with the values on standard input as `NAME=<base64 value>` lines, see `--help`), but the workflow is the way to deploy: it checks the signatures, and it is the record that the owner approved the change.

## The rehearsal

`deploy/scripts/test/saas-rehearsal.sh` proves deploy, upgrade, automatic rollback and manual rollback on a build machine. It runs as root, under the host lock of the Compose test stacks:

```bash
flock /tmp/mscd-stack.lock bash deploy/scripts/test/saas-rehearsal.sh
```

It starts a local registry on `127.0.0.1:5000` (`registry:3.0.0`, pinned by digest), makes a throwaway key set with `saas-keys.sh`, builds the release images `1.1.0-rc.1` and `1.1.0-rc.2` with it and pushes them. From them it makes three broken versions: `rc.3` is the web image tagged as the server image (refused before anything changes), `rc.4` has a migration that fails, and `rc.5` replaces the services with an image that never serves. Each release folder is made the way the workflow copies it, and the local images are removed, so every deploy pulls by digest.

`saas-deploy.sh` then runs against `/tmp/mscd-rehearsal` as a user that is not root but is in the docker group, like the deploy account:

| Run | Expected |
|---|---|
| Deploy `rc.1` | First deploy. The key files equal the values sent, `audit-anchor.pub` matches the key, the owners and modes are right, the backup and monitoring files exist. A test mail goes through the `cli` service to Mailpit, which accepts only the right SMTP password. The audit anchor job runs without "not among the anchor keys compiled into this build" |
| Deploy `rc.1` with another `PLATFORM_KEY` | Refused; `platform.key` stays as it was |
| Deploy `rc.2` | Upgrade with a pre-deploy dump that `pg_restore` can read; the API is polled during it |
| A release folder with `config/demo-secrets`; `--no-verify-signature` for `ghcr.io` images; a failing `cosign` | Each refused, nothing changed; `cosign verify` was called with the identity of `release.yml` for the tag |
| Deploy `rc.3`, `rc.4`, `rc.5` | Refused, then rolled back after the failed migration, then rolled back after the failed health check; `rc.2` runs each time, and only the images of `rc.1` and `rc.2` stay |
| Rollback to `rc.1`, then `check-only` | `rc.1` runs; nothing older is left to roll back to; every check passes |

At the end it removes every container, network, volume, image and folder it made, and keeps the deploy logs in `/tmp/mscd-rehearsal-logs`.

| Setting | Default | Meaning |
|---|---|---|
| `MSCD_TEST_CONTAINER_PREFIX` | `mscd-` | Prefix of the Compose project (`<prefix>rehearsal`), the containers and the image names |
| `MSCD_REHEARSAL_DIR` | `/tmp/mscd-rehearsal` | The install folder; work files go to `<folder>-work` |
| `MSCD_REHEARSAL_REGISTRY_PORT`, `MSCD_REHEARSAL_HTTP_PORT`, `MSCD_REHEARSAL_HTTPS_PORT` | 5000, 18080, 18443 | Ports on this machine |
| `MSCD_REHEARSAL_UID` | 61005 | User id of the deploy runs |
| `MSCD_REHEARSAL_OVERLAYS` | `repo` | `none` leaves the backup and monitoring parts out of the release folders |
| `MSCD_REHEARSAL_KEEP` | `false` | `true` keeps everything for a look; `--down` removes it later |
| `MSCD_SAAS_TEST_SCAN` | `gate` | `auto` for build machines that cannot reach the Alpine mirrors, as in [stack.md](stack.md) |
| `MSCD_BUILD_CA` | none | CA certificate of a TLS-inspecting proxy for the image builds |

Its test containers publish Caddy's ports on every address of the build machine, as the server does. Run it on a build machine that is not reachable from outside.

## Troubleshooting

| Message | What to do |
|---|---|
| "Another deploy or rollback is running" | Wait for the other run. A run that was stopped by force leaves no lock behind |
| "demo images are refused", "demo and test profiles are refused", "demo files are refused" | The run used something of the demo stack. Deploy a release tag with `deploy-prod.yml`; never copy the repository to the server by hand |
| "<file> does not match <KEY> of this deploy" | See [Keys](#keys). Nothing was changed |
| "The signature of ... does not check out" | The image was not signed by `release.yml` for this tag. Do not deploy it; check the release run |
| "docker pull ... failed" | The packages must stay readable for this repository's workflows (package settings, Actions access) |
| "is older than the running" | Use `action=rollback`, or deploy a newer version |
| "PostgreSQL is ..., so no pre-deploy dump can be taken" | Find out why the database is not healthy before deploying. `skip_backup` only when the deploy must fix exactly that |
| "The migrations of ... failed" | The log in the run (and `/opt/mscd/logs/migrate-*.log`) names the migration. The old release keeps running |
| "Migrate did not finish within ..." | A migration was too slow. Check it with the migration rehearsal of `restore-test.yml` on production data |
| "... did not become healthy" or "does not report ready" | The run prints the last log lines of that service; the deploy went back by itself |
| "MSCD_DOMAIN ... is a placeholder", "MSCD_SMTP_HOST ... is the placeholder" | A variable of the GitHub environment is missing |
| "MSCD_TLS_MODE internal is for test stacks only" | Remove the setting; servers use Let's Encrypt |
| "cosign is needed to check the image signatures" | The workflow copies cosign to `/opt/mscd/bin/cosign`; a run by hand needs `--cosign` |
