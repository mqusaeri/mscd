# MSCD Milestone 2 Plan

| | |
|---|---|
| Purpose | The implementation plan for Milestone 2: decisions, server additions, pack content, web extension points and ordered work packages, written for the agents that build them |
| Goal | A real customer can be onboarded and run its ISO programme entirely from the web app, on a fresh organisation with no demo data, without the browser console helper, after the installer has created the organisation and its first administrator (A.2) |
| Inputs | `docs/platform/BUILD-PLAN.md` (Milestone 1, cited as "BP" with its section, for example "BP F.6"), `docs/platform/ui-contract.md`, `docs/platform/handoff/WP-*.md`, the user-flow gap study (customer onboarding, user and role assignment, document preparation, clauses) and code research on the web app, the API contract, the server and the packs, checked against the repository on 27 October 2026 |
| Starting point | All 39 Milestone 1 work packages are built and verified on branch `mscd-platform`. The web app reaches 52 of the 185 contract routes. The other 133 are reachable only through the API |
| Out of scope | Section B |
| Build environment | As BP header: Linux container, 4 CPUs, 15 GB RAM, Node 22.22 and npm 10, Docker 29 with Compose v5, Playwright Chromium 1194, TLS-inspecting proxy (CA bundle `/root/.ccr/ca-bundle.crt`). At most four agents work at the same time in Milestone 2 (R-02) |

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
- [Review notes](#review-notes)

## 0. Rules for implementing agents

The rules R-01 to R-13 of BP section 0 still apply to every Milestone 2 work package (M2 package), with the changes in the second column. R-14 to R-18 are new.

| # | Status in Milestone 2 | Rule or change |
|---|---|---|
| R-01 | Applies | Work only inside the paths your package owns (G.2 "Owns"). A path owned by a finished package may be edited only when your package lists it. |
| R-02 | Changed | At most four packages run at the same time (was two). Packages in one wave never own the same file. The shared files of Milestone 2 have exactly one owner per wave, named in G.1. |
| R-03 | Changed | No new npm dependency is planned. Import parsing uses `exceljs` and `csv-parse`, already server dependencies. M2-03 is the only lockfile owner, for the server version change to 1.1.0 (`npm install --package-lock-only`). Any other missing package goes in the handoff note, and the orchestrator adds it between waves. |
| R-04 | Applies | Never hand-edit `apps/web/src/views/*.jsx` (except `util.js`) or `apps/web/src/hover.css`. Changes go through `project/MSCD Mockup.dc.html` or the `PATCHES` of `apps/web/scripts/convert-template.mjs`, then `npm run gen:views -w @mscd/web`. In Milestone 2 only M2-01 and M2-17 change the converter or the template. |
| R-05 | Changed | The fixed ports stay. The API E2E stack (4174, 3174, 4310, 4311) and the Compose stacks (18080, 18443, 18088, 18025) can run only once per host, so every run of `test:e2e:api`, `test:smoke` and the journey takes the host lock: `flock /tmp/mscd-stack.lock <command>`. Vitest suites keep random ports. |
| R-06 | Applies | Docker Hub pull limit, images of BP A.3 only, no `:latest`, `TESTCONTAINERS_RYUK_DISABLED=true`. |
| R-07 | Changed | Status codes, enum values and table names are exactly as written in BP and in section D of this plan. Section D wins where it changes BP. |
| R-08 | Applies | Writing rules for documentation and UI text: plain English, no em dash, no centre dot, no notes about the writing itself. `npm run check:text` checks `docs`. |
| R-09 | Changed | Definition of done as BP R-09. The handoff note goes to `docs/platform/handoff/M2-nn.md`. |
| R-10 | Changed | Agents never commit or push. The orchestrator commits once at the end of each wave, so `git diff HEAD` in an acceptance block shows only the current package's changes. |
| R-11 | Applies | Development keys only in the folders named in BP R-11. |
| R-12 | Applies | Every image build passes `--secret id=build_ca,src="$MSCD_BUILD_CA"`. |
| R-13 | Applies | Release artefacts never contain development keys, demo profiles or seed data. M2-18 extends `deploy/scripts/check-release-artefacts.sh` with a check for the demo texts listed in E.4. |
| R-14 | New | New route ids appear only in wave 1a (M2-02), and every one is listed in D.1 and J.1. From wave 2 on, a package may change the request or response schema of a route in the area files it owns, but adds no route id and changes no permission, enum value or matrix row. A needed change of that kind goes in the handoff note, and the orchestrator applies it between waves. |
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

### A.2 What stays outside the browser

Installing the software stays a technical task. On-premise, `install.sh --admin-email` creates the organisation and invites the first administrator, as today, and now emails the invitation when mail is configured. On SaaS, the platform operator account is created once with `mscd-server admin create-operator` (M2-06), and every later organisation is created from the operator console in the browser (M2-16). Everything after the first administrator's first sign-in happens in the web app.

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
| SaaS self-service sign-up and billing | Later milestone, because no payment provider or price list is chosen. The operator console creates organisations (M2-16) |
| LDAP and Active Directory sign-in, SMB, S3 and WebDAV repositories | Deferred as in BP Appendix 1, because no customer has asked for them and each needs its own adapter and tests. M2-18 corrects the user guide, the demo licence texts and `docs/INSTALL-ONPREM.md` so nothing promises them |
| Email domain verification for automatic account creation on first company sign-in | Stays the operator command `tenant verify-domain`, because proving domain ownership needs DNS access that only the operator has. Invitations work without it |
| Zero-transit upload from the browser to Microsoft 365 or Google Drive (`storage.upload-intents.complete`) | Later milestone, because it needs upload sessions and CORS settings in each customer tenant that are not tested yet. Uploads go through the gateway as today |
| Read confirmation of policies, retention periods and disposal review | Milestone 3, because retention needs a decision on legal hold and deletion of stored files. Proof of communication is kept as evidence files meanwhile |
| Document editor and review comments inside MSCD | Not planned, because customers write in their own tools and MSCD keeps the approved version and its hash |
| Moving applicability entries to a new edition through mapping files, and the offer of new activity templates after a pack update | Later milestone, because the mapping files for the new editions need the lead auditor check of H.6 first. The edition transition route keeps its Milestone 1 behaviour, and the transition action (M2-09) says so |
| Periodic access review task (Annex A 5.18) and the top management pending totals panel | Milestone 3, because the access review needs a review cycle record and the totals panel waits for the answer to H.13 |
| Seeding demo personas for Programme Owner, Risk Owner and Compliance Investigator, and sample-mode permissions taken from the F.6 matrix | Milestone 3, because the personas depend on the answers to H.4 |
| React Router and deep links for every screen | Later (D2-14), because the controller state model works and the change touches every screen |
| An offline `mscd-server diagnostics` command and the third-party notices file | Later milestone, because the online diagnostics download (M2-16) covers support needs for now and the notices file belongs to release packaging |
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

The guard cannot read a multipart body before the handler, so the import kind is a path member. A stub answers `501` with the new problem slug `not-implemented` after the guard (J.6). The WP-30 contract harness declares 501 for the routes listed in `apps/server/test/int/m2-pending/M2-nn.json` (route ids per building package), and the RBAC and security sweeps treat a 501 from a listed route as "guard passed, handler pending". Each building package deletes its own file. J.1 lists the same 27 routes in the format that the shared contract tests read.

### D.2 Changed behaviour of existing routes

| Route | Change | Built by |
|---|---|---|
| `admin.organization.update` | body also takes `name` (1 to 200), `timeZone` (IANA, checked with `Intl`), `siteCount` (0 or more); slug stays permanent; after a time zone change the daily jobs of the current local day run once and not twice | M2-06 |
| `admin.users.create` | an existing active account gets an email and a `membership_invited` notification; the admin still gets the same 202 (F.6) | M2-06 |
| `me.get` | `Me` gains `pendingMemberships: [{org, name, invitedBy, invitedAt}]` | M2-06 |
| `admin.ms.create` | creates the applicability entries of D2-09 in the same transaction (seeder of M2-03), owner unset, status `not_started` | M2-06 |
| `audit-events.create` | event type `internal_audit`; permission becomes `permissionBy` on the body member `eventType`: `internal_audit` needs `internal_audit.manage` [MM, IA], every other type `audit_event.manage` [MM] (M2-02 adds `source: 'body'` to `PermissionByMember` when the guard lacks it); body takes `scopeText` and `reportDocumentId`; the first `stage1` or `recertification` event with no open cycle creates or activates the cycle (D.4) | M2-02 (permission), M2-05 (behaviour) |
| `audit-events.update` | `anyOf` [`audit_event.manage`, `internal_audit.manage`], because the body carries no event type; the service refuses with 403 when the event is not `internal_audit` and the caller holds only `internal_audit.manage`; takes `scopeText` and `reportDocumentId` (attach report) | M2-02 (permission), M2-05 (behaviour) |
| `audit-activities.generate`, `audit-activities.update` | `anyOf` [`audit_event.manage`, `internal_audit.manage`] with the same event type check in the service; `audit-activities.update` takes `auditorHandle` and `targetCode` (clause or control); warning `AUD-INDEP` when the auditor owns an entry, document or evidence of that target | M2-02 (permission), M2-05 (behaviour) |
| `findings.create`, `findings.update`, `findings.list` | `targetCode` (a code from `applicability.targets`) stored in `finding.target_code` next to the free-text `clauseRef`; `findings.list` filters by `targetCode` | M2-02 (schema), M2-05 (behaviour) |
| `admin.packs.import`, `admin.packs.list` | M2-02 checks in wave 1a that both accept a platform operator session with no membership in multi tenancy (`pack.install` platform scope), as `PUT /admin/license` does, and changes the schema or the guard there if they do not | M2-02 |
| `ms.transition` | machine row `implementing -> certified` points to `ms.certification` | M2-02 (machine), M2-05 (behaviour) |
| `applicability.transition`, `applicability.update` | `not_applicable` refused with 422 rule `APPL-ASSESS` when the pack row has `applicability_assessable = false` | M2-07 |
| `documents.create`, `documents.update` | `origin` (`internal` default, `external`), `externalSource`, `externalRef`, `receivedAt` | M2-07 |
| `documents.versions` | optional `changeSummary` (up to 500 characters) | M2-07 |
| `registers.list`, `registers.create`, `registers.update` | register kinds `objectives` (table `quality_objective`) and `competence` (table `competence_record`); `registerPermission` gains the cases `objectives` and `competence`, both `register.manage` (own rows, owner required), and the F.6 condition text of `register.manage` names the two kinds (J.2) | M2-02 (permission), M2-07 (behaviour) |
| CLI `admin create-user` | sends the invitation email when mail is configured; prints the link as a fallback | M2-06 |

### D.3 Schema, enums and permissions

M2-02 writes all of it in wave 1a, except the ref migration change named below (M2-03, wave 1b).

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
  - New `competence_record` (standard tenant columns, `user_id`, `role_title`, `competence_required`, `proof_type` in `certificate`, `training`, `experience`, `assessment`, `storage_object_id`, `achieved_at`, `valid_until`, `verified_by`, `owner_user_id`) linked to systems through `entity_ms_link`, with RLS as every tenant table.
  - New `import_run` (`management_system_id`, `kind`, `file_name`, `file_sha256`, `status` in `validated`, `committing`, `committed`, `failed`, `expired`, `row_count`, `results jsonb`, `background_task_id`, `committed_at`; unique on `(management_system_id, kind, file_sha256)` where `status = 'committed'`).
- Kysely types: the columns in the existing group files, the three new tables in `apps/server/src/db/types/tenant-m2.ts`.
- `packages/shared/src/enums.ts`: `AUDIT_EVENT_TYPES` adds `internal_audit`; permissions `internal_audit.manage` and `ops.tenants.manage`; notification kinds `membership_invited`, `certificate_expiring`, `import_finished`, `pack_content_updated`; job names `readiness.recompute`, `certificate.expiry`, `import.run`, `applicability.sync`; audit actions `ms.certified`, `certification_cycle.created`, `certification_cycle.expired`, `certification_cycle.closed`, `org.updated`, `freshness_threshold.changed`, `auth.recovery_codes_regenerated`, `membership.declined`, `holdings.reassigned`, `import.validated`, `import.committed`, `ops.organization_created`, `applicability.seeded`, `pack.content_synced`, `document_code.linked`; problem slug `not-implemented` (501); platform rule ids `APPL-ASSESS` and `PACK-ROW-REMOVED` and warning rule id `AUD-INDEP`.
- `packages/shared/src/authz/matrix.ts`: `internal_audit.manage: ms([MM, IA])`, `ops.tenants.manage: platform([OP])`.
- `packages/shared/src/machines.ts`: the certification cycle machine (`planned -> active -> certified -> expired | closed`, `certified -> suspended -> certified | withdrawn`, `certified -> closed` when the next cycle is certified) with owner `M2-02`, and the row change of D.2.
- `packages/shared/src/api/risk-registers.ts`: `REGISTER_KINDS` adds `objectives` and `competence`.
- `AUDIT_EVENT_TYPES` also types `ref.audit_activity_template.event_type`, so M2-03 adds `internal_audit` to that CHECK in `apps/server/migrations/ref/0002_milestone2.sql` (wave 1b), and the pack schema accepts internal audit activity templates; J.7 lists both columns.
- UI contract: requirement-type entries of catalogue systems get the key `cl-<code>` (D2-09) in the UI contract types of `packages/shared/src/api/**` and in `docs/platform/ui-contract.md`.
- Permission changes on existing routes: as D.2 (`audit-events.create`, `audit-events.update`, `audit-activities.generate`, `audit-activities.update`, `registers.*`). After wave 1a no package changes a permission (R-14).
- Jobs: the four new jobs are registered in the worker module in wave 1a, each with a stub handler file in the folder of the package that builds it: `modules/packs/applicability-sync.job.ts` (M2-03), `modules/implementation/readiness/readiness-recompute.job.ts` and `modules/notifications/certificate-expiry.job.ts` (M2-05), `modules/imports/import-run.job.ts` (M2-08).
- J lists every enum value, permission row, job, notification kind, audit action, rule id, CHECK list and machine above in the formats the shared tests parse.

### D.4 Certification lifecycle

- Cycle creation: on the first `stage1` or `recertification` event with no open cycle (`planned` or `active`), or on `ms.cycles.create` (`{cycleStart, cycleEnd}`; `cycleEnd` defaults to three years later), in one transaction: insert the cycle (`active`), copy the active edition's `ref.cycle_requirement_def` rows into `cycle_requirement_status` (owner the primary MS Manager, due before the next audit event), link events of the system whose `certification_cycle_id` is null. When the system already has a `planned` cycle (every seeded system that is not certified), the first `stage1` event activates it (`planned -> active`) and copies the cycle items, instead of inserting a new cycle. The unique index of D.3 allows one open cycle; a `certified` cycle does not count as open.
- Recertification: a certified system keeps its `certified` cycle while the recertification audit runs. The first `recertification` event creates the next cycle (`active`) next to it. When `ms.certification` records the new certificate, the old cycle moves to `closed` (audited `certification_cycle.closed`) and the new one to `certified`.
- `ms.certification` body `{certificateNo, issuedAt, expiresAt, certificationBody, certifiedScope?}`: needs status `implementing` (first certificate) or `certified` (recertification), an open cycle and a `stage2` or `recertification` event in it with outcome `recommended` or `recommended_with_conditions`. Sets the cycle to `certified` with the details, the system to `certified`, closes the previous certified cycle, audits `ms.certified`. The certificate label of the read model comes from the newest certified cycle.
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

It writes `source = 'computed'` and never overwrites `source = 'manual'`. The demo seed writes its rows as `manual`, so the demo keeps its numbers.

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

After an installation that updates an edition in use, the installer queues `applicability.sync` for each organisation with a system on that edition. It adds entries for new catalogue items and leaf requirements (`not_started`, unassigned), adds cycle items for new cycle requirements to open cycles, never deletes, and sends `pack_content_updated` to the MS Managers with the added, retitled and retired codes. The job is idempotent and audited as `pack.content_synced`.

### E.4 Demo text out of release content

The pack content drops demo facts from prep tasks and cycle titles (`NC-2025-02`, `SoA v3.0`, `SharePoint`, `DC Jakarta`, "Internal audit 2026 report") and the ISO 9001:2026 activity phase 9 "ISO 9001:2026 transition". The sample keeps its own wording where the demo needs it. M2-18 adds these strings to the release artefact check.

## F. Testing in Milestone 2

| Layer | What each package adds |
|---|---|
| Server integration | `apps/server/test/int/<area>/**` for the package's routes and jobs: success, every business rule, scope policy, audit entry, `If-Match` |
| Shared contract | `packages/shared/test/{routes,enums,authz,machines}.test.ts` compare the code with the plan tables. M2-02 makes `helpers.ts` read BP and section J of this plan, so the tests stay as strict as in Milestone 1 |
| Contract, RBAC, security | M2-02 adds the routes and matrix rows; the generated sweeps cover them. Record-table entries and RBAC expectations of each building package live in `security/record-tables/M2-nn.ts` and `rbac/expectations/M2-nn.ts`, merged by the sweeps. Building packages delete their `m2-pending` file and run `test/int/rbac test/int/contract test/int/security` |
| Web unit | `apps/web/test/screens/<screen>.test.tsx` (run because `vitest.config.js` includes `.tsx`, C.7; each run must report at least one test, G.1): `renderToStaticMarkup` in both languages and both themes, adapter tests with the fake fetch of `test/auth/helpers.ts` (method, path, body, `X-CSRF-Token`, field errors kept), route contract test |
| Web E2E sample | `apps/web/e2e/screens/<screen>.spec.js`, tagged `@sample-only` unless written to pass in both modes (D2-04), opened with `openScreen` and the `sampleRole` of `meta.json` (C.2) |
| Web E2E API | `apps/web/e2e/api-only/<screen>.spec.js`, tagged `@api-only`, with the `apiSession` option (`tenant.admin` for admin screens, `rina` for manager flows, `maya` for internal auditor flows, `hendra` for top management, `bagus` for owner flows, `ops` for the operator console). Each spec opens every form and drawer and calls `expectOverlayReadable` in light and dark |
| Contrast | `e2e/contrast.spec.js` and `e2e/i18n.spec.js` cover every host screen through `meta.json`, `sampleRole` and the `?screen=` opener of sample builds (C.2, C.7), including screens with `nav: false` |
| Journey | `tools/smoke/tests/fresh-org.spec.mjs` (M2-18) |

## G. Work packages

### G.1 Waves

A wave starts when every package of the previous wave is done and committed (R-10). Inside a wave at most four packages run at once (R-02). Packages in one wave own disjoint paths. API E2E and Compose runs take the host lock (R-05).

| Wave | Work packages | Lockfile owner | Owners of shared files in this wave |
|---|---|---|---|
| 1a | M2-02 Server contract, schema and permissions | none | `packages/shared/src/api/*`, `enums.ts`, `authz/matrix.ts`, `machines.ts`, `index.ts`, `packages/shared/test/**`, tenant migrations, DB types except `ref.ts`, `apps/server/src/app/*.module.ts`, module files that register new controllers and jobs, the stub job files of D.3, contract snapshot, RBAC and security sweep files, `docs/platform/ui-contract.md`: M2-02 |
| 1b | M2-01 Web screen host and Administration area; M2-03 Pack format and upgrade path | M2-03 (server version only) | web controller, converter, generated views, `styles.css`, `vitest.config.js`, `e2e/helpers.js`, shared E2E specs, `controller.test.ts`, `SampleDataSource.js`, `data/api/**`, `auth/boot.tsx`: M2-01. `packages/shared/src/pack/**`, ref migration, `apps/server/package.json`, lockfile: M2-03 |
| 2 | M2-04 Pack content; M2-05 Certification, internal audit and readiness server; M2-06 Onboarding, accounts and operator server; M2-07 Document control and register server additions | none | `mscd-data.js`, seed snapshot, mock fixture, the Milestone 1 specs listed in M2-04: M2-04. `apps/server/src/modules/jobs/schedules.ts`, `apps/server/src/seed/**`, the command helpers of D.6: M2-05. `docs/INSTALL-ONPREM.md`, `deploy/scripts/install.sh`, `modules/jobs/scheduler-tick.job.ts`: M2-06. Area files: as listed per package (R-14) |
| 3 | M2-08 Bulk import; M2-09 Storage and management system administration; M2-10 People, roles and sign-in; M2-11 Controls, evidence and phases forms; M2-12 Document control screens; M2-13 Registers screen; M2-14 Audit registers screens; M2-15 Certification timeline and auditor workspace; M2-16 Getting started, account, notifications and operator console | none | `packages/shared/src/api/imports.ts` and `apps/server/src/modules/imports/**`: M2-08. Otherwise none (each package owns only its folders) |
| 4 | M2-17 Terminology (gated on H.1) | none | may edit any web text, the template and the converter, pack labels and docs (alone in the wave) |
| 5 | M2-18 Fresh-organisation journey and release check | none | `tools/smoke/**`, `docs/INSTALL-ONPREM.md`, `project/MSCD User Guide.dc.html`, `deploy/scripts/check-release-artefacts.sh` |

Wave 1a runs alone because M2-01 and M2-03 build on its route ids, enum values, job names and module registration, and R-10 commits only at the end of a wave.

When H.1 has no answer by the end of wave 3, wave 5 runs first, and M2-17 runs later followed by the M2-18 acceptance again. Without M2-17 the product still shows each of the eight business roles under its own label and the readiness block as "Internal progress score" (M2-01), in the current product words.

Common acceptance for every package (not repeated below): `npm run typecheck`, `npm run lint` and `npm test` pass; `npm run check:text` passes; `npm run test:int -w @mscd/server -- test/int/seed test/int/parity` and `CI=1 npm run test:e2e -w @mscd/web` pass (R-15); web packages also pass `npm run gen:views:check -w @mscd/web`, and each of their unit test commands reports at least one test (the zero-test check of M2-01, with the package's own test files); the handoff note exists (R-09).

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
- Readiness block: label "Internal progress score" with the one-line method text of D.6 ("Average of documents in place, entries implemented, evidence fresh and metrics current per clause"), through a converter `PATCH`, in both languages (D2-11, H.2 default).
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
| Owns | `packages/shared/src/api/**` (including the new `imports.ts` and the UI contract types), `packages/shared/src/{enums.ts,machines.ts,examples.ts,index.ts,openapi.ts}`, `packages/shared/src/authz/**`, `packages/shared/test/**`, `apps/server/migrations/tenant/0008_milestone2.sql`, `apps/server/src/db/types/*` except `ref.ts`, `apps/server/src/app/*.module.ts`, the `*.module.ts` and controller files named in D.1, the guard file that reads `permissionBy` (body source), `apps/server/src/modules/imports/**` (skeleton), the stub job files of D.3, `apps/server/test/int/{contract,rbac,security,db}/**`, `apps/server/test/int/m2-pending/**`, `docs/platform/ui-contract.md` |

Brief:
- Every route of D.1 with zod schemas, examples and OpenAPI output; the schema and permission changes of D.2 on existing routes; D.3 in full; the `cl-` key of D2-09 in the UI contract types and in `docs/platform/ui-contract.md`.
- Stub handlers behind `@ApiRoute` answering 501 with the problem slug `not-implemented`; new controllers registered in their module files; the `imports` module registered in the api and worker modules; the four new jobs registered with stub handler files (D.3).
- `admin.packs.import` and `admin.packs.list` from a platform operator session in multi tenancy (D.2): check, and fix the schema or guard here when they refuse it.
- Plan-anchored shared tests: `packages/shared/test/{routes,enums,authz,machines}.test.ts` compare the code with tables parsed from `docs/platform/BUILD-PLAN.md`. `packages/shared/test/helpers.ts` reads BP and section J of this plan and merges them (J overrides a BP CHECK list of the same column). `WORK_PACKAGE_IDS` and the owner types of `RouteDef.owner` and `Machine.owner` (today `WP-${string}`) also accept `M2-01` to `M2-18`, read from the `#### M2-nn` headings of this plan. New route owners are the building package of D.1. The `RULE_IDS` length check becomes the sum of both plans (57 plus 3). `PROBLEM_SLUGS` gets `not-implemented` 501, and the D.1 count of 17 becomes 18. No assertion is removed or loosened.
- `m2-pending/M2-05.json` to `M2-08.json` with the route ids each package builds; the WP-30 contract harness declares 501 for listed routes, and the RBAC, owner-scope and external auditor sweeps read them (D.1).
- Split the sweep data so later packages do not share one file: `security/record-tables.ts` and `rbac/expectations.ts` merge `security/record-tables/M2-nn.ts` and `rbac/expectations/M2-nn.ts` (one file per building package, M2-05 to M2-08). Record-table entries for every new GET route go in the file of its building package, so the owner-scope sweep checks them once the stubs are replaced.
- Contract snapshot updated once for the 27 new route ids. Schema drift test passes with the new columns and tables.
- Existing behaviour unchanged: no Milestone 1 route answers differently.

Acceptance:

```bash
npm test -w @mscd/shared
git diff --quiet HEAD -- docs/platform/BUILD-PLAN.md
npm run openapi
npm run test:int -w @mscd/server -- test/int/db test/int/contract test/int/rbac test/int/security
npm run test:int -w @mscd/server
test "$(ls apps/server/test/int/m2-pending/*.json | wc -l)" -eq 4
test "$(ls apps/server/test/int/security/record-tables/M2-*.ts apps/server/test/int/rbac/expectations/M2-*.ts | wc -l)" -eq 8
node -e "const s=require('fs').readFileSync('apps/server/test/int/contract/__snapshots__/routes.test.ts.snap','utf8');for(const id of ['ms.certification','admin.onboarding','imports.commit','records.holdings.reassign','applicability.targets','documented-info.link','ops.users.reset-mfa'])if(!s.includes(id+' '))process.exit(1)"
```

#### M2-03 Pack format and upgrade path

| | |
|---|---|
| Wave, depends on | 1b; M2-02 |
| Lockfile owner | yes, for the server version 1.1.0 only |
| Owns | `packages/shared/src/pack/**`, `packages/pack-tools/**`, `packs/scripts/**`, `packs/README.md`, `packs/content/**`, `packs/sources/**`, `apps/server/migrations/ref/0002_milestone2.sql`, `apps/server/src/db/types/ref.ts`, `apps/server/src/modules/packs/**` (including the stub `applicability-sync.job.ts`), `apps/server/src/modules/implementation/applicability-seed.ts` (new), `apps/server/package.json` (version), `package-lock.json`, `apps/server/test/int/packs/**`, `apps/server/test/int/pack-upgrade/**` (new) |

Brief:
- E.1 in full, with `engine_min_version` 1.1.0, the server version 1.1.0, the `removed.csv` marker and `clauseEvidenceMissing` in `--json`.
- `ref/0002_milestone2.sql` also adds `internal_audit` to the `ref.audit_activity_template.event_type` CHECK (D.3).
- No content change and no sample change: the clause 10 fixes go to M2-04 (E.2), so `mscd-data.js`, the seed snapshot and the Milestone 1 specs stay as they are in this package.
- `applicability-seed.ts`: `seedApplicability(trx, msId)` creates the D2-09 entries, skips retired rows and existing entries, and is used by `applicability.sync` (E.3) and by M2-06 at system creation.
- `applicability.sync` job (filling the stub of M2-02) and the retry of skipped mappings (E.3).
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

`test/int/pack-upgrade` installs the Milestone 1 packs into an organisation with systems, then a fixture version built from them that marks 10.3 retired, retitles 10.1 and adds one leaf row, and checks: no row deleted, 10.3 retired and hidden from `applicability.targets` data, entries added for the new row, `pack_content_updated` sent once, a second run adds nothing, a pack that drops a code without `retired` is refused with 422 `business-rule` and rule `PACK-ROW-REMOVED`, a pack that drops an activity template is accepted.

#### M2-04 Pack content

| | |
|---|---|
| Wave, depends on | 2; M2-03 |
| Owns | `packs/content/**`, `packs/sources/**`, `packs/README.md`, `apps/web/src/data/mscd-data.js`, `apps/server/src/seed/demo/sample-snapshot.json`, `tools/mock-providers/fixtures/demo.json`, `apps/server/test/int/packs/**`, `apps/server/test/int/parity/**`, `apps/web/e2e/{audit,calendar,chain,display,documents,framework,freshness,golden-thread,i18n,mytasks}.spec.js`, `apps/web/test/sample-source.test.js` |

Brief:
- E.2 for all six packs, written as content tables in `packs/content/<pack_id>/`: requirement rows with `parent_code`, documented information, document templates (covering the 13 activity output codes, plus `SCO-01` Scope statement for requirement 4.3 and the matching scope template of each other pack), review inputs, Annex A links, Annex A evidence examples and an evidence example for every leaf clause row, assessable flags, derivation JSON, ISO 37001 chain fixes.
- Clause 10 per standard (packs research "Clause 10 numbering per standard"): retitle and mark retired, never delete; ISO 37001:2016 retires 6.3. The `HS9` list of `mscd-data.js` changes with the packs so sample and pack agree, then the seed snapshot and mock fixture are regenerated with `node apps/web/scripts/export-sample-snapshot.mjs`. The Milestone 1 specs and `sample-source.test.js` in Owns get the new counts, readiness numbers and labels, with the reason per spec in the handoff note (R-15).
- Activities: 6.7 and 6.8 reworded to name the document types they produce; 2.3 and 2.6 get an `output_document_code` (scope statement, risk treatment plan); 3.4 completes from the objectives register, 7.2 from the competence register, 4.9 from its output document (E.2). This is pack content and does not wait for H.1.
- Demo text out of the pack prep tasks and cycle titles (E.4), and the ISO 9001:2026 phase 9 activity dropped through `removed.csv` (E.1).
- Document code clashes of the gap study (`PRC-05`, `POL-01` against `QM-01`, `POL-B01`, `POL-A01`): template codes are unique per pack, and activity output codes match the sample's codes where the demo links them. A customer's own codes are handled by `documented-info.link` (D.1, M2-07).
- `packs/README.md`: the lead auditor sign-off table of E.2, with every pack listed and no sign-off yet.
- Second version bump, the minor step of E.3. ISO37001 statuses stay as they are until H.6 is answered.

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
| Wave, depends on | 2; M2-02, M2-03 |
| Owns | `packages/shared/src/api/{admin-ms,audit-events}.ts` (schemas only, R-14), `apps/server/src/modules/management-systems/certification.*`, `apps/server/src/modules/registers/audit-events.service.ts`, `apps/server/src/modules/audit-registers/{internal-audit.controller.ts,audit-activities.service.ts,cycle-derive.service.ts,cycle-derive.job.ts}`, `apps/server/src/modules/implementation/readiness/**` (new), `apps/server/src/modules/notifications/certificate-expiry.job.ts` (new), `apps/server/src/modules/implementation/command-support.ts`, `apps/server/src/modules/registers/command-support.ts`, `apps/server/src/modules/risk-registers/support.ts`, `apps/server/src/modules/audit-registers/{findings.service.ts,corrective-actions.service.ts}`, `apps/server/src/modules/read-model/derive/{overview.ts,ms-fields.ts}`, `apps/server/src/modules/jobs/schedules.ts`, `apps/server/src/seed/**` except `seed/demo/sample-snapshot.json`, `apps/server/test/int/certification/**` (new), `apps/server/test/int/security/record-tables/M2-05.ts`, `apps/server/test/int/rbac/expectations/M2-05.ts`, `apps/server/test/int/m2-pending/M2-05.json` (deletes) |

Brief:
- D.4 in full: cycle creation (automatic and `ms.cycles.create`), activation of an existing `planned` cycle by the first `stage1` event, recertification next to a certified cycle and the move of the old cycle to `closed`, `ms.certification`, `ms.cycles.list`, certificate label from the cycle, `certificate.expiry` job, new derivation kinds.
- Internal audit: `internal_audit` events with `scope_text` and `report_document_id`, created by MS Managers and Internal Auditors (`internal_audit.manage`, D.2); the event type check in the services of `audit-events.update`, `audit-activities.generate` and `audit-activities.update` for callers who hold only `internal_audit.manage`; audit activities with auditor and target and the `AUD-INDEP` warning; `internal-audit.programme` coverage view (clauses 4 to 10 and applicable controls, the internal audit events and activities that covered each in the cycle, and the uncovered ones).
- Findings: store `finding.target_code` on create and update and filter `findings.list` by `targetCode` (D.2).
- D.6 readiness recompute with its schedule; `readiness.recompute` and `cycle.derive` queued next to every `freshness.recompute` call in the three command helpers, and after finding and corrective action commands; overview derivation reads the four stored dimensions and drops the fixed offsets; the seed writes demo readiness rows as `manual` and demo cycles with expiry dates that keep the sample certificate labels.

Acceptance:

```bash
npm run test:int -w @mscd/server -- test/int/certification
npm run test:int -w @mscd/server -- test/int/audit-registers test/int/commands test/int/jobs test/int/management-systems
test ! -e apps/server/test/int/m2-pending/M2-05.json
npm run test:int -w @mscd/server -- test/int/rbac test/int/contract test/int/security test/int/seed test/int/parity
npm run test:int -w @mscd/server
```

`test/int/certification` covers: the first stage1 event creates one cycle and its items, or activates the `planned` cycle of a seeded system; a second open cycle is refused; a recertification event on a certified system opens the next cycle, and its certificate closes the old one; `ms.certification` refused without a recommended stage2 outcome, accepted with it, sets both statuses, audits; expiry notices at 90, 30 and 7 days with a fixed clock, lapse to `expired`; `internal_audit` event by an Internal Auditor accepted, by a Domain Owner refused; an Internal Auditor can generate and edit activities and attach a report on an `internal_audit` event and is refused on a `stage1` event; `AUD-INDEP` warning; findings filtered by target code; programme coverage; readiness for a fresh system with no rows is null per group, rises after an entry is verified, and leaves `manual` rows alone.

#### M2-06 Onboarding, accounts and operator server

| | |
|---|---|
| Wave, depends on | 2; M2-02, M2-03 |
| Owns | `packages/shared/src/api/{admin-users,me,notifications,ops,license}.ts` (schemas only), `apps/server/src/modules/admin-users/**`, `apps/server/src/modules/authz/{me.controller.ts,me.service.ts,me-assembler.ts}`, `apps/server/src/modules/identity/recovery-codes.*`, `apps/server/src/modules/identity/{invitation.service.ts,mail-templates.ts}`, `apps/server/src/modules/notifications/{notifications.controller.ts,notifications.service.ts}`, `apps/server/src/modules/ops/**`, `apps/server/src/modules/management-systems/management-systems.service.ts`, `apps/server/src/modules/jobs/scheduler-tick.job.ts` (M2-05 keeps `schedules.ts`), `apps/server/src/cli/{admin.ts,tenant.ts,license.ts}` (new `license.ts` registered in the commander program of `apps/server/src/program.ts`), `apps/server/src/program.ts`, `deploy/scripts/install.sh`, `deploy/helm/mscd/templates/admin-job.yaml` (new), `deploy/helm/mscd/values.yaml` (the `adminJob` block), `deploy/helm/mscd/ci/{validate.sh,assert-render.mjs}`, `docs/INSTALL-ONPREM.md`, `apps/server/test/int/onboarding/**` (new), `apps/server/test/int/security/record-tables/M2-06.ts`, `apps/server/test/int/rbac/expectations/M2-06.ts`, `apps/server/test/int/m2-pending/M2-06.json` (deletes) |

Brief:
- Routes and changes of D.1 and D.2 marked M2-06, with D.5 including the steps `team`, `verifiers` and `internal_auditor` and the `doneBy` and `assignee` fields.
- `ops.users.reset-mfa`: finds the account by email, refuses with 404 when it has no factor set up, resets it as `admin.users.reset-mfa` does, ends the account's sessions, sends the security mail, audits `auth.mfa_reset` with the reason.
- `deploy/scripts/install.sh`: before it runs `tenant create`, it prints that the organisation slug can never be changed and asks for confirmation (skipped with `--yes`).
- `admin.ms.create` calls `seedApplicability` (D2-09) in its transaction and audits `applicability.seeded` with the count.
- `ops.organizations.create`: `{slug, name, timeZone, siteCount, firstAdmin: {email, displayName}}`, uses `TenantProvisioner.create`, creates the invitation, emails it when mail is configured and returns the link once only when it is not; warns in the response that the slug is permanent; in single tenancy answers 409 `conflict` with `messageKey` `single_tenancy`.
- CLI: `admin create-operator --email <email> [--name <name>]` and `admin revoke-operator --email <email>` (platform role `platform_operator`, one-time set-password link from token kind `set_password`, TOTP enrolment forced at first sign-in, audit entry); `license show-id` prints the installation id; `admin create-user` emails the invitation (D.2).
- Helm: an optional Job (`adminJob.enabled`) that runs `tenant create`, `admin create-user` or `admin create-operator` with values, documented in `docs/INSTALL-ONPREM.md` with the new CLI commands (open follow-up of `CLAUDE.md`).

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

`validate.sh` runs `helm` in a container (WP-29); M2-06 adds a render with `adminJob.enabled=true` and an assertion for the Job to `ci/assert-render.mjs`. `test/int/onboarding` covers every D.5 step on a fresh organisation, organisation update and time zone change, pending memberships with accept and decline, email and notification for an existing active account with the same 202 for the admin, recovery codes (old codes stop working, ten new ones, audit, security mail), read-all, operator organisation create in multi tenancy and 409 in single tenancy, operator factor reset for an account with two memberships, and system creation that seeds one entry per catalogue item plus one per leaf requirement row of the installed ISO 27001 pack, with the expected count computed from the installed pack (M2-04 runs in the same wave; the literal 93 plus 30 is checked in M2-09 and M2-18).

#### M2-07 Document control and register server additions

| | |
|---|---|
| Wave, depends on | 2; M2-02, M2-03 |
| Owns | `packages/shared/src/api/{implementation,documents,files,records,risk-registers,audit-registers}.ts` (schemas only), `apps/server/src/modules/implementation/{targets.controller.ts,freshness-thresholds.*,documented-info.*,applicability.service.ts,rules/**}`, `apps/server/src/modules/freshness/**`, `apps/server/src/modules/registers/{document-versions.controller.ts,holdings.*,documents.service.ts,records.service.ts}`, `apps/server/src/modules/files/**`, `apps/server/src/modules/risk-registers/**` except `risk-registers/support.ts` (M2-05), `apps/server/src/modules/audit-registers/{review-edit.controller.ts,management-reviews.service.ts}`, `apps/server/src/modules/read-model/load/**`, `apps/server/src/modules/read-model/derive/requirements.ts`, `apps/server/test/int/records-extra/**` (new), `apps/server/test/int/security/record-tables/M2-07.ts`, `apps/server/test/int/rbac/expectations/M2-07.ts`, `apps/server/test/int/m2-pending/M2-07.json` (deletes) |

Brief:
- Routes and changes of D.1 and D.2 marked M2-07.
- `applicability.targets` for the Add control form and the import resolver.
- Freshness thresholds per frequency and system: aging at least 1, expired at least aging (as the database check), upsert on the unique index, soft delete on reset, audit before and after, `freshness.recompute` queued. Organisation-wide defaults are not set on screen (B).
- Pack code links: `documented-info.link` writes `document_code_link`. BR-40 (`implementation/rules/activity.rules.ts`) and the documented information list resolve a pack document code to the document with that code, else to the linked document, so a customer that keeps its own codes can complete activities 3.1, 3.3 and 3.5.
- Documented information list: per `ref.documented_info` row, the linked document (by template code, by `document_code_link`, or by the applicability entry's implementing documents) with status, review date and owner, or for `retain` rows the evidence items of the clause with freshness. States `missing`, `draft`, `in_review`, `approved`, `review_overdue`, `fresh`, `out_of_date`.
- Document versions list with the scope policy that hides restricted documents.
- Holdings: every open item kind a person can hold (applicability entries, activities, documents as owner or approver, evidence, risks, treatments, findings, corrective actions, prep tasks, cycle items, register rows, stored tasks), reassign in one transaction with per-record warnings and audit.
- Register kinds `objectives` and `competence` with own-row rights (`register.manage` own), owner required, `valid_until` reminder through the existing task-overdue path.
- Management review PATCH. `APPL-ASSESS` rule.
- The read model loader exposes clause entries of catalogue systems with the key `cl-<code>` (D2-09, `requirementKey` in `derive/requirements.ts`), document origin and change summary in the snapshot. A read model test checks that no two entries of one system share a key, for the seeded demo and for a fresh ISO 27001 system with clause entries.

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
| Wave, depends on | 3; M2-01, M2-02, M2-07 (the resolver reads `applicability.targets` and the commit calls the command services M2-07 changes) |
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
| Wave, depends on | 3; M2-01, M2-02, M2-04, M2-06, M2-07 (the Controls count of the API spec needs the content, the seeding at system creation and the clause entries of the loader) |
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
| Wave, depends on | 3; M2-01, M2-06, M2-07 |
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
| Wave, depends on | 3; M2-01, M2-04, M2-07 |
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
| Wave, depends on | 3; M2-01, M2-04, M2-07 |
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
| Wave, depends on | 3; M2-01, M2-07 |
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
| Wave, depends on | 3; M2-01, M2-05, M2-07 |
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
| Wave, depends on | 3; M2-01, M2-05, M2-07 |
| Owns | `apps/web/src/screens/{timeline-edit,auditor-access,audit-trail}/**`, their tests in `apps/web/test/screens/`, `apps/web/e2e/screens/` and `apps/web/e2e/api-only/` |

Brief:
- `timeline-edit` claims `timeline.addEvent`: "Add audit event" (type, names in both languages, short label, date, audit days, lead auditor, preparation window), detail extension for `event`: "Edit" (the BR-42 count of notified holders in the toast), "Record result" (outcome, summary), and for certification audit events (`stage1`, `stage2`, `surveillance`, `recertification`) the activity list with "Generate activities" (`audit-activities.generate` from the pack's audit activity templates such as AA-S1 and AA-S2) and "Edit activity"; for `prep` and `cycle`: "Mark done", "Reassign or change due date" (BR-43). Page actions "Start certification cycle" (when none is open) and "Record certificate" (certificate number, issued, expires, issuing body, certified scope; enabled after a recommended outcome), certificate panel with the expiry date.
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
| Wave, depends on | 3; M2-01, M2-06 |
| Owns | `apps/web/src/screens/{getting-started,organization,account,notifications,invitations,ops}/**`, `apps/web/src/screens/license/**` (installation id panel), their tests in `apps/web/test/screens/`, `apps/web/e2e/screens/` and `apps/web/e2e/api-only/` |

Brief:
- "Getting started" (`getting-started`, `/admin/getting-started`, group `admin`, order first, perm `ms.admin`): the D.5 steps as a checklist with state, count and a button to the screen that completes each; progress "n of m done"; the single-admin warning. Steps with `doneBy: 'ms_manager'` (`applicability`, `audit_dates`) are marked "For the management system manager", name the primary MS Manager from `assignee`, and their button opens a prepared email to that person (`mailto:` with the system name and the step) instead of a screen the administrator cannot use. `verifiers` and `team` show a warning while pending: with fewer than two people who can verify, no work in the system can reach Implemented (separation of duties). `internal_auditor` shows as optional.
- "Organisation" (`organization`, `/admin/organization`, perm `org.settings.manage`): name, time zone (IANA list), number of sites, slug read-only with "cannot be changed", installation id with "Copy" for licence requests. The Licence screen shows the installation id too.
- Top bar (`hostTopbar`): notification bell with the unread count (`GET /notifications?unread=true&pageSize=1`), panel with the list, "Mark read", "Mark all read", links to the record; "My account" entry.
- "My account" (`account`, `/account`, nav false): profile, "Change password" (hidden for SSO-only accounts), "Replace authenticator" (the existing enrolment page with a return path), recovery codes left and "Get new recovery codes" (current code, codes shown once with "Copy" and "Download"), linked company sign-in identities with "Link" (`me.identity.link`), one "Revoke calendar feed" button per system the user can read (`calendar-feed.revoke` is per system and no list route exists), preferences (language, theme, density) saved with `PUT /me/preferences` and applied at once (boot applies them on the next start, M2-01).
- `invitations`: banner in the host layer "You were invited to <organisation>" with "Accept" (LIC-USERS message) and "Decline".
- "Operator console" (`ops`, `/ops`, group `ops`, scope `platform`, perm `ops.read`): health (components, migrations, queues, licence states), queue statistics, "Run job" for allow-listed jobs, "Download diagnostics", organisations list, "Create organisation" (slug with the permanence warning, name, time zone, sites, first administrator email and name; the one-time link when mail is off), "Install licence" for an organisation (multi tenancy, `PUT /admin/license` with `{org, licence}`), "Framework packs" with the installed pack list (`admin.packs.list`) and "Install pack" (signed `.bundle` upload to `admin.packs.import`, progress through the task id, signature and engine version errors shown next to the field), so SaaS organisations get new pack versions (E.3) without the command line, and "Reset sign-in factor" (email and reason, `ops.users.reset-mfa`) for accounts with several memberships.

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
| Wave, depends on | 4; M2-10 to M2-16; product owner approval of H.1 |
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
| Wave, depends on | 5; every other M2 package (M2-17 when approved) |
| Owns | `tools/smoke/**`, `docs/INSTALL-ONPREM.md`, `project/MSCD User Guide.dc.html`, `deploy/scripts/check-release-artefacts.sh`, `deploy/compose/config/demo-licences/**` texts if present, `docs/platform/handoff/M2-18.md` |

Brief:
- `tools/smoke/run-journey.mjs` and script `journey` in `tools/smoke/package.json`: the on-premise Compose file with the server demo image (development keys accepted) and an overlay that turns the demo seed off, plus Mailpit and the mock providers. The database holds no organisation until the journey runs `tenant create` and `admin create-user` (the installer step, A.2). A licence for the new organisation id is signed at run time with `node packages/pack-tools/dist/cli.js licence sign` and the development licence key.
- `tools/smoke/tests/fresh-org.spec.mjs`, one browser session per person, every step on screen: first admin accepts the invitation and enrols TOTP; installs the licence; invites a second admin and the team (emails read from Mailpit); second admin approves grants; connects a SharePoint repository on the mock and tests it; adds a routing rule; sets local sign-in to "admins only" after a company sign-in test; creates an ISO 27001 system with scope, body and default repository; grants MS Manager (primary), Top Management, Domain Owner and Internal Auditor; starts implementation; plans Stage 1 and Stage 2 events; Getting started shows every step done; imports justifications for 10 controls and edits one control on screen; registers POL-01 from the template, uploads a file, approves it as another person; defines evidence on A.5.1 with a file and verifies the control; records a risk with a treatment and residual acceptance; plans and records an internal audit with an activity; raises a finding and closes a corrective action with an effectiveness check by a third person; holds and closes a management review with all inputs; records the Stage 2 outcome and the certificate; checks that the readiness numbers on Overview moved above 0 and that the system shows as certified with its expiry date. The journey fails on any page error, console error or 5xx answer, and runs `expectReadableText` on every new screen it visits.
- SaaS variant (`--saas`): `admin create-operator`, the operator creates the organisation in the console and installs its licence there (`PUT /admin/license` with `{org, licence}`, because `license.manage` and `pack.install` belong to the platform operator in multi tenancy), the Licence screen shows no "Install licence" to the Tenant Admin, then the same steps up to the system creation.
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
| H.1 | Approve the terminology renames: Tenant Admin to "Organisation administrator"; MS Manager to "Management system manager" (or "ISMS Manager", "QMS Manager" per system); Programme Owner to "Executive sponsor"; Domain Owner to "Control or process owner"; External Auditor to "Certification auditor (guest)"; Compliance Investigator to "Investigation officer"; Holder to "Assigned to"; Gate to "Checkpoint"; Phase board to "Implementation plan"; Chain stages to "Open items by trace step"; Golden Thread Viewer to "Traceability viewer"; sidebar group Surveillance to "Ongoing monitoring" (surveillance audit stays for certification body visits); Expired for documents to "Review overdue"; Expired for evidence to "Out of date"; Verified for files to "File unchanged"; Tier to "Document type". Which ones, and which wording in Indonesian? | No rename; M2-17 waits | M2-17 |
| H.2 | Readiness: are the four inputs of D.6 the right ones, and should the block say "Internal progress score"? | D.6 as written, with the label "Internal progress score" | M2-01, M2-05 |
| H.3 | A customer with one administrator: keep the second-administrator requirement for self-grants and admin grantees, or let the platform operator approve the first grant with an audit entry? | Keep the rule, warn on screen (D2-12) | M2-10 |
| H.4 | Internal Auditors verifying items and seeing everyone's pending list (open question 3 of `CLAUDE.md`), and Programme Owner verify and approve rights (open question 6): confirm the defaults, then the demo can match the live permissions | Confirmed by the product owner on 2026-10-27: Internal Auditors do not verify and do not see everyone's pending list; the Programme Owner keeps verify and approve rights | Milestone 3 |
| H.5 | Who may see competence records of other people: MS Manager, Programme Owner and Internal Auditor, plus each person for their own? | Yes | M2-07, M2-13 |
| H.6 | ISO 37001: keep 2016 withdrawn and 2025 as a pre-release with a beta notice, or ship 2025 as current with a `supersedes` date from the IAF decision once a lead auditor checks the content? The same check is needed for ISO 9001:2026 | Unchanged statuses | M2-04 |
| H.7 | Bulk import: all rows or none per file, or load good rows and report bad ones? | All or none (D2-13) | M2-08 |
| H.8 | Applicability entries created at system creation (D2-09): all 93 Annex A controls as applicable "not started", so the team excludes controls with a reason, or start empty and add from the pack? | Create all | M2-06 |
| H.9 | Scope: keep the scope text on the management system and add a "Scope statement" document (template SCO-01) linked to clause 4.3, or replace the text with the document? | Keep both; the document is the controlled version | M2-04, M2-12 |
| H.10 | Certificate expiry reminders at 90, 30 and 7 days to MS Managers and Programme Owners: right days and people? | Yes | M2-05 |
| H.11 | Who may plan internal audits: MS Manager and Internal Auditor? | Yes | M2-02 |
| H.12 | The operator console creates SaaS organisations. Should it also be offered on-premise, or stay hidden there? | SaaS (multi tenancy) only | M2-06, M2-16 |
| H.13 | Pending work per person (open question 2 of `CLAUDE.md`, with HR sign-off): MS Manager and Programme Owner see each person's open items, Top Management sees totals only. Confirm before the People and Handover screens show holdings per person | Confirmed by the product owner on 2026-10-27: MS Manager and Programme Owner see detail, Top Management totals only, Tenant Admin counts without titles | M2-07, M2-10 |

## I. Risks

| Risk | Effect | Handling |
|---|---|---|
| The foundation (M2-01) takes longer than planned or its extension points miss a need | Every wave 2 and 3 web package waits or edits shared files | M2-01 ships the probe screen and the Licence screen as proof; a missing extension point goes into a handoff note and the orchestrator runs a short fix package before wave 3 |
| Many route stubs answer 501 between waves | A tester or the demo hits "not implemented" | Stubs exist only in the API and answer the declared problem `not-implemented`; no screen calls a route before its server package is done (dependencies in G.1); the demo screens are unchanged |
| Pack content needs licensed copies of the standards and expert review | Wrong clause numbers or lists reach customers | Paraphrased short titles only; ISO 9001:2026 and ISO 37001:2025 marked "to confirm"; H.6; a lead auditor sign-off row per pack and version in `packs/README.md` (M2-04), which the release check of M2-18 requires |
| Content changes break parity tests and the demo | Milestone 1 tests go red | Sample data, seed snapshot and packs change in the same package (M2-03, M2-04); demo readiness rows become `manual`; R-15 |
| The installer never deletes and matches by code | A wrong code shipped once stays for every customer | The `retired` flag and the 422 check of E.1 land before any content change |
| `engine_min_version` 1.1.0 against image tags such as `smoke` or other non-numeric `MSCD_VERSION` values | Packs refused in test images | M2-03 checks how the version comparison treats such values and sets the image builds' `MSCD_VERSION` or the comparison accordingly, with a test |
| One host lock for API E2E and Compose runs | Packages queue for the lock in waves 2 and 3 | Run focused specs first, the full API suite once at the end of each package; four agents at most |
| Tenant migration 0008 is written before the code that uses it | Later packages find a column missing or wrong | R-14 lets the orchestrator apply a correction migration (`0009_milestone2_fix.sql`) between waves; no package edits 0008 after wave 1a |
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

### J.2 Permission matrix

| Permission | Scope | MM | PO | DO | RO | IA | TM | EA | CI | TA | SA | OP |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `internal_audit.manage` | ms | yes | | | | yes | | | | | | |
| `ops.tenants.manage` | platform | | | | | | | | | | | yes |

The BP row of `register.manage` keeps its cells; its condition text now reads "context, interested parties, assets, metrics, objectives, competence" (D.2).

### J.3 Jobs

| Job (owner) | Trigger | Schedule | Effect |
|---|---|---|---|
| `readiness.recompute` (M2-05) | the commands of D.6; `scheduler.tick` | 02:30 local, and 60 seconds after a command | D.6 |
| `certificate.expiry` (M2-05) | `scheduler.tick` | daily, local time | D.4 |
| `import.run` (M2-08) | `imports.commit` | none | applies every row in one transaction, audits `import.committed`, sends `import_finished` |
| `applicability.sync` (M2-03) | pack install that updates an edition in use | none | E.3 |

### J.4 Notifications

| Kind | Created by | Recipient | Digest |
|---|---|---|---|
| `membership_invited` | `admin.users.create` for an existing active account, `ops.organizations.create` | the invited person | no |
| `certificate_expiring` | `certificate.expiry` | MS Managers and Programme Owners | no |
| `import_finished` | `import.run` | the import creator | no |
| `pack_content_updated` | `applicability.sync` | MS Managers of systems on the edition | no |

### J.5 Audit actions

- Actions: `ms.certified`, `certification_cycle.created`, `certification_cycle.expired`, `certification_cycle.closed`, `org.updated`, `freshness_threshold.changed`, `auth.recovery_codes_regenerated`, `membership.declined`, `holdings.reassigned`, `import.validated`, `import.committed`, `ops.organization_created`, `applicability.seeded`, `pack.content_synced`, `document_code.linked`.

### J.6 Problems and rules

| Topic | Rule |
|---|---|
| Problem slugs | `not-implemented` 501 (a route stub of D.1 whose id is listed in `m2-pending`); added after the 17 slugs of BP D.1 |
| Errors | platform rule ids added to the extension member `rule`: `APPL-ASSESS`, `PACK-ROW-REMOVED` |
| Warnings | `AUD-INDEP` (auditor independence, D.2) |

### J.7 CHECK lists

Column fragments in the DDL notation of BP C.4 to C.6, for the tests; the migrations are `tenant/0008_milestone2.sql` and `ref/0002_milestone2.sql`.

```sql
CREATE TABLE audit_event (
  event_type varchar(20) NOT NULL CHECK (event_type IN ('stage1', 'stage2', 'surveillance', 'recertification', 'transition', 'special', 'internal_audit')),
);
CREATE TABLE ref.audit_activity_template (
  event_type varchar(20) NOT NULL CHECK (event_type IN ('stage1', 'stage2', 'surveillance', 'recertification', 'transition', 'special', 'internal_audit')),
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
```

### J.8 State machines

| Machine | Transitions |
|---|---|
| `certification_cycle.status` (M2-02) | (new) to `planned` or `active`: `audit_event.manage`, or system on the first `stage1` or `recertification` event. `planned` to `active`: system on the first `stage1` event, or `audit_event.manage`. `active` to `certified`: only through `ms.certification` with `ms.transition`. `certified` to `closed`: system, when the next cycle is certified. `certified` to `expired`: system (`certificate.expiry`). `certified` to `suspended` and back, `suspended` to `withdrawn`: `ms.transition`. `active` to `closed`: `ms.transition`, reason required |

The BP row `management_system.status` keeps its entity; its transition `implementing` to `certified` now runs through `ms.certification` (D.2).

## Review notes

No issue of the review was rejected. Two fixes differ from the suggestion:

- Storing and filtering `finding.target_code` goes to M2-05 instead of M2-07, because M2-05 owns `audit-registers/findings.service.ts` for the readiness queueing (D.6) and one file has one owner per wave.
- The Getting started button for the steps of the management system manager opens a prepared email to the primary MS Manager, because no notification kind for onboarding steps exists and R-14 allows no new enum value after wave 1a.
