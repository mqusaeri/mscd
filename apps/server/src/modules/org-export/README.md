# org-export module

The full export of an organisation (Milestone 3 D.4, D3-03). Owner: M3-02.

- Tenant Admin routes (`org.export.manage`): `GET/POST /admin/organization/exports`, `GET /admin/organization/exports/{id}`,
  `POST .../{id}/decision`, `GET .../{id}/manifest`, `GET .../{id}/parts/{part}`. A request waits for a second active
  Tenant Admin when there is one (rule `SOD-SELF-APPROVE` for the requester); with one Tenant Admin it is queued at once
  with a warning. Every request, decision and download is audited (`organization_export.*`) and announced
  (`organization_export_requested`) to every active Tenant Admin and every primary Management System Manager. These
  routes stay usable while the organisation is `offboarding`.
- Operator routes (multi tenancy only): `GET/POST /ops/organizations/{org}/exports` show the status and queue an export
  (audited `ops.export_requested`); operators never download one.
- `org-export.build` (`org-export-build.job.ts`) builds any `queued` export, also the final export that the move to
  `offboarding` queues: `builder.ts` writes the gzipped tar parts (`archive/`, pax headers, part rotation, pieces for
  entries larger than a part) one at a time in the worker's temporary folder, and the job uploads each part to
  `exports/organization/<id>/` of the Managed Vault before the next one starts. The parts hold `README.txt`,
  `data/tenant/*` (every table, `tenant-data.ts`), `data/platform/*` (`platform-data.ts`), `audit/*` (`audit-data.ts`),
  `files/*` (decrypted vault files and the list of external files) and `manifest.json` (`manifest.ts`). The audit
  folder names the public anchor key of the installation (the public half of `audit.anchor_key_file`, which the worker
  signs with; on-premise each installation makes its own) and the compiled keys; a key the build does not know is
  listed with a null PEM and never replaced by another key.
- `exclusions.ts` classifies every tenant table and every platform table that holds organisation data (R-21);
  `test/int/org-export/coverage.test.ts` fails on a table or column that is not classified.
- `expiry.ts` is a tenant step of `cleanup.expired` for every organisation that is not deleted: it deletes the vault
  content of expired organisation exports (a final export once the organisation is closed) and of expired 7-day
  `export_file` files through `gateway.objects.delete`, expires requests left without a decision for 7 days, and fails
  an export left `queued` or `building` for 24 hours while no build runs (a worker that died), deleting what it stored.
- `verify.ts` checks an export folder (`mscd-server export verify`): parts and entries against the manifest, every audit
  hash from its canonical text (attested redactions included), and the signed anchors with the anchor keys compiled into
  the build and the public keys the operator names with `--anchor-key` (never a key of the export, which is not
  signed); an anchor without a valid signature by a trusted key is a problem. The report gives the newest anchored row
  and the rows after it, which no signature covers.
- `build-lock.ts`: one build at a time in the installation (a session advisory lock on a pinned connection), taken by
  the job (a busy job sends itself again two minutes later) and by `mscd-server export organization` (refuses).
