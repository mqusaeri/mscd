# Framework pack sources

This folder holds the source datasets of the framework packs that MSCD installs. `packages/pack-tools` builds and signs each source folder into `packs/dist/<pack_id>-<version>.pack` (git-ignored), and the server installs those archives into the `ref` schema (build plan E.8, Milestone 2 E.1).

| Path | Content |
|---|---|
| `sources/<pack_id>/` | One folder per pack, generated from the web sample data and the hand-written content. Never edit these files by hand |
| `content/<pack_id>/` | Hand-written pack content, merged over the sample extract: CSV rows, `removed.csv` and `manifest.json` with the pack version (see "Hand-written content") |
| `scripts/extract-from-sample.mjs` | Writes `sources/` from `apps/web/src/data/mscd-data.js`, the tables at the top of the script and `content/` |
| `scripts/validate-sources.mjs` | Checks every source folder and prints the dataset counts, or with `--json` the counts as JSON |
| `scripts/lib/pack-format.mjs` | The file list, CSV headers, row keys, engine version and encoding rules shared by both scripts |

## Commands

Plain Node 22 scripts with no dependencies, run from the repository root:

```bash
node packs/scripts/extract-from-sample.mjs           # rewrite packs/sources from the sample and packs/content
node packs/scripts/extract-from-sample.mjs --check   # exit 1 when packs/sources is out of date
node packs/scripts/validate-sources.mjs              # format and reference checks, dataset counts
node packs/scripts/validate-sources.mjs --verbose    # the same, listing every warning
node packs/scripts/validate-sources.mjs --json       # the counts per pack as JSON on stdout
```

The extractor owns `sources/`: it rewrites every file and removes files it does not produce. It never follows a symbolic link: a link or any other entry that is not a regular file or folder under `sources/` or `content/` stops both modes before anything is written or removed, and every removal is checked to stay inside `sources/`. To change a pack, change the hand-written content in `content/<pack_id>/` (or the sample data, or the tables in `extract-from-sample.mjs`), run the extractor, then the validator. `--check` regenerates in memory and lists every file that differs, is missing or is not produced by the script, so CI catches drift between the sample, the content and the packs.

## Hand-written content

`content/<pack_id>/` holds what the sample does not: customer pack content written for the packs (Milestone 2 E.2). The extractor merges it over the sample extract of the same pack. A folder may hold:

| File | Rule |
|---|---|
| Any CSV dataset of the pack (`requirements.csv`, `documented_info.csv`, ...) | Same header as the dataset. Each row replaces the extracted row with the same key in place, or is added at the end. Keys: `requirement_code`, `item_code`, `stage_key`, `<phase_no>.<activity_no>` for activities, `<domain>/<code>` for lookups, `code` elsewhere. Requirements are then sorted by clause code and activities by phase and number; requirements and catalogue items are numbered from 1, so their `sort_order` in a content file is not used |
| `mappings/<target>.csv` | Mapping rows to another pack, keyed by source and target code |
| `removed.csv` | Columns `dataset`, `code`, `reason`. Drops a row that the sample keeps (for example the activities `9.1` to `9.14`, the whole ISO 9001:2026 transition phase). The row must be in the sample extract and must not be added again by a content file. Requirements and catalogue items are never removed: a row that leaves the standard stays with `retired` true. Phase and activity numbers must stay contiguous from 1, so activities go as a whole last phase or as the last activities of a phase: removing only `9.1` leaves a gap that `validate-sources.mjs` refuses (`mscd-pack` and the installer accept a gap, so an installed pack may still drop any activity template) |
| `manifest.json` | Only `pack_version`. The released version of the pack; it may not be lower than the version the sample shows. Every version change of a pack goes here |

Anything else in a content folder, or a folder for a pack the extractor does not build, stops the run.

## Pack versions and the upgrade path

A newer version of an installed edition updates rows in place and adds rows; the installer never deletes a row. A version that drops a requirement or catalogue code of the installed version is refused (422 `business-rule`, rule `PACK-ROW-REMOVED`): the row stays with `retired` true, and readers hide it from pickers, from the seeder of new systems and from readiness. A version may drop an activity template or a preparation task template; the template stays installed and activities created from it stay as they are. After an update, the worker adds the entries of the catalogue items and leaf requirements that join the target list in the new version (new rows, rows back in the standard, and clause rows left without a sub-clause that is still in the standard), and the cycle items of new cycle requirements, to every system on the edition (`applicability.sync`), and tells the Management System Managers. Rows that were already in the standard get no entry from the update, so a system keeps the set of entries its team chose, and an entry the team deleted is not created again.

| Pack | Version | Step |
|---|---|---|
| `ISO27001-2022` | 1.3.0 | Milestone 2 content, minor step (E.3): clauses 4 to 10 with sub-clauses, clause 10 retitled and 10.3 retired |
| `ISO9001-2015` | 1.5.0 | Milestone 2 content, minor step |
| `ISO9001-2026` | 0.10.0 | Milestone 2 content, minor step; the edition transition phase of the demo is dropped (E.4) |
| `ISO22301-2019` | 1.1.0 | Milestone 2 content, minor step: 10.1 and 10.2 retitled, 10.3 retired |
| `ISO37001-2016` | 1.1.0 | Milestone 2 content, minor step: 10.1 and 10.2 retitled, 6.3 and 10.3 retired |
| `ISO37001-2025` | 0.7.0 | Milestone 2 content, minor step: 10.1 retitled, 10.3 retired |

The patch step (1.2.1, 1.4.3, 0.9.1, 1.0.1, 1.0.1, 0.6.1) brought the pack format of engine 1.1.0 without a content change. A system created before the content step keeps the entries its team chose: the update adds entries only for the rows that are new in it (the sub-clauses), and never for clause rows that were already in the standard. A demo organisation is never synced; a demo seeded before the content step shows the new content only after `MSCD_DEMO_RESET=1` (see `docs/platform/handoff/M2-04.md`).

## Packs

| Pack | Version | Sample version | Framework | Edition status | Built from | Notes |
|---|---|---|---|---|---|---|
| `ISO27001-2022` | 1.3.0 | 1.2.0 | ISO/IEC 27001 | current | `isms` | Catalogue of the 93 Annex A controls; applicability target `catalogue_item` |
| `ISO9001-2026` | 0.10.0 | 0.9.0 | ISO 9001 | current | `qms` | Supersedes edition 2015, transition ends 2029-09-15. Clause tree to confirm against the published text (H.6) |
| `ISO9001-2015` | 1.5.0 | 1.4.2 | ISO 9001 | current | `qms` | The installer moves it to `transition` when 2026 is installed |
| `ISO22301-2019` | 1.1.0 | 1.0.0 | ISO 22301 | current | `bcms` | |
| `ISO37001-2025` | 0.7.0 | 0.6.0 | ISO 37001 | current | `abms` | Pre-release (shown as beta). Clause tree to confirm against the published text (H.6) |
| `ISO37001-2016` | 1.1.0 | 1.0.0 | ISO 37001 | withdrawn | `abms` | |

The version comes from `content/<pack_id>/manifest.json`; the sample version is the one the demo screens show (`PACKS`), which the extractor checks against its pack table, so the demo cards keep showing the Milestone 1 versions until that table and the sample move together. Every manifest has `engine_min_version` 1.1.0 (the pack format of Milestone 2 E.1; `ENGINE_MIN_VERSION` in `scripts/lib/pack-format.mjs`) and an empty `modules` list (the framework workbenches are deferred). A server refuses a pack whose engine version is newer than its own release; a release candidate such as 1.1.0-rc.1 reads the format of 1.1.0, and a server version that is not a version number (an image tag such as `smoke`) is not compared. The two ISO 9001 packs share their datasets, and so do the two ISO 37001 packs, because the sample has one system for each framework.

## Pack content (Milestone 2 E.2)

The content step is written in `content/<pack_id>/` and covers clauses 4 to 10 of each standard. Counts as `validate-sources.mjs --json` prints them (requirement rows in the standard, retired rows, documented information, document templates, management review inputs):

| Pack | Requirements | Retired | Leaf clause rows | Documented information | Templates | Review inputs | Assessable rows |
|---|---|---|---|---|---|---|---|
| `ISO27001-2022` | 34 | 10.3 | 30 | 15 | 25 | 10 | none (Annex A controls are assessed in the Statement of Applicability) |
| `ISO9001-2015` | 84 | none | 65 | 27 | 25 | 12 | 10 |
| `ISO9001-2026` | 84 | none | 65 | 27 | 25 | 13 | 10 |
| `ISO22301-2019` | 59 | 10.3 | 47 | 15 | 23 | 13 | none |
| `ISO37001-2016` | 50 | 6.3, 10.3 | 42 | 13 | 23 | 11 (one for the governing body review) | none |
| `ISO37001-2025` | 51 | 10.3 | 43 | 13 | 24 | 12 (one for the governing body review) | none |

What each content folder holds:

| File | Content |
|---|---|
| `requirements.csv` | Every requirement row of the pack, Milestone 1 rows included: sub-clauses with `parent_code`, clause 10 numbered as each standard numbers it (ISO/IEC 27001 and ISO 37001:2025: 10.1 Continual improvement, 10.2 Nonconformity and corrective action; ISO 22301 and ISO 37001:2016: 10.1 Nonconformity and corrective action, 10.2 Continual improvement; ISO 9001: 10.1 to 10.3), rows that left the standard kept with `retired` true, an evidence example on every leaf row, `documented_info_mandatory` on the rows that `documented_info.csv` names and on their parents, and `applicability_assessable` on the ten ISO 9001 rows that an organisation may declare not applicable (7.1.5.1, 7.1.5.2, 8.3.1 to 8.3.6, 8.5.3, 8.5.5) |
| `catalogue.csv` (ISO/IEC 27001) | The 93 Annex A controls, each linked to a clause (84 to 8.3; A.5.1 to 5.2, A.5.2 to 5.3, A.5.4 to 5.1, A.5.5 to 7.4, A.5.31 to 4.2, A.5.33 to 7.5.3, A.5.35 to 9.2, A.5.36 to 9.1, A.6.3 to 7.3) and each with an evidence example (the ten examples of the sample unchanged) |
| `documented_info.csv` | The documented information each clause asks the organisation to maintain or retain, with the template that answers it |
| `document_templates.csv` | One template per document code: every activity output code of the pack, the scope statement (`SCO-01` for ISO/IEC 27001, `SCO-Q01`, `SCO-B01` and `SCO-A01` for the other standards, H.9) and the templates the documented information names. Codes are unique per pack and match the demo's document codes where an activity of the demo produces that document; each system has its own policy code (`POL-01`, `QM-01`, `POL-B01`, `POL-A01`), and the information security risk assessment method is `PRC-04` because the demo's `PRC-05` is the asset handling procedure |
| `review_inputs.csv` | The management review inputs of clause 9.3 of the standard, all mandatory; ISO 37001 adds the governing body review (`review_kind` `governing_body`) |
| `cycle_requirements.csv` | The certification cycle items of the sample with a derivation for every item that has a data source in MSCD (risk assessment, internal audit, management review, corrective actions, metrics, document reviews, business impact analysis, exercises, due diligence); ISO 9001:2026 gets general titles for its internal audit and management review items, because no demo system is certified on that edition |
| `prep_tasks.csv` | Audit preparation tasks without demo facts (E.4); ISO 37001 gains its own tasks |
| `chain.csv` (ISO 37001) | Auditor questions in English and Indonesian and the clause at risk of every stage |
| `activities.csv` | The completion source of the objectives, training and risk treatment plan activities, in the expected outcome |
| `removed.csv` (ISO 9001:2026) | The edition transition phase 9 of the demo and its cycle item `EDITION_TRANSITION` (E.4) |

Activity titles and output codes come from the sample, so the demo and the packs agree: the scope and policy activities name the document of their system, the ISO/IEC 27001 activities 6.7 and 6.8 name the document types they approve, and the 13 output codes of ISO/IEC 27001 are `POL-01`, `PRC-04`, `SOA-01`, `PLN-01` (risk treatment plan), `SCO-01`, `PRC-07`, `PRC-08`, `PRC-11`, `PRC-13` and `IMS-01` to `IMS-04`.

The ISO 9001:2026 and ISO 37001:2025 trees are to confirm against the published text (H.6): until a lead auditor checks them, they follow the 2015 and 2016 trees, with the Harmonized Structure changes of the new editions (6.3 Planning of changes in ISO 37001:2025, the new review input on the needs and expectations of interested parties in both). The ISO 22301 tree counts the numbered paragraphs of 7.5.3 (7.5.3.1 and 7.5.3.2) as rows, as ISO 9001 does; whether 8.4.4 should be split into its numbered paragraphs is a question for the same check.

## Lead auditor sign-off

A pack version is released only with a sign-off row for that version (MILESTONE-2 E.2; the M2-18 release check). A lead auditor confirms the clause tree, the short titles, the documented information, the templates and the review inputs against the published standard, then adds the name and the date here.

| Pack | Version | Lead auditor | Date |
|---|---|---|---|
| `ISO27001-2022` | 1.3.0 | not signed yet | |
| `ISO9001-2015` | 1.5.0 | not signed yet | |
| `ISO9001-2026` | 0.10.0 | not signed yet | |
| `ISO22301-2019` | 1.1.0 | not signed yet | |
| `ISO37001-2016` | 1.1.0 | not signed yet | |
| `ISO37001-2025` | 0.7.0 | not signed yet | |

## Content rule: short titles only

Packs hold numbering, short titles and provider guidance only, never text of ISO standards (PRD 3.3, TS 4.1). Titles of clauses and sub-clauses are short paraphrased titles; evidence examples, documented information titles, template titles and review input titles are written for MSCD in plain English. The text written in `extract-from-sample.mjs` is limited to its tables: Indonesian labels, phase names and auditor questions, lookup labels, drift rule messages, risk profile labels, and the ISO 27001 audit activities and finding conditions below. The other packs carry only the header row of `audit_activities.csv` and `finding_conditions.csv`.

ISO 27001 audit activity templates (`audit_activities.csv`):

| Code | Event | Clause | Title | Auditee |
|---|---|---|---|---|
| `AA-S1-01` | Stage 1 | 4.3 | Review ISMS scope and context | ISMS Manager |
| `AA-S1-02` | Stage 1 | 6.1 | Review risk method and Statement of Applicability | ISMS Manager |
| `AA-S1-03` | Stage 1 | 9.2 | Confirm audit programme and management review plan | ISMS Manager |
| `AA-S2-01` | Stage 2 | 5.1 | Interview top management on leadership | Top Management |
| `AA-S2-02` | Stage 2 | 8.1 | Sample controls in operation | Domain Owner |
| `AA-S2-03` | Stage 2 | 10.2 | Follow up nonconformities and corrective actions | ISMS Manager |

ISO 27001 finding conditions (`finding_conditions.csv`):

| Code | Classification | Requirement | Text |
|---|---|---|---|
| `FC-01` | major | 8.2 | No information security risk assessment performed for the scope |
| `FC-02` | major | 9.2 | Internal audit programme not carried out within the cycle |
| `FC-03` | minor | 6.1 | Control decision in the Statement of Applicability without a risk-based justification |
| `FC-04` | minor | 7.5 | Controlled document used after its review date |
| `FC-05` | minor | 10.2 | Corrective action closed without an effectiveness check |
| `FC-06` | ofi | 9.1 | Performance metrics without target values |

## File format

- UTF-8 without a byte order mark, LF line endings, a final newline.
- CSV: a header row (also when a dataset is empty), then one row per record. A field is quoted when it holds a comma, a double quote or a line break, with inner quotes doubled (RFC 4180). Booleans are `true` or `false`; an empty field means null.
- JSON: pretty-printed with two spaces.
- `manifest.json` has every field of E.8 except `datasets`, which the pack builder fills with the checksums. There is no `signature` file in a source folder.

| File | Columns or shape | Source in the sample |
|---|---|---|
| `manifest.json` | `pack_id`, `pack_version`, `framework_code`, `framework_name`, `edition`, `status`, `pre_release`, `supersedes?`, `engine_min_version`, `modules`, `applicability_target`, `catalogue` | `MS[].code` (framework name), `MS[].unit`; versions as in the build plan (D-14), checked against `PACKS` |
| `requirements.csv` | `requirement_code, parent_code, title_short, clause_group, is_hs_common, documented_info_mandatory, applicability_assessable, default_frequency_code, evidence_example, sort_order, retired` | `buildReqs()` of the system; ISO 27001 uses the Harmonized Structure entries of the QMS list (clauses 4 to 7, 9 and 10) plus its clause 8 entries 8.1, 8.2 and 8.3. `retired` is false for every sample row. The content folder gives the full tree (see "Pack content") |
| `catalogue.csv` | `item_code, theme_code, title_short, requirement_code, default_frequency_code, evidence_example, sort_order, retired` | `buildReqs(isms)`: code, title, theme `A.5` to `A.8`, frequency; examples from `EXAMPLES`. `requirement_code` links an item to the clause it supports |
| `chain.csv` | `stage_key, position, label_en, label_id, question_en, question_id, source, entity_type, risk_profile_code, is_mandatory, clause_at_risk, overview_clause, gate_type_label_en, gate_type_label_id` | `STAGES`, `CLAUSE_AT_RISK` |
| `activities.csv` | `phase_no, phase_name_en, phase_name_id, is_gate_phase, activity_no, title, clause_ref, output_document_code, expected_outcome` | `PHASES`, `OUTPUT_MAP` |
| `frequencies.csv` | `code, label_en, label_id, period_days, sort_order` | `FREQ`, `FREQ_ORDER` |
| `labels.en.json`, `labels.id.json` | Flat key to text: `ms.name`, `ms.long_name`, `ms.manager_role`, `gate.name`, `applicability.artefact_name`, `risk.object_name`, `catalogue.theme.<n>` | `MS[].short`, `name`, `mgrRole`, `theme`; checkpoint names of the controller (`gateName`) |
| `cycle_requirements.csv` | `code, requirement_code, title, derivation, sort_order` | `CYCLE_ITEMS`. `derivation` is empty or a JSON object whose `kind` is one of `management_review_closed`, `risk_assessment_current` (with `months`), `internal_audit_done`, `exercise_performed`, `corrective_actions_closed`, `metrics_current`, `documents_reviewed_on_time`, `bia_approved`, `due_diligence_current` |
| `drift_rules.json` | Array of `{code, label_en, label_id, severity, source_stage, source_kind, predicate, message, sort_order}` | `DRIFT` |
| `prep_tasks.csv` | `code, title, days_before_audit, skip_on_first_audit, sort_order` | `PREP`, `MS[].audit.date` |
| `review_inputs.csv` | `code, title, mandatory, sort_order, review_kind` | Content folder only (`MR-nn`, `GB-nn`). `review_kind` is `management`, or `governing_body` for the governing body review of ISO 37001 |
| `finding_conditions.csv` | `code, classification, requirement_code, text` | ISO 27001 only, written for this build |
| `document_templates.csv` | `code, title, doc_type, requirement_code` | Content folder only. `requirement_code` names the clause the document answers |
| `documented_info.csv` | `code, requirement_code, kind, title, template_code, sort_order` | Content folder only (`DI-nn`). The documented information a clause asks for: `maintain` (a document) or `retain` (a record), with the template that answers it; a record without a template is answered by evidence |
| `audit_activities.csv` | `code, event_type, clause_ref, title, auditee_role, key_questions, evidence_to_request, sort_order` | ISO 27001 only, written for this build. `event_type` may also be `internal_audit` |
| `lookups.csv` | `domain, code, label_en, label_id, sort_order` | Document tiers of `DOCS` and `SHARED`, plus fixed lists |
| `rules.json` | Array of `{rule_id, active, params}` | Fixed list |
| `risk_profiles.json` | Array of `{code, definition}` | One profile per risk stage of the chain |
| `mappings/<target>.csv` | `source_code, target_pack_id, target_code, mapping_type, evidence_reusable, note` | None generated yet (the sample has no mappings) |

## Derivation rules

- Requirements are sorted by clause number segment by segment (8.2 before 8.10). In the sample extract, `is_hs_common` is true for the Harmonized Structure entries and for 8.1 Operational planning and control, `documented_info_mandatory` is true for the Harmonized Structure clauses that ask for documented information (4.3, 5.2, 6.2, 7.2, 8.1, 9.1, 9.2, 9.3, 10.2) and, in ISO 27001, for 6.1, 8.2 and 8.3, and `applicability_assessable` is true for ISO 9001 clause 8. The content folders replace every requirement row with the values of "Pack content".
- Chain stages without a sample `src` are entity stages: `context` uses `context_issue`, `risk`, `drisk` and `brisk` use `risk` (profiles `information_security`, `quality`, `disruption`, `bribery`), `treatment` and `action` use `risk_treatment`, `objective` uses `quality_objective`, `metric` uses `metric`, `product` uses `prioritized_activity`, `bia` uses `business_impact_analysis`, `exercise` uses `exercise`, `associate` uses `business_associate`. `src` `req`, `soa`, `doc` and `ev` give the sources `applicability`, `justification` (entity type `chain_record`), `document` and `evidence`. The overview clause is 4 for `context` and `brisk`, 6 for `risk`, `treatment`, `soa`, `action` and `objective`, 7 for `document`, 9 for `metric` and 8 otherwise. Checkpoint item type labels are those of the sample (`Risk`, `Treatment`, `SoA`, `BIA`); other stages leave them empty and show their stage key. Every stage is mandatory.
- An activity's output document is the first `OUTPUT_MAP` keyword found in its title (case-insensitive), as the sample computes it; the expected outcome is the sample's text "<title>: approved and recorded in the register". The sample gives no clause per activity, so `clause_ref` is empty.
- Cycle requirements use the sample clause as `requirement_code` (empty for `-`) and a code per kind (`RISK_ASSESSMENT`, `INTERNAL_AUDIT`, `MGMT_REVIEW`, `CORRECTIVE_ACTION` and others). The extract gives no derivation; the content folders add one per kind with a data source (`RISK_ASSESSMENT` `risk_assessment_current` with 12 months, `INTERNAL_AUDIT` `internal_audit_done`, `MGMT_REVIEW` `management_review_closed`, `CORRECTIVE_ACTION` `corrective_actions_closed`, `PERFORMANCE_EVALUATION` `metrics_current`, `DOCUMENT_REVIEW` `documents_reviewed_on_time`, `BIA` `bia_approved`, `EXERCISE_PROGRAMME` `exercise_performed`, `DUE_DILIGENCE` `due_diligence_current`). Titles stay those of the sample in the editions the demo seeds, because the demo seed links its cycle items to the definitions by title. ISO 9001:2026 is the exception: the demo QMS is certified on ISO 9001:2015, so the 2026 pack has general titles ("Internal audit covering all requirements", "Management review with all mandatory inputs") and no `EDITION_TRANSITION` item.
- Drift rules keep the sample ids as codes. `risk12` gets `source_kind` `stale_risk` with predicate `{"months": 12}`, `dd` gets `dd_expired`, `mr` and `csat` get `manual`, and the rules that the sample computes (`unverif`, `metric`, `exercise`, `nohash`) keep their kind. Severity: `unverif` is `crit`; `risk12`, `dd`, `mr` and `exercise` are `risk`; `metric`, `csat` and `nohash` are `warn`.
- Preparation tasks: `days_before_audit` is the next audit date minus the sample due date; tasks that close a named finding (for example "Close NC-2025-02 ...") are skipped on a system's first audit (BR-44). The content folders replace the titles that carry demo facts (finding codes, document versions, repository and site names) with general wording and keep the codes, days and flags; the demo keeps its own wording.
- Lookups: `doc_type` holds the seven document tiers of the register (Policy, Standard, Procedure, Plan, Register, Record, Form) and every pack has `treatment_option` (`modify`, `retain`, `avoid`, `share`). ISO 22301 adds `exercise_type` (`tabletop`, `walkthrough`, `simulation`, `full`); ISO 37001 adds `bribery_risk_level` (`low`, `medium`, `high`, `very_high`) and `due_diligence_subject` (`associate`, `position`, `transaction`, `project`).
- Rules: every pack activates BR-01, BR-03, BR-04, BR-06 to BR-17, BR-21 to BR-23, BR-29 to BR-32 and BR-34 to BR-50 (39 rules); ISO 27001 and ISO 37001 also activate BR-02. BR-03 carries the phrases that do not count as a justification, per language (`params.phrases.en`, `params.phrases.id`). Not activated: BR-05 and BR-18 (deferred), BR-19 and BR-20 (enforced by permissions), BR-24 (a database constraint), BR-25 to BR-28 (workbenches deferred) and BR-33 (raised by the platform's pack lifecycle job).
- Risk profiles hold labels, likelihood and consequence scales of 1 to 5 and impact dimensions (confidentiality, integrity and availability for information security) until the profile format is defined (specification question A-33).

## Validation

`validate-sources.mjs` checks, per pack folder: every file of the list above exists and nothing else does (apart from `mappings/*.csv`); UTF-8, LF and the final newline; CSV headers and field counts; JSON formatting; manifest fields, semantic versions, `pack_id` equal to the folder name and to `<framework_code>-<edition>`, `catalogue` consistent with `catalogue.csv`, no `datasets`; value types and the lengths of the `ref` columns; unique codes; retired rows (a row under a retired parent is retired too); references (catalogue items, documented information and document templates to requirements that are not retired, mapping sources to requirements or catalogue items that are not retired, finding conditions to requirement codes where given, requirement and catalogue frequencies, chain entity types in the record tables of C.10, risk profiles of risk stages, document template types in `doc_type`, drift rule stages, derivation kinds); contiguous chain positions, phase numbers and activity numbers; the lookup domains `doc_type` and `treatment_option`; a `management` review input when a pack has review inputs; the same label keys in both languages, including a theme label for every catalogue theme. It prints the dataset counts per pack and exits 1 on any error.

Content references must resolve as well: cycle requirement codes and chain `clause_at_risk` values name requirements of the pack (`clause_at_risk` is one or more clause codes joined by ` / `, each optionally followed by a list item such as `d)`), and activity `output_document_code` and documented information `template_code` values name document templates of the pack. They are errors, in the validator, in `mscd-pack build` and in the server's installer. The one exception was the Milestone 1 content, which named subclauses and documents the packs did not hold: in a version of a Milestone 1 pack below its content step that lists no documented information, they are warnings (the validator prints a count per pack, `--verbose` lists them, and `mscd-pack` prints them on stderr). Every pack in `sources/` is at its content step, so every reference resolves and the check is strict; a copy of a pack folder with one unknown `output_document_code` makes `validate-sources.mjs --dir <copy>` exit 1. The content step is fixed per pack, so an empty `documented_info.csv` in a later version does not turn the check off:

| Pack | Content references are errors from |
|---|---|
| ISO27001-2022 | 1.3.0 |
| ISO9001-2015 | 1.5.0 |
| ISO9001-2026 | 0.10.0 |
| ISO22301-2019 | 1.1.0 |
| ISO37001-2016 | 1.1.0 |
| ISO37001-2025 | 0.7.0 |

A pack that lists documented information, and every other pack, is checked strictly at any version. The table is `CONTENT_REFERENCES_STRICT_FROM` in `packs/scripts/lib/pack-format.mjs` and in `@mscd/pack-tools` (a pack-tools test keeps them equal).

`--json` prints, per pack: `requirements` (rows that are not retired), `retired`, `catalogue`, `catalogueRetired`, `catalogueLinked` (items with a clause), `documentedInfo`, `documentTemplates`, `reviewInputs`, `evidenceExamples` (rows in the standard with an example), `clauseEvidenceMissing` (leaf clause rows without an evidence example; a leaf row has no child row that is still in the standard), `unresolvedReferences` and the other dataset counts.
