// Auditor independence (Milestone 2 D.2, J.6 warning `AUD-INDEP`, M2-05), registered with `@BusinessRule` for the
// global `RuleEngine` in the internal audit sub-module: an audit activity whose auditor owns an applicability entry of
// the activity's target (the clause or control code, with its sub-clauses), a document that implements such an entry,
// or evidence linked to it, is saved with a warning, because an auditor should not audit their own work (ISO 19011,
// ISO/IEC 27001 9.2.2). It is a platform warning rule, so it is active for every system.
import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { BusinessRule, type BusinessRuleHandler, type RuleCheck, type RuleViolation } from '../rules';

export interface AudIndepInput {
  auditorUserId: string;
  /** Display name of the auditor (the warning names them). */
  auditorName: string;
  targetCode: string;
}

@Injectable()
@BusinessRule('AUD-INDEP', { severity: 'warning' })
export class AudIndepRule implements BusinessRuleHandler<AudIndepInput> {
  async check({ trx, msId, input }: RuleCheck<AudIndepInput>): Promise<RuleViolation | null> {
    const { rows } = await sql<{ owns: boolean }>`
      with target_entries as (
        select e.id, e.owner_user_id from applicability_entry e
          left join ref.catalogue_item ci on ci.id = e.catalogue_item_id
          left join ref.requirement rq on rq.id = e.requirement_id
         where e.management_system_id = ${msId} and e.deleted_at is null
           and (ci.item_code = ${input.targetCode} or rq.requirement_code = ${input.targetCode}
                or starts_with(rq.requirement_code, ${`${input.targetCode}.`})))
      select (
        exists (select 1 from target_entries t where t.owner_user_id = ${input.auditorUserId})
        or exists (select 1 from target_entries t
                     join applicability_entry_document ad on ad.applicability_entry_id = t.id and ad.deleted_at is null
                     join document d on d.id = ad.document_id and d.deleted_at is null
                    where d.owner_user_id = ${input.auditorUserId})
        or exists (select 1 from target_entries t
                     join evidence_target et on et.applicability_entry_id = t.id and et.deleted_at is null
                     join evidence ev on ev.id = et.evidence_id and ev.deleted_at is null
                    where ev.owner_user_id = ${input.auditorUserId})
      ) as owns`.execute(trx);
    return rows[0]?.owns ? { vars: { auditor: input.auditorName, target: input.targetCode } } : null;
  }
}
