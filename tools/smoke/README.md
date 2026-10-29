# Full-stack smoke test

`npm run test:smoke` checks one user journey through the complete MSCD stack: the web image, the api, the worker, the storage gateway, PostgreSQL, SeaweedFS, the provider mocks, Mailpit and Keycloak (build plan J.9).

## What it does

1. Builds three images with the build CA (R-12): `cyberlentera/mscd-server-demo` (target `demo` of `deploy/docker/server.Dockerfile`), `cyberlentera/mscd-web` and `cyberlentera/mscd-mock-providers`, all tagged `smoke` unless `MSCD_VERSION` is set. Build logs go to `test-results/build-*.log`.
2. Removes what an earlier interrupted run of the same project left behind, checks that the published ports are free and that the internal network range is not used by another Docker network.
3. Starts `deploy/compose/docker-compose.yml` with the demo overlay `deploy/compose/docker-compose.demo.yml` as Compose project `mscd-smoke` (`up -d --wait`), so migrations, the demo seed and every health check have finished.
4. Runs the Playwright suite in `tests/` with Chromium. The browser maps the name `keycloak` to this host (`--host-resolver-rules=MAP keycloak 127.0.0.1:<port>`), because Keycloak's issuer is `http://keycloak:18088` for the browser and the containers alike.
5. Runs `docker compose down -v`: on success, on failure and on Ctrl-C. Before that, after a failure, the service logs are saved to `test-results/compose.log`.

The journey, in order and in one browser session:

| Step | Check |
|---|---|
| Stack | `/healthz`, `/api/v1/system/profile` (demo mode), the Keycloak provider in `/api/v1/auth/providers`, the Mailpit API |
| Sign-in | `rina` with password and TOTP on `/login` and `/login/mfa`; `GET /api/v1/me` answers with her account |
| Portfolio | four management system cards (ISMS, QMS, BCMS, ABMS) |
| ISMS controls | the reference counts of UI 4.7: 61 of 93 implemented, 18 partial, 4 open checkpoint items, 14 of 22 documents approved, 5 expired |
| Mark complete | `A.5.13` shows the toast and becomes "Complete, awaiting verification" |
| SharePoint link | `EV-0124` is re-linked to `Access-Review-Q3-2026.xlsx` from the mock SharePoint picker and leaves the "File cannot be verified" list |
| Managed Vault | a generated file is uploaded to `EQ-0154` (QMS); the drawer shows its SHA-256, compared with the hash computed by the test |
| Integrity check | the page action starts the check and confirms with a toast |
| Reminder | a reminder for `A.5.1` is sent and the email `[MSCD] Reminder ...` to Rina arrives in Mailpit |
| Keycloak | `bagus` signs in through the Keycloak login form, then the local TOTP step (F.5) |
| Sign out | Sign out returns to `/login` and `GET /api/v1/me` answers 401; no page error and no 5xx answer happened during the journey |

TOTP codes come from `lib/totp.mjs`, a copy of the logic of `tools/scripts/demo-totp.mjs` (secret rule of G.3, RFC 6238). The runner checks the copy against the RFC 6238 test vectors before it starts.

## Running it

```bash
npm run test:smoke                       # build the images, then test
SMOKE_SKIP_BUILD=1 npm run test:smoke    # use the images of an earlier build
```

Requirements: Docker with BuildKit and Compose v2, about 4 GB of free memory, the Chromium of Playwright 1.56.1, and the images `postgres:16.15-alpine`, `chrislusf/seaweedfs:4.48`, `axllent/mailpit:v1.31.3`, `keycloak/keycloak:26.7.5` and `node:22-alpine` (pulled when missing).

Options are given to the runner itself:

```bash
node tools/smoke/run-smoke.mjs --build-ca /path/to/proxy-ca.pem
node tools/smoke/run-smoke.mjs --keep            # leave the stack running after the tests
node tools/smoke/run-smoke.mjs --down            # remove a stack left by --keep
node tools/smoke/run-smoke.mjs -- --headed       # arguments after -- go to "playwright test"
```

| Variable | Default | Meaning |
|---|---|---|
| `MSCD_BUILD_CA` | empty file | CA certificate of a TLS-inspecting proxy for the image builds (`--build-ca` wins) |
| `SMOKE_SKIP_BUILD` | unset | `1` uses the existing images |
| `SMOKE_KEEP` | unset | `1` is the same as `--keep` |
| `SMOKE_STRICT_LAYOUT` | `1` | the picker step fails when a modal button stays outside the window after its list is scrolled to it; `0` presses such a button with the keyboard and records the overflow in the report instead (see "Layout check of the picker") |
| `SMOKE_PROJECT` | `mscd-smoke` | Compose project name |
| `SMOKE_OUTPUT_DIR` | `tools/smoke/test-results` | build logs, Compose logs, the Playwright report (`report/`) and traces (`artifacts/`) |
| `MSCD_VERSION` | `smoke` | tag of the three images |
| `MSCD_SERVER_DEMO_IMAGE`, `MSCD_IMAGE`, `MSCD_MOCK_IMAGE` | `cyberlentera/mscd-server-demo`, `cyberlentera/mscd-web`, `cyberlentera/mscd-mock-providers` | image repositories |
| `MSCD_HTTP_PORT`, `MSCD_HTTPS_PORT`, `MSCD_KEYCLOAK_PORT`, `MSCD_MAILPIT_PORT` | 18080, 18443, 18088, 18025 | published ports on 127.0.0.1 |
| `MSCD_SUBNET`, `MSCD_WEB_ADDRESS` | `172.31.250.0/24`, `172.31.250.10` | internal network and the fixed web address; when another Docker network uses the default range, the runner picks a free `172.31.x.0/24` |

A relative path in `MSCD_BUILD_CA`, `SMOKE_OUTPUT_DIR` or `--build-ca` is taken from the folder where `npm run test:smoke` (or `node`) was started.

The runner gives Compose an empty `--env-file` and passes the published ports and `MSCD_BIND_ADDRESS=127.0.0.1` itself, so a `deploy/compose/.env` of an on-premise install (ports 80 and 443 on 0.0.0.0, `COMPOSE_PROFILES`) does not change the smoke stack.

The port and network variables are the ones of the Compose files, so a second stack can run next to another one:

```bash
MSCD_HTTP_PORT=28080 MSCD_HTTPS_PORT=28443 MSCD_KEYCLOAK_PORT=28088 MSCD_MAILPIT_PORT=28025 \
  SMOKE_PROJECT=mscd-smoke-2 npm run test:smoke
```

Exit codes: 0 when every check passed, 1 when a build, the stack or a test failed, 2 for wrong usage or a missing requirement (Docker not running, a port in use, a missing image with `SMOKE_SKIP_BUILD=1`).

## When it fails

- The runner prints the last lines of every service that did not become healthy; all logs are in `test-results/compose.log`.
- `npx playwright show-report tools/smoke/test-results/report` opens the report with the screenshot and the trace of the failed step.
- `node tools/smoke/run-smoke.mjs --keep` keeps the stack for a look in the browser at `http://localhost:18080` (sign-in users and passwords: G.3 of the build plan and `deploy/compose/dev/README.md`).

## Layout check of the picker

The demo SharePoint folder lists 82 files. The repository picker scrolls its file list, so a mouse user reaches every row and the "Link selected file" button in a 900 px window. The step scrolls the list to the row first, as a person does, and fails when a button still lies outside the window (`SMOKE_STRICT_LAYOUT=1`, the default since M2-18). `SMOKE_STRICT_LAYOUT=0` brings back the old workaround for a look at a layout problem: the button is pressed with the keyboard and the overflow is recorded as an annotation of the report.

# Fresh-organisation journey

`npm run journey -w @mscd/smoke` runs the journey of MILESTONE-2 M2-18: a customer organisation without demo data runs its ISO/IEC 27001 programme in the browser, from the first administrator's invitation to the certificate. `npm run journey -w @mscd/smoke -- --saas` runs the SaaS variant. Both take the host lock like the smoke test (R-05), because they publish the same ports:

```bash
flock /tmp/mscd-stack.lock npm run journey -w @mscd/smoke
flock /tmp/mscd-stack.lock npm run journey -w @mscd/smoke -- --saas
```

## What it does

1. Builds the same three images as the smoke test (or uses them with `SMOKE_SKIP_BUILD=1`).
2. Starts `deploy/compose/docker-compose.yml` with the demo overlay and `compose/journey.yml` as project `mscd-journey` (`mscd-journey-saas` with `--saas`). The server demo image accepts the development keys; the overlay turns the demo seed off, so the database holds no organisation; Mailpit, the provider mocks and Keycloak come from the demo overlay. The server date is fixed to today in the organisation's time zone (`demo.fixed_today`), so a run that crosses midnight keeps one date.
3. Runs the installer step through the cli service. On-premise: `tenant create` and `admin create-user --tenant-admin`, which emails the invitation to Mailpit, and signs the organisation's licence with the development licence key (`packages/pack-tools/dist/cli.js licence sign`, built when missing) into a private temporary folder. With `--saas` (`compose/journey-saas.yml`: tenancy mode multi with one schema per organisation, mail required, the plan presets, the provider mocks answering DNS on a fixed address, Keycloak allowed for discovery): `admin create-operator`, which emails the set-password link.
4. Registers a certificate for an app of the mock SharePoint tenant, as the customer's Microsoft 365 administrator registers the MSCD app before the repository is connected.
5. Runs `tests/fresh-org.spec.mjs` (configuration `journey.config.mjs`): each person in their own browser session, every step on screen. Emails are read from Mailpit, authenticator codes come from the secret each person enrolled, and the team signs in through Keycloak. The journey fails on any page error, console error or 5xx answer, and checks every new screen with the readability check of `lib/readable.mjs` (WCAG AA contrast and no text under 12px): the screens of the sidebar, the sign-in pages and the first screen each person lands on. A check whose scope finds no visible text fails.
6. Removes the stack, its volumes and the temporary folder (licence, certificate key, enrolled secrets).

## The people

| Person | Account | Roles |
|---|---|---|
| Ana Wijaya | local | first Tenant Admin |
| Dewi Lestari | local | second Tenant Admin: approves the grant that needs four eyes |
| Rina Kusuma | Keycloak `rina` | Management System Manager (primary) of the ISMS |
| Hendra Wijaya | Keycloak `hendra` | Top Management and Programme Owner (the second person who verifies) |
| Bagus Prasetyo | Keycloak `bagus` | Domain Owner and Storage Admin |
| Maya Putri | Keycloak `maya` | Internal Auditor |
| Oki Pratama (`--saas`) | local | platform operator |

## The steps

| Step | On screen |
|---|---|
| First administrator | opens the emailed invitation, sets a password, enrols the authenticator and lands on Getting started |
| Licence | on-premise: Licence, Install licence with the signed file. SaaS: the operator creates the organisation and installs its licence in the operator console, and verifies the email domain (TXT record in the mock DNS); the Tenant Admin's Licence screen shows the licence without Install licence |
| Team | People and roles invites the second administrator and the team (emails from Mailpit); the second administrator accepts with a password |
| Repository | Connect repository: the SharePoint library of the mock, its certificate and Test connection |
| Routing | a rule for confidential files of the whole organisation to the Managed Vault |
| Company sign-in | Add OIDC provider (Keycloak) and Test; the team accepts the invitations through it and enrols the MSCD authenticator; local sign-in limited to administrators |
| System | New management system: ISO/IEC 27001 with scope, certification body and the Managed Vault as default repository (the library has no ISMS folder yet). The SaaS variant ends here |
| Setup | Grant role for the four roles, the grant to the Storage Admin approved by the second administrator in Pending approvals; Start implementation |
| Audits and checklist | the Management System Manager plans the Stage 1 and Stage 2 audits; Getting started shows every step done |
| Programme | a risk with a treatment and the risk owner's residual acceptance; Import of the justifications of ten controls and Edit entry of A.5.1; POL-01 from its template with a file uploaded from the browser into the Managed Vault, approved by Top Management; the ISMS moves to the library (its folder in the repository settings, the credential set again and tested, then Edit in Management systems makes the library the default repository); evidence of A.5.1 with a file from the library, completed by its owner and verified by the manager; an internal audit with its outcome, report and a finding; a corrective action implemented by its owner |
| Five weeks later | the server date moves forward (api and worker recreated with a later `demo.fixed_today`): the effectiveness check by a third person, the finding closed; the management review with every input, held and closed by Top Management; the Stage 2 result and the certificate; the system certified with its expiry date, and the readiness of the clauses above 0 on Overview |

## Running it

| Variable | Default | Meaning |
|---|---|---|
| `JOURNEY_PROJECT` | `mscd-journey`, `mscd-journey-saas` | Compose project name |
| `JOURNEY_OUTPUT_DIR` | `tools/smoke/test-results/journey` (or `journey-saas`) | build logs, Compose logs, the Playwright report and traces |
| `JOURNEY_TIME_ZONE` | `Asia/Jakarta` | time zone of the organisation and of the server date |
| `SMOKE_SKIP_BUILD`, `SMOKE_KEEP`, `MSCD_VERSION`, the image, port and network variables | as for the smoke test | |

`--keep` leaves the stack running and prints the temporary folder with the state of the run; `--down` removes it (`JOURNEY_PROJECT=... node tools/smoke/run-journey.mjs [--saas] --down`).

The development keys and the signed licence stay in the temporary folder of the run and never enter the repository. The release check (`deploy/scripts/check-release-artefacts.sh`) refuses them in any release artefact.
