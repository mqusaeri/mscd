// Phase confirmation (build plan D.3, BR-12, WP-30 review finding): `POST /ms/{ms}/phases/{n}/verify` writes one
// `phase.verified` per change of the phase. Only a status change of one of its activities asks for a new
// confirmation; an edit that keeps every status (a reassignment) leaves the earlier one standing, and the command
// answers "Phase n is already verified" with nothing changed.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { createFullApp, demoSession, msIdOf, rowsIn, inOrg, userIdOf, type Client, type FullApp } from '../contract/harness';

const ALREADY = ['Phase 3 is already verified', 'Fase 3 sudah terverifikasi'];
const VERIFIED = ['Phase 3 verified', 'Fase 3 terverifikasi'];

describe('phase confirmation after edits that keep the status', () => {
  const db = useTestDatabase('demo');
  let full: FullApp;
  let rina: Client;

  const confirmations = async () =>
    (await rowsIn<{ n: number }>(db, 'tst', sql`select count(*)::int as n from audit_trail where action = 'phase.verified' and entity_code = '3'`))[0]!.n;

  beforeAll(async () => {
    full = await createFullApp(db);
    rina = await demoSession(full, db, 'rina', 'tst');
  });

  afterAll(async () => {
    await full?.close();
  });

  it('keeps the confirmation after a reassignment of one of the phase activities', async () => {
    const msId = await msIdOf(db, 'tst', 'isms');
    const bagus = await userIdOf(db, 'bagus');
    const [act] = await rowsIn<{ id: string }>(db, 'tst', sql`
      select id from implementation_activity_progress
       where management_system_id = ${msId} and phase_no = 3 and deleted_at is null order by activity_no limit 1`);
    // Fixture: the first activity of phase 3 completed by its owner, so the manager may verify it (VERIFY-SELF).
    await inOrg(db, 'tst', async (trx) => {
      await sql`update implementation_activity_progress
                   set status = 'complete', owner_user_id = ${bagus}, completed_by_user_id = ${bagus}, completed_at = current_date,
                       verified_by_user_id = null, verified_at = null
                 where id = ${act!.id}`.execute(trx);
    });
    const verify = await rina.post(`/api/v1/ms/isms/activities/${act!.id}/transitions`, { to: 'verified' });
    expect(verify.status, verify.text).toBe(200);
    const first = await rina.post('/api/v1/ms/isms/phases/3/verify');
    expect(first.body).toMatchObject({ ok: true, changed: [], message: VERIFIED });
    expect(await confirmations()).toBe(1);

    // A reassignment writes an audit entry about the activity but changes no status.
    const reassign = await rina.post(`/api/v1/ms/isms/records/implementation_activity_progress/${act!.id}/assignment`, { kind: 'act', holder: 'hendra', dueAt: null });
    expect(reassign.status, reassign.text).toBe(200);
    const [entry] = await rowsIn<{ action: string }>(db, 'tst', sql`
      select action from audit_trail where entity_id = ${act!.id} order by seq desc limit 1`);
    expect(entry!.action).not.toBe('activity.transition');
    const again = await rina.post('/api/v1/ms/isms/phases/3/verify');
    expect(again.body).toMatchObject({ ok: true, changed: [], message: ALREADY });
    expect(await confirmations()).toBe(1);
  });
});
