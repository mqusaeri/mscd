// Milestone 3 records of the demo seed (MILESTONE-3 E, M3-10), written at the end of `writeOrganisation` in the
// organisation's transaction:
//
// - Records of the new personas that are no chain items, so the sample counts stay (the sample build has the chain
//   items, document approvals and cycle requirements of mscd-data.js): the Risk Owner `ratna` owns ready risks of the
//   ISMS and the BCMS with a residual risk acceptance, and the Compliance Investigator `gilang` owns an open signal
//   about an investigation in the ABMS.
// - The routines of Milestone 3 in RS Medika Nusantara (`rmn`), so the new screens have content: the Programme Owner
//   `wulan` owns the planned ISMS management review, the Information Security Policy waits for read confirmation by
//   the Programme Owner and the Risk Owner (D.7), the evidence files of the ISMS have a set retention period and one
//   file is due for review (D.8), and an access review is open (D.9). The integration suites of M3-05 to M3-07 and the
//   job parity tests work in `ndt` and `tst` and expect no such record there, so the routines stay out of both.
//
// The read confirmation request and the access review are opened through the services of their modules, so their
// rows, tasks and notifications are exactly what the application writes; their audit entries are left out, as for
// every other record the seed writes, and no email is queued.
import { sql } from 'kysely';
import { Clock } from '../common/clock';
import { addDays, startOfLocalDay } from '../common/dates';
import { SYSTEM_USER_ID, type AuditWriter, type NotificationInput, type NotificationWriter, type RecordedAuditEntry, type Trx } from '../common/tokens';
import { AccessReviewOpenService } from '../modules/access-reviews/access-review-open.service';
import { AcknowledgementService } from '../modules/acknowledgements/acknowledgement.service';
import { addMonths } from '../modules/retention/retention-model';
import type { DemoOrg } from './people';
import { RISK_OWNER_SYSTEMS } from './people';

/** The organisation that shows the Milestone 3 routines (read confirmation, retention, access review). */
export const ROUTINES_ORG = 'rmn';

/** Ready risks the Risk Owner owns per system (MILESTONE-3 E). */
const RISKS_PER_SYSTEM = 3;

/** The retention period of the ISMS evidence files in the routines organisation, and its basis. */
export const DEMO_RETENTION = {
  recordClass: 'evidence_file',
  months: 12,
  basis: 'Access logs are kept for one year after they are withdrawn (records schedule RS-04)',
} as const;

/** The evidence record withdrawn from the ISMS whose file is due for a retention review. */
export const DEMO_RETIRED_EVIDENCE = {
  code: 'EV-0090',
  title: 'Badge access log of the former server room',
  versionLabel: 'v1.0',
  fileName: 'EV-0090 badge access log.pdf',
  owner: 'bagus',
  control: 'A.7.2',
  /** Months before today that the record was withdrawn (its file then waits 12 months, so it is due 2 months ago). */
  withdrawnMonthsAgo: 14,
} as const;

/** The ISMS management review the Programme Owner owns. */
export const DEMO_MANAGEMENT_REVIEW = { code: 'MR-2026', title: 'ISMS management review 2026', owner: 'wulan', inDays: 27 } as const;

/** The policy that waits for read confirmation, and who is asked. */
export const DEMO_READ_CONFIRMATION = { document: 'POL-01', roles: ['programme_owner', 'risk_owner'] as const, dueDays: 14, openedDaysAgo: 3 } as const;

/** The signal about an investigation in the ABMS. */
export const DEMO_INVESTIGATION = {
  code: 'INV-2026-01',
  title: 'Gift to a procurement officer reported through the concern channel; investigation not concluded',
  clause: '8.10',
  note: 'Interviews with the supplier and the buyer are planned; the gift register entry is being checked',
  raisedDaysAgo: 12,
} as const;

export interface Milestone3SeedInput {
  org: DemoOrg;
  schema: string;
  timeZone: string;
  today: string;
  now: Date;
  /** User id of a handle that is a member of the organisation, else null. */
  memberId: (handle: string) => string | null;
  /** `management_system.id` per system slug. */
  msIds: ReadonlyMap<string, string>;
  /** `storage_repository.id` per repository slug. */
  repoIds: ReadonlyMap<string, string>;
}

export interface Milestone3SeedSummary {
  riskOwnerRisks: number;
  residualAcceptances: number;
  investigations: number;
  routines: boolean;
}

/** Notifications of the seed: the row only (members only, as the application writes them); no email is queued. */
class SeedNotificationWriter implements NotificationWriter {
  async create(trx: Trx, input: NotificationInput): Promise<string | null> {
    const pair = (value: NotificationInput['title']) => (Array.isArray(value) ? { en: value[0], id: value[1] } : { en: value.en, id: value.id });
    const title = pair(input.title);
    const body = pair(input.body);
    const { rows } = await sql<{ id: string }>`
      insert into notification (recipient_user_id, management_system_id, kind, title_en, title_id, body_en, body_id, entity_ref, digest, created_by, updated_by)
      select ${input.recipientUserId}, ${input.msId ?? null}, ${input.kind}, ${title.en}, ${title.id}, ${body.en}, ${body.id},
             ${input.ref ? JSON.stringify(input.ref) : null}::jsonb, ${input.digest ?? false}, ${input.createdBy ?? null}, ${input.createdBy ?? null}
       where exists (select 1 from platform.org_membership m
                      where m.user_id = ${input.recipientUserId} and m.organization_id = nullif(current_setting('app.org_id', true), '')::uuid
                        and m.status = 'active' and m.deleted_at is null)
      returning id`.execute(trx);
    return rows[0]?.id ?? null;
  }
}

/** The seed writes no audit entry for the records it creates (G.6). */
const NO_AUDIT: AuditWriter = {
  record: async (): Promise<RecordedAuditEntry> => ({ chain: 'tenant', id: '', seq: '0' }),
  recordDetached: async (): Promise<RecordedAuditEntry> => ({ chain: 'tenant', id: '', seq: '0' }),
};

/** A clock whose `now()` is the seed's instant (the access review snapshot compares role end dates with it). */
function seedClock(now: Date): Clock {
  const clock = Object.create(Clock.prototype) as Clock;
  clock.now = () => new Date(now.getTime());
  return clock;
}

export async function writeMilestone3Records(trx: Trx, input: Milestone3SeedInput): Promise<Milestone3SeedSummary> {
  // The module services read unqualified tenant tables, as in a request transaction (D-03).
  await sql`select set_config('search_path', ${`"${input.schema}", ext`}, true)`.execute(trx);
  const summary: Milestone3SeedSummary = { riskOwnerRisks: 0, residualAcceptances: 0, investigations: 0, routines: false };

  const ratna = input.memberId('ratna');
  if (ratna) {
    for (const system of RISK_OWNER_SYSTEMS) {
      const msId = input.msIds.get(system);
      if (!msId) continue;
      const result = await riskOwnerRecords(trx, input, msId, ratna, system === 'isms');
      summary.riskOwnerRisks += result.risks;
      summary.residualAcceptances += result.accepted;
    }
  }
  const gilang = input.memberId('gilang');
  const abms = input.msIds.get('abms');
  if (gilang && abms) summary.investigations += await investigation(trx, input, abms, gilang);

  if (input.org.slug === ROUTINES_ORG) {
    await routines(trx, input);
    summary.routines = true;
  }
  return summary;
}

/**
 * The Risk Owner owns ready risks of the system (no pending action, not listed by a regression rule), those with an
 * implemented treatment first; in the ISMS she accepted the residual risk of the first of them after its treatment
 * was implemented by someone else (BR-04).
 */
async function riskOwnerRecords(trx: Trx, input: Milestone3SeedInput, msId: string, ratna: string, accept: boolean): Promise<{ risks: number; accepted: number }> {
  const { rows } = await sql<{ id: string; treatment_id: string | null; implemented_by: string | null }>`
    select r.id, t.id as treatment_id, t.implemented_by_user_id as implemented_by
      from risk r
      join entity_ms_link l on l.entity_type = 'risk' and l.entity_id = r.id and l.management_system_id = ${msId} and l.is_primary and l.deleted_at is null
      left join lateral (select t.id, t.implemented_by_user_id from risk_treatment t
                          where t.risk_id = r.id and t.status = 'implemented' and t.deleted_at is null
                          order by t.position, t.code limit 1) t on true
     where r.pending_action is null and r.deleted_at is null
       and not exists (select 1 from drift_result d where d.entity_type = 'risk' and d.entity_id = r.id and d.deleted_at is null)
     order by (t.id is not null) desc, r.position, r.code
     limit ${RISKS_PER_SYSTEM}`.execute(trx);
  if (rows.length === 0) return { risks: 0, accepted: 0 };
  await sql`update risk set owner_user_id = ${ratna}, updated_by = ${ratna} where id = any(${rows.map((r) => r.id)}::uuid[])`.execute(trx);

  const treated = accept ? rows.find((r) => r.treatment_id && r.implemented_by && r.implemented_by !== ratna) : undefined;
  if (!treated) return { risks: rows.length, accepted: 0 };
  const acceptedOn = addDays(input.today, -20);
  const [likelihood, consequence] = [2, 2];
  await sql`
    insert into residual_acceptance (risk_id, risk_treatment_id, accepted_by_user_id, implemented_by_user_id, accepted_at, residual_score, note, created_by, updated_by)
    values (${treated.id}, ${treated.treatment_id}, ${ratna}, ${treated.implemented_by}, ${acceptedOn}::date, ${likelihood * consequence},
            ${'Residual risk is within appetite after the treatment was implemented and tested'}, ${ratna}, ${ratna})`.execute(trx);
  await sql`update risk_treatment set status = 'residual_accepted', pending_action = null, updated_by = ${ratna} where id = ${treated.treatment_id}`.execute(trx);
  await sql`update risk set residual_likelihood = ${likelihood}, residual_consequence = ${consequence}, residual_accepted_at = ${acceptedOn}::date
             where id = ${treated.id}`.execute(trx);
  return { risks: rows.length, accepted: 1 };
}

/** An open signal in the ABMS about an investigation, owned by the Compliance Investigator (classification signal). */
async function investigation(trx: Trx, input: Milestone3SeedInput, msId: string, gilang: string): Promise<number> {
  await sql`
    insert into finding (management_system_id, framework_version_id, code, title, classification, clause_ref, source, status, status_note,
                         owner_user_id, raised_at, position, created_by, updated_by)
    select m.id, m.framework_version_id, ${DEMO_INVESTIGATION.code}, ${DEMO_INVESTIGATION.title}, 'signal', ${DEMO_INVESTIGATION.clause}, 'other',
           'in_progress', ${DEMO_INVESTIGATION.note}, ${gilang}, ${addDays(input.today, -DEMO_INVESTIGATION.raisedDaysAgo)}::date,
           (select coalesce(max(f.position) + 1, 0) from finding f where f.management_system_id = m.id), ${gilang}, ${gilang}
      from management_system m where m.id = ${msId}`.execute(trx);
  return 1;
}

/** The Milestone 3 routines of the routines organisation (its ISMS, run by rina). */
async function routines(trx: Trx, input: Milestone3SeedInput): Promise<void> {
  const isms = input.msIds.get('isms');
  const rina = input.memberId('rina');
  const wulan = input.memberId('wulan');
  const owner = input.memberId(DEMO_RETIRED_EVIDENCE.owner);
  const sharePoint = input.repoIds.get('sp');
  if (!isms || !rina || !wulan || !owner || !sharePoint) {
    throw new Error(`Organisation ${input.org.slug}: the Milestone 3 routines need the ISMS, rina, wulan, ${DEMO_RETIRED_EVIDENCE.owner} and the SharePoint repository`);
  }
  const notifications = new SeedNotificationWriter();
  const localInstant = (date: string, hour = 9) => new Date(startOfLocalDay(date, input.timeZone).getTime() + hour * 3_600_000);

  // The planned ISMS management review of the Programme Owner, with one empty input per mandatory input (BR-13).
  const { rows: review } = await sql<{ id: string }>`
    insert into management_review (code, title, owner_user_id, planned_at, status, created_by, updated_by)
    values (${DEMO_MANAGEMENT_REVIEW.code}, ${DEMO_MANAGEMENT_REVIEW.title}, ${wulan}, ${addDays(input.today, DEMO_MANAGEMENT_REVIEW.inDays)}::date, 'planned', ${rina}, ${rina})
    returning id`.execute(trx);
  await sql`insert into entity_ms_link (entity_type, entity_id, management_system_id, is_primary, created_by, updated_by)
            values ('management_review', ${review[0]!.id}, ${isms}, true, ${rina}, ${rina})`.execute(trx);
  await sql`
    insert into management_review_input (management_review_id, review_input_def_id, management_system_id, created_by, updated_by)
    select ${review[0]!.id}, d.id, m.id, ${rina}, ${rina}
      from management_system m join ref.review_input_def d on d.framework_version_id = m.framework_version_id and d.mandatory
     where m.id = ${isms}`.execute(trx);

  // The current approved version of the Information Security Policy waits for read confirmation (D.7).
  const { rows: policy } = await sql<{ id: string; code: string; title: string; is_org_wide: boolean; version_id: string; version_label: string }>`
    select d.id, d.doc_code as code, d.title, d.is_org_wide, v.id as version_id, v.version_label
      from document d join document_version v on v.id = d.current_version_id
     where d.doc_code = ${DEMO_READ_CONFIRMATION.document} and d.deleted_at is null and v.status = 'approved'`.execute(trx);
  if (!policy[0]) throw new Error(`Organisation ${input.org.slug}: ${DEMO_READ_CONFIRMATION.document} has no approved current version`);
  const doc = policy[0];
  const opened = await new AcknowledgementService(NO_AUDIT, notifications).openRequest(
    trx,
    {
      actorId: rina,
      today: addDays(input.today, -DEMO_READ_CONFIRMATION.openedDaysAgo),
      document: { id: doc.id, code: doc.code, title: doc.title, isOrgWide: doc.is_org_wide },
      version: { id: doc.version_id, label: doc.version_label },
      scope: 'roles',
      roles: [...DEMO_READ_CONFIRMATION.roles],
      dueDays: DEMO_READ_CONFIRMATION.dueDays,
    },
    { emptyAudience: 'refuse' },
  );
  if (opened) {
    const at = localInstant(addDays(input.today, -DEMO_READ_CONFIRMATION.openedDaysAgo));
    await sql`update acknowledgement_request set created_at = ${at}, updated_at = ${at} where id = ${opened.id}`.execute(trx);
    await sql`update acknowledgement set created_at = ${at}, updated_at = ${at} where acknowledgement_request_id = ${opened.id}`.execute(trx);
  }

  // Retention (D.8): ISMS evidence files are kept 12 months; the file of a withdrawn evidence record is due for review.
  await sql`
    insert into retention_rule (management_system_id, record_class, doc_type, retain_months, basis, created_by, updated_by)
    values (${isms}, ${DEMO_RETENTION.recordClass}, null, ${DEMO_RETENTION.months}, ${DEMO_RETENTION.basis}, ${rina}, ${rina})`.execute(trx);
  const withdrawnOn = addMonths(input.today, -DEMO_RETIRED_EVIDENCE.withdrawnMonthsAgo);
  const withdrawnAt = localInstant(withdrawnOn, 10);
  const { rows: object } = await sql<{ id: string }>`
    insert into storage_object (storage_repository_id, external_item_id, external_version_id, version_label, display_name, mime_type, size_bytes,
                                hash_algorithm, hash_value, hash_source, provider_created_at, provider_modified_at, folder_path,
                                link_status, link_status_since, last_verified_at, last_good_check_at, created_by, updated_by)
    values (${sharePoint}, ${`demo-sp-${DEMO_RETIRED_EVIDENCE.code}`}, '1.0', ${DEMO_RETIRED_EVIDENCE.versionLabel}, ${DEMO_RETIRED_EVIDENCE.fileName},
            'application/pdf', 2048, 'quickxor', 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=', 'provider', ${localInstant(addMonths(withdrawnOn, -12))}, ${localInstant(addMonths(withdrawnOn, -1))},
            'Compliance / ISMS / Evidence / Archive', 'intact', ${withdrawnAt}, ${withdrawnAt}, ${withdrawnAt}, ${owner}, ${owner})
    returning id`.execute(trx);
  const { rows: entry } = await sql<{ id: string; target_type: 'catalogue_item' | 'requirement'; catalogue_item_id: string | null; requirement_id: string | null }>`
    select a.id, a.target_type, a.catalogue_item_id, a.requirement_id
      from applicability_entry a join ref.catalogue_item c on c.id = a.catalogue_item_id
     where a.management_system_id = ${isms} and c.item_code = ${DEMO_RETIRED_EVIDENCE.control} and a.deleted_at is null`.execute(trx);
  if (!entry[0]) throw new Error(`Organisation ${input.org.slug}: the ISMS has no applicability entry ${DEMO_RETIRED_EVIDENCE.control}`);
  const { rows: evidence } = await sql<{ id: string }>`
    insert into evidence (evidence_code, title, owner_user_id, produced_at, storage_object_id, frequency_code, classification, file_sequence, position,
                          deleted_at, created_by, updated_by)
    values (${DEMO_RETIRED_EVIDENCE.code}, ${DEMO_RETIRED_EVIDENCE.title}, ${owner}, ${addMonths(withdrawnOn, -1)}::date, ${object[0]!.id},
            (select e.frequency_code from evidence e join evidence_target t on t.evidence_id = e.id where t.management_system_id = ${isms} order by e.position limit 1),
            'internal', 10, (select coalesce(max(position) + 1, 0) from evidence), ${withdrawnAt}, ${owner}, ${owner})
    returning id`.execute(trx);
  await sql`
    insert into evidence_target (evidence_id, management_system_id, applicability_entry_id, target_type, catalogue_item_id, requirement_id, position, deleted_at, created_by, updated_by)
    values (${evidence[0]!.id}, ${isms}, ${entry[0].id}, ${entry[0].target_type}, ${entry[0].catalogue_item_id}, ${entry[0].requirement_id}, 0, ${withdrawnAt}, ${owner}, ${owner})`.execute(trx);
  // A withdrawn record keeps its system link, as records.delete leaves it (every entity keeps one primary system, A-29).
  await sql`
    insert into entity_ms_link (entity_type, entity_id, management_system_id, is_primary, created_by, updated_by)
    values ('evidence', ${evidence[0]!.id}, ${isms}, true, ${owner}, ${owner})`.execute(trx);
  // The review the daily `retention.review` job opened on the day the period ended (the seed runs no job).
  await sql`
    insert into retention_review (management_system_id, record_class, item_id, item_code, item_title, retention_ends_on, status, created_at, updated_at,
                                  created_by, updated_by)
    values (${isms}, ${DEMO_RETENTION.recordClass}, ${object[0]!.id}, ${`${DEMO_RETIRED_EVIDENCE.code} ${DEMO_RETIRED_EVIDENCE.versionLabel}`},
            ${DEMO_RETIRED_EVIDENCE.title}, ${addMonths(withdrawnOn, DEMO_RETENTION.months)}::date, 'open',
            ${localInstant(addMonths(withdrawnOn, DEMO_RETENTION.months), 3)}, ${localInstant(addMonths(withdrawnOn, DEMO_RETENTION.months), 3)},
            ${SYSTEM_USER_ID}, ${SYSTEM_USER_ID})`.execute(trx);

  // An access review opened today by the Tenant Admin (D.9): the organisation part and the ISMS part, their snapshot,
  // the task of the ISMS manager and the notices to the reviewers.
  const org = { id: input.org.id, timeZone: input.timeZone };
  await new AccessReviewOpenService(seedClock(input.now), NO_AUDIT, notifications).open(trx, org, input.today, rina);
}
