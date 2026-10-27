# ops module

Platform operator endpoints and diagnostics (D.3 Operations), and the metrics of ARCHITECTURE 12 that are read from the job queue and the database.
Owner: WP-34 (skeleton by WP-03, build plan B.4); Milestone 2: M2-06 (organisations, factor reset), M2-S09, M2-S11.

| Route | Permission | Notes |
|---|---|---|
| `GET /api/v1/ops/health` | `ops.read` | Readiness checks, job queue, job outbox (degraded when rows are stuck or parked), telemetry; newest applied migration of `platform` and `ref`; queue statistics; licence state per active organisation |
| `GET /api/v1/ops/queues` | `ops.read` | `JobQueue.stats()` |
| `POST /api/v1/ops/jobs/{name}/run` | `ops.jobs.run` | Allow-list of D.3 (`OPS_RUNNABLE_JOBS`), body `{org?}` only, empty payload. Tenant jobs need `org` of an active organisation (422 otherwise, 404 for an unknown slug); installation-wide jobs refuse `org` (422); a job without a handler in the build is 422. Singleton key `ops:<job>:<org id or all>`; 409 when the driver reports a run already waiting. The job and the `ops.job_run` entry (platform chain, actor kind `operator`) commit in one transaction |
| `POST /api/v1/ops/diagnostics` | `ops.read` | `.tar.gz` with `README.txt`, `profile.json`, `versions.json`, `migrations.json`, `queues.json`, `health.json`, `logs.ndjson` (ring buffer, at most 1,000 lines) and `metrics.txt`; every file scrubbed by `SecretScrubber`; audited `ops.diagnostics_exported` before the bytes are sent |
| `GET /api/v1/ops/organizations` | `ops.read` | Multi tenancy only (409 `single_tenancy` otherwise). Organisations with status, licence state, plan and validity of the entitlement row, active members (guests not counted), systems that are not archived, verified domains; `q` searches slug and name, `status` filters; paged (M2-06) |
| `POST /api/v1/ops/organizations` | `ops.tenants.manage` | Multi tenancy only. `TenantProvisioner.create` with the api's database owner URL and a data key of the storage gateway (503 when either is missing), local sign-in allowed, the first administrator invited as Tenant Admin and emailed. With `mail.required` and SMTP not answering: 409 `mail_required` before anything is created; the one-time link is returned only when mail is not required and the email did not go out. An existing active account gets the email and the notification `membership_invited`. 409 `org_exists`, 409 `first_admin_disabled`, 422 `unknown_preset`. Audited `ops.organization_created` (M2-06) |
| `POST /api/v1/ops/users/reset-mfa` | `ops.users.manage` | Body `{email, reason}`: removes the factors and recovery codes of the account, clears its second-factor lock, ends its sessions, emails it; 404 when no account has the address or it has no factor. Audited `auth.mfa_reset` with the reason, actor kind `operator` (M2-06) |

`OpsMetricsCollector` keeps one snapshot of the collected metrics for 15 seconds, so scrapes of the api and the worker cost one round of queries per interval; a section that fails keeps its last values and is logged once.

`mail-readiness.ts` checks the SMTP server of the profile (connection, greeting and login) for the mail rule of `ops.organizations.create` and of the commands `admin create-user` and `admin create-operator`. `TenantDataKeys` gives the data key issuer of a new organisation (the storage gateway); a test application replaces it.
