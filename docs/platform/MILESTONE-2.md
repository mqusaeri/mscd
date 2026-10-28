# MSCD Milestone 2 Plan

| | |
|---|---|
| Purpose | The implementation plan for Milestone 2: decisions, server additions, pack content, web extension points and ordered work packages, written for the agents that build them |
| Goal | A real customer can be onboarded and run its ISO programme entirely from the web app, on a fresh organisation with no demo data, without the browser console helper, after the installer or the platform operator has created the organisation and its first administrator (A.2). The same release runs in production as a multi-tenant SaaS service, and on-premise stays supported (A.1, section K) |
| Inputs | `docs/platform/BUILD-PLAN.md` (Milestone 1, cited as "BP" with its section, for example "BP F.6"), `docs/platform/ui-contract.md`, `docs/platform/handoff/WP-*.md`, the user-flow gap study (customer onboarding, user and role assignment, document preparation, clauses) and code research on the web app, the API contract, the server and the packs, checked against the repository on 27 October 2026, plus the SaaS research on operator tools, deployment, backups, monitoring and Indonesian data protection (section K) |
| Starting point | All 39 Milestone 1 work packages are built and verified on branch `mscd-platform`. The web app reaches 52 of the 185 contract routes. The other 133 are reachable only through the API |
| Out of scope | Section B |
| Build environment | As BP header: Linux container, 4 CPUs, 15 GB RAM, Node 22.22 and npm 10, Docker 29 with Compose v5, Playwright Chromium 1194, TLS-inspecting proxy (CA bundle `/root/.ccr/ca-bundle.crt`). At most four agents work at the same time in Milestone 2, counted across both tracks (R-02) |

## Contents

- [0. Rules for implementing agents](#0-rules-for-implementing-agents)
- [A. Goal, scope and decisions](#a-goal-scope-and-decisions)
- [B. Out of scope](#b-out-of-scope)
- [C. Web extension points](#c-web-extension-points)
- [D. Server additions](#d-server-additions)
- [E. Pack content and upgrade path](#e-pack-content-and-upgrade-path)
- [F. Testing in Milestone 2](#f-testing-in-milestone-2)
- [G. Work packages](#g-work-packages)
- [H. Questions for the product owner](#h-questions-for-the-product-owner)
- [I. Risks](#i-risks)
- [J. Contract tables](#j-contract-tables)
- [K. SaaS production track](#k-saas-production-track)
- [L. Motion track](#l-motion-track)
- [Review notes](#review-notes)

## 0. Rules for implementing agents

The rules R-01 to R-13 of BP section 0 still apply to every Milestone 2 work package (M2 package), with the changes in the second column. R-14 to R-18 are new. All rules apply to both tracks of Milestone 2: the core track (sections C to J, packages M2-01 to M2-18) and the SaaS production track (section K, packages M2-S01 to M2-S13), which adds the rules S-1 to S-7 of K.1.

| # | Status in Milestone 2 | Rule or change |
|---|---|---|
| R-01 | Applies | Work only inside the paths your package owns (G.2 "Owns"). A path owned by a finished package may be edited only when your package lists it. |
| R-02 | Changed | At most four packages run at the same time (was two), counted across both tracks. Packages in one wave never own the same file. The shared files of Milestone 2 have exactly one owner per wave, named in the combined wave table of G.1. |
| R-03 | Changed | No new npm dependency is planned. Import parsing uses `exceljs` and `csv-parse`, already server dependencies. M2-03 is the only lockfile owner, for the server version change to 1.1.0 (`npm install --package-lock-only`). Any other missing package goes in the handoff note, and the orchestrator adds it between waves. |
| R-04 | Applies | Never hand-edit `apps/web/src/views/*.jsx` (except `util.js`) or `apps/web/src/hover.css`. Changes go through `project/MSCD Mockup.dc.html` or the `PATCHES` of `apps/web/scripts/convert-template.mjs`, then `npm run gen:views -w @mscd/web`. In Milestone 2 only M2-01 and M2-17 change the converter or the template. |
| R-05 | Changed | The fixed ports stay. The API E2E stack (4174, 3174, 4310, 4311) and the Compose stacks (18080, 18443, 18088, 18025) can run only once per host, so every run of `test:e2e:api`, `test:smoke` and the journey takes the host lock: `flock /tmp/mscd-stack.lock <command>`. Vitest suites keep random ports. |
| R-06 | Applies | Docker Hub pull limit, images of BP A.3 only, no `:latest`, `TESTCONTAINERS_RYUK_DISABLED=true`. |
| R-07 | Changed | Status codes, enum values and table names are exactly as written in BP and in section D of this plan. Section D wins where it changes BP. |
| R-08 | Applies | Writing rules for documentation and UI text: plain English, no em dash, no centre dot, no notes about the writing itself. `npm run check:text` checks `docs`. |
| R-09 | Changed | Definition of done as BP R-09. The handoff note goes to `docs/platform/handoff/M2-nn.md` (core) or `docs/platform/handoff/M2-Snn.md` (SaaS). |
| R-10 | Changed | Agents never commit or push. The orchestrator commits once at the end of each wave, so `git diff HEAD` in an acceptance block shows only the current package's changes. |
| R-11 | Applies | Development keys only in the folders named in BP R-11. |
| R-12 | Applies | Every image build passes `--secret id=build_ca,src="$MSCD_BUILD_CA"`. |
| R-13 | Applies | Release artefacts never contain development keys, demo profiles or seed data. M2-18 extends `deploy/scripts/check-release-artefacts.sh` with a check for the demo texts listed in E.4. |
| R-14 | New | New route ids, permissions, enum values, profile keys and the tenant and platform migrations of both tracks appear only in wave 1a (M2-02). Every new route id is listed in D.1 and J.1. The only other migration is the ref migration of M2-03 in wave 1b (D.3), and M2-03 may add in `packages/shared/src/pack/**` the pack-format values listed in E.1, D.3 and J.7, and no others. From wave 2 on, a package may change the request or response schema of a route in the area files it owns, but adds no route id, profile key or migration and changes no permission, enum value or matrix row. A needed change of that kind goes in the handoff note, and the orchestrator applies it between waves. |
| R-15 | New | The demo keeps working: `bash deploy/scripts/deploy-demo.sh` still loads, `npm run test:int -w @mscd/server -- test/int/seed test/int/parity` and `CI=1 npm run test:e2e -w @mscd/web` pass after every package, and no Milestone 1 test is deleted or weakened. A test whose expected value changes because of a deliberate content change (E.2) is updated in the same package, with the reason in the handoff note. |
| R-16 | New | Every new screen, form, drawer and dialog follows decision D2-01: hand-written React (`.tsx`), tokens of `apps/web/src/styles.css` only, English and Indonesian text for every label, no text under 12px, WCAG AA contrast in light and dark. |
| R-17 | New | Web packages call the API only through the ApiClient of the host context (C.4). They never create their own client, never import zod at run time and import only types from `@mscd/shared`. |
| R-18 | New | Every new server write keeps the Milestone 1 guarantees: guard and F.6 permission, scope policy, `If-Match` where the record has a version, one audit entry per change, business rules through the rule engine, and `freshness.recompute` or `readiness.recompute` queued where the data feeds them. |

## A. Goal, scope and decisions

### A.1 Goal

At the end of Milestone 2 a customer organisation that holds no demo data can do every step of its ISO programme in the browser:

1. The organisation administrator signs in, installs the licence, invites a second administrator and the team, grants roles, connects storage, sets the sign-in policy and creates its management systems with their scope.
2. The management system manager adds the audit dates (Stage 1 and Stage 2), loads the Statement of Applicability or requirement list (created automatically, edited on screen or imported), registers and approves documents, defines evidence, verifies controls and records risks.
3. The internal auditor plans and runs internal audits and raises findings. Owners close corrective actions. Top management holds and closes the management review.
4. The manager records certification audits, the audit result and the certificate. Readiness numbers move as the work progresses.

SaaS production is in scope too (product decision 9 of `CLAUDE.md`). At the end of Milestone 2 the same release runs as a multi-tenant SaaS service for many customer organisations on one VPS with Docker Compose. Signed release images reach it only through an approved GitHub Actions workflow. Backups are tested by a weekly restore, alerts reach the owner, and the platform operator runs the whole organisation lifecycle (create, suspend, offboard, archive), plans and limits per organisation and verified email domains from the operator console. A go-live checklist covers security, operations and the Indonesian personal data protection law (UU PDP). Section K holds this track. On-premise stays supported and keeps its behaviour.

### A.2 What stays outside the browser

Installing the software stays a technical task. On-premise, `install.sh --admin-email` creates the organisation and invites the first administrator, as today, and now emails the invitation when mail is configured. On SaaS, the platform operator account is created once with `mscd-server admin create-operator` (M2-06), which the owner runs on the production server through the approved `ops-cli.yml` workflow (M2-S09). Every later organisation is created from the operator console in the browser (M2-16, extended with status, domains and plans by M2-S12). Everything after the first administrator's first sign-in happens in the web app.

### A.3 Decisions

| # | Decision |
|---|---|
| D2-01 | New screens and forms are hand-written React components in `apps/web` (TSX), styled only with the tokens of `apps/web/src/styles.css` through `.mx-` classes, with English and Indonesian text pairs like the rest of the app, no text under 12px and WCAG AA contrast in light and dark themes. The generated views stay generated. A change to them goes through `project/MSCD Mockup.dc.html` and the converter. |
| D2-02 | The first web package (M2-01) builds the extension points of section C once: screen registry, sidebar entries, host slots for screens, layers, drawer detail and the top bar, a modal and drawer host, shared form controls, API mutation helpers, action claims for existing buttons, and an Administration area that an admin-only user lands on. Every later web package adds files in its own folders only and does not edit `MscdApp.jsx`. |
| D2-03 | Every write uses an existing API route when one exists. New server routes exist only where the research found a capability missing (D.1). Each new route has integration tests, an F.6 matrix entry, and is covered by the WP-30 contract, RBAC and security suites. |
| D2-04 | Each new screen has Playwright specs in the API project (`apps/web/e2e/api-only/<screen>.spec.js`) and a sample-mode spec (`apps/web/e2e/screens/<screen>.spec.js`), and is covered by `e2e/contrast.spec.js` through the registry. The API Playwright project also runs `e2e/screens`, so every spec there carries the `@sample-only` tag unless it is written to pass in both modes; the M2-01 probe and Licence specs show the pattern. The last package (M2-18) runs a fresh-organisation journey end to end. |
| D2-05 | Pack content work adds clauses 4 to 10 with sub-clauses, mandatory documented information, document templates, management review inputs, control-to-clause links and evidence examples for every standard, with a pack version bump and an upgrade path for organisations that already installed the packs (section E). |
| D2-06 | Terminology renames are one late package (M2-17), started only after the product owner approves the list in H.1. Labels that show the wrong role today (Programme Owner shown as "MS Manager", External Auditor as "Internal Auditor") are display bugs, fixed in M2-01 with the current product words, one label per role. |
| D2-07 | The demo seed keeps working and every Milestone 1 test stays green (R-15). |
| D2-08 | New register screens read the list routes of their area (`registers.list`, `findings.list`, `corrective-actions.list`, `management-reviews.list` and the new routes of D.1) with paging. The generated screens keep reading the three snapshot routes. After a write, a screen reloads its own list and calls `ctx.reload(msIds)` only when snapshot data changed (chain records, applicability, documents, evidence, people, repositories, systems). |
| D2-09 | A new management system starts with its applicability entries created from the pack: one entry per Annex A control plus one per leaf clause row from 4.1 to 10.2 (a row that has no child rows and is still in the standard) for ISO/IEC 27001, which gives 93 plus 30 entries with the E.2 content, and one per leaf requirement for the other standards. Clause entries of a catalogue system have the read model key `cl-<code>` (for example `cl-5.1`, snapshot ref `isms:cl-5.1`), so they never share a key with the Annex A control of the same number (`5.1`). Clause rows are always applicable and can never be marked not applicable (`applicability_assessable`). |
| D2-10 | The certification cycle is created when the first Stage 1 or recertification audit event is planned, or on screen with "Start certification cycle". A system moves to `certified` only through the certificate record of D.1, after a Stage 2 or recertification audit with outcome `recommended` or `recommended_with_conditions`. |
| D2-11 | Clause readiness is computed by the server (`readiness.recompute`) from four inputs per clause group: documented information in place, entries implemented, evidence fresh, metrics current. The screen labels it "Internal progress score" with a one-line method text (M2-01). The default inputs are listed in H.2 for the product owner to confirm. |
| D2-12 | A single organisation administrator is supported with a clear warning: "Getting started" and the role grant form show that grants to yourself and to other administrators need a second administrator. No rule is relaxed (question H.3). |
| D2-13 | Bulk import is one dry-run-then-commit flow per file for four kinds (applicability, documents, risks, evidence). The commit is all rows or none, through the existing command services, so business rules and the audit trail apply to imported rows. |
| D2-14 | Host screens navigate through controller state, as the generated screens do. URL sync (research extension point 8) is not built in Milestone 2. Each screen id is the last segment of its intended route so React Router can map it later. |
| D2-15 | SaaS production is a second track of Milestone 2 (section K, packages M2-S01 to M2-S13). Both tracks share one contract written by M2-02 in wave 1a (R-14, D.1, D.3, J), one combined wave table (G.1) and the four-agent limit (R-02). M2-06 builds `admin create-operator` and `ops.organizations.create`, M2-S09 builds the rest of the organisation lifecycle, M2-16 builds the operator console and M2-S12 extends it. |

### A.4 Corrections to the gap study

The code research corrected these points of the gap study. The plan follows the corrected version.

| Gap study said | What the code does |
|---|---|
| The certificate has nowhere to go | `certification_cycle` already has `certificate_no` and `certified_at`. Missing: expiry date, issuing body per cycle, certified scope, and any route that sets `certified` |
| Guest auditor access is always 14 days and cannot be listed or ended | The server already takes 1 to 30 days and lists and revokes grants. The gap is in the web app only |
| Password change and authenticator replacement need console work | Both work on the server from a signed-in session. Missing: new recovery codes while keeping the authenticator, and the count of codes left |
| A second-organisation invitation only lacks a screen | No route lists the invitations waiting for a person, and an existing active account gets no email or notification. Server work is needed |
| Version history is only hidden | No route lists document versions. Server work is needed |
| Clause readiness starts at 0 | Rows are created with `source = 'computed'` and a fixed 0, and nothing recalculates them |

## B. Out of scope

| Item | Where it goes and why |
|---|---|
| SaaS self-service sign-up and billing | Later milestone, because no payment provider or price list is chosen (decision D-S1 in K.3: sales-led). The operator console creates organisations (M2-16, M2-S12) |
| LDAP and Active Directory sign-in, SMB, S3 and WebDAV repositories | Deferred as in BP Appendix 1, because no customer has asked for them and each needs its own adapter and tests. M2-18 corrects the user guide, the demo licence texts and `docs/INSTALL-ONPREM.md` so nothing promises them |
| Email domain verification on-premise | Stays the operator command `tenant verify-domain`, because proving domain ownership needs DNS access that only the operator has. Invitations work without it. On SaaS, M2-S11 adds verification by a DNS TXT record from the operator console |
| Zero-transit upload from the browser to Microsoft 365 or Google Drive (`storage.upload-intents.complete`) | Later milestone, because it needs upload sessions and CORS settings in each customer tenant that are not tested yet. Uploads go through the gateway as today |
| Read confirmation of policies, retention periods and disposal review | Milestone 3, because retention needs a decision on legal hold and deletion of stored files. Proof of communication is kept as evidence files meanwhile |
| Document editor and review comments inside MSCD | Not planned, because customers write in their own tools and MSCD keeps the approved version and its hash |
| Moving applicability entries to a new edition through mapping files, and the offer of new activity templates after a pack update | Later milestone, because the mapping files for the new editions need the lead auditor check of H.6 first. The edition transition route keeps its Milestone 1 behaviour, and the transition action (M2-09) says so |
| Periodic access review task (Annex A 5.18) and the top management pending totals panel | Milestone 3, because the access review needs a review cycle record and the totals panel waits for the answer to H.13 |
| Seeding demo personas for Programme Owner, Risk Owner and Compliance Investigator, and sample-mode permissions taken from the F.6 matrix | Milestone 3, because the personas depend on the answers to H.4 |
| React Router and deep links for every screen | Later (D2-14), because the controller state model works and the change touches every screen |
| The third-party notices file | Later milestone, because it belongs to release packaging. The offline `mscd-server diagnostics` command is built in M2-S09 |
| A change register for planned changes (clause 6.3 of ISO/IEC 27001, ISO 9001, ISO 22301 and ISO 37001:2025) | Not in Milestone 2, because clause 6.3 is covered by its clause row (D2-09) with an owner, a justification and evidence, which an auditor accepts as the record of planned changes |
| Organisation-wide freshness defaults set on screen | Not in Milestone 2, because the built-in defaults apply to every system and each system can set its own limits (M2-07, M2-11) |
| Golden Thread Viewer node and chain stage for audit findings | Later milestone, because the trace view needs a stage definition per standard; findings show on the clause or control they concern through `finding.target_code` (M2-05, M2-14) |
| Installer follow-ups of `CLAUDE.md`: saving the Compose project name for removal, and a default organisation with `install.sh --yes` | Later milestone, because both concern unattended installs and removal, which no Milestone 2 step needs. The installer slug warning is in M2-06 |

## C. Web extension points

M2-01 builds these once. They come from the web research and were checked with a dry run of the converter in the scratchpad (two patches changed four lines of `AppView.jsx`).

### C.1 Host slots in the generated views

`PATCHES` in `apps/web/scripts/convert-template.mjs`, then `npm run gen:views -w @mscd/web`. `project/MSCD Mockup.dc.html` does not change.

| Slot | Patch anchor (must match once) | Placed | Used for |
|---|---|---|---|
| `hostScreen` | `  </div>\n  </sc-if>\n</main>` | inside the main content column, after `<FrameworkLibrary v={v} />` | the body of a host screen, with page padding, gap and entry animation |
| `hostLayer` | `<sc-if value="{{ toast }}">` | at the `.mscd` root before the toast | portals for host modals and drawers, inside the token and theme scope and outside the animated column |
| `hostDetail` | the end of the drawer body in the `Drawer` and `PageDetail` splits (M2-01 picks the anchor and keeps it at one match each) | below the generated detail fields | detail extensions of C.5 (edit panels, review panel, versions tab) |
| `hostTopbar` | before the role menu button in the `<header>` (TopBar) | top bar | notification bell and "My account" entry (M2-16) |

### C.2 Screen registry

`apps/web/src/screens/types.ts` and `registry.ts`. The registry collects `./*/index.tsx` with `import.meta.glob(..., { eager: true })` and checks at load: unique ids, no clash with the 14 built-in ids, a known group, both languages in every label. It exports `HOST_SCREENS` sorted by group and order, and `hostById(id)`.

`ScreenDef` fields: `id`, `path` (intended route, for example `/admin/users`), `group` (`top`, `impl`, `audit`, `surv`, `tasks`, `admin`, `ops`), `order`, `label` (pair), `icon` (24 by 24 stroke path), `scope` (`org`, `ms` or `platform`), `roles` (sample personas), `perm` (an org, ms or platform permission for API mode, or a list where any one is enough), `nav` (false for screens opened only from another screen), `Component` (lazy), `pageActions?(ctx)`, `count?(ctx)` (sidebar badge), `tera?` (help text pairs).

Every screen folder also has a `meta.json` with id, label pair, group, order, roles, expected page action labels, `sampleRole` (the sample persona that opens it in specs) and `open` (`nav` or `query`), read by the E2E helpers with `fs`.

Sample personas: sample mode has only the personas `manager`, `owner`, `auditor` and `top` (`UI_ROLES`). In sample mode, the `admin` and `ops` groups show for the `manager` persona, and their `meta.json` lists `manager` in `roles`. In sample builds only (`VITE_DATA_SOURCE` other than `api`), the controller honours a `?screen=<id>` query at start, so specs open screens with `nav: false` (`storage-admin`, `account`) and screens of another persona directly. `contrast.spec.js` and `i18n.spec.js` loop over host screens with the persona from `sampleRole` and open each through `open`; `helpers.js` offers `openScreen(page, meta)` for this.

### C.3 Host glue in the controller

`apps/web/src/screens/host.tsx` holds pure functions: `hostNav(groups, ctx, role)`, `canOpenHost(id, ctx, role)`, `hostVals(screen, ctx)` and the `HostScreen` wrapper (Suspense plus `HostContext`). The one-time edits to `MscdApp.jsx` (about 40 lines): import, build `ctx` once per render, pass `NAV` through `hostNav`, make `visFor` and `landing` consult `canOpenHost`, take title, breadcrumb, page actions and Tera help from `hostVals` when a host screen is open, add `hostScreen`, `hostLayer`, `hostDetail` and `hostTopbar` to `v`.

No-system path: in API mode the controller today shows the NO_SYSTEMS panel when `MSL` is empty, and `renderVals` and `msObj` assume a system (`this.MSL[0]`). The data source always calls `/ui/org`, which needs an organisation. M2-01 changes three places: `apps/web/src/auth/boot.tsx` and `apps/web/src/data/api/**` skip `/ui/org` and `/ui/ms` when `me.org` is null (a platform operator with no membership) and build an empty snapshot for an organisation with no systems; `renderVals` gets a path without `msObj` that shows host screens only (org and platform scope) and keeps the NO_SYSTEMS panel for the built-in screens. `controller.test.ts` covers both cases. Boot also loads the user's preferences (`me.preferences`: language, theme, density) and applies them before the first render.

Administration landing: a user whose `Me` holds `tenant_admin` or `storage_admin` and no business role lands on the first visible admin screen ("Getting started" once M2-16 exists, else "Licence"). The Administration group shows Framework library and Storage repositories to Tenant Admins and Storage Admins whether or not they hold a business role. A platform operator with no membership lands on the first `platform` screen. Everyone else without a role keeps the existing message.

### C.4 Host context

`ctx` provides `lang`, `li(pair)`, `fill(pair, values)`, `theme`, `D` (snapshot), `msObj`, `org`, `me`, `mode` (`sample` or `api`), `client` (the boot's ApiClient in API mode, null in sample mode), `can(ms, perm)`, `orgCan(perm)`, `platformCan(perm)`, `toast(text)`, `go(screen, extra)`, `track(promise)` (busy bar), `reload(msIds)`, `command(run, done)`, `openPicker(opts)` (opens the existing file picker and resolves with the chosen or uploaded file, without attaching it), `layer()`.

### C.5 Action claims and detail extensions

Every page action and row action that today only shows a toast gets a stable id. M2-01 lists them in `apps/web/src/screens/actions.ts` (`controls.add`, `docs.new`, `docs.openReview`, `docs.continueDraft`, `phases.recordBlocker`, `timeline.addEvent`, `storage.connect`, `storage.settings` and every other toast-only action found in `MscdApp.jsx`). The same list holds overrides of existing commands, which already call the API and are replaced by a claim: `audit.auditorAccess` (today a `window.prompt` for the email, then the guest access route with a fixed 14 days). The Framework library card has no transition button (in `MscdApp.jsx` "transition" is only the pack status label), so edition transition is a page action added to screen `fw` with `extraPageActions` (M2-09). A package claims an id by exporting it from `apps/web/src/screens/<folder>/actions.ts`. The controller calls the claimed handler, else keeps the toast. The same file may add page actions to a built-in screen (`extraPageActions: [{screen: 'controls', ...}]`) and detail extensions keyed by record kind (`req`, `doc`, `ev`, `item`, `activity`, `event`, `prep`, `cycle`). Several extensions per kind are allowed and render in `order`.

The "Reassign", "Change due date" and "Send reminder" buttons are hidden when `can(ms, perm)` is false, as "Verify" already is.

### C.6 UI kit, styles and sample adapters

- `apps/web/src/screens/ui/*.tsx` and `screens.css`: Card, Table (12px uppercase headers in `--tx3`, rows with `tr[data-hov]`), Badge (tone pairs), Button (default, primary on `--acc` with `--onacc`, danger; a disabled Button keeps full text contrast, `--tx3` on `--sur2` with a dashed `--field` border and the reason shown as text next to it, and never uses opacity, because `contrast.spec.js` measures every visible text node at 4.5:1), Field with TextInput, Select, Checkbox, Radio, Textarea, DateInput, PersonPicker, RecordPicker (36px high, `--sur2` background, `--field` border, error line with `role="alert"`), Tabs, Alert, EmptyState, ConfirmDialog, Modal and Drawer.
- Modal and Drawer portal into `ctx.layer()` and keep the generated geometry and inline z-index values (modal backdrop 50, dialog 51, 520px; drawer 40 and 41, 560px), so `e2e/helpers.js` layer locators and the i18n label collector find them. They add `role="dialog"`, `aria-modal`, `aria-labelledby`, focus on the first field, focus return on close, and Escape through a document listener that stops propagation.
- `styles.css` gains `--field` (`#8f877a` light, `#7a7366` dark, 3.55:1 and 3.70:1), `--ring` and a `:focus-visible` rule for `.mx-` controls.
- `apps/web/src/screens/api.ts`: `call(client, routeId, {params, query, body, ifMatch, idempotencyKey})` returns `ApiResult` with field errors kept, `fieldErrors(error)` maps `errors[].path` to messages, `useList(routeId, params)` pages a list route, `useMutation` disables Save while busy and keeps the form open on failure.
- `SampleDataSource` gains `mutate(ms, kind, id, patch)` and `insert(ms, kind, row)` so sample adapters change the sample snapshot and built-in screens show the result in the sample build.
- Each screen folder has `routes.ts` (`[method, path]` constants plus `ROUTE_IDS`, with a contract test against `routeById`), `api.ts` and `sample.ts` with one interface, chosen in `index.tsx` with `import.meta.env.VITE_DATA_SOURCE === 'api'`.

### C.7 Test plumbing

- `apps/web/e2e/helpers.js` appends host screens to `SCREENS` and `SCREENS_ID` from every `src/screens/*/meta.json`, offers `navFor(role)` in place of hard-coded nav counts in `switching.spec.js` and `display.spec.js`, and `openScreen(page, meta)` (C.2). `shell.spec.js` reads expected page actions from `meta.json`.
- `apps/web/vitest.config.js` includes `**/*.test.{js,ts,tsx}` (today only `js` and `ts`, so a `.tsx` test would never run and `--passWithNoTests` would hide it).
- `apps/web/test/api/controller.test.ts` takes its screen ids from the registry, so `renderVals` runs for every host screen in both languages.
- `apps/web/test/screens/registry.test.tsx` checks ids, both languages, Indonesian that differs from English, no U+2014 or U+00B7 in any text pair, and an icon per screen.
- `expectOverlayReadable(page)` in `helpers.js` runs `expectReadableText(page, 4.5)` and the 12px check inside the open modal or drawer, for specs to call after opening each form.

## D. Server additions

### D.1 New routes

M2-02 adds every route below to the area file named, with request and response schemas, the permission, an example, a mounted handler stub in the controller file named and the F.6 matrix entry. The package in the last column replaces the stub with the real handler.

| Route id | Method and path | Area file | Permission | Purpose | Controller file (under `apps/server/src/modules/`) | Built by |
|---|---|---|---|---|---|---|
| `admin.organization.get` | `GET /api/v1/admin/organization` | `admin-users.ts` | `org.settings.manage` [TA] | slug, name, time zone, site count, local sign-in policy, installation id, tenancy mode, active admin count | `admin-users/admin-users.controller.ts` | M2-06 |
| `admin.onboarding` | `GET /api/v1/admin/onboarding` | `admin-users.ts` | `ms.admin` [TA] | onboarding steps computed from existing tables (D.5) | `admin-users/onboarding.controller.ts` (new) | M2-06 |
| `me.membership.decline` | `POST /api/v1/me/memberships/:org/decline` | `me.ts` | active session | decline an invited membership | `authz/me.controller.ts` | M2-06 |
| `me.security` | `GET /api/v1/me/security` | `me.ts` | active session | password set, SSO only, authenticator set up at, recovery codes left, linked identities | `authz/me.controller.ts` | M2-06 |
| `me.recovery-codes` | `POST /api/v1/me/mfa/recovery-codes` | `me.ts` | active session, TOTP code in the body unless one was given in the last 5 minutes | ten new recovery codes, shown once | `identity/recovery-codes.controller.ts` (new) | M2-06 |
| `notifications.read-all` | `POST /api/v1/notifications/read-all` | `notifications.ts` | active session | mark every notification of the user read | `notifications/notifications.controller.ts` | M2-06 |
| `ops.organizations.list` | `GET /api/v1/ops/organizations` | `ops.ts` | `ops.read` platform [OP] | organisations with licence state, member count, systems | `ops/ops.controller.ts` | M2-06 |
| `ops.organizations.create` | `POST /api/v1/ops/organizations` | `ops.ts` | `ops.tenants.manage` platform [OP] (new) | create an organisation and invite its first administrator (multi tenancy only; otherwise 409 `conflict` with `messageKey` `single_tenancy`) | `ops/ops.controller.ts` | M2-06 |
| `ops.users.reset-mfa` | `POST /api/v1/ops/users/reset-mfa` | `ops.ts` | `ops.users.manage` platform [OP] | body `{email, reason}`: reset the second factor of an account that holds several active memberships, which no single Tenant Admin may do (`admin.users.reset-mfa` refuses it); audited `auth.mfa_reset` | `ops/ops.controller.ts` | M2-06 |
| `ms.cycles.list` | `GET /api/v1/ms/:ms/certification-cycles` | `admin-ms.ts` | `ms.read` | cycles with status, dates, certificate | `management-systems/certification.controller.ts` (new) | M2-05 |
| `ms.cycles.create` | `POST /api/v1/ms/:ms/certification-cycles` | `admin-ms.ts` | `audit_event.manage` [MM] | start a cycle and its cycle items | `management-systems/certification.controller.ts` | M2-05 |
| `ms.certification` | `POST /api/v1/ms/:ms/certification` | `admin-ms.ts` | `ms.transition` [MM] | record the certificate and move cycle and system to `certified` | `management-systems/certification.controller.ts` | M2-05 |
| `ms.cycles.transition` | `POST /api/v1/ms/:ms/certification-cycles/:id/transitions` | `admin-ms.ts` | `ms.transition` [MM] | body `{to, reason}`: the manual moves of machine `certification_cycle.status` (J.8): `certified` to `suspended`, `suspended` to `certified` or `withdrawn`, `active` to `closed` (reason required); audited `certification_cycle.transitioned` | `management-systems/certification.controller.ts` | M2-05 |
| `internal-audit.programme` | `GET /api/v1/ms/:ms/internal-audit/programme` | `audit-events.ts` | `ms.read` | per cycle: clauses 4 to 10 and applicable controls with the internal audits that covered them | `audit-registers/internal-audit.controller.ts` (new) | M2-05 |
| `applicability.targets` | `GET /api/v1/ms/:ms/applicability/targets` | `implementation.ts` | `ms.read` | catalogue items and requirements of the active edition: code, title, clause group, has entry, retired, assessable, documented information needed | `implementation/targets.controller.ts` (new) | M2-07 |
| `freshness.thresholds.get` | `GET /api/v1/ms/:ms/freshness-thresholds` | `implementation.ts` | `ms.read` | values in force per frequency, marked default or set | `implementation/freshness-thresholds.controller.ts` (new) | M2-07 |
| `freshness.thresholds.put` | `PUT /api/v1/ms/:ms/freshness-thresholds/:frequencyCode` | `implementation.ts` | `applicability.manage` [MM] | set or reset (null) grace days, aging factor, expired factor | `implementation/freshness-thresholds.controller.ts` | M2-07 |
| `documented-info.list` | `GET /api/v1/ms/:ms/documented-information` | `implementation.ts` | `ms.read` | required documented information of the edition with the linked document or evidence and its state | `implementation/documented-info.controller.ts` (new) | M2-07 |
| `documented-info.link` | `PUT /api/v1/ms/:ms/documented-information/:code/link` | `implementation.ts` | `document.manage` [MM] | body `{documentId}` or `{documentId: null}`: map a pack document code (template code or activity `output_document_code`) to any registered document of the system, so a customer keeps its own codes (for example `ISP-001` for the policy); audited `document_code.linked` | `implementation/documented-info.controller.ts` | M2-07 |
| `documents.versions.list` | `GET /api/v1/ms/:ms/documents/:id/versions` | `documents.ts` | `ms.read` (document scope policy) | versions newest first: label, status, storage object id, submitter, approver, dates, rejection note, change summary | `registers/document-versions.controller.ts` (new) | M2-07 |
| `records.holdings` | `GET /api/v1/ms/:ms/holdings/:handle` | `records.ts` | `record.assign` [MM, PO] | open items a person holds in the system | `registers/holdings.controller.ts` (new) | M2-07 |
| `records.holdings.reassign` | `POST /api/v1/ms/:ms/holdings/:handle/reassign` | `records.ts` | `record.assign` [MM, PO] | move all or chosen kinds to a successor, BR-16, BR-17 and BR-41 applied per record | `registers/holdings.controller.ts` | M2-07 |
| `admin.users.holdings` | `GET /api/v1/admin/users/:id/holdings` | `records.ts` | `user.manage` [TA] | counts per system and record kind with the primary manager of each system (no titles) | `registers/holdings.controller.ts` | M2-07 |
| `management-reviews.update` | `PATCH /api/v1/ms/:ms/management-reviews/:id` | `audit-registers.ts` | `management_review.manage` [MM, PO] | change title, planned date, owner, linked systems while planned or held | `audit-registers/review-edit.controller.ts` (new) | M2-07 |
| `imports.templates` | `GET /api/v1/ms/:ms/imports/templates/:kind` | `imports.ts` (new area) | `ms.read` | XLSX template for `applicability`, `documents`, `risks` or `evidence` | `imports/imports.controller.ts` (new module) | M2-08 |
| `imports.create` | `POST /api/v1/ms/:ms/imports/:kind` | `imports.ts` | `permissionBy` on the path member `kind`: `applicability` `applicability.manage`, `documents` `document.manage`, `risks` `risk.manage`, `evidence` `evidence.manage` | multipart upload, dry run: row results and an import id | `imports/imports.controller.ts` | M2-08 |
| `imports.get` | `GET /api/v1/ms/:ms/imports/:id` | `imports.ts` | `ms.read`; the service answers 404 to anyone but the creator | state and row results | `imports/imports.controller.ts` | M2-08 |
| `imports.commit` | `POST /api/v1/ms/:ms/imports/:id/commit` | `imports.ts` | `ms.read`; the service answers 404 to anyone but the creator and checks the kind's permission again | queue `import.run`; 202 with task id | `imports/imports.controller.ts` | M2-08 |
| `ops.organizations.get` | `GET /api/v1/ops/organizations/:org` | `ops.ts` | `ops.read` platform [OP] | status, region, created date, member count, system count, entitlement summary, domains, last sign-in | `ops/ops.controller.ts` | M2-S09 |
| `ops.organizations.status` | `POST /api/v1/ops/organizations/:org/status` | `ops.ts` | `ops.tenants.manage` platform [OP] | body `{status, reason, confirmSlug?}`: move the organisation along the status machine of J.8; audited `ops.organization_status_changed` | `ops/ops.controller.ts` | M2-S09 |
| `ops.organizations.events` | `GET /api/v1/ops/organizations/:org/events` | `ops.ts` | `ops.read` platform [OP] | status history from `platform.organization_status_event` | `ops/ops.controller.ts` | M2-S09 |
| `ops.domains.list` | `GET /api/v1/ops/organizations/:org/domains` | `ops-domains.ts` (new area) | `ops.read` platform [OP] | domains with status, method and the requested, verified and last checked times | `ops/domains/domains.controller.ts` (new) | M2-S11 |
| `ops.domains.add` | `POST /api/v1/ops/organizations/:org/domains` | `ops-domains.ts` | `ops.tenants.manage` platform [OP] | body `{domain}`; returns `{domain, txtName, txtValue, status}`; audited `ops.domain_added` | `ops/domains/domains.controller.ts` | M2-S11 |
| `ops.domains.verify` | `POST /api/v1/ops/organizations/:org/domains/:domain/verify` | `ops-domains.ts` | `ops.tenants.manage` platform [OP] | check the TXT record at once; audited `ops.domain_verified` or `ops.domain_verification_failed` | `ops/domains/domains.controller.ts` | M2-S11 |
| `ops.domains.remove` | `DELETE /api/v1/ops/organizations/:org/domains/:domain` | `ops-domains.ts` | `ops.tenants.manage` platform [OP] | remove a domain; audited `ops.domain_removed` | `ops/domains/domains.controller.ts` | M2-S11 |
| `ops.entitlements.get` | `GET /api/v1/ops/organizations/:org/entitlements` | `ops-entitlements.ts` (new area) | `ops.read` platform [OP] | the `platform.entitlement` row with current use, and its `ETag` | `license/entitlements.controller.ts` (new) | M2-S10 |
| `ops.entitlements.set` | `PUT /api/v1/ops/organizations/:org/entitlements` | `ops-entitlements.ts` | `ops.entitlements.manage` platform [OP] (new), with `If-Match` | a preset from `license.plans` or explicit limits; audited `ops.entitlements_changed` | `license/entitlements.controller.ts` | M2-S10 |
| `ops.plans.list` | `GET /api/v1/ops/plans` | `ops-entitlements.ts` | `ops.read` platform [OP] | the presets of `license.plans` | `license/entitlements.controller.ts` | M2-S10 |

The guard cannot read a multipart body before the handler, so the import kind is a path member. A stub answers `501` with the new problem slug `not-implemented` after the guard (J.6). The WP-30 contract harness declares 501 for the routes listed in `apps/server/test/int/m2-pending/M2-nn.json` and `M2-Snn.json` (route ids per building package), and the RBAC and security sweeps treat a 501 from a listed route as "guard passed, handler pending". Each building package deletes its own file. J.1 lists the same 38 routes in the format that the shared contract tests read.

The last ten rows are the routes of the SaaS track (K), built by M2-S09, M2-S10 and M2-S11. Like `ops.organizations.create`, they answer 409 `conflict` with `messageKey` `single_tenancy` in single tenancy.

### D.2 Changed behaviour of existing routes

| Route | Change | Built by |
|---|---|---|
| `admin.organization.update` | body also takes `name` (1 to 200), `timeZone` (IANA, checked with `Intl`), `siteCount` (0 or more); slug stays permanent; after a time zone change the daily jobs of the current local day run once and not twice. The run ledger `platform.daily_job_run` (platform migration 0006) holds one row per organisation, daily job and local date, and each job works on the date of its row. | M2-06 |
| `admin.users.create` | an existing active account gets an email and a `membership_invited` notification; the admin still gets the same 202 (F.6) | M2-06 |
| `me.get` | `Me` gains `pendingMemberships: [{org, name, invitedBy, invitedAt}]` | M2-06 |
| `admin.ms.create` | creates the applicability entries of D2-09 in the same transaction (seeder of M2-03), owner unset, status `not_started` | M2-06 |
| `audit-events.create` | event type `internal_audit`; permission becomes `permissionBy` on the body member `eventType`: `internal_audit` needs `internal_audit.manage` [MM, IA], every other type `audit_event.manage` [MM] (M2-02 adds `source: 'body'` to `PermissionByMember` when the guard lacks it); body takes `scopeText` and `reportDocumentId`; the first `stage1` or `recertification` event with no open cycle creates or activates the cycle (D.4) | M2-02 (permission), M2-05 (behaviour) |
| `audit-events.update` | `anyOf` [`audit_event.manage`, `internal_audit.manage`], because the body carries no event type; the service refuses with 403 when the event is not `internal_audit` and the caller holds only `internal_audit.manage`; takes `scopeText` and `reportDocumentId` (attach report) | M2-02 (permission), M2-05 (behaviour) |
| `audit-activities.generate`, `audit-activities.update` | `anyOf` [`audit_event.manage`, `internal_audit.manage`] with the same event type check in the service; `audit-activities.update` takes `auditorHandle` and `targetCode` (clause or control); warning `AUD-INDEP` when the auditor owns an entry, document or evidence of that target | M2-02 (permission), M2-05 (behaviour) |
| `findings.create`, `findings.update`, `findings.list` | `targetCode` (a code from `applicability.targets`) stored in `finding.target_code` next to the free-text `clauseRef`; `findings.list` filters by `targetCode` | M2-02 (schema), M2-05 (behaviour) |
| `admin.packs.import`, `admin.packs.list` | M2-02 checks in wave 1a that both accept a platform operator session with no membership in multi tenancy (`pack.install` platform scope), as `PUT /admin/license` does, and changes the schema or the guard there if they do not | M2-02 |
| `ms.transition` | machine row `implementing -> certified` points to `ms.certification` | M2-02 (machine), M2-05 (behaviour) |
| `applicability.create`, `applicability.transition`, `applicability.update` | `not_applicable` refused with 422 rule `APPL-ASSESS` when the pack row has `applicability_assessable = false` (on create: `isApplicable: false`; orchestrator decision in wave 2a, since clause rows are always applicable under D2-09) | M2-07 |
| `documents.create`, `documents.update` | `origin` (`internal` default, `external`), `externalSource`, `externalRef`, `receivedAt` | M2-07 |
| `documents.versions` | optional `changeSummary` (up to 500 characters) | M2-07 |
| `registers.list`, `registers.create`, `registers.update` | register kinds `objectives` (table `quality_objective`) and `competence` (table `competence_record`); `registerPermission` gains the cases `objectives` and `competence`, both `register.manage` (own rows, owner required), and the F.6 condition text of `register.manage` names the two kinds (J.2) | M2-02 (permission), M2-07 (behaviour) |
| `ops.organizations.create` | body takes an optional `preset` (a key of `license.plans`); new organisations start with `local_login = 'allowed'` (product decision 7 of `CLAUDE.md`) and with `region` from `tenancy.default_region`; with `mail.required` true it refuses with 409 `conflict` and `messageKey` `mail_required` when SMTP is not configured, and it never returns an invitation link | M2-02 (schema), M2-06 (mail rule, sign-in policy), M2-S09 (preset through `applyPreset` of M2-S10, region) |
| `ops.organizations.list` | items add `status`, `plan`, `validUntil` and `verifiedDomains` | M2-02 (schema), M2-S09 |
| `admin.license.put`, `license.get` | in multi tenancy the upload still checks the signature (D-32) and now also writes the `platform.entitlement` row with source `signed_licence`; the effective licence of an organisation is its entitlement row | M2-S10 |
| `system.profile` | adds `legal: {privacyUrl, termsUrl}` from the profile keys of D.3 | M2-02 (schema), M2-S11 |
| `auth.providers` | the same answer shape and status for an unknown slug, an unknown domain and a known organisation without SSO (D-S10); its own limit of 20 per minute per address, answering 429 with `Retry-After` | M2-02 (schema), M2-S11 |
| CLI `admin create-user` | sends the invitation email when mail is configured; prints the link as a fallback | M2-06 |
| CLI `admin create-operator` | new (M2-06 brief); with `mail.required` true it refuses when SMTP is not configured and never prints the set-password link | M2-06 |

### D.3 Schema, enums and permissions

M2-02 writes all of it in wave 1a, for both tracks, except the ref migration named below (M2-03, wave 1b).

- `apps/server/migrations/tenant/0008_milestone2.sql`:
  - `certification_cycle`: `certificate_expires_at date`, `certification_body varchar(200)`, `certified_scope text`; unique partial index on `management_system_id` where `status IN ('planned', 'active') AND deleted_at IS NULL`, so a certified cycle can stay while the next cycle is open.
  - `finding`: `target_code varchar(30)` (clause or control code of the system's edition).
  - New `document_code_link` (standard tenant columns, `management_system_id`, `pack_code varchar(30)`, `document_id uuid`; unique on `(management_system_id, pack_code)` where `deleted_at IS NULL`), with RLS as every tenant table.
  - `clause_readiness`: `readiness_pct` becomes nullable; add `documented_pct`, `implemented_pct`, `evidenced_pct`, `measured_pct` (`smallint` 0 to 100, nullable) and `computed_at timestamptz`.
  - `audit_event.event_type` CHECK adds `internal_audit`; `audit_event` gains `scope_text text` and `report_document_id uuid` (document of type record).
  - `audit_activity`: `auditor_user_id uuid`, `target_code varchar(30)`.
  - `document`: `origin varchar(10) NOT NULL DEFAULT 'internal' CHECK (origin IN ('internal', 'external'))`, `external_source varchar(200)`, `external_ref varchar(120)`, `received_at date`.
  - `document_version`: `change_summary varchar(500)`.
  - `quality_objective`: `resources text`, `evaluation_method text`, `status varchar(12) CHECK (status IN ('planned', 'on_track', 'at_risk', 'achieved', 'missed'))`, `result text`, `achieved_at date`.
  - New `competence_record` (standard tenant columns, `user_id`, `role_title`, `competence_required`, `proof_type` in `certificate`, `training`, `experience`, `assessment`, `storage_object_id`, `achieved_at`, `valid_until`, `verified_by`, `owner_user_id`, `pending_action`, `action_due_at`) linked to systems through `entity_ms_link`, with RLS as every tenant table.
  - `entity_ms_link.entity_type` CHECK adds `competence_record` (full list in J.7), so competence rows can be linked to systems.
  - New `import_run` (`management_system_id`, `kind`, `file_name`, `file_sha256`, `status` in `validated`, `committing`, `committed`, `failed`, `expired`, `row_count`, `results jsonb`, `background_task_id`, `committed_at`; unique on `(management_system_id, kind, file_sha256)` where `status = 'committed'`).
- Kysely types: the columns in the existing group files, the three new tables in `apps/server/src/db/types/tenant-m2.ts`.
- `packages/shared/src/enums.ts`: `AUDIT_EVENT_TYPES` adds `internal_audit`; permissions `internal_audit.manage` and `ops.tenants.manage`; notification kinds `membership_invited`, `certificate_expiring`, `import_finished`, `pack_content_updated`; job names `readiness.recompute`, `certificate.expiry`, `import.run`, `applicability.sync`; audit actions `ms.certified`, `certification_cycle.created`, `certification_cycle.expired`, `certification_cycle.closed`, `certification_cycle.transitioned`, `org.updated`, `freshness_threshold.changed`, `auth.recovery_codes_regenerated`, `membership.declined`, `holdings.reassigned`, `import.validated`, `import.committed`, `ops.organization_created`, `ops.operator_created`, `ops.operator_revoked`, `applicability.seeded`, `pack.content_synced`, `document_code.linked`, `management_review.updated`; problem slug `not-implemented` (501); platform rule ids `APPL-ASSESS` and `PACK-ROW-REMOVED` and warning rule id `AUD-INDEP`.
- `packages/shared/src/authz/matrix.ts`: `internal_audit.manage: ms([MM, IA])`, `ops.tenants.manage: platform([OP])`.
- `packages/shared/src/machines.ts`: the certification cycle machine (`planned -> active -> certified -> expired | closed`, `certified -> suspended -> certified | withdrawn`, `certified -> closed` when the next cycle is certified) with owner `M2-02`, and the row change of D.2.
- `packages/shared/src/api/risk-registers.ts`: `REGISTER_KINDS` adds `objectives` and `competence`. `packages/shared/src/api/records.ts`: `RECORD_ENTITY_TYPES` adds `competence_record`, next to `quality_objective`.
- Ref migration `apps/server/migrations/ref/0002_milestone2.sql`, written by M2-03 in wave 1b with the matching pack schema in `packages/shared/src/pack/**` (R-14). Its full content:
  - `ref.requirement` and `ref.catalogue_item`: `retired boolean NOT NULL DEFAULT false`.
  - New `ref.documented_info`: `code`, `requirement_code`, `kind` (CHECK `maintain`, `retain`), `title`, `template_code`, `sort_order`.
  - `ref.document_template`: `requirement_code`.
  - `ref.review_input_def`: `review_kind` (CHECK `management`, `governing_body`).
  - `ref.requirement_mapping`: `source_catalogue_item_id`.
  - `ref.audit_activity_template.event_type` CHECK adds `internal_audit`, because `AUDIT_EVENT_TYPES` also types that column, and the pack schema accepts internal audit activity templates.
  - The pack schema accepts the six derivation kinds of D.4 in `cycle_requirements.csv` (JSON, no CHECK).

  J.7 lists every CHECK list above.
- UI contract, in `packages/shared/src/ui/{snapshot,records,codes}.ts` and `docs/platform/ui-contract.md`: requirement-type entries of catalogue systems get the key `cl-<code>` (D2-09); the clause readiness values of a system (`clauses` in `records.ts`) and the four dimensions `documented`, `implemented`, `evidenced` and `measured` per clause group become nullable (D.6), with `computedAt`; documents gain `origin` and versions `changeSummary` (D.2). M2-01 renders a null readiness in `data/api/**` and through the converter as "Not computed yet" instead of 0.
- Sub-modules: Nest lists providers explicitly, so M2-02 creates one sub-module file per building package and parent module, puts that package's stub controllers and stub jobs in it, and imports it once in the parent module (and in the api or worker module where needed). The building package adds its services to that file only and never edits the parent module. The files are `management-systems/certification.module.ts`, `implementation/readiness/readiness.module.ts` and `audit-registers/internal-audit.module.ts` (M2-05); `admin-users/onboarding.module.ts` and `identity/recovery-codes.module.ts` (M2-06); `implementation/targets.module.ts` (targets, freshness thresholds, documented information), `registers/holdings.module.ts` (holdings, document versions) and `audit-registers/review-edit.module.ts` (M2-07); `imports/imports.module.ts` (M2-08); `license/entitlements.module.ts` (M2-S10); `identity/org-sessions.module.ts` (M2-S09; the ops services of M2-S09 go in `ops.module.ts`, which M2-S09 owns in wave 3a); `ops/domains/domains.module.ts` (M2-S11).
- Permission changes on existing routes: as D.2 (`audit-events.create`, `audit-events.update`, `audit-activities.generate`, `audit-activities.update`, `registers.*`). After wave 1a no package changes a permission (R-14).
- Jobs: the six new jobs are registered in the worker module in wave 1a, each with a stub handler file in the folder of the package that builds it: `modules/packs/applicability-sync.job.ts` (M2-03), `modules/implementation/readiness/readiness-recompute.job.ts` and `modules/notifications/certificate-expiry.job.ts` (M2-05), `modules/imports/import-run.job.ts` (M2-08), `modules/license/entitlement-expiry.job.ts` (M2-S10), `modules/ops/domains/domain-verify.job.ts` (M2-S11). The building package adds the schedule entry in `modules/jobs/schedules.ts`, which has one owner per wave (G.1).
- CLI: `apps/server/src/program.ts` registers three new command modules whose actions are stubs (`notImplemented` of `cli/not-implemented.ts`, exit code 2): `cli/license.ts` (filled by M2-06, extended by M2-S10), `cli/backup.ts` (M2-S07) and `cli/diagnostics.ts` (M2-S09). No later package edits `program.ts`, and no Milestone 2 package edits `apps/server/src/main.ts`.
- SaaS track (section K), also in wave 1a:
  - `apps/server/migrations/platform/0005_milestone2_saas.sql`. The platform folder ends at `0004_operations.sql` and the core track adds no platform migration, so the number is free. A correction goes in `0006_milestone2_fix.sql` (I).
    - New table `platform.organization_status_event`: `id`, `organization_id`, `from_status`, `to_status` (both with the CHECK list of `platform.organization.status`), `reason text NOT NULL`, `actor_user_id`, `created_at`.
    - `platform.verified_domain` adds `status` (`pending`, `verified`, `failed`; default `verified`, so existing rows stay verified), `txt_token_hash`, `requested_at`, `last_checked_at` and `method` (`dns`, `manual`; default `manual` for existing rows). `verified_at` and `verified_by` become nullable for pending rows. A unique index on `lower(domain)` where `status = 'verified'`; when verified duplicates already exist, the migration stops and lists them.
    - New table `platform.entitlement`: primary key `organization_id`; `plan`, `source` (`preset`, `manual`, `signed_licence`), `max_users`, `max_management_systems`, `frameworks`, `storage_adapters`, `features`, `rate_user_per_minute`, `rate_org_per_minute`, `valid_from`, `valid_until`, `grace_days`, `version`, `updated_at`, `updated_by`.
    - Grants and RLS like the other platform tables.
  - Kysely types of the new columns and tables in `apps/server/src/db/types/platform.ts`.
  - Profile keys in `apps/server/src/config/profile.schema.ts` and in `apps/server/profiles/{saas,onprem,demo,test}.yaml`, with defaults that keep on-premise unchanged: `tenancy.default_region` (default `id`); `license.plans` (map of preset name to limits, with its schema; M2-02 writes an empty map in every profile, and M2-S10 writes the D-S4 presets `trial` and `standard` into `saas.yaml` in wave 2b); `network.dns_resolvers` (default `[]`); `legal.privacy_url` and `legal.terms_url` (default null); `mail.required` (`true` in `saas.yaml`, `false` elsewhere).
  - `enums.ts`: permission `ops.entitlements.manage`; audit actions `ops.organization_status_changed`, `ops.domain_added`, `ops.domain_verified`, `ops.domain_verification_failed`, `ops.domain_removed`, `ops.entitlements_changed`; job names `domain.verify`, `entitlement.expiry`; notification kind `organization_status_changed`. No new problem slug: the SaaS refusals use existing slugs with the message keys of J.6.
  - `authz/matrix.ts`: `ops.entitlements.manage: platform([OP])`.
  - `machines.ts`: the organisation status machine of J.8 with owner `M2-02`.
  - Stub handlers for the ten SaaS routes of D.1 in `ops/ops.controller.ts`, `ops/domains/domains.controller.ts` and `license/entitlements.controller.ts`, registered in `ops.module.ts`, `ops/domains/domains.module.ts` and `license/entitlements.module.ts` (sub-modules above).
- J lists every enum value, permission row, job, notification kind, audit action, rule id, CHECK list and machine above in the formats the shared tests parse.

### D.4 Certification lifecycle

- Cycle creation: on the first `stage1` or `recertification` event with no open cycle (`planned` or `active`), or on `ms.cycles.create` (`{cycleStart, cycleEnd}`; `cycleEnd` defaults to three years later), in one transaction: insert the cycle (`active`), copy the active edition's `ref.cycle_requirement_def` rows into `cycle_requirement_status` (owner the primary MS Manager, due before the next audit event), link events of the system whose `certification_cycle_id` is null. When the system already has a `planned` cycle (every seeded system that is not certified), the first `stage1` event activates it (`planned -> active`) and copies the cycle items, instead of inserting a new cycle. The unique index of D.3 allows one open cycle; a `certified` cycle does not count as open.
- Recertification: a certified system keeps its `certified` cycle while the recertification audit runs. The first `recertification` event creates the next cycle (`active`) next to it. When `ms.certification` records the new certificate, the old cycle moves to `closed` (audited `certification_cycle.closed`) and the new one to `certified`.
- `ms.certification` body `{certificateNo, issuedAt, expiresAt, certificationBody, certifiedScope?}`: needs status `implementing` (first certificate) or `certified` (recertification), an open cycle and a `stage2` or `recertification` event in it with outcome `recommended` or `recommended_with_conditions`. Sets the cycle to `certified` with the details, the system to `certified`, closes the previous certified cycle, audits `ms.certified`. The certificate label of the read model comes from the newest certified cycle.
- Manual cycle moves (`ms.cycles.transition`, `ms.transition` [MM]): a suspension, reinstatement or withdrawal decided by the certification body, and closing an `active` cycle that will not reach certification, each with a reason. The certificate label of the read model shows "Certificate suspended" or "Certificate withdrawn"; the system status does not change. A `suspended` or `withdrawn` cycle is not open, so the manager can start the next cycle.
- `certificate.expiry` (daily): `certificate_expiring` notifications to MS Managers and Programme Owners 90, 30 and 7 days before `certificate_expires_at`; a lapsed cycle moves to `expired` and the system shows "Certificate expired".
- `cycle.derive` gains kinds `corrective_actions_closed`, `metrics_current`, `documents_reviewed_on_time`, `bia_approved`, `due_diligence_current` and `internal_audit_done` counting `internal_audit` events with a report. It is queued after the commands that feed it as well as daily.

### D.5 Onboarding checklist

`admin.onboarding` returns `[{key, state: 'done' | 'pending' | 'optional', count?, screen}]` for: `licence` (installed and valid, seats used and limit), `second_admin` (two or more active Tenant Admins), `sign_in` (a provider saved and tested; optional), `local_login` (policy set; optional), `repository` (one connected and tested, or Managed Vault as default), `routing` (one active rule), `systems` (one or more), `team` (active members beyond the administrators, count), and per system `ms_manager` (primary MS Manager granted), `verifiers` (two or more people with `applicability.verify` in the system, so separation of duties lets work reach Implemented; pending with a warning while fewer), `internal_auditor` (an Internal Auditor granted; optional), `implementing`, `applicability` (entries exist) and `audit_dates` (stage1 and stage2 events), plus `pending_grants` (count). The steps `applicability` and `audit_dates` are done by the management system manager (`audit_event.manage` and `applicability.manage` are [MM] only), so they carry `doneBy: 'ms_manager'` and `assignee` (name and email of the primary MS Manager). It returns states, counts and that assignee only, so a Tenant Admin sees no compliance content (F.6).

### D.6 Readiness recompute

`readiness.recompute` per system, daily at 02:30 and queued with a 60-second delay after applicability, document, evidence, metric, finding and corrective action commands. The queueing sits next to `freshness.recompute` in the three command helpers (`implementation/command-support.ts`, `registers/command-support.ts`, `risk-registers/support.ts`) and in `audit-registers/{findings,corrective-actions}.service.ts`, all owned by M2-05, which also queues `cycle.derive` there. For each clause group 4 to 10:

- `implemented_pct`: share of applicability entries in the group that are `implemented` or `not_applicable`. Requirement rows group by `ref.requirement.clause_group`; catalogue items by the clause group of their `requirement_code` (E.2), else group 8.
- `documented_pct`: share of the group's `ref.documented_info` rows with a linked approved document that is not past review, or for records a fresh evidence item.
- `evidenced_pct`: share of the group's evidence items that are fresh.
- `measured_pct`: group 9 only, share of metrics with a value in the current period.
- `readiness_pct`: the mean of the dimensions that have rows; null when none has rows.

It writes `source = 'computed'` and never overwrites `source = 'manual'`. The demo seed writes its rows as `manual` with the four dimensions null. When a row has no stored dimensions, the overview keeps the Milestone 1 offset formula of `maturityValues` in `derive/overview.ts`; when they are stored, it shows them. So the demo and the parity numbers stay as they are (R-15).

## E. Pack content and upgrade path

### E.1 Format changes (M2-03)

- `requirements.csv` and `catalogue.csv` gain `retired` (true or false). The installer refuses (422 `business-rule` with rule `PACK-ROW-REMOVED`) a version that drops a code of the installed version without marking it retired. Retired rows stay in `ref`, readers hide them from pickers, the seeder and readiness, and an existing entry on a retired row shows "No longer in the standard".
- New `documented_info.csv`: `code`, `requirement_code`, `kind` (`maintain` or `retain`), `title`, `template_code`, `sort_order`. Table `ref.documented_info`.
- `document_templates.csv` gains `requirement_code`. `review_inputs.csv` gains `review_kind` (`management` or `governing_body`).
- `ref.requirement_mapping` gains `source_catalogue_item_id`. Skipped mappings are retried when their target pack is installed.
- `cycle_requirements.csv` derivation kinds of D.4 are accepted by the schema.
- `validate-sources.mjs --json` prints the counts per pack as JSON (`requirements` counts rows that are not retired, plus `retired`, `catalogueLinked`, `documentedInfo`, `documentTemplates`, `reviewInputs`, `evidenceExamples`, and `clauseEvidenceMissing`, the leaf clause rows without an evidence example), next to the existing table output.
- `validate-sources.mjs` and `parsePackDatasets` check that cycle requirement codes, chain `clause_at_risk` values, activity `output_document_code` values and `documented_info.template_code` exist in the pack.
- `packs/content/<pack_id>/*.csv` is merged by `extract-from-sample.mjs` over the sample extract (rows added or replaced by code), so customer content is hand-written and `--check` still guards drift. `packs/content/<pack_id>/removed.csv` (`dataset`, `code`, `reason`) drops a row that the sample keeps, such as the ISO 9001:2026 phase 9 transition activity; `--check` fails when a listed code is missing from the sample extract or still present in the output. A removed requirement or catalogue row is refused (the `retired` rule above); the installer accepts a version that drops an activity template or a prep task template, and activities already created from it stay as they are.
- `engine_min_version` becomes `1.1.0` in every pack; the server version becomes 1.1.0.

### E.2 Content (M2-04)

| Pack | Requirement rows after | New | Retitled | Retired | Documented info | Templates | Review inputs |
|---|---|---|---|---|---|---|---|
| ISO27001-2022 | 34 | 11 | 1 (10.1 Continual improvement) | 10.3 | 15 | 25 | 10 |
| ISO9001-2015 | 84 | 56 | 0 | none | 27 | 25 | 12 |
| ISO9001-2026 | 84 (85 if 6.1 is split) | 56 | 0 | none | 27 | 25 | 13 |
| ISO22301-2019 | 59 | 33 | 2 (10.1, 10.2) | 10.3 | 15 | 23 | 13 |
| ISO37001-2016 | 50 | 20 | 2 (10.1, 10.2) | 6.3, 10.3 | 13 | 23 | 11 |
| ISO37001-2025 | 51 | 20 | 1 (10.1) | 10.3 | 13 | 24 | 12 |

Also: 93 Annex A control-to-clause links (84 to 8.3, nine to a closer clause), 83 new Annex A evidence examples, an evidence example for every leaf clause row of every pack (`clauseEvidenceMissing` 0), the template `SCO-01` Scope statement linked to requirement 4.3 in ISO/IEC 27001 and a matching scope statement template in each other pack (H.9), activities 6.7 and 6.8 reworded to name the document types they produce, activities 2.3 and 2.6 given an `output_document_code` (scope statement, risk treatment plan) and activities 3.4, 4.9 and 7.2 a completion source (3.4 the objectives register, 7.2 the competence register, 4.9 its output document), `documented_info_mandatory` and `applicability_assessable` values corrected (ISO 9001: ten assessable rows per edition), derivation JSON on every cycle requirement that has a data source, ISO 37001 chain fixes (auditor questions in both languages, `clause_at_risk` per stage). The row lists are in the packs research and are copied into `packs/content` as paraphrased short titles (PRD 3.3). ISO 9001:2026 and ISO 37001:2025 trees are marked "to confirm against the published text" in `packs/README.md` until a lead auditor checks them (H.6). `packs/README.md` gets a sign-off table with one row per pack (pack id, version, lead auditor, date); a pack without a sign-off row for its version is not released (M2-18 release check).

When the researched template list of a pack has no scope statement template, M2-04 adds one and raises that pack's template count in the table above and in its acceptance by one.

Clause 6.3 (planning of changes) is covered by its clause row with an owner, a justification and evidence (B).

Clause 10 numbering clash: the clause 10 fixes (retitle and retire) go into M2-04 together with the sample, because the sample builds the QMS, BCMS and ABMS requirement lists from one shared `HS9` list in `mscd-data.js`, and the change moves row counts, readiness numbers and labels that many Milestone 1 specs check. M2-04 owns those specs (R-15). M2-03 builds the `retired` format and tests it with a fixture pack.

### E.3 Versions and upgrade path

Two steps per edition, from the versions in `packs/sources/*/manifest.json` today:

| Pack | Today | M2-03 (patch: format, `engine_min_version`) | M2-04 (minor: content and clause 10) |
|---|---|---|---|
| ISO27001-2022 | 1.2.0 | 1.2.1 | 1.3.0 |
| ISO9001-2015 | 1.4.2 | 1.4.3 | 1.5.0 |
| ISO9001-2026 | 0.9.0 | 0.9.1 | 0.10.0 |
| ISO22301-2019 | 1.0.0 | 1.0.1 | 1.1.0 |
| ISO37001-2016 | 1.0.0 | 1.0.1 | 1.1.0 |
| ISO37001-2025 | 0.6.0 | 0.6.1 | 0.7.0 |

M2-17 adds a patch step for labels when it runs.

After an installation that updates an edition in use, the installer queues `applicability.sync` for each organisation with a system on that edition. It adds entries for new catalogue items and leaf requirements (`not_started`, unassigned), adds cycle items for new cycle requirements to open cycles, never deletes, and sends `pack_content_updated` to the MS Managers with the added, retitled and retired codes. The job is idempotent and audited as `pack.content_synced`. It skips demo organisations (`demo_deploy_label` set), so an upgraded demo keeps matching the sample. A demo seeded before M2-04 gets the new sample content only with `MSCD_DEMO_RESET=1`, which `docs/platform/handoff/M2-04.md` states.

### E.4 Demo text out of release content

The pack content drops demo facts from prep tasks and cycle titles (`NC-2025-02`, `SoA v3.0`, `SharePoint`, `DC Jakarta`, "Internal audit 2026 report") and the ISO 9001:2026 activity phase 9 "ISO 9001:2026 transition". The sample keeps its own wording where the demo needs it. M2-18 adds these strings to the release artefact check.

## F. Testing in Milestone 2

| Layer | What each package adds |
|---|---|
| Server integration | `apps/server/test/int/<area>/**` for the package's routes and jobs: success, every business rule, scope policy, audit entry, `If-Match` |
| Shared contract | `packages/shared/test/{routes,enums,authz,machines}.test.ts` compare the code with the plan tables. M2-02 makes `helpers.ts` read BP and section J of this plan, so the tests stay as strict as in Milestone 1 |
| Contract, RBAC, security | M2-02 adds the routes and matrix rows; the generated sweeps cover them. Record-table entries and RBAC expectations of each building package live in `security/record-tables/M2-nn.ts` and `rbac/expectations/M2-nn.ts` (`M2-Snn.ts` for M2-S09, M2-S10 and M2-S11), merged by the sweeps. Building packages delete their `m2-pending` file and run `test/int/rbac test/int/contract test/int/security` |
| Web unit | `apps/web/test/screens/<screen>.test.tsx` (run because `vitest.config.js` includes `.tsx`, C.7; each run must report at least one test, G.1): `renderToStaticMarkup` in both languages and both themes, adapter tests with the fake fetch of `test/auth/helpers.ts` (method, path, body, `X-CSRF-Token`, field errors kept), route contract test |
| Web E2E sample | `apps/web/e2e/screens/<screen>.spec.js`, tagged `@sample-only` unless written to pass in both modes (D2-04), opened with `openScreen` and the `sampleRole` of `meta.json` (C.2) |
| Web E2E API | `apps/web/e2e/api-only/<screen>.spec.js`, tagged `@api-only`, with the `apiSession` option (`tenant.admin` for admin screens, `rina` for manager flows, `maya` for internal auditor flows, `hendra` for top management, `bagus` for owner flows, `ops` for the operator console). Each spec opens every form and drawer and calls `expectOverlayReadable` in light and dark |
| Contrast | `e2e/contrast.spec.js` and `e2e/i18n.spec.js` cover every host screen through `meta.json`, `sampleRole` and the `?screen=` opener of sample builds (C.2, C.7), including screens with `nav: false` |
| Journey | `tools/smoke/tests/fresh-org.spec.mjs` (M2-18) |

## G. Work packages

### G.1 Waves

This is the one wave table for both tracks. A wave starts when every package of the previous wave is done and committed (R-10). Each wave holds at most four packages (R-02), so all its packages start together; the order inside a wave is the start order when fewer agents are free. Packages in one wave own disjoint paths, and a shared file has one owner per wave, named in the last column and in the shared file table below. API E2E and Compose runs take the host lock (R-05). Where other sections say "wave 2", they mean waves 2a and 2b, and "wave 3" means waves 3a to 3c.

| Wave | Work packages, in start order | Lockfile owner | Owners of shared files in this wave |
|---|---|---|---|
| 1a | M2-02 Server contract, schema and permissions (both tracks); M2-S01 Release images, signing and supply chain; M2-S04 Go-live checklist and owner pack | none | M2-02: `packages/shared/src/**` (every file, with the new area files `imports.ts`, `ops-domains.ts` and `ops-entitlements.ts`), `packages/shared/test/**`, tenant migration 0008 and platform migration 0005, DB types except `ref.ts`, `apps/server/src/config/profile.schema.ts` and the new keys in `apps/server/profiles/*.yaml`, `apps/server/src/program.ts` and the CLI stubs, `apps/server/src/app/*.module.ts`, the parent module files that import the new sub-modules, the sub-module files of D.3, the stub controllers and job files of D.3, contract snapshot, RBAC and security sweep files, `m2-pending/**`, `docs/platform/ui-contract.md`. M2-S01: `deploy/scripts/build-bundle.sh`, `tools/scripts/check-workflows.mjs`, `.github/dependabot.yml`. M2-S04: `docs/saas/README.md`, `docs/saas/go-live-checklist.md` |
| 1b | M2-01 Web screen host and Administration area; M2-03 Pack format and upgrade path; M2-S02 SaaS Compose stack and TLS; M2-S03 Server bootstrap | M2-03 (server version only) | M2-01: web controller, converter, generated views, `styles.css`, `vitest.config.js`, `e2e/helpers.js`, shared E2E specs, `controller.test.ts`, `SampleDataSource.js`, `data/api/**`, `auth/boot.tsx`, `screens/license/**`. M2-03: `packages/shared/src/pack/**`, ref migration, `apps/server/package.json`, lockfile. M2-S02: `apps/server/profiles/saas.yaml` (values; the keys of M2-02 stay), `deploy/nginx/**`, `deploy/compose/.env.saas.example`, `deploy/compose/config/caddy/**` |
| 2a | M2-04 Pack content; M2-05 Certification, internal audit and readiness server; M2-06 Onboarding, accounts and operator server; M2-07 Document control and register server additions | none | M2-04: `mscd-data.js`, seed snapshot, `tools/mock-providers/fixtures/demo.json`, the Milestone 1 specs listed in M2-04. M2-05: `apps/server/src/modules/jobs/schedules.ts`, `apps/server/src/seed/**`, the command helpers of D.6. M2-06: `apps/server/src/modules/ops/**`, `apps/server/src/cli/{admin,tenant,license}.ts`, `identity/mail-templates.ts`, `modules/jobs/scheduler-tick.job.ts`, `docs/INSTALL-ONPREM.md`, `deploy/scripts/install.sh`. Area files: as listed per package (R-14) |
| 2b | M2-S10 Per-organisation entitlements; M2-S05 Deploy script and deploy workflow; M2-S07 Backups and restore test; M2-S08 Monitoring and alerts | none | M2-S10: `apps/server/src/modules/license/**`, `apps/server/src/cli/license.ts`, `apps/server/profiles/saas.yaml` (`license.plans` values), `identity/mail-templates.ts`, `modules/jobs/schedules.ts`, `modules/platform/rate-limit.ts`, `modules/tenancy/rate-limit-store.ts`, `packages/shared/src/api/{license,ops-entitlements}.ts` (schemas only). M2-S05: `.github/workflows/deploy-prod.yml`, which also writes the backup and monitoring secrets that M2-S07 and M2-S08 read. M2-S07: `apps/server/src/cli/backup.ts`. M2-S08: `deploy/compose/config/caddy/conf.d/ops.caddy` |
| 3a | M2-S09 Operator commands and organisation lifecycle; M2-08 Bulk import; M2-09 Storage and management system administration; M2-10 People, roles and sign-in | none | M2-S09: `apps/server/src/modules/ops/**` except `ops/domains/**`, `apps/server/src/modules/tenancy/**`, `apps/server/src/db/tenant-provisioner.ts`, `apps/server/src/cli/{tenant,diagnostics}.ts`, `identity/{mail-templates.ts,session-resolver.ts}`, `modules/jobs/scheduler-tick.job.ts`, `packages/shared/src/api/ops.ts` (schemas only). M2-08: `packages/shared/src/api/imports.ts`, `apps/server/src/modules/imports/**`. Web packages: own folders only |
| 3b | M2-S11 Organisation discovery at sign-in; M2-16 Getting started, account, notifications and operator console; M2-11 Controls, evidence and phases forms; M2-12 Document control screens | none | M2-S11: `apps/web/src/auth/**` (with `i18n.ts`), `apps/web/test/auth/**`, `tools/mock-providers/**`, `apps/server/src/cli/tenant.ts` (`verify-domain` only), `apps/server/src/modules/ops/domains/**`, `identity/mail-templates.ts`, `modules/jobs/schedules.ts`, `modules/platform/system-profile.controller.ts`, `packages/shared/src/api/{auth,ops-domains}.ts` (schemas only). M2-16: `apps/web/src/screens/{ops,license}/**`. Web packages: own folders only |
| 3c | M2-S12 Operator console: organisations, status, domains and entitlements; M2-13 Registers screen; M2-14 Audit registers screens; M2-15 Certification timeline and auditor workspace | none | M2-S12: `apps/web/src/screens/ops/**`. Otherwise each package owns only its folders |
| 4 | M2-17 Terminology (gated on H.1) | none | may edit any web text (with `apps/web/src/auth/i18n.ts`), the template and the converter, pack labels, `tools/mock-providers/fixtures/demo.json`, `tools/smoke/tests/**` and docs (alone in the wave) |
| 5 | M2-18 Fresh-organisation journey and release check | none | `tools/smoke/**`, `docs/INSTALL-ONPREM.md`, `project/MSCD User Guide.dc.html`, `deploy/scripts/check-release-artefacts.sh` |
| 6 | M2-S13 SaaS end-to-end run, CI jobs and go-live evidence | none | `.github/workflows/ci.yml`, `tools/smoke/**`, `apps/server/test/setup/**`, `apps/server/package.json` (script only), `docs/saas/go-live-checklist.md` (status and evidence columns) |

Wave 1a holds M2-02 and the two SaaS packages that need no core work. M2-01 and M2-03 build on the route ids, enum values, job names and module registration of M2-02, and R-10 commits only at the end of a wave, so they wait for wave 1b. M2-S01 and M2-S04 own no file of M2-02 and use none of its output. M2-S03 runs in wave 1b, because its acceptance runs `check-workflows.mjs`, which M2-S01 writes in wave 1a. M2-S10 runs in wave 2b, before M2-S09, because M2-S09 calls its `applyPreset` and reuses its change notice (K.6). M2-S11 runs in wave 3b, after M2-S09, because both edit `cli/tenant.ts` and `identity/mail-templates.ts`. M2-17 runs after M2-S11 and M2-S12, because it may change their text.

Files that both tracks touch, with one owner per wave:

| File or path | Owner per wave |
|---|---|
| `packages/shared/src/**` | M2-02 (1a, every file, `ui/**` included). Then schemas only, in the area files each package lists: M2-03 `pack/**` (1b); M2-05, M2-06 and M2-07 (2a); M2-S10 `api/{license,ops-entitlements}.ts` (2b); M2-S09 `api/ops.ts` and M2-08 `api/imports.ts` (3a); M2-S11 `api/{auth,ops-domains}.ts` (3b) |
| `apps/server/src/config/profile.schema.ts` | M2-02 (1a) only |
| `apps/server/profiles/saas.yaml` | M2-02 (1a, new keys), M2-S02 (1b, mail port and comments), M2-S10 (2b, `license.plans` values) |
| `apps/server/src/program.ts` | M2-02 (1a) only; it registers every new command module (D.3) |
| `apps/server/src/main.ts` | no package |
| Parent Nest modules (`implementation.module.ts`, `registers.module.ts`, `management-systems.module.ts`, `audit-registers.module.ts`, `identity.module.ts`, `admin-users.module.ts`, `ops.module.ts`, `license.module.ts`, `imports.module.ts`) | M2-02 (1a, imports every sub-module of D.3). Later only `ops.module.ts` (M2-06 in 2a, M2-S09 in 3a, both through `ops/**`), `license.module.ts` (M2-S10 in 2b, through `license/**`) and `imports/imports.module.ts` (M2-08 in 3a) |
| Sub-module files of D.3 | M2-02 (1a, stubs), then the package named for each file in D.3 |
| `apps/server/src/cli/license.ts` | M2-02 (1a, stub), M2-06 (2a), M2-S10 (2b) |
| `apps/server/src/cli/tenant.ts` | M2-06 (2a), M2-S09 (3a), M2-S11 (3b, `verify-domain` only) |
| `apps/server/src/modules/ops/**` | M2-02 (1a, stubs), M2-06 (2a), M2-S09 (3a, except `domains/**`), M2-S11 (3b, `domains/**`) |
| `apps/server/src/modules/license/**` | M2-02 (1a, stubs and module registration), M2-S10 (2b) |
| `apps/server/src/modules/tenancy/**` | M2-S10 (2b, `rate-limit-store.ts` only), M2-S09 (3a) |
| `apps/server/src/modules/identity/mail-templates.ts` | M2-06 (2a), M2-S10 (2b), M2-S09 (3a), M2-S11 (3b) |
| `apps/server/src/modules/jobs/schedules.ts` | M2-05 (2a), M2-S10 (2b), M2-S11 (3b) |
| `apps/server/src/modules/jobs/scheduler-tick.job.ts` | M2-06 (2a), M2-S09 (3a) |
| `apps/server/test/int/{contract,rbac,security}/**` | M2-02 (1a). Later each building package owns only its own `record-tables/M2-xx.ts`, `expectations/M2-xx.ts` and `m2-pending/M2-xx.json` |
| `apps/server/package.json` | M2-03 (1b, version), M2-S13 (6, script `test:int:saas`) |
| `apps/web/src/auth/**` | M2-01 (1b, `boot.tsx`), M2-S11 (3b), M2-17 (4, `i18n.ts` and other text) |
| `apps/web/src/screens/ops/**` | M2-16 (3b), M2-S12 (3c) |
| `tools/mock-providers/**` | M2-04 (2a, `fixtures/demo.json`), M2-S11 (3b), M2-17 (4, `fixtures/demo.json`) |
| `tools/smoke/**` | M2-17 (4, `tests/**`), M2-18 (5), M2-S13 (6) |
| `.github/workflows/ci.yml` | M2-S13 (6) only |
| `deploy/compose/config/caddy/**` | M2-S02 (1b), M2-S08 (2b, `conf.d/ops.caddy`) |
| `docs/INSTALL-ONPREM.md` | M2-06 (2a), M2-18 (5) |
| `docs/saas/go-live-checklist.md` | M2-S04 (1a), M2-S13 (6, status and evidence columns) |

When H.1 has no answer by the end of wave 3c, waves 5 and 6 run first, and M2-17 runs later, followed by the acceptance of M2-18 and M2-S13 again. Without M2-17 the product still shows each of the eight business roles under its own label and the readiness block as "Internal progress score" (M2-01), in the current product words.

Common acceptance for every package (not repeated below): `npm run typecheck`, `npm run lint` and `npm test` pass; `npm run check:text` passes; packages that change server code also pass `npm run test:int -w @mscd/server -- test/int/seed test/int/parity`, and packages that change web code also pass `CI=1 npm run test:e2e -w @mscd/web -- e2e/contrast.spec.js e2e/shell.spec.js` plus the specs of the screens they touch (R-15). The full web E2E suite and the full server integration suite run once per wave, by the orchestrator, after the wave's packages are committed; a failure there goes back to the package that caused it; web packages also pass `npm run gen:views:check -w @mscd/web`, and each of their unit test commands reports at least one test (the zero-test check of M2-01, with the package's own test files); the handoff note exists (R-09).

### G.2 Work package details

#### M2-01 Web screen host and Administration area

| | |
|---|---|
| Wave, depends on | 1b; M2-02 |
| Owns | `apps/web/scripts/convert-template.mjs` (`PATCHES`), the regenerated `apps/web/src/views/*.jsx` and `hover.css`, `apps/web/src/MscdApp.jsx`, `apps/web/src/styles.css`, `apps/web/vitest.config.js`, `apps/web/src/data/SampleDataSource.js`, `apps/web/src/data/types.ts`, `apps/web/src/data/api/**`, `apps/web/src/auth/boot.tsx`, `apps/web/src/screens/{types.ts,registry.ts,host.tsx,actions.ts,api.ts,roles.ts}`, `apps/web/src/screens/ui/**`, `apps/web/src/screens/license/**`, `apps/web/e2e/{helpers.js,shell.spec.js,switching.spec.js,display.spec.js,i18n.spec.js,contrast.spec.js}`, `apps/web/e2e-api/stack.mjs`, `apps/web/test/api/controller.test.ts`, `apps/web/test/screens/{registry,host,ui,license}.test.tsx`, `apps/web/test/fixtures/screens/**`, `apps/web/e2e/screens/{license,probe}.spec.js`, `apps/web/e2e/api-only/{license,admin-landing}.spec.js`, `docs/DEVELOPMENT.md` |

Brief:
- Build section C in full, in the order C.1, C.2, C.3 and C.4, C.6, C.5, C.7, including the sample persona rules and the `?screen=` opener of C.2, the no-system path and preference loading of C.3, and the `.tsx` include of `vitest.config.js`.
- Controls screen: the grouping logic only. Entries with a `cl-` key (D2-09) show in a first group "Clauses 4 to 10" with the label "Cl. 4.1". The sample ISMS holds Annex A controls only and API data has clause entries only after M2-07, so M2-01 tests the group with a unit test on a fixture snapshot; the end-to-end check is in M2-11.
- Role labels: `apps/web/src/screens/roles.ts` holds one label pair per business role (MS Manager, Programme Owner, Domain Owner, Risk Owner, Internal Auditor, Top Management, External Auditor, Compliance Investigator, in the current product words) and the two admin roles. The top bar and the role menu show the label of the role the person holds, so Programme Owner no longer shows as "MS Manager" and External Auditor no longer as "Internal Auditor". `controller.test.ts` checks one distinct label per role.
- Readiness block: label "Internal progress score" with the one-line method text of D.6 ("Average of documents in place, entries implemented, evidence fresh and metrics current per clause"), through a converter `PATCH`, in both languages (D2-11, H.2 default). A null readiness value (D.3; a fresh system before `readiness.recompute` runs) shows as "Not computed yet" in both languages, mapped in `data/api/**`, and never as 0.
- Reference screen "Licence" (`license`, path `/admin/license`, group `admin`, scope `org`, perm `license.read` [TA, TM]): state badge (valid, grace, read-only, expired), licence id, organisation, valid from and until, grace days, seats "used of limit" (active members without guests), frameworks, storage adapters, features, management systems "used of limit". Page action "Install licence" (`license.manage`, through `orgCan`, so it is hidden for Tenant Admins in multi tenancy where only the platform operator holds it) opens a modal with a file input (`.json`) and a paste area, calls `PUT /api/v1/admin/license`, shows `LIC-BINDING` and signature errors next to the field. Sample adapter returns the sample `LICENCE`.
- Specs in `e2e/screens/` carry `@sample-only` (D2-04); `probe.spec.js` shows the pattern.
- Administration landing and the Administration group for Tenant Admins and Storage Admins without a business role (C.3), with `e2e/api-only/admin-landing.spec.js` signing in as `tenant.admin`.
- Permission-aware Reassign, Change due date and Send reminder buttons (C.5).
- `stack.mjs` removes only leftover containers whose expiry label has passed (open follow-up of `CLAUDE.md`).
- `docs/DEVELOPMENT.md`: "Adding a screen" (folder pattern, `meta.json`, action claims, detail extensions, tests) and the API E2E section with the default data source `api` (open follow-up).

Acceptance:

```bash
npm run gen:views:check -w @mscd/web
git diff --quiet HEAD -- project/
npm test -w @mscd/web -- test/screens test/api/controller.test.ts
(cd apps/web && npx vitest run test/screens --reporter=json --outputFile=/tmp/mscd-vitest-screens.json) && node -e "const r=JSON.parse(require('fs').readFileSync('/tmp/mscd-vitest-screens.json','utf8'));if(!(r.numTotalTests>0))process.exit(1)"
CI=1 npm run test:e2e -w @mscd/web
CI=1 npm run test:e2e -w @mscd/web -- e2e/screens/license.spec.js e2e/screens/probe.spec.js e2e/contrast.spec.js e2e/i18n.spec.js e2e/display.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web -- e2e/api-only/license.spec.js e2e/api-only/admin-landing.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web
mkdir -p apps/web/src/screens/zz-probe && cp -r apps/web/test/fixtures/screens/probe/. apps/web/src/screens/zz-probe/ && npm test -w @mscd/web -- test/screens/registry.test.tsx; rm -rf apps/web/src/screens/zz-probe
```

The zero-test line fails when Vitest finds no test file, which `--passWithNoTests` would otherwise hide; every web package runs it with its own test files. The last line proves that a screen folder is found without editing any shared file (`test/fixtures/screens/probe` is a minimal screen the package adds).

#### M2-02 Server contract, schema and permissions

| | |
|---|---|
| Wave, depends on | 1a; Milestone 1 |
| Owns | `packages/shared/src/api/**` (including the new `imports.ts`, `ops-domains.ts` and `ops-entitlements.ts`), `packages/shared/src/ui/**` (the UI contract types), `packages/shared/src/{enums.ts,machines.ts,examples.ts,index.ts,openapi.ts}`, `packages/shared/src/authz/**`, `packages/shared/test/**`, `apps/server/migrations/tenant/0008_milestone2.sql`, `apps/server/migrations/platform/0005_milestone2_saas.sql`, `apps/server/src/db/types/*` except `ref.ts`, `apps/server/src/config/profile.schema.ts`, `apps/server/profiles/{saas,onprem,demo,test}.yaml` (new keys only), `apps/server/src/program.ts`, the CLI stubs `apps/server/src/cli/{license,backup,diagnostics}.ts`, `apps/server/src/app/*.module.ts`, the `*.module.ts` and controller files named in D.1, the sub-module files of D.3 (with the stubs `apps/server/src/modules/ops/domains/**` and `apps/server/src/modules/license/entitlements.controller.ts`), the guard file that reads `permissionBy` (body source), `apps/server/src/modules/imports/**` (skeleton), the stub job files of D.3, `apps/server/test/int/{contract,rbac,security,db}/**`, `apps/server/test/int/m2-pending/**`, `docs/platform/ui-contract.md` |

Brief:
- Every route of D.1 with zod schemas, examples and OpenAPI output; the schema and permission changes of D.2 on existing routes; D.3 in full; the UI contract changes of D.3 (the `cl-` key of D2-09, nullable readiness and dimensions, document `origin` and `changeSummary`) in `packages/shared/src/ui/**` and in `docs/platform/ui-contract.md`.
- The contract of the SaaS track (K) in the same pass: the ten SaaS routes of D.1, the D.2 schema changes of `ops.organizations.create`, `ops.organizations.list`, `system.profile` and `auth.providers`, the platform migration, profile keys, permission, enum values and organisation status machine of D.3, so no SaaS package adds any of them (R-14, S-3). Every profile still loads, and the defaults of the new keys leave on-premise behaviour unchanged.
- Stub handlers behind `@ApiRoute` answering 501 with the problem slug `not-implemented`; new controllers and stub jobs registered in the sub-module files of D.3, each imported once in its parent module; the `imports` module registered in the api and worker modules; the six new jobs registered with stub handler files (D.3); the three new CLI modules registered in `program.ts` with stub actions (D.3).
- `admin.packs.import` and `admin.packs.list` from a platform operator session in multi tenancy (D.2): check, and fix the schema or guard here when they refuse it.
- Plan-anchored shared tests: `packages/shared/test/{routes,enums,authz,machines}.test.ts` compare the code with tables parsed from `docs/platform/BUILD-PLAN.md`. `packages/shared/test/helpers.ts` reads BP and section J of this plan and merges them (J overrides a BP CHECK list of the same column). `WORK_PACKAGE_IDS` and the owner types of `RouteDef.owner` and `Machine.owner` (today `WP-${string}`) also accept `M2-01` to `M2-18` and `M2-S01` to `M2-S13`, read from the `#### M2-nn` and `#### M2-Snn` headings of this plan. New route owners are the building package of D.1. The `RULE_IDS` length check becomes the sum of both plans (57 plus 3). `PROBLEM_SLUGS` gets `not-implemented` 501, and the D.1 count of 17 becomes 18. No assertion is removed or loosened.
- `m2-pending/M2-05.json` to `M2-08.json` and `M2-S09.json` to `M2-S11.json` with the route ids each package builds; the WP-30 contract harness declares 501 for listed routes, and the RBAC, owner-scope and external auditor sweeps read them (D.1).
- Split the sweep data so later packages do not share one file: `security/record-tables.ts` and `rbac/expectations.ts` merge `security/record-tables/M2-nn.ts` and `rbac/expectations/M2-nn.ts` (one file per building package: M2-05 to M2-08 and M2-S09 to M2-S11). Record-table entries for every new GET route go in the file of its building package, so the owner-scope sweep checks them once the stubs are replaced.
- Contract snapshot updated once for the 38 new route ids. Schema drift test passes with the new columns and tables.
- Existing behaviour unchanged: no Milestone 1 route answers differently.

Acceptance:

```bash
npm test -w @mscd/shared
git diff --quiet HEAD -- docs/platform/BUILD-PLAN.md
npm run openapi
npm run test:int -w @mscd/server -- test/int/db test/int/contract test/int/rbac test/int/security
npm run test:int -w @mscd/server
test "$(ls apps/server/test/int/m2-pending/*.json | wc -l)" -eq 7
test "$(ls apps/server/test/int/security/record-tables/M2-*.ts apps/server/test/int/rbac/expectations/M2-*.ts | wc -l)" -eq 14
node -e "const s=require('fs').readFileSync('apps/server/test/int/contract/__snapshots__/routes.test.ts.snap','utf8');for(const id of ['ms.certification','admin.onboarding','imports.commit','records.holdings.reassign','applicability.targets','documented-info.link','ops.users.reset-mfa','ops.organizations.status','ops.domains.add','ops.entitlements.set','ops.plans.list'])if(!s.includes(id+' '))process.exit(1)"
test -e apps/server/migrations/platform/0005_milestone2_saas.sql && test "$(ls apps/server/migrations/platform/0005_*.sql | wc -l)" -eq 1
npm run build -w @mscd/server && node apps/server/dist/main.js backup --help >/dev/null && node apps/server/dist/main.js diagnostics --help >/dev/null && git diff --quiet HEAD -- apps/server/src/main.ts
```

#### M2-03 Pack format and upgrade path

| | |
|---|---|
| Wave, depends on | 1b; M2-02 |
| Lockfile owner | yes, for the server version 1.1.0 only |
| Owns | `packages/shared/src/pack/**`, `packages/pack-tools/**`, `packs/scripts/**`, `packs/README.md`, `packs/content/**`, `packs/sources/**`, `apps/server/migrations/ref/0002_milestone2.sql`, `apps/server/src/db/types/ref.ts`, `apps/server/src/modules/packs/**` (including the stub `applicability-sync.job.ts`), `apps/server/src/modules/implementation/applicability-seed.ts` (new), `apps/server/package.json` (version), `package-lock.json`, `apps/server/test/int/packs/**`, `apps/server/test/int/pack-upgrade/**` (new) |

Brief:
- E.1 in full, with `engine_min_version` 1.1.0, the server version 1.1.0, the `removed.csv` marker and `clauseEvidenceMissing` in `--json`.
- `ref/0002_milestone2.sql` with the full content listed in D.3 and the CHECK lists of J.7, including `internal_audit` in the `ref.audit_activity_template.event_type` CHECK. The pack schema in `pack/**` adds only the values of E.1, D.3 and J.7 (R-14).
- No content change and no sample change: the clause 10 fixes go to M2-04 (E.2), so `mscd-data.js`, the seed snapshot and the Milestone 1 specs stay as they are in this package.
- `applicability-seed.ts`: `seedApplicability(trx, msId)` creates the D2-09 entries, skips retired rows and existing entries, and is used by `applicability.sync` (E.3) and by M2-06 at system creation.
- `applicability.sync` job (filling the stub of M2-02) and the retry of skipped mappings (E.3). The job skips demo organisations (`demo_deploy_label` set, E.3).
- Pack versions bumped once, the patch step of E.3.

Acceptance:

```bash
node packs/scripts/extract-from-sample.mjs --check
node packs/scripts/validate-sources.mjs
npm run build -w @mscd/pack-tools && node packages/pack-tools/dist/cli.js build-all --sign-key-file packages/pack-tools/dev-keys/pack-signing.key --out packs/dist
node apps/web/scripts/export-sample-snapshot.mjs --check
git diff --quiet HEAD -- apps/web/src/data/mscd-data.js apps/server/src/seed/demo/sample-snapshot.json
grep -q '"engine_min_version": "1.1.0"' packs/sources/ISO27001-2022/manifest.json
grep -q '"pack_version": "1.2.1"' packs/sources/ISO27001-2022/manifest.json && grep -q '"pack_version": "1.4.3"' packs/sources/ISO9001-2015/manifest.json && grep -q '"pack_version": "0.6.1"' packs/sources/ISO37001-2025/manifest.json
npm run test:int -w @mscd/server -- test/int/packs test/int/pack-upgrade test/int/seed test/int/parity
npm run test:int -w @mscd/server
```

`test/int/pack-upgrade` installs the Milestone 1 packs into an organisation with systems, then a fixture version built from them that marks 10.3 retired, retitles 10.1 and adds one leaf row, and checks: no row deleted, 10.3 retired and hidden from `applicability.targets` data, entries added for the new row, `pack_content_updated` sent once, a second run adds nothing, a pack that drops a code without `retired` is refused with 422 `business-rule` and rule `PACK-ROW-REMOVED`, a pack that drops an activity template is accepted, and a demo organisation (`demo_deploy_label` set) gets no entry and no notification.

#### M2-04 Pack content

| | |
|---|---|
| Wave, depends on | 2a; M2-03 |
| Owns | `packs/content/**`, `packs/sources/**`, `packs/README.md`, `apps/web/src/data/mscd-data.js`, `apps/server/src/seed/demo/sample-snapshot.json`, `tools/mock-providers/fixtures/demo.json`, `apps/server/test/int/packs/**`, `apps/server/test/int/parity/**`, `apps/server/test/int/pack-upgrade/**`, `apps/web/e2e/{audit,calendar,chain,display,documents,framework,freshness,golden-thread,i18n,mytasks}.spec.js`, `apps/web/test/sample-source.test.js` |

Brief:
- E.2 for all six packs, written as content tables in `packs/content/<pack_id>/`: requirement rows with `parent_code`, documented information, document templates (covering the 13 activity output codes, plus `SCO-01` Scope statement for requirement 4.3 and the matching scope template of each other pack), review inputs, Annex A links, Annex A evidence examples and an evidence example for every leaf clause row, assessable flags, derivation JSON, ISO 37001 chain fixes.
- Clause 10 per standard (packs research "Clause 10 numbering per standard"): retitle and mark retired, never delete; ISO 37001:2016 retires 6.3. The `HS9` list of `mscd-data.js` changes with the packs so sample and pack agree, then the seed snapshot and mock fixture are regenerated with `node apps/web/scripts/export-sample-snapshot.mjs`. The Milestone 1 specs and `sample-source.test.js` in Owns get the new counts, readiness numbers and labels, with the reason per spec in the handoff note (R-15).
- Activities: 6.7 and 6.8 reworded to name the document types they produce; 2.3 and 2.6 get an `output_document_code` (scope statement, risk treatment plan); 3.4 completes from the objectives register, 7.2 from the competence register, 4.9 from its output document (E.2). This is pack content and does not wait for H.1.
- Demo text out of the pack prep tasks and cycle titles (E.4), and the ISO 9001:2026 phase 9 activity dropped through `removed.csv` (E.1).
- Document code clashes of the gap study (`PRC-05`, `POL-01` against `QM-01`, `POL-B01`, `POL-A01`): template codes are unique per pack, and activity output codes match the sample's codes where the demo links them. A customer's own codes are handled by `documented-info.link` (D.1, M2-07).
- `packs/README.md`: the lead auditor sign-off table of E.2, with every pack listed and no sign-off yet.
- Second version bump, the minor step of E.3. ISO37001 statuses stay as they are until H.6 is answered.
- Orchestrator note from M2-03: `apps/server/test/int/pack-upgrade/**` joins this package's Owns. Its fixture versions (1.2.2 to 1.2.5) become downgrades after the content step, so move them above 1.3.0 and take the counts from `seedTargets`.
- Orchestrator note from M2-03: `test/int/parity/snapshots.test.ts` raises every sample PACKS version by one patch step. Remove that transform when the sample moves to the content step, or parity expects 1.3.1 against 1.3.0.
- Orchestrator note from M2-03: content references become errors at the content step (`CONTENT_REFERENCES_STRICT_FROM`). Prove it in the handoff: a copy of a pack folder with one `output_document_code` changed to an unknown code makes `node packs/scripts/validate-sources.mjs --dir <copy>` exit 1.

Acceptance:

```bash
node packs/scripts/extract-from-sample.mjs --check
node packs/scripts/validate-sources.mjs
node packs/scripts/validate-sources.mjs --json | node -e "
const c = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const want = { 'ISO27001-2022': [34, 15, 25, 10], 'ISO9001-2015': [84, 27, 25, 12], 'ISO22301-2019': [59, 15, 23, 13], 'ISO37001-2016': [50, 13, 23, 11] };
for (const [id, [req, di, tpl, mr]] of Object.entries(want)) {
  const p = c[id];
  if (p.requirements !== req || p.documentedInfo !== di || p.documentTemplates !== tpl || p.reviewInputs !== mr || p.clauseEvidenceMissing !== 0) { console.error(id, p); process.exit(1); }
}
if (c['ISO27001-2022'].catalogueLinked !== 93 || c['ISO27001-2022'].evidenceExamples < 93) process.exit(1);"
! grep -rqE 'NC-2025-02|SoA v3\.0|DC Jakarta' packs/sources/*/prep_tasks.csv packs/sources/*/cycle_requirements.csv
grep -q 'SCO-01' packs/sources/ISO27001-2022/document_templates.csv
grep -q '"pack_version": "1.3.0"' packs/sources/ISO27001-2022/manifest.json && grep -q '"pack_version": "1.1.0"' packs/sources/ISO22301-2019/manifest.json && grep -q '"pack_version": "0.10.0"' packs/sources/ISO9001-2026/manifest.json
node apps/web/scripts/export-sample-snapshot.mjs --check
npm run test:int -w @mscd/server -- test/int/packs test/int/seed test/int/parity
npm test -w @mscd/web -- test/sample-source.test.js
CI=1 npm run test:e2e -w @mscd/web
```

ISO 9001:2026 and ISO 37001:2025 are checked by the same script once their trees are confirmed (H.6); until then their counts are written in the handoff note.

#### M2-05 Certification, internal audit and readiness server

| | |
|---|---|
| Wave, depends on | 2a; M2-02, M2-03 |
| Owns | `packages/shared/src/api/{admin-ms,audit-events}.ts` (schemas only, R-14), `apps/server/src/modules/management-systems/certification.*`, `apps/server/src/modules/registers/audit-events.service.ts`, `apps/server/src/modules/audit-registers/{internal-audit.controller.ts,internal-audit.module.ts,audit-activities.service.ts,cycle-derive.service.ts,cycle-derive.job.ts}`, `apps/server/src/modules/implementation/readiness/**` (new), `apps/server/src/modules/notifications/certificate-expiry.job.ts` (new), `apps/server/src/modules/implementation/command-support.ts`, `apps/server/src/modules/registers/command-support.ts`, `apps/server/src/modules/risk-registers/support.ts`, `apps/server/src/modules/audit-registers/{findings.service.ts,corrective-actions.service.ts}`, `apps/server/src/modules/read-model/derive/{overview.ts,ms-fields.ts}`, `apps/server/src/modules/jobs/schedules.ts`, `apps/server/src/seed/**` except `seed/demo/sample-snapshot.json`, `apps/server/test/int/certification/**` (new), `apps/server/test/int/security/record-tables/M2-05.ts`, `apps/server/test/int/rbac/expectations/M2-05.ts`, `apps/server/test/int/m2-pending/M2-05.json` (deletes) |

Brief:
- D.4 in full: cycle creation (automatic and `ms.cycles.create`), activation of an existing `planned` cycle by the first `stage1` event, recertification next to a certified cycle and the move of the old cycle to `closed`, `ms.certification`, `ms.cycles.list`, `ms.cycles.transition` (suspend, reinstate, withdraw, close an active cycle; reason required; audited `certification_cycle.transitioned`), certificate label from the cycle, `certificate.expiry` job, new derivation kinds.
- Internal audit: `internal_audit` events with `scope_text` and `report_document_id`, created by MS Managers and Internal Auditors (`internal_audit.manage`, D.2); the event type check in the services of `audit-events.update`, `audit-activities.generate` and `audit-activities.update` for callers who hold only `internal_audit.manage`; audit activities with auditor and target and the `AUD-INDEP` warning; `internal-audit.programme` coverage view (clauses 4 to 10 and applicable controls, the internal audit events and activities that covered each in the cycle, and the uncovered ones).
- Findings: store `finding.target_code` on create and update and filter `findings.list` by `targetCode` (D.2).
- D.6 readiness recompute with its schedule; `readiness.recompute` and `cycle.derive` queued next to every `freshness.recompute` call in the three command helpers, and after finding and corrective action commands; overview derivation reads the four stored dimensions and the certificate expiry that the loader of M2-07 passes in, and keeps the Milestone 1 offset formula of `maturityValues` for a row without stored dimensions (D.6); the seed writes demo readiness rows as `manual` with null dimensions and demo cycles with expiry dates that keep the sample certificate labels. The parity files stay unchanged.
- Services and controllers are registered in the sub-modules `management-systems/certification.module.ts`, `implementation/readiness/readiness.module.ts` and `audit-registers/internal-audit.module.ts` (D.3).
- Orchestrator note from M2-03: retired requirement and catalogue rows stay in `ref` with `retired = true`. Leave them out of readiness and clause lists; an existing entry on a retired row shows "No longer in the standard".
- Orchestrator note from M2-03: `applicability.sync` queues `readiness.recompute` with the singleton key `rr:<org>:<ms>`. Keep that key, or change it in `packs/applicability-sync.service.ts` too.

Acceptance:

```bash
npm run test:int -w @mscd/server -- test/int/certification
npm run test:int -w @mscd/server -- test/int/audit-registers test/int/commands test/int/jobs test/int/management-systems
test ! -e apps/server/test/int/m2-pending/M2-05.json
npm run test:int -w @mscd/server -- test/int/rbac test/int/contract test/int/security test/int/seed test/int/parity
git diff --quiet HEAD -- apps/server/test/int/parity
npm run test:int -w @mscd/server
```

`test/int/certification` covers: the first stage1 event creates one cycle and its items, or activates the `planned` cycle of a seeded system; a second open cycle is refused; a recertification event on a certified system opens the next cycle, and its certificate closes the old one; `ms.certification` refused without a recommended stage2 outcome, accepted with it, sets both statuses, audits; `ms.cycles.transition` for every move of J.8 that it serves, refused without a reason and for any other move; expiry notices at 90, 30 and 7 days with a fixed clock, lapse to `expired`; `internal_audit` event by an Internal Auditor accepted, by a Domain Owner refused; an Internal Auditor can generate and edit activities and attach a report on an `internal_audit` event and is refused on a `stage1` event; `AUD-INDEP` warning; findings filtered by target code; programme coverage; readiness for a fresh system with no rows is null per group, rises after an entry is verified, and leaves `manual` rows alone.

#### M2-06 Onboarding, accounts and operator server

| | |
|---|---|
| Wave, depends on | 2a; M2-02, M2-03 |
| Owns | `packages/shared/src/api/{admin-users,me,notifications,ops,license}.ts` (schemas only), `apps/server/src/modules/admin-users/**`, `apps/server/src/modules/authz/{me.controller.ts,me.service.ts,me-assembler.ts}`, `apps/server/src/modules/identity/recovery-codes.*`, `apps/server/src/modules/identity/{invitation.service.ts,mail-templates.ts}`, `apps/server/src/modules/notifications/{notifications.controller.ts,notifications.service.ts}`, `apps/server/src/modules/ops/**` except `ops/domains/**`, `apps/server/src/modules/management-systems/management-systems.service.ts`, `apps/server/src/modules/jobs/scheduler-tick.job.ts` (M2-05 keeps `schedules.ts`), `apps/server/src/cli/{admin.ts,tenant.ts,license.ts}` (`license.ts` fills the stub that M2-02 registered in `program.ts`), `deploy/scripts/install.sh`, `deploy/helm/mscd/templates/admin-job.yaml` (new), `deploy/helm/mscd/values.yaml` (the `adminJob` block), `deploy/helm/mscd/ci/{validate.sh,assert-render.mjs}`, `docs/INSTALL-ONPREM.md`, `apps/server/test/int/onboarding/**` (new), `apps/server/test/int/security/record-tables/M2-06.ts`, `apps/server/test/int/rbac/expectations/M2-06.ts`, `apps/server/test/int/m2-pending/M2-06.json` (deletes) |

Brief:
- Routes and changes of D.1 and D.2 marked M2-06, with D.5 including the steps `team`, `verifiers` and `internal_auditor` and the `doneBy` and `assignee` fields.
- `ops.users.reset-mfa`: finds the account by email, refuses with 404 when it has no factor set up, resets it as `admin.users.reset-mfa` does, ends the account's sessions, sends the security mail, audits `auth.mfa_reset` with the reason.
- `deploy/scripts/install.sh`: before it runs `tenant create`, it prints that the organisation slug can never be changed and asks for confirmation (skipped with `--yes`).
- `admin.ms.create` calls `seedApplicability` (D2-09) in its transaction and audits `applicability.seeded` with the count.
- `ops.organizations.create`: `{slug, name, timeZone, siteCount, firstAdmin: {email, displayName}, preset?}`, uses `TenantProvisioner.create`, creates the organisation with `local_login = 'allowed'` (product decision 7 of `CLAUDE.md`), creates the invitation and emails it; warns in the response that the slug is permanent; in single tenancy answers 409 `conflict` with `messageKey` `single_tenancy`. With `mail.required` true (SaaS) and no SMTP configured it refuses with 409 `conflict` and `messageKey` `mail_required` and never returns the invitation link; with `mail.required` false and mail off it returns the link once. The schema accepts `preset`, which M2-S09 applies in wave 3a (D.2). The rest of the organisation lifecycle (status, detail, history, `tenant onboard`) is M2-S09.
- CLI: `admin create-operator --email <email> [--name <name>]` and `admin revoke-operator --email <email>` (platform role `platform_operator`, one-time set-password link from token kind `set_password`, TOTP enrolment forced at first sign-in, audit entry `ops.operator_created` or `ops.operator_revoked`); `license show-id` prints the installation id; `admin create-user` emails the invitation (D.2). With `mail.required` true, `admin create-operator` refuses when SMTP is not configured, never prints the set-password link, and prints "Invitation sent to <email>".
- New services go in the sub-modules `admin-users/onboarding.module.ts` and `identity/recovery-codes.module.ts` (D.3); the ops services go in `ops.module.ts`, which M2-06 owns in wave 2a.
- Helm: an optional Job (`adminJob.enabled`) that runs `tenant create`, `admin create-user` or `admin create-operator` with values, documented in `docs/INSTALL-ONPREM.md` with the new CLI commands (open follow-up of `CLAUDE.md`).
- Orchestrator note from M2-03: call `seedApplicability` (`implementation/applicability-seed.ts`, without `only`) when a system is created, and audit `applicability.seeded`.

Acceptance:

```bash
npm run test:int -w @mscd/server -- test/int/onboarding
npm run test:int -w @mscd/server -- test/int/admin-users test/int/identity test/int/authz test/int/notifications test/int/ops test/int/management-systems test/int/license
test ! -e apps/server/test/int/m2-pending/M2-06.json
npm run build -w @mscd/server && node apps/server/dist/main.js admin --help | grep -q create-operator && node apps/server/dist/main.js license --help | grep -q show-id
bash -n deploy/scripts/install.sh && grep -qi 'slug.*cannot be changed' deploy/scripts/install.sh
bash deploy/helm/mscd/ci/validate.sh
npm run test:int -w @mscd/server -- test/int/rbac test/int/contract test/int/security
npm run test:int -w @mscd/server
```

`validate.sh` runs `helm` in a container (WP-29); M2-06 adds a render with `adminJob.enabled=true` and an assertion for the Job to `ci/assert-render.mjs`. `test/int/onboarding` covers every D.5 step on a fresh organisation, organisation update and time zone change, pending memberships with accept and decline, email and notification for an existing active account with the same 202 for the admin, recovery codes (old codes stop working, ten new ones, audit, security mail), read-all, operator organisation create in multi tenancy with local sign-in allowed, 409 in single tenancy, and 409 `mail_required` when `mail.required` is true and SMTP is missing, operator factor reset for an account with two memberships, and system creation that seeds one entry per catalogue item plus one per leaf requirement row of the installed ISO 27001 pack, with the expected count computed from the installed pack (M2-04 runs in the same wave; the literal 93 plus 30 is checked in M2-09 and M2-18).

#### M2-07 Document control and register server additions

| | |
|---|---|
| Wave, depends on | 2a; M2-02, M2-03 |
| Owns | `packages/shared/src/api/{implementation,documents,files,records,risk-registers,audit-registers}.ts` (schemas only), `apps/server/src/modules/implementation/{targets.controller.ts,targets.module.ts,freshness-thresholds.*,documented-info.*,applicability.service.ts,rules/**}`, `apps/server/src/modules/freshness/**`, `apps/server/src/modules/registers/{document-versions.controller.ts,holdings.*,documents.service.ts,records.service.ts}`, `apps/server/src/modules/files/**`, `apps/server/src/modules/risk-registers/**` except `risk-registers/support.ts` (M2-05), `apps/server/src/modules/audit-registers/{review-edit.controller.ts,review-edit.module.ts,management-reviews.service.ts}`, `apps/server/src/modules/jobs/tasks-overdue.job.ts`, `apps/server/src/modules/read-model/load/**`, `apps/server/src/modules/read-model/derive/requirements.ts`, `apps/server/test/int/records-extra/**` (new), `apps/server/test/int/security/record-tables/M2-07.ts`, `apps/server/test/int/rbac/expectations/M2-07.ts`, `apps/server/test/int/m2-pending/M2-07.json` (deletes) |

Brief:
- Routes and changes of D.1 and D.2 marked M2-07.
- `applicability.targets` for the Add control form and the import resolver.
- Freshness thresholds per frequency and system: aging at least 1, expired at least aging (as the database check), upsert on the unique index, soft delete on reset, audit before and after, `freshness.recompute` queued. Organisation-wide defaults are not set on screen (B).
- Pack code links: `documented-info.link` writes `document_code_link`. BR-40 (`implementation/rules/activity.rules.ts`) and the documented information list resolve a pack document code to the document with that code, else to the linked document, so a customer that keeps its own codes can complete activities 3.1, 3.3 and 3.5.
- Documented information list: per `ref.documented_info` row, the linked document (by template code, by `document_code_link`, or by the applicability entry's implementing documents) with status, review date and owner, or for `retain` rows the evidence items of the clause with freshness. States `missing`, `draft`, `in_review`, `approved`, `review_overdue`, `fresh`, `out_of_date`.
- Document versions list with the scope policy that hides restricted documents.
- Holdings: every open item kind a person can hold (applicability entries, activities, documents as owner or approver, evidence, risks, treatments, findings, corrective actions, prep tasks, cycle items, register rows, stored tasks), reassign in one transaction with per-record warnings and audit.
- Register kinds `objectives` and `competence` with own-row rights (`register.manage` own), owner required. Reminder: the daily `tasks.overdue` job (`jobs/tasks-overdue.job.ts`) sets `pending_action` and `action_due_at` on a competence record 30 days before `valid_until`, so it shows in the owner's tasks, and sends the owner the existing notification kind `task_overdue` once when `valid_until` has passed.
- Management review PATCH. `APPL-ASSESS` rule.
- New services go in the sub-modules `implementation/targets.module.ts`, `registers/holdings.module.ts` and `audit-registers/review-edit.module.ts` (D.3).
- The read model loader exposes clause entries of catalogue systems with the key `cl-<code>` (D2-09, `requirementKey` in `derive/requirements.ts`), document origin and change summary in the snapshot. The loader also loads the new `clause_readiness` columns (`documented_pct`, `implemented_pct`, `evidenced_pct`, `measured_pct`, `computed_at`) and `certification_cycle.certificate_expires_at` for the overview of M2-05, and passes a null `readiness_pct` or dimension through as null (`num()` is not applied to them). A read model test checks that no two entries of one system share a key, for the seeded demo and for a fresh ISO 27001 system with clause entries.
- Orchestrator note from M2-03: retired requirement and catalogue rows stay in `ref` with `retired = true`. Pickers leave them out; an existing entry on a retired row shows "No longer in the standard". Mappings can now come from a catalogue item (`ref.requirement_mapping.source_catalogue_item_id`); the rules in `risk-registers/rules.ts` and `files/file-commands.service.ts` still read only requirement sources.

Acceptance:

```bash
npm run test:int -w @mscd/server -- test/int/records-extra
npm run test:int -w @mscd/server -- test/int/commands test/int/commands-implementation test/int/risk-registers test/int/audit-registers test/int/files test/int/read-model test/int/read-model-api test/int/jobs
test ! -e apps/server/test/int/m2-pending/M2-07.json
npm run test:int -w @mscd/server -- test/int/rbac test/int/contract test/int/security test/int/seed test/int/parity
npm run test:int -w @mscd/server
```

#### M2-08 Bulk import

| | |
|---|---|
| Wave, depends on | 3a; M2-01, M2-02, M2-07 (the resolver reads `applicability.targets` and the commit calls the command services M2-07 changes) |
| Owns | `packages/shared/src/api/imports.ts` (schemas only), `apps/server/src/modules/imports/**`, `apps/server/test/int/imports/**` (new), `apps/server/test/int/security/record-tables/M2-08.ts`, `apps/server/test/int/rbac/expectations/M2-08.ts`, `apps/server/test/int/m2-pending/M2-08.json` (deletes), `apps/web/src/screens/import/**`, `apps/web/test/screens/import.test.tsx`, `apps/web/e2e/screens/import.spec.js`, `apps/web/e2e/api-only/import.spec.js` |

Brief:
- Server: upload to `POST /ms/:ms/imports/:kind` (the kind in the path, D.1); `imports.get` and `imports.commit` answer 404 to anyone but the creator. Templates as XLSX with a header row matching the existing exports (SoA columns for applicability, document register columns for documents) and an "Allowed values" sheet; upload up to 5 MB and 5,000 rows, CSV or XLSX; parse with `exceljs` or `csv-parse`; formula cells read as text (F.15); each row checked against the create schemas (`ApplicabilityCreateRequest` with the update fields, `DocumentCreateRequest`, `RegisterCreate` for risks, `EvidenceCreate`); handles and emails resolved to members; codes resolved against `applicability.targets`; results per row `{row, status: ok | error | warning, messages}`; `import_run` stored with the file digest; the same committed digest refused; commit queues `import.run`, which applies every row in one transaction through the existing services, audits `import.committed` with counts and sends `import_finished`. A document import registers metadata only.
- Web: screen "Import" (`import`, `/ms/:ms/import`, group `impl`, perm `applicability.manage` or `document.manage` or `risk.manage` or `evidence.manage`): kind select, "Download template", file field, "Check file" (dry run), results table with filters (errors only), "Import N rows" (disabled while any row has an error), progress through the task id, result summary with links to the screen of the kind. Page action "Import" added to Controls & requirements and Document register (`extraPageActions`).

Acceptance:

```bash
npm run test:int -w @mscd/server -- test/int/imports
test ! -e apps/server/test/int/m2-pending/M2-08.json
npm test -w @mscd/web -- test/screens/import.test.tsx
CI=1 npm run test:e2e -w @mscd/web -- e2e/screens/import.spec.js e2e/contrast.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web -- e2e/api-only/import.spec.js
npm run test:int -w @mscd/server -- test/int/rbac test/int/contract test/int/security
```

`test/int/imports` covers: a 93-row SoA file for a system with seeded entries updates justifications and owners in one commit; one bad row blocks the commit; a filler justification gives the BR-03 warning per row; a second commit of the same file is refused; a Domain Owner cannot import documents; a formula cell is stored as text.

#### M2-09 Storage and management system administration

| | |
|---|---|
| Wave, depends on | 3a; M2-01, M2-02, M2-04, M2-06, M2-07 (the Controls count of the API spec needs the content, the seeding at system creation and the clause entries of the loader) |
| Owns | `apps/web/src/screens/{storage-admin,routing,systems}/**`, `apps/web/test/screens/{storage-admin,routing,systems}.test.tsx`, `apps/web/e2e/screens/{storage-admin,routing,systems}.spec.js`, `apps/web/e2e/api-only/{storage-admin,routing,systems}.spec.js` |

Brief:
- `storage-admin` (no nav entry) claims `storage.connect` and `storage.settings` on the Storage repositories screen. "Connect repository" wizard in a drawer: (1) adapter from the licence's adapters (`managed_vault`, `m365`, `google_drive`), (2) settings from the `StorageRepositoryCreate` schema of `storage.ts` (name, slug, for Microsoft 365 the tenant, site and library, for Google Drive the shared drive or My Drive, root folder per system, storage mode), with the id pattern checks shown next to the fields, (3) credential with `PUT .../credentials` (client secret field, never shown again) or "Grant consent" through the existing re-consent flow, (4) "Test connection" with the result. "Settings" opens the same form with `PATCH` and a note that a config change needs the credential sealed again.
- `routing` ("Routing rules", `/admin/storage/routing`, group `admin`, perm `storage.repository.read`): list with system, classification, repository, mode, state (active, pending approval, rejected), "Add rule" and "Edit" with the BR-38 confirmation dialog, "Approve" and "Reject" for pending rules (disabled with a reason for the requester), tab "Stored files" over `admin.storage.objects.list` (name, repository, system, size, type, hash state; no content).
- `systems` ("Management systems", `/admin/systems`, group `admin`, perm `ms.admin`): list with code, name, edition, status, primary manager, default repository; "New management system" form (code, slug, name, framework and edition from installed packs with status badges and the beta notice for pre-release packs, scope statement, certification body, colour from a token-safe palette, default repository); "Edit" (scope, body, colour, default repository); "Start implementation" (`status: implementing`, refused message when no primary MS Manager); "Archive" with confirmation. Page action "Edition transition" added to screen `fw` with `extraPageActions` (C.5) for MS Managers: a drawer lists the systems with a newer edition installed, with "Start edition transition" and "Finish transition" (`ms.transition`) per system and the note that entries keep pointing at the old edition (B).

Acceptance:

```bash
npm test -w @mscd/web -- test/screens/storage-admin.test.tsx test/screens/routing.test.tsx test/screens/systems.test.tsx
CI=1 npm run test:e2e -w @mscd/web -- e2e/screens/storage-admin.spec.js e2e/screens/routing.spec.js e2e/screens/systems.spec.js e2e/storage.spec.js e2e/framework.spec.js e2e/contrast.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web -- e2e/api-only/storage-admin.spec.js e2e/api-only/routing.spec.js e2e/api-only/systems.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web
git diff --quiet HEAD -- apps/web/src/MscdApp.jsx apps/web/src/views apps/web/src/styles.css apps/web/e2e/helpers.js
```

The API specs connect a SharePoint repository against the mock provider, test it, add a routing rule as `rina` and approve it as `tenant.admin`, and create an ISO 27001 system in `tst` whose Controls screen then lists 123 entries (93 controls and 30 clause rows).

#### M2-10 People, roles and sign-in

| | |
|---|---|
| Wave, depends on | 3a; M2-01, M2-06, M2-07 |
| Owns | `apps/web/src/screens/{users,approvals,handover,identity-providers}/**`, `apps/web/test/screens/{users,approvals,handover,identity-providers}.test.tsx`, `apps/web/e2e/screens/{users,approvals,handover,identity-providers}.spec.js`, `apps/web/e2e/api-only/{users,approvals,handover,identity-providers}.spec.js` (the Milestone 1 spec `e2e/api-only/sign-in.spec.js` stays as it is) |

Brief:
- "People and roles" (`users`, `/admin/users`, perm `user.manage`): member table (name, email, job title, admin roles, business roles per system with the real role label, membership status, authenticator set up, last sign-in), search and filters, drawer per person. "Invite person" form (email, display name, job title, admin roles Tenant Admin and Storage Admin). Drawer actions: "Edit" (job title, admin roles), "Grant role" (system, role from the eight business roles, primary for MS Manager, valid until required for External Auditor), "Revoke role" (shows the `admin.users.holdings` counts of that system with its primary manager before the confirmation, and a link to Handover for the manager to move the items), "Pre-register company sign-in" (provider, subject), "Reset sign-in factor" (confirmation; the server message when another organisation must do it), "Disable" (shows `admin.users.holdings` counts per system with the primary manager to contact and needs a typed confirmation while counts are not zero; refused for yourself and the last admin). Single-admin warning on grants to yourself or another admin (D2-12). "Export roles and responsibilities" downloads a CSV built in the browser (person, role, system, primary, granted by, since, valid until).
- "Pending approvals" (`approvals`, `/admin/users/approvals`, badge count): pending role grants and pending routing rules with "Approve" and "Reject", disabled with the reason for the requester and the grantee.
- "Handover" (`handover`, `/ms/:ms/handover`, group `audit`, perm `record.assign`): pick a person, list their holdings, "Move all to" a successor or per kind, warnings shown per record.
- "Company sign-in" (`identity-providers`, `/admin/sign-in`, perm `idp.manage`; the id keeps clear of the sign-in pages of `apps/web/src/auth`): providers list (name, protocol, slug, enabled, last test), "Add OIDC provider" (issuer, client id, client secret, scopes, button label and icon, MFA claim and fallback, JIT on verified domains), "Add SAML provider" with the fields of the `admin.idp.create` SAML schema (`entryPoint`, `idpIssuer`, `idpCerts`, `spEntityId`, `mfaAuthnContexts`) and a "Paste metadata XML" area that the browser parses into those fields, "Test" (discovery result), "Disable" with the warning that its sessions end, the SP metadata link for SAML (`GET /auth/saml/:slug/metadata`), and "Local sign-in" policy (allowed, admins only, disabled) with the warning to test company sign-in first.

Acceptance:

```bash
npm test -w @mscd/web -- test/screens/users.test.tsx test/screens/approvals.test.tsx test/screens/handover.test.tsx test/screens/identity-providers.test.tsx
CI=1 npm run test:e2e -w @mscd/web -- e2e/screens/users.spec.js e2e/screens/approvals.spec.js e2e/screens/handover.spec.js e2e/screens/identity-providers.spec.js e2e/contrast.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web -- e2e/api-only/users.spec.js e2e/api-only/approvals.spec.js e2e/api-only/handover.spec.js e2e/api-only/identity-providers.spec.js e2e/api-only/sign-in.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web
git diff --quiet HEAD -- apps/web/src/MscdApp.jsx apps/web/src/views apps/web/src/styles.css apps/web/e2e/helpers.js apps/web/e2e/api-only/sign-in.spec.js
```

The API specs: `tenant.admin` invites a person (the email arrives in Mailpit); `tenant.admin` makes `bagus` a Storage Admin through "Edit" (`admin.users.update`), then grants `bagus` a business role, which stays pending because `bagus` is now an administrator, and the approver list names `rina`; `rina` approves it (she neither requested nor receives it); revoking a role shows the holdings counts; disabling a holder shows the counts; an OIDC provider against the mock identity provider is added and tested. Role-grants refuse approval by the requester and by the grantee, so a pending grant to `rina` or `tenant.admin` would have no approver in org `tst`.

#### M2-11 Controls, evidence and phases forms

| | |
|---|---|
| Wave, depends on | 3b; M2-01, M2-04, M2-07 |
| Owns | `apps/web/src/screens/{controls-edit,evidence-edit,phases-edit}/**`, their tests in `apps/web/test/screens/`, `apps/web/e2e/screens/` and `apps/web/e2e/api-only/` |

Brief:
- `controls-edit` claims `controls.add`: "Add control or requirement" lists `applicability.targets` without an entry and not retired, with search; "Custom control" is not offered (the route takes only pack targets). Detail extension for `req`: "Edit" panel for MS Managers with applicability, justification for inclusion and for exclusion (BR-03 warnings from the server shown under the field after Save), linked risks (RecordPicker over `registers.list` risks), implementing documents (picker over documents), owner, gate flag and reason, note, operating frequency and description (`PUT .../operating-criteria`); badges "Written record required" and "Always applicable" from the target data; "Reject" (back to partially implemented with a reason), "Not applicable" (disabled with the `APPL-ASSESS` reason for clause rows), "Delete entry" (`records.delete` with reason and the BR-22 confirmation).
- `evidence-edit`: page action "New evidence" on Evidence freshness and "Define evidence" in the `req` detail: code, title, owner, frequency, classification, targets (controls and requirements of this system, other systems with `integrated_mode`, BR-23 warning); detail extension for `ev`: "Edit", "Add target", "Remove target" (never the last). Page action "Freshness limits" opens the thresholds per frequency with "Reset to default".
- `phases-edit`: detail extension for `activity`: "Start" (activity transition `start`), claims `phases.recordBlocker`: gate item picker from the snapshot's gates and a reason, then the activity transition `block` (BR-39, BR-46).
- End-to-end check of the "Clauses 4 to 10" group of M2-01: `e2e/api-only/controls-edit.spec.js` opens the Controls screen of an ISO 27001 system with seeded clause entries, finds the group first with "Cl. 4.1", opens `cl-5.1` and `5.1` and checks that the two drawers show different records, the clause and the control.

Acceptance:

```bash
npm test -w @mscd/web -- test/screens/controls-edit.test.tsx test/screens/evidence-edit.test.tsx test/screens/phases-edit.test.tsx
CI=1 npm run test:e2e -w @mscd/web -- e2e/screens/controls-edit.spec.js e2e/screens/evidence-edit.spec.js e2e/screens/phases-edit.spec.js e2e/controls.spec.js e2e/phases.spec.js e2e/freshness.spec.js e2e/contrast.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web -- e2e/api-only/controls-edit.spec.js e2e/api-only/evidence-edit.spec.js e2e/api-only/phases-edit.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web
git diff --quiet HEAD -- apps/web/src/MscdApp.jsx apps/web/src/views apps/web/src/styles.css apps/web/e2e/helpers.js
```

#### M2-12 Document control screens

| | |
|---|---|
| Wave, depends on | 3b; M2-01, M2-04, M2-07 |
| Owns | `apps/web/src/screens/{docs-edit,documented-info}/**`, their tests in `apps/web/test/screens/`, `apps/web/e2e/screens/` and `apps/web/e2e/api-only/` |

Brief:
- `docs-edit` claims `docs.new`: "New document" form (code, title, document type from the `doc_type` lookup, owner, approver, classification, next review date, organisation-wide, linked systems, origin with issuer, reference and received date for external documents); optional prefill from a template. Detail extension for `doc`: "Edit" (BR-22 confirmation for shared documents), "Change owner or approver" with the BR-16 check shown before Save, "Reassign" for the person who must act on a document in review (the existing `records.assign` route with kind `doc`, BR-16 and BR-17 messages), "Attach first version" on Draft (through `ctx.openPicker`, then `documents.versions` with a change summary), "Upload new version" with change summary; claims `docs.openReview` and `docs.continueDraft`: review panel with "Approve" (disabled with "You submitted this version" for its author) and "Return to draft" (note required); "Versions" tab (label, status, submitter, approver, dates, rejection note, change summary, "Open file" through `storage.objects.open`).
- "Required documented information" (`documented-info`, `/ms/:ms/documented-information`, group `impl`): table per clause (code, title, document or record, template, linked item, state from D.1 route), filter "Missing only", "Register from template" (opens New document prefilled with the template code, title and type), "Link existing document" (a document picker that writes `documented-info.link`, so the row and the activity that expects the pack code resolve to the customer's own document, BR-40). Badge count of missing items. A "Scope" panel at the top shows the scope text of the system next to the approved scope statement document (`SCO-01` or the document linked to that code) with its version and approval date, or "No approved scope statement" with "Register from template" (H.9).
- Sample adapter: a new version goes to In review, as on a live install, and is approved only through the review panel by another persona; `e2e/screens/docs-edit.spec.js` uploads as `owner` and approves as `manager`.

Acceptance:

```bash
npm test -w @mscd/web -- test/screens/docs-edit.test.tsx test/screens/documented-info.test.tsx
CI=1 npm run test:e2e -w @mscd/web -- e2e/screens/docs-edit.spec.js e2e/screens/documented-info.spec.js e2e/documents.spec.js e2e/contrast.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web -- e2e/api-only/docs-edit.spec.js e2e/api-only/documented-info.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web
git diff --quiet HEAD -- apps/web/src/MscdApp.jsx apps/web/src/views apps/web/src/styles.css apps/web/e2e/helpers.js
```

The API spec registers a document as `bagus`, attaches a vault upload, cannot approve it as its submitter, and `rina` approves it; the Phase board activity that expects its code becomes completable (BR-40). A second document with a customer code (`ISP-001`) is linked to the policy code with "Link existing document", and the activity that expects the policy code becomes completable too.

#### M2-13 Registers screen

| | |
|---|---|
| Wave, depends on | 3c; M2-01, M2-07 |
| Owns | `apps/web/src/screens/registers/**`, `apps/web/test/screens/registers.test.tsx`, `apps/web/e2e/screens/registers.spec.js`, `apps/web/e2e/api-only/registers.spec.js` |

Brief:
- "Registers" (`registers`, `/ms/:ms/registers`, group `impl`, perm `ms.read`) with tabs Context issues, Interested parties, Assets, Risks, Metrics, Objectives, Competence. Each tab: paged list from `registers.list` with search, a drawer per row (display.spec drill rule), "Add" and "Edit" forms with the fields of `risk-registers.ts` for the kind.
- Risks: owner required (BR-17), likelihood and impact on the risk profile scale, inherent and residual score, treatments list in the drawer with "Add treatment" (option from `treatment_option`, owner, due date, linked controls), treatment transitions per C.13 (approve, start, delay, implement, close; close refused without residual acceptance, BR-04), "Accept residual risk" for the risk owner (disabled for the implementer), "Link to another system", "Make primary", "Remove link" (integrated mode).
- Metrics: target, period, "Record value" (period, value, note). Objectives: statement, target, metric, owner, due date, resources, how results are evaluated, status, result, achieved date. Competence: person, role, competence required, proof type, proof file (`ctx.openPicker`), achieved, valid until, verified by.

Acceptance:

```bash
npm test -w @mscd/web -- test/screens/registers.test.tsx
CI=1 npm run test:e2e -w @mscd/web -- e2e/screens/registers.spec.js e2e/contrast.spec.js e2e/display.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web -- e2e/api-only/registers.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web
git diff --quiet HEAD -- apps/web/src/MscdApp.jsx apps/web/src/views apps/web/src/styles.css apps/web/e2e/helpers.js
```

#### M2-14 Audit registers screens

| | |
|---|---|
| Wave, depends on | 3c; M2-01, M2-05, M2-07 |
| Owns | `apps/web/src/screens/{internal-audit,findings,management-review}/**`, their tests in `apps/web/test/screens/`, `apps/web/e2e/screens/` and `apps/web/e2e/api-only/` |

Brief:
- "Internal audit" (`internal-audit`, `/ms/:ms/internal-audit`, group `audit`, perm `ms.read`): programme per cycle (clauses 4 to 10 and applicable controls with covered or not covered), "Plan internal audit" (name, date, audit days, lead auditor from members, scope text) for MS Managers and Internal Auditors, event drawer with audit activities ("Generate from templates", "Edit activity": auditor, clause or control, planned time, key questions, evidence to request; the `AUD-INDEP` warning), "Attach report" (Record document or file), outcome summary, "Raise finding" prefilled with the event.
- "Findings and actions" (`findings`, `/ms/:ms/findings`, group `audit`): tabs Findings, Corrective actions, Self-assessment. Findings: list (source, classification major, minor, opportunity for improvement, clause or control, owner, due, status), "Raise finding" (source, classification, target from `applicability.targets` stored as `targetCode`, text, owner, due, audit event), transitions with BR-06, BR-07 and BR-08 messages, root cause and systemic check texts. Corrective actions: "Create" for one or more findings (owner, due), steps correction, root cause, systemic check, action, effectiveness check (verifier differs from implementer and owner, BR-09), close. Self-assessment: rows per finding condition, assessment, "Raise finding" from a gap. Detail extension for `req` shows open findings of that clause or control through `findings.list?targetCode=`, so the match uses the stored code instead of the free-text clause reference.
- "Management review" (`management-review`, `/ms/:ms/management-review`, group `audit`): list with input completeness, "Plan review" (title, planned date, owner, linked systems), "Edit" (PATCH), inputs per definition with text, "Mark held", "Close" with decisions and the BR-13 and BR-14 messages.

Acceptance:

```bash
npm test -w @mscd/web -- test/screens/internal-audit.test.tsx test/screens/findings.test.tsx test/screens/management-review.test.tsx
CI=1 npm run test:e2e -w @mscd/web -- e2e/screens/internal-audit.spec.js e2e/screens/findings.spec.js e2e/screens/management-review.spec.js e2e/contrast.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web -- e2e/api-only/internal-audit.spec.js e2e/api-only/findings.spec.js e2e/api-only/management-review.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web
git diff --quiet HEAD -- apps/web/src/MscdApp.jsx apps/web/src/views apps/web/src/styles.css apps/web/e2e/helpers.js
```

#### M2-15 Certification timeline and auditor workspace

| | |
|---|---|
| Wave, depends on | 3c; M2-01, M2-05, M2-07 |
| Owns | `apps/web/src/screens/{timeline-edit,auditor-access,audit-trail}/**`, their tests in `apps/web/test/screens/`, `apps/web/e2e/screens/` and `apps/web/e2e/api-only/` |

Brief:
- `timeline-edit` claims `timeline.addEvent`: "Add audit event" (type, names in both languages, short label, date, audit days, lead auditor, preparation window), detail extension for `event`: "Edit" (the BR-42 count of notified holders in the toast), "Record result" (outcome, summary), and for certification audit events (`stage1`, `stage2`, `surveillance`, `recertification`) the activity list with "Generate activities" (`audit-activities.generate` from the pack's audit activity templates such as AA-S1 and AA-S2) and "Edit activity"; for `prep` and `cycle`: "Mark done", "Reassign or change due date" (BR-43). Page actions "Start certification cycle" (when none is open) and "Record certificate" (certificate number, issued, expires, issuing body, certified scope; enabled after a recommended outcome), certificate panel with the expiry date, and on that panel "Record suspension", "Reinstate certificate" and "Record withdrawal" for a certified or suspended cycle and "Close cycle" for an active one, each with a reason (`ms.cycles.transition`, shown only with `ms.transition`).
- "Auditor access" (`auditor-access`, `/ms/:ms/audit/access`, group `audit`, perm `auditor_access.grant` or `ms.read` for the packs tab): claims `audit.auditorAccess`, an override of the existing command (C.5), and replaces its `window.prompt` with a form: email and "Valid for (days)" 1 to 30; grants list (email, created, expires, last used, revoked) with "Revoke"; evidence packs tab (status, built at, repository, item count) with "Download manifest" and "Download archive".
- "Audit trail" (`audit-trail`, `/ms/:ms/audit-trail`, group `audit`, perm `audit_trail.read` or `audit_trail.metadata.read`): entries with filters (action, actor, date range), "Export CSV", "Verify chain" with the result, "Download anchors".

Acceptance:

```bash
npm test -w @mscd/web -- test/screens/timeline-edit.test.tsx test/screens/auditor-access.test.tsx test/screens/audit-trail.test.tsx
CI=1 npm run test:e2e -w @mscd/web -- e2e/screens/timeline-edit.spec.js e2e/screens/auditor-access.spec.js e2e/screens/audit-trail.spec.js e2e/timeline.spec.js e2e/audit.spec.js e2e/contrast.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web -- e2e/api-only/timeline-edit.spec.js e2e/api-only/auditor-access.spec.js e2e/api-only/audit-trail.spec.js e2e/api-only/guest.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web
git diff --quiet HEAD -- apps/web/src/MscdApp.jsx apps/web/src/views apps/web/src/styles.css apps/web/e2e/helpers.js
```

#### M2-16 Getting started, account, notifications and operator console

| | |
|---|---|
| Wave, depends on | 3b; M2-01, M2-06 |
| Owns | `apps/web/src/screens/{getting-started,organization,account,notifications,invitations,ops}/**`, `apps/web/src/screens/license/**` (installation id panel), their tests in `apps/web/test/screens/`, `apps/web/e2e/screens/` and `apps/web/e2e/api-only/` |

Brief:
- "Getting started" (`getting-started`, `/admin/getting-started`, group `admin`, order first, perm `ms.admin`): the D.5 steps as a checklist with state, count and a button to the screen that completes each; progress "n of m done"; the single-admin warning. Steps with `doneBy: 'ms_manager'` (`applicability`, `audit_dates`) are marked "For the management system manager", name the primary MS Manager from `assignee`, and their button opens a prepared email to that person (`mailto:` with the system name and the step) instead of a screen the administrator cannot use. `verifiers` and `team` show a warning while pending: with fewer than two people who can verify, no work in the system can reach Implemented (separation of duties). `internal_auditor` shows as optional.
- "Organisation" (`organization`, `/admin/organization`, perm `org.settings.manage`): name, time zone (IANA list), number of sites, slug read-only with "cannot be changed", installation id with "Copy" for licence requests. The Licence screen shows the installation id too.
- Top bar (`hostTopbar`): notification bell with the unread count (`GET /notifications?unread=true&pageSize=1`), panel with the list, "Mark read", "Mark all read", links to the record; "My account" entry.
- "My account" (`account`, `/account`, nav false): profile, "Change password" (hidden for SSO-only accounts), "Replace authenticator" (opens the existing `reenrol` mode of the enrolment page in `apps/web/src/auth`, which returns to the app as today; M2-16 edits no file in `auth/**`, which M2-S11 owns in the same wave), recovery codes left and "Get new recovery codes" (current code, codes shown once with "Copy" and "Download"), linked company sign-in identities with "Link" (`me.identity.link`), one "Revoke calendar feed" button per system the user can read (`calendar-feed.revoke` is per system and no list route exists), preferences (language, theme, density) saved with `PUT /me/preferences` and applied at once (boot applies them on the next start, M2-01).
- `invitations`: banner in the host layer "You were invited to <organisation>" with "Accept" (LIC-USERS message) and "Decline".
- "Operator console" (`ops`, `/ops`, group `ops`, scope `platform`, perm `ops.read`): health (components, migrations, queues, licence states), queue statistics, "Run job" for allow-listed jobs, "Download diagnostics", organisations list (M2-S12 adds status, plan, domains and entitlements in wave 3c), "Create organisation" (slug with the permanence warning, name, time zone, sites, first administrator email and name; the one-time link only when the response carries one, which never happens on SaaS because `mail.required` is true there), "Install licence" for an organisation (multi tenancy, `PUT /admin/license` with `{org, licence}`), "Framework packs" with the installed pack list (`admin.packs.list`) and "Install pack" (signed `.bundle` upload to `admin.packs.import`, progress through the task id, signature and engine version errors shown next to the field), so SaaS organisations get new pack versions (E.3) without the command line, and "Reset sign-in factor" (email and reason, `ops.users.reset-mfa`) for accounts with several memberships.

Acceptance:

```bash
npm test -w @mscd/web -- test/screens/getting-started.test.tsx test/screens/organization.test.tsx test/screens/account.test.tsx test/screens/notifications.test.tsx test/screens/invitations.test.tsx test/screens/ops.test.tsx
CI=1 npm run test:e2e -w @mscd/web -- e2e/screens/getting-started.spec.js e2e/screens/account.spec.js e2e/screens/notifications.spec.js e2e/screens/ops.spec.js e2e/contrast.spec.js e2e/shell.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web -- e2e/api-only/getting-started.spec.js e2e/api-only/organization.spec.js e2e/api-only/account.spec.js e2e/api-only/notifications.spec.js e2e/api-only/invitations.spec.js e2e/api-only/ops.spec.js e2e/api-only/sign-in.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web
git diff --quiet HEAD -- apps/web/src/MscdApp.jsx apps/web/src/views apps/web/src/styles.css apps/web/e2e/helpers.js
```

#### M2-17 Terminology

| | |
|---|---|
| Wave, depends on | 4; M2-10 to M2-16, M2-S11 and M2-S12 (it may change their text); product owner approval of H.1 |
| Owns | `project/MSCD Mockup.dc.html`, `apps/web/scripts/convert-template.mjs`, the regenerated views, `apps/web/src/MscdApp.jsx`, `apps/web/src/data/{static.js,mscd-data.js}`, `apps/web/src/auth/i18n.ts`, `apps/web/src/screens/roles.ts`, `apps/web/src/screens/*/text.ts`, `apps/web/e2e/**`, `apps/web/test/**`, `packs/content/**` and `packs/sources/**` (labels only, with a patch version bump), `apps/server/src/seed/demo/sample-snapshot.json`, `tools/mock-providers/fixtures/demo.json`, `tools/smoke/tests/**`, `docs/**` (alone in its wave) |

Brief:
- Apply the approved renames of H.1 in English and Indonesian, in the UI, the role labels of `screens/roles.ts`, the pack labels (`ms.manager_role`, `gate.name`), the Tera help and the docs. The one-label-per-role display and the readiness label are already built in M2-01; this package changes only words the product owner approved.
- Regenerate views and the seed snapshot; update the label assertions of the E2E specs and the smoke test.

Acceptance:

```bash
npm run gen:views:check -w @mscd/web
node packs/scripts/extract-from-sample.mjs --check && node packs/scripts/validate-sources.mjs
node apps/web/scripts/export-sample-snapshot.mjs --check
! grep -rn "Golden Thread Viewer\|Phase board\|Domain Owner" apps/web/src --include=*.ts --include=*.tsx --include=*.js --include=*.jsx | grep -v test
CI=1 npm run test:e2e -w @mscd/web
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web
npm run test:int -w @mscd/server -- test/int/seed test/int/parity test/int/packs
flock /tmp/mscd-stack.lock npm run test:smoke
```

The `grep` line lists only the renamed terms the product owner approved.

#### M2-18 Fresh-organisation journey and release check

| | |
|---|---|
| Wave, depends on | 5; every other core package (M2-17 when approved) and every SaaS package except M2-S13 |
| Owns | `tools/smoke/**`, `docs/INSTALL-ONPREM.md`, `project/MSCD User Guide.dc.html`, `deploy/scripts/check-release-artefacts.sh`, `deploy/compose/config/demo-licences/**` texts if present, `docs/platform/handoff/M2-18.md` |

Brief:
- `tools/smoke/run-journey.mjs` and script `journey` in `tools/smoke/package.json`: the on-premise Compose file with the server demo image (development keys accepted) and an overlay that turns the demo seed off, plus Mailpit and the mock providers. The database holds no organisation until the journey runs `tenant create` and `admin create-user` (the installer step, A.2). A licence for the new organisation id is signed at run time with `node packages/pack-tools/dist/cli.js licence sign` and the development licence key.
- `tools/smoke/tests/fresh-org.spec.mjs`, one browser session per person, every step on screen: first admin accepts the invitation and enrols TOTP; installs the licence; invites a second admin and the team (emails read from Mailpit); second admin approves grants; connects a SharePoint repository on the mock and tests it; adds a routing rule; sets local sign-in to "admins only" after a company sign-in test; creates an ISO 27001 system with scope, body and default repository; grants MS Manager (primary), Top Management, Domain Owner and Internal Auditor; starts implementation; plans Stage 1 and Stage 2 events; Getting started shows every step done; imports justifications for 10 controls and edits one control on screen; registers POL-01 from the template, uploads a file, approves it as another person; defines evidence on A.5.1 with a file and verifies the control; records a risk with a treatment and residual acceptance; plans and records an internal audit with an activity; raises a finding and closes a corrective action with an effectiveness check by a third person; holds and closes a management review with all inputs; records the Stage 2 outcome and the certificate; checks that the readiness numbers on Overview moved above 0 and that the system shows as certified with its expiry date. The journey fails on any page error, console error or 5xx answer, and runs `expectReadableText` on every new screen it visits.
- SaaS variant (`--saas`): `admin create-operator` (the set-password email read from Mailpit, because `mail.required` is true), the operator creates the organisation in the console of M2-16 and M2-S12 and installs its licence there (`PUT /admin/license` with `{org, licence}`, because `license.manage` and `pack.install` belong to the platform operator in multi tenancy), the Licence screen shows no "Install licence" to the Tenant Admin, then the same steps up to the system creation.
- Make `SMOKE_STRICT_LAYOUT=1` the default (open follow-up of `CLAUDE.md`).
- `check-release-artefacts.sh` fails on the demo strings of E.4 in built packs, and on a pack bundle whose pack and version have no lead auditor sign-off row in `packs/README.md` (E.2). The journey and the test suites use development bundles and are not release runs.
- `docs/INSTALL-ONPREM.md`: replace the browser console helper section with the screens of Milestone 2, correct any text that offers LDAP, Active Directory, SMB, S3 or WebDAV, and add a short "Not yet available" list of the deferred features of B (LDAP and Active Directory sign-in, SMB, S3 and WebDAV repositories, self-service sign-up, zero-transit upload).
- `project/MSCD User Guide.dc.html`: correct the sentence that offers LDAP or Active Directory sign-in on-premise (line 91 today) and the sentence that says packs are distributed automatically on SaaS (line 226 today; on SaaS the platform operator installs them, M2-16), plus any other mention of SMB, S3 or WebDAV. The guide is written in Indonesian, so the check covers both languages.

Acceptance:

```bash
flock /tmp/mscd-stack.lock npm run journey -w @mscd/smoke
flock /tmp/mscd-stack.lock npm run journey -w @mscd/smoke -- --saas
flock /tmp/mscd-stack.lock npm run test:smoke
bash deploy/scripts/check-release-artefacts.sh --help >/dev/null
! grep -n "mscd(" docs/INSTALL-ONPREM.md
! grep -nE 'LDAP|Active Directory|WebDAV|\bSMB\b|\bS3\b|distributed automatically|didistribusikan otomatis' "project/MSCD User Guide.dc.html"
grep -q 'Not yet available' docs/INSTALL-ONPREM.md
npm run test:int -w @mscd/server
CI=1 npm run test:e2e -w @mscd/web
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web
test -z "$(docker ps -q --filter label=mscd.test=true)"
```

## H. Questions for the product owner

Each question has a default that is built when no answer arrives before the package that needs it.

| # | Question | Default built | Needed by |
|---|---|---|---|
| H.1 | Approve the terminology renames: Tenant Admin to "Organisation administrator"; MS Manager to "Management system manager" (or "ISMS Manager", "QMS Manager" per system); Programme Owner to "Executive sponsor"; Domain Owner to "Control or process owner"; External Auditor to "Certification auditor (guest)"; Compliance Investigator to "Investigation officer"; Holder to "Assigned to"; Gate to "Checkpoint"; Phase board to "Implementation plan"; Chain stages to "Open items by trace step"; Golden Thread Viewer to "Traceability viewer"; sidebar group Surveillance to "Ongoing monitoring" (surveillance audit stays for certification body visits); Expired for documents to "Review overdue"; Expired for evidence to "Out of date"; Verified for files to "File unchanged"; Tier to "Document type". Which ones, and which wording in Indonesian? | No rename; M2-17 waits. Owner's answer (2026-10-28): rename only "Gate" to "Checkpoint" and "MS Manager" to "Management System Manager"; every other label keeps its name | M2-17 |
| H.2 | Readiness: are the four inputs of D.6 the right ones, and should the block say "Internal progress score"? | D.6 as written, with the label "Internal progress score" | M2-01, M2-05 |
| H.3 | A customer with one administrator: keep the second-administrator requirement for self-grants and admin grantees, or let the platform operator approve the first grant with an audit entry? | Keep the rule, warn on screen (D2-12) | M2-10 |
| H.4 | Internal Auditors verifying items and seeing everyone's pending list (open question 3 of `CLAUDE.md`), and Programme Owner verify and approve rights (open question 6): confirm the defaults, then the demo can match the live permissions | Confirmed by the product owner on 2026-10-27: Internal Auditors do not verify and do not see everyone's pending list; the Programme Owner keeps verify and approve rights | Milestone 3 |
| H.5 | Who may see competence records of other people: MS Manager, Programme Owner and Internal Auditor, plus each person for their own? | Yes | M2-07, M2-13 |
| H.6 | ISO 37001: keep 2016 withdrawn and 2025 as a pre-release with a beta notice, or ship 2025 as current with a `supersedes` date from the IAF decision once a lead auditor checks the content? The same check is needed for ISO 9001:2026 | Unchanged statuses. Owner's answer (2026-10-28): both stay preview | M2-04 |
| H.7 | Bulk import: all rows or none per file, or load good rows and report bad ones? | All or none (D2-13) | M2-08 |
| H.8 | Applicability entries created at system creation (D2-09): all 93 Annex A controls as applicable "not started", so the team excludes controls with a reason, or start empty and add from the pack? | Create all | M2-06 |
| H.9 | Scope: keep the scope text on the management system and add a "Scope statement" document (template SCO-01) linked to clause 4.3, or replace the text with the document? | Keep both; the document is the controlled version | M2-04, M2-12 |
| H.10 | Certificate expiry reminders at 90, 30 and 7 days to MS Managers and Programme Owners: right days and people? | Yes | M2-05 |
| H.11 | Who may plan internal audits: MS Manager and Internal Auditor? | Yes | M2-02 |
| H.12 | The operator console creates SaaS organisations. Should it also be offered on-premise, or stay hidden there? | SaaS (multi tenancy) only | M2-06, M2-16, M2-S12 |
| H.13 | Pending work per person (open question 2 of `CLAUDE.md`, with HR sign-off): MS Manager and Programme Owner see each person's open items, Top Management sees totals only. Confirm before the People and Handover screens show holdings per person | Confirmed by the product owner on 2026-10-27: MS Manager and Programme Owner see detail, Top Management totals only, Tenant Admin counts without titles | M2-07, M2-10 |
| H.14 | SaaS owner decisions D-S1 to D-S12: onboarding model, hosting location, public address, plans and limits, read-only period after a contract ends, backup retention, uptime target, CDN or firewall, telemetry, sign-in discovery, key management, key copies for the restore test | The defaults in [K.3](#k3-decisions-for-the-owner) | The SaaS package named per decision in K.3 |

The items that only the owner can buy, sign or approve for SaaS (servers, domain, mail provider, backup storage, release keys, legal documents, penetration test) are listed in [K.2](#k2-what-the-owner-provides).

The product owner confirmed these decisions on 2026-10-27 (`CLAUDE.md`, "Product decisions"). The plan keeps them as follows:

| # | Confirmed decision | Where the plan keeps it |
|---|---|---|
| 1 | Google Drive repositories in a personal My Drive are allowed, as well as Shared Drives | The connect wizard of M2-09 offers a shared drive or My Drive |
| 2 | Pending work per person: MS Manager and Programme Owner see the detail, Top Management sees totals only | H.13; `records.holdings` needs `record.assign` [MM, PO] and `admin.users.holdings` returns counts only (M2-07, M2-10); the totals panel for Top Management is Milestone 3 (B) |
| 3 | Internal Auditors do not verify items and do not see everyone's pending list | H.4; their new permission `internal_audit.manage` covers internal audits only (J.2), and `records.holdings` stays [MM, PO] |
| 4 | Phases are shown in order; the hard block applies only at critical gates | M2-11 records blockers through the existing BR-39 and BR-46 and adds no new block |
| 5 | The licence user count is active members, without guests | Licence screen of M2-01; entitlement limits of M2-S10 (`LIC-USERS`) |
| 6 | The Programme Owner keeps verify and approve rights | H.4; no matrix row of these rights changes |
| 7 | New SaaS organisations do not default to SSO-only sign-in | `ops.organizations.create` (M2-06) and `tenant onboard` (M2-S09) create organisations with local sign-in allowed; the Tenant Admin changes the policy later (M2-10) |
| 8 | A moved or changed evidence file shows "cannot be verified" in evidence lists and does not lower the item status | No Milestone 2 package changes this behaviour; M2-07 changes freshness thresholds only |
| 9 | Production target: multi-tenant SaaS for many customer organisations on one VPS, deployed by a GitHub Actions workflow; on-premise stays supported | A.1, D2-15 and section K |

## I. Risks

| Risk | Effect | Handling |
|---|---|---|
| The foundation (M2-01) takes longer than planned or its extension points miss a need | Every wave 2 and 3 web package waits or edits shared files | M2-01 ships the probe screen and the Licence screen as proof; a missing extension point goes into a handoff note and the orchestrator runs a short fix package before wave 3 |
| Many route stubs answer 501 between waves | A tester or the demo hits "not implemented" | Stubs exist only in the API and answer the declared problem `not-implemented`; no screen calls a route before its server package is done (dependencies in G.1); the demo screens are unchanged |
| Pack content needs licensed copies of the standards and expert review | Wrong clause numbers or lists reach customers | Paraphrased short titles only; ISO 9001:2026 and ISO 37001:2025 marked "to confirm"; H.6; a lead auditor sign-off row per pack and version in `packs/README.md` (M2-04), which the release check of M2-18 requires |
| Content changes break parity tests and the demo | Milestone 1 tests go red | Sample data, seed snapshot and packs change in the same package (M2-03, M2-04); demo readiness rows become `manual`; R-15 |
| The installer never deletes and matches by code | A wrong code shipped once stays for every customer | The `retired` flag and the 422 check of E.1 land before any content change |
| `engine_min_version` 1.1.0 against image tags such as `smoke` or other non-numeric `MSCD_VERSION` values | Packs refused in test images | M2-03 checks how the version comparison treats such values and sets the image builds' `MSCD_VERSION` or the comparison accordingly, with a test |
| One host lock for API E2E and Compose runs | Packages queue for the lock in waves 2 and 3, and the SaaS packages add Compose runs | Run focused specs first, the full API suite once at the end of each package; four agents at most across both tracks |
| Tenant migration 0008 and platform migration 0005 are written before the code that uses them | Later packages find a column missing or wrong | R-14 lets the orchestrator apply a correction migration (`tenant/0009_milestone2_fix.sql` or `platform/0006_milestone2_fix.sql`) between waves; no package edits 0008 or 0005 after wave 1a |
| The SaaS contract is written in wave 1a, three to five waves before M2-S09, M2-S10 and M2-S11 build it | A SaaS package finds a schema or value missing | The SaaS rows of D.1 to D.3 and J come from the SaaS research with field lists; the pending files keep the stubs in the sweeps; a gap goes in the handoff note and the orchestrator fixes it between waves (R-14) |
| Two tracks share four agents | Go-live waits for core waves, or the core waits for SaaS work | The SaaS packages that need no core work start in wave 1a; the combined table of G.1 leaves only one slot free in waves 1a to 3c |
| Import commits large files in one transaction | Long locks on a busy system | Limits of 5,000 rows and 5 MB; the commit runs in the worker; the integration test measures a 5,000-row file |
| Admin screens show business data to a Tenant Admin | Breach of the F.6 separation | Admin routes return counts only (D.5, `admin.users.holdings`); the security sweep covers every new GET route |
| Time zone change of an organisation | Daily jobs run twice or skip a day | M2-06 handles the change day as D.2 says, with a test |
| Terminology approval arrives late | Labels change after the journey is written | Wave order of G.1 with the rerun rule |

## J. Contract tables

The shared contract tests of `packages/shared/test` compare the code with these tables, read next to the matching BP tables by `packages/shared/test/helpers.ts` (M2-02). Each table uses the column format of its BP counterpart. A CHECK list here replaces the BP list of the same column.

### J.1 Endpoints

Paths below `/api/v1`, in the BP D.3 notation.

| Method and path | Route id | Owner |
|---|---|---|
| `GET /admin/organization` | `admin.organization.get` | M2-06 |
| `GET /admin/onboarding` | `admin.onboarding` | M2-06 |
| `POST /me/memberships/{org}/decline` | `me.membership.decline` | M2-06 |
| `GET /me/security` | `me.security` | M2-06 |
| `POST /me/mfa/recovery-codes` | `me.recovery-codes` | M2-06 |
| `POST /notifications/read-all` | `notifications.read-all` | M2-06 |
| `GET /ops/organizations` | `ops.organizations.list` | M2-06 |
| `POST /ops/organizations` | `ops.organizations.create` | M2-06 |
| `POST /ops/users/reset-mfa` | `ops.users.reset-mfa` | M2-06 |
| `GET /ms/{ms}/certification-cycles` | `ms.cycles.list` | M2-05 |
| `POST /ms/{ms}/certification-cycles` | `ms.cycles.create` | M2-05 |
| `POST /ms/{ms}/certification` | `ms.certification` | M2-05 |
| `POST /ms/{ms}/certification-cycles/{id}/transitions` | `ms.cycles.transition` | M2-05 |
| `GET /ms/{ms}/internal-audit/programme` | `internal-audit.programme` | M2-05 |
| `GET /ms/{ms}/applicability/targets` | `applicability.targets` | M2-07 |
| `GET /ms/{ms}/freshness-thresholds` | `freshness.thresholds.get` | M2-07 |
| `PUT /ms/{ms}/freshness-thresholds/{frequencyCode}` | `freshness.thresholds.put` | M2-07 |
| `GET /ms/{ms}/documented-information` | `documented-info.list` | M2-07 |
| `PUT /ms/{ms}/documented-information/{code}/link` | `documented-info.link` | M2-07 |
| `GET /ms/{ms}/documents/{id}/versions` | `documents.versions.list` | M2-07 |
| `GET /ms/{ms}/holdings/{handle}` | `records.holdings` | M2-07 |
| `POST /ms/{ms}/holdings/{handle}/reassign` | `records.holdings.reassign` | M2-07 |
| `GET /admin/users/{id}/holdings` | `admin.users.holdings` | M2-07 |
| `PATCH /ms/{ms}/management-reviews/{id}` | `management-reviews.update` | M2-07 |
| `GET /ms/{ms}/imports/templates/{kind}` | `imports.templates` | M2-08 |
| `POST /ms/{ms}/imports/{kind}` | `imports.create` | M2-08 |
| `GET /ms/{ms}/imports/{id}` | `imports.get` | M2-08 |
| `POST /ms/{ms}/imports/{id}/commit` | `imports.commit` | M2-08 |
| `GET /ops/organizations/{org}` | `ops.organizations.get` | M2-S09 |
| `POST /ops/organizations/{org}/status` | `ops.organizations.status` | M2-S09 |
| `GET /ops/organizations/{org}/events` | `ops.organizations.events` | M2-S09 |
| `GET /ops/organizations/{org}/domains` | `ops.domains.list` | M2-S11 |
| `POST /ops/organizations/{org}/domains` | `ops.domains.add` | M2-S11 |
| `POST /ops/organizations/{org}/domains/{domain}/verify` | `ops.domains.verify` | M2-S11 |
| `DELETE /ops/organizations/{org}/domains/{domain}` | `ops.domains.remove` | M2-S11 |
| `GET /ops/organizations/{org}/entitlements` | `ops.entitlements.get` | M2-S10 |
| `PUT /ops/organizations/{org}/entitlements` | `ops.entitlements.set` | M2-S10 |
| `GET /ops/plans` | `ops.plans.list` | M2-S10 |

### J.2 Permission matrix

| Permission | Scope | MM | PO | DO | RO | IA | TM | EA | CI | TA | SA | OP |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `internal_audit.manage` | ms | yes | | | | yes | | | | | | |
| `ops.tenants.manage` | platform | | | | | | | | | | | yes |
| `ops.entitlements.manage` | platform | | | | | | | | | | | yes |

The BP row of `register.manage` keeps its cells; its condition text now reads "context, interested parties, assets, metrics, objectives, competence" (D.2).

### J.3 Jobs

| Job (owner) | Trigger | Schedule | Effect |
|---|---|---|---|
| `readiness.recompute` (M2-05) | the commands of D.6; `scheduler.tick` | 02:30 local, and 60 seconds after a command | D.6 |
| `certificate.expiry` (M2-05) | `scheduler.tick` | daily, local time | D.4 |
| `import.run` (M2-08) | `imports.commit` | none | applies every row in one transaction, audits `import.committed`, sends `import_finished` |
| `applicability.sync` (M2-03) | pack install that updates an edition in use | none | E.3 |
| `entitlement.expiry` (M2-S10) | `scheduler.tick` | daily | emails platform operators 30, 7 and 1 days before `valid_until`, and the organisation's Tenant Admins 30 and 7 days before |
| `domain.verify` (M2-S11) | `ops.domains.add`, `ops.domains.verify`; `scheduler.tick` | hourly for pending domains up to 7 days, then `failed`; monthly for verified domains | checks the TXT record, audits `ops.domain_verified` or `ops.domain_verification_failed`, emails the operators when a verified record is gone (the status stays verified) |

### J.4 Notifications

| Kind | Created by | Recipient | Digest |
|---|---|---|---|
| `membership_invited` | `admin.users.create` for an existing active account, `ops.organizations.create` | the invited person | no |
| `certificate_expiring` | `certificate.expiry` | MS Managers and Programme Owners | no |
| `import_finished` | `import.run` | the import creator | no |
| `pack_content_updated` | `applicability.sync` | MS Managers of systems on the edition | no |
| `organization_status_changed` | `ops.organizations.status` | Tenant Admins of the organisation, also by email | no |

### J.5 Audit actions

- Actions: `ms.certified`, `certification_cycle.created`, `certification_cycle.expired`, `certification_cycle.closed`, `certification_cycle.transitioned`, `org.updated`, `freshness_threshold.changed`, `auth.recovery_codes_regenerated`, `membership.declined`, `holdings.reassigned`, `import.validated`, `import.committed`, `ops.organization_created`, `ops.operator_created`, `ops.operator_revoked`, `applicability.seeded`, `pack.content_synced`, `document_code.linked`, `management_review.updated`.
- SaaS track: `ops.organization_status_changed`, `ops.domain_added`, `ops.domain_verified`, `ops.domain_verification_failed`, `ops.domain_removed`, `ops.entitlements_changed`.

### J.6 Problems and rules

| Topic | Rule |
|---|---|
| Problem slugs | `not-implemented` 501 (a route stub of D.1 whose id is listed in `m2-pending`); added after the 17 slugs of BP D.1 |
| Errors | platform rule ids added to the extension member `rule`: `APPL-ASSESS`, `PACK-ROW-REMOVED` |
| Warnings | `AUD-INDEP` (auditor independence, D.2) |
| Message keys | no new problem slug for the SaaS track; refusals carry a `messageKey` on an existing slug: `single_tenancy` and `mail_required` (409 `conflict`), `invalid_status_transition` (409 `transition-not-allowed`), `domain_taken` (409 `conflict`), `domain_not_allowed` and `confirmation_mismatch` (422 `business-rule`) |

### J.7 CHECK lists

Column fragments in the DDL notation of BP C.4 to C.6, for the tests; the migrations are `tenant/0008_milestone2.sql`, `ref/0002_milestone2.sql` and `platform/0005_milestone2_saas.sql`.

```sql
CREATE TABLE audit_event (
  event_type varchar(20) NOT NULL CHECK (event_type IN ('stage1', 'stage2', 'surveillance', 'recertification', 'transition', 'special', 'internal_audit')),
);
CREATE TABLE ref.audit_activity_template (
  event_type varchar(20) NOT NULL CHECK (event_type IN ('stage1', 'stage2', 'surveillance', 'recertification', 'transition', 'special', 'internal_audit')),
);
CREATE TABLE ref.documented_info (
  kind varchar(10) NOT NULL CHECK (kind IN ('maintain', 'retain')),
);
CREATE TABLE ref.review_input_def (
  review_kind varchar(15) NOT NULL DEFAULT 'management' CHECK (review_kind IN ('management', 'governing_body')),
);
CREATE TABLE entity_ms_link (
  entity_type varchar(30) NOT NULL CHECK (entity_type IN ('context_issue', 'interested_party', 'asset', 'document', 'evidence', 'risk', 'audit_event', 'management_review', 'metric', 'competence_record')),
);
CREATE TABLE document (
  origin varchar(10) NOT NULL DEFAULT 'internal' CHECK (origin IN ('internal', 'external')),
);
CREATE TABLE quality_objective (
  status varchar(12) CHECK (status IN ('planned', 'on_track', 'at_risk', 'achieved', 'missed')),
);
CREATE TABLE competence_record (
  proof_type varchar(12) NOT NULL CHECK (proof_type IN ('certificate', 'training', 'experience', 'assessment')),
);
CREATE TABLE import_run (
  kind varchar(15) NOT NULL CHECK (kind IN ('applicability', 'documents', 'risks', 'evidence')),
  status varchar(12) NOT NULL CHECK (status IN ('validated', 'committing', 'committed', 'failed', 'expired')),
);
CREATE TABLE platform.organization_status_event (
  from_status varchar(20) NOT NULL CHECK (from_status IN ('active', 'suspended', 'offboarding', 'archived')),
  to_status varchar(20) NOT NULL CHECK (to_status IN ('active', 'suspended', 'offboarding', 'archived')),
);
CREATE TABLE platform.verified_domain (
  status varchar(10) NOT NULL DEFAULT 'verified' CHECK (status IN ('pending', 'verified', 'failed')),
  method varchar(10) NOT NULL DEFAULT 'manual' CHECK (method IN ('dns', 'manual')),
);
CREATE TABLE platform.entitlement (
  source varchar(15) NOT NULL CHECK (source IN ('preset', 'manual', 'signed_licence')),
);
```

### J.8 State machines

| Machine | Transitions |
|---|---|
| `organization.status` (M2-02) | `active` to `suspended` or `offboarding`; `suspended` to `active` or `offboarding`; `offboarding` to `active` or `archived`: `ops.tenants.manage` through `ops.organizations.status` or `tenant set-status`, reason required; `offboarding` and `archived` also need `confirmSlug` equal to the slug. `archived` is final until the purge of K.8 |
| `certification_cycle.status` (M2-02) | (new) to `planned` or `active`: `audit_event.manage`, or system on the first `stage1` or `recertification` event. `planned` to `active`: system on the first `stage1` event, or `audit_event.manage`. `active` to `certified`: only through `ms.certification` with `ms.transition`. `certified` to `closed`: system, when the next cycle is certified. `certified` to `expired`: system (`certificate.expiry`). `certified` to `suspended` and back, `suspended` to `withdrawn`: `ms.transition` through `ms.cycles.transition`, reason required. `active` to `closed`: `ms.transition` through `ms.cycles.transition`, reason required |

The BP row `management_system.status` keeps its entity; its transition `implementing` to `certified` now runs through `ms.certification` (D.2).

## K. SaaS production track

This track makes MSCD ready to run as a multi-tenant SaaS service for paying customers. The core packages of section G build the product screens. This track builds the operator tools, the production deployment, and the checks needed before go-live. It builds on M2-06 (`admin create-operator`, `ops.organizations.create`) and M2-16 (operator console base). Its contract (route ids, permission, enum values, organisation status machine, platform migration and profile keys) is written by M2-02 in wave 1a (D.1, D.2, D.3, J), and its packages run in the combined wave table of G.1. On SaaS, email domains are verified by a DNS TXT record (M2-S11); on-premise keeps the operator command of section B.

**Chosen deployment: Docker Compose on one Ubuntu VPS** (option a). The stack uses:
- the existing `deploy/compose/docker-compose.yml`;
- the `saas.yaml` profile, which already ships in the release server image;
- a new `docker-compose.saas.yml` overlay;
- a Caddy container in front for Let's Encrypt certificates;
- separate overlays for backups and monitoring.

Releases are built and signed by `release.yml` and pushed to `ghcr.io/mqusaeri`. They reach the server through `deploy-prod.yml`. That workflow pulls by digest, takes a backup, migrates, restarts the services in order, checks health and rolls back by itself when a check fails. A person approves every production run in GitHub.

Why Compose and not k3s on the same server:
1. The Compose path is hardened and tested today. It has per-service secret mounts, an internal network with no route out, resource limits, a fixed web address for proxy trust, and a migrate-first upgrade with canary and automatic rollback (`upgrade.sh`). The 11-step smoke test runs on it.
2. The Helm chart has no production PostgreSQL or object store. On k3s the owner would also run and back up a database operator, an S3 store, cert-manager, an ingress controller and k3s itself. That is about 1 GB more RAM and many more parts that can fail, for an owner who does not run Kubernetes.
3. On one node, Kubernetes gives no high availability. Compose comes close to its rolling updates: migrations run while the old version serves, then services restart one by one behind Caddy retries.
4. Agents act only through `gh workflow run`. A short shell script over SSH is easier to debug from workflow logs than Helm hook failures.

Move to k3s or managed Kubernetes with the existing chart when a second node is needed.

### K.1 Rules for this track

R-01 to R-18 apply. Handoff notes go to `docs/platform/handoff/M2-Sxx.md`. The rules below are added.

| # | Rule |
|---|---|
| S-1 | No agent holds a production or staging secret, connects to those servers, or approves a protected GitHub environment. An agent may start `deploy-prod.yml`, `bootstrap-prod.yml` or `ops-cli.yml` with `gh workflow run` only when the owner asks. The run then waits for the owner's approval. |
| S-2 | Acceptance runs on the build host with throwaway keys made at test time (`deploy/scripts/saas-keys.sh --out <tmp>`) and deleted afterwards. Keys from `packages/pack-tools/dev-keys/` stay limited to demo-flavour images (R-11, R-13). |
| S-3 | The contract of this track (route ids, permissions, enum values, profile keys and the platform migration `0005_milestone2_saas.sql`) is written by M2-02 in wave 1a. SaaS packages follow R-14 like the core packages: they change schemas only in the area files they own and add no contract item. |
| S-4 | Every third-party action in a new workflow is pinned to a full commit SHA, with the tag in a comment. Secrets reach `run` steps only through `env`. `tools/scripts/check-workflows.mjs --saas` (M2-S01) enforces both. |
| S-5 | New container images are only those of K.4. Each is pinned to an exact version at least two weeks old plus its digest, and recorded in the handoff note. R-06 applies. |
| S-6 | SaaS packages share the four-agent limit of R-02 with the core packages and run in the combined wave table of G.1. Compose runs take the host lock (R-05) and use ports 18080 and 18443. |
| S-7 | The demo stack and demo images never run on the production or staging server. `saas-deploy.sh` refuses image names ending in `-demo` and the `demo.yaml` and `test.yaml` profiles. |

### K.2 What the owner provides

Agents cannot buy, sign, register or approve any of these items. Each item names the package or step that needs it first.

| Item | What exactly | Where it goes | Needed before |
|---|---|---|---|
| Production server | Ubuntu 24.04 LTS VPS. 4 vCPU or more, 16 GB RAM, 80 GB system disk, a separate block volume of 200 GB or more for Docker data. Public IPv4, plus IPv6 if offered. The provider's first root SSH key. Located as decided in K.3 (D-S2) | Secrets `BOOTSTRAP_SSH_KEY` (deleted after bootstrap), `DEPLOY_HOST` in environment `production` | First run of `bootstrap-prod.yml` |
| Staging server (recommended) | A smaller VPS (8 GB RAM, same OS) for release rehearsals and the penetration test. It is separate from the demo server | Same secret names in environment `staging` | First release rehearsal |
| Domain and DNS | A host name such as `app.<domain>`. A and AAAA records pointing to the VPS. A CAA record for `letsencrypt.org`. Optionally `ops.<domain>` for Grafana. DNS access to add records | Variable `MSCD_DOMAIN`, `ACME_EMAIL` | M2-S05 first deploy |
| Mail provider | An account with a transactional SMTP provider (for example Amazon SES, Mailgun, Brevo or Postmark) on port 587. SPF, DKIM and DMARC records for the sending domain | Variables `SMTP_HOST`, `SMTP_PORT`, `MAIL_FROM`; secrets `SMTP_USER`, `SMTP_PASSWORD` | First deploy (with `mail.required`, SaaS creates no organisation and no operator without mail, M2-06 and M2-S09) |
| Off-site backup storage | An S3-compatible bucket at a different provider or region, with versioning or object lock. One access key limited to that bucket, a second key limited to the secrets prefix, and a third read-only key for the restore test | `production` and `staging`: secrets `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY`, `BACKUP_S3_SECRET_KEY`, `BACKUP_SECRETS_ACCESS_KEY`, `BACKUP_SECRETS_SECRET_KEY`, `BACKUP_RESTIC_PASSWORD`. `restore-test`: `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, the read-only key as `BACKUP_S3_ACCESS_KEY` and `BACKUP_S3_SECRET_KEY`, and `BACKUP_RESTIC_PASSWORD` | M2-S07 first scheduled run |
| Monitoring accounts | A heartbeat service (for example healthchecks.io) with three check URLs: watchdog, backup and restore test. An external uptime check of `https://<domain>/healthz`. An alert email address. Optionally a Telegram bot token and chat id, and a hosted status page | Secrets `HEARTBEAT_WATCHDOG_URL`, `HEARTBEAT_BACKUP_URL`, `TELEGRAM_BOT_TOKEN`; variables `ALERT_EMAIL_TO`, `TELEGRAM_CHAT_ID`. `HEARTBEAT_RESTORE_URL` in environment `restore-test` | M2-S08 first deploy |
| GitHub settings | Environments `release`, `staging`, `production` and `restore-test`. The owner is required reviewer on `release` and `production`. `restore-test` is limited to the default branch. A tag protection rule for `v*.*.*`. GHCR packages kept private, with this repository granted Actions read access on the `mscd-server` and `mscd-web` packages, so the job `GITHUB_TOKEN` of `deploy-prod.yml` and `restore-test.yml` can pull them | Repository settings and package settings | M2-S01 first release |
| Release key set | Generated by the owner on the owner's own computer with `deploy/scripts/saas-keys.sh` (M2-S01): pack, licence and audit anchor Ed25519 pairs, the bundle signing key, and the two KEKs `platform.key` and `storage.key`. Offline copies go in a password manager, because GitHub secrets cannot be read back and losing a KEK makes every backup unreadable | `release`: `MSCD_PACK_SIGNING_KEY`, `MSCD_RELEASE_SIGNING_KEY`, variables `MSCD_TRUSTED_KEYS_LICENCE_PUB`, `MSCD_TRUSTED_KEYS_PACK_PUB`, `MSCD_TRUSTED_KEYS_ANCHOR_PUB`. `production` and `staging`: `PLATFORM_KEY`, `STORAGE_KEY`, `AUDIT_ANCHOR_KEY`. `restore-test`: copies of `PLATFORM_KEY` and `STORAGE_KEY` | M2-S01 first release |
| SSH access | After bootstrap, the deploy key and the pinned host key line that `bootstrap-host.sh` prints | `DEPLOY_USER`, `DEPLOY_SSH_KEY`, `DEPLOY_SSH_KNOWN_HOSTS`, variable `DEPLOY_SSH_PORT` per environment | M2-S05 first deploy |
| Legal documents | Drafted or reviewed by a lawyer qualified in Indonesian law: privacy notice (Indonesian and English); data processing agreement (DPA) with customers; terms of service (Indonesian and English, Law 24/2009); DPO decision; PSE Lingkup Privat registration through OSS; written position on data location and cross-border transfer (UU PDP Article 56); confirmation of the breach notice duties and the current authority. M2-S04 writes the facts the lawyer needs | Public URLs set as `legal.privacy_url` and `legal.terms_url` (variables `LEGAL_PRIVACY_URL`, `LEGAL_TERMS_URL`) | Go-live |
| Penetration test vendor | Booking (allow 2 to 3 weeks), a grey-box web and API test of the staging stack using the scope in `docs/saas/pentest-scope.md`, a report, a retest after fixes, and a short summary letter for customers | `docs/saas/go-live-checklist.md` evidence column | Go-live |
| Incident contacts | Named people for incident roles, a 24/7 phone number, the support email | `docs/saas/incident-response.md` | Go-live |
| Decisions | The decisions of K.3 | Answers recorded in the handoff notes | The package named in K.3 |

### K.3 Decisions for the owner

Each decision has a default that is built when no answer arrives in time.

| # | Decision | Default built | Needed by |
|---|---|---|---|
| D-S1 | Onboarding: the operator creates each organisation (sales-led), or customers sign up themselves | Sales-led. Self-service is in K.8 | M2-S09 |
| D-S2 | Hosting location for the server, backups and mail provider: in Indonesia or abroad. Some regulated customers (for example under OJK) may need data kept in Indonesia | Server in Indonesia; backup bucket at a second provider, also in Indonesia when available | Owner purchase |
| D-S3 | Public address | One host name `app.<domain>` for every organisation, with `?org=` and email discovery at sign-in | M2-S02 |
| D-S4 | Plans and their limits | Presets `trial` (30 days, 10 users, 1 system) and `standard` (50 users, 3 systems, 12 months), editable in `saas.yaml` | M2-S10 |
| D-S5 | Read-only period after a contract ends | 30 days in `offboarding`, then `archived` | M2-S09, DPA |
| D-S6 | Backup retention and recovery point | 14 daily, 8 weekly, 12 monthly; recovery point 24 hours | M2-S07, DPA |
| D-S7 | Uptime target and maintenance window | 99.5 percent monthly, announced maintenance excluded; window Sunday 22:00 to 24:00 WIB | M2-S04 |
| D-S8 | CDN or web application firewall in front of the VPS | None at start; reviewed after the penetration test | M2-S02 |
| D-S9 | Operational telemetry export in SaaS | Off until a collector exists | none |
| D-S10 | May strangers find out which organisations are customers through the sign-in page | No: the same answer for unknown slugs and domains | M2-S11 |
| D-S11 | Key management | File KEKs on the server with offline copies (deviation X-03); cloud KMS in K.8 | M2-S05 |
| D-S12 | KEK copies in environment `restore-test` so the weekly restore test can open backups | Yes, environment limited to the default branch | M2-S07 |

### K.4 Container images added by this track

| Use | Image | Used by |
|---|---|---|
| TLS front and certificate renewal | `caddy` (Caddy 2) | M2-S02 |
| Metrics, alerts, probes | `prom/prometheus`, `prom/alertmanager`, `prom/node-exporter`, `prometheuscommunity/postgres-exporter`, `prom/blackbox-exporter` | M2-S08 |
| Dashboards (optional profile `grafana`) | `grafana/grafana` (the open source edition; `grafana-oss` is no longer published separately, M2-S08 deviation 1) | M2-S08 |
| Local registry for deploy rehearsals (tests only) | `registry` (Distribution 2 or 3) | M2-S05 |
| Bootstrap dry run (tests only) | `ubuntu` 24.04, pinned to an exact dated tag (`ubuntu:noble-<yyyymmdd>`) at least two weeks old plus its digest, stored in `deploy/host/test/ubuntu-image` (S-5) | M2-S03 |
| Backup tools | Built from `postgres:16.15-alpine` with `restic` and `rclone` from Alpine packages (`deploy/docker/backup.Dockerfile`) | M2-S07 |
| Image and config scanning | `aquasec/trivy:0.74.0` (already in CI) | M2-S01 |
| Dependency scanning in CI (OSV) | `ghcr.io/google/osv-scanner-action:v2.7.0`, pinned by digest in `security-scan.yml` (CI only, never in a stack) | M2-S01 |

### K.5 Waves and common acceptance

The SaaS packages run in the combined wave table of G.1: M2-S01 and M2-S04 in wave 1a; M2-S02 and M2-S03 in 1b; M2-S10, M2-S05, M2-S07 and M2-S08 in 2b; M2-S09 in 3a; M2-S11 in 3b; M2-S12 in 3c; M2-S13 in wave 6. M2-S06 is merged into M2-02 (K.6). G.1 also names the owner per wave of every file that both tracks touch.

Common acceptance for every SaaS package (not repeated below):
- the common acceptance of G.1;
- `node tools/scripts/check-workflows.mjs --saas` passes once M2-S01 is done;
- every new shell script passes `bash -n`.

### K.6 Work package details

#### M2-S01 Release images, signing and supply chain

| | |
|---|---|
| Wave, depends on | 1a; Milestone 1 |
| Owns | `.github/workflows/release.yml`, `.github/workflows/security-scan.yml`, `.github/dependabot.yml`, `deploy/scripts/build-release-images.sh`, `deploy/scripts/build-bundle.sh` (new `--images-only` mode), `deploy/scripts/saas-keys.sh`, `tools/scripts/check-workflows.mjs`, `docs/saas/release.md`, `docs/platform/handoff/M2-S01.md` |

Brief:
- `build-bundle.sh --images-only`: stops after the image build, the release artefact check and the Trivy gate, and writes no bundle. The bundle path is unchanged.
- `build-release-images.sh`: takes `--version x.y.z[-rc.n]`, `--revision`, `--trusted-keys-dir`, `--pack-signing-key`, `--build-ca`, `--registry <host/owner>`, optional `--server-image` and `--web-image` (full names; default `<registry>/mscd-server` and `<registry>/mscd-web`), `--load` or `--push` and `--digest-file <json>`.
  - It calls `build-bundle.sh --images-only --release`, which builds web with `VITE_DATA_SOURCE=api` and server `--target release`.
  - On loaded images it runs `check-release-artefacts.sh` and the Trivy gate (HIGH or CRITICAL with a fix fails) before any push.
  - It pushes `mscd-server:<version>` and `mscd-web:<version>` with `--provenance=mode=max --sbom=true` and writes both digests.
  - It refuses names ending in `-demo` (also when set with `--server-image` or `--web-image`) with the message "demo images are refused" before any build, and versions that do not match the pattern.
- `release.yml`:
  - Triggers: tags `v*.*.*` and `workflow_dispatch` with a tag input. Environment `release`. Permissions `contents: write`, `packages: write`, `id-token: write`, `attestations: write`.
  - Writes the trusted-keys folder from the three `MSCD_TRUSTED_KEYS_*_PUB` variables, and the pack key from `MSCD_PACK_SIGNING_KEY` to `$RUNNER_TEMP` with mode 0600.
  - Builds and pushes with `build-release-images.sh --push --registry ghcr.io/mqusaeri`, then signs each digest with keyless cosign and attaches the SBOM and provenance as attestations.
  - Creates the GitHub Release with `digests.json` as an asset and the digests in the notes.
  - An optional job (input `bundle`, default false) builds the signed on-premise bundle with `MSCD_RELEASE_SIGNING_KEY`.
- `saas-keys.sh`: the owner runs it on the owner's own computer.
  - It refuses an output folder inside a git work tree.
  - It makes the pack and licence pairs with `mscd-pack keygen`, and the KEKs, gateway token and anchor pair with `mscd-server keys generate`. It also makes the bundle signing key, and names the public files the way the trusted-keys build context expects.
  - It rejects any key id in `dev-key-ids.json`.
  - It prints the `gh secret set --env <name> < file` and `gh variable set` commands for K.2. Private values are never printed.
  - It ends with a reminder to store offline copies.
  - `--print-only` prints the commands without the reminder prompt, for tests.
- `security-scan.yml`, on push, pull request and nightly:
  - CodeQL for JavaScript and TypeScript;
  - gitleaks secret scanning;
  - OSV scan of `package-lock.json`;
  - Trivy config scan of `deploy/`;
  - a nightly Trivy scan of the image digests in the latest GitHub Release's `digests.json`, so the deployed images are scanned again.
- `dependabot.yml`: weekly grouped updates for npm, GitHub Actions and the Dockerfiles in `deploy/docker`.
- `check-workflows.mjs` uses the `yaml` package already in the lockfile. It checks four things:
  - top-level `permissions` is set;
  - third-party `uses:` are pinned to a 40-character SHA;
  - no `${{ secrets.` appears inside `run:` text;
  - jobs with environment `production` or `staging` have a `concurrency` group with `cancel-in-progress: false`.

  `--saas` checks the SaaS workflows that exist. `--require-all` also fails when one of `release.yml`, `security-scan.yml`, `bootstrap-prod.yml`, `deploy-prod.yml`, `restore-test.yml` and `ops-cli.yml` is missing.
- `docs/saas/release.md`: how to cut a release, what each check means, and how to verify an image with `cosign verify` locally.

Acceptance:

```bash
bash -n deploy/scripts/build-release-images.sh deploy/scripts/saas-keys.sh deploy/scripts/build-bundle.sh
node tools/scripts/check-workflows.mjs .github/workflows/release.yml .github/workflows/security-scan.yml
K=$(mktemp -d) && bash deploy/scripts/saas-keys.sh --out "$K/keys" --print-only | grep -q 'gh secret set --env production PLATFORM_KEY'
! bash deploy/scripts/saas-keys.sh --out "$PWD/tmp-keys" --print-only && test ! -e "$PWD/tmp-keys"
bash deploy/scripts/build-release-images.sh --version 1.1.0-rc.1 --trusted-keys-dir "$K/keys/trusted" --pack-signing-key "$K/keys/pack-signing.key" --build-ca "$MSCD_BUILD_CA" --registry localhost/mqusaeri --load --digest-file "$K/digests.json"
node -e "const d=require(process.argv[1]);if(!/^sha256:/.test(d.server)||!/^sha256:/.test(d.web))process.exit(1)" "$K/digests.json"
bash deploy/scripts/build-release-images.sh --version 1.1.0 --revision "$(git rev-parse HEAD)" --build-ca "$MSCD_BUILD_CA" --registry localhost/mqusaeri --server-image localhost/mqusaeri/mscd-server-demo --load --trusted-keys-dir "$K/keys/trusted" --pack-signing-key "$K/keys/pack-signing.key" 2>&1 | grep -q 'demo images are refused'
bash deploy/scripts/build-bundle.sh --help | grep -q images-only
rm -rf "$K"
```

#### M2-S02 SaaS Compose stack and TLS

| | |
|---|---|
| Wave, depends on | 1b; M2-S01 (its test script uses `build-release-images.sh`), M2-02 (the new keys in `saas.yaml`) |
| Owns | `deploy/compose/docker-compose.saas.yml`, `deploy/compose/.env.saas.example`, `deploy/compose/config/caddy/**`, `deploy/nginx/**`, `apps/server/profiles/saas.yaml`, `deploy/scripts/test/saas-stack.sh`, `docs/saas/stack.md`, `docs/platform/handoff/M2-S02.md` |

Brief:
- `docker-compose.saas.yml`:
  - **Server services:** `migrate`, `storage-gateway`, `api`, `worker` and `cli` use `${MSCD_SERVER_IMAGE}@${MSCD_SERVER_DIGEST}` with `pull_policy: missing`, one entry per service. `web` uses `${MSCD_IMAGE}@${MSCD_WEB_DIGEST}`.
  - **web:** `ports: !override []`, `volumes: !reset []`, `MSCD_HTTP_REDIRECT=false`, `MSCD_TRUSTED_PROXY_CIDRS=<caddy address>/32`, and a fixed address on a fixed-subnet `edge` network inside `172.31.0.0/16`, the range that the Docker address pools of M2-S03 leave free.
  - **caddy:** pinned by digest; ports 80/tcp, 443/tcp and 443/udp; volumes `caddy_data` and `caddy_config`; `read_only`, `cap_drop: [ALL]`, `cap_add: [NET_BIND_SERVICE]`.
  - **postgres:** tuning flags sized to its 4G container limit (`shared_buffers=1GB`, `effective_cache_size=3GB`, `work_mem=16MB`, `maintenance_work_mem=512MB`, `wal_compression=on`, `log_min_duration_statement=500ms`) and `shm_size: 1g`.
  - **Limits:** memory limits from `.env` (PostgreSQL 4G, SeaweedFS 2G, api 2G, worker 2G, gateway 1G, web and Caddy 512M).
  - **Logging:** driver `local` with `max-size: 20m` and `max-file: 10`.
  - **Profiles:** `COMPOSE_PROFILES=bundled-db,bundled-s3`; pg-boss stays and Valkey stays off.
- `.env.saas.example` contains:
  - `MSCD_PROFILE_FILE=/app/apps/server/profiles/saas.yaml`, `MSCD_DOMAIN`, `MSCD_PUBLIC_URL`;
  - `MSCD_SMTP_*` for port 587 with STARTTLS;
  - the image names `ghcr.io/mqusaeri/mscd-server` and `ghcr.io/mqusaeri/mscd-web` and the digest variables;
  - `ACME_EMAIL` and `ACME_CA` (Let's Encrypt staging by default for a first run);
  - `MSCD_TLS_MODE` (`acme` or `internal` for tests) and the memory limits.

  It has no `MSCD_ORG_*` lines. The deploy script writes the real file, so the owner never edits it on the server.
- `config/caddy/Caddyfile`:
  - **Certificates:** ACME HTTP-01 with `{$ACME_EMAIL}` and `{$ACME_CA}`, or `tls internal` when `MSCD_TLS_MODE=internal`. HTTP redirects to HTTPS with 308.
  - **Headers:** `Strict-Transport-Security: max-age=31536000; includeSubDomains`, without preload. Caddy replaces any client `X-Forwarded-For` with the client address.
  - **Upstream:** `reverse_proxy web:8080` with `lb_try_duration 30s` and a health check on `/healthz`. A request body limit matches `max_upload_bytes` plus 1 MB.
  - **Logs:** JSON access logs with the query string removed.
  - **Extensions:** `import /etc/caddy/conf.d/*.caddy` for the optional ops host of M2-S08.
- `deploy/nginx`:
  - `limit_req` per client address for `/api/v1/auth/` (10 per second, burst 20) and for `/api/` (50 per second, burst 100), plus `limit_conn` 50 per address.
  - Values come from `MSCD_RATE_*` variables in `40-mscd-runtime.sh`, and `MSCD_RATE_LIMITS=false` turns them off.
  - The limits answer 429 with the problem headers.
  - The defaults are generous so an office behind one carrier NAT address is not locked out.
  - The on-premise defaults stay unchanged.
- `saas.yaml`: SMTP port 587. Comments say that Compose sets `trust_proxy` and the public URL through environment variables. The keys that M2-02 added in wave 1a stay as they are. The anchor key file stays at `/run/secrets/audit-anchor.key`.
- `saas-stack.sh up|check|down`: the local test stack, project `mscd-saas-test`, ports 18080 and 18443.
  - **up:** makes throwaway keys with `saas-keys.sh` and builds release images with them. It writes `.env` from the example with `MSCD_TLS_MODE=internal` and `MSCD_DOMAIN=localhost`, adds Mailpit for mail, starts the stack, runs migrate, and copies Caddy's local root certificate to `/tmp/mscd-saas-test/caddy-root.crt`.
  - **check:** asserts five things:
    - tenancy mode `multi` through the `cli` service;
    - only Caddy publishes ports;
    - HSTS is present;
    - the rate limit answers 429;
    - after running the audit anchor job, the worker log has no line "not among the anchor keys compiled into this build".

    The last assertion proves that the deployed anchor key matches the compiled key.
  - **down:** removes everything, volumes included.

Acceptance:

```bash
C="docker compose -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.saas.yml --env-file deploy/compose/.env.saas.example"
$C config -q
$C config --format json | node -e "const c=JSON.parse(require('fs').readFileSync(0));const p=Object.entries(c.services).filter(([,s])=>(s.ports||[]).length).map(([n])=>n);if(p.join()!=='caddy')process.exit(1)"
bash -n deploy/scripts/test/saas-stack.sh
flock /tmp/mscd-stack.lock bash -c 'bash deploy/scripts/test/saas-stack.sh up && bash deploy/scripts/test/saas-stack.sh check; s=$?; bash deploy/scripts/test/saas-stack.sh down; exit $s'
flock /tmp/mscd-stack.lock npm run test:smoke
```

The `check` step also runs `curl --cacert /tmp/mscd-saas-test/caddy-root.crt https://localhost:18443/healthz` and checks that `http://localhost:18080/` answers 308. The last line proves the on-premise stack still works with the NGINX changes.

Orchestrator decision (M2-S02): a host that cannot reach the Alpine mirrors (`dl-cdn.alpinelinux.org`) runs the fourth line with `MSCD_SAAS_TEST_SCAN=auto`, because the web base image keeps known findings that only `apk upgrade` removes. The line runs unchanged, with the scan gate, in the `saas-smoke` job of M2-S13 on GitHub Actions.

#### M2-S03 Server bootstrap

| | |
|---|---|
| Wave, depends on | 1b; M2-S01 (its acceptance runs `tools/scripts/check-workflows.mjs`) |
| Owns | `deploy/scripts/bootstrap-host.sh`, `deploy/host/{ssh,docker,firewall,system,test}/**`, `.github/workflows/bootstrap-prod.yml`, `docs/saas/bootstrap.md`, `docs/platform/handoff/M2-S03.md` |

Brief:
- `bootstrap-host.sh` runs as root and is safe to run again. Each step reports `done`, `changed` or `skipped`.
  - **Packages and Docker:** `apt-get upgrade`; `unattended-upgrades` for security updates, with a reboot-needed marker for M2-S08; Docker CE and the Compose plugin from the `download.docker.com` apt repository.
  - **Docker daemon:** `/etc/docker/daemon.json` sets `live-restore: true`, `log-driver: local`, and `default-address-pools` outside `172.31.0.0/16`, which holds the fixed `mscd` subnet `172.31.250.0/24` and the `edge` subnet of M2-S02 (same wave).
  - **Accounts:** a `deploy` user with SSH key only, in the docker group; one admin user with sudo for the owner; the `mscd` system account.
  - **SSH:** `sshd_config.d/10-mscd.conf` sets `PasswordAuthentication no`, `PermitRootLogin no` and `AllowUsers deploy <admin>`.
  - **Firewall:** ufw denies incoming by default and allows `limit 22/tcp`, 80/tcp, 443/tcp and 443/udp. fail2ban covers sshd.
  - **System:** UTC and chrony; a 4 GB swap file with swappiness 10; journald `SystemMaxUse=1G`.
  - **Data volume:** an optional `--data-device <dev>` is mounted at `/var/lib/docker`. It is formatted only with `--format-data-device`, and only when the device is empty.
  - **Folders:** `/opt/mscd/{releases,state,logs,secrets,backup,metrics}` with fixed owners and modes.
  - **Output:** the host key fingerprints and the `known_hosts` line for `DEPLOY_SSH_KNOWN_HOSTS`.
- Test modes:
  - `--render-only --root <dir>` writes every config file under `<dir>` and changes nothing else.
  - `--dry-run` prints each command it would run.
  - `--check` reports what differs from the target state and exits 1 when anything does.
- `deploy/host/test/ubuntu-image` holds the pinned image reference of K.4 (`ubuntu:noble-<yyyymmdd>@sha256:<digest>`), also recorded in the handoff note.
- Docker-published ports bypass ufw. `docs/saas/bootstrap.md` explains this and why only Caddy publishes.
- `bootstrap-prod.yml`, dispatched by hand:
  - **Inputs:** `target` (`staging` or `production`), the admin user name, and `host_key_fingerprint`. The owner copies the fingerprint from the provider console.
  - **Host check:** the workflow compares the ssh-keyscan result with that fingerprint and stops on a difference.
  - **Run:** it connects as root with `BOOTSTRAP_SSH_KEY`, copies the script and runs it.
  - **Output:** a job summary asking the owner to delete `BOOTSTRAP_SSH_KEY` and set `DEPLOY_SSH_KNOWN_HOSTS` and `DEPLOY_SSH_KEY`.
- `docs/saas/bootstrap.md`: the provider steps, the block volume, the DNS records, the bootstrap run, and the later option of closing port 22 with the Tailscale GitHub Action (GitHub runner addresses change, so port 22 stays open at first).

Acceptance:

```bash
bash -n deploy/scripts/bootstrap-host.sh
node tools/scripts/check-workflows.mjs .github/workflows/bootstrap-prod.yml
R=$(mktemp -d) && bash deploy/scripts/bootstrap-host.sh --render-only --root "$R" --admin-user owner --deploy-key-file deploy/host/test/deploy.pub
grep -qx 'PasswordAuthentication no' "$R/etc/ssh/sshd_config.d/10-mscd.conf" && grep -qx 'PermitRootLogin no' "$R/etc/ssh/sshd_config.d/10-mscd.conf"
node -e "const d=JSON.parse(require('fs').readFileSync(process.argv[1]));if(d['live-restore']!==true||d['log-driver']!=='local')process.exit(1)" "$R/etc/docker/daemon.json"
grep -q 'SystemMaxUse=1G' "$R/etc/systemd/journald.conf.d/10-mscd.conf"
docker run --rm -v "$PWD/deploy:/deploy:ro" "$(cat deploy/host/test/ubuntu-image)" bash /deploy/scripts/bootstrap-host.sh --dry-run --admin-user owner --deploy-key-file /deploy/host/test/deploy.pub | grep -q 'ufw limit 22/tcp'
rm -rf "$R"
```

#### M2-S04 Go-live checklist and owner pack

| | |
|---|---|
| Wave, depends on | 1a; none |
| Owns | `docs/saas/README.md`, `docs/saas/go-live-checklist.md`, `docs/saas/owner-inputs.md`, `docs/saas/legal-inputs.md`, `docs/saas/records-of-processing.md`, `docs/saas/incident-response.md`, `docs/saas/pentest-scope.md`, `tools/scripts/check-golive.mjs`, `docs/platform/handoff/M2-S04.md` |

Brief:
- The pack is written early so the owner can start the legal work and book the penetration test while agents build. Booking alone can take weeks.
- `go-live-checklist.md` is one table per area. Every row has these columns: id `GL-nn`, item, why it matters in plain words, who (`agent` or `owner`), evidence (a command, CI job or document), and status (`open`, `done` or `n/a`). Rows include at least the items below.
  - **Security:**
    - HSTS on, and certificates renewed by Caddy;
    - NGINX rate limits on;
    - tenant isolation proven under tenancy `multi` (M2-S13);
    - MFA required;
    - mail working, with invitation links never shown in SaaS;
    - release keys made outside the repository, and development keys rejected;
    - images signed and verified at deploy;
    - Trivy, CodeQL, gitleaks and OSV clean;
    - deploys only through the approved workflow;
    - named SSH accounts only, and root login off;
    - operator accounts with TOTP, and the break-glass decision recorded;
    - audit chain and anchors verified;
    - KEK offline copies confirmed by the owner;
    - demo stack absent from the production server;
    - penetration test done, findings fixed and retested.
  - **Operations:**
    - off-site backups running;
    - a restore test passed in the last 8 days, with the measured restore time written down;
    - a test alert received;
    - external heartbeat and uptime check active;
    - status page published;
    - uptime target and support hours published.
  - **Indonesian personal data protection (UU PDP, Law 27 of 2022):**
    - privacy notice published in Indonesian and English and linked from the sign-in page;
    - DPA ready, stating that the customer is the controller and MSCD the processor, with breach notice to the customer within 24 hours;
    - records of processing complete;
    - DPO decision recorded (Article 53);
    - breach procedure meeting the 3 x 24 hour notice of Article 46, with templates and one exercise run;
    - data location and cross-border position written (Article 56);
    - PSE Lingkup Privat registration done (PP 71/2019);
    - retention periods written for logs, backups and offboarding;
    - a manual procedure for requests from data subjects until a feature exists (K.8);
    - subprocessor list published;
    - only essential cookies used.
  - **Legal documents the owner provides:** privacy notice, DPA, terms of service in Indonesian and English (Law 24/2009), DPO appointment or decision, PSE registration proof, lawyer's note on cross-border transfer, and the penetration test summary letter.
  - **Sign-off:** the owner's name and date.
- `owner-inputs.md`: K.2 and K.3 as a checklist with the exact secret and variable names and the command that sets each one.
- `legal-inputs.md`: the facts a lawyer needs, taken from the code and BP F.11 and F.12. It covers:
  - the data categories per activity, their purposes and the people involved;
  - the cookies (session, guest and binding);
  - recipients and subprocessors (VPS host, mail provider, backup provider, heartbeat service);
  - data locations and retention;
  - the security measures, as a ready annex for the DPA;
  - what happens at offboarding (D-S5) and what is not built yet (K.8).

  It is headed "Facts for the lawyer. Not legal advice."
- `records-of-processing.md`: one record per activity (account and sign-in data, customer compliance content, evidence files, notification emails, logs and backups, support access), with purpose, data, people, recipients, location, retention and safeguards. It is marked as a draft for review by a lawyer qualified in Indonesian law.
- `incident-response.md`: roles, severity levels, the 24/7 contact placeholder, and how to find affected organisations and people with the audit log and access logs. It includes notice templates in Indonesian and English for customers and, where the controller asks for help, for the authority and the people affected. It also has an incident log template and an exercise script. It is marked as a draft for legal review.
- `pentest-scope.md`: the staging target, test accounts per role in two organisations, and the areas in scope: moving between tenants, sign-in with MFA and SSO, file upload and download, the storage gateway, operator routes, and the VPS and network. It also lists what is out of scope and the rules of engagement.
- `check-golive.mjs` parses the checklist tables.
  - Default mode: fails when a row lacks an id, who, evidence or a valid status, or when a link to a repository file is broken.
  - `--agent-items-done`: also fails on any open `agent` row.
  - `--require-done`: fails on any open row. It is used on the go-live day.

Acceptance:

```bash
npm run check:text
node tools/scripts/check-golive.mjs docs/saas/go-live-checklist.md
! node tools/scripts/check-golive.mjs --require-done docs/saas/go-live-checklist.md
test "$(grep -c '^| GL-' docs/saas/go-live-checklist.md)" -ge 40
grep -q '3 x 24' docs/saas/incident-response.md && grep -q 'Article 46' docs/saas/go-live-checklist.md
grep -q 'PLATFORM_KEY' docs/saas/owner-inputs.md && grep -q 'BACKUP_RESTIC_PASSWORD' docs/saas/owner-inputs.md
```

#### M2-S05 Deploy script and deploy workflow

| | |
|---|---|
| Wave, depends on | 2b; M2-S01, M2-S02, M2-S03 |
| Owns | `deploy/scripts/saas-deploy.sh`, `deploy/scripts/lib/saas.sh`, `deploy/scripts/test/saas-rehearsal.sh`, `.github/workflows/deploy-prod.yml`, `docs/saas/deploy.md`, `docs/platform/handoff/M2-S05.md` |

Brief:
- `saas-deploy.sh` sources `lib/common.sh` and the new `lib/saas.sh`. `common.sh` is unchanged, so `install.sh` and `upgrade.sh` behave as before. Actions are `deploy`, `rollback` and `check-only`. The steps are:
  1. Lock, then check Docker, disk and memory.
  2. Refuse demo images, demo or test profiles, any `MSCD_DEMO` value, and a release folder that holds `config/demo-secrets` or `docker-compose.demo.yml` (S-7). These checks run before any other check, also in `check-only`, with the messages "demo images are refused", "demo and test profiles are refused" and "demo files are refused".
  3. Write `.env` from `.env.saas.example` and the given values (`env_set`), including `MSCD_SMTP_HOST`, `MSCD_SMTP_PORT`, `MSCD_SMTP_USER` and `MSCD_MAIL_FROM`.
  4. Read `PLATFORM_KEY`, `STORAGE_KEY`, `AUDIT_ANCHOR_KEY` and `SMTP_PASSWORD` from stdin, before any other secret is written. `lib/saas.sh` writes `platform.key`, `storage.key` and `audit-anchor.key` when missing, and derives `audit-anchor.pub` from the private key in the format that `ensure_anchor_key` writes. When a file exists, it must equal the stdin value. On a mismatch the script stops and never overwrites.
  5. Write the generated secrets only when missing, by calling `ensure_database_secrets`, `ensure_key_secrets` (which keeps the key files of step 4 and adds the gateway token and S3 identity), `ensure_certificates` and `fix_secret_owners` one by one. Then write `smtp.password` from stdin with `set_smtp_password`. The script never calls `ensure_secrets` or `ensure_anchor_key`: both would write a random KEK or a new anchor key pair, which the compiled trust anchors do not include, before the real keys are in place.
  6. Pull both images by digest while the old containers keep running, then start the new server image with `--help` once.
  7. Take a pre-deploy `pg_dump --format=custom` to `/opt/mscd/backup/pre-deploy` (last 3 kept). When `deploy/backup/backup.sh` exists (M2-S07), also send an off-site copy.
  8. Run migrate alone (`compose run --rm --no-deps migrate`). The timeout grows with the number of `org_` schemas, and the log is written to `/opt/mscd/logs` and printed back.
  9. Restart with `--no-deps --wait` in order: storage-gateway, api, worker, web, caddy.
  10. Verify through Caddy: `/healthz`, `/readyz` and the version in `/api/v1/system/profile`.
  11. Record the current and previous digests in `/opt/mscd/state`, and keep the images of the last 3 releases.

  It uses every overlay that exists: `docker-compose.saas.yml`, plus `docker-compose.backup.yml` and `docker-compose.ops.yml` when present.
- A failed migrate or health check restores the saved `.env` and starts the previous digests (the `upgrade.sh` logic of `save_backup` and `restore_backup`, with registry pulls in place of `load_bundle_images`). There is no down migration. Restoring the database is a documented manual step, needed only for a broken contract migration.
- `deploy-prod.yml`, on `workflow_dispatch`:
  - **Inputs:** `version` (tag), `action` (`deploy` or `rollback`), `target` (`staging` or `production`), `skip_backup` (default false).
  - **Run settings:** environment `${{ inputs.target }}`, concurrency group `deploy-${{ inputs.target }}` with `cancel-in-progress: false`, permissions `contents: read` and `packages: read`.
  - **Steps:**
    1. Check out the tag.
    2. Read the digests from the release's `digests.json`, then `cosign verify` each digest with `--certificate-identity https://github.com/mqusaeri/mscd/.github/workflows/release.yml@refs/tags/<tag>` and the GitHub OIDC issuer.
    3. Rsync to `/opt/mscd/releases/<version>`, with the host key from `DEPLOY_SSH_KNOWN_HOSTS`, only the files the server needs: from `deploy/compose` the files `docker-compose.yml`, `docker-compose.saas.yml`, `docker-compose.backup.yml` and `docker-compose.ops.yml` (when present), `.env.saas.example`, and the folders `config/postgres` and `config/caddy`; plus `deploy/scripts`, and `deploy/backup` and `deploy/ops` when present. The rsync also passes `--exclude config/demo-secrets --exclude docker-compose.demo.yml --exclude dev` as a second guard, as `build-bundle.sh` and `install_config` do.
    4. Over SSH: `docker login ghcr.io --password-stdin` with the job's `GITHUB_TOKEN`, which expires with the job; `saas-deploy.sh` with secret values on stdin (`PLATFORM_KEY`, `STORAGE_KEY`, `AUDIT_ANCHOR_KEY`, `SMTP_PASSWORD`) and never as arguments, and the mail variables of K.2 as values; `docker logout`.
    5. From the runner, check `https://<domain>/healthz` and the reported version.
  - **Cleanup:** the runner always removes the key.
- `deploy-prod.yml` also writes the backup and monitoring secrets and variables of K.2 (`BACKUP_*`, `HEARTBEAT_*`, `TELEGRAM_BOT_TOKEN`, `ALERT_EMAIL_TO`, `TELEGRAM_CHAT_ID`) as one file per name under `/opt/mscd/secrets/backup/` and `/opt/mscd/secrets/ops/` (mode 0400, sent on stdin). M2-S07 and M2-S08 read them there, so they need no change to this workflow in the same wave, and `.env.saas.example` keeps one owner (M2-S02).
- `saas-rehearsal.sh` proves deploy, upgrade, automatic rollback and manual rollback on the build host.
  - It starts a local registry on `127.0.0.1:5000`. It builds and pushes two versions with throwaway keys, and makes a broken third version by tagging the web image as the server image so migrate fails.
  - It runs `saas-deploy.sh` against `/tmp/mscd-rehearsal` four times: deploy rc.1, upgrade to rc.2, try rc.3 and expect the automatic restore to rc.2, then `rollback` to rc.1.
  - After the first deploy it checks that `platform.key`, `storage.key` and `audit-anchor.key` equal the stdin values, that `audit-anchor.pub` matches the private key, and that the worker log has no line "not among the anchor keys compiled into this build" after the audit anchor job.
  - It checks that the `cli` service sends a test mail to a Mailpit container with the `MSCD_SMTP_*` values and `smtp.password`.
  - It checks that `saas-deploy.sh` refuses a release folder that holds `config/demo-secrets`.
  - The flag `--no-verify-signature` skips cosign. It is accepted only for a `127.0.0.1` registry.
- `docs/saas/deploy.md`:
  - how an agent starts a run (`gh workflow run deploy-prod.yml -f version=v1.1.0 -f target=staging`) and how the owner approves it;
  - the release rehearsal order: staging first, then the restore-test migration rehearsal (M2-S07), then production;
  - rollback;
  - what users see during a deploy: slow requests for up to 20 seconds, and retried POSTs are safe because of idempotency keys.
- Orchestrator note (wave 2b): deviations 1 to 5, 9 and 11 to 15 of `docs/platform/handoff/M2-S05.md` are accepted and take precedence over this brief where they differ, for example `set_smtp_password` runs before `fix_secret_owners` so the server user can read `smtp.password`.

Acceptance:

```bash
bash -n deploy/scripts/saas-deploy.sh deploy/scripts/lib/saas.sh deploy/scripts/test/saas-rehearsal.sh
node tools/scripts/check-workflows.mjs .github/workflows/deploy-prod.yml
node -e "const y=require('yaml');const w=y.parse(require('fs').readFileSync('.github/workflows/deploy-prod.yml','utf8'));const j=Object.values(w.jobs)[0];if(!String(j.environment).includes('inputs.target'))process.exit(1)"
flock /tmp/mscd-stack.lock bash deploy/scripts/test/saas-rehearsal.sh
D=$(mktemp -d) && cp deploy/compose/.env.saas.example "$D/.env"
MSCD_SERVER_IMAGE=ghcr.io/mqusaeri/mscd-server-demo bash deploy/scripts/saas-deploy.sh check-only --install-dir "$D" 2>&1 | grep -q 'demo images are refused'
MSCD_PROFILE_FILE=/app/apps/server/profiles/demo.yaml bash deploy/scripts/saas-deploy.sh check-only --install-dir "$D" 2>&1 | grep -q 'demo and test profiles are refused'
rm -rf "$D"
flock /tmp/mscd-stack.lock npm run test:smoke
```

#### M2-S06 Merged into M2-02

This is no longer a separate package. Its contract work is part of M2-02 in wave 1a, so R-14 holds for both tracks: the ten SaaS routes with stubs, pending files and sweep files (D.1, J.1), the schema changes of `ops.organizations.create`, `ops.organizations.list`, `system.profile` and `auth.providers` (D.2), the permission `ops.entitlements.manage`, the enum values, the organisation status machine, the platform migration `0005_milestone2_saas.sql` and the profile keys (D.3, J). Profile values that are not contract stay with the package that uses them: the mail settings of `saas.yaml` with M2-S02 and the `license.plans` presets with M2-S10. The id M2-S06 is not reused.

#### M2-S07 Backups and restore test

| | |
|---|---|
| Wave, depends on | 2b; M2-S02, M2-06, M2-02 (the `backup` command stub) |
| Owns | `deploy/docker/backup.Dockerfile`, `deploy/compose/docker-compose.backup.yml`, `deploy/backup/**`, `deploy/host/systemd/mscd-backup.{service,timer}`, `.github/workflows/restore-test.yml`, `apps/server/src/cli/backup.ts` (fills the stub that M2-02 registered in `program.ts`), `apps/server/test/int/backup/**`, `docs/saas/backup-restore.md`, `docs/platform/handoff/M2-S07.md` |

Brief:
- `backup.Dockerfile`: `postgres:16.15-alpine` plus `restic` and `rclone`. It runs as non-root and mounts the build CA as in R-12.
- The `backup` service runs on demand only (profile `backup`) on two networks: `mscd` for the database and `objectstore`, and `egress` for the off-site bucket, because `mscd` is `internal: true` and has no route out. A systemd timer on the host runs `deploy/backup/backup.sh` at 02:00 UTC. Each run has three parts, with no downtime:
  1. `pg_dump --format=custom` of database `mscd`, all `org_` schemas included, into a restic repository on the off-site bucket.
  2. `rclone sync` of bucket `mscd-vault` from `objectstore:8333` to the off-site bucket while the stack runs. Vault objects are already sealed by the gateway.
  3. A restic-encrypted copy of `/opt/mscd/secrets`, `.env` and `/opt/mscd/state` under a separate prefix with the separate credentials, plus the last 25 hours of worker `audit.anchor` log lines.
- Retention: `restic forget` 14 daily, 8 weekly, 12 monthly (D-S6). Each success pings `HEARTBEAT_BACKUP_URL` and writes `mscd_backup_last_success_timestamp_seconds` to `/opt/mscd/metrics/backup.prom` for the node-exporter of M2-S08.
- The backup secrets of K.2 reach the server as files under `/opt/mscd/secrets/backup/`, written by `deploy-prod.yml` (M2-S05). This package reads them there and edits neither that workflow nor `.env.saas.example`.
- `restore.sh`: a documented full restore onto a new server bootstrapped with M2-S03. It covers secrets, database, vault, start and checks.
- `mscd-server backup verify [--sample <n>] [--write-probe]`, in `cli/backup.ts`:
  - checks the database and gateway;
  - unwraps each tenant data key with `platform.key`;
  - opens n vault objects per organisation through the gateway;
  - checks that the head of the audit chain matches the newest signed anchor;
  - prints a JSON summary and exits 1 on any failure.

  `--write-probe` writes small probe objects. It is refused unless `MSCD_SAAS_TEST=1`.
- `restore-test.yml`, weekly and on dispatch with an optional `target_version`:
  - environment `restore-test` (D-S12) on a GitHub runner, so the production server carries no load;
  - restores the latest dump and a sample of vault objects into scratch containers;
  - runs migrate of `target_version` (default: the current release) against the restored dump as the migration rehearsal;
  - starts storage-gateway and api, checks `/readyz`, and runs `backup verify` and SQL checks (organisation count; newest `audit_log` entry under 26 hours old);
  - writes the measured restore time to the job summary as the restore time objective;
  - pings `HEARTBEAT_RESTORE_URL`.
- `restore-test.sh --local`: the same test against the M2-S02 test stack, end to end. It creates two organisations with `tenant create`, writes probes, backs up to a second SeaweedFS container that stands in for the off-site bucket and sits outside `mscd` (reached only through `egress`, which proves the outbound path), deletes the stack volumes, restores and verifies.

Acceptance:

```bash
npm run test:int -w @mscd/server -- test/int/backup
npm run build -w @mscd/server && node apps/server/dist/main.js backup --help | grep -q verify
docker compose -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.saas.yml -f deploy/compose/docker-compose.backup.yml --env-file deploy/compose/.env.saas.example config -q
bash -n deploy/backup/*.sh
node tools/scripts/check-workflows.mjs .github/workflows/restore-test.yml
flock /tmp/mscd-stack.lock bash deploy/backup/restore-test.sh --local
```

#### M2-S08 Monitoring and alerts

| | |
|---|---|
| Wave, depends on | 2b; M2-S02 |
| Owns | `deploy/compose/docker-compose.ops.yml`, `deploy/ops/**`, `deploy/compose/config/caddy/conf.d/ops.caddy`, `docs/saas/monitoring.md`, `docs/platform/handoff/M2-S08.md` |

Brief:
- `docker-compose.ops.yml` runs these services:
  - **Prometheus:** joins the internal `mscd` network to scrape `api:9464`, `worker:9464` and `storage-gateway:9464`. Retention is 30 days. It publishes no port.
  - **Alertmanager:** on `mscd` (Prometheus sends it alerts) and `egress` (SMTP, Telegram, heartbeat).
  - **node-exporter:** with the textfile collector on `/opt/mscd/metrics`.
  - **postgres-exporter:** as role `mscd_monitor` with `pg_monitor`. An idempotent `ops-init` one-shot service creates that role.
  - **blackbox-exporter:** HTTPS probe of the public URL and certificate expiry; on `mscd` and `egress`.
  - Prometheus, node-exporter and postgres-exporter stay on `mscd` only.
  - **Grafana (optional profile `grafana`):** behind Caddy at `ops.<domain>` with basic auth from `ops.caddy`.

  The services use about 1.5 GB RAM in total, with limits set.
- Alert rules in `deploy/ops/prometheus/rules/`:
  - **Services:** target down for 2 minutes; HTTP 5xx ratio over 2 percent for 10 minutes (from `mscd_http_request_duration_seconds`).
  - **Audit and licences:** `mscd_audit_chain_broken > 0`; `mscd_licence_days_left < 30` for any organisation.
  - **Jobs:** a rise in `mscd_job_failures_total`; `mscd_queue_oldest_age_seconds > 900`; `mscd_job_outbox_stuck_rows > 0`.
  - **Security spikes:** `mscd_mfa_locks_total` and `mscd_authz_denied_total`. These are early breach signals for the 3 x 24 hour deadline.
  - **Host:** disk over 80 percent; memory pressure; reboot needed.
  - **Certificates:** expiring in under 14 days.
  - **Backups:** backup older than 26 hours.
  - **Watchdog:** always firing.
- Alertmanager:
  - email through the SMTP secrets (`smtp_auth_password_file`) to `ALERT_EMAIL_TO`, and Telegram when `TELEGRAM_BOT_TOKEN` is set (`bot_token_file`);
  - the Watchdog goes to `HEARTBEAT_WATCHDOG_URL` every minute, so the external service alerts the owner when the box itself is down;
  - `ops-init` renders the config from a template.
  - Settings and secrets come from `/opt/mscd/secrets/ops/`, written by `deploy-prod.yml`, and from the `smtp.password` secret file and the `MSCD_SMTP_*` values of `.env`, written by `saas-deploy.sh` (M2-S05). This package edits neither that workflow nor `.env.saas.example`.
- Promtool unit tests in `deploy/ops/prometheus/tests/` for every rule.
- `deploy/ops/test-ops.sh`: starts the M2-S02 test stack with the ops overlay, checks that every target is up through the Prometheus API inside the container, fires a test alert with `amtool`, and checks that the email arrives in a Mailpit container placed outside `mscd` (reached only through `egress`, which proves outbound delivery).
- `docs/saas/monitoring.md`:
  - what each alert means and the first action, in plain words;
  - how to set up the external uptime check and heartbeat;
  - log retention: Docker `local` logs on the box, and anchor lines kept off-site by M2-S07. Write the retention periods into the privacy notice and records of processing.

Acceptance:

```bash
O="docker compose -f deploy/compose/docker-compose.yml -f deploy/compose/docker-compose.saas.yml -f deploy/compose/docker-compose.ops.yml --env-file deploy/compose/.env.saas.example"
$O config -q
IMG() { $O config --format json | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0)).services[process.argv[1]].image)" "$1"; }
docker run --rm --network none -v "$PWD/deploy/ops/prometheus:/etc/prometheus:ro" --entrypoint promtool "$(IMG prometheus)" check config /etc/prometheus/prometheus.yml
docker run --rm --network none -v "$PWD/deploy/ops/prometheus:/etc/prometheus:ro" --entrypoint promtool "$(IMG prometheus)" test rules /etc/prometheus/tests/alerts.test.yml
docker run --rm --network none -v "$PWD/deploy/ops/alertmanager:/etc/alertmanager:ro" --entrypoint amtool "$(IMG alertmanager)" check-config /etc/alertmanager/alertmanager.yml.example
bash -n deploy/ops/test-ops.sh
flock /tmp/mscd-stack.lock bash deploy/ops/test-ops.sh
```

The promtool and amtool lines use plain `docker run` with the pinned images of the overlay, so they create no project network and need no host lock.

#### M2-S09 Operator commands and organisation lifecycle

| | |
|---|---|
| Wave, depends on | 3a; M2-02, M2-06, M2-S05 (for `ops-cli.yml`), M2-S10 (`applyPreset` and the change notice) |
| Owns | `packages/shared/src/api/ops.ts` (schemas only), `apps/server/src/modules/ops/**` except `ops/domains/**`, `apps/server/src/modules/tenancy/**`, `apps/server/src/db/tenant-provisioner.ts`, `apps/server/src/modules/identity/org-sessions.ts` (new, session revocation) and its sub-module `identity/org-sessions.module.ts` (D.3), `apps/server/src/modules/identity/session-resolver.ts` (cache drop only), `apps/server/src/modules/identity/mail-templates.ts` (the `organization_status_changed` template), `apps/server/src/modules/jobs/scheduler-tick.job.ts` (skips organisations that are not active), `apps/server/src/cli/{tenant.ts,diagnostics.ts}` (`diagnostics.ts` fills the stub of M2-02), `.github/workflows/ops-cli.yml`, `deploy/scripts/saas-ops.sh`, `apps/server/test/int/saas-ops/**`, `apps/server/test/int/security/record-tables/M2-S09.ts`, `apps/server/test/int/rbac/expectations/M2-S09.ts`, `apps/server/test/int/m2-pending/M2-S09.json` (deletes), `docs/saas/operator.md`, `docs/platform/handoff/M2-S09.md` |

Brief:
- Routes `ops.organizations.get`, `.status` and `.events`. The detail shows status, region, created date, member count, system count, entitlement summary, domains and last sign-in.
- `ops.organizations.list` items get `status`, `plan`, `validUntil` (from the entitlement row of M2-S10) and `verifiedDomains`. `ops.organizations.create` applies its `preset` with `applyPreset` of M2-S10 (D.2). M2-06 keeps the rest of `ops.organizations.create` as built.
- Status change:
  - follows the machine of J.8 and requires a reason;
  - `offboarding` and `archived` also need `confirmSlug` equal to the slug;
  - one transaction writes the status, the status event and a platform-chain audit entry;
  - `suspended` and `archived` revoke every session whose current organisation is this one, and users keep their other memberships;
  - it sends the `mscd_tenant_changed` notice of M2-S10, and every api and worker process drops its tenant resolver and session cache within 2 seconds (this package adds those two listeners);
  - the organisation's Tenant Admins get an email with the new status and reason.
- CLI:
  - `tenant list` shows slug, id, status, plan, valid until and members;
  - `tenant show --org <slug>`;
  - `tenant set-status --org <slug> --status <status> --reason <text> [--confirm <slug>]`;
  - `tenant onboard --slug --name --time-zone --site-count --admin-email --admin-name [--preset <name>]` does `tenant create`, the entitlement preset (M2-S10) and the first administrator invitation in one step, through the same service as `ops.organizations.create`;
  - `diagnostics --out <file>` writes the redacted archive of `POST /ops/diagnostics` without the api (open follow-up of `CLAUDE.md`).
- New organisations get `region` from `tenancy.default_region`.
- `tenant onboard` follows the mail rule that M2-06 built for `ops.organizations.create` and `admin create-operator`: with `mail.required` it refuses when SMTP is not configured, never prints an invitation link, and prints "Invitation sent to <email>". It creates the organisation with local sign-in allowed (product decision 7 of `CLAUDE.md`).
- `saas-ops.sh` is the server-side allow-list wrapper. It accepts only these commands, each with validated arguments, mapped to `docker compose run --rm cli ...`:
  - `create-operator`, `revoke-operator`;
  - `tenant-list`, `tenant-show`, `tenant-onboard`, `tenant-set-status`;
  - `admin-create-user --org`;
  - `license-entitlements-show`, `license-entitlements-set` (M2-S10);
  - `diagnostics`.
- `ops-cli.yml`:
  - **Inputs:** `target`, `command` (a choice list), and one input field per argument, each checked with a pattern.
  - **Run:** in the target's environment, so the owner approves each run. It calls `saas-ops.sh` over SSH with the pinned host key.
  - **Output:** shown in the job summary.

  The owner creates the first operator with it, using the owner's own email.
- `docs/saas/operator.md`:
  - onboarding a customer step by step;
  - what each status means for users, explained in plain words;
  - offboarding with the D-S5 period;
  - the commands.

Acceptance:

```bash
npm run test:int -w @mscd/server -- test/int/saas-ops
npm run test:int -w @mscd/server -- test/int/ops test/int/identity test/int/onboarding test/int/jobs
test ! -e apps/server/test/int/m2-pending/M2-S09.json
npm run build -w @mscd/server && node apps/server/dist/main.js tenant --help | grep -q set-status && node apps/server/dist/main.js tenant --help | grep -q onboard && node apps/server/dist/main.js diagnostics --help >/dev/null
bash -n deploy/scripts/saas-ops.sh && ! bash deploy/scripts/saas-ops.sh psql 2>/dev/null
node tools/scripts/check-workflows.mjs .github/workflows/ops-cli.yml
npm run test:int -w @mscd/server -- test/int/rbac test/int/contract test/int/security
```

`test/int/saas-ops` covers:
- every allowed status move, and every refused one with 409 `transition-not-allowed` and `messageKey` `invalid_status_transition`;
- 422 `business-rule` with `messageKey` `confirmation_mismatch`;
- sessions revoked, while the other organisation's sessions keep working;
- a second api process seeing the new status within 2 seconds;
- jobs skipping suspended organisations;
- the audit entry and the email;
- onboarding refused in multi tenancy when mail is missing;
- 409 `conflict` with `messageKey` `single_tenancy` for each new route in single tenancy.

#### M2-S10 Per-organisation entitlements

| | |
|---|---|
| Wave, depends on | 2b; M2-02, M2-06 |
| Owns | `packages/shared/src/api/{license,ops-entitlements}.ts` (schemas only), `apps/server/src/modules/license/**`, `apps/server/src/modules/platform/rate-limit.ts`, `apps/server/src/modules/tenancy/rate-limit-store.ts` (limits per organisation), `apps/server/src/cli/license.ts`, `apps/server/profiles/saas.yaml` (`license.plans` values), `apps/server/src/modules/identity/mail-templates.ts` (the entitlement expiry templates), `apps/server/src/modules/jobs/schedules.ts` (the `entitlement.expiry` entry), `apps/server/test/int/license/**`, `apps/server/test/int/entitlements/**`, `apps/server/test/int/security/record-tables/M2-S10.ts`, `apps/server/test/int/rbac/expectations/M2-S10.ts`, `apps/server/test/int/m2-pending/M2-S10.json` (deletes), `docs/saas/entitlements.md`, `docs/platform/handoff/M2-S10.md` |

Brief:
- Orchestrator note from M2-02: `platform.entitlement` rows can only be written in platform scope. Wrap every write in `withPlatformScope` (`identity/platform-scope.ts`), including `PUT /admin/license` in multi tenancy and the first-read backfill in `LicenceService`.
- In multi tenancy, the effective licence of each organisation is its `platform.entitlement` row. LicenceGate reads it through a cache of up to 60 seconds. Every entitlement write sends `NOTIFY mscd_tenant_changed` with the organisation id, and each process clears its cache entry on that notice. The helper `publishTenantChange(trx, orgId)` and the listener live in `modules/license/`; M2-S09 reuses them in wave 3a.
- What stays the same:
  - the codes `LIC-USERS`, `LIC-MS`, `LIC-FEATURE`, the adapter checks, read-only after grace, and `license.check`;
  - `LIC-USERS` counts active members without guests (product decision 5 of `CLAUDE.md`);
  - single tenancy, which still uses the signed licence file;
  - `PUT /admin/license {org, licence}` (D-32): it still verifies the signature and now writes the entitlement row with source `signed_licence`, so the M2-16 "Install licence" button keeps working.
- `ops.entitlements.set`:
  - accepts a `preset` from `license.plans` or explicit fields;
  - needs `If-Match`;
  - writes one audit entry with the old and new values;
  - when a limit falls below current use, it is accepted with a warning in the response, and new invitations then stop with `LIC-USERS`.
- `ops.plans.list` returns the presets. `EntitlementService.applyPreset(trx, orgId, preset)` writes the row for a preset; M2-S09 calls it from `ops.organizations.create` and `tenant onboard` in wave 3a. Until then an organisation without a row keeps the Milestone 1 rule: no licence, so no users or systems can be added.
- Existing licences: an organisation that has no entitlement row but holds a current installed signed licence (a multi-tenancy install or staging stack created before M2-S10) gets a row with source `signed_licence` from that licence, written once by `LicenceService` on the first read and audited `ops.entitlements_changed`. No licence is lost on upgrade.
- `saas.yaml`: the D-S4 presets `trial` and `standard` as the values of `license.plans`, whose key and schema M2-02 added with an empty map (D.3).
- Rate limits per organisation and per user come from the entitlement, with `DEFAULT_RATE_LIMITS` when a value is null.
- The daily `entitlement.expiry` job emails platform operators at 30, 7 and 1 days before `valid_until`, and the organisation's Tenant Admins at 30 and 7 days. `mscd_licence_days_left` reads the registry through `LicenceService.evaluateOrg`, so the collector in `modules/ops/` does not change.
- CLI: `license entitlements show --org <slug>` and `license entitlements set --org <slug> (--preset <name> | --max-users <n> --max-systems <n> --valid-until <date> ...)`.
- `docs/saas/entitlements.md`: presets, how to change a customer's plan, and what users see at each limit.

Acceptance:

```bash
npm run test:int -w @mscd/server -- test/int/entitlements test/int/license test/int/platform
test ! -e apps/server/test/int/m2-pending/M2-S10.json
npm run build -w @mscd/server && node apps/server/dist/main.js license entitlements --help | grep -q preset
npm run test:int -w @mscd/server -- test/int/rbac test/int/contract test/int/security
npm run test:int -w @mscd/server
```

`test/int/entitlements` covers:
- preset and explicit set, plus 412 and 428 for `If-Match`;
- limits enforced per organisation, and a second organisation's limits left unchanged;
- a lowered limit blocking invitations;
- the cache refresh across processes;
- the upload path writing a registry row;
- an organisation with a signed licence installed before M2-S10 and no row keeping its limits, with one row of source `signed_licence` written;
- per-organisation rate limits answering 429 at the new value;
- the expiry emails.

#### M2-S11 Organisation discovery at sign-in

| | |
|---|---|
| Wave, depends on | 3b; M2-02, M2-10, M2-S09 (both edit `cli/tenant.ts` and `identity/mail-templates.ts`, so this package comes one wave later) |
| Owns | `packages/shared/src/api/{auth,ops-domains}.ts` (schemas only), `apps/server/src/modules/identity/oidc/{auth-providers.service.ts,provider-lookup.ts}`, `apps/server/src/modules/ops/domains/**`, `apps/server/src/modules/platform/system-profile.controller.ts` (the `legal` member), `apps/server/src/modules/identity/mail-templates.ts` (the missing-record template), `apps/server/src/modules/jobs/schedules.ts` (the `domain.verify` entries), `apps/server/src/cli/tenant.ts` (the `verify-domain` command only), `apps/server/test/int/domains/**`, `apps/server/test/int/security/record-tables/M2-S11.ts`, `apps/server/test/int/rbac/expectations/M2-S11.ts`, `apps/server/test/int/m2-pending/M2-S11.json` (deletes), `apps/web/src/auth/**`, `apps/web/test/auth/**`, `apps/web/e2e/api-only/sign-in-discovery.spec.js`, `tools/mock-providers/**`, `docs/saas/sign-in.md`, `docs/platform/handoff/M2-S11.md` |

Brief:
- Orchestrator note: the email field of the sign-in page shows the demo address `rina.kusuma@nusantaradigital.co.id` as its placeholder (`emailPlaceholder` in `apps/web/src/auth/i18n.ts`). Replace it with a generic example (`name@company.com`, Indonesian `nama@perusahaan.co.id`); demo builds may keep the demo address through the profile `demo.enabled`.
- Domain verification by DNS TXT:
  - `ops.domains.add` normalises the domain (lower case, IDN to punycode). It refuses free mail domains (for example `gmail.com`, `yahoo.com`, `yahoo.co.id`, `outlook.com`, `hotmail.com`) with 422 `business-rule` and `messageKey` `domain_not_allowed`.
  - It returns the record `_mscd-verify.<domain>` TXT `mscd-verify=<token>`, with a 32-byte random token. Only the token's hash is stored.
  - The worker job `domain.verify` checks pending domains every hour for 7 days, then marks them `failed`. "Verify now" checks at once. Lookups use `node:dns` with `network.dns_resolvers`.
  - A verified domain belongs to one organisation only. A second claim gets 409 `conflict` with `messageKey` `domain_taken`.
  - A monthly re-check emails the operators when the record is gone. The status stays verified.
- `system.profile` returns `legal: {privacyUrl, termsUrl}` from the profile keys (D.2), for the sign-in page footer.
- `tenant verify-domain --by <name>` stays for on-premise. In multi tenancy it also needs `--manual-reason <text>` and is audited with method `manual`.
- `GET /auth/providers` gives the same answer shape and status for an unknown slug, an unknown domain and a known organisation without SSO (D-S10). It has its own limit of 20 per minute per address, which answers 429 with `Retry-After`.
- Login page:
  - "Work email" (`#au-email`) and the password field (`#au-password`) show together on one page from the start, as in Milestone 1. Email discovery runs as the person types (debounced) and adds the SSO buttons of the matched organisation. The password field is hidden only when the matched organisation disables local sign-in, so filling email and password and pressing submit still works in one pass, as `e2e/api-only/sign-in.spec.js` and the smoke journey (`tools/smoke/tests/smoke.spec.mjs`) do;
  - `?org=` still preselects an organisation;
  - the last slug is remembered in `localStorage` inside try and catch;
  - footer links to the privacy notice and terms from `system.profile.legal`, hidden when null;
  - English and Indonesian text, no text under 12px, AA contrast in both themes (R-16).
- `tools/mock-providers`: a small DNS responder on UDP (random port in tests) for TXT records, with an admin route to set records. The API E2E stack and M2-S13 use it.
- `docs/saas/sign-in.md`: what the customer's IT team adds to DNS, and how sign-in finds the organisation, in plain words.

Acceptance:

```bash
npm run test:int -w @mscd/server -- test/int/domains test/int/sso test/int/identity
test ! -e apps/server/test/int/m2-pending/M2-S11.json
npm test -w @mscd/mock-providers
npm test -w @mscd/web -- test/auth
CI=1 npm run test:e2e -w @mscd/web -- e2e/contrast.spec.js e2e/i18n.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web -- e2e/api-only/sign-in-discovery.spec.js e2e/api-only/sign-in.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web
flock /tmp/mscd-stack.lock npm run test:smoke
git diff --quiet HEAD -- apps/web/e2e/api-only/sign-in.spec.js apps/web/e2e-api/fixtures.js tools/smoke/tests/smoke.spec.mjs
npm run test:int -w @mscd/server -- test/int/rbac test/int/contract test/int/security
```

`test/int/domains` covers:
- add, verify through the mock DNS, expiry after 7 days, and remove;
- `domain_taken` and `domain_not_allowed`;
- the token stored only as a hash;
- discovery returning SSO providers only for a verified domain;
- the same answer for unknown slugs and domains;
- the 429 limit.

#### M2-S12 Operator console: organisations, status, domains and entitlements

| | |
|---|---|
| Wave, depends on | 3c; M2-16, M2-S09, M2-S10, M2-S11 |
| Owns | `apps/web/src/screens/ops/**`, `apps/web/test/screens/ops*.test.tsx`, `apps/web/e2e/screens/ops*.spec.js`, `apps/web/e2e/api-only/ops-organizations.spec.js`, `docs/platform/handoff/M2-S12.md` |

Brief:
- Organisations table:
  - adds the columns status, plan, users "used of limit", valid until with days left, and verified domains;
  - filters by status and search by slug or name.
- "Create organisation" gains the plan preset (`ops.plans.list`). It shows no one-time link on SaaS, because `mail.required` is true there (M2-06).
- Organisation drawer tabs:
  - **Overview:** the `ops.organizations.get` fields.
  - **Status:** shows the current status with one plain sentence on what users can do. Actions are "Suspend", "Reactivate", "Start offboarding" and "Archive". Each needs a reason, and the last two also need the slug typed again. The effects are listed before confirming.
  - **Domains:** add a domain; shows the TXT name and value with "Copy", state badges, "Verify now", and "Remove" with confirmation.
  - **Entitlements:** preset picker, the limit fields and valid until; saves with `If-Match`, shows the conflict message and the over-limit warning from the response.
  - **History:** `ops.organizations.events`.
- The sample adapter has two sample organisations so sample-mode specs and contrast cover every tab.
- Hand-written React as D2-01, both languages, both themes, `expectOverlayReadable` on every drawer and dialog (R-16, R-17).

Acceptance:

```bash
npm test -w @mscd/web -- test/screens/ops.test.tsx test/screens/ops-organizations.test.tsx
CI=1 npm run test:e2e -w @mscd/web -- e2e/screens/ops.spec.js e2e/screens/ops-organizations.spec.js e2e/contrast.spec.js e2e/i18n.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web -- e2e/api-only/ops.spec.js e2e/api-only/ops-organizations.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web
git diff --quiet HEAD -- apps/web/src/MscdApp.jsx apps/web/src/views apps/web/src/styles.css apps/web/e2e/helpers.js
```

#### M2-S13 SaaS end-to-end run, CI jobs and go-live evidence

| | |
|---|---|
| Wave, depends on | 6; every other SaaS package, M2-18 |
| Owns | `.github/workflows/ci.yml`, `tools/smoke/**`, `apps/server/vitest.int-saas.config.ts`, `apps/server/package.json` (script `test:int:saas` only; lockfile unchanged), `apps/server/test/setup/**` (a multi-tenancy template database), `docs/saas/go-live-checklist.md` (status and evidence columns), `docs/platform/handoff/M2-S13.md` |

Brief:
- `npm run test:int:saas -w @mscd/server` runs the `security`, `rbac` and `contract` suites, plus `saas-ops`, `entitlements` and `domains`, with tenancy `multi`. Two organisations are in the template database. The route-generated sweeps cover every operator route.
- `tools/smoke/run-saas.mjs` and script `saas` run the M2-S02 test stack (release-flavour images with throwaway keys, Caddy with `tls internal`, Mailpit, mock providers, mock DNS). Every step runs in the browser:
  1. `saas-ops.sh create-operator` runs locally, then the operator enrols TOTP.
  2. The operator creates organisations Alpha (`standard`) and Beta (`trial`) and verifies a domain for Alpha through the mock DNS.
  3. Each first administrator accepts the invitation from Mailpit. Alpha's administrator signs in by work email discovery.
  4. Each administrator creates a system and uploads a file.
  5. Isolation: Beta's administrator opens Alpha's system, file and export URLs and gets 404; discovery answers the same for an unknown slug.
  6. Suspend Beta: Beta's session ends, sign-in shows the inactive message, and Alpha keeps working. Then reactivate Beta.
  7. Offboard Beta: reads work and writes answer 403.
  8. Lower Alpha's user limit to current use: the next invitation shows the `LIC-USERS` message.

  `--with-ops` also checks that every Prometheus target is up. The run fails on any page error, console error or 5xx answer, and runs `expectReadableText` on every operator screen it visits.
- `ci.yml` adds three jobs:
  - **`saas-static` on every push:**
    - `check-workflows.mjs --saas --require-all`;
    - `compose config -q` for the saas, backup and ops overlays;
    - promtool and amtool checks;
    - `bash -n` of every SaaS script;
    - `check-golive.mjs`.
  - **`int-saas` on every push:** `test:int:saas`.
  - **`saas-smoke` on pushes to the default branch and nightly:** makes throwaway keys in the job, builds release-flavour images and runs `npm run saas -w @mscd/smoke`.
- Go-live checklist: every `agent` row gets status `done` with its evidence (CI job name or command). `owner` rows stay open.
- Orchestrator note from M2-S08: run `deploy/ops/test-ops.sh` once with `MSCD_OPS_TEST_GRAFANA=true` in the `saas-smoke` job (the build host of Milestone 2 had too little disk for the Grafana image), before Grafana is turned on in production.

Acceptance:

```bash
npm run test:int:saas -w @mscd/server
flock /tmp/mscd-stack.lock npm run saas -w @mscd/smoke -- --with-ops
flock /tmp/mscd-stack.lock npm run journey -w @mscd/smoke -- --saas
flock /tmp/mscd-stack.lock npm run test:smoke
node tools/scripts/check-workflows.mjs --saas --require-all
node tools/scripts/check-golive.mjs --agent-items-done docs/saas/go-live-checklist.md
npm run test:int -w @mscd/server
test -z "$(docker ps -q --filter label=mscd.test=true)"
```

### K.7 Order of going live

| Step | Who | What |
|---|---|---|
| 1 | Owner | Buy the server, staging server, domain, mail provider and backup bucket (K.2). Start the lawyer's work with `docs/saas/legal-inputs.md`. Book the penetration test |
| 2 | Owner | Run `deploy/scripts/saas-keys.sh` on the owner's own computer, run the printed `gh` commands, store the offline copies, and set up the GitHub environments |
| 3 | Owner approves | `bootstrap-prod.yml` for staging, then for production. Then set `DEPLOY_*` secrets and delete `BOOTSTRAP_SSH_KEY` |
| 4 | Owner | Push tag `v1.1.0`. `release.yml` builds, checks, signs and pushes after the owner approves the `release` environment |
| 5 | Agent starts, owner approves | `deploy-prod.yml` with `target=staging`, then `ops-cli.yml create-operator` with the owner's email on staging |
| 6 | Vendor | Penetration test on staging. Agents fix the findings in normal packages, then the vendor retests |
| 7 | Agent starts, owner approves | `restore-test.yml` with `target_version`, then `deploy-prod.yml` with `target=production`, then `create-operator` on production |
| 8 | Owner | Publish the privacy notice and terms, set `LEGAL_PRIVACY_URL` and `LEGAL_TERMS_URL`, deploy again, and confirm that the test alert and heartbeat arrive |
| 9 | Owner | `node tools/scripts/check-golive.mjs --require-done docs/saas/go-live-checklist.md` passes, then sign off |
| 10 | Operator | Onboard the first customer from the operator console with the signed DPA in place |

### K.8 Not in this track

| Item | Why it waits, and when it is needed |
|---|---|
| Full tenant export in open formats and verified purge after offboarding | Needed before the first customer leaves, because the DPA promises return and deletion. Plan it as the next SaaS package set (estimated 11 to 17 working days). Until then, offboarding uses the per-system exports and the `archived` status |
| Requests from data subjects (export, anonymise or delete one person) | Handled by a manual operator procedure (M2-S04) until a feature exists |
| Self-service sign-up and billing | D-S1 default is sales-led |
| Storage quota per organisation and fair job scheduling | Plan limits cover users and systems first |
| Cloud KMS for the KEKs | Deviation X-03 stays. It needs a provider choice |
| Second region and a global sign-in directory | One region (D-S2). The `region` column is set from the first day |
| Break-glass access to tenant data with a second approver | Operators cannot read tenant data today. Recorded as a decision in the checklist |
| WAL archiving for a recovery point of minutes | Add once customers pay. Daily dumps give 24 hours |
| Central log store (Loki) and SSH session recording | Docker logs on the box and anchor lines off-site come first |
| Helm SaaS values and k3s | When a second node is needed |
| Managed pack channel publish command | New packs arrive with each image and are installed by migrate |
| Mail provider API driver with bounce handling | SMTP to the provider relay works |

### K.9 Risks

| Risk | Effect | Handling |
|---|---|---|
| One VPS has no high availability | A host failure stops every customer | Modest uptime target (D-S7), tested restore with a measured restore time, external heartbeat, restore runbook onto a fresh bootstrapped server |
| KEKs sit on the same disk as the database, and copies sit in `restore-test` | A full server compromise exposes tenant data keys | File permissions 0400, per-service mounts, separate backup credentials, offline copies, cloud KMS in K.8, D-S12 asks the owner |
| Port 22 open to the internet | Attack surface | Key-only SSH, ufw limit, fail2ban, named accounts; Tailscale later (M2-S03 doc) |
| Owner approval needed for every production action | Slower fixes at night | Staging rehearsal first, automatic rollback in the script, rollback is one approved run |
| Carrier NAT in Indonesia shares one address across an office | Login rate limits lock out a whole office | Generous NGINX defaults, per-email limits stay the main guard, alert on `mscd_mfa_locks_total` spikes |
| Tenant migrations run one schema after another | Deploys get slower as customers grow | Timeout grows with the schema count, the restore-test rehearsal measures the time before each production run |
| Legal documents and penetration test booking take weeks | Go-live waits | M2-S04 runs in the first wave and hands the owner the inputs at once |
| On-premise installs make their own anchor key, which the compiled keys do not include | In-app anchor checks fail on-premise | SaaS is fixed in M2-S05. The on-premise fix (compile the customer key in, or trust the installation's own `audit-anchor.pub`) goes in the M2-S05 handoff note as a follow-up |
| The demo stack reaches a production server by mistake | Public development keys protect real data | S-7, the refusals in `saas-deploy.sh`, separate GitHub environments, checklist item |

## L. Motion track

The product owner wants motion, illustrated animation and animated backgrounds in three places, all built with the `motionsites-web-builder` skill (installed in `~/.claude/skills/motionsites-web-builder/` for this session; see the rule in `CLAUDE.md`). Follow the skill's workflow: decide, study the 2 or 3 closest examples, choose media, write the spec, build, then the look-and-fix loop with screenshots until the page scores 8 or more on the skill's `references/review.md`, nothing under 7. The skill's sponsor block never goes into files or replies.

Rules for this track, on top of R-01 to R-18:

| # | Rule |
|---|---|
| L-1 | No request to another origin at run time: fonts, scripts, videos and images are copied into the repository and served from the same site. A chosen MotionSites media file may be copied for this site (allowed by the skill's licence); the skill's `examples/` and `media/` folders are never committed. |
| L-2 | `prefers-reduced-motion: reduce` shows a still frame or a static poster and stops every loop. Nothing is hidden until an animation runs (the page is complete at rest). |
| L-3 | Text 12px or more and WCAG AA contrast in light and dark themes, measured over the moving background at its brightest frame (use a scrim where needed). |
| L-4 | Performance: animated backgrounds pause when off screen or when the tab is hidden; a video background is at most 6 MB, H.264 MP4 with a WebM fallback and a poster image; no layout shift from media. |
| L-5 | Brand: MSCD tokens (accent `#e8731a` dark, `#ad4f0b` light), IBM Plex Sans and IBM Plex Mono, the CyberLentera logo from `project/assets/`. |

| Wave | Package | Depends on | Owns |
|---|---|---|---|
| L1 (now, parallel to wave 1a and 1b) | MOT-01 Marketing landing site | none | `apps/site/**`, `docs/site.md`, `docs/platform/handoff/MOT-01.md` |
| L1 | MOT-02 Sign-in brand panel motion | none (must finish before M2-S11, which owns `apps/web/src/auth/**` in wave 3b) | `apps/web/src/auth/ui.tsx` (BrandPanel and AuthLayout only), `apps/web/src/auth/auth.css`, `apps/web/src/auth/motion/**`, `apps/web/public/motion/**`, `apps/web/test/auth/motion.test.tsx`, `apps/web/e2e/auth-motion.spec.js`, `docs/platform/handoff/MOT-02.md` |
| L2 | MOT-03 In-app illustration library | M2-01 (uses its EmptyState in `apps/web/src/screens/ui/`) | `apps/web/src/illustrations/**`, `apps/web/test/illustrations/**`, `apps/web/e2e/illustrations.spec.js`, `docs/platform/handoff/MOT-03.md` |

#### MOT-01 Marketing landing site

| | |
|---|---|
| Wave, depends on | L1; none |
| Owns | `apps/site/**`, `docs/site.md`, `docs/platform/handoff/MOT-01.md` |

Brief:
- A public marketing site for MSCD at `apps/site/`, the cinematic version of the design in `project/MSCD Landing.dc.html` (keep its sections, facts and message: one traceability chain from risk to evidence, ISO/IEC 27001, ISO 9001, ISO 22301 and ISO 37001, files stay in the customer's repository, SaaS and on-premise, MFA). Read that file and `project/MSCD Technical Proposal.dc.html` for the facts; invent no customer names, numbers or certifications.
- Signature idea chosen through the skill. Good candidates: the chain Issue, Risk, Control, Document, Evidence, Finding drawn as a living thread across the hero; evidence files flowing into a vault; a calm dark cinematic video behind a precise headline.
- Static files only: `apps/site/index.html` plus `apps/site/assets/**` (self-hosted fonts in WOFF2, any library copied from `node_modules` or vendored with its licence, media). No build step is needed; if one is used it must not change the root lockfile.
- English first, with an Indonesian version at `apps/site/id/index.html` using the same assets.
- Calls to action: "Request a demo" (a `mailto:` placeholder address `sales@example.com` the owner replaces, shown as text too) and "Sign in" (link to `/` of the app host, set in one constant).
- `apps/site/check.mjs`: a Playwright script (use `@playwright/test` from the root `node_modules` and the Chromium at `/opt/pw-browsers` or the default install) that serves the folder on a free local port, takes screenshots at 1440x900 and 390x844 in light and dark (`colorScheme`), and fails on: any request to another origin, horizontal overflow, text under 12px, a contrast ratio under 4.5:1 for text over its background (sample the background at the text position), missing `<title>` or meta description, console errors, broken media. It also runs once with `reducedMotion: 'reduce'` and checks that no animation is running.
- `docs/site.md`: what the site is, how to preview it, how to swap the media, and how it will be served (a follow-up for M2-S02: Caddy serves `apps/site` on the bare domain and the app on `app.<domain>`).

Acceptance:

```bash
node apps/site/check.mjs
node tools/scripts/check-text.mjs apps/site docs/site.md
```

#### MOT-02 Sign-in brand panel motion

| | |
|---|---|
| Wave, depends on | L1; none |
| Owns | `apps/web/src/auth/ui.tsx` (BrandPanel and AuthLayout only), `apps/web/src/auth/auth.css`, `apps/web/src/auth/motion/**`, `apps/web/public/motion/**`, `apps/web/test/auth/motion.test.tsx`, `apps/web/e2e/auth-motion.spec.js`, `docs/platform/handoff/MOT-02.md` |

Brief:
- Replace the static brand panel of the sign-in pages (`BrandPanel` in `apps/web/src/auth/ui.tsx`, used by every auth page through `AuthLayout`) with an animated background chosen through the skill: the traceability chain as a living illustration (canvas or SVG) or a calm self-hosted video loop, behind the existing text and facts.
- The form side stays exactly as it is; only the brand panel changes. Keep every existing auth test and spec green (`apps/web/test/auth/**`, `apps/web/e2e/api-only/sign-in.spec.js`, `apps/web/e2e/contrast.spec.js`).
- On narrow screens the panel collapses as today; the animation stops when the panel is hidden.
- Rules L-1 to L-5 apply. The nginx Content-Security-Policy in `deploy/nginx/**` must not need a change: no new origins, no inline scripts beyond what the build already emits.

Acceptance:

```bash
npm test -w @mscd/web -- test/auth
CI=1 npm run test:e2e -w @mscd/web -- e2e/auth-motion.spec.js e2e/contrast.spec.js e2e/shell.spec.js
npm run build -w @mscd/web
```

#### MOT-03 In-app illustration library

| | |
|---|---|
| Wave, depends on | L2; M2-01 |
| Owns | `apps/web/src/illustrations/**`, `apps/web/test/illustrations/**`, `apps/web/e2e/illustrations.spec.js`, `docs/platform/handoff/MOT-03.md` |

Brief:
- A small set of illustrated, lightly animated scenes for the app, built through the skill but quiet enough for daily work: Getting started (a path of steps lighting up), no systems yet, no documents yet, no evidence yet, no findings, all done, and an error or offline state. Each scene is a React component with a static frame and a short entrance (under 1.2 s), no endless loops inside the dashboard.
- Each component takes a size and the theme from the tokens of `apps/web/src/styles.css`, has a text alternative, and plugs into the `EmptyState` of `apps/web/src/screens/ui/` (M2-01) through a prop, so screen packages pick a scene by name.
- A gallery screen in sample mode only (`?screen=illustrations`) for review, registered through the M2-01 screen registry.
- Follow-up for M2-16 and the screen packages: use these scenes for Getting started and empty states.

Acceptance:

```bash
npm test -w @mscd/web -- test/illustrations
CI=1 npm run test:e2e -w @mscd/web -- e2e/illustrations.spec.js e2e/contrast.spec.js
```

## Review notes

No issue of the review was rejected. Two fixes differ from the suggestion:

- Storing and filtering `finding.target_code` goes to M2-05 instead of M2-07, because M2-05 owns `audit-registers/findings.service.ts` for the readiness queueing (D.6) and one file has one owner per wave.
- The Getting started button for the steps of the management system manager opens a prepared email to the primary MS Manager, because no notification kind for onboarding steps exists and R-14 allows no new enum value after wave 1a.

Second review round. Every finding was applied, with these parts rejected:

- Sign-in finding: `apps/web/e2e-api/fixtures.js` does not fill the login form (it mints sessions through `POST /api/v1/test/session`), so only `e2e/api-only/sign-in.spec.js` and the smoke journey depend on the one-page form; the fix keeps both fields on one page, and M2-S11 edits none of these files.
- Module finding: `ops.module.ts` already has an owner in waves 2a and 3a (M2-06 and M2-S09 own `ops/**`), so the ops services of those packages stay there; only `ops/domains/domains.module.ts` is a new sub-module.
