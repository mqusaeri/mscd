# MSCD Milestone 3 Plan

| | |
|---|---|
| Purpose | The implementation plan for Milestone 3: decisions, server additions, screens and ordered work packages, written for the agents that build them |
| Goal | A customer's data can leave MSCD and be deleted with proof when a contract ends, a person can get, correct or erase their own data from the web app, and the organisation runs four ISO routines in MSCD that it keeps outside the platform today: read confirmation of policies, retention and disposal review of records, the periodic access review and the Top Management totals. The demo shows every business role (A.1) |
| Scope | Chosen by the product owner on 2026-10-31: section 2 of `docs/ROADMAP.md`, without the terminology renames (done in M2-17), plus a maintenance track the owner may drop (section K) |
| Inputs | `docs/platform/BUILD-PLAN.md` (cited as "BP" with its section), `docs/platform/MILESTONE-2.md` (cited as "M2"), `docs/platform/M2-STATUS.md`, `docs/saas/*.md`, `docs/product/USER-FLOWS.md`, and code research on the repository on 31 October 2026, including the uncommitted work of M2-19 (operator accounts) and M2-20 (screen addresses), which this plan treats as existing |
| Starting point | Milestone 1 and Milestone 2 are built, including M2-19, M2-20 and M2-21 (faster browser tests), which are committed before wave 1 starts (section 0, "Milestone 2 work that ends first"). The web app has host screens for administration, document control, registers, audits, certification and the operator console, and every screen has an address (M2-20). The SaaS service runs on one VPS with nightly off-site backups (M2-S07) |
| Terminology | As M2: the screens say "Checkpoint" and "Management System Manager" (product decision 10). Code names stay (`gate_items`, `ms_manager`), and this plan uses them where it names code |
| Out of scope | Section B |
| Build environment | The build host: Linux under WSL with 16 GB of memory and 8 GB of swap, Node 22.22, npm 10, Docker with Compose v5, Playwright Chromium. Memory in use stays at or below 12 GB. At most four packages run at the same time, and only one host stack runs at a time (R-02, R-05) |

## Plain summary for the product owner

| Package | What the customer gets |
|---|---|
| M3-01 Contract, schema and permissions | Nothing to see yet. It prepares the data tables, permissions, rules and two storage functions that every other package uses |
| M3-02 Organisation export | A Tenant Admin can download everything the organisation keeps in MSCD: every register and record as spreadsheet files (CSV) and data files (JSON), the audit trail, and every stored document and evidence file, with a list of fingerprints (SHA-256) that proves nothing is missing or changed |
| M3-03 End of contract and verified deletion | When a contract ends, the organisation stays read-only for 30 days so the customer can take its export, then it closes, and after a further 30 days MSCD deletes it for good. The operator receives a signed deletion certificate to give the customer. The certificate says honestly when the last backup copy disappears |
| M3-04 Requests from one person | A Tenant Admin records a person's request about their own personal data and answers it on screen: give a copy, correct it, stop using it, or erase it. Each person can download their own data and correct their own name in "My account" |
| M3-05 Read confirmation of policies | When a policy gets a new approved version, the people concerned are asked to open and confirm it, get reminders, and the manager sees who confirmed. The finished list is filed as audit evidence |
| M3-06 Retention and disposal review | Each kind of record has a keeping period. When it ends, the manager decides to keep it, extend it or dispose of it, and a second person approves a disposal. A disposal register shows the auditor what happened and why |
| M3-07 Periodic access review | Every quarter MSCD opens an access review. Tenant Admins and the managers of each system check every person's access and remove what is no longer needed. The finished review is filed as evidence for the auditor |
| M3-08 Open work totals | Top Management sees how much work is open and overdue per step and role, without any names |
| M3-09 Export and deletion screens | The screens for M3-02 and M3-03: the export page for Tenant Admins and the export and deletion tabs of the operator console |
| M3-10 Demo personas | The demo gains a Programme Owner, a Risk Owner and a Compliance Investigator to sign in as |
| M3-11 Data lifecycle run and documents | An automatic test of the whole data lifecycle on the SaaS test stack, and updated texts for the lawyer, the operator and the user flows |
| M3-M01 Open follow-ups (may be dropped) | The installer remembers its project name, accepts a default organisation, and every bundle carries a third-party notices file |
| M3-M02 Major dependency upgrades (may be dropped) | Newer major versions of the programming tools and libraries that Dependabot proposes today |

## Contents

- [0. Rules for implementing agents](#0-rules-for-implementing-agents)
- [A. Goal, scope and decisions](#a-goal-scope-and-decisions)
- [B. Out of scope](#b-out-of-scope)
- [C. Web extension points and screens](#c-web-extension-points-and-screens)
- [D. Server additions](#d-server-additions)
- [E. Demo personas](#e-demo-personas)
- [F. Testing in Milestone 3](#f-testing-in-milestone-3)
- [G. Work packages](#g-work-packages)
- [H. Questions for the product owner](#h-questions-for-the-product-owner)
- [I. Risks](#i-risks)
- [J. Contract tables](#j-contract-tables)
- [K. Maintenance track](#k-maintenance-track)

## 0. Rules for implementing agents

The rules R-01 to R-18 of M2 section 0, and S-1 to S-7 of M2 K.1 for every package that touches the SaaS stack, backups or deploy scripts, apply to every Milestone 3 package, with the changes below. R-19 to R-22 are new.

| # | Status in Milestone 3 | Rule or change |
|---|---|---|
| R-02 | Changed | At most four packages run at the same time, counted across the core track and the maintenance track. Packages in one wave never own the same file; G.1 names the one owner per wave of every shared file |
| R-03 | Changed | No new npm dependency in the core track or in M3-M01. Archives are written with the tar writer of `apps/server/src/modules/evidence-packs/tar-stream.ts` and `node:zlib`. M3-M02 is the only lockfile owner |
| R-04 | Changed | No Milestone 3 package changes `project/MSCD Mockup.dc.html`, `apps/web/scripts/convert-template.mjs` or the generated views `apps/web/src/views/*.jsx` |
| R-05 | Changed | The host stacks are the API E2E stack (`test:e2e:api`), the Compose smoke test, the journeys, the SaaS run (`npm run saas -w @mscd/smoke`), the new lifecycle run of M3-11, the bundle build and installer rehearsal of M3-M01 and `deploy/backup/restore-test.sh --local`. Only one runs on the build host at a time: every such command takes `flock /tmp/mscd-stack.lock`. The build host has 16 GB of memory and stays at or below 12 GB in use, so no package starts a second stack beside the locked one, and the owner's preview stack stays stopped while packages run. Column "Host stack" of G.1 names the stacks each package needs. The integration suites (`test:int`, `test:int:saas`) use Testcontainers and take no lock |
| R-09 | Changed | The handoff note goes to `docs/platform/handoff/M3-nn.md` (core) or `docs/platform/handoff/M3-Mnn.md` (maintenance) |
| R-14 | Changed | New route ids, permissions, enum values, profile keys, job names and the migrations `tenant/0009_milestone3.sql` and `platform/0007_milestone3.sql` appear only in wave 1 (M3-01). Two exceptions: M3-03 writes `platform/0008_milestone3_purge.sql` in wave 2 with the database functions and the audit trigger change of D.5 and nothing else; M3-10 adds the three persona values to `UI_ROLES` and `UI_ROLE_LABELS` and changes `uiRoleFor` and `DEMO_PERSONAS` in `packages/shared/src/authz/matrix.ts` in wave 4 (no permission row). From wave 2 on, a package changes request or response schemas only in the area files its Owns list names. A missing contract item goes in the handoff note, and the orchestrator adds it between waves with a correction migration (`tenant/0010_milestone3_fix.sql`, `platform/0009_milestone3_fix.sql`) |
| R-19 | New | Personal data in tests, fixtures, samples and documents: invented people only, as in the existing demo. Never data copied from staging or production, and never a real person's name or address in a test |
| R-20 | New | Irreversible operations (organisation purge, vault deletion, audit redaction, account anonymisation) run only against databases, buckets and stacks that the package's own tests create. No agent runs them on staging or production, or starts a workflow that does (S-1). On SaaS they are operator actions in the console, and the purge itself runs only on its date (D.5) |
| R-21 | New | Every table and column that holds organisation data is covered by the organisation export (D.4: in the archive, or in the exclusion list with a reason) and by the deletion checks (D.5). The coverage tests of M3-02 and M3-03 fail on a tenant table, or a platform table with `organization_id` or a foreign key to a table that has one, that is in neither |
| R-22 | New | Every new screen follows M2 D2-01 to D2-04, R-16, R-17 and C.2 to C.7: hand-written React in its own folder under `apps/web/src/screens/`, a sample adapter and an API adapter, English and Indonesian text, no text under 12px, WCAG AA contrast in light and dark (`apps/web/e2e/contrast.spec.js`), and an address through M2-20 (a screen with tabs uses `useScreenTab` of `apps/web/src/routing`) |

Workflow: `.claude/workflows/mscd-m2-wp.js` and `mscd-m2-followup.js` name `docs/platform/MILESTONE-2.md`, `#### M2-` headings and the M2 handoff folder. Before wave 1 the orchestrator copies them to `mscd-m3-wp.js` and `mscd-m3-followup.js` with this plan's path, `#### M3-` headings and the handoff names of R-09, and runs packages with those copies (args `{wp: "M3-02"}`). The copies keep the BROWSER SUITE RULE of the M2 workflows: where an acceptance command names `npm run test:e2e` or `npm run test:e2e:api` without spec files, the package runs it with the spec files of its own screens and of the screens and shared code it touched, and lists them in its acceptance note. The orchestrator runs both full browser suites once per wave (G.1), and CI runs them on every push to `main`.

**Milestone 2 work that ends first.** M2-19 (operator accounts) and M2-20 (screen addresses) finish now, and M2-21 "Faster browser tests" runs after them. M2-21 adds the heading `#### M2-21` to `docs/platform/MILESTONE-2.md` (so `WORK_PACKAGE_IDS` holds 39 + 21 + 13 ids before M3-01 starts) and owns `apps/web/playwright*.config.js`, `apps/web/e2e-api/**`, `apps/web/e2e/helpers.js`, `apps/server/src/modules/test-support/**`, the browser jobs of `.github/workflows/ci.yml` and the "Browser suites" section of `docs/DEVELOPMENT.md`. Wave 1 starts only when M2-21 is committed. No core package of this plan changes those files: specs sign in through the `apiSession` option, which takes any seeded handle, and follow the conventions that M2-21 writes into "Browser suites" (where specs live, tags, projects); where they differ from C.2, M2-21's conventions win. M3-M01 adds one check step to a job of `ci.yml` that is not a browser job, and M3-M02 runs alone in wave 5.

## A. Goal, scope and decisions

### A.1 Goal

At the end of Milestone 3:

1. A Tenant Admin downloads a complete export of the organisation in open formats, with a manifest of SHA-256 fingerprints, at any time and during the read-only period after a contract ends. The platform operator can start an export but never download one.
2. A SaaS organisation whose contract ended moves by itself from read-only (`offboarding`, 30 days) to closed (`archived`), and after a grace period MSCD deletes its database schema, its vault files and its data key, anonymises the accounts that belonged to it only, removes personal values from the platform audit entries about it, checks the result and issues a signed deletion certificate.
3. A Tenant Admin answers requests from one person (copy, correction, restriction, erasure) on screen, with the deadline and the time left shown and reminders before it passes, with the help of each system's manager. Erasure keeps the organisation's records and audit trail intact under a pseudonym.
4. A new approved version of a policy asks the people in scope to read and confirm it, and the confirmations form a register that is filed as evidence.
5. Each management system has retention periods per record type, a disposal review when a period ends, and a disposal register.
6. The organisation reviews access rights on a schedule, applies the changes, and the completed review becomes evidence for ISO/IEC 27001 control A.5.18.
7. Top Management sees open work as totals, without names.
8. The demo has a persona for each of the eight business roles.

### A.2 What stays outside the browser

- The purge of an organisation runs in the worker on its date (D.5). Nobody starts a purge before its date: the operator can only retry a failed purge (console or CLI), start a due purge at once (`tenant deletion run`), or re-apply a certified deletion after a restore (D.5.6).
- Checking a deletion certificate, and re-applying deletions after a restore from an older backup, are server commands (`mscd-server tenant verify-certificate`, `deploy/backup/restore.sh --reapply-deletions`).
- On-premise, the customer controls deletion: it exports the organisation (screen or `mscd-server export organization`) and removes the installation with `uninstall.sh --purge` (BP WP-33).
- The lawyer's documents (privacy notice, data processing agreement, the answer to each question of `docs/saas/legal-inputs.md`) stay outside the code. M3-11 updates the facts the lawyer reads.

### A.3 Decisions

| # | Decision |
|---|---|
| D3-01 | Contract first, as M2 D2-15: M3-01 writes every route, schema, permission, enum value, job name, profile key and migration of this plan in wave 1, with route stubs that answer 501 `not-implemented` after the guard. The building package replaces its stubs |
| D3-02 | Every new screen is a host screen (C.2). No package edits the generated views. The Top Management totals are a host screen, reached through page actions on the built-in screens, so the generated Overview stays as it is |
| D3-03 | The organisation export is a set of `.tar.gz` parts holding CSV and JSON Lines per table, the audit trail with its hashes and signed anchors, and the original files, plus a `manifest.json` with the size and SHA-256 of every entry and every part (D.4). Parts are stored in the organisation's Managed Vault area and expire. Only Tenant Admins download, and a second active Tenant Admin approves first when the organisation has one (H.2). The platform operator can start an export and see its status, because operators never read tenant data (M2 K.8) |
| D3-04 | Verified deletion exists only in multi tenancy, at the end of the lifecycle of D.5: `offboarding` (30 days), `archived`, a grace period (30 days), then `deleted`. The purge runs through two database functions owned by the migrator role, so the application role never holds the right to drop a schema or rewrite audit rows in general. The certificate is signed with the audit anchor key |
| D3-05 | The audit chain is never broken and no audit row is removed. Personal values inside audit rows are removed by attested redaction (D.5.4): the row keeps its stored hash, and a new chained entry lists the redacted rows with their hashes, so the verifier still proves that no row was added, removed or reordered |
| D3-06 | An account is anonymised and its row kept, because records and audit rows refer to its id. Inside one organisation a person is erased by a pseudonym that only that organisation shows (`erased_person`), and the shared account is anonymised only when no other membership remains (D.6) |
| D3-07 | The customer organisation is the controller of its members' data and answers requests from people. The provider forwards requests it receives and acts as processor. The deadline is a profile value, 72 hours by default, which the lawyer confirms (H.4) |
| D3-08 | Read confirmation is a setting of each document. Approval of a new version starts a confirmation request for the people in scope; each person opens the version and confirms it (D.7) |
| D3-09 | Retention rules are set per management system and record class, with 36 months as the default (H.8). A disposal needs a second person. It deletes file content from the Managed Vault, marks database records deleted (BP C.1 keeps rows), and asks the owner to delete files kept in the customer's own repository (D.8) |
| D3-10 | The access review is one review per organisation with one part per management system. People decide on others' access only. Revocations are applied through the existing role, membership, guest grant and identity services by people who hold those rights (D.9) |
| D3-11 | The Top Management totals read the existing route `readmodel.audit.pending` with `aggregate=unit`. No server change (D.10) |
| D3-12 | The demo gets three personas with three new sample UI roles, and the sample permissions come from the F.6 matrix (E). They stay demo material (R-13, R-19) |
| D3-13 | Work for a person (confirm a policy, review access, check a system for a personal data request) appears in My Tasks through the existing `task` table, with new source values. Such a task is completed on its own screen, never with "Mark done" |
| D3-14 | The maintenance track (section K) is separate and can be dropped as a whole or per package. M3-M02 runs alone in the last wave, because it may touch any file |

### A.4 Findings of the code research

The roadmap and earlier plans assumed some things that the code does differently. The plan follows the code.

| Assumption | What the code does |
|---|---|
| The Top Management totals panel needs server work | The route exists: `GET /api/v1/ms/:ms/audit/pending?aggregate=unit` (`readmodel.audit.pending`, `screen-read.service.ts` `pending()`, permission `audit.pending.aggregate` [MM, PO, TM]) returns counts per chain stage and business role without names. No screen calls it. M3-08 is web only |
| The terminology renames are open | Done in M2-17 (product decision 10). Dropped |
| Exports end after 7 days | The download ends after 7 days (`EXPORT_RETENTION_DAYS`), but `cleanup.expired` only sets `export_file.deleted_at`; the encrypted vault bytes stay. M3-02 removes them |
| MSCD can delete vault files | No gateway route deletes anything. `VaultStore.delete` exists only to clean up a failed upload. M3-01 adds `gateway.objects.delete` and `gateway.tenants.purge` |
| A person can be pseudonymised in the audit trail | The chain hash (`platform.chain_hash()`) covers every column, including `source_ip`, `user_agent`, `entity_code` (handles) and `before_data` and `after_data` (emails). Any change breaks the chain, and both audit tables refuse updates. D.5.4 solves this with attested redaction |
| Archived organisations move on | `archived` is final in M2 J.8, and nothing moves `offboarding` to `archived` after the 30 days of D-S5 (M2-S09 follow-up 8). M3-03 adds both |
| The application can purge an organisation | `mscd_app` has no `DELETE` on business tables and cannot drop a schema; `mscd_migrator` owns every `org_` schema (`TenantProvisioner.create`). The only `drop schema` is the demo reset of `seed/seed-demo.ts` |
| User rows with no membership are purged (`docs/ARCHITECTURE.md` section 9.4) | Many tenant tables reference `platform.app_user(id)` (`created_by` and the owner columns), and audit rows keep `actor_user_id`. M3 anonymises such accounts and keeps the row |
| Destroying a tenant key deletes its data at once (`docs/ARCHITECTURE.md` section 10.3) | The wrapped data key sits in `platform.tenant_key`, every nightly database backup holds a copy, and one key-encryption key (`storage.key`) wraps the keys of every organisation. Deleting the key makes the live vault unreadable at once, and backups only once they age out (D.5.6) |
| Stored tasks can carry any source | `task.source_rule` is `varchar(12)` with a CHECK list. M3-01 widens it to `varchar(20)` |
| Linked company sign-in can be removed | No route removes a `platform.user_identity` row. M3-07 adds `admin.users.identities.remove` |
| A new approved document version notifies someone | Approval (`DocumentCommandsService.transition`) sends no notification. M3-05 adds the confirmation request |
| The demo persona switch can show more roles | `POST /auth/demo/persona` takes a `UiRole`, and there are four (`manager`, `owner`, `auditor`, `top`). M3-10 adds three |
| The release check finds demo people | `deploy/scripts/check-release-artefacts.sh` checks keys, demo files and pack texts, and no demo names. The compiled seed module is in release images and is refused at run time (`seedDemo`, `releaseFlavourIssues`). M3-10 adds a name check for packs and profiles |
| Five open follow-ups of `CLAUDE.md` are open | Done already: `admin create-operator` grants `platform_operator` to an existing account; `mscd-server diagnostics` works without the api (M2-S09); the Helm `adminJob` runs `tenant create` and `admin create-user` (M2-06); `docs/DEVELOPMENT.md` has the API E2E section and the default data source (M2-01); `apps/web/e2e-api/stack.mjs` removes only leftovers whose `mscd.test.expires` label has passed (M2-01). M2-21 owns those two files now and keeps them current. Left: the installer project name and default organisation, and the third-party notices (M3-M01) |
| Dependabot's `@types/node` 26 fits | The runtime is Node 22.22, so type definitions of Node 26 describe functions the runtime lacks. M3-M02 keeps `@types/node` on the 22 major (K.2) |

## B. Out of scope

| Item | Where it goes and why |
|---|---|
| Self-service sign-up and billing, LDAP and Active Directory, SMB, S3 and WebDAV repositories, direct browser upload to Microsoft 365 and Google Drive, edition transitions with mapping files, high availability | Roadmap section 3, driven by customer demand |
| Changing the email address of an account | Later. It needs a verified change flow for a sign-in identifier. The workaround of `docs/saas/records-of-processing.md` stays: invite the new address, hand over the records, disable the old membership |
| Removing deleted data from backups before they age out, and per-organisation key-encryption keys that would make key destruction effective at once | Later, with cloud key management (M2 K.8, deviation X-03). The certificate states the real end date (D.5.6) |
| Physical deletion of database rows at disposal | Not planned: BP C.1 keeps soft delete for business records. Only the purge of a whole organisation removes rows (D.5) |
| Deleting files in a customer's SharePoint or Google Drive | Never: those files belong to the customer. MSCD removes only what it holds itself: its links to the files, the sealed credentials and the copies in its own vault (D.5, D.8) |
| Deleting an on-premise organisation from the app | The customer controls its installation (`uninstall.sh --purge`, A.2) |
| A legal hold that covers a whole system or organisation at once | Later; holds are set per record (D.8) |
| Read confirmation by people who are not members (contractors, interested parties) | Later; the audience is members of the organisation (D.7) |
| A scheduled review of platform operator accounts | The owner reviews the operator list of M2-19 (`ops.operators.list`); a scheduled task for it is later |
| A request log for the provider inside MSCD | Not planned: the organisation records requests (D.6), and the provider keeps its short forwarding log outside MSCD (M3-11 rewrites the procedure) |
| Audit findings in the Golden Thread Viewer | Roadmap section 3. Deep links for every screen are done by M2-20 |

## C. Web extension points and screens

### C.1 Extension points in use

No new extension point is built. The packages use those of M2 C:

- the screen registry and `meta.json` of M2 C.2, with the `?screen=` opener of sample builds;
- the host context of M2 C.4 (`ctx.client`, `ctx.can`, `ctx.orgCan`, `ctx.platformCan`, `ctx.go`, `ctx.openPicker`, `ctx.layer()`);
- `layerItems` of a folder's `actions.ts` for banners in the host layer (as `screens/invitations`);
- detail extensions for record kind `doc` (read confirmation settings and status, retention end) and `ev` (retention end), and `extraPageActions` on built-in screens (M2 C.5). A page action that a package adds to a built-in screen shows in API builds only, as the "Import" and "Edition transition" actions do: `e2e/shell.spec.js` checks the exact page actions of the generated views in the sample build (M2-STATUS, M2-08 and M2-09). Sample specs reach the new screens through their address instead;
- the UI kit of `apps/web/src/screens/ui/` and the scenes of `apps/web/src/illustrations/` for empty states;
- `useScreenTab(ctx, ids, fallback)` of `apps/web/src/routing` for screen tabs (M2-20).

### C.2 New screens

| Screen id | Label (English, Indonesian) | Path | Group | Scope | Permission (`perm`) | Sample persona | Built by |
|---|---|---|---|---|---|---|---|
| `pending-totals` | Open work totals, Total pekerjaan terbuka | `/ms/:ms/pending-totals` | `audit` | `ms` | `audit.pending.aggregate` | `top` | M3-08 |
| `org-export` | Organisation export, Ekspor organisasi | `/admin/org-export` | `admin` | `org` | `org.export.manage` | `manager` | M3-09 |
| `privacy-requests` | Personal data requests, Permintaan data pribadi | `/admin/privacy-requests` | `admin` | `org` | `privacy_request.manage` | `manager` | M3-04 |
| `privacy-checks` | Personal data checks, Pemeriksaan data pribadi | `/ms/:ms/privacy-checks` | `tasks` | `ms` | `privacy_request.assist` | `manager` | M3-04 |
| `acknowledgements` | Policy read confirmations, Konfirmasi baca kebijakan | `/ms/:ms/acknowledgements` | `impl` | `ms` | `acknowledgement.manage`, `audit.pending.all` or `audit.pending.aggregate` | `manager` | M3-05 |
| `my-confirmations` | Policies to confirm, Kebijakan untuk dikonfirmasi | `/my-confirmations` | `tasks` | `ms` | `ms.read` | `owner` | M3-05 |
| `retention` | Retention and disposal, Retensi dan pemusnahan | `/ms/:ms/retention` | `impl` | `ms` | `retention.manage` or `retention.approve` | `manager` | M3-06 |
| `access-reviews` | Access reviews, Tinjauan akses | `/admin/access-reviews` | `admin` | `org` | `access_review.manage` | `manager` | M3-07 |
| `access-review` | Access review of this system, Tinjauan akses sistem ini | `/ms/:ms/access-review` | `audit` | `ms` | `access_review.decide` | `manager` | M3-07 |

Changed screens: `account` (M2-16) gains a "My data" section (M3-04); `ops` (M2-16, M2-S12, M2-19) gains the Export and Deletion tabs of its organisation drawer and the new status moves (M3-09).

Every new screen has `routes.ts`, `api.ts`, `sample.ts`, `adapter.ts`, `text.ts` and `meta.json` as M2 C.6 and `docs/DEVELOPMENT.md` "Adding a screen" describe, unit tests in `apps/web/test/screens/<id>.test.tsx`, a sample spec `apps/web/e2e/screens/<id>.spec.js` tagged `@sample-only` unless it passes in both modes, and an API spec `apps/web/e2e/api-only/<id>.spec.js` that opens every form and drawer and calls `expectOverlayReadable` in light and dark.

### C.3 Tasks and notifications in the web app

- Stored tasks with the new sources (`acknowledgement`, `access_review`, `privacy_check`) reach My Tasks through the existing loader (`loadOpenTasks` in `apps/server/src/modules/read-model/load/loader.ts`). Their title names the screen that completes them. `tasks.complete` refuses them (D.2). The table keeps one open task per source and record (`task_open_uq` on `source_rule, entity_type, entity_id`, which `RuleTaskService.open` relies on), so each task names a record of its own: entity `acknowledgement` (one row per person) for a confirmation, `privacy_check` (one row per system) for a personal data check, and `access_review_part` (one row per system part) for an access review.
- The notification bell links each new kind to its screen through `KIND_SCREENS` of `apps/web/src/screens/notifications/model.ts`. M3-11 adds the kinds of J.4 once every screen exists; until then a new notification shows without a link.

## D. Server additions

### D.1 New routes

M3-01 adds every route below to the area file named, with request and response schemas, an example, the permission, a mounted stub in the controller file named and the F.6 matrix entry. The package in the last column replaces the stub. Routes whose id starts with `exports.` stay usable while an organisation is `offboarding`, because `offboardingAllows` in `apps/server/src/modules/identity/session-resolver.ts` allows `GET` routes and routes whose id starts with `exports.`. The operator routes answer 409 `conflict` with `messageKey` `single_tenancy` in single tenancy, as in M2 D.1.

| Route id | Method and path | Area file | Permission | Purpose | Controller file (under `apps/server/src/modules/`) | Built by |
|---|---|---|---|---|---|---|
| `exports.organization.list` | `GET /api/v1/admin/organization/exports` | `org-export.ts` (new) | `org.export.manage` [TA] (new) | exports with status, requester, approver, dates, parts, sizes, expiry | `org-export/org-export.controller.ts` (new) | M3-02 |
| `exports.organization.create` | `POST /api/v1/admin/organization/exports` | `org-export.ts` | `org.export.manage` [TA] | request an export: `requested` when another active Tenant Admin exists, else `queued` with a warning; 202 | `org-export/org-export.controller.ts` | M3-02 |
| `exports.organization.get` | `GET /api/v1/admin/organization/exports/:id` | `org-export.ts` | `org.export.manage` [TA] | one export with its parts | `org-export/org-export.controller.ts` | M3-02 |
| `exports.organization.decide` | `POST /api/v1/admin/organization/exports/:id/decision` | `org-export.ts` | `org.export.manage` [TA] | body `{approve, note}`: another Tenant Admin approves or rejects; the requester is refused with rule `SOD-SELF-APPROVE` | `org-export/org-export.controller.ts` | M3-02 |
| `exports.organization.manifest` | `GET /api/v1/admin/organization/exports/:id/manifest` | `org-export.ts` | `org.export.manage` [TA] | the manifest JSON as an attachment; audited | `org-export/org-export.controller.ts` | M3-02 |
| `exports.organization.download` | `GET /api/v1/admin/organization/exports/:id/parts/:part` | `org-export.ts` | `org.export.manage` [TA] | one part as an attachment with `Content-Length` and its SHA-256 in `X-MSCD-SHA256`; audited | `org-export/org-export.controller.ts` | M3-02 |
| `ops.exports.list` | `GET /api/v1/ops/organizations/:org/exports` | `org-export.ts` | `ops.read` platform [OP] | status, dates and sizes of the organisation's exports, no content and no download | `org-export/ops-exports.controller.ts` (new) | M3-02 |
| `ops.exports.create` | `POST /api/v1/ops/organizations/:org/exports` | `org-export.ts` | `ops.tenants.manage` platform [OP] | body `{reason}`: queue an export for the Tenant Admins to download; audited `ops.export_requested` | `org-export/ops-exports.controller.ts` | M3-02 |
| `ops.deletion.get` | `GET /api/v1/ops/organizations/:org/deletion` | `ops.ts` | `ops.read` platform [OP] | the deletion record: status, dates, steps, report, certificate id | `ops/deletion/deletion.controller.ts` (new) | M3-03 |
| `ops.deletion.schedule` | `POST /api/v1/ops/organizations/:org/deletion` | `ops.ts` | `ops.tenants.manage` platform [OP] | body `{scheduledFor, reason, confirmSlug}`: schedule or move the date of an `archived` organisation's deletion, not earlier than archiving plus `lifecycle.deletion_min_grace_days` | `ops/deletion/deletion.controller.ts` | M3-03 |
| `ops.deletion.cancel` | `POST /api/v1/ops/organizations/:org/deletion/cancel` | `ops.ts` | `ops.tenants.manage` platform [OP] | body `{reason}`: cancel a `scheduled` deletion | `ops/deletion/deletion.controller.ts` | M3-03 |
| `ops.deletion.retry` | `POST /api/v1/ops/organizations/:org/deletion/retry` | `ops.ts` | `ops.tenants.manage` platform [OP] | body `{reason}`: run a `failed` purge again from its failed step | `ops/deletion/deletion.controller.ts` | M3-03 |
| `ops.deletion.certificate` | `GET /api/v1/ops/organizations/:org/deletion/certificate` | `ops.ts` | `ops.read` platform [OP] | the signed deletion certificate (JSON attachment) | `ops/deletion/deletion.controller.ts` | M3-03 |
| `privacy-requests.list` | `GET /api/v1/admin/privacy-requests` | `privacy.ts` (new) | `privacy_request.manage` [TA] (new) | requests with type, subject, status, received and due times, paged and filtered | `privacy/privacy-requests.controller.ts` (new) | M3-04 |
| `privacy-requests.create` | `POST /api/v1/admin/privacy-requests` | `privacy.ts` | `privacy_request.manage` [TA] | body `{type, subject: {userId} or {name, email?}, receivedAt, channel, note}` | `privacy/privacy-requests.controller.ts` | M3-04 |
| `privacy-requests.get` | `GET /api/v1/admin/privacy-requests/:id` | `privacy.ts` | `privacy_request.manage` [TA] | one request with its system checks, actions and result | `privacy/privacy-requests.controller.ts` | M3-04 |
| `privacy-requests.update` | `PATCH /api/v1/admin/privacy-requests/:id` | `privacy.ts` | `privacy_request.manage` [TA] | with `If-Match`: start work (identity check note required), refuse or record withdrawal (reason), notes | `privacy/privacy-requests.controller.ts` | M3-04 |
| `privacy-requests.rectify` | `POST /api/v1/admin/privacy-requests/:id/rectify` | `privacy.ts` | `privacy_request.manage` [TA] | body `{displayName?, jobTitle?}`; refused with `messageKey` `shared_account` when the account has another active membership | `privacy/privacy-requests.controller.ts` | M3-04 |
| `privacy-requests.restrict` | `POST /api/v1/admin/privacy-requests/:id/restrict` | `privacy.ts` | `privacy_request.manage` [TA] | disable the membership (also used for an objection) | `privacy/privacy-requests.controller.ts` | M3-04 |
| `privacy-requests.erase` | `POST /api/v1/admin/privacy-requests/:id/erase` | `privacy.ts` | `privacy_request.manage` [TA] | body `{confirm: true}`: erase the person in this organisation (D.6) | `privacy/privacy-requests.controller.ts` | M3-04 |
| `privacy-requests.close` | `POST /api/v1/admin/privacy-requests/:id/close` | `privacy.ts` | `privacy_request.manage` [TA] | body `{outcome}`: complete the request with the answer given | `privacy/privacy-requests.controller.ts` | M3-04 |
| `exports.person.create` | `POST /api/v1/admin/privacy-requests/:id/export` | `privacy.ts` | `privacy_request.manage` [TA] | queue the person export of an access request (`export_file` kind `personal_data`); 202 with task id; downloaded with `exports.download` | `privacy/person-export.controller.ts` (new) | M3-04 |
| `privacy-checks.list` | `GET /api/v1/ms/:ms/privacy-checks` | `privacy.ts` | `privacy_request.assist` [MM] (new) | the checks of this system: request type, subject, due time, status | `privacy/privacy-checks.controller.ts` (new) | M3-04 |
| `privacy-checks.mentions` | `GET /api/v1/ms/:ms/privacy-checks/:id/mentions` | `privacy.ts` | `privacy_request.assist` [MM] | records of this system whose text names the subject (D.6.4), at most 500 | `privacy/privacy-checks.controller.ts` | M3-04 |
| `privacy-checks.done` | `POST /api/v1/ms/:ms/privacy-checks/:id/done` | `privacy.ts` | `privacy_request.assist` [MM] | body `{note}`: this system is checked and edited | `privacy/privacy-checks.controller.ts` | M3-04 |
| `me.privacy-requests.list` | `GET /api/v1/me/privacy-requests` | `privacy.ts` | active session | the person's own requests in the current organisation | `privacy/me-privacy.controller.ts` (new) | M3-04 |
| `me.privacy-requests.create` | `POST /api/v1/me/privacy-requests` | `privacy.ts` | active session | body `{type, note}`: ask the organisation for a correction, restriction or erasure | `privacy/me-privacy.controller.ts` | M3-04 |
| `exports.me.create` | `POST /api/v1/me/data-export` | `privacy.ts` | active session | queue the person's own export (kind `personal_data`); 202 with task id | `privacy/person-export.controller.ts` | M3-04 |
| `me.profile` | `PATCH /api/v1/me/profile` | `privacy.ts` | active session | body `{displayName?, jobTitle?}`: correct one's own name and job title; audited `user.updated` | `privacy/me-privacy.controller.ts` | M3-04 |
| `acknowledgement-requests.list` | `GET /api/v1/ms/:ms/acknowledgement-requests` | `acknowledgements.ts` (new) | `anyOf` [`acknowledgement.manage` [MM] (new), `audit.pending.aggregate`] | requests with document, version, due date and totals (confirmed, pending, overdue, excused) | `acknowledgements/acknowledgement-requests.controller.ts` (new) | M3-05 |
| `acknowledgement-requests.create` | `POST /api/v1/ms/:ms/acknowledgement-requests` | `acknowledgements.ts` | `acknowledgement.manage` [MM] | body `{documentId, audience?, dueDays?}`: ask for confirmation of the current approved version | `acknowledgements/acknowledgement-requests.controller.ts` | M3-05 |
| `acknowledgement-requests.get` | `GET /api/v1/ms/:ms/acknowledgement-requests/:id` | `acknowledgements.ts` | `anyOf` [`audit.pending.all`, `audit.pending.aggregate`] | totals for every caller; the person list only with `audit.pending.all` | `acknowledgements/acknowledgement-requests.controller.ts` | M3-05 |
| `acknowledgement-requests.remind` | `POST /api/v1/ms/:ms/acknowledgement-requests/:id/remind` | `acknowledgements.ts` | `acknowledgement.manage` [MM] | remind the pending people now (at most once a day) | `acknowledgements/acknowledgement-requests.controller.ts` | M3-05 |
| `acknowledgement-requests.close` | `POST /api/v1/ms/:ms/acknowledgement-requests/:id/close` | `acknowledgements.ts` | `acknowledgement.manage` [MM] | body `{evidenceId?}`: stop reminders and file the register as a new file of the evidence item | `acknowledgements/acknowledgement-requests.controller.ts` | M3-05 |
| `acknowledgement-requests.export` | `GET /api/v1/ms/:ms/acknowledgement-requests/:id/export` | `acknowledgements.ts` | `audit.pending.all` | the register as CSV | `acknowledgements/acknowledgement-requests.controller.ts` | M3-05 |
| `me.acknowledgements` | `GET /api/v1/me/acknowledgements` | `acknowledgements.ts` | active session | the person's open and recent confirmations in the current organisation | `acknowledgements/me-acknowledgements.controller.ts` (new) | M3-05 |
| `me.acknowledgements.open` | `POST /api/v1/me/acknowledgements/:id/open` | `acknowledgements.ts` | active session | a short-lived address of the version's file for a person in the audience; records `opened_at` | `acknowledgements/me-acknowledgements.controller.ts` | M3-05 |
| `me.acknowledgements.confirm` | `POST /api/v1/me/acknowledgements/:id/confirm` | `acknowledgements.ts` | active session | confirm the version; refused before opening with rule `ACK-OPEN-FIRST` | `acknowledgements/me-acknowledgements.controller.ts` | M3-05 |
| `retention.rules.list` | `GET /api/v1/ms/:ms/retention/rules` | `retention.ts` (new) | `anyOf` [`retention.manage` [MM] (new), `retention.approve` [MM, PO] (new)] | the period in force per record class (and document type), marked default or set | `retention/retention.controller.ts` (new) | M3-06 |
| `retention.rules.put` | `PUT /api/v1/ms/:ms/retention/rules/:recordClass` | `retention.ts` | `retention.manage` [MM] | body `{docType?, retainMonths or null, basis}`: set or reset a rule | `retention/retention.controller.ts` | M3-06 |
| `retention.reviews.list` | `GET /api/v1/ms/:ms/retention/reviews` | `retention.ts` | `anyOf` [`retention.manage`, `retention.approve`] | disposal reviews by status, paged | `retention/retention.controller.ts` | M3-06 |
| `retention.reviews.decide` | `POST /api/v1/ms/:ms/retention/reviews/decide` | `retention.ts` | `retention.manage` [MM] | body `{ids, decision, reason, keepUntil?, extendMonths?}`: keep, extend, or propose disposal | `retention/retention.controller.ts` | M3-06 |
| `retention.reviews.approve` | `POST /api/v1/ms/:ms/retention/reviews/:id/approve` | `retention.ts` | `retention.approve` [MM, PO] | a second person approves a disposal, which then runs; the proposer is refused with `SOD-SELF-APPROVE` | `retention/retention.controller.ts` | M3-06 |
| `retention.reviews.reject` | `POST /api/v1/ms/:ms/retention/reviews/:id/reject` | `retention.ts` | `retention.approve` [MM, PO] | body `{note}`: send a disposal back to review | `retention/retention.controller.ts` | M3-06 |
| `retention.reviews.file-removed` | `POST /api/v1/ms/:ms/retention/reviews/:id/file-removed` | `retention.ts` | `retention.manage` [MM] | record that the owner deleted the file in the customer's repository | `retention/retention.controller.ts` | M3-06 |
| `retention.register` | `GET /api/v1/ms/:ms/retention/register` | `retention.ts` | `anyOf` [`retention.manage`, `retention.approve`] | decided reviews (paged), or `?format=csv` | `retention/retention.controller.ts` | M3-06 |
| `retention.holds.list` | `GET /api/v1/ms/:ms/retention/holds` | `retention.ts` | `anyOf` [`retention.manage`, `retention.approve`] | holds in force and released | `retention/retention.controller.ts` | M3-06 |
| `retention.holds.create` | `POST /api/v1/ms/:ms/retention/holds` | `retention.ts` | `retention.manage` [MM] | body `{recordClass, itemId, reason}`: keep an item whatever its period says | `retention/retention.controller.ts` | M3-06 |
| `retention.holds.release` | `POST /api/v1/ms/:ms/retention/holds/:id/release` | `retention.ts` | `retention.manage` [MM] | body `{reason}` | `retention/retention.controller.ts` | M3-06 |
| `access-reviews.settings.get` | `GET /api/v1/admin/access-reviews/settings` | `access-reviews.ts` (new) | `access_review.manage` [TA] (new) | frequency, next due date, days to complete, with `ETag` | `access-reviews/access-reviews.controller.ts` (new) | M3-07 |
| `access-reviews.settings.put` | `PUT /api/v1/admin/access-reviews/settings` | `access-reviews.ts` | `access_review.manage` [TA] | with `If-Match`: frequency 1, 3, 6 or 12 months, next due date, days to complete | `access-reviews/access-reviews.controller.ts` | M3-07 |
| `access-reviews.list` | `GET /api/v1/admin/access-reviews` | `access-reviews.ts` | `access_review.manage` [TA] | reviews with status, dates and progress | `access-reviews/access-reviews.controller.ts` | M3-07 |
| `access-reviews.create` | `POST /api/v1/admin/access-reviews` | `access-reviews.ts` | `access_review.manage` [TA] | open a review now (one open review at a time) | `access-reviews/access-reviews.controller.ts` | M3-07 |
| `access-reviews.get` | `GET /api/v1/admin/access-reviews/:id` | `access-reviews.ts` | `access_review.manage` [TA] | the organisation part with its items, the status of every system part, and the decided revocations still to apply | `access-reviews/access-reviews.controller.ts` | M3-07 |
| `access-reviews.decide` | `POST /api/v1/admin/access-reviews/:id/items/:itemId/decision` | `access-reviews.ts` | `access_review.manage` [TA] | body `{decision, note}` on an organisation item; refused on one's own access with `REVIEW-OWN-ACCESS` | `access-reviews/access-reviews.controller.ts` | M3-07 |
| `access-reviews.apply` | `POST /api/v1/admin/access-reviews/:id/items/:itemId/apply` | `access-reviews.ts` | `user.manage` [TA] | apply a decided revocation or change through the existing services, or record why it is not applied | `access-reviews/access-reviews.controller.ts` | M3-07 |
| `access-reviews.complete` | `POST /api/v1/admin/access-reviews/:id/complete` | `access-reviews.ts` | `access_review.manage` [TA] | complete when every part is signed off and every revocation applied or explained; stores the report | `access-reviews/access-reviews.controller.ts` | M3-07 |
| `access-reviews.cancel` | `POST /api/v1/admin/access-reviews/:id/cancel` | `access-reviews.ts` | `access_review.manage` [TA] | body `{reason}` | `access-reviews/access-reviews.controller.ts` | M3-07 |
| `access-reviews.report` | `GET /api/v1/admin/access-reviews/:id/report` | `access-reviews.ts` | `access_review.manage` [TA] | the review as CSV | `access-reviews/access-reviews.controller.ts` | M3-07 |
| `access-reviews.ms.list` | `GET /api/v1/ms/:ms/access-reviews` | `access-reviews.ts` | `access_review.decide` [MM, PO] (new) | the parts of this system, open first | `access-reviews/ms-access-reviews.controller.ts` (new) | M3-07 |
| `access-reviews.ms.get` | `GET /api/v1/ms/:ms/access-reviews/:id` | `access-reviews.ts` | `access_review.decide` [MM, PO] | the items of this system's part | `access-reviews/ms-access-reviews.controller.ts` | M3-07 |
| `access-reviews.ms.decide` | `POST /api/v1/ms/:ms/access-reviews/:id/items/:itemId/decision` | `access-reviews.ts` | `access_review.decide` [MM, PO] | body `{decision, note}`; refused on one's own access with `REVIEW-OWN-ACCESS` | `access-reviews/ms-access-reviews.controller.ts` | M3-07 |
| `access-reviews.ms.apply` | `POST /api/v1/ms/:ms/access-reviews/:id/items/:itemId/apply` | `access-reviews.ts` | `auditor_access.grant` [MM] | revoke a guest auditor grant decided `revoke` | `access-reviews/ms-access-reviews.controller.ts` | M3-07 |
| `access-reviews.ms.sign-off` | `POST /api/v1/ms/:ms/access-reviews/:id/sign-off` | `access-reviews.ts` | `access_review.decide` [MM, PO] | body `{evidenceId?}`: sign off the part when every item is decided | `access-reviews/ms-access-reviews.controller.ts` | M3-07 |
| `admin.users.identities.remove` | `POST /api/v1/admin/users/:id/identities/remove` | `admin-users.ts` | `user.manage` [TA] | body `{provider, reason}`: remove a linked company sign-in of this organisation's provider; audited `identity.unlinked` | `admin-users/admin-users.controller.ts` | M3-07 |

Two storage gateway routes, in `packages/shared/src/api/gateway.ts` and `apps/server/src/gateway/routes.ts`, built by M3-01 because three later packages call them:

| Route id | Method and path | Body | Answer | Adapters |
|---|---|---|---|---|
| `gateway.objects.delete` | `POST /v1/objects/delete` | `{tenant, repository, object}` | `{deleted, versions}`: every stored version of the object removed | `managed_vault`; others answer 422 `unsupported` |
| `gateway.tenants.purge` | `POST /v1/tenants/purge` | `{orgId, confirmOrgId}` (with `tls.mode: mtls`, as the SaaS and on-premise profiles run, the worker certificate `CN=mscd-worker` only, as `gateway.anchors`; the demo and test profiles run without TLS and check the token only) | `{objectsDeleted, versionsDeleted, retained: [{key, retainUntil}]}`: every object version under `tenants/<orgId>/` removed, the cached data key of the organisation dropped; objects that a bucket retention rule still protects are listed | `managed_vault` bucket |

J.1 lists the same routes in the format of the shared contract tests.

### D.2 Changed behaviour of existing routes

| Route | Change | Built by |
|---|---|---|
| `ops.organizations.status`, CLI `tenant set-status` | The machine of J.8: `offboarding` sets `organization.offboarding_ends_at` to now plus `lifecycle.offboarding_days` and queues the final export (D.4); `archived` schedules the deletion (D.5); `archived` to `offboarding` (reason and `confirmSlug`) is allowed while the deletion is `scheduled`, cancels it, sets a new end 7 days ahead and queues a new final export; `deleted` is never accepted from a caller | M3-01 (schema), M3-03 |
| `ops.organizations.get`, `ops.organizations.list`, CLI `tenant list` and `tenant show` | Items add `offboardingEndsAt`, `deletion: {status, scheduledFor} or null` and `lastExport: {status, readyAt} or null`; the status filter accepts `deleted` | M3-01 (schema), M3-03 |
| `admin.organization.get` | Adds `offboardingEndsAt` and `deletionScheduledFor`: while `offboarding` the planned date (`offboarding_ends_at` plus `lifecycle.deletion_grace_days`), while `archived` the scheduled date, else null. Tenant Admins cannot sign in to an archived organisation, so the banner of M3-09 shows the planned date during the read-only period | M3-01 (schema), M3-03 |
| `documents.create`, `documents.update` | Body and item take `acknowledgement: {required, scope, roles, dueDays}` (D.7) | M3-01 (schema), M3-05 |
| `documents.transition` to `approved` | When the document has `acknowledgement_required`, the approval opens a confirmation request for the new version in the same transaction | M3-05 |
| `tasks.complete` | Refuses a task whose `source_rule` is `acknowledgement`, `access_review` or `privacy_check` with 422 `business-rule` and `messageKey` `task_completes_on_screen` | M3-05 |
| `storage.objects.open`, `storage.objects.redirect`, `storage.objects.content` (`files/object-access.service.ts`) and the evidence pack download (`evidence-packs/evidence-packs.service.ts`) | An object with `storage_object.content_disposed_at` answers 404 `not-found` with `messageKey` `content_disposed` | M3-01 |
| `integrity.rehash`, `link-health.check` (jobs) | Skip objects with `content_disposed_at`, so a disposed file never shows as changed or missing (`integrity/integrity.service.ts`, `link-health/link-health.service.ts`) | M3-01 |
| `evidence.files` (`FileCommandsService.evidenceFile`) | The object that a new file replaces gets `storage_object.replaced_at` | M3-06 |
| `audit-trail.list`, `audit-trail.export`, `audit-trail.verify` | Entries carry `redacted` and `redactedAt`; the export adds the columns; the verifier accepts attested redactions (D.5.4) and reports their count | M3-01 (schema, `audit-trail.ts`), M3-03 |
| `audit-trail.list`, `admin.users.list`, the read model people of `/ui/*` | A person erased in this organisation shows as its pseudonym (D.6) | M3-04 |
| `exports.get`, `exports.download` | Serve `personal_data` exports: a person's own export to that person; an access request export to its creator, with `privacy_request.manage` checked again | M3-04 |
| `exports.create` | Unchanged: its body refuses the kind `personal_data` (400), which only `exports.person.create` and `exports.me.create` create | M3-01 |
| `ops.jobs.run` | `org.lifecycle` joins `OPS_RUNNABLE_JOBS` | M3-01 (enum), M3-03 |
| `auth.demo-persona`, `me.get` (`personas`) | The persona values `sponsor`, `riskowner` and `investigator` (E) | M3-10 |
| `cleanup.expired` (job) | Removes the vault content of expired `export_file` rows and organisation exports (M3-02), and the technical personal data of D.6.7 (M3-04) | M3-02, M3-04 |
| `audit.verify-chain` (job) | Skips deleted organisations; accepts attested redactions | M3-03 |

### D.3 Schema, enums and permissions

M3-01 writes all of it in wave 1, except `platform/0008_milestone3_purge.sql` (M3-03, wave 2) and the persona values (M3-10, wave 4), as R-14 says.

- `apps/server/migrations/tenant/0009_milestone3.sql` (standard tenant columns and row-level security as `competence_record` in 0008 for every new table):
  - `privacy_request`: `request_no varchar(20)` (unique, `PR-<year>-<nnn>`), `request_type`, `status`, `subject_kind`, `subject_user_id uuid`, `subject_name varchar(200)`, `subject_email varchar(320)`, `channel`, `received_at timestamptz`, `due_at timestamptz`, `identity_check_note varchar(500)`, `identity_checked_by uuid`, `handled_by uuid`, `closed_at timestamptz`, `outcome text`, `result jsonb` (counts of what was done).
  - `privacy_check`: `privacy_request_id`, `management_system_id`, `status`, `done_by`, `done_at`, `note varchar(500)`; unique on `(privacy_request_id, management_system_id)`.
  - `erased_person`: `erased_user_id uuid` primary key, `pseudonym varchar(40)` (unique, so two erased people never share one; the service draws new hex characters on a clash), `privacy_request_id`, `erased_at`, `erased_by`. The column is not called `user_id`: `platform.secure_tenant_schema()` puts the member check `platform.assert_member` on every `user_id` column, and the erased person is no longer a member when the row is written (D.6.5).
  - `acknowledgement_request`: `management_system_id` (the document's primary system; the request shows in every system the document is linked to), `document_id`, `document_version_id`, `status`, `audience_scope`, `audience_roles text[]`, `audience_count integer`, `due_on date`, `last_reminded_at timestamptz`, `closed_at`, `closed_by`, `evidence_id uuid`; unique on `document_version_id` where `status = 'open'`.
  - `acknowledgement`: `acknowledgement_request_id`, `user_id`, `status`, `opened_at`, `confirmed_at`, `reminded_at`, `reminder_count smallint`, `excused_reason varchar(200)`; unique on `(acknowledgement_request_id, user_id)`.
  - `document`: `acknowledgement_required boolean NOT NULL DEFAULT false`, `acknowledgement_scope`, `acknowledgement_roles text[]`, `acknowledgement_due_days smallint NOT NULL DEFAULT 14 CHECK (acknowledgement_due_days BETWEEN 1 AND 90)`.
  - `retention_rule`: `management_system_id`, `record_class`, `doc_type varchar(20)` (required for `document_version`, null otherwise), `retain_months smallint CHECK (retain_months BETWEEN 1 AND 1200)`, `basis varchar(500)`; unique on `(management_system_id, record_class, coalesce(doc_type, ''))` where `deleted_at IS NULL`.
  - `retention_review`: `management_system_id`, `record_class`, `item_id uuid`, `item_code varchar(60)`, `item_title varchar(300)`, `retention_ends_on date`, `status`, `decision`, `decided_by`, `decided_at`, `reason varchar(1000)`, `keep_until date`, `approved_by`, `approved_at`, `rejected_note varchar(500)`, `disposed_at`, `file_action`, `file_removed_by`, `file_removed_at`; unique on `(record_class, item_id)` where `status IN ('open', 'awaiting_approval')`.
  - `retention_hold`: `management_system_id`, `record_class`, `item_id`, `reason varchar(500)`, `set_by`, `set_at`, `released_by`, `released_at`, `release_reason varchar(500)`.
  - `storage_object`: `replaced_at timestamptz`, `content_disposed_at timestamptz`, `content_disposed_by uuid`.
  - `access_review_setting`: one row per organisation (unique `organization_id`), `frequency_months smallint NOT NULL DEFAULT 3 CHECK (frequency_months IN (1, 3, 6, 12))`, `next_due_on date`, `days_to_complete smallint NOT NULL DEFAULT 14 CHECK (days_to_complete BETWEEN 1 AND 60)`, `version`.
  - `access_review`: `review_no varchar(20)`, `status`, `opened_on date`, `due_on date`, `opened_by uuid` (null when the schedule opened it), `completed_at`, `completed_by`, `cancel_reason varchar(500)`, `summary jsonb`, `report_object_id uuid`; unique on `organization_id` where `status = 'open'`.
  - `access_review_part`: `access_review_id`, `management_system_id` (null for the organisation part), `status`, `signed_off_by`, `signed_off_at`, `evidence_id uuid`, `evidence_filed_at`.
  - `access_review_item`: `access_review_id`, `access_review_part_id`, `subject_user_id`, `item_kind`, `ref jsonb` (the ids of the reviewed row), `role varchar(30)`, `granted_by uuid`, `granted_at timestamptz`, `valid_until date`, `last_sign_in_at timestamptz`, `decision`, `decision_note varchar(500)`, `decided_by`, `decided_at`, `applied_at`, `applied_by`, `applied_action varchar(60)`, `not_applied_reason varchar(500)`.
  - `task.source_rule` becomes `varchar(20)` with the CHECK list of J.7.
  - `export_file`: `kind` and `format` CHECK lists of J.7; `subject_user_id uuid`, `privacy_request_id uuid`.
  - `audit_trail`: `redacted_at timestamptz`, `redaction_id uuid` (outside the hashed columns; the update rule is M3-03's, D.5.4).
  - Grants and row-level security: the migration ends with `SELECT platform.secure_tenant_schema(current_schema())`, as `0008_milestone2.sql` does, which secures the new tables and applies the `DELETE` right on `notification` and `calendar_feed_token` (D.6) that `platform/0007` adds to that function.
- `apps/server/migrations/platform/0007_milestone3.sql`:
  - `platform.organization`: `status` CHECK of J.7 (adds `deleted`), `offboarding_ends_at timestamptz`; `platform.organization_status_event` CHECK lists of J.7.
  - `platform.secure_tenant_schema()` redefined (`CREATE OR REPLACE`) to also grant `DELETE` on `notification` and `calendar_feed_token` to `mscd_app`; `audit_trail` keeps no `UPDATE` right for `mscd_app`.
  - New `platform.organization_export`: `id`, `organization_id`, `status`, `requested_via`, `requested_by uuid`, `requested_at`, `decided_by`, `decided_at`, `decision_note varchar(500)`, `is_final boolean NOT NULL DEFAULT false`, `part_count`, `file_count`, `size_bytes bigint`, `parts jsonb` (storage object id, size and SHA-256 per part), `manifest_object_id uuid`, `manifest_sha256 varchar(64)`, `expires_at`, `completed_at`, `download_count integer`, `error text`; one row in `queued` or `building` per organisation (unique partial index).
  - New `platform.organization_deletion`: `id`, `organization_id`, `status`, `scheduled_for timestamptz`, `scheduled_by uuid` (null for the system), `reason text`, `notify_emails_sealed text` (sealed with `platform.key`, cleared after the certificate email), `final_export_id uuid`, `started_at`, `completed_at`, `failed_step varchar(40)`, `error text`, `report jsonb`, `vault_objects_deleted bigint`, `certificate jsonb`, `certificate_signature text`, `certificate_key_id varchar(64)`; one row not `cancelled` per organisation.
  - `platform.audit_log`: `redacted_at timestamptz`, `redaction_id uuid`.
  - `platform.app_user`: `erased_at timestamptz`.
  - Grants: `platform.secure_platform_schema()` redefined, as `0005` and `0006` did, with: `DELETE` on `platform.session`, `platform.invitation` and `platform.password_reset_token` (D.6.7); `DELETE` on `platform.user_identity`, `platform.mfa_factor`, `platform.mfa_recovery_code` and `platform.user_preference` (the account anonymiser of D.5.2 and the unlinking of D.9; `secret_sealed` and `code_hash` are `NOT NULL`, so these rows are deleted); `offboarding_ends_at` added to the `UPDATE` columns of `platform.organization`; `SELECT, INSERT, UPDATE` on the two new tables with row-level security like the other platform tables; status columns writable only in platform scope (as `organization_status_platform_scope`). `platform.audit_log` keeps `SELECT, INSERT` only.
- Kysely types: the new columns in the existing group files, the new tenant tables in `apps/server/src/db/types/tenant-m3.ts`, the platform tables in `apps/server/src/db/types/platform.ts`.
- `packages/shared/src/enums.ts`: `ORGANIZATION_STATUSES` adds `deleted`; new lists `ORGANIZATION_EXPORT_STATUSES`, `EXPORT_REQUEST_SOURCES`, `ORGANIZATION_DELETION_STATUSES`, `PRIVACY_REQUEST_TYPES`, `PRIVACY_REQUEST_STATUSES`, `PRIVACY_SUBJECT_KINDS`, `PRIVACY_CHANNELS`, `PRIVACY_CHECK_STATUSES`, `ACKNOWLEDGEMENT_SCOPES`, `ACKNOWLEDGEMENT_REQUEST_STATUSES`, `ACKNOWLEDGEMENT_STATUSES`, `RETENTION_RECORD_CLASSES`, `RETENTION_REVIEW_STATUSES`, `RETENTION_DECISIONS`, `DISPOSAL_FILE_ACTIONS`, `ACCESS_REVIEW_STATUSES`, `ACCESS_REVIEW_PART_STATUSES`, `ACCESS_REVIEW_ITEM_KINDS`, `ACCESS_REVIEW_DECISIONS` (values of J.7); `TASK_SOURCE_RULES`, `EXPORT_KINDS` and `EXPORT_FORMATS` add the values of J.7, while the body of `exports.create` keeps the five Milestone 1 kinds; the permissions of J.2; the notification kinds of J.4; the job names of J.3 and `org.lifecycle` in `OPS_RUNNABLE_JOBS`; the audit actions of J.5; the rule ids of J.6. (The session revoke reasons `organisation_deleted` and `account_erased` are server code: M3-03 adds them to `identity/session.service.ts`.)
- `packages/shared/src/authz/matrix.ts`: the rows of J.2.
- `packages/shared/src/machines.ts`: the machines of J.8 with owner `M3-01`; the `organization.status` machine replaces the M2-02 one.
- `packages/shared/src/api/common.ts`: `WORK_PACKAGE_IDS` adds `M3-01` to `M3-11` and `M3-M01` and `M3-M02`; `WorkPackageId` and the owner type of `Machine` accept `M3-${string}`; `ROUTE_AREAS` adds the five new area files. `packages/shared/src/api/routes.ts` concatenates them.
- Profile keys in `apps/server/src/config/profile.schema.ts` and `apps/server/profiles/{saas,onprem,demo,test}.yaml`, with defaults that keep every profile loading:

  | Key | Default | Range | Used by |
  |---|---|---|---|
  | `lifecycle.offboarding_days` | 30 (D-S5) | 0 to 365 | M3-03 |
  | `lifecycle.deletion_grace_days` | 30 (H.1) | 0 to 365 | M3-03 |
  | `lifecycle.deletion_min_grace_days` | 7 (H.1) | 0 to 365 | M3-03 |
  | `lifecycle.export_part_bytes` | 2147483648 (2 GiB) | 64 MiB to 8 GiB | M3-02 |
  | `lifecycle.export_max_bytes` | 107374182400 (100 GiB) | 1 GiB and more | M3-02 |
  | `lifecycle.export_link_days` | 7 (H.3) | 1 to 90 | M3-02 |
  | `lifecycle.backup_copies_end_days` | 780 (D.5.6) | 0 to 3650 | M3-03 |
  | `privacy.request_due_hours` | 72 (H.4) | 24 to 720 | M3-04 |
  | `privacy.session_retention_days` | 90 | 7 to 3650 | M3-04 |
  | `privacy.token_retention_days` | 30 | 1 to 3650 | M3-04 |
  | `privacy.notification_retention_days` | 365 | 30 to 3650 | M3-04 |

  The values below 7 for `lifecycle.offboarding_days`, `lifecycle.deletion_grace_days` and `lifecycle.deletion_min_grace_days` exist for the test stacks of M3-03 and M3-11 only. The server refuses to start with such a value unless its environment holds `MSCD_SAAS_TEST=1` (test stacks only, the rule `backup verify --write-probe` already follows) or the profile is `test`, so a production server can never purge an organisation without the 7-day minimum and its two warning emails. `saas.yaml` and `onprem.yaml` keep the defaults.
- Modules: Nest lists providers explicitly, so M3-01 creates one module per building package with its stub controllers and stub jobs and adds it once to the module lists of `apps/server/src/app/feature-modules.ts` (the list the api and worker run modes share; the `*.module.ts` files of that folder stay as they are): `org-export/org-export.module.ts` (M3-02), `ops/deletion/deletion.module.ts` (M3-03, imported by `ops/ops.module.ts`), `privacy/privacy.module.ts` (M3-04), `acknowledgements/acknowledgements.module.ts` (M3-05), `retention/retention.module.ts` (M3-06), `access-reviews/access-reviews.module.ts` (M3-07). The building package adds providers to its own module, and changes another module file only where its Owns list names it (M3-03 `identity/identity.module.ts`, M3-05 `registers/registers.module.ts`, M3-07 `admin-users/admin-users.module.ts`).
- Jobs: the seven jobs of J.3 are registered with stub handlers that finish without doing anything, one file per job in the folder of the building package, with their payload types in `apps/server/src/common/jobs/job-payloads.ts`. M3-01 also writes their schedule entries in `apps/server/src/modules/jobs/schedules.ts` (J.3), so no later package edits that file. Daily jobs go through the run ledger `platform.daily_job_run` and read their date from the payload (`localDate`, `Clock.runDate`), as every daily job since M2-06; their singleton prefixes are new (M3-01 checks that `pd`, `ak`, `rt` and `ax` are free and picks others if not).
- CLI: `apps/server/src/program.ts` registers `cli/export.ts` with stub actions (`notImplemented`, exit code 2): `export organization` and `export verify` (M3-02). The commands of M3-03 go into the existing `cli/tenant.ts`.
- Pending stubs and sweeps, as M2 D.1 and F: `apps/server/test/int/m2-pending/M3-02.json` to `M3-07.json`; `pending.ts` reads files named `M2-nn`, `M2-Snn` or `M3-nn`; `rbac/expectations.ts` and `security/record-tables.ts` merge `expectations/M3-nn.ts` and `record-tables/M3-nn.ts` (one empty file per building package, M3-02 to M3-07).
- `apps/server/test/setup/tenancy.ts` adds the suites `org-export`, `org-deletion` and `privacy` to the list that fits each (`MULTI_TENANCY_SUITES` for suites whose files run with tenancy `multi` set for the whole file, `OPERATOR_SUITES` for suites whose tests set the tenancy themselves, as `saas-ops` does), so `test:int:saas` runs them; `apps/server/vitest.int-saas.config.ts` reads those lists and stays as it is.
- Changed responses: a response member that D.2 adds to an existing route is optional in wave 1, so the handlers that do not fill it yet keep passing their schemas; the package that fills it makes it required in the area file it owns (R-14).

### D.4 Organisation export

**Who.** A Tenant Admin requests it (`exports.organization.create`). When the organisation has another active Tenant Admin, the request waits until that person approves it (`exports.organization.decide`); the requester can never approve. With one Tenant Admin it is queued at once and the answer warns that nobody else approved it (H.2). Every request, approval and download sends `organization_export_requested` (in the app and by email) to every active Tenant Admin and every primary Management System Manager, so a full download never goes unnoticed. Any active Tenant Admin downloads a ready export. The platform operator starts an export (`ops.exports.create`) and sees its status (`ops.exports.list`) and never downloads one. The move to `offboarding` queues a final export (`requested_via = 'offboarding'`, `is_final`) without approval, because the contract has ended and the customer must get its data.

**Build.** The worker job `org-export.build` (payload `{exportId}`, one build per installation at a time) runs for organisations that are `active` or `offboarding`. It writes:

| Entry | Content |
|---|---|
| `README.txt` | In English and Indonesian: what the export holds, how to check every part with `sha256sum` or PowerShell `Get-FileHash`, how to read the CSV and JSON files, and how to check the audit chain |
| `data/tenant/<table>.csv` and `.jsonl` | Every table of the organisation's schema, every row including rows marked deleted (with `deleted_at`), columns as stored, minus the excluded columns below. CSV: UTF-8, header row, RFC 4180, formula-safe cells as `exports/sheets.ts` writes them. JSON Lines: one object per row. Times in ISO 8601 UTC |
| `data/platform/*.csv` and `.jsonl` | The organisation (slug, name, time zone, sites, region, status, dates); members (email, display name, job title, handle, kind, account and membership status, admin roles, invited by, invited and accepted dates, last sign-in); company sign-in providers without secrets; linked company sign-in (provider, subject, method, date); verified domains; plan and limits; status history; sessions in this organisation (start, last seen, end, method, network address, browser, without the session id); the platform audit log entries of the organisation, without the network address and browser of entries whose actor is a platform operator or the system (those belong to the provider's staff). A person listed in `erased_person` appears under the pseudonym only: no email, name, handle, linked sign-in or session |
| `audit/audit_trail.jsonl` and `.csv` | The tenant chain with `seq`, `prev_hash`, `row_hash`, `redacted_at` and every hashed column, plus each row's canonical text as the database computes it (`platform.audit_canonical_text`), so `export verify` and the customer's own tools recompute every hash without rebuilding PostgreSQL's JSON text |
| `audit/anchors.jsonl` | The signed anchors of the chain (`platform.audit_anchor`), the public key id and the public anchor key itself (`audit-anchor.pub` in PEM) |
| `files/<repository slug>/<object id>/<file name>` | The decrypted content of every `storage_object` in a `managed_vault` repository: document versions, evidence files, evidence pack archives. Objects with `content_disposed_at` are listed in the manifest without content |
| `files/external-files.csv` | Every object kept in the customer's Microsoft 365 or Google Drive repository: adapter, repository, folder, name, external ids, hash, link status, last check. The files stay where they are |
| `manifest.json` (separate download, also in the last part) | Format version 1; organisation id, slug and name; creation time; requester and approver handles; MSCD version; tenant migrations applied; framework pack versions; every part (name, size, SHA-256); every entry (path, part, size, SHA-256, row count for tables); the exclusion list with reasons; counts |

**Excluded.** Password hashes, TOTP secrets, recovery code hashes, session ids, invitation, password reset, calendar feed and guest code token hashes, sealed repository credentials, identity provider client secrets and private keys, data keys, idempotency keys, rate limit counters, job queue rows and the build's own export objects. Data of any other organisation never enters the build: it runs in the organisation's tenant scope and reads platform rows by `organization_id`. The list lives in `org-export/exclusions.ts` with one reason per entry, and the coverage test (R-21) fails on a table that is neither exported nor listed.

**Format and limits.** Parts are gzipped tar files written with the tar writer of `evidence-packs/tar-stream.ts`, extended in `org-export/archive/` with pax headers for long names, so names are never cut at 99 bytes and never collide. A part holds at most `lifecycle.export_part_bytes`. Before the build, the size of the stored files (`storage_object.size_bytes`) is compared with `lifecycle.export_max_bytes`; a larger organisation is refused with 409 `conflict` and `messageKey` `export_too_large`, and the operator raises the key. The worker writes one part at a time to its temporary folder, so its free space must exceed one part; the job checks it first. One export per organisation runs at a time (409 `messageKey` `export_in_progress`).

**Storage and expiry.** Parts and the manifest are vault objects of the organisation under `tenants/<orgId>/exports/organization/<exportId>/`, with `storage_object` rows in the tenant schema, so the purge removes them with everything else. An export expires `lifecycle.export_link_days` after it is ready; a final export stays until the organisation leaves `offboarding`. `cleanup.expired` deletes the content of expired exports through `gateway.objects.delete` and marks them `expired`, for every organisation that is not `deleted` (its tenant cleanup steps run for `active` organisations only, so this step reads `platform.organization_export` directly). It does the same for the 7-day `export_file` exports, which today keep their vault bytes for ever.

**On-premise.** The screen works in single tenancy. `mscd-server export organization --out <dir>` builds the same parts into a folder for the customer's own IT; in multi tenancy it refuses with the message to use the web app, because a server folder would let the operator read tenant data. `mscd-server export verify --dir <dir>` checks every part and entry against the manifest and the audit chain against its anchors.

### D.5 End of contract and verified deletion

#### D.5.1 Timeline

| Step | Status | Who | What happens |
|---|---|---|---|
| Contract ends | `active` or `suspended` to `offboarding` | Operator, with reason and slug (M2-S09) | Read-only for `lifecycle.offboarding_days` (30, D-S5): users sign in, read and export. `offboarding_ends_at` is set. The final export is queued. Tenant Admins get the status email |
| During the read-only period | `offboarding` | Tenant Admins | Download the final export, or request a new one. Reminders 7 days and 1 day before the end (`organization_lifecycle`, in the app and by email) |
| End of the read-only period | `offboarding` to `archived` | `org.lifecycle`, or the operator earlier | Every session ends. The deletion is scheduled for archiving plus `lifecycle.deletion_grace_days` (30). Tenant Admins get an email with the deletion date |
| Grace period | `archived` | Operator | Can move the date (not earlier than archiving plus `lifecycle.deletion_min_grace_days`, 7) or reopen the organisation to `offboarding` for 7 days when the customer forgot an export, which cancels the deletion. Tenant Admins get an email 7 days and 1 day before the deletion |
| Deletion | `archived` to `deleted` | `org.lifecycle` starts `org.purge` on the date | The purge steps of D.5.2, the checks of D.5.3, the certificate of D.5.5 |

`org.lifecycle` runs every hour in platform scope, because the run ledger of the daily jobs skips organisations that are not active. In single tenancy it does nothing and the deletion routes answer 409 `single_tenancy`.

#### D.5.2 Purge steps

`org.purge` (payload `{deletionId}`) runs the steps in order. Each step is idempotent and writes its result into `organization_deletion.report`, so a retry (`ops.deletion.retry`) continues from `failed_step`.

1. **Check and lock.** The deletion is `running` and due, the organisation is `archived`, no other purge runs (advisory lock).
2. **End access.** Sessions, invitations, calendar feed tokens and guest auditor grants of the organisation end.
3. **Accounts.** Each account whose only membership is this organisation's, and which is no platform operator and no system account, is anonymised by `AccountAnonymiser` (`apps/server/src/modules/identity/account-anonymiser.ts`): email `<new handle>@erased.invalid`, handle `erased-<8 hex>`, display name "Former user", job title cleared, password hash, second factors, recovery codes, linked identities, sessions, tokens and preferences removed, status `disabled`, `erased_at` set; audited `user.anonymised` without the old values. Accounts with other memberships keep everything except this organisation's membership. The membership rows themselves go in step 5.
4. **Vault.** `gateway.tenants.purge` removes every version of every object under `tenants/<orgId>/` (document versions, evidence files, evidence packs, exports) and drops the gateway's cached data key. The count goes to `vault_objects_deleted`. Objects that a bucket retention rule still protects are listed with their end date.
5. **Database.** `platform.purge_organization(org_id)` (D.5.4) drops the organisation's schema (`organization.schema_name`, `org_<slug>`) with everything in it (records, sealed repository credentials, notifications, the tenant audit chain), deletes the organisation's rows from the platform tables that hold organisation data (memberships, invitations, sessions, sign-in transactions (`auth_transaction`), identity providers with the rows that hang off them (`user_identity`, `saml_assertion_seen`), verified domains, licences, entitlement, daily job ledger, outbox, queued jobs whose payload names the organisation, rate limit and idempotency rows) and deletes the `platform.tenant_key` row, so the live data key is gone.
6. **Platform audit log.** The entries of this organisation are redacted (D.5.4): network address and browser removed, emails, handles and names inside entries replaced by the pseudonym of the account. Action, time, organisation id and record ids stay. One attestation entry `tenant.audit_redacted` closes the step.
7. **Organisation row.** Status `deleted` with a status event; slug, name, time zone and region stay, so the slug is never reused and the certificate can name the customer.
8. **Checks** (D.5.3), then **certificate** (D.5.5), then **emails**.

MSCD keeps no search index and no copy of tenant data outside the schema, the vault, the platform tables above and the backups: full-text search reads the tenant tables directly, and the per-process caches drop the organisation on the `mscd_tenant_changed` notice.

#### D.5.3 Checks

Each check is recorded with its result. A failed check fails the purge (`failed`, operator alerted by email).

- The organisation's schema (`org_<slug>`) does not exist.
- No row with the organisation id remains in a platform table, except the allowed list: `organization`, `organization_status_event`, `organization_deletion`, `organization_export` (every row `expired`, `rejected` or `failed`, with no content left), the redacted `audit_log` entries and `audit_anchor`; and no row remains that points to one of the organisation's identity providers. The coverage test of R-21 keeps this list complete, also for platform tables that reach the organisation only through a foreign key (for example `user_identity` through `identity_provider`).
- The vault lists no object under `tenants/<orgId>/`, apart from objects a bucket rule protects (listed).
- The data key of the organisation can no longer be unwrapped.
- No account that belonged only to this organisation holds an email, a name or a secret (count).
- The platform chain verifies, with the new attestation, and its newest row is covered by the next anchor run.

#### D.5.4 Database functions and the audit chain

The application role cannot drop a schema or change an audit row, and it keeps that limit. M3-03's migration `platform/0008_milestone3_purge.sql` adds two `SECURITY DEFINER` functions owned by `mscd_migrator`, with `EXECUTE` granted to `mscd_app`:

- `platform.purge_organization(org_id uuid)`: refuses unless the organisation is `archived` and its deletion row is `running` and due; then step 5 of D.5.2; returns the counts as `jsonb`.
- `platform.redact_audit_rows(chain text, seqs bigint[], redaction_id uuid, replacements jsonb)`: for `platform.audit_log` or the `audit_trail` of one tenant schema, sets `source_ip` and `user_agent` to null, replaces the listed values in `entity_code`, `before_data` and `after_data` with pseudonyms, and sets `redacted_at` and `redaction_id`. It never touches `seq`, `prev_hash`, `row_hash`, `action`, `occurred_at` or the record ids. Before it changes a row, it recomputes the row's hash from its current columns and refuses the whole call when one row no longer matches its stored `row_hash`, so a row that was already tampered with can never be passed off as a redaction. It writes, in the same transaction, one attestation entry in the same chain (`tenant.audit_redacted`, `user.audit_redacted` or `privacy.audit_redacted`) whose `after_data` lists every redacted `seq` with its stored `row_hash`.

The append-only triggers allow exactly that update while the function runs (a transaction-local setting the function sets), and refuse every other update as today. `mscd_app` keeps no `UPDATE` right on `platform.audit_log` or any `audit_trail`, so only the function reaches that path. The tenant tables force row-level security, which binds the function owner too, so the function sets `app.org_id` to the organisation of the chain before it touches a tenant `audit_trail`.

**Why the chain stays intact.** Each row's `row_hash` is SHA-256 over the previous row's hash and the row's columns, and the next row stores that hash as its `prev_hash`. Redaction leaves every stored hash in place, so every link from row to row still checks, and the signed anchors (which sign a `seq` and its `row_hash`) still verify. For a redacted row the verifier cannot recompute the hash from the changed columns, so it checks two things instead: the stored hash is the one listed for that row in a later attestation entry, and the attestation entry itself verifies and is covered by an anchor. So nobody can add, remove or reorder a row unnoticed, and a redaction is always visible in the chain with its date and reason. `runVerification` and `AuditChainVerifier` of `audit/chain-verifier.ts` and `audit-trail.service.ts` (M3-03) apply this rule and report the number of redacted rows.

#### D.5.5 Deletion certificate

A JSON document signed with Ed25519 by the audit anchor key of the worker (`audit.anchor_key_file`, the key that signs anchors), stored in `organization_deletion.certificate` with its signature, and holding:

- the member `type: "mscd-deletion-certificate-v1"`, which no anchor payload has, so a certificate can never pass as an anchor and an anchor never as a certificate;
- certificate id, installation id, organisation id, slug and name;
- dates: offboarding started, archived, deletion scheduled by whom, deletion completed;
- the final export (id, ready date, manifest SHA-256) or "no export taken";
- counts per step and the result of every check;
- what remains and why: the organisation row with status `deleted`, its status history and this deletion record (no personal data); the platform audit entries of the organisation without network addresses, browsers, emails or names; the signed anchor files of the deleted chain under `audit-anchors/org_<slug>.audit_trail/` in the vault bucket, outside `tenants/<orgId>/`, which object lock keeps for 10 years from each anchor (`ANCHOR_LOCK_DAYS`); they hold the chain name (which carries the slug), sequence numbers, hashes, times and the installation id, and no personal data; the files and evidence pack copies in the customer's own Microsoft 365 or Google Drive repositories, listed by adapter and repository name, which belong to the customer and which MSCD does not touch;
- the backup statement of D.5.6 with its end date;
- how to check the certificate: `mscd-server tenant verify-certificate <file>` against the release's trusted anchor keys.

The certificate is emailed to the Tenant Admins captured when the deletion was scheduled (`notify_emails_sealed`, cleared after sending, so the record then holds only the count) and to every platform operator, and operators download it from the console (`ops.deletion.certificate`).

#### D.5.6 Backups, in honest words

Deleting an organisation does not reach into the backups at once. Three things keep copies after the deletion (`docs/saas/backup-restore.md`):

- The restic repository keeps 14 daily, 8 weekly and 12 monthly copies of the database and the pre-deploy dumps (D-S6), so the last monthly copy that holds the organisation leaves the retention about 12 months after the deletion, and its data is removed at the next Sunday `prune`.
- The off-site bucket has versioning on, as `backup-restore.md` recommends, so every file that `prune` or the vault sync removes stays there as an old version until the bucket's lifecycle rule removes it: 400 days with the recommended rule. That holds for the restic data and for the vault copy alike.
- The pre-deploy database copies on the server are removed after three further deploys, and the weekly restore test removes its copy when the job ends.

So, with the recommended bucket settings, the last copy is gone at the latest about 12 months, plus 7 days, plus 400 days after the deletion: about 26 months. With object lock instead, or another lifecycle period, the end moves with it, and without a lifecycle rule old versions never leave the bucket. The backups are encrypted, kept at a second provider, and used only to rebuild the whole service after a disaster and by the weekly restore test. The certificate states the end date as the deletion date plus `lifecycle.backup_copies_end_days` (780 by default: 366 + 7 + 400 days, rounded up), names the bucket settings that date assumes, and says the date holds only while the bucket keeps those settings. The operator sets the value to match the real bucket (`backup-restore.md`, M3-03).

Two changes keep this true in practice:

- **Backup guard.** `deploy/backup/backup.sh` has two stops for the vault sync: it stops when the vault holds fewer objects than the copy by more than a tenth of the copy, and rclone `--max-delete` ends the sync after deleting a tenth of the copy (at least 100). Both now allow, on top, the number of objects that purges completed in the last 72 hours removed (`organization_deletion.vault_objects_deleted`, read from the database the backup already dumps), so the night after a purge the backup runs and stops only for losses no purge explains.
- **Restore.** A restore from a copy older than a deletion brings the organisation back, in any status it had then, maybe without a deletion row. `deploy/backup/restore.sh --reapply-deletions <folder>` runs `mscd-server tenant purge --reapply <certificate> --confirm <slug>` for every certificate in the folder. The command checks the signature against the trusted anchor keys and that the certificate names this organisation id, then moves the organisation to `archived` and its deletion row to `running` with `scheduled_for` set to now, as the system (the re-apply transitions of J.8), and queues `org.purge` for the worker, which holds the gateway certificate the purge needs. `backup-restore.md` tells the operator to collect the certificates from the operators' mailbox before a restore.

### D.6 Requests from one person

#### D.6.1 Who does what

- The data subject is a person whose personal data the organisation holds: a member (an account with a membership), a former member, or a person who has no account and is only named in the text of records, for example a contact of an interested party or a business associate who is an individual (ISO 37001).
- The customer organisation is the controller (the party that decides why and how the data is used) and answers the person. A Tenant Admin records the request after checking who is asking, decides, acts and answers. Management System Managers check their own systems (D.6.4).
- A member files a request in "My account" (`me.privacy-requests.create`), and can download their own data (`exports.me.create`) and correct their own name and job title (`me.profile`) without a request (H.6).
- The provider is the processor (it handles the data on the customer's instructions; processors are UU PDP Article 51 in `docs/saas/legal-inputs.md`, and the lawyer confirms the roles). A request that reaches the provider is forwarded to the organisation's Tenant Admins within 1 working day, without confirming whether the person has an account anywhere. The provider keeps a short forwarding log outside MSCD with date, organisation and request type and no details of the person; it no longer runs database queries for requests (M3-11 rewrites the procedure in `docs/saas/records-of-processing.md`).

#### D.6.2 Deadline

UU PDP (Law No. 27 of 2022) gives people rights over their personal data, and the facts for the lawyer note short deadlines for controllers, for example 3 x 24 hours for access and correction requests (`docs/saas/legal-inputs.md`, question 13). The lawyer confirms the rights, the articles and the deadline of each type. Each request gets `due_at` = `received_at` plus `privacy.request_due_hours` (72). The daily job `privacy.deadlines` notifies the Tenant Admins of requests due within 24 hours and of overdue ones (`privacy_request_due`); the screens show the time left. The lawyer confirms the deadline per type (H.4).

#### D.6.3 Types and actions

| Type | Action in MSCD | Result for the person |
|---|---|---|
| `access` (see or get a copy) | `exports.person.create` builds a JSON file: account fields this organisation sees (email, display name, job title, handle, kind, status, dates), membership and admin roles, business roles per system with grant dates, linked company sign-in for this organisation's providers, sessions and sign-in events in this organisation, audit trail entries where the person acted, records the person owns or holds (code, title, status, due date), confirmations, competence records about the person, notifications, and the person's requests. Secrets and other people's data are left out. The Tenant Admin downloads it and sends it through a channel agreed with the person; a member can download the same file directly (`exports.me.create`) | A copy within the deadline |
| `rectification` (correct) | `privacy-requests.rectify` changes display name and job title when the account has no other active membership; otherwise the person corrects them in "My account" (`me.profile`), because the account is shared. Text in records is corrected by the record owner or the system manager | Correct data |
| `restriction` (stop using; also an objection) | `privacy-requests.restrict` disables the membership: no sign-in, no notifications, no new work for the person in this organisation | Processing stops; records stay |
| `erasure` (delete) | `privacy-requests.erase` (D.6.5) after every system check is done | The person's name, email and handle no longer appear in the organisation's records, lists or audit entries; the request record keeps them as proof that the request was answered, and backups keep older copies until they age out (D.5.6) |

#### D.6.4 System checks and mentions

Creating a request of type `access` or `erasure` opens one `privacy_check` per management system of the organisation, with a stored task (source `privacy_check`) for the primary Management System Manager and the notification `privacy_check_requested`. The manager opens `privacy-checks.mentions`, which searches the text columns of the system's records for the person's name, email and handle (case-insensitive, at most 500 results with record kind, code, field and a short excerpt). The searched columns are listed in `privacy/mention-columns.ts` (titles, descriptions, notes, justifications, `audit_event.lead_auditor_name`, `storage_object.provider_modified_by`, the titles and texts of interested parties and business associates, for example `interested_party.requirements`; MSCD has no separate contact fields), and a coverage test fails on a new tenant text column that is neither listed nor marked as holding no person data. The manager edits what must change through the existing record screens, reassigns the person's open items with Handover (`records.holdings.reassign`), and marks the check done with a note.

#### D.6.5 Erasure

Erasure applies to this organisation. Preconditions: every check is done; the person holds no open items in any system (`admin.users.holdings` counts are zero, else 422 rule `ERASE-OPEN-ITEMS`); the person is not the last active Tenant Admin (409 `messageKey` `last_tenant_admin`). Then in one transaction:

1. Business roles are revoked (`role.revoked`, written by the privacy service in this transaction: `RoleGrantsService.revoke` runs its own request and transaction), the membership is marked removed (`deleted_at`; `mscd_app` has no `DELETE` on memberships), the person's sessions in this organisation end.
2. An `erased_person` row gives the person a pseudonym, "Former user" with 4 hex characters, which this organisation shows wherever it showed the name: the read model people of `/ui/*`, user lists, audit trail views, exports and the organisation export of D.4.
3. Pending confirmations become `excused`; open tasks of the person are cancelled; the person's notifications and calendar feed tokens in this organisation are deleted.
4. The organisation's audit trail entries where the person acted or is the subject, and the platform audit log entries of this organisation about the person, are redacted (D.5.4) with the attestations `privacy.audit_redacted` and `user.audit_redacted`.
5. When the account has no other membership and is no platform operator, `AccountAnonymiser` anonymises the account (D.5.2 step 3).

For a subject without an account, erasure is the edit of every mention found by the checks; the request records what was changed.

**What stays, and why.** The organisation's records stay under the pseudonym, because they are its ISO evidence (who verified a control, who accepted a risk). Audit entries stay with action, time and record, without the person's network address, browser, email or name, because removing rows would break the integrity chain that customers and auditors rely on (legal inputs, question 7). Competence records about the person stay under the pseudonym until disposed of under retention (D.8). An account that the person still uses in another organisation stays, because that organisation holds it. Backups keep older copies until they age out (D.5.6). The request record itself, with the name as entered, stays as proof that the request was answered; the lawyer confirms how long. The lawyer confirms this approach (H.5).

#### D.6.6 The person's own screen

"My account" (`account`) gains "My data": "Download my data" (`exports.me.create`, then the existing export download), "Correct my name and job title" (`me.profile`), "Ask the organisation" (correction, restriction or erasure, `me.privacy-requests.create`) and the list of the person's requests with status and due time.

#### D.6.7 Technical data with a retention period

The facts for the lawyer list data that stays without an end today (`docs/saas/records-of-processing.md`, retention gaps). M3-04 extends `cleanup.expired`:

| Data | Removed after |
|---|---|
| Ended sessions (with network address and browser) | `privacy.session_retention_days` (90) after the end |
| Used or expired invitations and password tokens | `privacy.token_retention_days` (30) after use or expiry |
| Read notifications, except those a `reminder` row refers to (the reminder is the record that it was sent) | `privacy.notification_retention_days` (365) after reading |
| Expired export files | Removed by M3-02 (D.4) |

### D.7 Read confirmation of policies

**Audit terms in plain words.**
- ISO/IEC 27001:2022 control A.5.1 (policies for information security): policies are approved, published, communicated to the people concerned and *acknowledged* by them, which means each person says they have read them.
- A.6.3 (information security awareness, education and training): people receive awareness, education and training, and regular updates of the policies and procedures that concern their work.
- Clause 7.3 of each standard (awareness): people know the policy, how they contribute, and what happens if they do not follow it. The policy clause of each standard asks that the policy is communicated inside the organisation (5.2.2 in ISO 9001 and ISO 22301, 5.2 in ISO/IEC 27001 and ISO 37001).
- A.5.37 (documented operating procedures): operating procedures for information processing facilities are written down and available to the people who need them.
- The confirmation register is the record that proves these were done.

**Setting.** Each document has `acknowledgement_required`, `acknowledgement_scope` and, for scope `roles`, `acknowledgement_roles`, and `acknowledgement_due_days` (default 14). The audience scopes: `system_roles` (default: every active member with a business role in a system the document is linked to through `entity_ms_link`; an organisation-wide document (`is_org_wide`) reaches every system), `roles` (only the holders of the chosen business roles) and `organisation` (every active member with a business role in any system of the organisation). Guests and external auditors are never in the audience. A member without any business role is left out, because the screens of a system, "Policies to confirm" among them, need `ms.read` in a selected system, as "My account" does today; the handoff of M3-05 names this gap (an organisation-wide screen permission every member holds, an open item of M2-16).

**Request.** Approving a version of such a document (`documents.transition` to `approved`) opens an `acknowledgement_request` for that version and closes the open request of the previous version (its pending rows become `excused`, reason "replaced by version X"). A Management System Manager can also start one for the current approved version (`acknowledgement-requests.create`), for documents approved before Milestone 3. The audience is fixed when the request opens: one `acknowledgement` row and one stored task (source `acknowledgement`) per person, and the notification `acknowledgement_requested`.

**Confirming.** The person opens "Policies to confirm" (`my-confirmations`, also reached from the task, the notification and a banner in the host layer that counts open confirmations). "Open document" calls `me.acknowledgements.open`, which records `opened_at` and returns a short-lived address of the version's file through the redirect token of `apps/server/src/modules/files/redirect-token.ts`, also for a member who has no file rights in that system, and only for that version (`acknowledgement.opened`, plus the existing `file.opened`). For a file kept in the customer's repository the address is the provider's, and the person's own access there applies. "I have read and understood this document" calls `me.acknowledgements.confirm`; before opening it is refused with rule `ACK-OPEN-FIRST` (H.7). The task closes.

**Reminders.** The daily job `acknowledgement.reminders` reminds pending people 7 days after the start and on the due date, then every 7 days, at most three times; overdue requests reach the Management System Managers in the digest (`acknowledgement_overdue`). The same job marks `excused`, with the reason, a person whose membership ended or who lost the role that put them in the audience, so the membership and role services stay unchanged.

**Register.** `acknowledgements` shows each request with its totals (confirmed, pending, overdue, excused). The person list needs `audit.pending.all` [MM, PO]; Top Management and anyone with only `audit.pending.aggregate` see totals (product decision 2); Internal Auditors see neither, since they do not see everyone's pending list (product decision 3), and read the filed register as evidence. "Export CSV" downloads the register. "Close and file as evidence" stops reminders and files the register CSV as a new file of the chosen evidence item (for example the evidence of A.5.1 or clause 7.3) through `fileGeneratedEvidence` (M3-01), so it counts for freshness and evidence packs like any upload.

### D.8 Retention and disposal review

**Audit terms in plain words.**
- ISO/IEC 27001:2022 control A.5.33 (protection of records): records are protected from loss, destruction, falsification, unauthorised access and unauthorised release. The guidance of ISO/IEC 27002 for this control adds retention periods and the disposal of records when the period ends, as laws, contracts and the business require.
- ISO 9001 clause 7.5.3 (control of documented information), with the same clause in ISO/IEC 27001, ISO 22301 and ISO 37001: the organisation decides how long it keeps documented information (*retention*) and what happens to it afterwards (*disposition*, for example destruction). ISO 9001 also asks that records kept as evidence of conformity are protected from unintended changes.
- A *retention period* is how long a record is kept; a *disposal review* is the check, when the period ends, of whether it may now be destroyed; a *legal hold* keeps a record whatever its period says, for example during a dispute or an investigation.

**Record classes.** Rules are set per management system (`retention.rules.put`), per class, and for document versions per document type (`doc_type` of the pack lookup: policy, standard, procedure, plan, register, record, form):

| Class | Items | Period starts | Dispose does |
|---|---|---|---|
| `document_version` | Superseded versions of documents | The approval date of the version that replaced it | File content in the Managed Vault deleted (`gateway.objects.delete`, `content_disposed_at` set); the version row keeps label, dates and hash. In the customer's repository the document owner is asked to delete the file, and "File removed" records it |
| `evidence_file` | Earlier files of evidence items (`storage_object.replaced_at`) and files of evidence items marked deleted | The replacement or deletion date | As above |
| `evidence_pack` | Built evidence packs | The build date | The archive and manifests in the vault deleted; copies under `_packs/` in a customer drive are the customer's (owner asked) |
| `audit_event` | Audit events with a recorded result | The event's last day | The record is marked deleted (`deleted_at`) in the disposal transaction with `writeRow` of `registers/command-support.ts`, as `RecordsService.softDelete` of `records.delete` (BP WP-35) does, with the reason, audited `record.disposed`. `records.delete` itself is not used: it opens its own transaction, audits `record.deleted` and does not cover `audit_event`. Attached files follow the file rows above |
| `finding` | Closed findings | The closing date | As `audit_event` |
| `corrective_action` | Closed corrective actions | The closing date | As `audit_event` |
| `management_review` | Closed management reviews | The closing date | As `audit_event` |
| `competence_record` | Competence records past `valid_until` or marked deleted | `valid_until` or the deletion date | As `audit_event` |

The default period of every class is 36 months, one full certification cycle (H.8). `retention.rules.list` shows each value in force marked "default" or "set", as the freshness limits of M2-07 do. The `basis` field says why (law, contract, standard).

**Review.** The daily job `retention.review` opens a `retention_review` for every item whose period ended, unless the item is under a hold or a "keep until" date lies ahead, and sends the Management System Managers the digest `retention_review_due`. M3-06 sets `replaced_at` when an evidence file is replaced and, on the job's first run, fills it for older replacements from the `evidence.file_uploaded` and `evidence.file_linked` audit entries (their `before.storageObjectId`).

**Decision.** In `retention` ("Due for review"), a manager selects items and decides (`retention.reviews.decide`, reason required):
- **Keep** until a date: the review becomes `kept` and opens again on that date.
- **Extend** by months: the end date moves (`extended`).
- **Dispose**: refused for an item under a hold (`RET-HOLD`), before its period ends (`RET-NOT-DUE`), and for a document's current approved version or an evidence item's current file (`RET-CURRENT`). Otherwise the review waits for approval (`awaiting_approval`) and `disposal_approval_pending` goes to the other managers and Programme Owners.

A second person with `retention.approve` approves (`retention.reviews.approve`; the proposer is refused with `SOD-SELF-APPROVE`), and the disposal runs at once, as the table says; or rejects it back to review with a note.

**Holds.** `retention.holds.create` keeps an item whatever its period says until released with a reason. A hold set on an item with an open review takes it out of the review list.

**Register.** "Disposal register" lists every decision with item, class, period, decision, reason, decider, approver, dates and file action, and downloads as CSV: the evidence for A.5.33 and 7.5.3. Detail extensions for `doc` and `ev` show the retention end date and any hold.

### D.9 Periodic access review

**Audit terms in plain words.** ISO/IEC 27001:2022 control A.5.18 (access rights) asks that access rights are given, *reviewed*, changed and removed according to the organisation's rules for access control; the guidance of ISO/IEC 27002 says the review happens at regular intervals and after changes such as a new job or a departure. A.5.15 (access control) sets that policy, and A.8.2 (privileged access rights) asks for closer control of administrator rights. An *access review* is the regular check that every person still needs each right they hold, followed by removing what is no longer needed, with a dated record to show the auditor.

**Settings.** `access-reviews.settings.put`: how often (1, 3, 6 or 12 months; default every 3 months, H.9), the next due date, and the days to complete (default 14).

**Opening.** The daily job `access-review.open` opens a review when the due date has come and none is open, moves the next due date on by the frequency, and notifies (`access_review_due`) the Tenant Admins and the reviewers of each system part. Each system part gets one stored task (source `access_review`, entity `access_review_part`) for the system's primary Management System Manager, because the task table keeps one open task per record (C.3); the other reviewers work from the notification and the screen. The organisation part has no stored task: the Tenant Admins reach it from the notification and Access reviews. A Tenant Admin can also open one at once. The review takes a snapshot of every right in force, so the report shows the state that was reviewed:

| Item kind | Rows | Part | Decided by |
|---|---|---|---|
| `membership` | Every active or invited membership, with last sign-in in this organisation | Organisation | Tenant Admins (`access_review.manage`) |
| `admin_role` | Each Tenant Admin and Storage Admin role | Organisation | Tenant Admins |
| `linked_sign_in` | Each linked company sign-in for this organisation's providers | Organisation | Tenant Admins |
| `business_role` | Each active or pending `user_ms_role` of the system, including External Auditor roles with their end date, with requester, approver and grant date | The system | The system's Management System Managers and Programme Owners (`access_review.decide`) |
| `auditor_access` | Each open guest auditor grant (`auditor_access_grant`) | The system | The same |

Nobody decides on their own access (`REVIEW-OWN-ACCESS`). When the organisation has one Tenant Admin, that admin's own organisation items stay "needs a second reviewer", and the review can still complete with the warning `REVIEW-SINGLE-ADMIN`, which the report shows (as M2 D2-12 warns without relaxing rules).

**Decisions and applying them.** Each item gets **keep**, **change** (with a note, for example a shorter end date) or **revoke**. Revocations are applied by people who hold the right, through the existing services, each audited as today plus `access_review.item_applied`:

| Item | Applied by | Through |
|---|---|---|
| `business_role` revoke | Tenant Admin (`access-reviews.apply`) | `RoleGrantsService.revoke` (`role.revoked`) |
| `admin_role` revoke | Tenant Admin | `UsersService.update` with the new admin roles (`membership.updated`) |
| `membership` revoke | Tenant Admin | `UsersService.update` with `membershipStatus: 'disabled'` |
| `linked_sign_in` revoke | Tenant Admin | `admin.users.identities.remove` (`identity.unlinked`) |
| `auditor_access` revoke | Management System Manager (`access-reviews.ms.apply`) | `AuditorAccessService.revoke` (`auditor_access.revoked`) |
| Any `change` | The person who holds the right, on People and roles or Auditor access | Then "Mark as applied" records it |

An item that will not be applied gets a reason instead.

**Sign-off and completion.** Each system part is signed off when every item is decided (`access-reviews.ms.sign-off`). The review completes (`access-reviews.complete`) when every part is signed off and every revocation is applied or explained; the overdue reminders (`access_review_overdue`) run every 7 days after the due date until then. Completion stores the report CSV in the vault and files each system's rows as a new file of the evidence item named at sign-off, through `fileGeneratedEvidence` (M3-01). For a system on ISO/IEC 27001 the sign-off form proposes the evidence item whose targets include control `A.5.18` (the requirement code of the ISO27001-2022 pack), so the completed review becomes A.5.18 evidence without extra work.

### D.10 Open work totals for Top Management

`pending-totals` (M3-08) reads `GET /api/v1/ms/:ms/audit/pending?aggregate=unit` and shows, for the selected system, open and overdue counts per chain stage and per business role, with no name, holder or due date, as product decision 2 asks. "All my systems" adds a table with one row per system where the person holds `audit.pending.aggregate`, from one call per system. Page actions "Open work totals" on the built-in screens `chain` and `m1overview` lead to it in API builds (C.1); the sample build reaches the screen through its address. Management System Managers and Programme Owners see the same screen (they hold the permission). The sample adapter computes the same totals from the sample chain items.

## E. Demo personas

M3-10 adds three demo people, in the same organisations as the four existing personas (`ndt`, `bsd`, `rmn` and `tst`), with their own records so each role shows real work (H.10):

| Handle | Name, job title | Business role | Sample UI role | Records in the demo |
|---|---|---|---|---|
| `wulan` | Wulan Hartono, Director of Operations | `programme_owner` in every system | `sponsor` | Approver of several documents; verifies entries; owns the management review of the ISMS |
| `ratna` | Ratna Kusumawati, Finance and Risk Manager | `risk_owner` in the ISMS and BCMS | `riskowner` | Owner of a set of ISMS and BCMS risks, with a residual risk acceptance |
| `gilang` | Gilang Saputra, Compliance Investigator | `compliance_investigator` in the ABMS | `investigator` | Owner of ABMS due diligence records and a finding about an investigation |

- Server seed: `apps/server/src/seed/people.ts` and `org-writer.ts`, with the demo password and the TOTP rule of BP G.3 (`node tools/scripts/demo-totp.mjs wulan` works without a change); the demo Keycloak realm (`deploy/compose/dev/keycloak/realm-mscd.json`) gets the three users for the company sign-in demo. The seed also writes one open read confirmation request, retention rules with one due review, and one open access review, so the new screens have content in the demo.
- Sample build: `apps/web/src/data/mscd-data.js` gains the three people and the `ROLES` entries `sponsor`, `riskowner` and `investigator`; the seed snapshot and the mock provider fixture are regenerated (`node apps/web/scripts/export-sample-snapshot.mjs`).
- Persona values: `UI_ROLES` and `UI_ROLE_LABELS` (`packages/shared/src/enums.ts`) add `sponsor`, `riskowner` and `investigator`; `uiRoleFor` takes the first match in this order: `ms_manager` gives `manager`, `programme_owner` `sponsor`, `internal_auditor` or `external_auditor` `auditor`, `top_management` `top`, `domain_owner` `owner`, `risk_owner` `riskowner`, `compliance_investigator` `investigator`; `DEMO_PERSONAS` names the new handles; the web type `UiRole` (`apps/web/src/data/types.ts`), `UI_ROLE_LABEL` (`apps/web/src/screens/roles.ts`) and `PERSONAS` (`apps/web/src/routing/address.ts`) accept them.
- Same view as today: real users get the new UI roles in the API build too (`me.get` computes `uiRoleByMs` with `uiRoleFor`), so every place that compares UI roles treats `sponsor` as `manager`, and `riskowner` and `investigator` as `owner`, through one helper in `MscdApp.jsx` (for example `baseRole`): `visFor` (sidebar and built-in screens a role may open), the own-item filter of the Controls, Freshness and Documents screens (`role==='owner'`), the landing screen of `startScreen` (My Tasks for `owner`), and the sample-mode checks `canVerify` and `canSeePeople`. A Risk Owner in the API build still sees only their own items and lands on My Tasks, and a Programme Owner still sees what a Management System Manager sees. `apps/web/test/api/controller.test.ts` checks each of these for the three new roles.
- Sample permissions: `SAMPLE_GRANTS` in `apps/web/src/screens/host.tsx` comes from the F.6 matrix (`permissionsFor` of each persona's business role), except `manager`, which keeps every permission because it stands for the administrators of the sample organisation (M2 C.2). Host screens list the new personas in `roles` where their permissions open the screen.
- Counts: the seed has 93 users (90 today), each sample organisation 89 active members (86 today), and the sample licence shows "89 of 150". `seed-command.test.ts`, `demo-template.test.ts`, the parity tests, `apps/web/test/screens/license.test.tsx` and the specs that show the count (`e2e/screens/license.spec.js`, `e2e/screens/ops-organizations.spec.js`) change in the same package with the reason (R-15).
- Release: the personas exist only in demo material (R-13). `deploy/scripts/check-release-artefacts.sh` also fails when the display name of any demo persona appears in release packs or profiles.

## F. Testing in Milestone 3

The layers of M2 F apply. Additions:

| Layer | What Milestone 3 adds |
|---|---|
| Server integration | One folder per building package: `test/int/org-export`, `org-deletion`, `privacy`, `acknowledgements`, `retention`, `access-reviews`. Every route: success, every rule, scope, audit entry, `If-Match`. `org-export`, `org-deletion` and `privacy` also run in `test:int:saas` (multi tenancy, two organisations) |
| Coverage | The export coverage test (M3-02), the deletion coverage test over platform tables with `organization_id` (M3-03) and the mention column test (M3-04) fail on a new table or column that nobody classified (R-21) |
| Irreversible steps | Purge and redaction tests run against the Testcontainers database and a throwaway gateway bucket only (R-20): purge of one organisation leaves the other's rows, vault objects and chain intact; a retry after a forced failure finishes; the chain verifies after redaction and fails when a redacted row is changed without attestation |
| Contract, RBAC, security | M3-01 adds routes, matrix rows and sweep files; each building package fills `rbac/expectations/M3-nn.ts` and `security/record-tables/M3-nn.ts` and deletes its `m2-pending/M3-nn.json` |
| Web | Unit, sample E2E, API E2E and contrast per screen as M2 F and C.2 here. API sessions: `tenant.admin` (admin screens), `rina` (manager flows), `bagus` (a person who confirms a policy), `hendra` (totals), `ops` (operator console) |
| Journey | The lifecycle run of M3-11 on the SaaS test stack, plus the existing journeys and smoke test |

## G. Work packages

### G.1 Waves

A wave starts when every package of the previous wave is done and committed (R-10). Packages in one wave own disjoint paths. "Host stack" names the R-05 stacks a package runs; they queue on the lock.

| Wave | Packages, in start order | Lockfile owner | Owners of shared files in this wave | Host stack |
|---|---|---|---|---|
| 1 | M3-01 Contract, schema, permissions and storage functions; M3-08 Open work totals; M3-M01 Open follow-ups | none | M3-01: `packages/shared/src/**`, `packages/shared/test/**`, migrations `tenant/0009` and `platform/0007`, DB types, `profile.schema.ts` and the new keys in `apps/server/profiles/*.yaml`, `program.ts`, `apps/server/src/app/feature-modules.ts`, `ops/ops.module.ts`, `jobs/schedules.ts`, `common/jobs/job-payloads.ts`, `common/tokens.ts` (gateway interface), `apps/server/src/gateway/**`, `storage/gateway-client.ts`, `files/{object-access.service.ts,file-commands.service.ts,generated-evidence.ts}`, the `content_disposed_at` checks in `evidence-packs/evidence-packs.service.ts`, `integrity/integrity.service.ts` and `link-health/link-health.service.ts`, `apps/server/test/setup/tenancy.ts`, the sweep and pending files. M3-M01: `deploy/scripts/{install.sh,upgrade.sh,uninstall.sh,lib/common.sh,build-bundle.sh}`, `deploy/docker/{server,web}.Dockerfile` (notices copy only), `.github/workflows/ci.yml` (one step outside the browser jobs), `docs/INSTALL-ONPREM.md` | M3-08 API E2E; M3-M01 bundle build and installer rehearsal |
| 2 | M3-03 End of contract and verified deletion; M3-02 Organisation export; M3-05 Read confirmation; M3-06 Retention and disposal | none | M3-03: `apps/server/src/modules/ops/**` except `ops.module.ts`, `identity/{identity.module.ts,mail-templates.ts,account-anonymiser.ts}` and the `archived` checks of D.5 (with `evidence-packs/evidence-pack-build.job.ts`), `modules/audit/**`, `jobs/audit-verify-chain.job.ts`, `modules/tenancy/**`, `cli/tenant.ts`, `deploy/backup/**`, `platform/0008`, `docs/saas/backup-restore.md`, `packages/shared/src/api/{ops,admin-users,audit-trail}.ts` (schemas). M3-02: `jobs/{cleanup-expired.job.ts,tenant-cleanup.ts}`, `cli/export.ts`, `docs/INSTALL-ONPREM.md`. M3-05: `registers/{documents.service.ts,records.service.ts,registers.module.ts}`, `packages/shared/src/api/documents.ts` (schemas). M3-06: `files/file-commands.service.ts` | M3-03 restore test; M3-05 and M3-06 API E2E |
| 3 | M3-04 Requests from one person; M3-07 Periodic access review; M3-09 Export and deletion screens | none | M3-04: `modules/exports/**`, `jobs/{cleanup-expired.job.ts,tenant-cleanup.ts}`, `modules/read-model/**`, `audit/audit-trail.service.ts`, `admin-users/user-views.ts`, `apps/web/src/screens/account/**`, `packages/shared/src/api/exports.ts` (schemas). M3-07: `admin-users/{admin-users.controller.ts,admin-users.module.ts,identities.service.ts}`, `packages/shared/src/api/admin-users.ts` (schemas). M3-09: `apps/web/src/screens/ops/**` | API E2E each, one at a time on the lock |
| 4 | M3-10 Demo personas; M3-11 Data lifecycle run and documents | none | M3-10: `apps/server/src/seed/**`, `apps/web/src/data/mscd-data.js`, the seed snapshot, `tools/mock-providers/fixtures/demo.json`, `apps/web/src/MscdApp.jsx` (UI role handling only), `apps/web/src/data/types.ts` (`UiRole` only), `apps/web/src/screens/roles.ts` (`UI_ROLE_LABEL` only), `apps/web/src/screens/host.tsx`, `apps/web/src/routing/address.ts`, the `roles` field of every host screen, `apps/web/test/api/controller.test.ts`, `apps/web/test/screens/host.test.tsx`, `packages/shared/src/{enums.ts,authz/matrix.ts}` (persona values only), `deploy/scripts/check-release-artefacts.sh`, `deploy/compose/dev/keycloak/realm-mscd.json`. M3-11: `tools/smoke/**`, `docs/saas/{records-of-processing,legal-inputs,operator,README}.md`, `docs/product/USER-FLOWS.md`, `docs/platform/ui-contract.md`, `apps/web/src/screens/notifications/**` | M3-10 API E2E and smoke; M3-11 lifecycle run, journeys, SaaS run |
| 5 | M3-M02 Major dependency upgrades (alone) | M3-M02 | any file | every suite |

Wave 1 holds M3-01 with the two packages that need no contract: M3-08 reads an existing route, and M3-M01 touches only installer and packaging files. M3-03 starts first in wave 2 because the first customer may leave before Milestone 3 ends. M3-04 waits for wave 3 because it reuses the account anonymiser and the redaction function of M3-03, and M3-09 because it shows the routes of M3-02 and M3-03. M3-10 waits for wave 4 because its seed fills the screens of M3-05 to M3-07. Waves 1 to 4 do not depend on the maintenance track; when the owner drops it, M3-M01 leaves wave 1 and wave 5 does not run.

Files that several packages touch, with their owner per wave:

| File or path | Owner per wave |
|---|---|
| `packages/shared/src/**` | M3-01 (1, every file). Then schemas only, in the area files each package lists: M3-02 `org-export.ts`, M3-03 `ops.ts`, `admin-users.ts` and `audit-trail.ts`, M3-05 `acknowledgements.ts` and `documents.ts`, M3-06 `retention.ts` (2); M3-04 `privacy.ts` and `exports.ts`, M3-07 `access-reviews.ts` and `admin-users.ts` (3); M3-10 the persona values (4) |
| `apps/server/src/modules/jobs/{cleanup-expired.job.ts,tenant-cleanup.ts}` | M3-02 (2), M3-04 (3) |
| `apps/server/src/modules/audit/**` | M3-03 (2), M3-04 (3, `audit-trail.service.ts` only) |
| `apps/server/src/modules/files/**` | M3-01 (1, the three files named), M3-06 (2, `file-commands.service.ts`) |
| `apps/server/src/modules/admin-users/**` | M3-01 (1, the stub of `admin.users.identities.remove` in `admin-users.controller.ts`), M3-03 (2, `organization.service.ts`), M3-07 (3, `admin-users.controller.ts`, `admin-users.module.ts` and the new `identities.service.ts`), M3-04 (3, `user-views.ts`) |
| `apps/server/src/modules/evidence-packs/**` | M3-01 (1, `evidence-packs.service.ts`, disposed content), M3-03 (2, `evidence-pack-build.job.ts`, `deleted` organisations) |
| `apps/server/src/modules/registers/**` | M3-05 (2, `documents.service.ts`, `records.service.ts`, `registers.module.ts`); M3-06 calls the exported `writeRow` of `command-support.ts` and changes no file there |
| `apps/server/src/modules/identity/**` | M3-03 (2, the files its Owns list names) |
| `apps/server/src/modules/read-model/**` | M3-04 (3) |
| `apps/server/src/cli/tenant.ts` | M3-03 (2) |
| `docs/INSTALL-ONPREM.md` | M3-M01 (1), M3-02 (2) |
| `.github/workflows/ci.yml` | M3-M01 (1, one step outside the browser jobs, which M2-21 owned), M3-M02 (5) |
| `apps/web/src/screens/ops/**` | M3-01 (1, the `deleted` status label only), M3-09 (3) |
| `apps/web/test/api/controller.test.ts`, `apps/web/test/screens/host.test.tsx` | the orchestrator, except M3-10 (4) |

Common acceptance for every package (not repeated below): the common acceptance of M2 G.1 (typecheck, lint, unit tests, `npm run check:text`; server packages also `npm run test:int -w @mscd/server -- test/int/seed test/int/parity`; web packages also `CI=1 npm run test:e2e -w @mscd/web -- e2e/contrast.spec.js e2e/shell.spec.js e2e/i18n.spec.js`, `npm run gen:views:check -w @mscd/web`, the zero-test check with their own test files and `git diff --quiet HEAD -- apps/web/src/views apps/web/scripts project/`); once M3-02 is committed, packages that add tables or columns also pass `npm run test:int -w @mscd/server -- test/int/org-export/coverage.test.ts`; the handoff note exists (R-09). Browser suites in packages run with targeted spec files (the BROWSER SUITE RULE of section 0): an acceptance command below that names `npm run test:e2e` or `npm run test:e2e:api` without spec files runs with the spec files of the package's screens and of the screens and shared code it touched. The orchestrator runs the full suites once per wave (M2-STATUS "How to continue", step 7): `npm run test:int -w @mscd/server`, `CI=1 npm run test:e2e -w @mscd/web`, `flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web`, and the smoke test when deploy or Compose files changed. In wave 5, M3-M02 runs alone, so its acceptance is that wave's full run.

### G.2 Work package details

#### M3-01 Contract, schema, permissions and storage functions

| | |
|---|---|
| Wave, depends on | 1; Milestone 2 with M2-19, M2-20 and M2-21 committed |
| Owns | `packages/shared/src/**` (with the new area files `org-export.ts`, `privacy.ts`, `acknowledgements.ts`, `retention.ts`, `access-reviews.ts`), `packages/shared/test/**`, `apps/server/migrations/tenant/0009_milestone3.sql`, `apps/server/migrations/platform/0007_milestone3.sql`, `apps/server/src/db/types/*`, `apps/server/src/config/{profile.schema.ts,load-profile.ts}` (new keys and the lifecycle check), `apps/server/profiles/{saas,onprem,demo,test}.yaml` (new keys only), `apps/server/src/program.ts`, `apps/server/src/cli/export.ts` (stub), `apps/server/src/app/feature-modules.ts` (module lists), the module, stub controller and stub job files of D.3 in `apps/server/src/modules/{org-export,privacy,acknowledgements,retention,access-reviews,ops/deletion}/**`, `apps/server/src/modules/ops/ops.module.ts` (import only), the stub of `admin.users.identities.remove` in `apps/server/src/modules/admin-users/admin-users.controller.ts`, `apps/server/src/modules/jobs/schedules.ts`, `apps/server/src/common/jobs/job-payloads.ts`, `apps/server/src/common/tokens.ts` (gateway interface), `apps/server/src/gateway/**`, `apps/server/src/modules/storage/gateway-client.ts`, `apps/server/src/modules/files/{object-access.service.ts,file-commands.service.ts,generated-evidence.ts}`, the `content_disposed_at` checks in `apps/server/src/modules/{evidence-packs/evidence-packs.service.ts,integrity/integrity.service.ts,link-health/link-health.service.ts}`, `apps/server/test/setup/tenancy.ts` (suite lists), `apps/server/test/int/{contract,rbac,security,db,gateway,files}/**`, `apps/server/test/int/m2-pending/**`, the `deleted` label in `apps/web/src/screens/ops/{org-text.ts,org-model.ts}`, `docs/platform/handoff/M3-01.md` |
| Host stack | none |

Brief:
- Every route of D.1 with zod schemas, examples and OpenAPI output; the schema changes of D.2; D.3 in full; stub handlers behind `@ApiRoute` answering 501 `not-implemented`; the modules, stub controllers, stub jobs with their schedule entries and payload types, and the `export` CLI module of D.3.
- Plan-anchored shared tests: `packages/shared/test/helpers.ts` also reads this plan (`MILESTONE_3_PLAN`, an `m3Section` helper): J.1 rows (rows whose path starts with `/v1/` join the gateway endpoints, the others the API endpoints), J.2 rows after M2 J.2, J.3 to J.6 after M2, J.7 lists that replace earlier lists of the same column, J.8 rows that replace earlier rows of the same entity (section end `## K. Maintenance track`), and the work packages of the `#### M3-nn` and `#### M3-Mnn` headings. The machine regex accepts owners `M3-nn`. The counts follow: `WORK_PACKAGE_IDS.length` is 39 + 21 + 13 + 11 + 2 (M2-21 has added its heading by then), the M3 J.1 route count, the gateway count 16 + 2, the rule id sum, and the job, notification and audit action counts. No assertion is removed or loosened, except the `organization.status` test of `machines.test.ts`, which follows the J.8 machine that replaces the M2-02 one (`archived` back to `offboarding`, `deleted`, and the system re-apply moves); the handoff names each changed expectation. Every route owned by an `M3-` package is a J.1 row.
- Gateway: `gateway.objects.delete` and `gateway.tenants.purge` (D.1) in `gateway/routes.ts` and the vault adapter, removing every version of each object (the bucket may use versioning, because anchors use object lock), purge allowed only with the worker certificate when the gateway runs with mTLS and refused when `orgId` differs from `confirmOrgId`, objects kept by a bucket retention rule reported with their date; the client methods in `storage/gateway-client.ts`.
- `files/object-access.service.ts` and the evidence pack download of `evidence-packs/evidence-packs.service.ts`: an object with `content_disposed_at` answers 404 `not-found` with `messageKey` `content_disposed` on every open and download path; `integrity.rehash` and `link-health.check` skip such objects (D.2).
- `files/generated-evidence.ts`: `fileGeneratedEvidence(trx, actor, {msId, evidenceId, fileName, mimeType, bytes})` stores server-generated bytes in the repository the routing rules choose for evidence of that system, then links them to the evidence item through the same code path as `FileCommandsService.evidenceFile` (audit `evidence.file_uploaded`, freshness queued), which M3-01 moves into a function both call. Used by M3-05 and M3-07.
- Keep every workspace compiling: where a web file holds a map keyed by an enum that gains a value (the organisation status labels of `apps/web/src/screens/ops/org-text.ts` for `deleted`), add the entry with English and Indonesian text and nothing else. `UI_ROLES` is not changed here (R-14).
- Pending files `m2-pending/M3-02.json` to `M3-07.json`; `pending.ts` reads `M3-nn` names; `rbac/expectations.ts` and `security/record-tables.ts` merge empty `expectations/M3-nn.ts` and `record-tables/M3-nn.ts` for M3-02 to M3-07; record-table entries for every new GET route with an `{id}` go in the file of its building package.
- `apps/server/test/setup/tenancy.ts` adds the suites `org-export`, `org-deletion` and `privacy` to the SaaS run (D.3).
- The check in `load-profile.ts` (next to `releaseFlavourIssues`) that refuses lifecycle values below 7 without `MSCD_SAAS_TEST=1` or the `test` profile (D.3), with a unit test.
- A response member added to an existing route is optional until its building package fills it (D.3, "Changed responses").
- Contract snapshot updated once for the new route ids. Schema drift test passes with the new tables and columns. Existing behaviour unchanged, apart from the disposed-content answer.

Acceptance:

```bash
npm test -w @mscd/shared
git diff --quiet HEAD -- docs/platform/BUILD-PLAN.md docs/platform/MILESTONE-2.md docs/platform/MILESTONE-3.md
npm run openapi
npm run test:int -w @mscd/server -- test/int/db test/int/contract test/int/rbac test/int/security test/int/gateway test/int/files
npm run test:int:saas -w @mscd/server
npm run test:int -w @mscd/server
test "$(ls apps/server/test/int/m2-pending/M3-*.json | wc -l)" -eq 6
test "$(ls apps/server/test/int/security/record-tables/M3-*.ts apps/server/test/int/rbac/expectations/M3-*.ts | wc -l)" -eq 12
node -e "const s=require('fs').readFileSync('apps/server/test/int/contract/__snapshots__/routes.test.ts.snap','utf8');for(const id of ['exports.organization.download','ops.deletion.schedule','privacy-requests.erase','me.acknowledgements.confirm','retention.reviews.approve','access-reviews.ms.sign-off','admin.users.identities.remove','gateway.tenants.purge'])if(!s.includes(id+' '))process.exit(1)"
test "$(ls apps/server/migrations/tenant/0009_*.sql apps/server/migrations/platform/0007_*.sql | wc -l)" -eq 2
npm run build -w @mscd/server && node apps/server/dist/main.js export --help >/dev/null && git diff --quiet HEAD -- apps/server/src/main.ts
```

`test/int/gateway` covers: delete of a vault object with two versions leaves none; delete on an `m365` repository answers 422; purge removes every object of one organisation and none of the other; purge with an api certificate or a mismatched `confirmOrgId` is refused; the data key cache entry is gone after purge. `test/int/files` covers the disposed-content answer and `fileGeneratedEvidence` (new file current, old file replaced, audit entry, freshness queued).

#### M3-02 Organisation export

| | |
|---|---|
| Wave, depends on | 2; M3-01 |
| Owns | `packages/shared/src/api/org-export.ts` (schemas only), `apps/server/src/modules/org-export/**`, `apps/server/src/modules/jobs/{cleanup-expired.job.ts,tenant-cleanup.ts}`, `apps/server/src/cli/export.ts`, `apps/server/test/int/org-export/**` (new), `apps/server/test/int/security/record-tables/M3-02.ts`, `apps/server/test/int/rbac/expectations/M3-02.ts`, `apps/server/test/int/m2-pending/M3-02.json` (deletes), `docs/INSTALL-ONPREM.md` (an "Export all data" section), `docs/platform/handoff/M3-02.md` |
| Host stack | none |

Brief:
- D.4 in full: the eight routes, the four-eyes rule with `SOD-SELF-APPROVE`, the notices, the job `org-export.build` (it builds any `queued` row, also the final export that M3-03 queues by inserting a row and sending the job), the archive writer with pax headers and part rotation in `org-export/archive/`, the exclusion list with reasons, the platform and audit entries (with the canonical text of each audit row and the public anchor key), the pseudonyms of `erased_person` in the member and audit files, no network address or browser of platform operators, the README in both languages, the manifest, storage in the vault and expiry.
- `cleanup.expired`: removes the vault content of expired organisation exports and of expired `export_file` rows through `gateway.objects.delete` and marks them.
- CLI `export organization --out <dir>` (single tenancy; refused in multi tenancy) and `export verify --dir <dir>`.
- Coverage test `test/int/org-export/coverage.test.ts` (R-21).
- In the handoff: the measured build time and peak temporary disk use for an organisation with 1 GiB of vault files and three parts.

Acceptance:

```bash
npm run test:int -w @mscd/server -- test/int/org-export test/int/exports test/int/jobs
npm run test:int:saas -w @mscd/server -- test/int/org-export
test ! -e apps/server/test/int/m2-pending/M3-02.json
npm run build -w @mscd/server && node apps/server/dist/main.js export organization --help >/dev/null && node apps/server/dist/main.js export verify --help >/dev/null
npm run test:int -w @mscd/server -- test/int/rbac test/int/contract test/int/security
npm run test:int -w @mscd/server
```

`test/int/org-export` covers: a request with two Tenant Admins waits for the other's approval and the requester cannot approve; with one admin it is queued with the warning; the notices; an operator starts an export and gets 403 on download; a build with a small part size gives several parts whose SHA-256 match the manifest, row counts equal the database, a vault file's bytes equal its upload, and none of a known password hash, TOTP secret, recovery code hash, session id, token hash, sealed credential or data key appears in any part; an operator's network address in a platform audit entry of the organisation is absent; a person in `erased_person` appears only under the pseudonym; `export verify` recomputes every audit hash from the canonical texts; the other organisation's data is absent; `offboarding` allows create, decision and download; expiry removes the vault content of the parts and of a 7-day `export_file`; an organisation over `export_max_bytes` is refused with `export_too_large`; `export verify` passes on a good folder and fails on a changed byte.

#### M3-03 End of contract and verified deletion

| | |
|---|---|
| Wave, depends on | 2; M3-01 |
| Owns | `packages/shared/src/api/{ops,admin-users,audit-trail}.ts` (schemas only), `apps/server/migrations/platform/0008_milestone3_purge.sql`, `apps/server/src/modules/ops/**` except `ops.module.ts` (with `ops/deletion/**`, `organization-status.service.ts`, `organizations.service.ts`), `apps/server/src/modules/admin-users/organization.service.ts`, `apps/server/src/modules/identity/{identity.module.ts,account-anonymiser.ts,mail-templates.ts,session-resolver.ts,session.service.ts}` (the module file for the anonymiser's provider and export only), the files that exclude `archived` organisations and must exclude `deleted` ones too (`identity/oidc/{auth-providers.service.ts,provider-lookup.ts}`, `identity/local-login-policy.ts`, `identity/invitation.service.ts`, `authz/{me-assembler.ts,me.service.ts,membership-directory.ts}`, `evidence-packs/evidence-pack-build.job.ts`; that change only), `apps/server/src/modules/audit/**`, `apps/server/src/modules/jobs/audit-verify-chain.job.ts`, `apps/server/src/modules/tenancy/**`, `apps/server/src/cli/tenant.ts`, `deploy/backup/**`, `apps/server/test/int/org-deletion/**` (new), `apps/server/test/int/security/record-tables/M3-03.ts`, `apps/server/test/int/rbac/expectations/M3-03.ts`, `apps/server/test/int/m2-pending/M3-03.json` (deletes), `docs/saas/backup-restore.md`, `docs/platform/handoff/M3-03.md` |
| Host stack | `deploy/backup/restore-test.sh --local` |

Brief:
- D.5 in full: the status machine changes of J.8 and D.2, `offboarding_ends_at`, the final export row and job at `offboarding`, the deletion record and its machine, the five routes, `org.lifecycle` (hourly, platform scope; archive at the end of the period; schedule at archive; reminders; start the purge when due; runnable from the console), `org.purge` with the steps of D.5.2 and the checks of D.5.3, the certificate of D.5.5 and its emails, the `deleted` status treated like `archived` wherever organisations are listed or resolved.
- `platform/0008_milestone3_purge.sql`: `platform.purge_organization`, `platform.redact_audit_rows` and the trigger change of D.5.4, and nothing else (R-14). The functions check their own preconditions; tests call them as `mscd_app` and prove a refused call changes nothing.
- `AccountAnonymiser` and the redaction service, built for M3-04 to reuse and exported from their modules: `identity/account-anonymiser.ts` and `audit/audit-redactor.ts` with the attestation entries.
- The verifier rule of D.5.4 in `AuditChainVerifier` and `audit-trail.service.ts` (entries marked redacted, verify reports redactions), and `audit.verify-chain` skipping deleted organisations.
- CLI in `cli/tenant.ts`: `tenant deletion show|schedule|cancel` (the console's actions), `tenant deletion run --org <slug>` (queues `org.purge` for a due deletion and waits), `tenant purge --reapply <certificate> --confirm <slug>` (the re-apply transitions of J.8, then `org.purge` queued for the worker, D.5.6), `tenant verify-certificate <file>`.
- `lifecycle.backup_copies_end_days` in the certificate's backup statement (D.5.6), and `docs/saas/backup-restore.md` tells the operator to set it to match the bucket's versioning and lifecycle rule or object lock.
- Backups: the guard allowance for both stops (the count check and rclone `--max-delete`) and `restore.sh --reapply-deletions <folder>` of D.5.6; `restore-test.sh --local` adds, with an overlay of its own that sets the `MSCD__LIFECYCLE__*` values to 0 and `MSCD_SAAS_TEST=1` on the api and the worker of its test stack: purge one of its two organisations, back up (the guard lets the drop pass), restore the copy from before the purge with the certificate, and check that the organisation is deleted again and the other intact. `docs/saas/backup-restore.md` describes both.
- Deletion coverage test over platform tables with `organization_id` (R-21).

Acceptance:

```bash
npm run test:int:saas -w @mscd/server -- test/int/org-deletion
npm run test:int -w @mscd/server -- test/int/saas-ops test/int/ops test/int/identity test/int/jobs test/int/backup
test ! -e apps/server/test/int/m2-pending/M3-03.json
test "$(ls apps/server/migrations/platform/0008_*.sql | wc -l)" -eq 1
npm run build -w @mscd/server && node apps/server/dist/main.js tenant --help | grep -q verify-certificate && node apps/server/dist/main.js tenant purge --help | grep -q reapply
bash -n deploy/backup/*.sh
flock /tmp/mscd-stack.lock bash deploy/backup/restore-test.sh --local
npm run test:int -w @mscd/server -- test/int/rbac test/int/contract test/int/security
npm run test:int:saas -w @mscd/server
npm run test:int -w @mscd/server
```

`test/int/org-deletion` covers, with a fixed clock: `offboarding` sets the end and queues the final export; `org.lifecycle` archives at the end, schedules the deletion and sends the reminders once; the operator moves the date (refused before the minimum), cancels and reopens to `offboarding` (deletion cancelled); the purge of organisation A removes A's schema, vault objects, data key and platform rows, anonymises the account that belonged to A only, keeps the account that also belongs to B with B's membership, redacts A's platform audit entries with one attestation, and leaves every row, object and chain of B intact; the platform chain verifies after the purge and fails when a redacted row is changed by the migrator without an attestation; `redact_audit_rows` refuses a row whose content no longer matches its stored hash; a lifecycle value below 7 stops the server without `MSCD_SAAS_TEST=1`; a forced failure at step 4 is retried from step 4; the certificate verifies and a changed byte fails; `tenant purge --reapply` deletes A again in a database restored from before the purge, also when the restored A is `active` and has no deletion row, and refuses a certificate with a changed byte or another organisation id; every route answers 409 `single_tenancy` in single tenancy.

#### M3-04 Requests from one person

| | |
|---|---|
| Wave, depends on | 3; M3-01, M3-03 (anonymiser and redaction) |
| Owns | `packages/shared/src/api/{privacy,exports}.ts` (schemas only), `apps/server/src/modules/privacy/**`, `apps/server/src/modules/exports/**`, `apps/server/src/modules/jobs/{cleanup-expired.job.ts,tenant-cleanup.ts}`, `apps/server/src/modules/read-model/**` (people names), `apps/server/src/modules/audit/audit-trail.service.ts` (pseudonyms), `apps/server/src/modules/admin-users/user-views.ts`, `apps/server/test/int/privacy/**` (new), `apps/server/test/int/security/record-tables/M3-04.ts`, `apps/server/test/int/rbac/expectations/M3-04.ts`, `apps/server/test/int/m2-pending/M3-04.json` (deletes), `apps/web/src/screens/{privacy-requests,privacy-checks,account}/**`, their tests in `apps/web/test/screens/`, `apps/web/e2e/screens/` and `apps/web/e2e/api-only/`, `docs/platform/handoff/M3-04.md` |
| Host stack | API E2E |

Brief:
- D.6 in full: the request register and its machine, the system checks with tasks and the mention search with its column list and coverage test, the person export as `export_file` kind `personal_data` in format `json` built by `export.build`, rectify, restrict, erase (with `ERASE-OPEN-ITEMS` and `last_tenant_admin`), the `erased_person` pseudonyms in every place that shows a person's name for this organisation, the self-service routes, the job `privacy.deadlines`, and the retention clean-up of D.6.7.
- Web: `privacy-requests` (list with filters and time left, "Record request" with subject picker or name and email, request drawer with checks, actions per type, confirmation that names what stays, and "Close" with the answer), `privacy-checks` (the system's checks with the mentions table linking each record to its screen, Handover link, "Mark checked"), and "My data" in `account` (D.6.6).

Acceptance:

```bash
npm run test:int -w @mscd/server -- test/int/privacy test/int/exports test/int/admin-users test/int/read-model test/int/jobs
npm run test:int:saas -w @mscd/server -- test/int/privacy
test ! -e apps/server/test/int/m2-pending/M3-04.json
npm test -w @mscd/web -- test/screens/privacy-requests.test.tsx test/screens/privacy-checks.test.tsx test/screens/account.test.tsx
CI=1 npm run test:e2e -w @mscd/web -- e2e/screens/privacy-requests.spec.js e2e/screens/privacy-checks.spec.js e2e/screens/account.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web -- e2e/api-only/privacy-requests.spec.js e2e/api-only/privacy-checks.spec.js e2e/api-only/account.spec.js
npm run test:int -w @mscd/server -- test/int/rbac test/int/contract test/int/security
git diff --quiet HEAD -- apps/web/src/MscdApp.jsx apps/web/src/styles.css apps/web/e2e/helpers.js
```

`test/int/privacy` covers: due times and the deadline notices; the access export holds the listed sections and no secret or other person's data, for a Tenant Admin and for the person; rectify refused for a shared account and the person's own `me.profile` works; restrict stops sign-in to this organisation only; erase refused with open holdings and for the last Tenant Admin; after erasure the person shows as the pseudonym in lists, the read model and the audit trail, their audit entries hold no address, browser, email or name, the chain verifies with the attestation, and the shared account keeps working in the other organisation; an account with no other membership is anonymised; the mention search finds a name in a risk description and in an interested party's requirements text and nothing from another system; the clean-up removes old sessions, tokens and read notifications and keeps a notification a reminder refers to.

#### M3-05 Read confirmation of policies

| | |
|---|---|
| Wave, depends on | 2; M3-01 |
| Owns | `packages/shared/src/api/{acknowledgements,documents}.ts` (schemas only), `apps/server/src/modules/acknowledgements/**`, `apps/server/src/modules/registers/{documents.service.ts,records.service.ts,registers.module.ts}` (the module file for the import only), `apps/server/test/int/acknowledgements/**` (new), `apps/server/test/int/security/record-tables/M3-05.ts`, `apps/server/test/int/rbac/expectations/M3-05.ts`, `apps/server/test/int/m2-pending/M3-05.json` (deletes), `apps/web/src/screens/{acknowledgements,my-confirmations}/**`, their tests in `apps/web/test/screens/`, `apps/web/e2e/screens/` and `apps/web/e2e/api-only/`, `docs/platform/handoff/M3-05.md` |
| Host stack | API E2E |

Brief:
- D.7 in full: the document settings in `documents.create` and `documents.update`, the request opened by approval and by hand, the audience snapshot with tasks (`RuleTaskService` of `jobs/rule-tasks.ts`, source `acknowledgement`), open and confirm with `ACK-OPEN-FIRST`, the job `acknowledgement.reminders`, excusal, the register with the permission split of D.7, the CSV, and "Close and file as evidence" through `fileGeneratedEvidence`.
- `tasks.complete` refuses the three Milestone 3 task sources (D.2).
- Each confirmation task names its `acknowledgement` row (C.3). Approval opens the request through the acknowledgement service, which `registers/registers.module.ts` imports; `acknowledgements/` imports nothing from `registers/`, so the modules do not import each other.
- Web: `acknowledgements` (requests with totals, person list where the permission allows, "Ask for confirmation", "Remind", "Export CSV", "Close and file as evidence" with an evidence picker), `my-confirmations` (open and done confirmations, "Open document", the confirmation checkbox and button) with the host layer banner, a `doc` detail extension ("Read confirmation" settings for managers and the confirmed count), and the page action "Read confirmations" on the built-in `docs` screen in API builds (C.1).

Acceptance:

```bash
npm run test:int -w @mscd/server -- test/int/acknowledgements test/int/commands test/int/records-extra test/int/files
test ! -e apps/server/test/int/m2-pending/M3-05.json
npm test -w @mscd/web -- test/screens/acknowledgements.test.tsx test/screens/my-confirmations.test.tsx
CI=1 npm run test:e2e -w @mscd/web -- e2e/screens/acknowledgements.spec.js e2e/screens/my-confirmations.spec.js e2e/documents.spec.js e2e/mytasks.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web -- e2e/api-only/acknowledgements.spec.js e2e/api-only/my-confirmations.spec.js e2e/api-only/docs-edit.spec.js
npm run test:int -w @mscd/server -- test/int/rbac test/int/contract test/int/security
git diff --quiet HEAD -- apps/web/src/MscdApp.jsx apps/web/src/styles.css apps/web/e2e/helpers.js
```

The API specs: `rina` marks a policy as needing confirmation and `bagus` submits a new version, which `rina` approves; `bagus` sees the banner and the task, cannot confirm before opening, opens and confirms; `rina` sees 1 confirmed; `hendra` sees totals only; `rina` closes the request into an evidence item, which shows a new file.

#### M3-06 Retention and disposal review

| | |
|---|---|
| Wave, depends on | 2; M3-01 |
| Owns | `packages/shared/src/api/retention.ts` (schemas only), `apps/server/src/modules/retention/**`, `apps/server/src/modules/files/file-commands.service.ts` (`replaced_at`), `apps/server/test/int/retention/**` (new), `apps/server/test/int/security/record-tables/M3-06.ts`, `apps/server/test/int/rbac/expectations/M3-06.ts`, `apps/server/test/int/m2-pending/M3-06.json` (deletes), `apps/web/src/screens/retention/**`, its tests in `apps/web/test/screens/`, `apps/web/e2e/screens/` and `apps/web/e2e/api-only/`, `docs/platform/handoff/M3-06.md` |
| Host stack | API E2E |

Brief:
- D.8 in full: rules with defaults marked default or set, the job `retention.review` with item discovery per class and the `replaced_at` backfill, decisions with `RET-HOLD`, `RET-NOT-DUE` and `RET-CURRENT`, approval with `SOD-SELF-APPROVE`, the disposal effects per class (vault content through `gateway.objects.delete`; records marked deleted in the disposal transaction with `writeRow` of `registers/command-support.ts` and audited `record.disposed`, refused while the record has open dependent records, as `records.delete` refuses them with `messageKey` `records.open_dependants`; owner asked for files in customer repositories), holds, the register and its CSV. No file of `registers/` changes (M3-05 owns them in this wave).
- Web: `retention` with tabs Rules (the value in force per class and document type, "Edit", "Reset to default"), Due for review (filters, multi-select, decision form), Awaiting approval ("Approve" disabled with "You proposed this disposal" for the proposer, "Reject"), Holds, and Disposal register ("Export CSV"); detail extensions for `doc` and `ev` showing the retention end and any hold.

Acceptance:

```bash
npm run test:int -w @mscd/server -- test/int/retention test/int/files test/int/commands
test ! -e apps/server/test/int/m2-pending/M3-06.json
npm test -w @mscd/web -- test/screens/retention.test.tsx
CI=1 npm run test:e2e -w @mscd/web -- e2e/screens/retention.spec.js e2e/documents.spec.js e2e/freshness.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web -- e2e/api-only/retention.spec.js
npm run test:int -w @mscd/server -- test/int/rbac test/int/contract test/int/security
git diff --quiet HEAD -- apps/web/src/MscdApp.jsx apps/web/src/styles.css apps/web/e2e/helpers.js
```

`test/int/retention` covers, with a fixed clock: each class gets a review when its period ends and none before; a hold keeps an item out; keep and extend move the date; disposal of a current version, a held item or an item before its end is refused with its rule; the proposer cannot approve; an approved disposal deletes the vault content of a superseded version (opening it answers `content_disposed`) and keeps the version row and hash; a closed finding is marked deleted with `record.disposed`; a file in an `m365` repository asks the owner and "File removed" completes it; the register lists every decision.

#### M3-07 Periodic access review

| | |
|---|---|
| Wave, depends on | 3; M3-01 |
| Owns | `packages/shared/src/api/{access-reviews,admin-users}.ts` (schemas only), `apps/server/src/modules/access-reviews/**`, `apps/server/src/modules/admin-users/{admin-users.controller.ts,admin-users.module.ts,identities.service.ts}` (the module file for the new provider and for exporting `UsersService`, `RoleGrantsService` and the identities service, which `access-reviews/` uses), `apps/server/test/int/access-reviews/**` (new), `apps/server/test/int/security/record-tables/M3-07.ts`, `apps/server/test/int/rbac/expectations/M3-07.ts`, `apps/server/test/int/m2-pending/M3-07.json` (deletes), `apps/web/src/screens/{access-reviews,access-review}/**`, their tests in `apps/web/test/screens/`, `apps/web/e2e/screens/` and `apps/web/e2e/api-only/`, `docs/platform/handoff/M3-07.md` |
| Host stack | API E2E |

Brief:
- D.9 in full: settings with `If-Match`, the job `access-review.open` with snapshot, one task per system part (source `access_review`, entity `access_review_part`, C.3), reminders and overdue notices, decisions with `REVIEW-OWN-ACCESS` and the single-admin warning, applying through the services of D.9, sign-off with the evidence item proposal for control `A.5.18`, completion with the report, its storage and the evidence filing through `fileGeneratedEvidence`.
- `admin.users.identities.remove` in `admin-users/identities.service.ts`: removes the `platform.user_identity` row of a member for one of this organisation's providers, ends that person's sessions signed in through it, audits `identity.unlinked`.
- Web: `access-reviews` (settings card, list of reviews with progress, "Start review now", review page with the organisation items, the status of each system part, the revocations to apply with "Apply" or "Not applied" and a reason, "Complete", "Download report") and `access-review` (this system's items with filters, decision per item or for a selection, "Revoke guest access" for decided guest grants, "Sign off" with the evidence item picker).

Acceptance:

```bash
npm run test:int -w @mscd/server -- test/int/access-reviews test/int/admin-users test/int/auditor-access test/int/identity
test ! -e apps/server/test/int/m2-pending/M3-07.json
npm test -w @mscd/web -- test/screens/access-reviews.test.tsx test/screens/access-review.test.tsx
CI=1 npm run test:e2e -w @mscd/web -- e2e/screens/access-reviews.spec.js e2e/screens/access-review.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web -- e2e/api-only/access-reviews.spec.js e2e/api-only/access-review.spec.js e2e/api-only/users.spec.js
npm run test:int -w @mscd/server -- test/int/rbac test/int/contract test/int/security
git diff --quiet HEAD -- apps/web/src/MscdApp.jsx apps/web/src/styles.css apps/web/e2e/helpers.js
```

The API specs: `tenant.admin` sets a 3-month frequency and starts a review; `rina` decides the ISMS items, cannot decide her own role, revokes a guest grant and signs off into the A.5.18 evidence; `tenant.admin` applies a business role revocation decided by `rina`, decides the organisation items, removes a linked sign-in, and completes the review; the evidence item shows the new file.

#### M3-08 Open work totals

| | |
|---|---|
| Wave, depends on | 1; Milestone 2 |
| Owns | `apps/web/src/screens/pending-totals/**`, `apps/web/test/screens/pending-totals.test.tsx`, `apps/web/e2e/screens/pending-totals.spec.js`, `apps/web/e2e/api-only/pending-totals.spec.js`, `docs/platform/handoff/M3-08.md` |
| Host stack | API E2E |

Brief:
- D.10: the screen with the stage by role table for the selected system, open and overdue counts, "All my systems", no names anywhere; page actions "Open work totals" on `chain` and `m1overview` through `extraPageActions`, in API builds only (C.1); the empty state with the `all-done` scene when nothing is open. The sample spec opens the screen by its address.
- The sample adapter derives the totals from the sample chain items and the business role of each holder; `meta.json` lists `top` and `manager`.
- No server or shared file changes.

Acceptance:

```bash
npm test -w @mscd/web -- test/screens/pending-totals.test.tsx
CI=1 npm run test:e2e -w @mscd/web -- e2e/screens/pending-totals.spec.js e2e/chain.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web -- e2e/api-only/pending-totals.spec.js
git diff --quiet HEAD -- apps/web/src/MscdApp.jsx apps/web/src/styles.css apps/web/e2e/helpers.js
```

M3-01 changes `apps/server` and `packages/shared` in the same working tree during wave 1, so the check above leaves them out; the verifier checks M3-08's changes against its Owns list instead. The API spec signs in as `hendra`, opens the screen from Chain stages, checks that the totals equal the API answer and that no member's name appears on the page.

#### M3-09 Export and deletion screens

| | |
|---|---|
| Wave, depends on | 3; M3-02, M3-03 |
| Owns | `apps/web/src/screens/{ops,org-export}/**`, `apps/web/test/screens/{ops*,org-export}.test.tsx`, `apps/web/e2e/screens/{ops*,org-export}.spec.js`, `apps/web/e2e/api-only/{ops*,org-export}.spec.js`, `docs/platform/handoff/M3-09.md` |
| Host stack | API E2E |

Brief:
- `org-export`: list of exports with status, requester, approver, size, parts and expiry; "Export all data" with the explanation of what the archive holds and who is told; "Approve" and "Reject" (disabled with "You requested this export" for the requester); download of each part and the manifest with the SHA-256 shown next to each and "How to check" text; a host layer banner for Tenant Admins during `offboarding`, with the end of the read-only period and the planned deletion date (`admin.organization.get`, D.2); nobody signs in to an archived organisation, so the email reminders of D.5.1 cover the grace period.
- Operator console (`ops`): organisation table columns "Read-only until" and "Deletion on"; drawer tab Export (exports with status and sizes, "Start export" with a reason, no download); drawer tab Deletion (status and dates, "Change date", "Cancel deletion", "Retry", steps and checks of the report, "Download certificate"); the Status tab offers the moves of J.8 with their effects, including "Reopen for export" for an archived organisation with a scheduled deletion.
- Sample adapters with a sample organisation in each lifecycle state, so specs and contrast cover every tab.

Acceptance:

```bash
npm test -w @mscd/web -- test/screens/ops.test.tsx test/screens/ops-organizations.test.tsx test/screens/org-export.test.tsx
CI=1 npm run test:e2e -w @mscd/web -- e2e/screens/ops.spec.js e2e/screens/ops-organizations.spec.js e2e/screens/org-export.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web -- e2e/api-only/ops.spec.js e2e/api-only/ops-organizations.spec.js e2e/api-only/org-export.spec.js
git diff --quiet HEAD -- apps/web/src/MscdApp.jsx apps/web/src/styles.css apps/web/e2e/helpers.js
```

#### M3-10 Demo personas

| | |
|---|---|
| Wave, depends on | 4; M3-05, M3-06, M3-07 (the seed fills their screens) |
| Owns | `apps/server/src/seed/**`, `apps/web/src/data/mscd-data.js`, `apps/server/src/seed/demo/sample-snapshot.json`, `tools/mock-providers/fixtures/demo.json`, the demo Keycloak realm `deploy/compose/dev/keycloak/realm-mscd.json`, `packages/shared/src/enums.ts` (`UI_ROLES` and `UI_ROLE_LABELS` only), `packages/shared/src/authz/matrix.ts` (`uiRoleFor` and `DEMO_PERSONAS` only), `apps/web/src/MscdApp.jsx` (UI role handling only, E), `apps/web/src/data/types.ts` (`UiRole` only), `apps/web/src/screens/roles.ts` (`UI_ROLE_LABEL` only), `apps/web/src/screens/host.tsx`, `apps/web/src/routing/address.ts` (`PERSONAS`), the `roles` field of `apps/web/src/screens/*/index.tsx` and `meta.json`, `apps/web/test/api/controller.test.ts`, `apps/web/test/screens/host.test.tsx`, `apps/web/test/sample-source.test.js`, `apps/web/test/screens/license.test.tsx`, `apps/web/e2e/personas.spec.js` (new) and the specs whose counts change (E), `apps/server/test/int/{seed,parity}/**`, `deploy/scripts/check-release-artefacts.sh`, `docs/platform/handoff/M3-10.md` |
| Host stack | API E2E, smoke |

Brief:
- Section E in full, with the reason for every changed count in the handoff (R-15).
- `e2e/personas.spec.js`: each of the seven sample personas opens and sees the sidebar of its role; switching persona in the sample build and in the demo API stack keeps the address of M2-20. The API specs sign in as the new personas through the `apiSession` option; no file of `apps/web/e2e-api/**` changes (M2-21).
- `controller.test.ts`: a Risk Owner and a Compliance Investigator in the API build keep the own-item filter and land on My Tasks, a Programme Owner sees what a Management System Manager sees (E).

Acceptance:

```bash
node apps/web/scripts/export-sample-snapshot.mjs --check
npm run test:int -w @mscd/server -- test/int/seed test/int/parity test/int/identity test/int/authz
npm test -w @mscd/shared
npm test -w @mscd/web -- test/api/controller.test.ts test/screens/host.test.tsx test/routing test/sample-source.test.js
CI=1 npm run test:e2e -w @mscd/web -- e2e/personas.spec.js e2e/shell.spec.js e2e/routing.spec.js e2e/switching.spec.js e2e/controls.spec.js e2e/documents.spec.js e2e/freshness.spec.js e2e/mytasks.spec.js e2e/screens/license.spec.js e2e/screens/ops-organizations.spec.js
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web -- e2e/personas.spec.js e2e/api-only/routing.spec.js e2e/api-only/sign-in.spec.js e2e/api-only/license.spec.js e2e/api-only/users.spec.js
flock /tmp/mscd-stack.lock npm run test:smoke
node tools/scripts/demo-totp.mjs wulan >/dev/null && node tools/scripts/demo-totp.mjs --self-test
bash deploy/scripts/check-release-artefacts.sh --help >/dev/null
```

#### M3-11 Data lifecycle run and documents

| | |
|---|---|
| Wave, depends on | 4; every other core package |
| Owns | `tools/smoke/**`, `apps/web/src/screens/notifications/**` (the kind map), `apps/web/test/screens/notifications.test.tsx`, `docs/saas/{records-of-processing,legal-inputs,operator,README}.md`, `docs/product/USER-FLOWS.md`, `docs/platform/ui-contract.md` (a Milestone 3 section), `docs/platform/handoff/M3-11.md` |
| Host stack | lifecycle run, journeys, SaaS run |

Brief:
- `tools/smoke/tests/data-lifecycle.spec.mjs` and script `lifecycle` in `tools/smoke/package.json`, on the SaaS test stack of `run-saas.mjs`, whose run overlay sets the `MSCD__LIFECYCLE__*` values to 0 days and `MSCD_SAAS_TEST=1` on the api and the worker (never in `saas.yaml`, D.3). Every step on screen, one browser session per person: in organisation Alpha a policy needs confirmation, two people confirm and the register is filed as evidence; a retention rule of 1 month and a disposal proposed and approved by two people; an access review decided, applied and completed with its evidence; a member downloads "My data"; an access request is answered with an export and an erasure of a leaver is done after the system check; the operator moves Alpha to `offboarding`, a Tenant Admin downloads every part of the final export and the run checks each SHA-256 against the manifest; the operator runs `org.lifecycle` from the console, Alpha is archived, the deletion date is set to now, `org.lifecycle` runs again and the purge completes; the certificate downloads and passes `mscd-server tenant verify-certificate` in the stack's cli container; Alpha's sign-in shows no organisation; organisation Beta and a person in both keep working. The run fails on any page error, console error or 5xx answer, and runs `expectReadableText` on every new screen.
- `KIND_SCREENS` for the notification kinds of J.4.
- Documents, from the code as built: `records-of-processing.md` (retention table: the gaps closed by D.4 and D.6.7 and the new periods; record 2 and 3 retention after a contract; the request procedure replaced by the screens of D.6 and the provider's short forwarding log); `legal-inputs.md` ("End of contract and what is not built yet", questions 7, 8 and 13 with the built facts, the "Retention" section and the backup statement of D.5.6, which replaces "about 12 months" with the end date of the certificate); `operator.md` (offboarding step by step with the final export, the dates, reopening, the certificate, the restore re-apply); `README.md` (index); `USER-FLOWS.md` (Stage 7 access review and the steps now built, their status and where); `ui-contract.md` (the Milestone 3 screens and the routes that feed them).

Acceptance:

```bash
flock /tmp/mscd-stack.lock npm run lifecycle -w @mscd/smoke
flock /tmp/mscd-stack.lock npm run journey -w @mscd/smoke
flock /tmp/mscd-stack.lock npm run journey -w @mscd/smoke -- --saas
flock /tmp/mscd-stack.lock npm run saas -w @mscd/smoke
npm test -w @mscd/web -- test/screens/notifications.test.tsx
grep -q 'verify-certificate' docs/saas/operator.md && grep -q 'reapply-deletions' docs/saas/operator.md
! sed -n '/Not built yet/,/^## /p' docs/saas/legal-inputs.md | grep -qi 'full export\|verified deletion\|requests from data subjects\|removal of ended sessions'
npm run check:text
flock /tmp/mscd-stack.lock sh -c 'test -z "$(docker ps -q --filter label=mscd.test=true)"'
```

## H. Questions for the product owner

Each question has a default that is built when no answer arrives before the package that needs it.

Product owner, 2026-10-31: every default of H.1 to H.11 is accepted. H.12 was added by the plan review after that answer; its default applies unless the owner decides otherwise before M3-04.

| # | Question | Default built | Needed by |
|---|---|---|---|
| H.1 | After the 30 read-only days, how long should a closed organisation wait before MSCD deletes it, and may the operator shorten that wait when the customer asks in writing? | 30 days; the operator may move the date, but never to less than 7 days after closing | M3-03 |
| H.2 | Who may download the full organisation export? | A Tenant Admin, after a second Tenant Admin approves when the organisation has two or more; every Tenant Admin and every primary Management System Manager is told of each request and download | M3-02 |
| H.3 | How long does an export stay downloadable? | 7 days; the final export made when the contract ends stays until the organisation closes | M3-02 |
| H.4 | What deadline applies to requests from people about their own data? | 72 hours (3 x 24 hours, as the notes for the lawyer cite for access and correction) for every type; the lawyer confirms per type, and the operator changes the profile value if needed | M3-04 |
| H.5 | When a person asks to be erased, may MSCD keep the organisation's records and audit entries under a pseudonym ("Former user 7F3A") and remove only the person's identifying values from them? | Yes; the lawyer confirms it with questions 7 and 13 of `docs/saas/legal-inputs.md` | M3-04 |
| H.6 | May each person download their own data and correct their own name and job title in "My account" without asking the Tenant Admin? | Yes | M3-04 |
| H.7 | Read confirmation: must people open the document before confirming, must they type their name, how long do they have, and who is asked by default? | Open first: yes. Typed name: no (a checkbox and a button). 14 days, reminders at 7 days and on the due date. Everyone with a role in the document's systems | M3-05 |
| H.8 | Retention: what default keeping period, and may an approved disposal delete the file itself from the Managed Vault? | 36 months for every record type (one certification cycle), changed per system; yes, after a second person approves | M3-06 |
| H.9 | Access review: how often, and who reviews? | Every 3 months, 14 days to complete; Tenant Admins review organisation access, the Management System Managers and Programme Owners of each system review its roles and guest auditors; nobody reviews their own access | M3-07 |
| H.10 | Names of the three new demo personas | Wulan Hartono (Programme Owner), Ratna Kusumawati (Risk Owner), Gilang Saputra (Compliance Investigator) | M3-10 |
| H.11 | Run the maintenance track, or drop it? | Run M3-M01 in wave 1 and M3-M02 last; keep `@types/node` on the Node 22 major (K.2) | M3-M01, M3-M02 |
| H.12 | Erasing a person cannot be undone and removes their name from audit entries. Should a second Tenant Admin approve each erasure, as for the full export (H.2)? | No second approval: the system checks by the Management System Managers come first, the erasure is audited, and every redaction stays visible in the audit chain (D.5.4). In an organisation where one person is the only Tenant Admin and the only manager, nobody else looks at it | M3-04 |
| H.13 | A person who was erased in an organisation is later invited again (for example rehired). Refuse the invitation, or let them rejoin? | Let them rejoin with a fresh account: the invitation creates a new account and membership, and every record from before the erasure keeps the pseudonym. Decided by the product owner on 2026-11-01: fresh account. Built by the M3-04 follow-up | M3-04 follow-up |

The product decisions of `CLAUDE.md` hold. Decision 2 (Top Management sees totals only) shapes D.7 and D.10; decision 3 (Internal Auditors do not see everyone's pending list) shapes D.7; decision 6 (the Programme Owner keeps verify and approve rights) gives Programme Owners `retention.approve` and `access_review.decide`; decision 9 (multi-tenant SaaS on one VPS) shapes D.5.

## I. Risks

| Risk | Effect | Handling |
|---|---|---|
| A purge runs on the wrong organisation or too early | Customer data lost for good | The purge runs only through `org.lifecycle` on a date at least `deletion_min_grace_days` after closing, a server refuses a minimum below 7 days outside test stacks (D.3), the database function checks status and date itself, the gateway purge needs the worker certificate and the organisation id twice, emails go out 7 days and 1 day before, and agents never run it outside tests (R-20) |
| Redaction weakens the integrity proof of the audit trail | An attacker with database access could hide a change as a redaction | Only the definer function can redact, it limits the columns, every redaction is a new chained and anchored entry listing the old hashes, and the verifier rejects a changed row without one (D.5.4) |
| Large organisations make exports slow or fill the worker disk | Failed exports during the read-only period | Parts of at most 2 GiB written one at a time, a free space check first, a size limit with a clear refusal, measured times in the M3-02 handoff, and the final export queued on the first day of the 30 |
| A compromised Tenant Admin account downloads everything | Data leak | Second Tenant Admin approval, notices to every admin and manager, a second factor for every local account (company sign-in accounts use their provider's), audit entries for each part, 7-day expiry |
| A restore from an older backup brings a deleted organisation back | Deleted data returns | `restore.sh --reapply-deletions` with the certificates, which go to every operator's mailbox; the restore runbook asks for them first (D.5.6) |
| The nightly backup stops after a purge | No backup that night | Both stops of the vault guard allow the drop that purges explain (D.5.6); `restore-test.sh --local` proves it |
| The certificate names a backup end date the bucket does not keep | A promise to the customer that is not true | The date comes from `lifecycle.backup_copies_end_days`, the certificate names the bucket settings it assumes, and `backup-restore.md` tells the operator to keep the value in line with the bucket (D.5.6) |
| The lawyer answers differently on deadlines, pseudonyms or retention | Rework | Deadline and periods are profile values or settings, erasure keeps every step separate, and M3-11 writes the facts the lawyer needs (H.4, H.5) |
| Disposal removes a record an auditor still needs | Audit finding | Disposal only after the period, never of current items, never under a hold, always with a second person, and a disposal register as evidence (D.8) |
| New UI roles change what API users see | Programme Owners, Risk Owners or Compliance Investigators see other screens | The new roles get the same sidebar as the role they had before, and `controller.test.ts` checks it (E) |
| The contract of wave 1 misses something later packages need | Packages wait | Field lists come from the code research; a gap goes in the handoff note and the orchestrator adds a correction migration between waves (R-14) |
| Major upgrades break the build late in the milestone | A lost wave | M3-M02 runs alone after everything else, in steps that each pass the full suites, and a step that cannot pass is dropped with a Dependabot ignore rule (K.2) |
| Text fields hold personal data the mention search misses | An erasure leaves a name behind | The column list has a coverage test, and the request records which systems the managers checked and what they changed (D.6.4) |

## J. Contract tables

The shared contract tests of `packages/shared/test` compare the code with these tables, read after the BP and M2 tables by `packages/shared/test/helpers.ts` (M3-01). Each table uses the column format of its M2 counterpart. A CHECK list here replaces the earlier list of the same column, and a machine row here replaces the earlier row of the same entity.

### J.1 Endpoints

Paths below `/api/v1`, in the BP D.3 notation. The last two rows are storage gateway routes: their paths start with `/v1/` and carry no `/api/v1` prefix.

| Method and path | Route id | Owner |
|---|---|---|
| `GET /admin/organization/exports` | `exports.organization.list` | M3-02 |
| `POST /admin/organization/exports` | `exports.organization.create` | M3-02 |
| `GET /admin/organization/exports/{id}` | `exports.organization.get` | M3-02 |
| `POST /admin/organization/exports/{id}/decision` | `exports.organization.decide` | M3-02 |
| `GET /admin/organization/exports/{id}/manifest` | `exports.organization.manifest` | M3-02 |
| `GET /admin/organization/exports/{id}/parts/{part}` | `exports.organization.download` | M3-02 |
| `GET /ops/organizations/{org}/exports` | `ops.exports.list` | M3-02 |
| `POST /ops/organizations/{org}/exports` | `ops.exports.create` | M3-02 |
| `GET /ops/organizations/{org}/deletion` | `ops.deletion.get` | M3-03 |
| `POST /ops/organizations/{org}/deletion` | `ops.deletion.schedule` | M3-03 |
| `POST /ops/organizations/{org}/deletion/cancel` | `ops.deletion.cancel` | M3-03 |
| `POST /ops/organizations/{org}/deletion/retry` | `ops.deletion.retry` | M3-03 |
| `GET /ops/organizations/{org}/deletion/certificate` | `ops.deletion.certificate` | M3-03 |
| `GET /admin/privacy-requests` | `privacy-requests.list` | M3-04 |
| `POST /admin/privacy-requests` | `privacy-requests.create` | M3-04 |
| `GET /admin/privacy-requests/{id}` | `privacy-requests.get` | M3-04 |
| `PATCH /admin/privacy-requests/{id}` | `privacy-requests.update` | M3-04 |
| `POST /admin/privacy-requests/{id}/rectify` | `privacy-requests.rectify` | M3-04 |
| `POST /admin/privacy-requests/{id}/restrict` | `privacy-requests.restrict` | M3-04 |
| `POST /admin/privacy-requests/{id}/erase` | `privacy-requests.erase` | M3-04 |
| `POST /admin/privacy-requests/{id}/close` | `privacy-requests.close` | M3-04 |
| `POST /admin/privacy-requests/{id}/export` | `exports.person.create` | M3-04 |
| `GET /ms/{ms}/privacy-checks` | `privacy-checks.list` | M3-04 |
| `GET /ms/{ms}/privacy-checks/{id}/mentions` | `privacy-checks.mentions` | M3-04 |
| `POST /ms/{ms}/privacy-checks/{id}/done` | `privacy-checks.done` | M3-04 |
| `GET /me/privacy-requests` | `me.privacy-requests.list` | M3-04 |
| `POST /me/privacy-requests` | `me.privacy-requests.create` | M3-04 |
| `POST /me/data-export` | `exports.me.create` | M3-04 |
| `PATCH /me/profile` | `me.profile` | M3-04 |
| `GET /ms/{ms}/acknowledgement-requests` | `acknowledgement-requests.list` | M3-05 |
| `POST /ms/{ms}/acknowledgement-requests` | `acknowledgement-requests.create` | M3-05 |
| `GET /ms/{ms}/acknowledgement-requests/{id}` | `acknowledgement-requests.get` | M3-05 |
| `POST /ms/{ms}/acknowledgement-requests/{id}/remind` | `acknowledgement-requests.remind` | M3-05 |
| `POST /ms/{ms}/acknowledgement-requests/{id}/close` | `acknowledgement-requests.close` | M3-05 |
| `GET /ms/{ms}/acknowledgement-requests/{id}/export` | `acknowledgement-requests.export` | M3-05 |
| `GET /me/acknowledgements` | `me.acknowledgements` | M3-05 |
| `POST /me/acknowledgements/{id}/open` | `me.acknowledgements.open` | M3-05 |
| `POST /me/acknowledgements/{id}/confirm` | `me.acknowledgements.confirm` | M3-05 |
| `GET /ms/{ms}/retention/rules` | `retention.rules.list` | M3-06 |
| `PUT /ms/{ms}/retention/rules/{recordClass}` | `retention.rules.put` | M3-06 |
| `GET /ms/{ms}/retention/reviews` | `retention.reviews.list` | M3-06 |
| `POST /ms/{ms}/retention/reviews/decide` | `retention.reviews.decide` | M3-06 |
| `POST /ms/{ms}/retention/reviews/{id}/approve` | `retention.reviews.approve` | M3-06 |
| `POST /ms/{ms}/retention/reviews/{id}/reject` | `retention.reviews.reject` | M3-06 |
| `POST /ms/{ms}/retention/reviews/{id}/file-removed` | `retention.reviews.file-removed` | M3-06 |
| `GET /ms/{ms}/retention/register` | `retention.register` | M3-06 |
| `GET /ms/{ms}/retention/holds` | `retention.holds.list` | M3-06 |
| `POST /ms/{ms}/retention/holds` | `retention.holds.create` | M3-06 |
| `POST /ms/{ms}/retention/holds/{id}/release` | `retention.holds.release` | M3-06 |
| `GET /admin/access-reviews/settings` | `access-reviews.settings.get` | M3-07 |
| `PUT /admin/access-reviews/settings` | `access-reviews.settings.put` | M3-07 |
| `GET /admin/access-reviews` | `access-reviews.list` | M3-07 |
| `POST /admin/access-reviews` | `access-reviews.create` | M3-07 |
| `GET /admin/access-reviews/{id}` | `access-reviews.get` | M3-07 |
| `POST /admin/access-reviews/{id}/items/{itemId}/decision` | `access-reviews.decide` | M3-07 |
| `POST /admin/access-reviews/{id}/items/{itemId}/apply` | `access-reviews.apply` | M3-07 |
| `POST /admin/access-reviews/{id}/complete` | `access-reviews.complete` | M3-07 |
| `POST /admin/access-reviews/{id}/cancel` | `access-reviews.cancel` | M3-07 |
| `GET /admin/access-reviews/{id}/report` | `access-reviews.report` | M3-07 |
| `GET /ms/{ms}/access-reviews` | `access-reviews.ms.list` | M3-07 |
| `GET /ms/{ms}/access-reviews/{id}` | `access-reviews.ms.get` | M3-07 |
| `POST /ms/{ms}/access-reviews/{id}/items/{itemId}/decision` | `access-reviews.ms.decide` | M3-07 |
| `POST /ms/{ms}/access-reviews/{id}/items/{itemId}/apply` | `access-reviews.ms.apply` | M3-07 |
| `POST /ms/{ms}/access-reviews/{id}/sign-off` | `access-reviews.ms.sign-off` | M3-07 |
| `POST /admin/users/{id}/identities/remove` | `admin.users.identities.remove` | M3-07 |
| `POST /v1/objects/delete` | `gateway.objects.delete` | M3-01 |
| `POST /v1/tenants/purge` | `gateway.tenants.purge` | M3-01 |

### J.2 Permission matrix

| Permission | Scope | MM | PO | DO | RO | IA | TM | EA | CI | TA | SA | OP |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `org.export.manage` | org | | | | | | | | | yes | | |
| `privacy_request.manage` | org | | | | | | | | | yes | | |
| `privacy_request.assist` | ms | yes | | | | | | | | | | |
| `acknowledgement.manage` | ms | yes | | | | | | | | | | |
| `retention.manage` | ms | yes | | | | | | | | | | |
| `retention.approve` | ms | yes | yes | | | | | | | | | |
| `access_review.manage` | org | | | | | | | | | yes | | |
| `access_review.decide` | ms | yes | yes | | | | | | | | | |

The operator routes of D.1 use the existing platform permissions `ops.read` and `ops.tenants.manage`. The routes under `/me/` and `exports.me.create` need an active session only, and their services act on the caller's own data.

### J.3 Jobs

| Job (owner) | Trigger | Schedule | Effect |
|---|---|---|---|
| `org-export.build` (M3-02) | `exports.organization.create` and `.decide`, `ops.exports.create`, the move to `offboarding` | none | D.4: builds the parts and the manifest, stores them in the vault, sends `organization_export_ready` |
| `org.lifecycle` (M3-03) | `scheduler` cron; `ops.jobs.run` | hourly at minute 20 UTC, platform scope | D.5.1: archives organisations at the end of the read-only period, schedules deletions, sends lifecycle reminders, queues `org.purge` when due |
| `org.purge` (M3-03) | `org.lifecycle`, `ops.deletion.retry`, `tenant deletion run` | none | D.5.2 to D.5.5 |
| `privacy.deadlines` (M3-04) | `scheduler.tick` | daily 08:00 local, run ledger | sends `privacy_request_due` for requests due within 24 hours and overdue |
| `acknowledgement.reminders` (M3-05) | `scheduler.tick` | daily 08:10 local, run ledger | D.7 reminders, excusals and the `acknowledgement_overdue` digest |
| `retention.review` (M3-06) | `scheduler.tick` | daily 03:15 local, run ledger | D.8: opens disposal reviews, sends `retention_review_due` |
| `access-review.open` (M3-07) | `scheduler.tick` | daily 06:30 local, run ledger | D.9: opens due reviews, sends `access_review_due` and `access_review_overdue` |

### J.4 Notifications

| Kind | Created by | Recipient | Digest |
|---|---|---|---|
| `organization_export_requested` | `exports.organization.create`, `.decide`, `.download`, `ops.exports.create` | every active Tenant Admin and primary Management System Manager | no |
| `organization_export_ready` | `org-export.build` | the requester, or every Tenant Admin for an operator or final export | no |
| `organization_lifecycle` | `org.lifecycle` | Tenant Admins of an organisation in `offboarding`, also by email | no |
| `privacy_request_received` | `me.privacy-requests.create` | Tenant Admins | no |
| `privacy_request_due` | `privacy.deadlines` | Tenant Admins | no |
| `privacy_check_requested` | `privacy-requests.create` (access and erasure) | primary Management System Manager of each system | no |
| `acknowledgement_requested` | approval of a version, `acknowledgement-requests.create`, `.remind`, `acknowledgement.reminders` | each pending person in the audience | no |
| `acknowledgement_overdue` | `acknowledgement.reminders` | Management System Managers of the system | yes |
| `retention_review_due` | `retention.review` | Management System Managers of the system | yes |
| `disposal_approval_pending` | `retention.reviews.decide` with `dispose` | the system's other Management System Managers and Programme Owners | no |
| `access_review_due` | `access-review.open`, `access-reviews.create` | Tenant Admins and the reviewers of each system part | no |
| `access_review_overdue` | `access-review.open` | the same | no |

The emails about a deletion (schedule, reminders, certificate) go to Tenant Admins who can no longer sign in, so they use mail templates of `identity/mail-templates.ts` (M3-03), and this table lists no kind for them.

### J.5 Audit actions

- Actions: `organization_export.requested`, `organization_export.decided`, `organization_export.built`, `organization_export.failed`, `organization_export.downloaded`, `privacy_request.created`, `privacy_request.updated`, `privacy_request.rectified`, `privacy_request.restricted`, `privacy_request.erased`, `privacy_request.closed`, `privacy_check.done`, `privacy.audit_redacted`, `acknowledgement_request.created`, `acknowledgement_request.reminded`, `acknowledgement_request.closed`, `acknowledgement.opened`, `acknowledgement.confirmed`, `retention_rule.changed`, `retention_review.decided`, `retention_review.approved`, `retention_review.rejected`, `retention_review.file_removed`, `retention_hold.created`, `retention_hold.released`, `record.disposed`, `access_review.settings_changed`, `access_review.opened`, `access_review.item_decided`, `access_review.item_applied`, `access_review.signed_off`, `access_review.completed`, `access_review.cancelled`.
- Platform log: `ops.export_requested`, `ops.deletion_scheduled`, `ops.deletion_cancelled`, `ops.deletion_retried`, `tenant.offboarding_ended`, `tenant.purge_started`, `tenant.purged`, `tenant.purge_failed`, `tenant.audit_redacted`, `user.anonymised`, `user.audit_redacted`, `identity.unlinked`.

### J.6 Problems and rules

| Topic | Rule |
|---|---|
| Problem slugs | none added; Milestone 3 uses the slugs of BP D.1 and M2 J.6 |
| Errors | platform rule ids added to the extension member `rule`: `ACK-OPEN-FIRST`, `RET-HOLD`, `RET-NOT-DUE`, `RET-CURRENT`, `SOD-SELF-APPROVE`, `REVIEW-OWN-ACCESS`, `ERASE-OPEN-ITEMS` |
| Warnings | `REVIEW-SINGLE-ADMIN` (an access review completes with the single Tenant Admin's own items not reviewed) |
| Message keys | refusals on existing slugs: `export_too_large`, `export_in_progress`, `deletion_not_archived`, `deletion_too_soon`, `deletion_in_progress` and `last_tenant_admin` (409 `conflict`); `shared_account` and `task_completes_on_screen` (422 `business-rule`); `content_disposed` (404 `not-found`); `single_tenancy` as in M2 |

### J.7 CHECK lists

Column fragments in the DDL notation of BP C.4 to C.6, for the tests; the migrations are `tenant/0009_milestone3.sql` and `platform/0007_milestone3.sql`.

```sql
CREATE TABLE platform.organization (
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'offboarding', 'archived', 'deleted')),
);
CREATE TABLE platform.organization_status_event (
  from_status varchar(20) NOT NULL CHECK (from_status IN ('active', 'suspended', 'offboarding', 'archived', 'deleted')),
  to_status varchar(20) NOT NULL CHECK (to_status IN ('active', 'suspended', 'offboarding', 'archived', 'deleted')),
);
CREATE TABLE platform.organization_export (
  status varchar(12) NOT NULL CHECK (status IN ('requested', 'queued', 'building', 'ready', 'failed', 'rejected', 'expired')),
  requested_via varchar(15) NOT NULL CHECK (requested_via IN ('tenant_admin', 'operator', 'offboarding')),
);
CREATE TABLE platform.organization_deletion (
  status varchar(12) NOT NULL CHECK (status IN ('scheduled', 'cancelled', 'running', 'completed', 'failed')),
);
CREATE TABLE privacy_request (
  request_type varchar(15) NOT NULL CHECK (request_type IN ('access', 'rectification', 'restriction', 'erasure')),
  status varchar(12) NOT NULL CHECK (status IN ('received', 'in_progress', 'completed', 'refused', 'withdrawn')),
  subject_kind varchar(10) NOT NULL CHECK (subject_kind IN ('member', 'other')),
  channel varchar(15) NOT NULL CHECK (channel IN ('self_service', 'email', 'letter', 'provider', 'other')),
);
CREATE TABLE privacy_check (
  status varchar(10) NOT NULL CHECK (status IN ('open', 'done')),
);
CREATE TABLE document (
  acknowledgement_scope varchar(15) NOT NULL DEFAULT 'system_roles' CHECK (acknowledgement_scope IN ('system_roles', 'roles', 'organisation')),
  acknowledgement_roles text[] CHECK (acknowledgement_roles <@ ARRAY['ms_manager', 'programme_owner', 'domain_owner', 'risk_owner', 'internal_auditor', 'top_management', 'compliance_investigator']),
);
CREATE TABLE acknowledgement_request (
  status varchar(10) NOT NULL CHECK (status IN ('open', 'closed')),
  audience_scope varchar(15) NOT NULL CHECK (audience_scope IN ('system_roles', 'roles', 'organisation')),
);
CREATE TABLE acknowledgement (
  status varchar(10) NOT NULL CHECK (status IN ('pending', 'confirmed', 'excused')),
);
CREATE TABLE retention_rule (
  record_class varchar(20) NOT NULL CHECK (record_class IN ('document_version', 'evidence_file', 'evidence_pack', 'audit_event', 'finding', 'corrective_action', 'management_review', 'competence_record')),
);
CREATE TABLE retention_review (
  record_class varchar(20) NOT NULL CHECK (record_class IN ('document_version', 'evidence_file', 'evidence_pack', 'audit_event', 'finding', 'corrective_action', 'management_review', 'competence_record')),
  status varchar(20) NOT NULL CHECK (status IN ('open', 'kept', 'extended', 'awaiting_approval', 'disposed')),
  decision varchar(10) CHECK (decision IN ('keep', 'extend', 'dispose')),
  file_action varchar(25) CHECK (file_action IN ('vault_content_deleted', 'owner_asked', 'none')),
);
CREATE TABLE retention_hold (
  record_class varchar(20) NOT NULL CHECK (record_class IN ('document_version', 'evidence_file', 'evidence_pack', 'audit_event', 'finding', 'corrective_action', 'management_review', 'competence_record')),
);
CREATE TABLE access_review (
  status varchar(10) NOT NULL CHECK (status IN ('open', 'completed', 'cancelled')),
);
CREATE TABLE access_review_part (
  status varchar(12) NOT NULL CHECK (status IN ('open', 'signed_off')),
);
CREATE TABLE access_review_item (
  item_kind varchar(15) NOT NULL CHECK (item_kind IN ('membership', 'admin_role', 'business_role', 'auditor_access', 'linked_sign_in')),
  decision varchar(10) CHECK (decision IN ('keep', 'change', 'revoke')),
);
CREATE TABLE task (
  source_rule varchar(20) NOT NULL CHECK (source_rule IN ('BR-10', 'BR-11', 'BR-15', 'BR-31', 'manual', 'acknowledgement', 'access_review', 'privacy_check')),
);
CREATE TABLE export_file (
  kind varchar(20) NOT NULL CHECK (kind IN ('portfolio_board', 'readiness', 'soa', 'document_register', 'audit_trail', 'personal_data')),
  format varchar(5) NOT NULL CHECK (format IN ('pdf', 'xlsx', 'csv', 'json')),
);
```

### J.8 State machines

| Machine | Transitions |
|---|---|
| `organization.status` (M3-01) | `active` to `suspended` or `offboarding`; `suspended` to `active` or `offboarding`; `offboarding` to `active` or `archived`: `ops.tenants.manage` through `ops.organizations.status` or `tenant set-status`, reason required; `offboarding` and `archived` also need `confirmSlug` equal to the slug. `offboarding` to `archived` also by the system (`org.lifecycle`) when `offboarding_ends_at` has passed. `archived` to `offboarding`: `ops.tenants.manage`, reason and `confirmSlug`, only while the deletion is `scheduled`, which it cancels. `archived` to `deleted`: system only (`org.purge`); `deleted` is final. Re-apply after a restore: `active`, `suspended` or `offboarding` to `archived`, system only, through `tenant purge --reapply` with a deletion certificate whose signature verifies and that names this organisation id (D.5.6) |
| `organization_export.status` (M3-01) | (new) to `requested`: `org.export.manage` when another active Tenant Admin exists. (new) to `queued`: `org.export.manage` with a single Tenant Admin, `ops.tenants.manage` through `ops.exports.create`, or the system at the move to `offboarding`. `requested` to `queued` or `rejected`: `org.export.manage` of another Tenant Admin through `exports.organization.decide`. `requested` to `expired`: system after 7 days without a decision. `queued` to `building`, `building` to `ready` or `failed`: system (`org-export.build`). `failed` to `building`: system, the one retry of `org-export.build`. `queued` to `failed`: system, when the organisation is no longer active or offboarding. `queued` or `building` to `failed`: system (`cleanup.expired`) after 24 hours without progress. `ready` to `expired`: system (`cleanup.expired`) |
| `organization_deletion.status` (M3-01) | (new) to `scheduled`: system at the move to `archived`, or `ops.tenants.manage` through `ops.deletion.schedule`; the date may change while `scheduled`. `scheduled` to `cancelled`: `ops.tenants.manage` through `ops.deletion.cancel`, or the system when the organisation returns to `offboarding`. `scheduled` to `running`: system (`org.lifecycle`) on the date. `running` to `completed` or `failed`: system (`org.purge`). `failed` to `running`: `ops.tenants.manage` through `ops.deletion.retry`. Re-apply after a restore: (new), `scheduled` or `cancelled` to `running`, system only, through `tenant purge --reapply` with a verified certificate (D.5.6) |
| `privacy_request.status` (M3-01) | (new) to `received`: `privacy_request.manage` through `privacy-requests.create`, or the person through `me.privacy-requests.create`. `received` to `in_progress`: `privacy_request.manage` with an identity check note. `in_progress` to `completed`: `privacy_request.manage` through `privacy-requests.close` after the action of its type. `received` or `in_progress` to `refused` (reason) or `withdrawn`: `privacy_request.manage` |
| `retention_review.status` (M3-01) | (new) to `open`: system (`retention.review`). `open` to `kept` or `extended`: `retention.manage`, reason required. `open` to `awaiting_approval`: `retention.manage` with decision `dispose`, rules `RET-HOLD`, `RET-NOT-DUE`, `RET-CURRENT`. `awaiting_approval` to `disposed`: `retention.approve` by another person (`SOD-SELF-APPROVE`). `awaiting_approval` to `open`: `retention.approve` with a note. `kept` or `extended` to `open`: system on the new date |
| `access_review.status` (M3-01) | (new) to `open`: system (`access-review.open`) or `access_review.manage` through `access-reviews.create`, one open review at a time. `open` to `completed`: `access_review.manage` through `access-reviews.complete`, when every part is signed off and every revocation is applied or explained. `open` to `cancelled`: `access_review.manage`, reason required |

## K. Maintenance track

This track holds two packages the product owner can drop (H.11), separately or together. Neither changes product behaviour, and no core package depends on them. Rules R-01 to R-22 apply. M3-M01 runs in wave 1 next to the core packages because it owns no file of theirs; M3-M02 runs alone in wave 5, after every other package, because a major upgrade may change any file.

### K.1 Open follow-ups of `CLAUDE.md`

| Follow-up | State on 31 October 2026 | Package |
|---|---|---|
| Installer saves the Compose project name so an install made with `COMPOSE_PROJECT_NAME` can be removed without it | Not done: `deploy/scripts/lib/common.sh` reads `COMPOSE_PROJECT_NAME` from the environment only, `write_env` of `install.sh` does not save it, and `uninstall.sh` filters by `com.docker.compose.project=$MSCD_PROJECT` (the SaaS scripts already save it) | M3-M01 |
| `install.sh --yes` accepts a default organisation | Not done: `--yes` exists, but a new install without `--org-slug` stops with "Name your organisation with --org-slug ... and --org-name" | M3-M01 |
| A command to grant `platform_operator` | Done: `mscd-server admin create-operator` grants the role to an existing account too (M2-06), and the console adds operators since M2-19 | none |
| An offline `mscd-server diagnostics` command | Done in M2-S09 (`cli/diagnostics.ts`, tested in `test/int/saas-ops/cli.test.ts`) | none |
| Helm: a Job or documented values for `tenant create` and `admin create-user` | Done in M2-06 (`deploy/helm/mscd/templates/admin-job.yaml`, `adminJob` values, `docs/INSTALL-ONPREM.md`) | none |
| A third-party notices file in the bundle | Not done: no notices file exists; the SecLists MIT notice sits only in the header of `apps/server/src/modules/identity/common-passwords.txt` | M3-M01 |
| `docs/DEVELOPMENT.md`: a section for the API E2E project and the default data source | Done in M2-01 ("API end-to-end project", the default data source `api` for images and bundles); M2-21 owns the browser sections of that file and keeps them current | none (M2-21) |
| The web E2E stack removes only leftovers whose expiry label has passed | Done in M2-01 (`mscd.test.expires` label, `leftoverIds()` in `apps/web/e2e-api/stack.mjs`); M2-21 owns `apps/web/e2e-api/**` and keeps it | none (M2-21) |

### K.2 Major dependency upgrades

Versions installed today (root `package-lock.json`) and the target majors that Dependabot proposes and that fail CI today (pull requests 4 and 6):

| Package | Where | Today | Target | Notes |
|---|---|---|---|---|
| `kysely` | server | 0.28.17 | 0.29 | Pull request 6, a step of its own |
| `@nestjs/core`, `@nestjs/common`, `@nestjs/platform-fastify`, `@nestjs/testing` | server | 11.2.7 | 12 | One step with the Fastify plugins |
| `@fastify/multipart` | server | 9.4.0 | 10 | Checks the import upload of M2-08 and every multipart route |
| `@fastify/rate-limit` | server | 10.3.0 | 11 | Checks the per-organisation limits of M2-S10 |
| `fastify` | server, mock providers, root override | 5.12.6 | the 5.x release the plugins ask for | Only if a plugin needs it |
| `typescript` | root | 5.9.3 | 7 | Only when every tool that loads the compiler (`typescript-eslint` above all) has a release that supports it |
| `typescript-eslint` | root | 8.71.0 | the release that supports TypeScript 7 and ESLint 10 | With TypeScript and ESLint |
| `eslint`, `@eslint/js` | root | 9.39.5 | 10 | Flat config already in use |
| `globals` | root | 16.5.0 | 17 | With ESLint |
| `@types/node` | root | 22.20.4 (range `^22.19.0`) | stays on 22 | Proposed 26, but the runtime is Node 22.22; type definitions of a newer Node describe functions the runtime lacks. Add a Dependabot ignore rule for its majors until the runtime moves |
| Others in pull request 4 | various | | their new major | Taken in the step of the package they belong to, or left with an ignore rule and a reason |

### K.3 Work package details

#### M3-M01 Open follow-ups

| | |
|---|---|
| Wave, depends on | 1; Milestone 2 |
| Owns | `deploy/scripts/{install.sh,upgrade.sh,uninstall.sh,lib/common.sh,build-bundle.sh}`, `deploy/docker/{server,web}.Dockerfile` (copy of the notices file only), `tools/scripts/third-party-notices.mjs` (new), `THIRD-PARTY-NOTICES.md` (new, at the repository root), `.github/workflows/ci.yml` (one check step, in a job that is not a browser job), `docs/INSTALL-ONPREM.md`, `docs/platform/handoff/M3-M01.md` |
| Host stack | bundle build and installer rehearsal, under the lock |

Brief:
- Project name: `install.sh` writes the Compose project name it used (`COMPOSE_PROJECT_NAME`, default `mscd`) into the installation's `.env`; `upgrade.sh` and `uninstall.sh` read it from there when the environment does not set it, and an environment value that differs from the saved one stops them with a clear message. `docs/INSTALL-ONPREM.md` drops the instruction to pass the variable by hand.
- Default organisation: `install.sh --yes` on a new install without `--org-slug` creates the organisation `default` named "Default organisation" and prints that the slug is permanent and the name can change in the app; without `--yes` the installer still asks.
- Notices: `tools/scripts/third-party-notices.mjs` writes `THIRD-PARTY-NOTICES.md` from the production dependency tree of `package-lock.json` (name, version, licence, and the licence text from each package's licence file) plus the SecLists notice of `common-passwords.txt`; `--check` fails when the committed file is out of date. `build-bundle.sh` adds the file to the bundle, and both release images carry it. CI runs the check. The file is outside `docs/`, so licence texts are not held to the writing rules.
- The handoff note gives the new text of the "Open follow-ups" list of `CLAUDE.md` (the five items K.1 marks done and the three this package finishes removed), which the orchestrator applies.

Acceptance:

```bash
bash -n deploy/scripts/install.sh deploy/scripts/upgrade.sh deploy/scripts/uninstall.sh deploy/scripts/lib/common.sh deploy/scripts/build-bundle.sh
node tools/scripts/third-party-notices.mjs --check
grep -q 'SecLists' THIRD-PARTY-NOTICES.md
bash deploy/scripts/build-bundle.sh --help >/dev/null
B=$(ls -t deploy/dist/mscd-onprem-*.tar.gz | head -1) && W=$(mktemp -d) && tar -xzf "$B" -C "$W" && grep -q SecLists "$W"/mscd-onprem-*/THIRD-PARTY-NOTICES.md
flock /tmp/mscd-stack.lock bash -c "cd $W/mscd-onprem-* && COMPOSE_PROJECT_NAME=mscdm01 ./install.sh --yes --self-signed --admin-email admin@m01.example --dir /tmp/mscd-m3m01 --http-port 18090 --https-port 18453 && ./uninstall.sh --dir /tmp/mscd-m3m01 --purge --yes"
test -z "$(docker volume ls -q --filter label=com.docker.compose.project=mscdm01)"
node -e "require('yaml').parse(require('fs').readFileSync('.github/workflows/ci.yml','utf8'))"
```

The rehearsal uses the newest bundle in `deploy/dist`, built once by the package with `build-bundle.sh` and throwaway keys as BP WP-33 does; the bundle build builds images, so it runs under `flock /tmp/mscd-stack.lock` like the rehearsal (R-05). It installs without `--org-slug` (the default organisation) and removes the installation with `COMPOSE_PROJECT_NAME` unset, then checks that no volume of the saved project name is left.

#### M3-M02 Major dependency upgrades

| | |
|---|---|
| Wave, depends on | 5; every other Milestone 3 package |
| Lockfile owner | yes |
| Owns | every file, alone in its wave: `package.json` files, `package-lock.json`, `.github/dependabot.yml`, `.github/workflows/ci.yml`, and any source or test file the upgrades require, `docs/platform/handoff/M3-M02.md` |
| Host stack | every stack |

Brief:
- K.2 in four steps, each one ending with every command of the acceptance passing before the next starts: (1) `kysely` 0.29; (2) NestJS 12 with `@fastify/multipart` 10, `@fastify/rate-limit` 11 and Fastify if they ask for it; (3) ESLint 10, `@eslint/js` 10, `globals` 17 and `typescript-eslint`; (4) TypeScript 7 with the matching `typescript-eslint`. The other majors of pull request 4 join the step of their package.
- A step that cannot pass is reverted, and `.github/dependabot.yml` gets an ignore rule for that major with the reason in a comment; the handoff names it. `@types/node` stays on the 22 major with an ignore rule.
- No behaviour change: no test is deleted or weakened, and a test changed for a new library behaviour carries the reason in the handoff.
- The release images still pass `check-release-artefacts.sh` and the Trivy gate (`build-bundle.sh --images-only` of M2-S01), and `THIRD-PARTY-NOTICES.md` is regenerated when M3-M01 ran.

Acceptance:

```bash
npm ci
npm run typecheck && npm run lint && npm test
npm run openapi
npm run build -w @mscd/server -w @mscd/web
npm run test:int -w @mscd/server
npm run test:int:saas -w @mscd/server
CI=1 npm run test:e2e -w @mscd/web
flock /tmp/mscd-stack.lock npm run test:e2e:api -w @mscd/web
flock /tmp/mscd-stack.lock npm run test:smoke
flock /tmp/mscd-stack.lock npm run journey -w @mscd/smoke -- --saas
flock /tmp/mscd-stack.lock npm run lifecycle -w @mscd/smoke
node tools/scripts/check-workflows.mjs --saas --require-all
npm run check:text
```
