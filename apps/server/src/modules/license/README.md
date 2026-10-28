# license module

Licence verification, derived licence state and the `LicenceGate` (D-15, D-16, D-32, BR-37), and the per-organisation
entitlements of multi tenancy (Milestone 2 K.6, M2-S10).

- `trust-anchors.ts`: the licence and pack keys compiled into the build (`TRUST_ANCHORS`); a release build refuses development key ids.
- `licence-state.ts`: the state of a licence on a date (`valid`, `grace`, `read_only`) and the clock high-water rule.
- `licence.service.ts`: verification (cached by document hash), binding to the installation or organisation, installation (`PUT /admin/license`), the view (`GET /license`) and the daily `license.check`. In multi tenancy `evaluate` turns the organisation's entitlement row into the same evaluated licence, writes the row of a signed licence installed before M2-S10 on the first read, and the upload writes the row with source `signed_licence`.
- `licence-gate.ts`: the `LICENCE_GATE` used by the guard (read-only mode) and by services (`LIC-USERS`, `LIC-MS`, `LIC-FEATURE`, adapters).

Milestone 2 (M2-S10), multi tenancy only:

- `entitlement-row.ts`: the `platform.entitlement` row, its read, ETag and `If-Match` check, and the values of a preset or a signed licence.
- `entitlement-store.ts`: every write of the table, in platform scope (`inPlatformScope`), under a per-organisation lock, audited `ops.entitlements_changed` with the old and new values, with the change notice.
- `entitlement-registry.ts`: the per-process cache of the rows (up to 60 seconds, dropped on a change notice); also the `ORG_RATE_LIMITS` of the rate limits per organisation.
- `tenant-change.ts`: `publishTenantChange(trx, orgId)` (`pg_notify('mscd_tenant_changed', orgId)`, delivered on commit) and `TenantChangeListener`, one listening connection per api and worker process. M2-S09 reuses both for organisation status and sessions.
- `entitlement.service.ts`: `ops.plans.list`, `ops.entitlements.get`, `ops.entitlements.set` (preset or limits, `If-Match`, warnings below current use), `applyPreset(trx, orgId, preset)` for M2-S09, and the work of `license entitlements show` and `set` (`cli/license.ts`).
- `entitlements.controller.ts`, `entitlements.module.ts`: the operator routes and the sub-module (D.3).
- `entitlement-expiry.job.ts`: the daily `entitlement.expiry` through the run ledger: operator emails 30, 7 and 1 days before `valid_until`, the Tenant Admins' `licence_expiring` notice 30 and 7 days before. When no operator email of a run could be sent, the job deletes the run's ledger row, so the next hourly tick runs it again on the same date.

Owners: WP-12; M2-S10 (entitlements).
