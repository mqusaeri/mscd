# Milestone 3 status

The live progress of `docs/platform/MILESTONE-3.md`. The orchestrator updates this file after every package. A new session reads it, with `docs/platform/M2-STATUS.md` for the rules of work that still hold, to know where to continue.

## How to continue

1. Read `CLAUDE.md`, then section 0 and the wave table G.1 of the plan.
2. Start a package with `.claude/workflows/mscd-m3-wp.js`, args `{wp: "<id>", notes: "..."}`. Continue one that ended with open findings, or was stopped part way, with `.claude/workflows/mscd-m3-followup.js`, args `{wp, notes, review: {acceptancePassed, problems}, interrupted}`.
3. At most four packages at once (R-02), at most one host stack at a time (R-05), and the machine at or below 12 GB of memory in use (product owner, 2026-10-31). While a package runs heavy test suites, give the others the memory guard of the launch notes (wait until less than 8000 MB is in use before a heavy command).
4. Browser suites run with targeted spec files in packages; the orchestrator runs both full suites once per wave, and CI runs them on every push to `main`.
5. When a package ends with `acceptancePassed: true`, apply cheap minor findings and the patches it leaves, record decisions in its handoff under "Orchestrator decisions", commit, push to `main`, and update this file.

## Packages

| Package | Wave | Status | Notes for the next session |
|---|---|---|---|
| M3-01 Contract, schema, permissions and storage functions | 1 | Done | 65 routes and 2 gateway routes (stubs answer 501 until their package), migrations tenant/0009 and platform/0007, permissions, jobs, profile keys `lifecycle.*` and `privacy.*`, gateway delete and purge. Notes for wave 2 in its handoff decisions |
| M3-08 Open work totals | 1 | Done | Screen `pending-totals` (`/ms/:ms/pending-totals`), opened from Chain stages and the Overview in API builds; totals only, no names (decision 2) |
| M3-M01 Open follow-ups | 1 | Done | Installer saves the Compose project name, `install.sh --yes` default organisation, `THIRD-PARTY-NOTICES.md` with a CI check. Every dependency change regenerates the notices file |
| M3-02 Organisation export | 2 | Done (follow-up done) | Requests with a second Tenant Admin's approval, build job (CSV and JSON Lines, files, audit trail with anchors, manifest), 7-day download, `export organization` and `export verify`. The follow-up made verify require a trusted anchor over each redaction attestation and gave the worker a scratch folder (`/var/lib/mscd/tmp`) |
| M3-03 End of contract and verified deletion | 2 | Done | Offboarding sets the end of the read-only period and queues the final export; `org.lifecycle` archives, schedules and reminds; `org.purge` removes schema, vault objects, keys and platform rows, anonymises accounts, redacts platform audit entries under one attestation and sends a signed deletion certificate. `restore.sh --reapply-deletions` and a purge step in `restore-test.sh --local` |
| M3-05 Read confirmation of policies | 2 | Done (follow-up done) | Register screen, "Policies to confirm", banner, daily reminders, close and file as evidence. The follow-up lets audience members without file rights open the version through a short-lived token address, and added the sidebar entry in the tasks group |
| M3-06 Retention and disposal review | 2 | Done | Screen `retention` (rules, due for review, awaiting approval, holds, disposal register with CSV); daily `retention.review`; disposal needs a second person and deletes Managed Vault content only. Follow-ups below |
| M3-04 Requests from one person | 3 | Done | Screens `privacy-requests` (register, system checks, correction, stop to the use, erasure under a pseudonym with the word ERASE) and `privacy-checks`; "My data" in My account (copy, correction, requests); `privacy.deadlines`; cleanup of old sessions and tokens (D.6.7); pseudonyms in every person column |
| M3-07 Periodic access review | 3 | Done | Screens `access-reviews` (Tenant Admins) and `access-review` (each system's managers); daily `access-review.open` every 3 months with reminders; keep, change or revoke with the existing services; nobody decides on their own access; the report CSV is filed as evidence for A.5.18 |
| M3-09 Export and deletion screens | 3 | Done | Screen "Organisation export" (request, approve or reject, parts and manifest with SHA-256, read-only banner); operator console columns "Read-only until" and "Deletion on", drawer tabs Export and Deletion (schedule, change date, cancel, retry, steps and checks, certificate), status moves of J.8 |
| M3-10 Demo personas | 4 | Running | Started 2026-11-01 |
| M3-11 Data lifecycle run and documents | 4 | Running | Started 2026-11-01 |
| M3-M02 Major dependency upgrades | 5 | Waiting, alone | Also upgrades `glob` and `minimatch` if that has not happened by then (`osv-scanner.toml` accepts them until 2026-11-14) |

## Product owner decisions for Milestone 3

- 2026-10-31: scope is section 2 of `docs/ROADMAP.md` as listed, plus the maintenance track.
- 2026-10-31: every default of section H (H.1 to H.11) accepted; H.12 (no second approval for an erasure) keeps its default unless the owner decides otherwise before M3-04.
- Open question H.13 (from M3-04): a person erased in an organisation and later invited again; default to build: the invitation creates a fresh account, and records from before the erasure keep the pseudonym.
- Open questions for the owner from the plan review: the real versioning, lifecycle rule or object lock of the backup bucket (the deletion certificate date depends on it); `docs/saas/legal-inputs.md` and `records-of-processing.md` still say "about 12 months" for backups until M3-11 corrects them.

## Open items for later packages

- For M3-10 (after M3-04 releases `read-model/**`): link My Tasks rows of entity type acknowledgement to "Policies to confirm" (optional `TaskItem.screen` set in `read-model/derive/tasks.ts`, a branch in the My Tasks screen of `MscdApp.jsx`; follow-up 3 of the M3-05 handoff). Today the generic Done button there is refused with 422 `task_completes_on_screen`.
- For M3-11: the `errors` list of `me.acknowledgements.open` may add 422 (`no_file`, `file_not_readable`).
- Optional, for a later owner of `jobs/cleanup-expired.job.ts`: call `removeStaleWorkDirs` on every hourly `cleanup.expired` run, so a stopped export build's scratch files do not wait for the next export.
- From M3-02: a REPEATABLE READ read-only option of `withTenant` (owner of `modules/tenancy/**`) so the export reads every table in one snapshot.
- From M3-02: `GRANT SELECT` on each tenant schema's `kysely_migration` to `mscd_app` in `platform.apply_tenant_grants` (a later platform migration); the manifest then names the migrations from the schema.
- From M3-02: keep retired anchor keys in `TRUSTED_KEYS` (D-16) for as long as exports signed with them are kept; the in-app anchor checks (`AuditChainVerifier`, `audit.verify-chain`) still trust only the compiled keys, so on-premise they reject the installation's own anchor key (owner of `modules/audit/**`, next to the M2-S05 K.9 item).
- For M3-11: `KIND_SCREENS` entries for `organization_export_requested` and `organization_export_ready` (screen `org-export`).
- For the orchestrator: `host.test.tsx` needs the "tasks" sidebar group of the M3-05 follow-up (`my-confirmations`) when it is committed; the M3-07 entry is in.


- From M3-06: a `retain_months` column on `retention_review` in a correction migration (R-14), so the disposal register stores the period of each decision in a column; today it reads it from the audit entries `retention_review.decided` and `retention_review.approved`.
- For M3-10: once the seed writes a due review, add API browser tests of decide, approve as a second person (the proposer's Approve disabled), reject and "File removed" to `e2e/api-only/retention.spec.js`, each with `expectOverlayReadable` in both themes; add `sponsor` to the roles of `screens/retention/index.tsx` and `meta.json`.
- For M3-11: map the notification kinds `retention_review_due` and `disposal_approval_pending` to the screen `retention` (tabs due and approval) in `KIND_SCREENS`.
