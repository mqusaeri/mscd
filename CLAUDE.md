# MSCD project guide for Claude Code

Read this file first. It replaces the old instructions in `README.md`, which date from the Claude Design hand-off and are out of date.

## What MSCD is

MSCD (Management System Compliance Dashboard) is a platform that helps an organisation reach and keep ISO certification. It covers ISO/IEC 27001 (ISMS), ISO 9001 (QMS), ISO 22301 (BCMS) and ISO 37001 (ABMS). It traces each risk to its controls, documents and evidence, and tracks progress toward the certification audit. It runs on-premise with Docker Compose or on Kubernetes with Helm.

## Status

- **Milestone 1 is done.** All 39 work packages of `docs/platform/BUILD-PLAN.md` are built and verified. `main` holds the work (the old `mscd-platform` branch is the same history).
- **Milestone 2 is planned, not started.** `docs/platform/MILESTONE-2.md` is the plan of record: the core track (M2-01 to M2-18: admin screens, data-entry forms, ISO clauses 4 to 10, readiness, certification cycle, bulk import) and the SaaS production track (section K, M2-Sxx: release images, Compose on one VPS with Caddy, GitHub Actions deploy, backups, monitoring, operator console, go-live checklist).
- The demo runs with `deploy/scripts/deploy-demo.sh`. A new customer cannot yet be run from the web app alone; Milestone 2 fixes that.
- `docs/product/USER-FLOWS.md` is a draft of the four user flows. Its ISO lead-auditor review is still to do.

## Next steps

1. Build Milestone 2 in the wave order of the plan (section G.1 and the SaaS waves in section K). Start with wave 1a, M2-02.
2. Build each package with the workflow in `.claude/workflows/mscd-m2-wp.js` (args `{wp: "M2-02"}`): it implements, runs the acceptance, has an independent agent verify, and fixes up to two rounds. Then commit once per package or per wave and push to `main`.
3. Run at most four packages at once (rule R-02 of the plan). The workflow uses `flock` locks in `/tmp`; on macOS install `flock` first or run packages one at a time.
4. Production deploys go through GitHub Actions with the owner's approval (section K). Never hold production secrets in the repo or the chat.

## Repository layout

| Path | Content |
|---|---|
| `apps/web` | React 18 and Vite web app. Views in `src/views` are generated from the design template |
| `apps/server` | NestJS 11 on Fastify. Run modes: api, worker, storage-gateway, migrate. Kysely on PostgreSQL 16 |
| `packages/shared` | zod API contract shared by web and server, OpenAPI generation |
| `packages/pack-tools` | signing and checking of framework packs and licences |
| `packs/sources` | framework pack sources per standard (clauses, controls, documents, activities) |
| `tools/mock-providers` | mock Microsoft 365, Google Drive and identity providers for tests and the demo |
| `tools/smoke` | full-stack smoke test (`npm run test:smoke`) |
| `deploy` | Dockerfiles, NGINX, Compose files, installer scripts, Helm chart |
| `docs` | architecture, development, on-premise install guide, build plan, hand-off notes |
| `project` | the original design prototypes from Claude Design (source of the generated views) |

## Key documents

- `docs/ARCHITECTURE.md`: system design.
- `docs/platform/BUILD-PLAN.md`: the plan of record. Rules R-01 to R-13, contracts, business rules (BR-xx), role matrix (F.6), acceptance per work package.
- `docs/platform/ui-contract.md`: what every screen shows and which API feeds it.
- `docs/platform/handoff/WP-xx.md`: what each work package built, its deviations and follow-ups.
- `docs/DEVELOPMENT.md`: local development.
- `docs/INSTALL-ONPREM.md`: install guide for operators.
- `docs/product/USER-FLOWS.md`: user flows and terminology for the product owner.

## Commands

```bash
npm ci
npm run typecheck && npm run lint && npm test     # unit tests, all workspaces
npm run test:int                                  # server integration tests (needs Docker)
npm run test:e2e                                  # web E2E in sample mode
npm run test:e2e:api                              # web E2E against a real API stack (needs Docker)
npm run test:smoke                                # full stack in Compose, 11-step journey
npm run check:text                                # writing rules on docs
bash deploy/scripts/deploy-demo.sh                # demo stack on a test server
```

Behind a TLS-inspecting proxy, pass the proxy CA to image builds: `--secret id=build_ca,src=<ca file>` (scripts read `MSCD_BUILD_CA`).

## Rules that are easy to break

- **Generated views.** Do not edit `apps/web/src/views/*.jsx` by hand. Edit `project/MSCD Mockup.dc.html` (or `apps/web/scripts/convert-template.mjs`), then run `npm run gen:views -w @mscd/web`. `npm run gen:views:check -w @mscd/web` fails when they drift.
- **Accessibility.** No text under 12px, WCAG AA contrast in light and dark themes. `apps/web/e2e/contrast.spec.js` enforces both.
- **Demo material.** Files in `deploy/compose/config/demo-secrets/`, `packages/pack-tools/dev-keys/` and the seed data are public development values. They must never reach a release. `deploy/scripts/check-release-artefacts.sh` checks bundles and images.
- **Writing rules** for docs and UI text: plain English, no em dash, no centre dot. `npm run check:text` checks docs.
- **Demo login.** Password `Mscd-Demo-2026!` for every demo user; TOTP code from `node tools/scripts/demo-totp.mjs <handle>`.

## Working with the product owner

- Answer in simple English, even when the message is in Indonesian.
- No em dashes, no centre dots, no "X, not Y" sentences, no meta commentary, no small or low-contrast text in anything you produce.
- The product owner is not an ISO auditor. Use correct audit terms and explain them in plain words.

## Product decisions

Confirmed by the product owner on 2026-10-27 (the defaults that were already built):

1. Google Drive repositories in a personal My Drive are allowed, as well as Shared Drives.
2. Pending work per person: MS Manager and Programme Owner see the detail; Top Management sees totals only.
3. Internal Auditors do not verify items and do not see everyone's pending list.
4. Phases are shown in order; the hard block applies only at critical gates.
5. The licence user count is active members, without guests.
6. The Programme Owner keeps verify and approve rights.
7. New SaaS organisations do not default to SSO-only sign-in.
8. A moved or changed evidence file shows "cannot be verified" in evidence lists and does not lower the item status.

9. Production target: MSCD runs as multi-tenant SaaS for many customer organisations, first on one VPS, deployed by a GitHub Actions workflow (the cloud agent cannot SSH). On-premise stays supported.

Still open: the terminology changes proposed in `docs/product/USER-FLOWS.md`.

## Open follow-ups

- Installer scripts: save the Compose project name so an install made with `COMPOSE_PROJECT_NAME` can be removed without it; optionally accept a default organisation with `install.sh --yes`.
- Server: a command to grant `platform_operator` and an offline `mscd-server diagnostics` command.
- Helm chart: a Job or documented values for `tenant create` and `admin create-user`.
- Bundle: a third-party notices file (the common-passwords list carries the SecLists notice).
- `docs/DEVELOPMENT.md`: a section for the API E2E project and the current default data source (`api`).
- Smoke test: make the strict picker layout check the default now that the picker scrolls.
- Web E2E stack (`apps/web/e2e-api/stack.mjs`): only remove leftover containers whose expiry label has passed.
