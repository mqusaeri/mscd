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
| M3-10 Demo personas | 4 | Done | Wulan Hartono (Programme Owner), Ratna Kusumawati (Risk Owner), Gilang Saputra (Compliance Investigator) in the demo seed, sample build and Keycloak realm; `baseRole` maps them to manager or owner views; Milestone 3 routines seeded in RS Medika Nusantara; My Tasks links read confirmations to "Policies to confirm"; retention API tests of decide, approve, reject and File removed |
| M3-11 Data lifecycle run and documents | 4 | Done | `npm run lifecycle -w @mscd/smoke` walks read confirmation, disposal, access review, My data, an access request and an erasure on screen (13 steps); every J.4 notification links to its screen; `records-of-processing.md`, `legal-inputs.md`, `operator.md`, `USER-FLOWS.md` and `ui-contract.md` describe what is built, with the honest backup end date |
| M3-12 Hardening follow-ups | 4 | Done | Operator idempotency, on-premise anchor keys (`audit-anchor.pub` mounted into the api and worker), export in one snapshot, `kysely_migration` grant (platform/0009), `retention_review.retain_months` (tenant/0010), hourly scratch cleanup, findings Close with the version of its write |
| M3-M02 Major dependency upgrades | 5 | Done | kysely 0.29.7, NestJS 12.2.0 with the Fastify plugins, ESLint 10, React 19.3.1, Vite 8.3.4, vitest 5, the server majors of Dependabot PR 4; glob 14.0.3 and minimatch 11.0.3 (`osv-scanner.toml` entries removed); engines `>=22.22`. TypeScript 7 waits for `typescript-eslint` (ignore rule); `@types/node` stays on 22. The NestJS tracing spans are off until the OpenTelemetry instrumentation supports NestJS 12 |

## Product owner decisions for Milestone 3

- 2026-10-31: scope is section 2 of `docs/ROADMAP.md` as listed, plus the maintenance track.
- 2026-10-31: every default of section H (H.1 to H.11) accepted; H.12 (no second approval for an erasure) keeps its default unless the owner decides otherwise before M3-04.
- 2026-11-01, H.13: a person erased in an organisation and later invited again rejoins with a fresh account; records from before the erasure keep the pseudonym (built by the M3-04 follow-up, committed 2026-11-02). Owner, 2026-11-02: case (a) accepted (the same email is refused while the erased account still belongs to the person elsewhere; rejoin with another address); case (b) accepted as built (an account kept at the erasure whose other membership has ended since is anonymised at the new invitation and the same email works).
- 2026-11-02, after three read-only reviews of Milestone 3 (security, ISO lead auditor and UU PDP, screen texts): a disposal really deletes the record's content (cleared fields, audit entries redacted under an attestation, left out of exports; only the disposal register line stays), and staging gets Milestone 3 in one release after the fix packages M3-13 and M3-14.
- 2026-11-02 (decision 20): H.2 unchanged; staging without disposal receipts (built before production go-live); one-holder roles join "Other roles" on Open work totals; the provider forwards a data request on the day it arrives.
- Open questions for the owner from the plan review: the real versioning, lifecycle rule or object lock of the backup bucket (the deletion certificate date depends on it). The documents now give the certificate's end date (deletion date plus `lifecycle.backup_copies_end_days`, 780 days by default) and say the owner confirms the bucket settings.

## Open items for later packages

- From M3-11 (optional): allow `retention.review` for one organisation in `OPS_RUNNABLE_JOBS`, so an operator can start the daily review from the console after an outage; keep the open drawer of Personal data checks while the list reloads after "Mark checked".
- From M3-11: a human lead auditor and the lawyer review the updated `USER-FLOWS.md`, `legal-inputs.md` and `records-of-processing.md`.
- From M3-12: an organisation export build holds three database connections at once (build lock, snapshot, one read); `database.pool_max` below 3 makes a build wait. Refuse a build early with a clear message below 3, or raise the profile minimum, and name the minimum in INSTALL-ONPREM.
- From M3-10 (demo only): the persona menu of `bsd` and `rmn` offers the Compliance Investigator, who has no role there; either `me-assembler.ts` lists only personas with a business role (and `Me.personas` carries the display name, a contract change), or Gilang Saputra joins `ndt` only (member counts 88). Also sample-mode tests of `canVerify` and `canSeePeople` for the three new roles, and `baseRole` in `screens/findings/shared.ts` line 146 once M3-12 is committed.
