# packs module

Framework pack installation with compiled trust anchors, the pack lifecycle and the pack routes (E.8, D-16, D-17, TS 6.3).

- `pack-verification.ts`: E.8 steps 1 to 3 (archive rules, signature, checksums, datasets through `@mscd/pack-tools`, engine version, chain entity types), and the api's import check, which refuses more than 16 MiB decompressed after decompressing off the event loop.
- `pack-installer.ts`: `PackInstaller` (steps 4 and 5) on a connection of role `mscd_pack_installer`; used by `migrate` (C.3 step 5), `mscd-server packs install` and the `pack.install` job. A lower version than the installed one is refused, except in `migrate`, which skips it. A newer version that drops a requirement or catalogue code is refused (422, rule `PACK-ROW-REMOVED`); retired rows, documented information, template clauses and review kinds are written (Milestone 2 E.1). Mapping rows whose target pack is not installed are kept in the `pack.installed` audit entry and written when that pack is installed. The audit entry of an update carries its change summary.
- `pack-content-diff.ts`: the rows an update drops (the refusal) and the change summary of an update (codes added, retitled, retired, back in the standard; new cycle requirements; activity and preparation task templates no longer listed, which stay installed).
- `applicability-sync.service.ts`, `applicability-sync.job.ts`: `applicability.sync` (Milestone 2 E.3). After an update, every system on the edition gets the entries of new catalogue items and leaf requirements (`implementation/applicability-seed.ts`) and the cycle items of new cycle requirements in its open cycles; nothing is deleted; the MS Managers get one `pack_content_updated` notice; the run is audited as `pack.content_synced`. Waiting systems are read from the database (update installations after the system was created and newer than the last one synced), so a run is idempotent. Queued by `pack.install` after an update, and by `packs.lifecycle` daily and the worker start for installations made by `migrate` or the command line. Demo organisations are skipped.
- `pack-installer.service.ts`: the lazily opened installer pool and the installer for Nest.
- `pack-bundle-store.ts`: where an imported bundle waits for the job (Managed Vault through the gateway, else a local temporary file, which only a job of the in-memory queue in the same process can read; with a separate worker such an import answers 503).
- `packs.service.ts`, `packs.controller.ts`: `GET /admin/packs`, `POST /admin/packs/import`, `POST /admin/packs/check-updates`.
- `pack-lifecycle.service.ts` and the jobs `pack.install`, `packs.lifecycle`, `edition.withdrawn-alerts`.
- `pack-verification.ts` compares `engine_min_version` with the release of the server (`engineVersionSatisfies` of `@mscd/shared`): `1.1.0-rc.1` reads 1.1.0 packs, and a version that is not a version number (an image tag) is not compared.
- `install-from-dir.ts`: installs every pack file of a folder (`migrate`) or one file (the command line).

Owner: WP-12; Milestone 2 format and upgrade path: M2-03.
