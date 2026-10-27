// BR-23 with mappings that start at a catalogue item (Milestone 2 ref 0002, `source_catalogue_item_id`, M2-07): evidence
// that serves an Annex A control of the ISMS and a QMS requirement is not reusable when a mapping from that control to
// the requirement says so, in either direction; a reusable mapping or none at all gives no warning.
import { sql } from 'kysely';
import { beforeAll, describe, expect, it } from 'vitest';
import { crossSystemNonReusable } from '../../../src/modules/risk-registers/rules';
import { useTestDatabase } from '../../setup/test-db';
import { inOrg, rowsOf, systemOf } from './helpers';

describe('BR-23 with catalogue item mappings (M2-07)', () => {
  const db = useTestDatabase('demo');
  let evidenceId: string;
  let itemId: string;
  let requirementId: string;

  const check = () => inOrg(db, 'ndt', (trx) => crossSystemNonReusable(trx, evidenceId));

  beforeAll(async () => {
    const isms = await systemOf(db, 'ndt', 'isms');
    const qms = await systemOf(db, 'ndt', 'qms');
    const [control] = await rowsOf<{ evidence_id: string; catalogue_item_id: string }>(db, 'ndt', sql`
      select t.evidence_id, t.catalogue_item_id from evidence_target t
       where t.management_system_id = ${isms.id} and t.target_type = 'catalogue_item' and t.deleted_at is null
         and not exists (select 1 from evidence_target o where o.evidence_id = t.evidence_id and o.management_system_id <> t.management_system_id and o.deleted_at is null)
       order by t.created_at, t.id limit 1`);
    const [entry] = await rowsOf<{ id: string; requirement_id: string }>(db, 'ndt', sql`
      select id, requirement_id from applicability_entry
       where management_system_id = ${qms.id} and target_type = 'requirement' and deleted_at is null order by position, id limit 1`);
    [evidenceId, itemId, requirementId] = [control!.evidence_id, control!.catalogue_item_id, entry!.requirement_id];
    await inOrg(db, 'ndt', (trx) => sql`
      insert into evidence_target (evidence_id, management_system_id, applicability_entry_id, target_type, requirement_id)
      values (${evidenceId}, ${qms.id}, ${entry!.id}, 'requirement', ${requirementId})`.execute(trx));
  });

  it('gives no warning without a mapping between the two targets', async () => {
    expect(await check()).toBe(false);
  });

  it('warns when a mapping from the control to the requirement marks the evidence not reusable', async () => {
    await inOrg(db, 'ndt', (trx) => sql`
      insert into ref.requirement_mapping (source_catalogue_item_id, target_requirement_id, mapping_type, evidence_reusable, note)
      values (${itemId}, ${requirementId}, 'related', false, 'M2-07 test mapping')`.execute(trx));
    expect(await check()).toBe(true);
  });

  it('gives no warning when that mapping allows reuse', async () => {
    await inOrg(db, 'ndt', (trx) => sql`update ref.requirement_mapping set evidence_reusable = true where note = 'M2-07 test mapping'`.execute(trx));
    expect(await check()).toBe(false);
    await inOrg(db, 'ndt', (trx) => sql`delete from ref.requirement_mapping where note = 'M2-07 test mapping'`.execute(trx));
  });
});
