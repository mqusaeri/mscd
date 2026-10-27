# Milestone 2 status

The live progress of `docs/platform/MILESTONE-2.md`. The orchestrator updates this file after every package. A new session reads it to know where to continue.

## How to continue

1. Read `CLAUDE.md`, then the wave table in section G.1 of the plan and the motion track in section L.
2. Start the next packages with the workflow `.claude/workflows/mscd-m2-wp.js`, args `{wp: "<id>", notes: "<anything from the Notes column>"}`. Run at most four at once (rule R-02); a machine with more cores may run more, as long as no two running packages own the same file.
3. When a package's workflow ends with `acceptancePassed: true`, apply cheap minor findings, record decisions in its handoff note, commit it, push to `main`, and update this file.
4. After every wave, run the full suites once (`CI=1 npm run test:e2e -w @mscd/web`, `npm run test:int -w @mscd/server`) and send any failure back to the package that caused it.

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
| M2-05 Certification, internal audit and readiness server | 2a | Done, waiting for the wave commit | Its handoff lists the cross-package fixes the orchestrator applies at the end of wave 2a |
| M2-07 Document control and register server additions | 2a | Done, waiting for the wave commit | APPL-ASSESS also applies on create (plan D.2 updated). Holdings include self-assessment gaps, audit activities and business associate relationship owners |
| M2-06 Onboarding, accounts and operator server | 2a | Built; a follow-up run fixes the daily job catch-up after a time zone change | The orchestrator applied its three patches outside Owns (set-password link, invite test, CLI test) |
| M2-04 Pack content | 2a | Built; its test updates outside Owns are applied (341ff9e); a follow-up run keys the evidence examples and the clause at risk per system | Six packs at the content step: ISO27001-2022 1.3.0, ISO9001-2015 1.5.0, ISO9001-2026 0.10.0, ISO22301-2019 1.1.0, ISO37001-2016 1.1.0, ISO37001-2025 0.7.0. H.6 still open |
| MOT-03 In-app illustration library | L2 | Next (M2-01 is done) | |
| M2-S05 Deploy script and deploy workflow, M2-S08 Monitoring and alerts | 2b | Running (started early: no server or web code) | |
| M2-S07 Backups, M2-S10 Entitlements | 2b | Next, after the wave 2a commit | M2-S10: write `platform.entitlement` only in platform scope (see its brief) |
| M2-S09, M2-08, M2-09, M2-10 | 3a | After wave 2 | |
| M2-S11, M2-16, M2-11, M2-12 | 3b | After 3a | M2-S11: generic email placeholder on the sign-in page. M2-16: use the MOT-03 scenes for Getting started |
| M2-S12, M2-13, M2-14, M2-15 | 3c | After 3b | |
| M2-17 Terminology | 4 | Waits for the owner's approval of H.1 | |
| M2-18 Fresh-organisation journey | 5 | After wave 3 | |
| M2-S13 SaaS end-to-end and go-live evidence | 6 | After M2-18 | |

## Wave results

| Wave | Full suites (orchestrator) | Notes |
|---|---|---|
| 1 (1a, 1b, L1) | Server integration: 108 files, 1342 passed, 56 skipped. Web E2E sample: 286 passed, 1 failed once. Web E2E API: 265 passed | The failure was `e2e/offline.spec.js` (a lazy `sample-*.js` chunk cut off by a page load while `page.route` intercepts every request); `--repeat-each=4` then passed 8 of 8. The orchestrator widened the `requestfailed` filter of `apps/web/e2e/helpers.js` for that case between waves (offline, probe and shell specs pass) |

## Product decisions to keep in mind

- The 9 decisions in `CLAUDE.md` (section "Product decisions").
- Motion work uses the `motionsites-web-builder` skill with the rules in `CLAUDE.md`.
- Speed rule: packages run only their own and targeted tests; the full suites run once per wave.
