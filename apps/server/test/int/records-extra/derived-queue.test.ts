// Readiness and cycle items after document and metric commands (Milestone 2 D.6, D.4, M2-07): registering, changing
// and reviewing a document and recording a metric value queue `readiness.recompute` and `cycle.derive` in the
// command's transaction, 60 seconds later and once per system, for every system the record counts in (its linked
// systems; every active system for an organisation-wide document). A change that changes nothing queues nothing.
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { READINESS_DELAY_SECONDS, readinessRecomputeKey } from '../../../src/modules/implementation/readiness/readiness-queue';
import { useTestDatabase } from '../../setup/test-db';
import { grantRole } from '../commands-implementation/helpers';
import { ORG_IDS, createExtraApp, rowsOf, sessionFor, systemOf, type Client, type CommandsApp } from './helpers';

const DERIVED = new Set(['readiness.recompute', 'cycle.derive']);

describe('readiness and cycle items queued by document and metric commands (M2-07)', () => {
  const db = useTestDatabase('demo');
  let ctx: CommandsApp;
  let rina: Client;
  let hendra: Client;
  let rinaNdt: Client;
  let isms: { id: string; version: string };
  let send: MockInstance;

  /** The derived jobs the last commands sent, as `<job> <system id>`, sorted. */
  const sent = () =>
    (send.mock.calls as [string, { payload: { msId?: string } }, { startAfterSeconds?: number; singletonKey?: string }?][])
      .filter(([name]) => DERIVED.has(name))
      .map(([name, env, opts]) => {
        expect(opts?.startAfterSeconds).toBe(READINESS_DELAY_SECONDS);
        return `${name} ${env.payload.msId}`;
      })
      .sort();
  const both = (...msIds: string[]) => msIds.flatMap((id) => [`cycle.derive ${id}`, `readiness.recompute ${id}`]).sort();
  const waitingFor = (msId: string) =>
    [...DERIVED].every((name) => ctx.queue.waitingJobs(name as 'readiness.recompute').some((j) => (j.env.payload as { msId?: string }).msId === msId));
  const activeSystems = async () =>
    (await rowsOf<{ id: string }>(db, 'ndt', sql`select id from management_system where deleted_at is null and status <> 'archived'`)).map((r) => r.id);

  beforeAll(async () => {
    ctx = await createExtraApp(db);
    // A second approver (a Programme Owner holds document.approve, F.6).
    await grantRole(db, 'tst', 'isms', 'hendra', 'programme_owner');
    rina = await sessionFor(ctx, db, 'rina', 'tst');
    hendra = await sessionFor(ctx, db, 'hendra', 'tst');
    rinaNdt = await sessionFor(ctx, db, 'rina', 'ndt');
    isms = await systemOf(db, 'tst', 'isms');
    send = vi.spyOn(ctx.queue, 'send');
  });
  beforeEach(() => {
    send.mockClear();
  });
  afterAll(async () => {
    send?.mockRestore();
    await ctx?.close();
  });

  it('queues both jobs for the linked system when a document is registered, changed and reviewed', async () => {
    const created = await rina.post('/api/v1/ms/isms/documents', {
      docCode: 'PRC-61', title: 'Change Management Procedure', docType: 'procedure', ownerHandle: 'rina', classification: 'internal', orgWide: false, linkedMs: ['isms'],
    });
    expect(created.status).toBe(201);
    expect(sent()).toEqual(both(isms.id));
    expect(waitingFor(isms.id)).toBe(true);
    const readiness = ctx.queue.waitingJobs('readiness.recompute').find((j) => (j.env.payload as { msId?: string }).msId === isms.id);
    expect(readiness?.env.orgId).toBe(ORG_IDS.tst);
    expect(send.mock.calls.find(([name]) => name === 'readiness.recompute')?.[2]).toMatchObject({ singletonKey: readinessRecomputeKey(ORG_IDS.tst, isms.id) });
    const url = `/api/v1/ms/isms/documents/${created.body.ref!.id}`;

    send.mockClear();
    expect((await rina.patch(url, { title: 'Change Management Procedure' })).status).toBe(200);
    expect(sent()).toEqual([]);
    expect((await rina.patch(url, { nextReviewAt: '2027-10-01' })).status).toBe(200);
    expect(sent()).toEqual(both(isms.id));

    send.mockClear();
    expect((await rina.post(`${url}/transitions`, { to: 'in_review' })).status).toBe(200);
    expect(sent()).toEqual(both(isms.id));
    send.mockClear();
    expect((await hendra.post(`${url}/transitions`, { to: 'approved' })).status).toBe(200);
    expect(sent()).toEqual(both(isms.id));
  });

  it('queues both jobs for every linked system of a shared document and every active system for an organisation-wide one', async () => {
    const systems = Object.fromEntries((await rowsOf<{ slug: string; id: string }>(db, 'ndt', sql`
      select slug, id from management_system where deleted_at is null`)).map((r) => [r.slug, r.id]));
    const shared = await rinaNdt.post('/api/v1/ms/isms/documents', {
      docCode: 'IMS-61', title: 'Integrated Change Policy', docType: 'policy', ownerHandle: 'rina', classification: 'internal', orgWide: false, linkedMs: ['qms', 'isms'],
    });
    expect(shared.status).toBe(201);
    expect(sent()).toEqual(both(systems.isms!, systems.qms!));

    send.mockClear();
    const orgWide = await rinaNdt.post('/api/v1/ms/isms/documents', {
      docCode: 'ORG-61', title: 'Code of Conduct', docType: 'policy', ownerHandle: 'rina', classification: 'internal', orgWide: true, linkedMs: ['isms'],
    });
    expect(orgWide.status).toBe(201);
    const active = await activeSystems();
    expect(active.length).toBeGreaterThan(1);
    expect(sent()).toEqual(both(...active));
  });

  it('queues both jobs for every system a metric is linked to when a value is recorded', async () => {
    const systems = Object.fromEntries((await rowsOf<{ slug: string; id: string }>(db, 'ndt', sql`
      select slug, id from management_system where deleted_at is null`)).map((r) => [r.slug, r.id]));
    const metric = await rinaNdt.post('/api/v1/ms/isms/registers/metrics', {
      code: 'M2-07-M1', title: 'Changes reviewed on time (%)', ownerHandle: 'rina', unit: '%', targetValue: 95, frequencyCode: 'monthly', linkedMs: ['isms', 'qms'],
    });
    expect(metric.status, JSON.stringify(metric.body)).toBe(201);
    send.mockClear();
    const recorded = await rinaNdt.post(`/api/v1/ms/isms/metrics/${metric.body.ref!.id}/values`, { periodStart: '2026-09-01', periodEnd: '2026-09-30', value: 97 });
    expect(recorded.status, JSON.stringify(recorded.body)).toBe(201);
    expect(sent()).toEqual(both(systems.isms!, systems.qms!));
    // A refused value (overlapping period) queues nothing that commits.
    send.mockClear();
    const overlap = await rinaNdt.post(`/api/v1/ms/isms/metrics/${metric.body.ref!.id}/values`, { periodStart: '2026-09-15', periodEnd: '2026-10-15', value: 90 });
    expect(overlap.status).toBe(422);
    expect(sent()).toEqual([]);
  });
});
