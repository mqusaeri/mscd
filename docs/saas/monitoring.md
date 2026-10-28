# Monitoring and alerts

This guide explains how the MSCD SaaS server watches itself and tells you when something is wrong: what runs, where the alerts go, what each alert means and what to do first, how to set up the outside checks that notice when the whole server is down, and how long the monitoring data is kept. It belongs to work package M2-S08 of the [Milestone 2 plan](../platform/MILESTONE-2.md#m2-s08-monitoring-and-alerts).

On the production and staging servers nobody types these commands by hand in normal operation. The deploy workflow (`deploy-prod.yml`, M2-S05) writes the settings and starts the monitoring together with the app. The commands below are for reading and fixing.

## How it works in short

1. **Prometheus** collects numbers ("metrics") every 30 seconds from the MSCD processes, the database, the server itself and a probe of the public address, and keeps them for 30 days.
2. Every 30 seconds Prometheus checks the **alert rules** of `deploy/ops/prometheus/rules/`. When a rule is true for long enough, the alert fires.
3. **Alertmanager** sends firing alerts by **email** to the alert address, and by **Telegram** when a bot is set up. It sends a second message when the problem is gone ("Resolved").
4. One alert, the **Watchdog**, always fires. Alertmanager sends it every minute to an outside **heartbeat** service. The pings stop when the server, Prometheus or Alertmanager is down, and also when alert emails cannot be sent: then Alertmanager mutes the Watchdog on purpose ([AlertDeliveryFailing](#alertdeliveryfailing)). Either way the heartbeat service alerts you by its own email. A server that is fully down, or that cannot send email, cannot tell you itself, so this outside check is the only way to hear about it.
5. A separate outside **uptime check** opens `https://<domain>/healthz` from the internet every few minutes, the way a customer would.

## What runs

The monitoring overlay `deploy/compose/docker-compose.ops.yml` adds these services to the SaaS stack of [stack.md](stack.md). None of them publishes a port.

| Service | Image | Job | Networks | Memory limit |
|---|---|---|---|---|
| `ops-init` | `postgres:16.15-alpine` (the database image) | Runs once at every start: creates the read-only database role `mscd_monitor`, writes the probe target and the Alertmanager settings, and the optional Grafana site | mscd | 128 MB |
| `prometheus` | `prom/prometheus:v3.13.4` | Collects the metrics, keeps 30 days, checks the alert rules | mscd | 768 MB |
| `alertmanager` | `prom/alertmanager:v0.34.1` | Sends the alerts by email and Telegram, pings the heartbeat | mscd, egress | 128 MB |
| `node-exporter` | `prom/node-exporter:v1.12.1` | The server: processor, memory, disks, and the files of `/opt/mscd/metrics` | mscd | 64 MB |
| `postgres-exporter` | `prometheuscommunity/postgres-exporter:v0.20.1` | The database, signed in as `mscd_monitor` | mscd | 64 MB |
| `blackbox-exporter` | `prom/blackbox-exporter:v0.29.0` | Opens `https://<domain>/healthz` and reads the certificate's expiry date | mscd, egress | 64 MB |
| `grafana` | `grafana/grafana:13.2.4` | Optional dashboards at `ops.<domain>` (profile `grafana`) | mscd, ops-web | 384 MB |

Together they use about 1.5 GB of memory at most. Every image is pinned by version and digest. The services run with a read-only file system, without extra privileges, and with all Linux capabilities dropped (`ops-init` keeps three: reading the secret files of other users and handing its output files to the user of the service that reads them).

`mscd` is the internal network of the stack: it has no route out of the server. Only Alertmanager (mail, Telegram, heartbeat) and the probe (the public address) are also on `egress`. Caddy, the only container that faces the internet, stays off `mscd`, so it has no way to the database, the object store or the storage gateway. It reaches Grafana over `ops-web`, a second internal network that holds only Caddy and Grafana. Prometheus does not read Caddy's own metrics; the probe of the public address checks Caddy from outside, and Caddy's admin endpoint stays inside its container.

What Prometheus reads:

| Target | Address | What it shows |
|---|---|---|
| `api`, `worker`, `storage-gateway` | port 9464 of each | Requests and errors, job runs and failures, queue age, licence days left, audit chain state, refused requests, second-factor lockouts |
| `node` | `node-exporter:9100` | Processor, memory, disks; `reboot.prom` of the reboot marker (M2-S03) and `backup.prom` of the backup script (M2-S07) |
| `postgres` | `postgres-exporter:9187` | Database up, connections, size, locks (no per-table numbers, which would grow with every organisation) |
| `public-url` | through `blackbox-exporter:9115` | `https://<domain>/healthz` answers 200, certificate expiry |
| `prometheus`, `alertmanager`, `blackbox` | their own ports | The monitoring itself, including failed alert deliveries |

Each target also carries the label `service`: the Compose service to look at when it does not answer. It differs from the target name for `node` (`node-exporter`), `postgres` (`postgres-exporter`), `blackbox` and `public-url` (both `blackbox-exporter`).

## Settings

The monitoring reads two kinds of settings. Nobody edits them on the server; the deploy writes them.

**The app's mail settings.** Alerts go through the same mail provider as the app's emails: `MSCD_SMTP_HOST`, `MSCD_SMTP_PORT`, `MSCD_SMTP_USER` and `MSCD_MAIL_FROM` of `.env`, and the secret file `smtp.password`. On port 587 the connection must switch to TLS (STARTTLS) before the password is sent.

**The monitoring settings of the GitHub environment** (K.2 of the plan). `deploy-prod.yml` writes each one as a file of the same name in `/opt/mscd/secrets/ops/` (mode 0400):

| File | GitHub | Needed | What it is |
|---|---|---|---|
| `ALERT_EMAIL_TO` | variable | yes | The alert address, or several separated by commas. Without it `ops-init` stops and the monitoring does not start |
| `HEARTBEAT_WATCHDOG_URL` | secret | strongly advised | The ping address of the "watchdog" check of the heartbeat service |
| `TELEGRAM_BOT_TOKEN` | secret | optional | The token of the Telegram bot |
| `TELEGRAM_CHAT_ID` | variable | with the token | The chat (or group) the bot writes to |
| `OPS_DOMAIN` | variable | for Grafana | The host name of the dashboards, for example `ops.example.com` |
| `OPS_BASIC_AUTH_USER` | variable | for Grafana | The user name for the dashboards (default `ops`) |
| `OPS_BASIC_AUTH_HASH` | secret | for Grafana | The bcrypt hash of the dashboard password, made with `caddy hash-password` ([Dashboards](#dashboards-optional)) |

`ops-init` checks every value before it changes anything, and stops with a clear message when a value is wrong (for example a Telegram token without a chat id). It never prints the alert address, the heartbeat address or a secret. The secrets reach Alertmanager as separate files that only Alertmanager can read; the rendered configuration holds none of them.

Optional settings in `.env` (the defaults suit production):

| Setting | Default | Meaning |
|---|---|---|
| `MSCD_OPS_SMTP_HOST`, `MSCD_OPS_SMTP_PORT`, `MSCD_OPS_SMTP_USER`, `MSCD_OPS_MAIL_FROM` | the app's values | Another mail relay for the alerts only |
| `MSCD_OPS_SMTP_REQUIRE_TLS` | `true` | `false` allows a relay without TLS (tests only) |
| `MSCD_OPS_PROBE_URL` | `<MSCD_PUBLIC_URL>/healthz` | The address the probe opens |
| `MSCD_METRICS_DIR` | `/opt/mscd/metrics` | The folder of `reboot.prom` and `backup.prom` |
| `MSCD_PROMETHEUS_MEMORY`, `MSCD_ALERTMANAGER_MEMORY`, `MSCD_GRAFANA_MEMORY` | 768M, 128M, 384M | Memory limits |

## Setting up the outside checks

Do this before the first deploy with monitoring. The go-live checklist asks for it in GL-33 and GL-34.

### Heartbeat service

Any service that alerts when expected pings stop works. With [healthchecks.io](https://healthchecks.io):

1. Create a project and set its email integration to the owner's address (and a second person).
2. Create three checks:

   | Check | Period | Grace time | Who pings it |
   |---|---|---|---|
   | `watchdog` | 1 minute | 5 minutes | Alertmanager, about every minute (this guide) |
   | `backup` | 1 day | 2 hours | The nightly backup at 02:00 UTC (M2-S07, [backup-restore.md](backup-restore.md)) |
   | `restore-test` | 7 days | 1 day | The weekly restore test (M2-S07) |

3. Copy each check's ping address into GitHub: `HEARTBEAT_WATCHDOG_URL` and `HEARTBEAT_BACKUP_URL` in the environments `production` and `staging` (one check set per environment), `HEARTBEAT_RESTORE_URL` in `restore-test` ([owner-inputs.md](owner-inputs.md#7-monitoring-accounts)).
4. Deploy. Within two minutes the `watchdog` check turns green.

### Uptime check

Use an uptime service in a region near Indonesia (for example Singapore) to open `https://<domain>/healthz` every 1 to 5 minutes and expect status 200. Send its alerts to the owner by email (and by text message when the service offers it). This check sees what customers see: DNS, the network of the provider, the firewall, Caddy and the certificate. It also gives the monthly uptime number for the 99.5 percent target (D-S7).

### Telegram (optional)

1. In Telegram, talk to `@BotFather`, send `/newbot` and follow the steps. Keep the token it gives you secret.
2. Add the bot to the group that should receive alerts (or start a chat with it) and send it one message.
3. Open `https://api.telegram.org/bot<token>/getUpdates` in a browser and read `chat` then `id` (a group id starts with `-`).
4. Set the secret `TELEGRAM_BOT_TOKEN` and the variable `TELEGRAM_CHAT_ID` in the GitHub environment and deploy.

### Test alert

After the first deploy with monitoring, send a test alert and write down when it arrived (GL-33). On the server, as the admin account, in `/opt/mscd/deploy/compose`, the folder of the running release ([deploy.md](deploy.md#commands-on-the-server)). Compose reads `.env` there, which names every Compose file of the deploy and the project, so the commands work on the same services as the deploy:

```bash
cd /opt/mscd/deploy/compose
C="sudo docker compose"
$C exec alertmanager amtool alert add MscdTestAlert severity=warning \
  --annotation=summary="Test alert, please ignore" --annotation=action="Nothing to do." \
  --alertmanager.url=http://127.0.0.1:9093
```

The email "[MSCD <domain>] Alert: MscdTestAlert" arrives within about a minute, and a Telegram message when Telegram is set up. The alert ends by itself after 5 minutes and then sends "Resolved".

## The alerts

Every alert email has the subject `[MSCD <domain>] Alert: <name>` and gives, for each alert, what is wrong, the first step and the start time in UTC (WIB is UTC + 7). **Critical** alerts repeat every hour while they last, **warnings** every 4 hours.

| Alert | Fires when | Severity |
|---|---|---|
| [TargetDown](#targetdown) | A target has not answered for 2 minutes | critical |
| [PublicUrlDown](#publicurldown) | `https://<domain>/healthz` has failed for 2 minutes | critical |
| [DatabaseDown](#databasedown) | PostgreSQL has not been reachable for 2 minutes | critical |
| [HttpErrorRateHigh](#httperrorratehigh) | More than 2 percent of requests end in a server error, for 10 minutes | critical |
| [AlertDeliveryFailing](#alertdeliveryfailing) | An email or Telegram alert could not be sent in the last 30 minutes; for email it also mutes the Watchdog | warning |
| [AuditChainBroken](#auditchainbroken) | An audit chain is broken or does not match its signed anchor | critical |
| [LicenceExpiringSoon](#licenceexpiringsoon) | An organisation's licence ends in less than 30 days | warning |
| [JobFailuresRising](#jobfailuresrising) | One job failed 3 times or more in 30 minutes | warning |
| [JobQueueStuck](#jobqueuestuck) | A due job has waited more than 15 minutes, for 5 minutes | warning |
| [JobOutboxStuck](#joboutboxstuck) | Job outbox rows have been stuck for 15 minutes | warning |
| [MfaLockSpike](#mfalockspike) | 3 or more second-factor lockouts in 15 minutes | warning, security |
| [AccessDeniedSpike](#accessdeniedspike) | More than 50 refused requests in 10 minutes | warning, security |
| [HostDiskFull](#hostdiskfull) | A disk is more than 80 percent full, for 15 minutes | warning |
| [HostMemoryPressure](#hostmemorypressure) | Less than 10 percent memory available, or processes waiting for memory, for 10 minutes | warning |
| [HostRebootNeeded](#hostrebootneeded) | A security update has needed a reboot for more than 7 days | warning |
| [CertificateExpiringSoon](#certificateexpiringsoon) | The certificate expires in less than 14 days | warning |
| [BackupTooOld](#backuptooold) | The last successful backup is more than 26 hours old | critical |
| [BackupMissing](#backupmissing) | No backup has reported success for 26 hours | critical |
| [Watchdog](#watchdog) | Always (goes to the heartbeat service only) | none |

The commands below use `$C` as defined in [Test alert](#test-alert). To see what Prometheus sees right now:

```bash
$C exec prometheus wget -qO- http://127.0.0.1:9090/api/v1/alerts        # firing alerts
$C exec prometheus wget -qO- http://127.0.0.1:9090/api/v1/targets       # every target and its last error
```

### TargetDown

**What it means.** Prometheus could not read the numbers of one service for 2 minutes. The email names the target (`job`) and, in the first step, the Compose service to look at (for example `node-exporter` for the target `node`). For `api`, `worker` or `storage-gateway` the app is probably affected; for an exporter only the monitoring is.

**First step.** `$C ps` shows the state of every container. Read the last lines of the service's log: `$C logs --tail 100 <service>`. A container that restarts again and again often ran out of memory (`docker inspect <container> --format '{{.State.OOMKilled}}'`). Start it again with `$C up -d <service>`.

### PublicUrlDown

**What it means.** The server could not open `https://<domain>/healthz` with a valid certificate and status 200 for 2 minutes. Customers probably cannot use the app.

**First step.** Open the address in a browser. Then check Caddy and the web container: `$C ps caddy web` and `$C logs --tail 100 caddy`. If the outside uptime check is green while this alert fires, the server cannot reach its own public address (DNS inside the server, or the provider's network); the app itself works.

### DatabaseDown

**What it means.** The database does not accept connections. The app cannot work without it.

**First step.** `$C ps postgres` and `$C logs --tail 100 postgres`. Look for a full disk (`df -h`) and for "out of memory". Do not delete anything in the database volume; restore from a backup only as described in [backup-restore.md](backup-restore.md).

### HttpErrorRateHigh

**What it means.** More than 2 percent of the requests of the api (or the storage gateway) ended in a server error (status 500 to 599) for 10 minutes. Users see error messages.

**First step.** Read the error lines of the named service: `$C logs --since 15m api | grep -i error`. A fresh deploy is a likely cause; rolling back is described in [deploy.md](deploy.md). Errors only for file actions point to the storage gateway or a customer's storage provider.

### AlertDeliveryFailing

**What it means.** Alertmanager could not send an alert by email (or Telegram). Other alerts may not reach you either. When email fails, this alert itself may not reach you by email, so Alertmanager also mutes the [Watchdog](#watchdog) while it lasts (until 30 minutes after the last failed send): the heartbeat pings stop and the heartbeat service warns you by its own email. A failure of Telegram alone does not mute the Watchdog, because the email reports it.

**First step.** `$C logs --tail 50 alertmanager` names the error. Check the mail provider's account (quota, a changed password), the sending domain records (SPF, DKIM, DMARC; GL-08) and, for Telegram, that the bot is still in the group.

### AuditChainBroken

**What it means.** The nightly check of the audit trail found that a chain of audit entries is broken, or does not match its newest signed anchor. Entries may have been changed or removed. This can be an attack, so treat it as a possible security incident.

**First step.** Open an incident log at once, following [incident-response.md](incident-response.md) (SEV-2). Do not change data or restart services before the evidence is copied. The email names the chain (`platform` or an organisation).

### LicenceExpiringSoon

**What it means.** The licence or plan of the named organisation ends in less than 30 days (a negative number means it has already ended).

**First step.** Contact the customer about the renewal, and renew or change the plan from the operator console.

### JobFailuresRising

**What it means.** A background job (for example sending emails, building an export, checking file links) failed 3 times or more within 30 minutes. Failed jobs are retried, so single failures are normal; repeated ones are not. The count includes the first failure of a job since the worker started.

**First step.** `$C logs --since 1h worker | grep '"job":"<job name>"'` shows the error. Errors that name a provider (mail, Microsoft 365, Google Drive) usually mean that provider is down or a credential has expired.

### JobQueueStuck

**What it means.** A job of this queue has been due for more than 15 minutes and was still waiting 5 minutes later. A job is due from its start time: the moment it was sent, or the later time it was planned for. A job that failed and waits to be tried again is due from the time of that retry (with the BullMQ job driver, which the SaaS stack does not use, a retry already back in the waiting list counts from the start of its failed run, a little early). The hourly scheduler queues the daily jobs of each organisation up to 54 minutes before their start time (for example at 02:05 for a job at 02:45); those jobs do not count until their start time comes, so a planned wait never raises this alert. When the alert fires, a job that should have run is still waiting: emails, reminders or exports are delayed.

**First step.** Check that the worker runs and is healthy: `$C ps worker` and `$C logs --tail 100 worker`. Restart it with `$C restart worker` when it hangs.

### JobOutboxStuck

**What it means.** Jobs written by the app cannot be handed to the job queue. This applies only to the BullMQ job driver with Valkey; the SaaS stack uses pg-boss, where the number stays 0.

**First step.** Check the worker log and Valkey (`$C ps valkey`).

### MfaLockSpike

**What it means.** Three or more accounts were locked within 15 minutes after wrong second-factor codes. Someone may be trying stolen passwords. This is an early sign of a possible breach.

**First step.** List the lockouts of the last hour from the platform audit log:

```bash
$C exec postgres psql -U postgres -d mscd -c "SELECT occurred_at, organization_id, actor_user_id, source_ip
  FROM platform.audit_log WHERE action = 'auth.mfa_locked' AND occurred_at > now() - interval '1 hour'
  ORDER BY occurred_at DESC"
```

Many lockouts from one address or against one organisation: open an incident log ([incident-response.md](incident-response.md), SEV-2). UU PDP requires the written notice of a personal data breach within 3 x 24 hours, so look at it the same day. Each locked person also got an email and may contact support.

### AccessDeniedSpike

**What it means.** More than 50 requests were refused by the permission check within 10 minutes. Someone may be probing for data of other organisations or roles. This is an early sign of a possible breach. The count includes the first refusal on each address of the app since the api started.

**First step.** Find the accounts and addresses behind the refused requests in the api log: `$C logs --since 1h api | grep '"statusCode":403'` (each line has the user and organisation id and the address). Each refusal is also in the audit trail of its organisation as `authz.denied`. One user clicking an old link is harmless; one account or address trying many records or organisations is not: open an incident log as for MfaLockSpike.

### HostDiskFull

**What it means.** A disk of the server is more than 80 percent full. When it is full, the database stops.

**First step.** `df -h` shows which disk. `docker system df` shows how much images, volumes and the build cache use. Release images older than the last 3 can be removed with `docker image rm <image>` (the deploy keeps the last 3). Never delete a volume. If the data disk keeps growing, enlarge the block volume at the provider.

### HostMemoryPressure

**What it means.** The server has less than 10 percent of its memory free, or processes often wait for memory. Containers may be stopped by the system.

**First step.** `docker stats --no-stream` shows the memory of every container. A container near its limit for a long time needs a higher limit (`MSCD_*_MEMORY`) or a larger server.

### HostRebootNeeded

**What it means.** A security update was installed more than 7 days ago that only takes effect after a reboot (for example a new kernel).

**First step.** Reboot in the next maintenance window (Sunday 22:00 to 24:00 WIB, D-S7) and announce it. The containers start again by themselves.

### CertificateExpiringSoon

**What it means.** The certificate of the public address expires in less than 14 days. Caddy renews it when a third of its lifetime is left (30 days for today's 90-day certificates), so renewal has failed for some time.

**First step.** `$C logs caddy | grep -i -E 'acme|certificate|error'`. Common causes: the A or AAAA record no longer points to the server, port 80 is blocked (the HTTP challenge needs it), or a CAA record does not allow `letsencrypt.org`. If certificates get shorter lifetimes in future, keep this threshold below the renewal point.

### BackupTooOld

**What it means.** The last successful backup is more than 26 hours old, so the recovery point of 24 hours (D-S6) is no longer met.

**First step.** Read the log of the last backup run (`journalctl -u mscd-backup.service --since yesterday`) and follow [backup-restore.md](backup-restore.md). The `backup` heartbeat check also turns red.

### BackupMissing

**What it means.** No backup has reported success on this server for 26 hours, for example on a new server where the backup timer was never installed.

**First step.** Check the timer: `systemctl list-timers mscd-backup.timer`, then run a backup by hand as described in [backup-restore.md](backup-restore.md).

### Watchdog

**What it means.** Nothing is wrong. This alert always fires so that the heartbeat service gets a ping about every minute. It never sends an email. While alert emails fail ([AlertDeliveryFailing](#alertdeliveryfailing)), Alertmanager mutes it, so the heartbeat service warns you.

**First step.** None. If the heartbeat service reports that the `watchdog` pings stopped, check in this order: the server answers (uptime check, SSH), `$C ps alertmanager prometheus`, and `$C logs --tail 50 alertmanager` (an error about email means alert emails fail: see [AlertDeliveryFailing](#alertdeliveryfailing)).

## Planned work and silences

During announced maintenance, silence the alerts it will cause, so nobody is woken up for nothing:

```bash
$C exec alertmanager amtool silence add alertname=~"PublicUrlDown|TargetDown|HttpErrorRateHigh" \
  --duration 2h --comment "Maintenance window" --alertmanager.url=http://127.0.0.1:9093
$C exec alertmanager amtool silence query --alertmanager.url=http://127.0.0.1:9093
```

A silence of these alerts does not stop the Watchdog, so the heartbeat stays green. The outside uptime check still sees the maintenance; pause it there as well, or count the window as announced maintenance (D-S7).

## Dashboards (optional)

Grafana shows the dashboard "MSCD overview" (health, requests, jobs, licences, security signals and the server) at `https://ops.<domain>`, behind a password that Caddy checks. Signed-in people can look at dashboards and run their own queries (Explore); nobody can change the dashboards in the browser. To turn it on:

1. Add a DNS A record (and AAAA when the app has one) for `ops.<domain>` pointing to the server.
2. On your own computer, make the password hash: `docker run --rm -it caddy:2.11.7-alpine caddy hash-password` (type the password twice). Keep the password in the password manager.
3. In the GitHub environment set the variable `OPS_DOMAIN`, the secret `OPS_BASIC_AUTH_HASH` and, when the user name should differ from `ops`, the variable `OPS_BASIC_AUTH_USER`. When `OPS_DOMAIN` is set, the deploy adds the `grafana` profile by itself, so Grafana starts.
4. Deploy. `ops-init` writes the site of `ops.<domain>`, and the deploy then reloads Caddy so it reads the site. The dashboards work when the deploy ends; nothing needs a restart. When the deploy log warns "Caddy refused the configuration of the monitoring overlay", see [Troubleshooting](#troubleshooting).

Grafana has no route out of the server, does not check for updates and keeps no administrator account: provisioning sets up the data source and the dashboard. It sits on the internal networks `mscd` (to read Prometheus) and `ops-web` (where only Caddy reaches it); no port of Grafana is published.

## Retention of logs and monitoring data

| Data | Where | Kept for | Personal data in it |
|---|---|---|---|
| Container logs of every service (access logs of Caddy and NGINX, app logs) | Docker `local` log driver on the server | 10 files of 20 MB per container, rotated by size; the oldest file is deleted. A deploy or restart that recreates a container starts its logs again | Network addresses, paths without query values, user and organisation ids in app logs |
| Signed audit anchor lines of the worker | Off-site backup bucket (M2-S07, the last 25 hours of each night's run) | As the backups: 14 daily, 8 weekly, 12 monthly (D-S6), so up to about 12 months | No personal data: chain heads and signatures |
| Metrics | Prometheus volume on the server | 30 days (at most 8 GB) | Organisation slugs (licence days), route names; no names or email addresses |
| Alert state and silences | Alertmanager volume on the server | 5 days (Alertmanager default) | As in the alerts |
| Alert emails and Telegram messages | The mail provider, the alert mailbox, Telegram | The provider's and the mailbox's own periods | Alert names, organisation slugs, service names |
| Watchdog pings | Heartbeat service | The service's own period | None (the alert "Watchdog" only) |
| Grafana | Grafana volume on the server | While Grafana is on | The user names that signed in |

The owner writes these periods into the privacy notice and the records of processing ([records-of-processing.md](records-of-processing.md#retention-periods), GL-52 and GL-53), and lists the heartbeat service, the uptime service and Telegram (when used) as subprocessors with their locations (GL-48, GL-55). After the first month, measure how many days the container logs cover (`docker inspect --format '{{.LogPath}}' <container>` and the dates of the oldest lines) and write the number there.

Logs on the server rotate by size and restart with each new container. Before a rollback or restart during an incident, copy them first ([incident-response.md](incident-response.md)).

## Changing an alert

1. Edit the rule in `deploy/ops/prometheus/rules/` (one file per topic), with a plain `summary` and `action`, and a section in this guide.
2. Add or change its test in `deploy/ops/prometheus/tests/alerts.test.yml`: when it must not fire, when it fires, and the exact text.
3. Run the checks:

   ```bash
   bash deploy/ops/test-ops.sh --static                         # promtool, amtool, ops-init, Caddy, dashboard
   flock /tmp/mscd-stack.lock bash deploy/ops/test-ops.sh       # also the full stack test
   ```

The static checks fail when a rule has no test. The Alertmanager settings come from the template `deploy/ops/alertmanager/alertmanager.yml.tmpl`; after changing it, render `alertmanager.yml.example` again with the example values of `test-ops.sh` (the static checks show the difference).

## Testing on a build machine

`deploy/ops/test-ops.sh` first runs the static checks, then starts the SaaS test stack of [stack.md](stack.md#testing-the-stack) with the monitoring overlay and checks it end to end:

- `ops-init` creates `mscd_monitor` (it can sign in with its password and cannot write), writes the probe target and the Alertmanager settings, and runs again without changes;
- the networks and ports are as described above, and every monitoring service has a memory limit and the hardening;
- every Prometheus target is up (checked through the Prometheus API inside its container), the probe passes with the certificate, the text files of `/opt/mscd/metrics` are read, and every rule is loaded;
- every target carries its Compose service, and the host's disks are listed without the container's own mounts;
- the Watchdog reaches a heartbeat receiver, and a real alert (HostRebootNeeded from a test `reboot.prom`) and a test alert sent with `amtool` arrive as email in a Mailpit container that sits only on the `egress` network, outside `mscd`, which proves the way out;
- AlertDeliveryFailing for email mutes the Watchdog, the heartbeat pings stop, and they come back when it ends;
- Caddy cannot reach the `mscd` network, and its admin endpoint answers only inside its container;
- with `MSCD_OPS_TEST_GRAFANA=true` (the default), the dashboards host through Caddy: no access without the password, the user signed in as a viewer, the dashboard listed, Prometheus reachable. `MSCD_OPS_TEST_GRAFANA=stub` runs the same host with a small stand-in of Grafana, for a build machine without disk space for the Grafana image (about 2 GB): it checks Caddy, the password, the user name Caddy passes and the `ops-web` network, but not Grafana itself.

Settings: `MSCD_OPS_TEST_PROJECT` (default `mscd-ops-test`), `MSCD_OPS_TEST_DIR` (default `/tmp/mscd-ops-test`), `MSCD_OPS_TEST_GRAFANA` (`true`, `stub` or `false`), `MSCD_OPS_TEST_KEEP`, and those of `saas-stack.sh` (`MSCD_SAAS_TEST_SCAN`, `MSCD_BUILD_CA`). On a build machine that cannot reach the Alpine mirrors, use `MSCD_SAAS_TEST_SCAN=auto` as for `saas-stack.sh`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `ops-init` exits 1 with "ALERT_EMAIL_TO is missing or empty" | The variable `ALERT_EMAIL_TO` is not set in the GitHub environment. Set it and deploy again. The app keeps running; only the monitoring waits |
| "bind source path does not exist: /opt/mscd/secrets/ops" | The deploy has not written the monitoring settings yet. Deploy with `deploy-prod.yml` |
| `postgres-exporter` reports `pg_up 0` after a database restore | The restored database lacks the role `mscd_monitor`. Run `$C up -d ops-init` once; it creates the role again |
| The heartbeat check is red but the server works | Alert emails fail, so Alertmanager muted the Watchdog on purpose: see [AlertDeliveryFailing](#alertdeliveryfailing). Otherwise `HEARTBEAT_WATCHDOG_URL` is missing (ops-init warns "nobody notices") or wrong, or the server cannot reach the heartbeat service. `$C logs alertmanager \| grep -E 'email\|webhook'` |
| PublicUrlDown fires while customers can work | The server cannot reach its own public address. Check DNS from the server (`getent hosts <domain>`) and the provider's network |
| The dashboards host shows an error from Caddy | Grafana is not running: check `$C ps grafana` (the deploy starts it only when `OPS_DOMAIN` is set). Or Caddy did not read the site that `ops-init` wrote (the deploy log warns "Caddy refused the configuration of the monitoring overlay"): `$C exec caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile` shows the reason, and a refused configuration leaves the running one in place. When the reload passes and the host still fails, `$C up -d --force-recreate caddy` |
| CertificateExpiringSoon right after the first deploy | The first deploy uses the Let's Encrypt staging CA, whose certificates the probe does not trust, so PublicUrlDown fires too. Switch `ACME_CA` to production as [stack.md](stack.md) describes |
