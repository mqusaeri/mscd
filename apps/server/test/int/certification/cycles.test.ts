// Certification lifecycle (Milestone 2 D.4, J.8, M2-05) on copies of the demo organisations: the first stage1 event
// activates the planned cycle of a seeded system and copies its cycle items; a system without an open cycle gets one
// new active cycle from its first stage1 event or from "Start certification cycle"; a second open cycle is refused;
// a recertification event on a certified system opens the next cycle next to the certified one, and its certificate
// closes the old cycle; `ms.certification` is refused without a recommending stage2 or recertification outcome and
// accepted with one, sets the cycle and the system to certified, audits `ms.certified` and moves the certificate
// label; every manual move of J.8 (suspend, reinstate, withdraw, close an active cycle) with a reason, refused without
// one and for any other move, and with a stale If-Match (R-18); the cycles list with the ETag of each cycle; the seeded certificate dates; `certificate.expiry` with a fixed clock
// (notices 90, 30 and 7 days ahead to MS Managers and Programme Owners, once each, and the lapse to expired).
import { CertificationCycleItem, CommandResult, type UiOrgSnapshot } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { certificateLabel, threeYearsAfter } from '../../../src/modules/management-systems/certification.cycles';
import { expiryTier } from '../../../src/modules/management-systems/certification.expiry';
import { demoCertificateExpiry } from '../../../src/seed/org-writer';
import { useTestDatabase } from '../../setup/test-db';
import {
  auditOf, createCertApp, cycleItemsIn, cyclesOf, defCodesOf, inOrg, notificationsOf, rowsOf, sessionFor, systemOf, TODAY, verifyChain,
  type CertApp, type Client,
} from './helpers';

const CYCLES = (ms: string) => `/api/v1/ms/${ms}/certification-cycles`;
const CERTIFY = (ms: string) => `/api/v1/ms/${ms}/certification`;
const EVENTS = (ms: string) => `/api/v1/ms/${ms}/audit-events`;
const event = (eventType: string, label: string, scheduledAt: string) => ({ eventType, nameEn: `${label} audit`, nameId: `Audit ${label}`, shortLabel: label, scheduledAt });

describe('certification lifecycle (Milestone 2 D.4)', () => {
  const db = useTestDatabase('demo');
  let ctx: CertApp;
  let rina: Client;
  let bagus: Client;
  let maya: Client;
  let rinaRmn: Client;
  let rinaTst: Client;

  beforeAll(async () => {
    ctx = await createCertApp(db);
    rina = await sessionFor(ctx, db, 'rina', 'ndt');
    bagus = await sessionFor(ctx, db, 'bagus', 'ndt');
    maya = await sessionFor(ctx, db, 'maya', 'ndt');
    rinaRmn = await sessionFor(ctx, db, 'rina', 'rmn');
    rinaTst = await sessionFor(ctx, db, 'rina', 'tst');
  });
  afterAll(async () => {
    ctx?.setToday(null);
    await ctx?.close();
  });

  const certLabel = async (client: Client, ms: string) =>
    (await client.get<UiOrgSnapshot>('/api/v1/ui/org')).body.MS.find((m) => m.id === ms)!.cert;
  const eventId = async (org: 'ndt' | 'rmn' | 'tst', ms: string, label: string) =>
    (await rowsOf<{ id: string }>(db, org, sql`select e.id from audit_event e join management_system m on m.id = e.management_system_id and m.slug = ${ms}
                                                where e.short_label = ${label} and e.deleted_at is null`))[0]!.id;

  describe('seeded certificates', () => {
    it('keep the sample labels: the label of each certified cycle equals the stored label, with an expiry after the demo date', async () => {
      for (const org of ['ndt', 'bsd', 'rmn', 'tst'] as const) {
        const rows = await rowsOf<{ slug: string; display: { certLabel?: unknown }; status: string; certified_at: string | null; certificate_expires_at: string | null; cycle_start: string; cycle_end: string; certification_body: string | null }>(
          db,
          org,
          sql`select m.slug, m.display, c.status, c.certified_at, c.certificate_expires_at::text, c.cycle_start, c.cycle_end, c.certification_body
                from certification_cycle c join management_system m on m.id = c.management_system_id where c.status = 'certified'`,
        );
        for (const row of rows) {
          expect(certificateLabel(row as Parameters<typeof certificateLabel>[0]), `${org}/${row.slug}`).toEqual(row.display.certLabel);
          expect(row.certificate_expires_at! > TODAY, `${org}/${row.slug}`).toBe(true);
          expect(row.certification_body).not.toBeNull();
        }
      }
      const [isms] = await cyclesOf(db, 'ndt', 'isms');
      expect(isms).toMatchObject({ status: 'certified', certified_at: '2025-03-14', certificate_expires_at: '2028-03-13', certification_body: 'PT Sertifikasi Nusantara' });
      // The sample QMS certificate of 2023: extended to the end of 2026, which keeps "cycle 2023–2026".
      expect((await cyclesOf(db, 'ndt', 'qms'))[0]).toMatchObject({ status: 'certified', certificate_expires_at: '2026-12-31' });
      expect(demoCertificateExpiry('2026-06-22', TODAY)).toBe('2026-12-31');
      expect(demoCertificateExpiry('2028-03-14', TODAY)).toBe('2028-03-13');
      expect(demoCertificateExpiry('2026-06-22', '2026-11-01')).toBe('2027-11-01');
      // Non-certified systems keep a planned cycle; nothing in the demo changes on the demo date.
      expect((await cyclesOf(db, 'ndt', 'bcms')).map((c) => c.status)).toEqual(['planned']);
      expect((await ctx.expiry('ndt'))).toMatchObject({ today: TODAY, notified: 0, expired: [] });
    });

    it('lists the cycles of a system newest first with dates, certificate, events and items (ms.read)', async () => {
      const list = await maya.get<CertificationCycleItem[]>(CYCLES('isms'));
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(1);
      expect(CertificationCycleItem.array().safeParse(list.body).success).toBe(true);
      expect(list.body[0]).toMatchObject({
        status: 'certified', cycleStart: '2025-03-14', certifiedAt: '2025-03-14', certificateExpiresAt: '2028-03-13', certificationBody: 'PT Sertifikasi Nusantara',
      });
      expect(list.body[0]!.events.map((e) => e.eventType)).toEqual(['stage1', 'stage2', 'surveillance', 'surveillance', 'recertification']);
      expect(list.body[0]!.events[0]).toMatchObject({ scopeText: null, reportDocumentId: null });
      expect(list.body[0]!.items.total).toBeGreaterThan(0);
      expect(list.body[0]!.etag).toMatch(/^W\/"\d+"$/);
      expect((await bagus.get(CYCLES('nope'))).status).toBe(404);
    });
  });

  describe('cycle creation', () => {
    it('activates the planned cycle of a seeded system with its first stage1 event and copies the missing cycle items', async () => {
      const bcms = await systemOf(db, 'ndt', 'bcms');
      const [planned] = await cyclesOf(db, 'ndt', 'bcms');
      const before = await cycleItemsIn(db, 'ndt', planned!.id);
      const created = await rina.post(EVENTS('bcms'), event('stage1', 'Stage 1 (moved)', '2027-01-20'));
      expect(created.status).toBe(201);
      expect(CommandResult.safeParse(created.body).success).toBe(true);
      expect(created.body.message?.[0]).toMatch(/planned certification cycle is now active/);
      const cycles = await cyclesOf(db, 'ndt', 'bcms');
      expect(cycles).toHaveLength(1);
      // Activation keeps the planned dates (D.4).
      expect(cycles[0]).toMatchObject({ id: planned!.id, status: 'active', cycle_start: planned!.cycle_start, cycle_end: planned!.cycle_end });
      const items = await cycleItemsIn(db, 'ndt', planned!.id);
      const defs = await defCodesOf(db, bcms.editionId);
      expect(new Set(items.map((i) => i.def_code).filter(Boolean))).toEqual(new Set(defs));
      expect(items.length).toBeGreaterThanOrEqual(before.length);
      // The new event belongs to the cycle.
      const [linked] = await rowsOf<{ certification_cycle_id: string }>(db, 'ndt', sql`select certification_cycle_id from audit_event where id = ${created.body.ref!.id}`);
      expect(linked!.certification_cycle_id).toBe(planned!.id);
      const audit = await auditOf(db, 'ndt', planned!.id);
      expect(audit).toEqual([
        expect.objectContaining({ action: 'certification_cycle.created', actor: 'rina', before: expect.objectContaining({ status: 'planned' }), after: expect.objectContaining({ status: 'active', activated: true, event_type: 'stage1' }) }),
      ]);
      // A second stage1 event opens nothing more: one open cycle per system.
      expect((await rina.post(EVENTS('bcms'), event('stage1', 'Stage 1 extra', '2027-01-27'))).status).toBe(201);
      expect(await cyclesOf(db, 'ndt', 'bcms')).toHaveLength(1);
      // "Start certification cycle" while a cycle is active: 409.
      const second = await rina.post(CYCLES('bcms'), { cycleStart: '2026-10-01' });
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({ messageKey: 'certification.cycle_open' });
      // The database backstop: a second open cycle fails the unique index.
      await expect(inOrg(db, 'ndt', (trx) => sql`insert into certification_cycle (management_system_id, cycle_start, cycle_end, status)
                                                   values (${bcms.id}, date '2026-01-01', date '2029-01-01', 'planned')`.execute(trx))).rejects.toThrow(/certification_cycle_open_uq/);
    });

    it('starts one new active cycle from the first stage1 event of a system without an open cycle', async () => {
      const abms = await systemOf(db, 'ndt', 'abms');
      // A system whose planned cycle is gone (for example one created before cycles were planned).
      await inOrg(db, 'ndt', (trx) => sql`update certification_cycle set deleted_at = now() where management_system_id = ${abms.id}`.execute(trx));
      const created = await rina.post(EVENTS('abms'), event('stage1', 'Stage 1', '2027-05-10'));
      expect(created.status).toBe(201);
      expect(created.body.message?.[0]).toMatch(/Certification cycle started/);
      const cycles = await cyclesOf(db, 'ndt', 'abms');
      expect(cycles).toHaveLength(1);
      // From the earlier of today and the event date, for three years.
      expect(cycles[0]).toMatchObject({ status: 'active', cycle_start: TODAY, cycle_end: threeYearsAfter(TODAY) });
      const items = await cycleItemsIn(db, 'ndt', cycles[0]!.id);
      expect(items.map((i) => i.def_code)).toEqual(await defCodesOf(db, abms.editionId));
      // Owner the primary MS Manager, due the day before the next audit of the cycle.
      const [primary] = await rowsOf<{ handle: string }>(db, 'ndt', sql`select u.handle from user_ms_role r join platform.app_user u on u.id = r.user_id
                                                                           where r.management_system_id = ${abms.id} and r.role = 'ms_manager' and r.is_primary and r.deleted_at is null`);
      for (const item of items) expect(item).toMatchObject({ status: 'not_started', due_at: '2027-05-09', owner: primary?.handle ?? null });
      expect(await auditOf(db, 'ndt', cycles[0]!.id)).toEqual([expect.objectContaining({ action: 'certification_cycle.created', after: expect.objectContaining({ status: 'active', event_type: 'stage1' }) })]);
      // Other event types never open a cycle.
      await inOrg(db, 'ndt', (trx) => sql`update certification_cycle set deleted_at = now() where management_system_id = ${abms.id}`.execute(trx));
      expect((await rina.post(EVENTS('abms'), event('surveillance', 'Surveillance', '2027-06-10'))).status).toBe(201);
      expect(await cyclesOf(db, 'ndt', 'abms')).toHaveLength(0);
    });

    it('starts a cycle on screen with cycleEnd three years later by default (audit_event.manage), refuses others', async () => {
      const abms = await systemOf(db, 'ndt', 'abms');
      expect((await bagus.post(CYCLES('abms'), { cycleStart: '2026-11-01' })).status).toBe(403);
      expect((await maya.post(CYCLES('abms'), { cycleStart: '2026-11-01' })).status).toBe(403);
      expect((await rina.post(CYCLES('abms'), { cycleStart: '2026-11-01', cycleEnd: '2026-10-01' })).status).toBe(400);
      const started = await rina.post(CYCLES('abms'), { cycleStart: '2026-11-01' });
      expect(started.status).toBe(201);
      expect(started.body).toMatchObject({ changed: ['abms'], ref: { entityType: 'certification_cycle' }, data: { activated: false } });
      const [cycle] = await cyclesOf(db, 'ndt', 'abms');
      expect(cycle).toMatchObject({ id: started.body.ref!.id, status: 'active', cycle_start: '2026-11-01', cycle_end: '2029-11-01' });
      expect((await cycleItemsIn(db, 'ndt', cycle!.id)).map((i) => i.def_code)).toEqual(await defCodesOf(db, abms.editionId));
      // The events without a cycle now belong to it.
      const [unlinked] = await rowsOf<{ n: number }>(db, 'ndt', sql`select count(*)::int as n from audit_event where management_system_id = ${abms.id} and certification_cycle_id is null and deleted_at is null`);
      expect(unlinked!.n).toBe(0);
      expect((await rina.post(CYCLES('abms'), { cycleStart: '2026-12-01' })).status).toBe(409);
    });
  });

  describe('certificate', () => {
    it('is refused without a recommending stage2 audit of the cycle, then recorded: cycle and system certified, label and audit', async () => {
      const bcms = await systemOf(db, 'ndt', 'bcms');
      expect(bcms.status).toBe('implementing');
      const body = { certificateNo: 'BCMS-2027-0042', issuedAt: '2027-05-03', expiresAt: '2030-05-02', certificationBody: 'PT Sertifikasi Nusantara' };
      expect((await bagus.post(CERTIFY('bcms'), body)).status).toBe(403);
      expect((await rina.post(CERTIFY('bcms'), { ...body, expiresAt: '2027-01-01' })).status).toBe(400);
      const none = await rina.post(CERTIFY('bcms'), body);
      expect(none.status).toBe(422);
      expect(none.body).toMatchObject({ messageKey: 'certification.no_recommendation', messages: { en: expect.stringMatching(/Stage 2/), id: expect.stringMatching(/Tahap 2/) } });
      const stage2 = await eventId('ndt', 'bcms', 'Stage 2, certification');
      expect((await rina.patch(`${EVENTS('bcms')}/${stage2}`, { outcome: 'not_recommended' })).status).toBe(200);
      expect((await rina.post(CERTIFY('bcms'), body)).status).toBe(422);
      expect((await rina.patch(`${EVENTS('bcms')}/${stage2}`, { outcome: 'recommended_with_conditions' })).status).toBe(200);

      const recorded = await rina.post(CERTIFY('bcms'), body);
      expect(recorded.status).toBe(200);
      expect(CommandResult.safeParse(recorded.body).success).toBe(true);
      const [cycle] = await cyclesOf(db, 'ndt', 'bcms');
      expect(cycle).toMatchObject({
        status: 'certified', certificate_no: 'BCMS-2027-0042', certified_at: '2027-05-03', certificate_expires_at: '2030-05-02', certification_body: 'PT Sertifikasi Nusantara',
      });
      // The certified scope defaults to the system's scope statement.
      const [scope] = await rowsOf<{ scope_statement: string }>(db, 'ndt', sql`select scope_statement from management_system where id = ${bcms.id}`);
      expect(cycle!.certified_scope).toBe(scope!.scope_statement);
      expect(await systemOf(db, 'ndt', 'bcms')).toMatchObject({ status: 'certified' });
      expect(await certLabel(rina, 'bcms')).toEqual(['Certified 03 May 2027, cycle 2027–2030', 'Tersertifikasi 03 Mei 2027, siklus 2027–2030']);
      const audit = await auditOf(db, 'ndt', bcms.id);
      expect(audit.at(-1)).toMatchObject({
        action: 'ms.certified', actor: 'rina',
        before: expect.objectContaining({ status: 'implementing', cycle_status: 'active' }),
        after: expect.objectContaining({ status: 'certified', cycle_status: 'certified', certificate_no: 'BCMS-2027-0042', outcome: 'recommended_with_conditions' }),
      });
      // A second certificate of the same cycle: no active cycle any more.
      expect((await rina.post(CERTIFY('bcms'), body)).status).toBe(409);
      // ms.transition implementing to certified now runs only through ms.certification.
      const abms = await rina.post('/api/v1/ms/abms/transitions', { to: 'certified' });
      expect(abms.status).toBe(409);
    });

    it('recertification: a recertification event opens the next cycle next to the certified one, and its certificate closes the old one', async () => {
      const [old] = await cyclesOf(db, 'rmn', 'isms');
      expect(old!.status).toBe('certified');
      const recert = await rinaRmn.post(EVENTS('isms'), event('recertification', 'Recertification 2027', '2027-12-08'));
      expect(recert.status).toBe(201);
      const cycles = await cyclesOf(db, 'rmn', 'isms');
      expect(cycles.map((c) => c.status)).toEqual(['active', 'certified']);
      expect((await rinaRmn.get<CertificationCycleItem[]>(CYCLES('isms'))).body.map((c) => c.status)).toEqual(['active', 'certified']);
      // The certified cycle stays in force while the recertification runs: the label is unchanged.
      expect((await certLabel(rinaRmn, 'isms'))[0]).toBe('Certified 14 Mar 2025, cycle 2025–2028');
      const body = { certificateNo: 'ISMS-2028-0007', issuedAt: '2028-02-20', expiresAt: '2031-02-19', certificationBody: 'PT Sertifikasi Nusantara', certifiedScope: 'Managed services, Jakarta' };
      expect((await rinaRmn.post(CERTIFY('isms'), body)).status).toBe(422);
      expect((await rinaRmn.patch(`${EVENTS('isms')}/${recert.body.ref!.id}`, { outcome: 'recommended' })).status).toBe(200);
      const recorded = await rinaRmn.post(CERTIFY('isms'), body);
      expect(recorded.status).toBe(200);
      expect(recorded.body.data).toEqual({ closedCycles: [old!.id] });
      const after = await cyclesOf(db, 'rmn', 'isms');
      expect(after.map((c) => [c.status, c.certificate_no])).toEqual([['certified', 'ISMS-2028-0007'], ['closed', null]]);
      expect(after[0]!.certified_scope).toBe('Managed services, Jakarta');
      expect(await auditOf(db, 'rmn', old!.id)).toEqual([
        expect.objectContaining({ action: 'certification_cycle.closed', before: { status: 'certified' }, after: expect.objectContaining({ status: 'closed', reason: 'next_cycle_certified' }) }),
      ]);
      expect(await systemOf(db, 'rmn', 'isms')).toMatchObject({ status: 'certified' });
      expect((await certLabel(rinaRmn, 'isms'))[0]).toBe('Certified 20 Feb 2028, cycle 2028–2031');
    });
  });

  describe('manual moves of a cycle (J.8)', () => {
    const move = (client: Client, ms: string, id: string, body: Record<string, unknown>, headers?: Record<string, string>) =>
      client.post(`${CYCLES(ms)}/${id}/transitions`, body, headers);

    it('suspends, reinstates and withdraws a certificate with a reason; the label follows and the system status stays', async () => {
      const [cycle] = await cyclesOf(db, 'ndt', 'bcms');
      expect((await move(rina, 'bcms', cycle!.id, { to: 'suspended' })).status).toBe(400);
      expect((await move(rina, 'bcms', cycle!.id, { to: 'suspended', reason: '' })).status).toBe(400);
      expect((await move(bagus, 'bcms', cycle!.id, { to: 'suspended', reason: 'Decision of the certification body' })).status).toBe(403);
      // Moves J.8 does not give this route: 409.
      for (const to of ['closed', 'withdrawn', 'certified']) {
        const refused = await move(rina, 'bcms', cycle!.id, { to, reason: 'Not a move of this route' });
        expect(refused.status, to).toBe(409);
        expect(refused.body.type).toMatch(/transition-not-allowed$/);
      }
      expect((await move(rina, 'bcms', cycle!.id, { to: 'expired', reason: 'Lapsed' })).status).toBe(400);

      // If-Match (R-18): a stale ETag is 412 and changes nothing; the ETag of the list works.
      const listed = (await rina.get<CertificationCycleItem[]>(CYCLES('bcms'))).body.find((c) => c.id === cycle!.id)!;
      const stale = await move(rina, 'bcms', cycle!.id, { to: 'suspended', reason: 'Suspended with an old version' }, { 'if-match': 'W/"1"' });
      expect(stale.status).toBe(412);
      expect(stale.body.type).toMatch(/precondition-failed$/);
      const suspended = await move(rina, 'bcms', cycle!.id, { to: 'suspended', reason: 'Suspended after the surveillance audit' }, { 'if-match': listed.etag });
      expect(suspended.status).toBe(200);
      expect(suspended.body.ref!.etag).not.toBe(listed.etag);
      expect((await move(rina, 'bcms', cycle!.id, { to: 'certified', reason: 'Reinstated' }, { 'if-match': listed.etag })).status).toBe(412);
      expect(suspended.body.message).toEqual(['Certificate suspended', 'Sertifikat dibekukan']);
      expect(await certLabel(rina, 'bcms')).toEqual(['Certificate suspended', 'Sertifikat dibekukan']);
      expect(await systemOf(db, 'ndt', 'bcms')).toMatchObject({ status: 'certified' });

      expect((await move(rina, 'bcms', cycle!.id, { to: 'certified', reason: 'Reinstated after the follow-up visit' }, { 'if-match': suspended.body.ref!.etag! })).status).toBe(200);
      expect((await certLabel(rina, 'bcms'))[0]).toBe('Certified 03 May 2027, cycle 2027–2030');
      expect((await move(rina, 'bcms', cycle!.id, { to: 'suspended', reason: 'Suspended again' })).status).toBe(200);
      expect((await move(rina, 'bcms', cycle!.id, { to: 'withdrawn', reason: 'Withdrawn by the certification body' })).status).toBe(200);
      expect(await certLabel(rina, 'bcms')).toEqual(['Certificate withdrawn', 'Sertifikat dicabut']);
      // Withdrawn is final for this route.
      expect((await move(rina, 'bcms', cycle!.id, { to: 'certified', reason: 'Again' })).status).toBe(409);
      const audit = (await auditOf(db, 'ndt', cycle!.id)).filter((a) => a.action === 'certification_cycle.transitioned');
      expect(audit.map((a) => [a.before, (a.after as { status: string; reason: string }).status, (a.after as { reason: string }).reason])).toEqual([
        [{ status: 'certified' }, 'suspended', 'Suspended after the surveillance audit'],
        [{ status: 'suspended' }, 'certified', 'Reinstated after the follow-up visit'],
        [{ status: 'certified' }, 'suspended', 'Suspended again'],
        [{ status: 'suspended' }, 'withdrawn', 'Withdrawn by the certification body'],
      ]);
      // A withdrawn cycle is not open: the manager starts the next one.
      expect((await rina.post(CYCLES('bcms'), { cycleStart: '2027-09-01' })).status).toBe(201);
    });

    it('closes an active cycle that will not reach certification, with a reason; 404 for a cycle of another system', async () => {
      const [active] = await cyclesOf(db, 'ndt', 'abms');
      expect(active!.status).toBe('active');
      expect((await move(rina, 'abms', active!.id, { to: 'suspended', reason: 'Not certified yet' })).status).toBe(409);
      const [bcms] = await cyclesOf(db, 'ndt', 'bcms');
      expect((await move(rina, 'abms', bcms!.id, { to: 'closed', reason: 'Wrong system' })).status).toBe(404);
      expect((await move(rina, 'abms', '00000000-0000-4000-8000-000000000999', { to: 'closed', reason: 'Unknown' })).status).toBe(404);
      const closed = await move(rina, 'abms', active!.id, { to: 'closed', reason: 'The organisation stopped the ABMS project' });
      expect(closed.status).toBe(200);
      expect((await cyclesOf(db, 'ndt', 'abms'))[0]).toMatchObject({ status: 'closed' });
      expect((await move(rina, 'abms', active!.id, { to: 'closed', reason: 'Twice' })).status).toBe(409);
      // Closing an active cycle changes no certificate label (the system never had one).
      expect(await certLabel(rina, 'abms')).toEqual(['Not yet certified, no audit event', 'Belum tersertifikasi, belum ada event audit']);
    });
  });

  describe('certificate.expiry', () => {
    it('sends one notice per tier 90, 30 and 7 days ahead to MS Managers and Programme Owners, and lapses the cycle after the expiry date', async () => {
      const isms = await systemOf(db, 'tst', 'isms');
      const [cycle] = await cyclesOf(db, 'tst', 'isms');
      expect(cycle).toMatchObject({ status: 'certified', certificate_expires_at: '2028-03-13' });
      // A Programme Owner of the system gets the notice too.
      await inOrg(db, 'tst', (trx) => sql`insert into user_ms_role (user_id, management_system_id, role, is_primary, approval_status)
                                          select id, ${isms.id}, 'programme_owner', false, 'active' from platform.app_user where handle = 'hendra'`.execute(trx));
      const [expected] = await rowsOf<{ handles: string[] }>(db, 'tst', sql`
        select array_agg(distinct u.handle order by u.handle) as handles from user_ms_role r join platform.app_user u on u.id = r.user_id
         where r.management_system_id = ${isms.id} and r.role in ('ms_manager', 'programme_owner') and r.approval_status = 'active' and r.deleted_at is null`);
      expect(expected!.handles).toEqual(expect.arrayContaining(['hendra', 'rina']));

      ctx.setToday('2027-12-13'); // 91 days ahead: nothing yet
      expect(await ctx.expiry('tst')).toMatchObject({ notified: 0, expired: [] });
      ctx.setToday('2027-12-14'); // 90 days ahead
      const first = await ctx.expiry('tst');
      expect(first!.notices).toEqual([expect.objectContaining({ cycleId: cycle!.id, tier: 90, days: 90, recipients: expected!.handles.length })]);
      // Idempotent on the same day and on the next days of the same tier.
      expect((await ctx.expiry('tst'))!.notified).toBe(0);
      ctx.setToday('2027-12-20');
      expect((await ctx.expiry('tst'))!.notified).toBe(0);
      ctx.setToday('2028-02-20'); // 22 days ahead: a missed 30-day run sends the 30-day notice once
      expect((await ctx.expiry('tst'))!.notices).toEqual([expect.objectContaining({ tier: 30, days: 22 })]);
      ctx.setToday('2028-03-06'); // 7 days ahead
      expect((await ctx.expiry('tst'))!.notices).toEqual([expect.objectContaining({ tier: 7, days: 7 })]);
      ctx.setToday('2028-03-13'); // the expiry date: still valid
      expect(await ctx.expiry('tst')).toMatchObject({ notified: 0, expired: [] });
      const notices = await notificationsOf(db, 'tst', 'certificate_expiring');
      expect(notices.map((n) => [n.handle, n.title_en])).toEqual(
        ['90', '30', '7'].flatMap((tier) => expected!.handles.map((h) => [h, `ISMS certificate expires within ${tier} days`])),
      );
      expect(notices.every((n) => n.ms_id === isms.id && n.ref_id === cycle!.id)).toBe(true);
      expect(notices[0]!.body_en).toMatch(/expires on 13 Mar 2028, in 90 days/);

      ctx.setToday('2028-03-14'); // lapsed
      const lapse = await ctx.expiry('tst');
      expect(lapse!.expired).toEqual([{ cycleId: cycle!.id, msId: isms.id }]);
      expect((await cyclesOf(db, 'tst', 'isms'))[0]).toMatchObject({ status: 'expired' });
      expect(await certLabel(rinaTst, 'isms')).toEqual(['Certificate expired', 'Sertifikat kedaluwarsa']);
      expect(await auditOf(db, 'tst', cycle!.id)).toEqual([
        expect.objectContaining({ action: 'certification_cycle.expired', actor: 'system', before: { status: 'certified' }, after: expect.objectContaining({ status: 'expired' }) }),
      ]);
      // An expired cycle is not open either: a recertification event starts the next cycle.
      expect((await ctx.expiry('tst'))!.expired).toEqual([]);
      ctx.setToday(null);
    });

    it('picks the tier of the days left', () => {
      expect([120, 91, 90, 31, 30, 8, 7, 0, -1].map(expiryTier)).toEqual([null, null, 90, 90, 30, 30, 7, 7, null]);
      expect(threeYearsAfter('2024-02-29')).toBe('2027-02-28');
      expect(threeYearsAfter('2026-11-01')).toBe('2029-11-01');
    });
  });

  it('keeps the audit chain intact', async () => {
    for (const org of ['ndt', 'rmn', 'tst'] as const) expect(await verifyChain(db, org)).toMatchObject({ firstBroken: null });
  });
});
