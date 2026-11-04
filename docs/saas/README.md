# MSCD SaaS: owner pack and operations documents

This folder holds what the owner and the operators need to run MSCD as a multi-tenant SaaS service: the go-live checklist, the owner's inputs, the facts for the lawyer, the records of processing, the incident plan and the penetration test scope, and the operating guides of the SaaS service: releases, the Compose stack, server bootstrap, deploys, backups, monitoring, customer organisations, plans and sign-in. The plan behind it is section K of the [Milestone 2 plan](../platform/MILESTONE-2.md#k-saas-production-track); the end of a contract, requests from one person and the retention periods come from the [Milestone 3 plan](../platform/MILESTONE-3.md).

Every legal point in these documents is general information. Each one needs the advice of a lawyer qualified in Indonesian law before go-live.

## Start here

| If you want to | Read |
|---|---|
| Know what must be true before the first customer | [go-live-checklist.md](go-live-checklist.md) |
| Buy, set up and decide what only the owner can | [owner-inputs.md](owner-inputs.md) |
| Brief the lawyer (privacy notice, DPA, terms, DPO, PSE, data location) | [legal-inputs.md](legal-inputs.md), then [records-of-processing.md](records-of-processing.md) |
| Book the penetration test | [pentest-scope.md](pentest-scope.md) |
| Handle a security incident or a personal data breach | [incident-response.md](incident-response.md) |
| Answer a person who asks to see, correct or delete their data | [Requests from data subjects](records-of-processing.md#requests-from-data-subjects): the customer answers on screen, the provider forwards |
| Onboard, suspend or offboard a customer organisation | [operator.md](operator.md) |
| End a contract: final export, deletion date, deletion certificate | [Offboarding at the end of a contract](operator.md#offboarding-at-the-end-of-a-contract) |
| Tell a customer how long its data stays in the backups after a deletion | [The backups, in honest words](operator.md#the-backups-in-honest-words) and [Deleted organisations and the backups](backup-restore.md#deleted-organisations-and-the-backups) |
| Check a deletion certificate | `mscd-server tenant verify-certificate <file>` ([operator.md](operator.md#offboarding-at-the-end-of-a-contract), step 7) |
| Restore a backup older than an erasure of a person | [Erased people and the backups](backup-restore.md#erased-people-and-the-backups) and [operator.md](operator.md#offboarding-at-the-end-of-a-contract), step 10 |
| Check the backup bucket before the first organisation deletion | [Before the first deletion](operator.md#before-the-first-deletion) and GL-27 of [go-live-checklist.md](go-live-checklist.md) |
| Change a customer's plan or a limit | [entitlements.md](entitlements.md) |

## Documents in this folder

| Document | What it holds | Written by |
|---|---|---|
| [go-live-checklist.md](go-live-checklist.md) | One table per area (security, operations, UU PDP, legal documents) with who, evidence and status per item, the recorded decisions and the sign-off. GL-27 needs the bucket's lifecycle rule and `lifecycle.backup_copies_end_days` confirmed before the first deletion; GL-69 holds production until disposals have receipts | M2-S04; status and evidence updated by M2-S13; GL-27 and GL-69 by M3-14 |
| [owner-inputs.md](owner-inputs.md) | What the owner buys and sets up, every GitHub secret and variable with the command that sets it, and the owner's decisions with their defaults | M2-S04 |
| [legal-inputs.md](legal-inputs.md) | Facts for the lawyer: data per activity, cookies, recipients, locations, retention with the backup statement (disposals delete content, erasure receipts), security measures, the end of a contract and what is not built yet, and the questions to answer, with the lawyer's questions on the article and deadline of each right | M2-S04; Milestone 3 facts by M3-11; review fixes by M3-14 |
| [records-of-processing.md](records-of-processing.md) | One record per processing activity, the retention periods with the remaining gaps, how requests from people are answered on screen and the provider's same-day forwarding with its log. Draft for the lawyer's review | M2-S04; draft 2 by M3-11; draft 3 by M3-14 |
| [incident-response.md](incident-response.md) | Roles, severity levels, the steps, how to find the affected organisations and people, notice templates in Indonesian and English, the incident log and an exercise script. Draft for legal review | M2-S04 |
| [pentest-scope.md](pentest-scope.md) | The staging target, test accounts per role in two organisations, the areas in and out of scope, and the rules of engagement | M2-S04 |

The operating guides of the SaaS service:

| Document | What it holds | Written by |
|---|---|---|
| [release.md](release.md) | Cutting a release, the checks of each image, verifying an image with `cosign verify`, the security scans and test builds | M2-S01 |
| [stack.md](stack.md) | The SaaS Compose stack: what runs, how a request travels, certificates and HSTS, request limits, logs, the marketing site and the local test stack | M2-S02 |
| [bootstrap.md](bootstrap.md) | Preparing a new Ubuntu server: what to buy, the DNS records, the bootstrap run from GitHub Actions and what to do afterwards | M2-S03 |
| [deploy.md](deploy.md) | Deploys through `deploy-prod.yml`, the automatic rollback, rollback by hand and the deploy rehearsal | M2-S05 |
| [backup-restore.md](backup-restore.md) | The nightly off-site backup, the weekly restore test, a full restore onto a new server, deleted organisations in the backups (`restore.sh --reapply-deletions`), erased people in the backups (`restore.sh --reapply-erasures` with the erasure receipts), and the disposals a restore from an older copy brings back until disposal receipts exist | M2-S07; deletions by M3-03; erasures and the disposal gap by M3-13 |
| [monitoring.md](monitoring.md) | What runs, where alerts go, what each alert means and the first action, and the outside heartbeat and uptime checks | M2-S08 |
| [operator.md](operator.md) | The first operator account, onboarding a customer, the organisation statuses, offboarding with the final export and `export verify`, the bucket check before the first deletion, the deletion and its certificate, erasure receipts and `restore.sh --reapply-erasures`, and every operator command | M2-S09; end of contract by M3-11; receipts and the bucket check by M3-14 |
| [entitlements.md](entitlements.md) | The plan presets, how to see and change a customer's plan, and what users see at each limit | M2-S10 |
| [sign-in.md](sign-in.md) | The one sign-in page, email domain verification with a DNS TXT record, and the privacy and terms links | M2-S11 |

## Order of going live

The full order is in [section K.7 of the plan](../platform/MILESTONE-2.md#k7-order-of-going-live). In short:

1. **Owner:** buy the servers, domain, mail provider and backup bucket; start the lawyer's work with [legal-inputs.md](legal-inputs.md); book the penetration test with [pentest-scope.md](pentest-scope.md).
2. **Owner:** make the release key set on your own computer and set the GitHub environments ([owner-inputs.md](owner-inputs.md), sections 1 and 2).
3. **Owner approves:** bootstrap staging, then production.
4. **Owner:** push the first release tag and approve the release.
5. **Agent starts, owner approves:** deploy to staging and create the first operator there.
6. **Vendor:** penetration test on staging; agents fix the findings; the vendor retests.
7. **Agent starts, owner approves:** the restore-test migration rehearsal, the production deploy and the first operator on production.
8. **Owner:** publish the privacy notice and terms, set their addresses, deploy again, and confirm that the test alert and heartbeat arrive.
9. **Owner:** run `node tools/scripts/check-golive.mjs --require-done docs/saas/go-live-checklist.md` until it passes, then sign off in the checklist.
10. **Operator:** onboard the first customer with the signed DPA in place.

## Checking the checklist

```bash
node tools/scripts/check-golive.mjs docs/saas/go-live-checklist.md                     # format and links, runs in CI
node tools/scripts/check-golive.mjs --agent-items-done docs/saas/go-live-checklist.md  # every agent row done (M2-S13)
node tools/scripts/check-golive.mjs --require-done docs/saas/go-live-checklist.md      # every row done (go-live day)
node tools/scripts/check-golive.mjs --self-test                                        # the checker's own tests
```

The checker prints a summary per area and one line per problem, with the line number in the checklist. It exits with 0 when everything passes, 1 when it finds a problem and 2 when it is called the wrong way.

## Rules for these documents

- Plain English, no em dash and no centre dot (`npm run check:text` checks the `docs` folder).
- No secret, password, key or personal data in this folder: the repository is public. The incident contact list, the names of the platform operators, the incident log, the forwarding log of requests and the deletion certificates live in the provider's protected storage. The one exception is the owner's name in the sign-off table of the go-live checklist.
- AI agents never hold production or staging secrets, never connect to those servers and never approve a protected GitHub environment (rule S-1 of the plan).
