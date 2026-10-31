# MSCD developer guide

How to set up the MSCD repository, run the web app and its tests, and build the images on a development machine. The build plan is [platform/BUILD-PLAN.md](platform/BUILD-PLAN.md); the target architecture is [ARCHITECTURE.md](ARCHITECTURE.md).

## Prerequisites

| Tool | Version | Used for |
|---|---|---|
| Node.js | 22.22 or later in the 22 line (`.nvmrc` holds `22.22.0`; every `package.json` says `"node": ">=22"`) | Everything below |
| npm | 10 (ships with Node 22) | Workspaces and the single root `package-lock.json` |
| Playwright Chromium | Build 1194, the build that `@playwright/test` 1.56.1 expects | The E2E suite |
| Docker Engine with Buildx and Compose | Docker 23 or later for image builds; Docker 25 and Compose 2.24 or later for the developer stack | Images and the developer infrastructure stack |

With `nvm`, run `nvm use` at the repository root to switch to the version in `.nvmrc`.

Playwright looks for its browsers in `PLAYWRIGHT_BROWSERS_PATH`, or in its default cache folder when that variable is not set. If Chromium build 1194 is not installed yet, install it once:

```bash
npx playwright install chromium
```

## Repository layout

The repository is one npm workspace with the members `apps/*`, `packages/*` and `tools/*`:

| Path | Contents |
|---|---|
| `apps/web` | The React single-page app (package `@mscd/web`): controller `src/MscdApp.jsx`, generated views in `src/views`, the data sources in `src/data` (sample data, and the API source in `src/data/api`), sign-in pages in `src/auth`, Playwright suite in `e2e/` |
| `deploy/docker/web.Dockerfile` | The web image, built with the repository root as the build context |
| `deploy/` | NGINX configuration, Compose files, Helm chart and the on-premise scripts ([deploy/README.md](../deploy/README.md)) |
| `deploy/compose/dev` | Developer infrastructure stack: PostgreSQL, object store, Valkey, Keycloak and Mailpit ([README](../deploy/compose/dev/README.md)) |
| `project/` | The Claude Design handoff. `project/MSCD Mockup.dc.html` is the source of the generated views; everything else is reference only |
| `docs/` | Architecture, build plan, install guide and this guide |

The server, shared contract, pack tools and test tools join the workspace as `apps/server`, `packages/*` and `tools/*`.

## Install

Run once after cloning, and again whenever `package-lock.json` changes:

```bash
npm ci
```

`npm ci` installs every workspace from the root lockfile into the root `node_modules`. There is no lockfile inside a workspace. To add a dependency to a workspace, run from the repository root:

```bash
npm install <package>@<exact version> -w @mscd/web
```

## Run the web app

```bash
npm run dev -w @mscd/web       # development server on http://localhost:5173
npm run build -w @mscd/web     # static files in apps/web/dist
npm run preview -w @mscd/web   # serves apps/web/dist on http://localhost:4173
```

By default the app runs fully in the browser on a fictional sample organisation, so no back end is needed (to use the api instead, see [Run the web app against the api](#run-the-web-app-against-the-api)). Display settings come from the query string, for example `http://localhost:5173/?lang=id&theme=dark`; [apps/web/README.md](../apps/web/README.md) lists them.

## Browser suites

The Playwright specs in `apps/web/e2e` run in two suites: the sample suite against the sample build (`apps/web/playwright.config.js`) and the API suite against a seeded api (`apps/web/playwright.api.config.js`). Specs tagged `@api-only` (`e2e/api-only`) run only in the API suite, and tests tagged `@sample-only` only in the sample suite.

```bash
CI=1 npm run test:e2e -w @mscd/web                                             # sample suite
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web                   # API suite (Docker)
flock /tmp/mscd-stack.lock npm run test:e2e:all -w @mscd/web                   # both, inside the memory budget
CI=1 npm run test:e2e -w @mscd/web -- e2e/portfolio.spec.js                    # one spec file
CI=1 npm run test:e2e -w @mscd/web -- -g "Golden Thread"                       # tests whose title matches
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web -- e2e/api-only/license.spec.js
```

`npm run test:e2e` and `npm run test:e2e:api` at the root run the workspace scripts. On a shared machine, wrap every API run in the lock: it keeps two stacks from fighting over the fixed ports.

### Sample suite

`tools/scripts/e2e-web-serve.mjs` builds the app with the sample data source and serves the build on port 4173 (`vite preview`). The build runs only when the sources of the app changed since the last build; otherwise the run reuses it. A server already listening on port 4173 (a leftover `npm run preview`, for example) makes the run stop with an error instead of testing a stale build. The suite runs fully parallel on up to 10 workers, as many as the memory budget allows.

### API suite and its lanes

`apps/web/e2e-api/stack.mjs` is the web server of the API suite. It needs Docker. It runs several lanes so that the tests run in parallel, and Playwright runs one worker per lane: the worker with parallel index `n` uses lane `n` (`e2e-api/fixtures.js`). Each lane has its own database, api, storage gateway, mock providers (with their DNS responder), Mailpit and object store bucket, so nothing a test writes is visible to a test of another lane. The lanes share one PostgreSQL container, one SeaweedFS container and one API web build, served for every lane by one process (`e2e-api/web-server.mjs`).

| Lane `n` | Port |
|---|---|
| Web app (`baseURL` of the tests) | 4174 + n |
| api | 3174 + n |
| Mock providers | 4310 + 10 x n |
| Storage gateway | 4311 + 10 x n |
| DNS responder of the mock providers (UDP) | 4312 + 10 x n |

- Every test starts from the seed state: before each test the lane's api puts its database back to the seeded template and a session of `rina` is minted. A spec picks another demo user with `test.use({ apiSession: 'maya' })`, or `null` for no session. A test reaches its lane through `baseURL` (`page.goto('/')`, `page.request`, new contexts) and `stackState()` of `e2e-api/fixtures.js` (mock providers, Mailpit).
- The reset recreates the database only when something wrote since the last reset: the test-support module of the api records every request other than GET or HEAD, the sign-in and storage consent callbacks, every audit entry and every job run (`apps/server/src/modules/test-support/write-tracker.ts`). A reset with nothing to undo deletes the minted sessions and answers at once. `E2E_STACK_RESET=always` recreates the database at every reset, as before.
- The test PostgreSQL runs with `fsync`, `synchronous_commit` and `full_page_writes` off, and the reset clones with `STRATEGY FILE_COPY`. These settings exist only in this test stack.
- `E2E_API_LANES` sets the number of lanes (default: what the memory budget allows, at most 6). Never run more workers than lanes.
- `MSCD_TEST_CONTAINER_PREFIX` names the containers and run volumes `<prefix>e2e-<service>-<random>` (default `mscd-`). At start the stack removes containers and run volumes of an earlier, killed run only when their `mscd.test.expires` label has passed (3 hours after they started) and their name has the same prefix. A stack still running in another session keeps its containers.
- The api and the reset reach PostgreSQL over its Unix socket (the container's socket folder is shared with the host), and the api, the storage gateway and the tests reach SeaweedFS and Mailpit on the containers' own addresses, so no query goes through Docker's port proxy. Where the host cannot reach them that way (Docker Desktop), the stack falls back to the published ports on 127.0.0.1; `E2E_STACK_DIRECT=off` always uses the published ports.
- `e2e-api/web-server.mjs` (and `tools/scripts/e2e-web-serve.mjs` of the sample suite) serves the files of the build's `assets/` folder from memory with the headers NGINX gives them in production: pre-compressed with gzip, and cached for a year when the name carries a content hash (`tools/scripts/e2e-assets.mjs`).
- `E2E_STACK_SKIP_BUILD=1` skips the server and mock provider builds; `MSCD_TEST_PG_IMAGE` replaces the PostgreSQL image; `E2E_STACK_TENANCY=multi` runs the stack with tenancy mode multi.
- Failures leave traces in `apps/web/test-results/api/` and the report in `apps/web/e2e-report/api/`.

### Memory budget

The whole machine stays at or below `E2E_MEMORY_BUDGET_MB` in use (`MemTotal - MemAvailable`, default 12288). Each suite reads the memory in use when it starts and chooses its lanes or workers from `tools/scripts/e2e-budget.mjs`: about 1.1 GB per API lane (its api, gateway, mock providers and Mailpit with one worker and its Chromium) after a fixed 1.5 GB, and about 0.6 GB per sample worker after a fixed 1.2 GB, at most half the CPUs. Every container of the stack has a memory limit. `E2E_SAMPLE_WORKERS` and `E2E_API_LANES` override the choice.

Both suites run Chromium with `--disable-gpu`: software compositing draws the same pictures (the app draws on 2D canvases only, and CI runners have no GPU) for about a tenth less browser CPU.

Every run of either suite ends with a line that gives the peak memory in use during the run against the budget (`tools/scripts/e2e-memory-reporter.mjs`). `npm run test:e2e:all -w @mscd/web` (`tools/scripts/e2e-all.mjs`) runs both suites: side by side when both fit the budget, else one after the other. It samples the memory in use every 2 seconds and ends with a summary: wall time, test count and peak memory in use of each suite, and the peak of the whole run against the budget.

### Build and template cache

A cold start builds everything; later runs reuse what did not change. The keys and outputs are in `node_modules/.cache/mscd/e2e/`:

- the server and the mock providers build again only when their sources changed (a SHA-256 of the source files; for the server also the migrations, `apps/server/scripts/gen-build-info.mjs` and the development keys in `packages/pack-tools/dev-keys`, which the prebuild writes into `src/generated`);
- the web builds (`web-api-<key>`, `web-sample-<key>`) are kept for the current sources, three per data source;
- the migrated and seeded template database lives in the Docker volume `mscd-e2e-cache-pg-<key>`, whose key covers the migrations, every server source (the key of the server build, so a change to code the seed runs builds the template again, in about 16 seconds), the packs, the test profile, the development secrets, the development licences in `packages/pack-tools/dev-licences` that `seed demo` loads, the PostgreSQL image and the tenancy mode. The cluster of a run is a copy of that volume.

A normal run never removes a cache volume. To clear the cache:

```bash
docker volume ls -q --filter name=mscd-e2e-cache | xargs -r docker volume rm
rm -rf node_modules/.cache/mscd/e2e
```

`E2E_STACK_CACHE=off` makes one run build the template and the web build again without using or changing the cache. Each server change leaves one older cache volume of about 115 MB behind; the commands above remove them.

### Reports, traces and CI

Failures leave screenshots in `apps/web/test-results/` and an HTML report in `apps/web/e2e-report/` (open it with `npx playwright show-report apps/web/e2e-report`). Both folders are git-ignored. Recording traces tripled the time of a local run, so a local run (also with `CI=1`) records them only on a retry; add `E2E_TRACE=retain-on-failure` (or `--trace retain-on-failure`) to keep the trace of a failure you look into. GitHub Actions keeps the traces of every failure.

In CI each suite runs as shards of a matrix (`--shard=i/n`: 4 for the sample suite, 8 for the API suite); each shard writes a blob report (`E2E_REPORT=blob`), and the final jobs "Web E2E (sample data)" and "Web E2E (API)" merge them into one HTML report and fail when a shard failed. On a runner with 4 CPUs a shard runs 2 sample workers or 2 API lanes.

### Data source of the web app

The data source of a build is set by `VITE_DATA_SOURCE` when it is built. `npm run dev`, `npm run build` and the sample suite use the sample data when it is unset. The API suite, the `mscd-web` image and release bundles build with `api`, which is the default of `deploy/docker/web.Dockerfile`.

## Generated views

The screen components in `apps/web/src/views/*.jsx` and the hover rules in `apps/web/src/hover.css` are generated from `project/MSCD Mockup.dc.html` by `apps/web/scripts/convert-template.mjs`. Never edit them by hand. The one exception is `apps/web/src/views/util.js`, which holds hand-written helpers the views import.

To change a screen's markup, change the design template or the patch list at the top of the converter, then regenerate:

```bash
npm run gen:views -w @mscd/web
```

Every change to the web app runs the check, which regenerates the views and `hover.css` into a temporary folder and fails, listing the files, when a generated file is missing, extra or different:

```bash
npm run gen:views:check -w @mscd/web
```

The converter also takes `--out <dir>` to write the views to `<dir>/views/` and the hover rules to `<dir>/hover.css` instead of `apps/web/src`.

## Adding a screen

New screens live in their own folder under `apps/web/src/screens/<id>/` and never change the generated views or a shared file: the screen host finds every `./*/index.tsx` with `import.meta.glob` (MILESTONE-2 C.1 and C.2). The Licence screen (`screens/license`) is the reference.

| File | Content |
|---|---|
| `index.tsx` | The default export is the `ScreenDef` (`screens/types.ts`): `id`, `path` ending with the id, `group` (`top`, `impl`, `audit`, `surv`, `tasks`, `admin`, `ops`), `order` inside the group, `label` as `[English, Indonesian]`, `icon` (a 24 by 24 stroke path), `scope` (`org`, `ms`, `platform`), `perm`, `roles` (sample personas that see it), `nav`, `Component` (lazy), `pageActions(ctx)`, `count(ctx)` and `tera` help |
| `meta.json` | The same `id`, `label`, `group`, `order`, `scope`, `perm`, `roles` and `nav`, plus `pageActions` (labels for the manager persona), `sampleRole` (the persona the E2E helpers open it as) and `open` (`nav` from the sidebar, `query` through `?screen=`). The E2E helpers read it; `test/screens/registry.test.tsx` checks that it matches `index.tsx` |
| `Screen.tsx` | The page body. It gets `{ ctx }` with the host context of C.4: `lang`, `li(pair)`, `fill(pair, values)`, `theme`, `D`, `msObj`, `org`, `me`, `mode`, `client`, `can(ms, perm)`, `orgCan(perm)`, `platformCan(perm)`, `toast`, `go(screen, { ms, params })`, `params`, `track`, `reload`, `command`, `openPicker` and `layer()` |
| `routes.ts` | `[method, path]` constants for every route the screen calls and `ROUTE_IDS`, compared with `routeById` of `@mscd/shared` in the screen's unit test |
| `api.ts`, `sample.ts` | Two adapters with one interface: `api.ts` calls `call(ctx.client, ROUTES.x, { params, query, body, ifMatch, idempotencyKey })` of `screens/api.ts`; `sample.ts` works on the sample snapshot (`ctx.ds.mutate` and `ctx.ds.insert` change it, so built-in screens show the result). The build picks one, below |
| `text.ts` | Every text as an `[English, Indonesian]` pair |
| `actions.ts` (optional) | Hooks into the built-in screens, below |

Rules for screen code:

- Build the page from the UI kit in `screens/ui` (`Card`, `Facts`, `Table`, `Badge`, `Button`, `Alert`, `EmptyState`, `Tabs`, `Field` with its inputs, `Modal`, `Drawer`, `ConfirmDialog`). Styles come from the `.mx-` classes of `screens/ui/screens.css` over the colour tokens of `src/styles.css`. No text under 12px, and every text and control meets WCAG AA in both themes. A disabled `Button` takes a `disabledReason`, shown as text.
- Call the api only through `ctx.client` and `screens/api.ts`. Import only types from `@mscd/shared`.
- Pick the adapter with the build value written out in full, and load `sample.ts` with a dynamic import inside the sample branch. Vite replaces `import.meta.env.VITE_DATA_SOURCE` and drops the other branch, so an api build holds no sample code or data (R-13). `adapterFor` in `screens/license/Screen.tsx` shows the pattern:

  ```ts
  return import.meta.env.VITE_DATA_SOURCE === 'api'
    ? createApiAdapter(client)
    : deferredAdapter(() => import('./sample').then((m) => m.createSampleAdapter(getD)));
  ```

  Never import `sample.ts` statically (`import type` is fine): `test/screens/registry.test.tsx` fails on such an import, and the API E2E stack (`e2e-api/stack.mjs`) stops when the api build holds the sample organisations or the sample licence id. Unit tests call `createApiAdapter` and `createSampleAdapter` directly.
- Field errors of a refused command go next to the field: `fieldErrors(error)` maps `errors[].path` to messages. A form keeps its state with `useMutation(run)` of `screens/api.ts`: Save is disabled while it runs, and the error and field errors stay until the next submit. `e2e/screens/probe.spec.js` checks it under React StrictMode, which the development build uses.
- `EmptyState` takes an `illustration` node for a scene of the illustration library.

`actions.ts` exports any of:

- `claims`: handlers for the ids in `ACTION_IDS` of `screens/actions.ts` (for example `controls.add`, `docs.new`, `storage.connect`). Without a claim the built-in action keeps its toast. One package claims each id.
- `extraPageActions`: page actions added to a built-in screen, for example `{ screen: 'fw', id, label, icon, visible(ctx), run(ctx) }`.
- `detailExtensions`: components shown at the end of a detail drawer or an inline detail, by record kind (`req`, `doc`, `ev`, `item`, `activity`, `event`, `prep`, `cycle`), in `order`.
- `topbarItems` and `layerItems`: components shown in the top bar or in the host layer of every screen.

Tests of a screen:

- Unit tests in `apps/web/test/screens/<id>.test.tsx` render with `renderToStaticMarkup` in the Node environment; `test/screens/license.test.tsx` shows the pattern, with the route contract test.
- E2E specs in `apps/web/e2e/screens/<id>.spec.js` carry `@sample-only` and open the screen with `openScreen(page, metaById('<id>'))` of `e2e/helpers.js`. Call `expectOverlayReadable(page)` after opening each form. `e2e/screens/probe.spec.js` checks every host screen's title, breadcrumb, page actions and help. API behaviour goes to `e2e/api-only/<id>.spec.js` with `@api-only`.
- The sample build opens a screen directly with `?screen=<id>&persona=<manager|owner|auditor|top>`, for example `http://localhost:5173/?screen=license&persona=top`. A screen the persona cannot open (its `roles` do not list it) is not opened: the persona lands on its own first screen, as after a persona switch. Without `persona`, the app switches to the first persona in `roles`. API builds ignore both parameters.
- `npm test -w @mscd/web -- test/screens` checks every screen folder: ids, both languages, Indonesian that differs from English, no em dash or centre dot in any text, an icon and a matching `meta.json`.

## Developer infrastructure stack

```bash
npm run dev:stack
```

starts PostgreSQL, the S3-compatible object store and Mailpit with Docker Compose and waits until they are healthy. Valkey and Keycloak start with the Compose profiles `bullmq` and `sso`. Connection strings, keys, logins and how to reset the data are in [deploy/compose/dev/README.md](../deploy/compose/dev/README.md).

## Server, shared packages and tools

Files of this part of the repository:

| Path | Package | Contents |
|---|---|---|
| `apps/server` | `@mscd/server` | NestJS server on Fastify (CommonJS): run modes `api`, `worker`, `storage-gateway` and `migrate`, admin commands, profiles, migrations, unit and integration tests ([README](../apps/server/README.md)) |
| `packages/shared` | `@mscd/shared` | Shared contract: zod schemas, route table, authorisation matrix, OpenAPI generator (ES module) |
| `packages/pack-tools` | `@mscd/pack-tools` | CLI `mscd-pack`: builds, signs and verifies framework packs and licences (ES module) |
| `tools/mock-providers` | `@mscd/mock-providers` | Local Microsoft identity, Graph and Google Drive mocks for tests and the demo |
| `tools/smoke` | `@mscd/smoke` | Full-stack smoke test (Playwright against Compose) |
| `tools/scripts` | none | `check-text.mjs` and `demo-totp.mjs` ([README](../tools/scripts/README.md)) |
| `tsconfig.base.json`, `eslint.config.mjs` | none | Shared TypeScript options (strict, ES2023, `nodenext`) and the ESLint configuration |

### Build, typecheck, lint and unit tests

```bash
npm run build -w @mscd/server     # also builds @mscd/shared and @mscd/pack-tools (project references)
npm run typecheck                 # every workspace
npm run lint                      # TypeScript everywhere and the .mjs scripts outside apps/web
npm test                          # unit tests of every workspace, no Docker needed
```

During development no package needs a build to be used by another: Vitest configurations alias `@mscd/shared`, `@mscd/pack-tools` and `@mscd/mock-providers` to their `src`, and the TypeScript configurations resolve the export condition `@mscd/source` to the same files. Only `node apps/server/dist/main.js` needs the built `dist` folders, which `npm run build -w @mscd/server` produces.

The server lint rules enforce tenant scoping (build plan F.10): outside `src/db`, `src/modules/tenancy` and `src/seed` no use of the injected pool, which means no reference to `this.db` at all and no method call on, hand-off or alias of a binding named `db` (query inside `withTenant` or `withPlatform` on the transaction `trx`, and give a dedicated connection in `src/cli` another name, such as `migrator`); `withPlatform` only in the identity, ops, jobs, audit, packs, license and tenancy modules, `src/cli`, `src/seed` and `src/worker` (any reference to it counts there, including `.call`, `.bind`, `x['withPlatform']`, destructuring and aliases); in SQL strings no `SET` at the start of a statement except `SET LOCAL`, `SET TRANSACTION` and `SET CONSTRAINTS` (comments do not hide one), and `set_config(...)` only with a literal `true` as its third argument. A statement starts at the start of the string, after `;`, after `BEGIN`, `THEN`, `ELSE` or `LOOP`, after a dollar-quote opener and after an opening single quote (dynamic SQL in `EXECUTE '...'` or `format('...')`). `SET` in capitals always counts there; `set` in any other spelling counts only in a SQL statement shape (`set name = v`, `set name to v`, `set role ...`, `set schema ...` and the like, or a bare `'set '` joined to the rest). So English messages such as "Set either A or B" or "The password is missing; set a new one" pass, while a message such as "set it to 5" or one that starts with `SET ` does not, so reword it.

### Integration tests

```bash
npm run test:int -w @mscd/server                      # every suite
npm run test:int -w @mscd/server -- test/int/smoke    # one folder
```

The global setup starts `postgres:16.15-alpine` with Testcontainers (label `mscd.test=true`, no reaper container) and builds the template database `mscd_tpl_empty`; each test file copies it with `useTestDatabase()` from `apps/server/test/setup/test-db.ts`. Variables:

| Variable | Effect |
|---|---|
| `MSCD_TEST_DATABASE_URL` | Use this PostgreSQL server (an administrator URL) instead of a container |
| `MSCD_TEST_PG_IMAGE` | Another image, for example `postgres:15-alpine` or `postgres:17-alpine` |
| `MSCD_TEST_CONTAINER_PREFIX` | Name the container `<prefix>postgres-<random>` |
| `MSCD_TEST_SSO=1` | Also run the Keycloak global setup (OIDC and SAML suites) |

### Run the api locally

```bash
npm run build -w @mscd/server
MSCD_PROFILE_FILE=apps/server/profiles/test.yaml node apps/server/dist/main.js api
curl http://localhost:3000/healthz
curl http://localhost:3000/api/v1/system/profile
```

`/readyz` answers 503 until the database of the profile is reachable (with `test.yaml`, the developer stack on port 55432). Metrics are on port 9464 (`/metrics`).

### Run the web app against the api

The web app has two data sources, chosen when it is built (build plan H.1):

| `VITE_DATA_SOURCE` | Data source | Used by |
|---|---|---|
| unset or `sample` | `src/data/SampleDataSource.js`: the fictional sample organisations, in the browser | `npm run dev -w @mscd/web`, the sample E2E suite |
| `api` | `src/data/api/ApiDataSource.ts`: sign-in pages, then every screen from the api | the `mscd-web` image, `VITE_DATA_SOURCE=api npm run build -w @mscd/web` |

In API mode the app signs in through the api, then reads `GET /me`, `GET /ui/org`, `GET /ui/ms/{ms}` for every system where the user holds a role and `GET /tasks`, and sends every action as a command of the api (build plan H.4). The menu under the user's name shows the demo personas in demo mode and Sign out. A build for the API holds no sample records: `VITE_DATA_SOURCE=api npm run build -w @mscd/web` followed by `grep -r Backup-Job-Log-Sep-2026 apps/web/dist/assets` finds nothing.

To run it against a local api with the demo data:

1. Start the developer stack and load the demo organisations (the second command builds the server, migrates the database of the stack and seeds it):

   ```bash
   npm run dev:stack
   npm run seed:demo
   ```

2. Build the mock providers and start them with the demo fixture, in their own terminal (file pickers, uploads and repository tests of Microsoft 365 and Google Drive go there):

   ```bash
   npm run build -w @mscd/mock-providers
   node tools/mock-providers/dist/server.js --port 4310 --fixtures demo
   ```

3. Start the storage gateway and the api, each in its own terminal, with the demo profile. The demo profile names the services of the Compose demo overlay, so on your machine the addresses of the stack and of the processes above replace them (`MSCD__<SECTION>__<KEY>` overrides, see the next section). When a port is taken, change it in the overrides (`MSCD__HTTP__PORT` for the api, `MSCD__GATEWAY__PORT` together with `MSCD__STORAGE__GATEWAY__URL` for the gateway, `--port` of the mock providers and the four provider addresses) and point `VITE_API_TARGET` of step 4 at the api:

   ```bash
   export MSCD_PROFILE_FILE=apps/server/profiles/demo.yaml
   export MSCD__STORAGE__GATEWAY__URL=http://localhost:8443
   export MSCD__GATEWAY__VAULT__ENDPOINT=http://localhost:58333
   export MSCD__GATEWAY__PROVIDERS__M365__GRAPH_BASE_URL=http://localhost:4310/v1.0
   export MSCD__GATEWAY__PROVIDERS__M365__LOGIN_BASE_URL=http://localhost:4310
   export MSCD__GATEWAY__PROVIDERS__GOOGLE__API_BASE_URL=http://localhost:4310
   export MSCD__GATEWAY__PROVIDERS__GOOGLE__TOKEN_URL=http://localhost:4310/token
   export MSCD__MAIL__SMTP__HOST=localhost
   export MSCD__MAIL__SMTP__PORT=51025
   export MSCD__HTTP__PUBLIC_URL=http://localhost:5173
   export MSCD__OBSERVABILITY__METRICS_PORT=null     # two processes on one machine cannot share port 9464
   export MSCD__DEMO__KEYCLOAK=null                  # the demo Keycloak sign-in needs the sso profile of the stack
   node apps/server/dist/main.js storage-gateway     # terminal 1
   node apps/server/dist/main.js api                 # terminal 2
   ```

4. Start the web development server in API mode. Vite forwards `/api` to `VITE_API_TARGET` (default `http://localhost:3000`, the api of step 3):

   ```bash
   VITE_DATA_SOURCE=api npm run dev -w @mscd/web
   ```

5. Open `http://localhost:5173` and sign in as a demo user, for example `rina`, with the password `Mscd-Demo-2026!` and the code of `node tools/scripts/demo-totp.mjs rina` (see Demo users below). Choose another persona in the menu under the user's name; Sign out is the last entry.

The display settings in the query string (`lang`, `theme`, `drill`, `density`, `layout`, `font`) work in both modes. `npm run preview -w @mscd/web` after an API build serves `apps/web/dist` on port 4173 with the same `/api` forwarding.

Unit tests of the API source and of the controller in API mode run with the other web unit tests (`npm test -w @mscd/web`, files in `apps/web/test/api`); they answer every request with a fake `fetch` built from the sample data, so they need no api.

### Deployment profiles

The server reads the YAML file named by `MSCD_PROFILE_FILE` and validates it strictly at start: an unknown key, a missing key or a forbidden value stops the process with a list of every problem. `apps/server/profiles` holds `onprem.yaml` and `saas.yaml` (release) and `demo.yaml` and `test.yaml` (development builds only; their secrets are the public values in `apps/server/test/fixtures/secrets`). Relative paths in a profile resolve against the profile's folder.

| Override | Example |
|---|---|
| `MSCD__<SECTION>__<KEY>=<YAML value>` | `MSCD__HTTP__PORT=3001`, `MSCD__DEMO__ENABLED=false`, `MSCD__OBSERVABILITY__METRICS_PORT=null` |
| Database URLs (win over `database.*_file`) | `MSCD_DATABASE_URL`, `MSCD_DATABASE_MIGRATOR_URL`, `MSCD_DATABASE_PACK_URL`, `MSCD_DATABASE_ADMIN_URL` |
| The same values from files | `MSCD_DATABASE_URL_FILE=/run/secrets/db-app.url` and so on |

`mscd-server db bootstrap [--with-report-role]` creates the database roles, schema `ext` and extension `pg_trgm` (build plan C.2). It connects with the administrator URL and takes each role's password from that role's URL, so all four URLs must be set. The developer stack already ran the same bootstrap at its first start.

### Build information and flavours

`npm run gen:build-info -w @mscd/server` (also run before every build, typecheck and test) writes `apps/server/src/generated/build-info.ts`: build flavour, version, revision, the platform migrations of the build and the trusted public keys. `MSCD_BUILD_FLAVOR` is `dev` (default; trusts the keys in `packages/pack-tools/dev-keys`) or `release` (trusts only the keys in `MSCD_TRUSTED_KEYS_DIR`, which must hold a `licence-*.pub` and a `pack-*.pub` key and no development key). Release builds also refuse the demo and test profiles at start. `MSCD_VERSION` and `MSCD_REVISION` override the version from `apps/server/package.json` and the Git revision.

### Demo users

Every demo and test user signs in with the password `Mscd-Demo-2026!` and a TOTP code derived from the user's handle:

```bash
node tools/scripts/demo-totp.mjs rina
```

## Root scripts

| Script | What it runs |
|---|---|
| `npm run build` | `build` of every workspace that has one |
| `npm run typecheck` | `typecheck` of every workspace that has one |
| `npm run lint` | ESLint over the repository |
| `npm test` | Unit tests of every workspace that has them |
| `npm run test:int` | Integration tests of `@mscd/server` |
| `npm run test:e2e` | The web E2E suite against the sample data |
| `npm run test:e2e:api` | The web E2E suite against the API |
| `npm run test:smoke` | The full-stack smoke test |
| `npm run openapi` | Writes the OpenAPI document from the shared contract |
| `npm run dev:stack` | Starts the developer infrastructure stack |
| `npm run seed:demo` | Loads the demo organisations into the development database |
| `npm run check:text` | Fails when a document in `docs/` contains an em dash or a centre dot character |

Scripts whose work package has not landed yet fail with a message that names it (for example `npm run test:smoke` until the smoke test exists). `npm run test:smoke` runs the script `smoke` of `@mscd/smoke`, not its `test` script, so `npm test` never starts the full stack.

## Image builds

Every image builds with the repository root as the build context and receives the build CA as a BuildKit secret named `build_ca`. Each `npm` or `apk` step in a Dockerfile mounts it and trusts it only when the file is not empty. Set `MSCD_BUILD_CA` to the CA certificate of the TLS-inspecting proxy between your machine and the npm registry or the Alpine mirrors. Without such a proxy, point it to an empty file, because BuildKit does not accept `/dev/null`:

```bash
export MSCD_BUILD_CA=/path/to/proxy-ca.pem              # behind a TLS-inspecting proxy
# or
: > /tmp/empty-ca.pem && export MSCD_BUILD_CA=/tmp/empty-ca.pem
```

Build and try the web image:

```bash
docker buildx build --load --secret id=build_ca,src="$MSCD_BUILD_CA" \
  -f deploy/docker/web.Dockerfile --build-context nginx-config=deploy/nginx \
  -t mscd-web:dev .
docker run -d --rm --name mscd-web-dev -p 8080:8080 mscd-web:dev
curl -fsS http://localhost:8080/healthz
docker rm -f mscd-web-dev
```

The build argument `VITE_DATA_SOURCE` selects the data source compiled into the app: `api` (the default) or `sample`. The build argument `APK_UPGRADE` controls the Alpine updates of the runtime stage: `auto` (the default) applies them when `apk update` succeeds and otherwise prints a warning and keeps the base image packages, `true` fails the build when `apk update` fails (a mirror that cannot be reached or is blocked by a proxy, or a TLS certificate that is not trusted because `MSCD_BUILD_CA` is missing or wrong), and `false` skips the step. Read the `apk` messages above the warning to tell the two causes apart. Release bundles always pass `true` (or `false` with `--no-os-updates`). The `.dockerignore` at the repository root keeps `node_modules`, build and test output, `deploy/dist` and the design uploads out of the build context. Release bundles are built with `deploy/scripts/build-bundle.sh`, which takes the CA file as `--build-ca <file>` ([deploy/README.md](../deploy/README.md)).
