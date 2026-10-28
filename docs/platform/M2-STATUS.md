# Milestone 2 status

The live progress of `docs/platform/MILESTONE-2.md`. The orchestrator updates this file after every package. A new session reads it to know where to continue.

## How to continue

1. Read `CLAUDE.md`, then the wave table in section G.1 of the plan and the motion track in section L.
2. New machine: install Docker, Node 22 and npm 10, run `npm ci`, and check that `docker info` works. On macOS install `flock` (`brew install flock`); the workflows use it so packages do not block each other. Run the tests with `TZ=UTC` on a host whose time zone is not UTC (as CI does): `test/int/jobs/freshness.test.ts` and `tasks-overdue.test.ts` fail otherwise. Keep about 10 GB of free disk: the Managed Vault (SeaweedFS) refuses to write below 1% free, which fails the vault tests and the smoke test.
3. Start the next packages with `.claude/workflows/mscd-m2-wp.js`, args `{wp: "<id>", notes: "<anything from the Notes column>"}`. Run at most four at once (rule R-02); a machine with more cores may run more, as long as no two running packages own the same file.
4. When a session ends while a package is still being built, start `.claude/workflows/mscd-m2-wp.js` again with `interrupted: true` and, if you have it, `previousTranscript` (the stopped implementer's transcript): the new implementer finishes the work in the tree instead of starting over.
5. When a package's workflow ends with open findings, or was stopped part way, continue it with `.claude/workflows/mscd-m2-followup.js`, args `{wp, notes, review: {acceptancePassed, problems}, interrupted}` (the `review` is the `final` object of the ended run). Name in `notes` any path outside the package's Owns list that you assign for the fix.
6. When a package ends with `acceptancePassed: true`, apply cheap minor findings, apply the patches it leaves for files outside its Owns list, record decisions in its handoff note under "Orchestrator decisions", commit, push to `main`, and update this file.
7. After every wave, run the full suites once (`npm run test:int -w @mscd/server`, `CI=1 npm run test:e2e -w @mscd/web`, `npm run test:e2e:api -w @mscd/web`, and `npm run test:smoke` when deploy or Compose files changed) and send any failure back to the package that caused it.

## Packages

| Package | Wave | Status | Notes for the next session |
|---|---|---|---|
| M2-02 Contract, schema, permissions | 1a | Done | Handoff lists follow-ups for M2-05, M2-06, M2-S10 |
| M2-S01 Release images and signing | 1a | Done | Server image gate passes since M2-03. Web image gate needs a host that reaches `dl-cdn.alpinelinux.org` |
| M2-S03 Server bootstrap | 1a | Done | |
| M2-S04 Go-live checklist and owner pack | 1a | Done | |
| MOT-01 Marketing landing site | L1 | Done | Owner fills `APP_URL` and `DEMO_EMAIL` in `apps/site/site.config.mjs` |
| MOT-02 Sign-in brand panel motion | L1 | Done | |
| M2-01 Web screen host and Administration area | 1b | Done | New screens copy the Licence screen: adapter chosen by the build, `useMutation` for forms. MOT-03 plugs into the EmptyState `illustration` prop |
| M2-03 Pack format and upgrade path | 1b | Done | zod 4.6.6 and undici 7.30.1 are in; the server image passes the gate. Notes for M2-04 to M2-07 are in their briefs |
| M2-S02 SaaS Compose stack and TLS | 1b | Done | Caddy also serves `apps/site` on `MSCD_SITE_DOMAIN`. Without the Alpine mirrors, run its stack test with `MSCD_SAAS_TEST_SCAN=auto` |
| M2-05 Certification, internal audit and readiness server | 2a | Done | |
| M2-07 Document control and register server additions | 2a | Done | APPL-ASSESS also applies on create (plan D.2 updated). Holdings include self-assessment gaps, audit activities and business associate relationship owners |
| M2-06 Onboarding, accounts and operator server | 2a | Done | Daily jobs run from a ledger, `platform.daily_job_run` (one row per organisation, job and local date; orchestrator decision): over 600,000 simulated ticks, 0 doubles, 0 misses. Every new daily job must go through the ledger and read its date from the payload (`localDate`). The organisation PATCH checks If-Match |
| M2-04 Pack content | 2a | Done | Six packs at the content step: ISO27001-2022 1.3.0, ISO9001-2015 1.5.0, ISO9001-2026 0.10.0, ISO22301-2019 1.1.0, ISO37001-2016 1.1.0, ISO37001-2025 0.7.0. Evidence examples and the clause at risk are keyed per system. H.6 still open |
| MOT-03 In-app illustration library | L2 | Done | Eight scenes (`getting-started`, `no-systems`, `no-documents`, `no-evidence`, `no-findings`, `all-done`, `error`, `offline`) through `<Illustration scene=... />` from `apps/web/src/illustrations`, passed to the EmptyState `illustration` prop. The handoff note says which scene goes where. Gallery at `?screen=illustrations` in the sample build only (the orchestrator assigned `apps/web/src/screens/illustrations/**`) |
| M2-S08 Monitoring and alerts | 2b | Done | Real Grafana image test assigned to M2-S13. The orchestrator follow-up of 2026-10-28 made the queue age count from the start time of due jobs and set `JobQueueStuck` back to 900 seconds (deviation 9 closed) |
| M2-S05 Deploy script and deploy workflow | 2b | Done | The deploy rehearsal passed 78 checks. Deploys run only through `.github/workflows/deploy-prod.yml` with the owner's approval |
| M2-S10 Per-organisation entitlements | 2b | Done | Each organisation's licence is its `platform.entitlement` row in multi tenancy (presets `trial` and `standard` in `saas.yaml`), cached 60 s and refreshed across processes by `NOTIFY mscd_tenant_changed`. Operator routes `ops.entitlements.*` and `ops.plans.list`, CLI `license entitlements show|set`, daily `entitlement.expiry` at 06:15 through the run ledger. M2-S09 reuses `publishTenantChange` and `EntitlementService.applyPreset` |
| M2-S07 Backups and restore test | 2b | Running | The backup values come from `deploy-prod.yml` of M2-S05 |
| M2-08 Bulk import, M2-09 Storage and management system administration | 3a | Running | Started early with the owner's approval (2026-10-28): they share no file with the open packages of 2b |
| M2-10 People, roles and sign-in | 3a | Running | |
| M2-S09 Operator commands and organisation lifecycle | 3a | Running | Started after M2-S10 was committed |
| M2-11, M2-12, M2-16 | 3b | Next | Web packages of wave 3b; they start as slots free up (at most five packages at once on this host, the owner's rule) |
| M2-S11 Organisation discovery at sign-in | 3b | After M2-S09 and M2-10 (shared files) | M2-S11: generic email placeholder on the sign-in page. M2-16: use the MOT-03 scenes for Getting started |
| M2-S12, M2-13, M2-14, M2-15 | 3c | After 3b | |
| M2-17 Terminology | 4 | Waits for the owner's approval of H.1 | |
| M2-18 Fresh-organisation journey | 5 | After wave 3 | |
| M2-S13 SaaS end-to-end and go-live evidence | 6 | After M2-18 | |

## Open orchestrator items

- After M2-S07: run the M2-S05 rehearsal once more with the default overlays (`repo`), so it deploys the backup overlay too (M2-S05 handoff, follow-ups).
- After M2-09: add the Administration entries `systems` and `routing` to the expectations of the shared tests `apps/web/test/screens/host.test.tsx` and `apps/web/test/api/controller.test.ts` (owned by M2-01; MOT-03 found them).
- Later: make `test/int/jobs/freshness.test.ts` and `tasks-overdue.test.ts` pass in any host time zone.
- M2-S13: run `deploy/ops/test-ops.sh` with `MSCD_OPS_TEST_GRAFANA=true` in the `saas-smoke` job (note in its brief).
- Owner: H.1 (terminology, gates M2-17) and H.6 (ISO 9001:2026 and ISO 37001:2025 trees) are still open.

## Wave results

| Wave | Full suites (orchestrator) | Notes |
|---|---|---|
| 2a (with M2-S05 and M2-S08 of 2b) | Server integration after the ledger rebuild: 125 files, 1449 passed, 59 skipped, 3 files failed only because the disk was below 1% free for the Managed Vault; after freeing disk they passed 13 of 13. Web E2E sample: 286 passed, then the display and offline specs 98 of 98 after the helper fix. Web E2E API: 264 passed, then `framework.spec.js` 6 of 6 after its fix. Smoke test: 11 of 11 passed (full stack in Compose) | The web E2E helper now counts a page load that began up to 2 s before a cut-off read |
| 1 (1a, 1b, L1) | Server integration: 108 files, 1342 passed, 56 skipped. Web E2E sample: 286 passed, 1 failed once. Web E2E API: 265 passed | The failure was `e2e/offline.spec.js` (a lazy `sample-*.js` chunk cut off by a page load while `page.route` intercepts every request); `--repeat-each=4` then passed 8 of 8. The orchestrator widened the `requestfailed` filter of `apps/web/e2e/helpers.js` for that case between waves (offline, probe and shell specs pass) |

## Product decisions to keep in mind

- The 9 decisions in `CLAUDE.md` (section "Product decisions").
- Motion work uses the `motionsites-web-builder` skill with the rules in `CLAUDE.md`.
- Speed rule: packages run only their own and targeted tests; the full suites run once per wave.
