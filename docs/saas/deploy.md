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

Every deploy writes all of them again, so the GitHub environment is the only place to change them. A value that is not set, or was removed from the environment, removes its file, so an old Telegram token or Grafana host stops being used. The backup and monitoring files have mode 0400 and belong to the deploy account; the backup and monitoring services read them there. When `OPS_DOMAIN` is set, the deploy adds the `grafana` profile to `COMPOSE_PROFILES`, so Grafana starts.

The monitoring needs `ALERT_EMAIL_TO` once the release holds the monitoring parts. Without it `ops-init` stops and the deploy ends with a warning (see step 11 below). Set it before that release.

## Starting a deploy

An agent starts a run only when the owner asks for it (rule S-1 of the plan):

```bash
gh workflow run deploy-prod.yml -f version=v1.1.0 -f target=staging
gh run list --workflow deploy-prod.yml --limit 1      # the run waits for approval
```

The owner approves it: GitHub, Actions, the run, "Review deployments", tick the environment and "Approve and deploy". GitHub also sends the owner an email with a link. Nothing reaches the server before the approval. Only one run per server goes at a time: a second run waits until the first one ends (the concurrency group `deploy-<target>`, shared with `bootstrap-prod.yml`). Do not cancel a run once its step "Deploy on the server" has started: the deploy on the server carries on anyway, and the run can no longer report its result (see [When a run is cut off](#when-a-run-is-cut-off)).

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
6. Logs the server in to `ghcr.io` with the job's own token, which expires with the job, then runs `saas-deploy.sh` with every secret and setting on standard input, and logs the server out again. The workflow file runs from the default branch and the scripts from the tag, so it sends only the names that the tag's `saas-deploy.sh` takes and notes each name it leaves out; a rollback to an older release keeps working after a new setting was added. When the connection ends before the script does, see [When a run is cut off](#when-a-run-is-cut-off).
7. Checks `https://<domain>/healthz` and the version from outside.

The lines that come from the server are fenced with `::stop-commands::`, so a log line of a service can never act as a GitHub workflow command. Afterwards the WARN lines of the server become warnings of the run and appear in its summary.

`saas-deploy.sh deploy`, on the server, as the deploy account:

1. Locks `/opt/mscd`, so two deploys never overlap, and prints the last line of `/opt/mscd/state/history.log`, which says how the run before ended.
2. Refuses anything of the demo stack before any other check: an image name ending in `-demo` ("demo images are refused"), the `demo.yaml` or `test.yaml` profile or any `MSCD_DEMO` setting ("demo and test profiles are refused"), and a release folder or install folder that holds `config/demo-secrets` or `docker-compose.demo.yml` ("demo files are refused"). Then it checks Docker, memory and free disk.
3. Reads `digests.json` and refuses a version older than the one running (use a rollback for that).
4. Reads the values on standard input and writes the new `.env` from `.env.saas.example` of the release. `docker compose config` must accept it before anything changes.
5. Checks both signatures again with `cosign verify`, pulls both images by digest while the old containers keep running, checks that the server image is a release build, and starts it once with `--help`.
6. Checks that PostgreSQL is healthy and that the disk has room for a dump of the database. A first deploy has no database yet and takes no dump.
7. Writes the line `deploy started` to `history.log`, puts the key files in place (see [Keys](#keys)), then writes the generated secrets that are missing (database passwords, gateway token, S3 identity, internal certificates), `smtp.password`, and the backup and monitoring files.
8. Takes a pre-deploy dump of the database with `pg_dump --format=custom` to `/opt/mscd/backup/pre-deploy` (the last 3 are kept). When the release has `deploy/backup/backup.sh` (M2-S07), it also sends an off-site copy.
9. Saves the files in place (the rollback point) and installs the release's files and `.env`. When the files in place belong to another release than the one `state/current.env` names, an earlier run was stopped hard while it switched them: the run first puts back the copy that run saved (see [When a run is cut off](#when-a-run-is-cut-off)).
10. Runs the database migrations alone, with `docker compose run --rm --no-deps migrate`, while the old services keep serving. The time limit is 10 minutes plus 20 seconds per organisation. The log goes to `/opt/mscd/logs/migrate-<version>-<time>.log` and is printed in the workflow log with organisation names hidden.
11. Restarts the services one at a time and waits until each one passes its health check: PostgreSQL and SeaweedFS (only when their settings changed), storage-gateway, api, worker, web and Caddy. Then it recreates the monitoring and backup services when the release has them, waits until `ops-init` has finished, and reloads Caddy so it reads the Grafana host that `ops-init` writes. These services do not decide whether the app is healthy: when one of them fails, or Caddy refuses the Grafana host, the deploy carries on, ends with a WARN line ("The app runs, but ..."), and the workflow shows it as a warning. Fix the cause and deploy the same version again.
12. Checks that api, worker and storage-gateway report ready (`/readyz`), that `/healthz` answers through Caddy, and that `/api/v1/system/profile` through Caddy reports the new version.
13. Records the release in `/opt/mscd/state`, writes the result to `history.log` and removes the images of releases older than the last 3.

The server keeps the whole output in `/opt/mscd/logs/deploy-<time>.log`, and the output of the Compose commands next to it. When a service fails, the workflow log shows its last lines with IP addresses, email addresses and organisation names hidden, because the repository is public; the full lines are in `/opt/mscd/logs/deploy-<time>-services.log`.

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

In two rehearsal runs on a busy build machine, a request to the API every half second during an upgrade got an answer 63 times out of 70 and 103 times out of 116, and the longest gaps were 3.7 and 9.9 seconds (see [The rehearsal](#the-rehearsal)). On a server with real load, expect slow or refused requests for up to 20 seconds in total. A POST that a client repeats with the same `Idempotency-Key` is stored once: the api answers the repeat with the first result.

## Automatic rollback

A deploy goes back to the previous release by itself when:

- the migrations fail or run out of time;
- a service of the app (PostgreSQL, SeaweedFS, storage-gateway, api, worker, web or Caddy) does not become healthy;
- a check of step 12 fails.

It puts the saved files and `.env` back, starts the previous digests again (pulling them when they are no longer on the server) and checks them the same way. The workflow run then ends as failed with "The deploy of <version> failed (...) and was rolled back automatically. <old version> is running and healthy."

The database is not rolled back. There are no down migrations:

- When the migrations failed: each migration folder (`platform`, `ref` and every organisation schema) runs in its own transaction. The folder that failed was rolled back; the folders that finished before it, and the other organisation schemas, stay migrated. The migrate log in the run lists them.
- When a later step failed, the database keeps all the new migrations.

In both cases the old release works with the migrations that stay, because every migration only adds to the schema and removals come one release later (expand and contract, as in `upgrade.sh`).

A deploy that is refused in steps 1 to 7 before anything is written (a demo image, a failed signature, an unhealthy database, a key that does not match) changes nothing; the run says "Nothing was changed." When step 7 fails after the keys matched (for example on a full disk), or the dump of step 8 or its off-site copy fails, only the secret files were brought up to date: the running release, its settings and the database are as before, and the run says so.

## Rolling back by hand

To return to the release that ran before:

```bash
gh workflow run deploy-prod.yml -f action=rollback -f version=v1.0.2 -f target=production
```

`version` is the release to return to. The workflow verifies its signatures like a deploy, and the server refuses when its previous release is another version. The rollback puts back the files and `.env` of that release, starts its images and checks them. It runs no migrations and takes a pre-rollback dump first. Each rollback goes one release further back. The server keeps the files of the last 3 earlier releases (`/opt/mscd/state/saved`) and the images of the running release and the 2 before it; an older image is pulled again by digest when a rollback needs it. After a rollback, a later deploy of a newer version works as usual.

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

## When a run is cut off

Do not cancel a run once its step "Deploy on the server" has started. A run can still lose the server in four ways: someone cancels it, it reaches the job's time limit of 75 minutes, the GitHub runner is lost, or the network stays silent for 3 minutes. In each case only the workflow stops. `saas-deploy.sh` keeps running on the server: it finishes, or rolls back by itself, exactly as when the workflow watches it, and writes its whole output to `/opt/mscd/logs/deploy-<time>.log` (or `rollback-<time>.log`). When the connection ended, the workflow run says "The SSH connection failed or ended before saas-deploy.sh finished".

To learn the result:

- Anyone, an agent too, can read the version that runs: `curl -s https://<domain>/api/v1/system/profile | jq -r .version`.
- The owner, or an admin on the server, reads `tail -n 5 /opt/mscd/state/history.log`.
- The next run of `deploy-prod.yml` prints the last line of `history.log` before it changes anything. While the earlier run still goes on, the next run stops with "Another deploy or rollback is running" and changes nothing; start it again a few minutes later.

The lines of `history.log` (time, action, result, version, details):

| Result | Meaning |
|---|---|
| `started` | The run began to change things. As the last line: it is still running, or it was stopped hard (see below) |
| `done` | Deployed or rolled back, and healthy |
| `restored` | The deploy failed (`reason=migrate` or `reason=health`) and went back by itself; the version after `running=` runs |
| `failed` | A first deploy that did not finish, or a rollback that failed and returned to the version it started from |
| `restore-failed` | Neither version became healthy: see [When a rollback fails](#when-a-rollback-fails) |
| `stopped` | The run ended with an error before its result. With `phase=secrets` or `phase=backup`, only the secret files were changed; with a later phase, the next run checks the files first (see below) |
| `repair done` | A run found the files of a run that was stopped hard and put the saved copy back |

A run that is stopped hard, by a restart of the server or a killed process, writes no result. When that happened while it switched the files, the files in place belong to the new release while `state/current.env` still names the old one. The next deploy or rollback sees this ("an earlier run stopped while it switched the files"), puts back the copy of the old files that the stopped run saved, removes the work folders that run left, and goes on. `check-only` reports the same state and changes nothing. If the run says "No saved copy of the files of ... is left to put back", a person on the server sets `MSCD_SERVER_DIGEST`, `MSCD_WEB_DIGEST` and `MSCD_VERSION` in `/opt/mscd/.env` to the values `SERVER_DIGEST`, `WEB_DIGEST` and `VERSION` of `/opt/mscd/state/current.env` (as the deploy account), then starts the deploy again.

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
| `/opt/mscd/state/` | `current.env` (running release and digests), `previous.env` (the rollback target), `history.log` (the start and the result of every deploy and rollback), `saved/` (the files of earlier releases), and `rollback-undo-<time>/` after a rollback that could not return |
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
cat /opt/mscd/state/current.env; tail -n 5 /opt/mscd/state/history.log
sudo -u deploy bash /opt/mscd/deploy/scripts/saas-deploy.sh check-only --target production
```

`check-only` runs the refusals and the checks of a deploy against the files in place, prints the last line of `history.log`, and changes nothing. It reads no standard input.

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
| Deploy `rc.1` with another `PLATFORM_KEY` | Refused with "Nothing was changed"; `platform.key` stays as it was and `history.log` ends with `deploy stopped ... phase=secrets` |
| Deploy `rc.2` | Upgrade with a pre-deploy dump that `pg_restore` can read; the API is polled during it |
| A release folder with `config/demo-secrets`; `--no-verify-signature` for `ghcr.io` images; a failing `cosign` | Each refused, nothing changed; `cosign verify` was called with the identity of `release.yml` for the tag |
| Deploy `rc.3` | Refused before anything changes; `rc.2` runs |
| Deploy `rc.4`, after the state a deploy stopped hard while it switched the files leaves (the `.env` of another release in place, the saved files of `rc.2`, a `started` line without a result, a key copy in a work folder) | The run puts the files of `rc.2` back before it saves its own rollback point and removes the work folders; then the migration fails and the deploy rolls back by itself; `rc.2` runs |
| Deploy `rc.5`, with nobody reading its output after 12 lines (as when the SSH connection ends) | The run carries on, the health check fails, the deploy rolls back by itself, and the server log and `history.log` hold the whole run and its result; `rc.2` runs |
| Deploy `rc.2` again with a stand-in monitoring overlay whose `ops-init` stops, an empty `TELEGRAM_BOT_TOKEN` and an `OPS_DOMAIN` (only with `MSCD_REHEARSAL_OVERLAYS=none`) | The deploy ends healthy with a warning and no rollback, Caddy reloads, `history.log` notes `overlay=problem`, the old token file is gone and `COMPOSE_PROFILES` holds `grafana`. Only the images of `rc.1` and `rc.2` stay |
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
| "Another deploy or rollback is running" | Wait for the other run: a run whose workflow was cancelled or lost its connection keeps running on the server ([When a run is cut off](#when-a-run-is-cut-off)). A run that was stopped by force leaves no lock behind |
| "The SSH connection failed or ended before saas-deploy.sh finished" | See [When a run is cut off](#when-a-run-is-cut-off) |
| "an earlier run stopped while it switched the files" | Nothing to do: the run puts the saved files back and goes on |
| "No saved copy of the files of ... is left to put back" | See the end of [When a run is cut off](#when-a-run-is-cut-off) |
| "demo images are refused", "demo and test profiles are refused", "demo files are refused" | The run used something of the demo stack. Deploy a release tag with `deploy-prod.yml`; never copy the repository to the server by hand |
| "<file> does not match <KEY> of this deploy" | See [Keys](#keys). Nothing was changed |
| "The signature of ... does not check out" | The image was not signed by `release.yml` for this tag. Do not deploy it; check the release run |
| "docker pull ... failed" | The packages must stay readable for this repository's workflows (package settings, Actions access) |
| "is older than the running" | Use `action=rollback`, or deploy a newer version |
| "PostgreSQL is ..., so no pre-deploy dump can be taken" | Find out why the database is not healthy before deploying. `skip_backup` only when the deploy must fix exactly that |
| "The migrations of ... failed" | The log in the run (and `/opt/mscd/logs/migrate-*.log`) names the migration. The old release keeps running |
| "Migrate did not finish within ..." | A migration was too slow. Check it with the migration rehearsal of `restore-test.yml` on production data |
| "... did not become healthy" or "does not report ready" | The run prints the last log lines of that service; the deploy went back by itself |
| "The app runs, but the overlay services did not all start" | The app was deployed. The run prints the last log lines of the monitoring or backup service (for `ops-init`, often a missing `ALERT_EMAIL_TO`); fix the value and deploy the same version again |
| "Caddy refused the configuration of the monitoring overlay" | Caddy keeps serving with the configuration it had. Check `OPS_DOMAIN` and `OPS_BASIC_AUTH_HASH` ([monitoring.md](monitoring.md)) and deploy the same version again |
| "MSCD_DOMAIN ... is a placeholder", "MSCD_SMTP_HOST ... is the placeholder" | A variable of the GitHub environment is missing |
| "MSCD_TLS_MODE internal is for test stacks only" | Remove the setting; servers use Let's Encrypt |
| "cosign is needed to check the image signatures" | The workflow copies cosign to `/opt/mscd/bin/cosign`; a run by hand needs `--cosign` |
