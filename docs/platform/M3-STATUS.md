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
| M3-02 Organisation export | 2 | Running | Started 2026-10-31 |
| M3-03 End of contract and verified deletion | 2 | Running | Started 2026-10-31 |
| M3-05 Read confirmation of policies | 2 | Running | Started 2026-10-31 |
| M3-06 Retention and disposal review | 2 | Running | Started 2026-10-31 |
| M3-04 Requests from one person | 3 | Waiting | |
| M3-07 Periodic access review | 3 | Waiting | |
| M3-09 Export and deletion screens | 3 | Waiting | |
| M3-10 Demo personas | 4 | Waiting | |
| M3-11 Data lifecycle run and documents | 4 | Waiting | |
| M3-M02 Major dependency upgrades | 5 | Waiting, alone | Also upgrades `glob` and `minimatch` if that has not happened by then (`osv-scanner.toml` accepts them until 2026-11-14) |

## Product owner decisions for Milestone 3

- 2026-10-31: scope is section 2 of `docs/ROADMAP.md` as listed, plus the maintenance track.
- 2026-10-31: every default of section H (H.1 to H.11) accepted; H.12 (no second approval for an erasure) keeps its default unless the owner decides otherwise before M3-04.
- Open questions for the owner from the plan review: the real versioning, lifecycle rule or object lock of the backup bucket (the deletion certificate date depends on it); `docs/saas/legal-inputs.md` and `records-of-processing.md` still say "about 12 months" for backups until M3-11 corrects them.
