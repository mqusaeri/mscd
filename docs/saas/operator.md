# Running customer organisations

This guide is for the platform operator of the MSCD SaaS service. It explains how to create the first operator account, how to onboard a customer step by step, what each organisation status means for the customer's users, how to offboard a customer at the end of a contract, and every operator command. It belongs to work package M2-S09 of the [Milestone 2 plan](../platform/MILESTONE-2.md#m2-s09-operator-commands-and-organisation-lifecycle).

## Where the operator works

| Tool | Use it for | Who can use it |
|---|---|---|
| Operator console in the web app | Everyday work: create organisations, change their status, set plans, verify email domains | A signed-in platform operator (password and authenticator app) |
| Workflow `ops-cli.yml` on GitHub | The first platform operator, and a fallback when the console cannot be used | The owner approves each run in the GitHub environment |
| `saas-ops.sh` on the server | The same commands as the workflow, for someone with SSH access to the server | Named accounts on the server |
| `mscd-server` commands in the `cli` container | Behind both of the above; on-premise installations use them directly | The server's operators |

Every tool uses the same code on the server: the command `tenant onboard` and the console's "create organisation" run the same steps, and so do `tenant set-status` and the console's status change. Each change is written to the platform audit trail as an action of the operator.

The repository is public, so anyone can read the log of a workflow run. The workflow therefore shows placeholders such as `[email]`, `[user]` and `[organisation]` instead of the values you typed and the user names made from them, hides one-time links, and shows counts instead of lists. The fields that can hold personal data (`email`, `person_name`, `org`, `org_name`, `reason` and `confirm`) are hidden in the log before the job prints anything. The full output stays on the server in `/opt/mscd/logs/ops-<time>-<command>.log` for 90 days; each later command removes older ones. The values you type into the workflow form are kept with the run, so use the console for customer data whenever you can, and never write personal data into a reason.

## The first platform operator

The operator console needs a platform operator account. The owner creates the first one once per server, with the owner's own email address:

```bash
gh workflow run ops-cli.yml -f target=staging -f command=create-operator -f email=<your email> -f person_name="<your name>"
```

The run waits until the owner approves it in the `staging` (later `production`) environment. Then:

1. The server checks that it can send email. Without working mail it refuses and creates nothing (`mail.required` on SaaS).
2. You get the email "Your MSCD platform operator account" with a link that works once, for 72 hours.
3. Open the link, choose a password, sign in, and set up an authenticator app. The operator console is now open to you.

To take the role away again, run the workflow with `command=revoke-operator` and the email address. Every session of that account ends; its other memberships stay.

## Onboarding a customer

Customers are onboarded by the operator after a sale (decision D-S1). Self-service sign-up does not exist.

### Before you start

1. The customer has signed the contract and the data processing agreement (DPA).
2. You have agreed the plan: `trial` or `standard`, or limits of your own ([entitlements.md](entitlements.md)).
3. You have from the customer:
   - the organisation name, for example "PT Bank Sentosa";
   - its time zone, for example `Asia/Jakarta` (it decides when daily reminders and checks run);
   - the number of sites;
   - the name and email address of the person who will administer MSCD for the customer (the first Tenant Admin).
4. You have chosen the **slug**: the short name of the organisation in addresses and commands, for example `bank_sentosa`. It starts with a small letter and has 2 to 40 small letters, digits or `_`. **The slug can never be changed.**

### Create the organisation

In the operator console, choose "New organisation" and fill in the form, or run the workflow:

```bash
gh workflow run ops-cli.yml -f target=production -f command=tenant-onboard \
  -f org=bank_sentosa -f org_name="PT Bank Sentosa" -f time_zone=Asia/Jakarta -f site_count=3 \
  -f email=it.admin@banksentosa.co.id -f person_name="Andi Wijaya" -f preset=standard
```

In one step MSCD then:

1. checks that it can send email (with `mail.required` it creates nothing while mail does not work, and it never shows an invitation link);
2. creates the organisation with its own database schema, its own data key and a Managed Vault repository, in the region of the server (`tenancy.default_region`, `id` for Indonesia);
3. allows sign-in with a password and an authenticator app (product decision 7: no SSO-only start);
4. sets the plan from the preset, when you named one (without a preset the organisation can add no users or systems until you set a plan);
5. invites the first administrator as Tenant Admin and emails the invitation. The output says "Invitation sent to" the address.

### What happens next

1. The first administrator opens the invitation within 72 hours, sets a password and an authenticator app, and signs in. If the link expired, invite the person again with `admin-create-user --tenant-admin`.
2. The administrator follows "Getting started" in the app: a second administrator, the team, storage, sign-in policy and the management systems.
3. If the customer wants people to find the organisation by their email address at sign-in, verify the customer's email domains: in the operator console with a DNS record (work package M2-S11, guide `sign-in.md`), or with the command `tenant verify-domain` on the server.
4. Check the organisation in the console or with `tenant-show`: status `active`, the plan and its end date, members, systems and the last sign-in.

## What each status means

An organisation always has one of four statuses. The customer's Tenant Admins get an email each time you change it, with the new status, what it means and the reason you gave.

| Status | What the customer's users can do | Sessions | Data | Daily jobs and emails |
|---|---|---|---|---|
| `active` | Everything their roles allow | Kept | Kept | Run |
| `suspended` | Nothing in this organisation: every page and action of it is refused. People who belong to other organisations keep working there | Every session in this organisation ends at once | Kept, nothing is deleted | Stop (no reminders, checks or digests) |
| `offboarding` | Sign in, read and export. Nothing can be changed | Kept | Kept | Stop, except the emails of finished exports |
| `archived` | Nothing: the organisation no longer appears for them | Every session in this organisation ends at once | Kept until it is deleted as the contract says | Stop |

In plain words:

- **Suspended** is a pause. Use it for an unpaid invoice or while a security incident is looked into. Making the organisation active again restores everything as it was.
- **Offboarding** is the read-only period at the end of a contract. The customer takes out what it needs to keep.
- **Archived** closes the organisation for good. There is no way back to active.

### Allowed moves

| From | To |
|---|---|
| `active` | `suspended`, `offboarding` |
| `suspended` | `active`, `offboarding` |
| `offboarding` | `active`, `archived` |
| `archived` | none (final) |

Every move needs a reason of 3 to 500 characters. The reason goes into the status history, the audit trail and the email to the Tenant Admins, so write it for the customer to read and name no person, for example "Invoice of September unpaid after two reminders".

A move to `offboarding` or `archived` also needs the slug typed again as a confirmation (`confirm` in the workflow, `confirmSlug` in the route). A wrong or missing confirmation changes nothing.

### Change the status

In the operator console, open the organisation and choose "Change status". Or run the workflow:

```bash
gh workflow run ops-cli.yml -f target=production -f command=tenant-set-status \
  -f org=bank_sentosa -f status=suspended -f reason="Invoice of September unpaid after two reminders"
```

The output says how many sessions ended and how many Tenant Admins were emailed. The change counts in every server process within moments. The status history of the organisation is in the console and in `tenant-show`.

## Offboarding at the end of a contract

The default read-only period is 30 days (decision D-S5). Agree the dates with the customer and keep to the DPA.

1. **On the last day of the contract:** move the organisation to `offboarding` with the slug as confirmation. The Tenant Admins get the email that the organisation is read-only.
2. **During the read-only period:** the customer exports what it needs. Each management system has its exports (register exports, evidence packs and the audit trail). A full export of the whole organisation in open formats is not built yet ([plan K.8](../platform/MILESTONE-2.md#k8-not-in-this-track)); agree with the customer which exports it needs before the period starts.
3. **If the customer renews during the period:** move the organisation back to `active` and set the new plan ([entitlements.md](entitlements.md)).
4. **After 30 days:** move the organisation to `archived` with the slug as confirmation. Every session in it ends, and its users no longer see it.
5. **Deletion:** the verified purge of an archived organisation is not built yet (plan K.8). Until it is, the data stays in the database and in the backups for their retention periods ([records-of-processing.md](records-of-processing.md#retention-periods)). Record what you promised the customer.

Requests from people about their own data (to see, correct or delete it) follow the manual procedure in [records-of-processing.md](records-of-processing.md#requests-from-data-subjects). If the end of a contract comes with a security incident or a data breach, follow [incident-response.md](incident-response.md) first.

## Commands

### The workflow `ops-cli.yml`

Start it in GitHub (Actions, "Operator command", Run workflow) or with `gh workflow run ops-cli.yml`. Choose the server (`target`) and the command, and fill in the fields the command needs. The owner approves the run in the environment. The job checks every field, connects to the server with the pinned host key and runs `saas-ops.sh` there. It never runs at the same time as a deploy of the same server.

| Command | Fields | What it does |
|---|---|---|
| `create-operator` | `email`, `person_name` (optional) | Makes the account a platform operator; a new account gets the set-password email |
| `revoke-operator` | `email` | Ends the platform operator role and its sessions |
| `tenant-list` | `status` (optional filter) | The number of organisations per status |
| `tenant-show` | `org` | Status, region, plan, members, systems, number of domains, last sign-in and the last status moves of one organisation |
| `tenant-onboard` | `org`, `org_name`, `time_zone`, `site_count`, `email`, `person_name`, `preset` (optional) | Creates the organisation, sets its plan and invites its first administrator |
| `tenant-set-status` | `org`, `status`, `reason`, `confirm` (for offboarding and archived) | Moves the organisation to another status |
| `admin-create-user` | `org`, `email`, `person_name` (optional), `tenant_admin` | Invites a person to an organisation, for example a new first administrator |
| `license-entitlements-show` | `org` | The plan, limits and current use |
| `license-entitlements-set` | `org`, then `preset` or `max_users`, `max_systems`, `valid_until` (with `valid_from`, `grace_days` optional) | Sets the plan or the limits |
| `diagnostics` | none | Writes the diagnostics archive on the server (see below) |

### `saas-ops.sh` on the server

```bash
bash /opt/mscd/deploy/scripts/saas-ops.sh <command> [options]
bash /opt/mscd/deploy/scripts/saas-ops.sh --help
```

It accepts only the ten commands above, with the options of the matching `mscd-server` command in their own spelling (for example `tenant-onboard --slug bank_sentosa --name "PT Bank Sentosa" --time-zone Asia/Jakarta --site-count 3 --admin-email ... --admin-name ...`). Each value is checked, then the script runs one `docker compose run --rm cli` command of the installed stack. Anything else, for example a shell or `psql`, is refused with exit code 2. `--public` prints the masked output that the workflow shows, and `--dry-run` checks the values and prints the command without running it. Every run writes its full output to `/opt/mscd/logs/ops-<time>-<command>.log`, readable only by the account that ran it, and removes the logs of runs older than 90 days and diagnostics archives older than 14 days.

### `mscd-server` commands

| Command | Route of the console |
|---|---|
| `mscd-server admin create-operator --email <email> [--name <name>]` | none |
| `mscd-server admin revoke-operator --email <email>` | none |
| `mscd-server tenant list [--status <status>] [--summary] [--json]` | `GET /api/v1/ops/organizations` |
| `mscd-server tenant show --org <slug> [--summary] [--json]` | `GET /api/v1/ops/organizations/<slug>` and `.../events` |
| `mscd-server tenant onboard --slug <slug> --name <name> --time-zone <zone> --site-count <n> --admin-email <email> --admin-name <name> [--preset <name>]` | `POST /api/v1/ops/organizations` |
| `mscd-server tenant set-status --org <slug> --status <status> --reason <text> [--confirm <slug>]` | `POST /api/v1/ops/organizations/<slug>/status` |
| `mscd-server admin create-user --org <slug> --email <email> [--name <name>] [--tenant-admin]` | none |
| `mscd-server license entitlements show` and `set` | `GET` and `PUT /api/v1/ops/organizations/<slug>/entitlements` |
| `mscd-server diagnostics --out <file>` (or `--out -` for standard output) | `POST /api/v1/ops/diagnostics` |

`tenant onboard` and `tenant set-status` work only on a SaaS installation with many organisations (`tenancy.mode multi`); on an installation with one organisation they refuse with the message that it runs one organisation. `tenant list` and `tenant show` work on both.

### Diagnostics

The diagnostics archive helps support find a fault. It holds the profile without secrets, versions, the migration state, queue statistics, the installation health, log lines and metrics, and every file is checked for secret values once more before it is written. The command builds it without the api, so it also works when the api does not start; when even the database cannot be reached, the archive says so in `health.json`.

Through the workflow, the archive is written on the server to `/opt/mscd/diagnostics/mscd-diagnostics-<time>.tar.gz` and the run prints its size and SHA-256 hash only. Copy it with your own SSH access and look through every file before you send it to anyone. The server keeps the archive for 14 days.

## When a command is refused

| Message | Meaning and what to do |
|---|---|
| "Mail is required on this installation" | The server cannot send email. Fix the mail settings of the environment ([deploy.md](deploy.md)) and run the command again; nothing was created |
| "is already ... " or "cannot move to ..." | The move is not allowed from the current status (see "Allowed moves"). The message names the moves that are allowed |
| "needs confirmSlug equal to the slug" | Type the slug again in `confirm` for offboarding and archived |
| "There is no plan preset" | The preset is not in `license.plans` of the profile ([entitlements.md](entitlements.md)) |
| "already exists" | Another organisation has this slug. Choose another one; the slug is permanent |
| "runs one organisation" | The installation has one organisation (on-premise); organisations are created there with the installer |
| "is not on the server" (workflow) | The running release does not have `saas-ops.sh` yet. Deploy a newer release with `deploy-prod.yml` |
