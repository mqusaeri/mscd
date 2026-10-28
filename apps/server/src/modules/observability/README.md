# observability module

Metric definitions and the OpenTelemetry bootstrap (ARCHITECTURE 12). Loaded by api, worker and storage-gateway, so it never touches the database.
Owner: WP-34 (skeleton by WP-03, build plan B.4).

| File | Content |
|---|---|
| `metric-catalogue.ts` | `METRICS` (every ARCHITECTURE 12 metric plus `mscd_job_outbox_stuck_rows`), `ARCHITECTURE_METRIC_NAMES`, get-or-create helpers `ensureCounter`, `ensureGauge`, `ensureHistogram`, collected metrics (`registerCollected`, read when Prometheus scrapes) and derived metrics (`registerDerived`, a slice of another module's metric published under the catalogue name) |
| `observability.service.ts` | `ObservabilityMetrics` (creates the catalogue metrics that need no database and the derived ones), `HttpObservability` (Fastify hooks: `mscd_http_request_duration_seconds` by route pattern, method and status, server spans), `TelemetryService` (in-process tracing), `LogRingTap` (copies pino output into the ring buffer) |
| `log-ring.ts` | `LOG_RING`: the last 1,000 log lines of the process as pino wrote them (already redacted, F.12), read by the diagnostics archive |
| `telemetry.ts` | OTLP/HTTP tracer of HTTP requests (W3C trace context, path only, never query values) and helpers |
| `otel-preload.ts` | Optional preload (`node --require dist/modules/observability/otel-preload.js dist/main.js <mode>`): the OpenTelemetry Node SDK with automatic instrumentation, started before the server loads its modules |

Where each ARCHITECTURE 12 metric comes from:

| Metric | Source |
|---|---|
| `mscd_http_request_duration_seconds{route,method,status}` | Fastify `onResponse` hook of this module (api and storage-gateway) |
| `mscd_queue_waiting{queue}`, `mscd_queue_oldest_age_seconds{queue}` | Collected by `modules/ops` from `JobQueue.stats()`. `mscd_queue_waiting` counts every job not yet taken by a worker, also jobs whose start time is ahead (queued with a start delay, or waiting for a retry). `mscd_queue_oldest_age_seconds` is the wait of the oldest due job, counted from its start time: the time it was queued for, or for a retry the time of the retry. A job queued to start later (for example a daily job that `scheduler.tick` queues up to 54 minutes ahead) counts only once its start time has come; with no due job the value is 0. On the BullMQ driver a retry that a worker already moved back to the waiting list keeps no retry time and counts from the start of its failed run, so it reads early by the run time and the backoff (pg-boss and the in-memory driver keep the retry time). The alert JobQueueStuck reads it (`deploy/ops/prometheus/rules/jobs.yml`) |
| `mscd_job_failures_total{job}` | Derived from `mscd_job_runs_total{outcome="failed"}` of the worker runtime |
| `mscd_link_status_objects{status}` | Collected by `modules/ops`: storage objects of every active organisation |
| `mscd_freshness_recompute_seconds{job}` | Derived from `mscd_job_duration_seconds` of `freshness.recompute` and `freshness.sweep` |
| `mscd_gateway_request_duration_seconds{adapter,operation}` | Derived from `mscd_gateway_call_duration_seconds` of the storage gateway |
| `mscd_adapter_throttled_total{adapter,operation}` | Derived from `mscd_gateway_calls_total{outcome="rate-limited"}` of the storage gateway |
| `mscd_licence_days_left{org}` | Collected by `modules/ops` from the licence service |
| `mscd_audit_chain_broken{chain}` | Set by `audit.verify-chain`; created here so it is always listed |
| `mscd_authz_denied_total{route}` | Counted by the authorisation guard; created here so it is always listed |
| `mscd_mfa_locks_total` | Collected by `modules/ops`: `auth.mfa_locked` entries of the platform audit log |
| `mscd_job_outbox_stuck_rows` | Collected by `modules/ops`: outbox rows stuck in (12 or more failed attempts, still retried) or parked by (permanent failure) the BullMQ relay |

Telemetry is off by default (`telemetry.enabled: false`). With `telemetry.enabled: true` and `telemetry.otlp_endpoint`, spans go to `<endpoint>/v1/traces`.
