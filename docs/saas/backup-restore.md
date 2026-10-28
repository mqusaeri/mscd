# Backups, restore test and full restore

This guide explains how the MSCD SaaS server keeps copies of its data somewhere else, how a weekly test proves those copies can be restored, and how to rebuild the service on a new server from them. It belongs to work package M2-S07 of the [Milestone 2 plan](../platform/MILESTONE-2.md#m2-s07-backups-and-restore-test).

On the production and staging servers the backup runs by itself every night, and the restore test runs by itself every week on GitHub. Nobody types the commands below in normal operation; they are for setting up, checking and recovering.

## How it works in short

1. Every night at **02:00 UTC** (09:00 WIB) a systemd timer on the server starts `deploy/backup/backup.sh run`. The service keeps running while it works.
2. It copies three things to an **off-site bucket**, an S3-compatible bucket at a second provider or region:
   - the **database**: a `pg_dump` of the database `mscd`, which holds every organisation;
   - the **vault**: the evidence files of the Managed Vault, already encrypted by the storage gateway;
   - the **host files**: the secret files of the server, its settings (`.env`), its deploy state and the signed audit anchor lines of the last 25 hours.
3. The database dump and the host files are encrypted with **restic** before they leave the server. Only someone with the restic password can read them.
4. Old copies are removed on a fixed plan: **14 daily, 8 weekly and 12 monthly** copies are kept (decision D-S6). The newest copy is never more than about 24 hours old (the **recovery point**).
5. Each successful night pings the `backup` heartbeat check and writes the time of the success for the monitoring, which alerts when it gets older than 26 hours ([monitoring.md](monitoring.md#backuptooold)).
6. Every deploy also sends its pre-deploy database dump off-site before it changes anything.
7. Every Monday a GitHub workflow, `restore-test.yml`, restores the newest copy into throwaway containers and checks that it opens. It writes the measured **restore time** into its job summary.

## What is backed up

| Part | How | Where in the bucket | Encryption |
|---|---|---|---|
| Database `mscd` (platform data, every `org_` schema, the job queue) | `pg_dump --format=custom` streamed into restic, tagged with the release and the number of organisations | `<bucket>/restic` | restic (AES-256), password `BACKUP_RESTIC_PASSWORD` |
| Pre-deploy dumps | The dump `saas-deploy.sh` takes before every deploy and rollback | `<bucket>/restic`, tag `pre-deploy` | restic |
| Vault bucket `mscd-vault` | `rclone sync` with the object metadata (each object's encryption header travels as metadata) | `<bucket>/vault` | Already sealed by the storage gateway with each organisation's data key |
| Secret files, `.env`, `state/` | One tar archive per night, owners and modes kept | `<bucket>/secrets`, opened with the second key pair | restic |
| Signed audit anchor lines of the worker (last 25 hours) | In the same archive | `<bucket>/secrets` | restic |

Not backed up, on purpose:

- The off-site and monitoring values in `secrets/backup` and `secrets/ops`. Every deploy writes them again from GitHub.
- Prometheus and Alertmanager data (30 days of metrics). A new server starts them empty.
- Caddy's certificates. A new server asks Let's Encrypt for new ones.
- Container logs, apart from the audit anchor lines.

The three key files `platform.key`, `storage.key` and `audit-anchor.key` are inside the secrets archive, but a restore never takes them from there: they must come from GitHub (and the owner's offline copies), see [Keys](#keys).

## Setting up

Do this once per server (production, and staging when it should have backups too).

1. **Bucket and keys.** The owner creates the bucket and three access keys as in section 6 of [owner-inputs.md](owner-inputs.md#6-off-site-backup-storage). Recommended bucket settings:
   - versioning on, with a lifecycle rule that removes old versions after 400 days (about the 12 monthly copies), or object lock;
   - the first key limited to the prefixes `restic/` and `vault/` when the provider allows prefix rules, else to the bucket;
   - the second key limited to the prefix `secrets/`;
   - the third key read-only on `restic/` and `vault/`, for the restore test.
2. **GitHub secrets.** In the environment `production` (and `staging`): `BACKUP_S3_ENDPOINT` (an `https://` address without a path), `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY` and `BACKUP_S3_SECRET_KEY` (first key), `BACKUP_SECRETS_ACCESS_KEY` and `BACKUP_SECRETS_SECRET_KEY` (second key), `BACKUP_RESTIC_PASSWORD`, `HEARTBEAT_BACKUP_URL`. In the environment `restore-test`: see [The weekly restore test](#the-weekly-restore-test).
3. **Deploy.** Run `deploy-prod.yml` ([deploy.md](deploy.md)). It writes one file per value to `/opt/mscd/secrets/backup/` (mode 0400, owner `deploy`) and, in its step "Off-site backup", builds the backup tools image and checks the values and the timer. Until the timer is installed, every deploy ends with the warning "mscd-backup.timer is not installed, so no nightly backup runs".
4. **Timer, once per server.** The deploy account has no root rights, so an admin of the server installs the timer over SSH:

   ```bash
   sudo bash /opt/mscd/deploy/backup/backup.sh install-timer
   ```

   It copies `mscd-backup.service` and `mscd-backup.timer` from the running release to `/etc/systemd/system` and starts the timer. Run it again when a release changes these two files; the deploy warns "differs from the copy of this release" then.
5. **First backup by hand**, so the first copy exists before the night:

   ```bash
   sudo systemctl start mscd-backup.service
   journalctl -u mscd-backup.service -n 60 --no-pager
   sudo bash /opt/mscd/deploy/backup/backup.sh status
   ```

   The heartbeat check "backup" turns green, and the go-live checklist items GL-26 and GL-27 can be ticked.

Without the `BACKUP_*` values, the first deploy works (it has no database to dump yet), but every later deploy stops at its pre-deploy copy with "The off-site backup is not set up", until the values are set or the deploy runs with `skip_backup`.

## The nightly backup

`mscd-backup.service` runs `backup.sh run` as root, because it reads the secret files of every service. The work itself happens in a short-lived container of the backup tools image, which never runs as root: it runs as the owner of the off-site values (the `deploy` account), joins the internal network `mscd` to reach PostgreSQL and the vault, and the network `egress` to reach the bucket.

A run does, in this order:

1. **Checks**: the off-site values, the backup tools image (built when missing), both restic repositories (made the first time).
2. **Guard for an empty database**: when the database holds no organisation but the newest off-site dump holds some, the run stops. This is a new server waiting for its restore, and an empty dump must not join the copies.
3. **Database**: the dump, tagged with the release and the organisation count.
4. **Vault**: the sync. When the vault holds fewer objects than the copy, by more than a tenth of the copy, the sync stops before it changes anything. An empty vault always stops it, whatever the size of the copy, so an empty or wrong vault never empties the copy. The app removes vault objects only when an organisation is purged, so a normal night removes none. As a second stop, rclone ends the sync after deleting a tenth of the copy (at least 100 objects).
5. **Host files**: the archive, into the second repository with the second key pair.
6. **Retention**: 14 daily, 8 weekly, 12 monthly. On Sundays the data no copy needs any more is also removed (`prune`).
7. **Reporting**: the heartbeat ping and `/opt/mscd/metrics/backup.prom`, the single line `mscd_backup_last_success_timestamp_seconds <unix time>` that node-exporter reads.

A failed part fails the run: retention, heartbeat and `backup.prom` stay as they were, so the alert and the heartbeat service notice. The output holds steps, sizes, counts and timings only, never a secret, an email address or an organisation name. It goes to the journal and to `/opt/mscd/logs/backup-run-<time>.log` (the newest 30 are kept).

The backup and the deploy share one lock. A backup that starts during a deploy waits for it (up to 3 hours). A deploy that starts during a backup waits for it (up to 45 minutes) and says so: "The off-site backup (started ...) holds /opt/mscd; waiting".

Useful commands on the server (as the admin account):

```bash
systemctl list-timers mscd-backup.timer                  # next run
journalctl -u mscd-backup.service --since yesterday      # last run
sudo bash /opt/mscd/deploy/backup/backup.sh status       # last success, timer, newest copies
sudo bash /opt/mscd/deploy/backup/backup.sh list         # every database and pre-deploy dump
sudo systemctl start mscd-backup.service                 # a backup now
```

## The pre-deploy copy

Before a deploy or rollback changes anything, `saas-deploy.sh` takes a `pg_dump` to `/opt/mscd/backup/pre-deploy` (the newest 3 stay on the server) and runs:

```bash
deploy/backup/backup.sh --pre-deploy <dump file> --install-dir /opt/mscd
```

It sends the dump to the restic repository with the tag `pre-deploy`. Exit code 0 means the off-site copy is done. Any other code stops the deploy before anything changes; code 3 means the off-site values are not set. When the backup itself is the problem, the owner can run the deploy with `skip_backup`, which also skips the local dump ([deploy.md](deploy.md)).

## The weekly restore test

A backup counts only when a restore has worked. `restore-test.yml` runs every Monday at 05:17 UTC and by hand:

```bash
gh workflow run restore-test.yml
gh workflow run restore-test.yml -f target_version=v1.2.0
```

On a GitHub runner, so the production server carries no load, it:

1. reads the newest database dump with the **read-only key**;
2. checks the signature of the server image of the target release (the release of the backup, or `target_version`);
3. starts PostgreSQL and SeaweedFS in throwaway containers, with new passwords and with copies of the production `platform.key` and `storage.key` (decision D-S12);
4. restores the dump, and copies back the newest 3 vault objects of every organisation;
5. runs **migrate of the target release** on the restored database. With `target_version` set to the next release, this is the **migration rehearsal**: it shows, on real data and before customers feel it, whether the database changes of that release work and how long they take ([deploy.md](deploy.md#release-order));
6. starts storage-gateway and api and checks `/readyz`;
7. runs `mscd-server backup verify`: the database and the gateway answer; every organisation's data key opens in the gateway; the sampled vault files open and match their SHA-256; values sealed with `platform.key` open; every audit chain is intact and its newest row is covered by its newest signed anchor;
8. checks with SQL that the organisation count equals the one of the dump, and that the newest entry of the platform audit log is under 26 hours old;
9. writes the summary (below) and pings the `restore-test` heartbeat; everything it made is removed at the end.

The job summary shows the backup used and its age, the target release and how long its migration took, the dump size and organisation count, the vault sample, the verify result and the **restore time objective (measured)**: the minutes from fetching the dump until the checks passed. A full restore takes longer, because it also copies the whole vault; the summary shows the size of the off-site vault copy so that time can be estimated. Write the measured time into GL-28 of the [go-live checklist](go-live-checklist.md).

Environment `restore-test`, limited to the default branch:

| Name | Kind | Value |
|---|---|---|
| `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET` | secret | As in `production` |
| `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY` | secret | The read-only key |
| `BACKUP_RESTIC_PASSWORD` | secret | As in `production` |
| `PLATFORM_KEY`, `STORAGE_KEY` | secret | Copies of the production keys (D-S12) |
| `HEARTBEAT_RESTORE_URL` | secret | The ping address of the heartbeat check "restore test" |

The audit log check fails when nobody used the service for a whole day, for example before go-live. That is the check doing its job: the backup cannot prove it holds yesterday's data. Sign in once and run the test again.

### Where the restore test runs

The test copies the newest production database to a GitHub-hosted runner for the length of the job. Those runners are outside Indonesia, so this is a transfer abroad that the lawyer must accept (GL-49 and the decision "Restore test location" in the [go-live checklist](go-live-checklist.md)). When the lawyer asks for a runner in Indonesia, register a self-hosted runner there and set the repository variable `RESTORE_TEST_RUNNER` to its label; `runs-on` of the workflow reads it, and nothing else changes. Give that runner its own runner group, allowed for this workflow only, because the repository is public.

The workflow log and summary show versions, timings, sizes and counts, and organisations by id at most (GL-50).

## Full restore onto a new server

Use this when the server is lost or cannot be trusted any more (disk failure, provider outage, a break-in). It rebuilds the service from the newest off-site copy. Every change made after that copy is lost; with the nightly backup that is at most about a day. Follow [incident-response.md](incident-response.md) for who decides and who tells the customers.

You need:

- the GitHub environment of the server, with the same `PLATFORM_KEY`, `STORAGE_KEY` and `AUDIT_ANCHOR_KEY` as before. When GitHub lost them, put back the owner's offline copies first (GL-21). The data opens only with the keys it was sealed with;
- the `BACKUP_*` secrets of that environment;
- the release that ran (the restore prints it), or a newer one.

Steps:

1. **New server.** Buy and bootstrap it as in [bootstrap.md](bootstrap.md), then update `DEPLOY_HOST` and `DEPLOY_SSH_KNOWN_HOSTS` in the GitHub environment.
2. **DNS.** Point the A and AAAA records of `app.<domain>` (and `ops.<domain>`) to the new server. Caddy gets new certificates once the names point there.
3. **Deploy.** Run `deploy-prod.yml` with the release that ran. On the new server this is a first deploy: it brings the release files, the images, the key files and the off-site values, and starts an empty service.
4. **Restore.** On the server, as the admin account:

   ```bash
   sudo bash /opt/mscd/deploy/backup/restore.sh
   ```

   It shows the copy it will restore (time, release, organisation count) and asks before it changes anything. It then:
   - fetches the dump and the host files into `/opt/mscd/backup/restore-<time>/`;
   - checks that the key files of the server are the keys of the backup, and stops when they differ;
   - puts back every other secret file of the backup (database passwords, gateway token, object store identity, internal certificates) and keeps the replaced ones in `secrets-before/`;
   - stops every service, deletes the database and vault volumes, restores the database in one transaction and copies the vault back;
   - runs migrate, starts storage-gateway, api, worker, web and Caddy, then runs `ops-init` once, which makes the database role `mscd_monitor` of the monitoring again, and starts the monitoring;
   - checks `/readyz`, `/healthz` through Caddy, `mscd-server backup verify` and the organisation count;
   - installs `mscd-backup.timer`.
5. **After the restore.**
   - Take a backup now: `sudo systemctl start mscd-backup.service`.
   - Check that the alert emails and the heartbeats are green ([monitoring.md](monitoring.md)).
   - Sign in as an operator and as a customer user and open some evidence files.
   - Delete `/opt/mscd/backup/restore-<time>/` once all is well.
   - Record the incident and tell the customers what was lost ([incident-response.md](incident-response.md)).

Options of `restore.sh`:

| Option | Use |
|---|---|
| `--snapshot <id>` | Restore an older copy, or a pre-deploy dump. `backup.sh list` shows the ids |
| `--host-files-snapshot <id>` | Take the secret files from another night (default: the newest) |
| `--vault-at <time>` | Copy the vault back as it was at that time (for example `2026-10-01T02:00:00Z`), from the old versions the bucket keeps. Use it with an older `--snapshot`, when files were deleted since |
| `--keep-secrets` | Keep the secret files of this server. For a restore on the same server, whose secrets are intact |
| `--no-timer` | Do not install the timer |
| `--yes` | No question (for scripts) |

### Restoring on the same server

When the server works but its data is damaged (for example a bad migration or a mistaken bulk change), the same script restores an older copy in place:

```bash
sudo bash /opt/mscd/deploy/backup/backup.sh list
sudo bash /opt/mscd/deploy/backup/restore.sh --snapshot <id> --keep-secrets
```

For damage done by the last deploy, the local pre-deploy dump is faster ([deploy.md](deploy.md#restoring-the-database)).

## Keys

Three secrets decide whether the copies can ever be read again:

- `BACKUP_RESTIC_PASSWORD` opens the database dumps and the host files;
- `platform.key` and `storage.key` open the data inside them (sealed values and the organisations' data keys).

GitHub secrets cannot be read back. The owner keeps offline copies of all three in a password manager and opens them once to check they work (GL-10, GL-21). Losing one of them makes every backup unreadable.

## Updating the backup tools

The backup tools image is built on the server from `deploy/docker/backup.Dockerfile`: the PostgreSQL 16 client tools of `postgres:16.15-alpine` plus `restic` and `rclone` from the Alpine packages. The base image is pinned by tag and digest, and both packages by exact version, each at least two weeks old (rule S-5). The image is tagged `mscd-backup:<hash of the Dockerfile>`, so the server builds it again only when the file changes.

Alpine keeps only the newest build of each package. When Alpine replaces a pinned build, the build fails with "apk could not install restic=... and rclone=...": the nightly backup, the deploy check and the restore test say so. To fix it:

1. Find the current versions: `docker run --rm postgres:16.15-alpine sh -c 'apk update -q && apk policy restic rclone'`.
2. Wait until they are two weeks old (the build date is in `apk info -a`), then set `RESTIC_PKG_VERSION` and `RCLONE_PKG_VERSION` in the Dockerfile.
3. Run `bash deploy/backup/restore-test.sh --local` on a build host, release and deploy.

The base image digest is updated the same way: take the digest of a `postgres:16.15-alpine` build that is at least two weeks old (or of a newer PostgreSQL 16 tag that the database service of the stack also runs), set it in `BASE_IMAGE`, and test as in step 3. `.github/dependabot.yml` watches `deploy/docker`, but the base image of this file is a build argument, which Dependabot may not read, so do not wait for a proposal.

## Troubleshooting

| What you see | Cause and fix |
|---|---|
| The deploy stops with "The off-site backup is not set up (... missing)" | The `BACKUP_*` secrets of the GitHub environment are missing. Set them and deploy again, or deploy once with `skip_backup` |
| "does not open with BACKUP_RESTIC_PASSWORD (wrong password)" | The secret holds another password than the one the repository was made with. Put back the owner's offline copy |
| "The repository ... cannot be read" or rclone errors | The endpoint, bucket or keys are wrong, or the bucket provider is down. Check with the provider; the next night tries again |
| "The backup tools image could not be built" | See [Updating the backup tools](#updating-the-backup-tools). Behind a TLS-inspecting proxy, set `MSCD_BUILD_CA` |
| "the sync would delete more than N" | The vault holds fewer objects than the copy, by more than a tenth of the copy (or none at all). Find out why before anything else (a wrong volume, a lost disk). When the deletions are right (for example after organisations were purged), run `sudo bash /opt/mscd/deploy/backup/backup.sh run --allow-vault-deletes` once |
| "looks like a new server waiting for its restore" | The database is empty but the copies are not. Restore first. When the organisations were really removed, run `backup.sh run --allow-empty` once |
| Alert BackupTooOld or BackupMissing | Read `journalctl -u mscd-backup.service --since yesterday`. On a new server, the timer may not be installed (`backup.sh install-timer`) |
| A deploy waits "The off-site backup (started ...) holds /opt/mscd" | The nightly backup runs; the deploy goes on when it ends. When it waits 45 minutes, check the backup with `journalctl -u mscd-backup.service -f` |
| `restore.sh` stops with "platform.key of this server differs from platform.key of the backup" | GitHub holds other keys than the backup. Put the owner's offline copies into the GitHub environment, deploy again, then run `restore.sh` again |
| `restore.sh` stops part way | Fix the cause it shows and run it again; it starts over from the off-site copy. The fetched files and `secrets-before/` are in the restore folder it names |
| The restore test fails at migrate | The migration of the target release does not work on real data. Do not deploy that release; fix it in a new one |
| The restore test fails "Newest platform audit_log entry ... not under 26 hours" | Nobody used the service for a day, or the nightly backup is old (BackupTooOld). See [The weekly restore test](#the-weekly-restore-test) |
| `postgres-exporter` reports `pg_up 0` after a restore | `ops-init` did not run. `cd /opt/mscd/deploy/compose && sudo docker compose up -d ops-init` |

## Files

| File | Content |
|---|---|
| `deploy/backup/backup.sh` | Nightly backup, pre-deploy copy, image, status, list, timer install and the deploy check |
| `deploy/backup/backup-run.sh` | The commands that run inside the backup container (restic, rclone, pg_dump) |
| `deploy/backup/restore.sh` | Full restore of a server |
| `deploy/backup/restore-test.sh` | The weekly restore test (`--ci`) and the end-to-end test of a build host (`--local`) |
| `deploy/backup/lib.sh` | Shared helpers |
| `deploy/docker/backup.Dockerfile` | The backup tools image |
| `deploy/compose/docker-compose.backup.yml` | The on-demand `backup` service (profile `backup`; a deploy never starts it) |
| `deploy/host/systemd/mscd-backup.{service,timer}` | The nightly timer |
| `.github/workflows/restore-test.yml` | The weekly restore test |
| `apps/server/src/cli/backup.ts` | `mscd-server backup verify` |

## Testing on a build machine

```bash
npm run test:int -w @mscd/server -- test/int/backup          # backup verify against a real database and gateway
flock /tmp/mscd-stack.lock bash deploy/backup/restore-test.sh --local
```

`restore-test.sh --local` runs the whole cycle on the SaaS test stack of [stack.md](stack.md) (ports 18080 and 18443, hence the host lock): two organisations with signed audit anchors and probe files, a second SeaweedFS as the off-site bucket (reached only through the network `egress`), the nightly backup, the pre-deploy copy, both guards (the vault guard also with an empty vault and the default limits), the loss of the server, `restore.sh`, the checks after it, and the weekly restore test with the read-only key, run as a user that is not root and reaches Docker through the docker group, as on a GitHub runner. It removes everything it made, and keeps its logs in `/var/tmp/<project>-logs`. `--down` removes what a stopped run left.
