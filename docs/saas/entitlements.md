# Plans and limits of customer organisations

This guide explains how MSCD limits what each customer organisation may use on the SaaS service: the plan presets, how to see and change a customer's plan, what is recorded, and what the customer's users see when they reach a limit. It belongs to work package M2-S10 of the [Milestone 2 plan](../platform/MILESTONE-2.md#m2-s10-per-organisation-entitlements).

## The idea in short

On the SaaS service every customer organisation has one **entitlement**: the set of limits it may use. MSCD keeps it in the table `platform.entitlement`, one row per organisation. The entitlement is the organisation's licence there: the Licence screen of a Tenant Admin shows it, and every limit check reads it.

An entitlement holds:

| Limit | Meaning |
|---|---|
| Users | Active members of the organisation. Guests (for example external auditors with a guest link) and invited people who have not accepted yet do not count (product decision 5) |
| Management systems | Management systems that are not archived |
| Frameworks | The standards the organisation may use. An empty list in a preset or in limits you set means every installed standard |
| Storage adapters | Where evidence may be kept (Managed Vault, Microsoft 365, Google Drive, and the on-premise adapters) |
| Features | Integrated Management System, edition transition, link health monitor, auditor guest access |
| Requests a minute | Per user and per organisation. Empty means the defaults of every request: 600 per user and 6000 per organisation each minute |
| Valid from, valid until | The first and the last day of the plan. "No end date" is possible |
| Grace days | How long the organisation keeps working after the last day before it becomes read-only |

An entitlement comes from one of three **sources**:

- `preset`: a plan preset of the profile, for example `trial` or `standard`.
- `manual`: limits the operator typed in.
- `signed_licence`: a signed licence file that was uploaded for the organisation.

On-premise installations with one organisation do not use entitlements. They keep the signed licence file, as before.

## Plan presets

The presets live in `apps/server/profiles/saas.yaml` under `license.plans`. They are the defaults of decision D-S4:

| Preset | Users | Management systems | Valid for | Grace | Frameworks | Storage | Features |
|---|---|---|---|---|---|---|---|
| `trial` | 10 | 1 | 30 days | 7 days | every installed standard | Managed Vault, Microsoft 365, Google Drive | all four |
| `standard` | 50 | 3 | 365 days | 30 days | every installed standard | Managed Vault, Microsoft 365, Google Drive | all four |

To change a preset or add one, edit `license.plans` in `saas.yaml` and deploy. A preset name uses small letters, digits, `-` and `_`. A changed preset applies to organisations that get the preset afterwards. Organisations that already have it keep their limits until you set the preset for them again.

## See a customer's plan

On the server, through the operations workflow or a shell in the api container:

```bash
mscd-server license entitlements show --org <slug>
```

It prints the plan, the limits, the current use (for example "Users: 41 of 50") and the dates. Add `--json` for the same answer as the operator route. An organisation without an entitlement prints a message and ends with exit code 1.

Through the operator routes (the operator console uses the same ones):

| What | Route |
|---|---|
| The presets | `GET /api/v1/ops/plans` |
| One organisation's entitlement with its current use | `GET /api/v1/ops/organizations/<slug>/entitlements` (the answer carries an `ETag`) |

## Change a customer's plan

### With the command line

Give a preset:

```bash
mscd-server license entitlements set --org <slug> --preset standard
mscd-server license entitlements set --org <slug> --preset standard --valid-from 2026-11-01
```

A preset starts today in the organisation's time zone unless you give `--valid-from`, and lasts the preset's number of days.

Or give limits. Options you leave out keep their current value:

```bash
# A first entitlement: the user and system limits and the last day are needed.
mscd-server license entitlements set --org <slug> --max-users 25 --max-systems 2 --valid-until 2027-06-30

# More users only; everything else stays.
mscd-server license entitlements set --org <slug> --max-users 80

# A rate limit of 300 requests per user and minute; "default" goes back to the default.
mscd-server license entitlements set --org <slug> --rate-user 300
```

The other options are `--valid-from`, `--grace-days`, `--frameworks` (codes such as `ISO27001,ISO9001`, or `all`), `--storage-adapters`, `--features` (or `none`), `--rate-org` and `--plan` (a name for the limits). `--help` lists them. Limits you type get the source `manual`; their plan name is the `--plan` value, or none.

### With the operator route

`PUT /api/v1/ops/organizations/<slug>/entitlements` takes either `{"preset": "standard"}` (with an optional `validFrom`) or every limit. It needs the `If-Match` header:

- the `ETag` of your last read, so you never overwrite a change someone else made in the meantime (answer 412 when the entitlement changed since);
- or `*` to replace whatever is there, which is also how you create the first entitlement of an organisation (there is no ETag to read yet);
- without the header the answer is 428.

### What happens on a change

- One audit entry `ops.entitlements_changed` records who made the change, the old values and the new ones.
- Every api and worker process uses the new limits within about 2 seconds (each process keeps the entitlement in memory for at most 60 seconds, and the change notice `mscd_tenant_changed` clears it at once).
- The daily licence check runs straight away, so licence warnings and read-only storage follow the new limits.
- Setting the same values again changes nothing and records nothing.

### Limits below the current use

You may set a limit below what the organisation uses today, for example 30 users while it has 41 active members. The change is saved with a warning in the answer (rule `LIC-USERS` or `LIC-MS`). Nobody loses access and nothing is deleted. The organisation cannot add or invite anyone, or create a management system, until it is below the limit again.

### Renew a plan

Set the preset again with the new first day, or set a later `--valid-until`. Do it before the last day; the reminders below tell you when.

## Signed licence files

A customer who bought a signed licence file can still have it installed: the operator console's "Install licence", or `PUT /api/v1/admin/license` with `{"org": "<slug>", "licence": {...}}`. MSCD checks the signature as before and then writes the entitlement from the licence (source `signed_licence`). Rate limits set before are kept, because a licence file has none.

**Upgrades from before M2-S10.** An organisation that had a valid signed licence installed and no entitlement row gets its row from that licence the first time anything reads its licence. This happens once, is recorded as `ops.entitlements_changed` by the system, and keeps every limit of the licence. A stored licence that does not verify writes no row: the organisation stays read-only, as it was.

**No plan at all.** An organisation without an entitlement and without a licence can have one member (its first Tenant Admin) and nothing else, as in Milestone 1. Set a preset for every new customer. From wave 3a, creating an organisation in the operator console or with `tenant onboard --preset` does this in the same step.

## Reminders before the last day

The daily job `entitlement.expiry` runs at 06:15 in each organisation's time zone:

| Who | When | How |
|---|---|---|
| Every platform operator | 30, 7 and 1 days before the last day | One email per organisation and day: "<organisation>: the <plan> ends in <n> days", with a link to the operator console |
| The organisation's Tenant Admins | 30 and 7 days before | A notification in MSCD, also sent by email |

The daily licence check also gives the Tenant Admins a notification 60 days before. A Tenant Admin gets each notification only once, whichever job writes it first. Nothing is sent for an entitlement without an end date.

**When the mail server cannot be reached.** The Tenant Admins' notification always stays in MSCD; its email is tried again every 5 minutes, up to 5 tries in all. For the operator emails:

- When none of the day's operator emails could be sent, the job runs again for that day at the next hour, and every hour after that, until the emails go out or the following day has ended. Nobody got the email before, so nobody gets it twice.
- When some were sent and some were not, the job does not try again, because the operators who got the email would get it a second time. The others miss that reminder; the worker log shows an error "operator emails could not be sent".
- After an outage of more than a day the reminder of that day is not sent.

Two more checks cover a missed reminder: `license entitlements show` prints an organisation's last day, and the alert [LicenceExpiringSoon](monitoring.md#licenceexpiringsoon) fires while an organisation has less than 30 days left.

## What the customer's users see at each limit

| Situation | What users see |
|---|---|
| The user limit is reached | Inviting or adding a person stops with "The plan of this organisation allows N active users and the organisation already has N. Ask your MSCD service provider for a plan with more users." (rule `LIC-USERS`) |
| The system limit is reached | Creating a management system stops with "The plan of this organisation allows N management systems ..." (rule `LIC-MS`) |
| A feature is not in the plan | The action stops with "The plan of this organisation does not include ..." (rule `LIC-FEATURE`) |
| A storage adapter is not in the plan | The adapter cannot be chosen for a new repository; existing repositories of that adapter become read-only at the next licence check |
| A standard is not in the plan | A management system for it cannot be created (rule `BR-21`) |
| 30 and 7 days before the last day | Tenant Admins get the reminder above; the Licence screen shows the dates |
| After the last day | The grace period starts: everything works, the Licence screen shows "Grace period" |
| After the grace period | The organisation is read-only: users can still sign in, read and export, but every change is refused until the plan is renewed |
| Too many requests in a minute | The request is refused with "try again in N seconds" (answer 429) |
| No plan set yet | Adding users or systems stops with "No plan is set for this organisation yet. Ask your MSCD service provider to set one ..." |

The messages are in English and Indonesian, in the user's language.

## Questions

**A customer says nobody can be invited.** Run `license entitlements show --org <slug>`. When "Users" shows the limit reached, raise `--max-users` or set a larger preset. Members who left can also be disabled by the Tenant Admin, which frees their places.

**The change does not seem to count.** Each process picks it up within about 2 seconds. When the database connection of a process was interrupted, the process reads the entitlement again within 60 seconds at the latest.

**Where is the history of a customer's plan?** In the platform audit log, action `ops.entitlements_changed`, with the old and the new values of each change.
