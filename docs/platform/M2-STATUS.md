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
| M2-S01 Release images and signing | 1a | Done | Server image gate needs the zod and undici bump (M2-03). Web image gate needs a host that reaches `dl-cdn.alpinelinux.org` |
| M2-S03 Server bootstrap | 1a | Done | |
| M2-S04 Go-live checklist and owner pack | 1a | Done | |
| MOT-01 Marketing landing site | L1 | Done | Owner fills `APP_URL` and `DEMO_EMAIL` in `apps/site/site.config.mjs` |
| MOT-02 Sign-in brand panel motion | L1 | Done | |
| M2-01 Web screen host and Administration area | 1b | Running | MOT-03 plugs into its EmptyState `illustration` prop |
| M2-03 Pack format and upgrade path | 1b | Running | Also raises zod to 4.6.6 and undici to 7.30.1 (lockfile owner) |
| M2-S02 SaaS Compose stack and TLS | 1b | Running | Caddy also serves `apps/site` on the bare domain |
| M2-04, M2-05, M2-06, M2-07 | 2a | Next, after M2-03 (and M2-02) | |
| MOT-03 In-app illustration library | L2 | Next, after M2-01 | |
| M2-S10, M2-S05, M2-S07, M2-S08 | 2b | After M2-S02 and M2-06 | M2-S10: write `platform.entitlement` only in platform scope (see its brief) |
| M2-S09, M2-08, M2-09, M2-10 | 3a | After wave 2 | |
| M2-S11, M2-16, M2-11, M2-12 | 3b | After 3a | M2-S11: generic email placeholder on the sign-in page. M2-16: use the MOT-03 scenes for Getting started |
| M2-S12, M2-13, M2-14, M2-15 | 3c | After 3b | |
| M2-17 Terminology | 4 | Waits for the owner's approval of H.1 | |
| M2-18 Fresh-organisation journey | 5 | After wave 3 | |
| M2-S13 SaaS end-to-end and go-live evidence | 6 | After M2-18 | |

## Product decisions to keep in mind

- The 9 decisions in `CLAUDE.md` (section "Product decisions").
- Motion work uses the `motionsites-web-builder` skill with the rules in `CLAUDE.md`.
- Speed rule: packages run only their own and targeted tests; the full suites run once per wave.
