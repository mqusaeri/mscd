// The daily `access-review.open` job and the single Tenant Admin (Milestone 3 D.9, J.3, J.4, M3-07), with a fixed clock
// (the organisation's "today" is set per step). In PT Nusantara Digital Teknologi (`ndt`) rina is the only Tenant Admin.
// The first run writes the settings with the first review due one period later; the run on the due date opens a review
// (opened by the schedule) with its notices and moves the next due date on; a second run of the same day does nothing;
// the reminder goes three days before the due date and the overdue notice the day after it and every 7 days after that;
// rina's own organisation items need a second reviewer and the review completes with REVIEW-SINGLE-ADMIN.
import type { AccessReviewDetail, AccessReviewSettings, CommandResult } from '@mscd/shared';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../setup/test-db';
import { startStorageStack, type StorageStack } from '../files/helpers';
import { createReviewApp, rowsOf, signIn, type FilesClient, type ReviewApp } from './helpers';

const ADMIN = '/api/v1/admin/access-reviews';

describe('access-review.open and the single Tenant Admin (Milestone 3 D.9)', () => {
  const db = useTestDatabase('demo');
  let stack: StorageStack;
  let ctx: ReviewApp;
  let rina: FilesClient;

  const notices = (kind: string) =>
    rowsOf<{ recipient_user_id: string; title_en: string; management_system_id: string | null }>(
      db, 'ndt', sql`select recipient_user_id, title_en, management_system_id from notification where kind = ${kind} order by created_at, title_en, recipient_user_id`,
    );

  beforeAll(async () => {
    stack = await startStorageStack();
    ctx = await createReviewApp(db, stack.gateway.url);
    rina = await signIn(ctx as never, db, 'rina', 'ndt');
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
    await stack?.close();
  });

  it('writes the settings at the first run and opens the review on its due date, once', async () => {
    ctx.setToday('2026-09-29');
    const first = await ctx.daily('ndt');
    expect(first).toMatchObject({ initialised: true, opened: null });
    const settings = (await rina.get<AccessReviewSettings>(`${ADMIN}/settings`)).body;
    expect(settings).toMatchObject({ frequencyMonths: 3, nextDueOn: '2026-12-29', daysToComplete: 14 });

    const moved = await rina.call<AccessReviewSettings>('PUT', `${ADMIN}/settings`, { frequencyMonths: 3, nextDueOn: '2026-10-05', daysToComplete: 10 }, { 'if-match': settings.etag });
    expect(moved.status).toBe(200);
    ctx.setToday('2026-10-04');
    expect((await ctx.daily('ndt')).opened).toBeNull();
    ctx.setToday('2026-10-05');
    const run = await ctx.daily('ndt');
    expect(run.opened).toMatchObject({ reviewNo: 'AR-2026-01', openedOn: '2026-10-05', dueOn: '2026-10-15' });
    expect(run.opened!.parts).toBeGreaterThan(2);
    expect((await ctx.daily('ndt')).opened).toBeNull();
    expect((await rina.get<AccessReviewSettings>(`${ADMIN}/settings`)).body.nextDueOn).toBe('2027-01-05');

    const detail = (await rina.get<AccessReviewDetail>(`${ADMIN}/${run.opened!.id}`)).body;
    expect(detail.openedBy).toBeNull();
    const opened = await notices('access_review_due');
    expect(opened.filter((n) => n.title_en === 'Access review AR-2026-01 is open').map((n) => n.recipient_user_id)).toEqual([rina.userId]);
    expect(opened.filter((n) => n.title_en.startsWith('Access review AR-2026-01: review the access in')).length).toBeGreaterThanOrEqual(detail.parts.length);
    const tasks = await rowsOf<{ n: number }>(db, 'ndt', sql`select count(*)::int as n from task where source_rule = 'access_review' and status = 'open'`);
    expect(tasks[0]!.n).toBe(detail.parts.length);
  });

  it('reminds three days before the due date and every 7 days after it while the review is open', async () => {
    const before = (await notices('access_review_due')).length;
    ctx.setToday('2026-10-11');
    expect((await ctx.daily('ndt')).dueSoonSent).toBe(0);
    ctx.setToday('2026-10-12');
    const soon = await ctx.daily('ndt');
    expect(soon.dueSoonSent).toBeGreaterThan(0);
    const after = await notices('access_review_due');
    expect(after.length).toBe(before + soon.dueSoonSent);
    expect(after.at(-1)!.title_en).toBe('Access review AR-2026-01 is due on 15 Oct 2026');
    expect((await ctx.daily('ndt')).dueSoonSent).toBe(0);

    ctx.setToday('2026-10-15');
    expect((await ctx.daily('ndt')).overdueSent).toBe(0);
    ctx.setToday('2026-10-16');
    const late = await ctx.daily('ndt');
    expect(late.overdueSent).toBeGreaterThan(0);
    expect((await notices('access_review_overdue')).at(-1)!.title_en).toBe('Access review AR-2026-01 is overdue');
    ctx.setToday('2026-10-20');
    expect((await ctx.daily('ndt')).overdueSent).toBe(0);
    ctx.setToday('2026-10-23');
    expect((await ctx.daily('ndt')).overdueSent).toBe(late.overdueSent);
  });

  it('leaves the single Tenant Admin\'s own items for a second reviewer and completes with REVIEW-SINGLE-ADMIN', async () => {
    ctx.setToday('2026-10-23');
    const [review] = (await rina.get<{ id: string }[]>(ADMIN)).body;
    const detail = (await rina.get<AccessReviewDetail>(`${ADMIN}/${review!.id}`)).body;
    const own = detail.organisationPart.rows.filter((r) => r.subject.handle === 'rina');
    expect(own.length).toBeGreaterThanOrEqual(3);
    expect(own.every((r) => r.needsSecondReviewer && r.ownAccess)).toBe(true);
    expect(detail.organisationPart.needsSecondReviewer).toBe(own.length);
    for (const row of detail.organisationPart.rows) {
      if (row.subject.handle !== 'rina') expect((await rina.post(`${ADMIN}/${review!.id}/items/${row.id}/decision`, { decision: 'keep' })).status).toBe(200);
    }
    // Every system part: rina decides what she may, the system's own manager decides rina's role, and rina signs off.
    // In the ISMS rina is the only manager, so her own role there needs a second reviewer.
    const others: Record<string, string> = { qms: 'sari', bcms: 'tono', abms: 'lina' };
    for (const part of detail.parts) {
      const items = (await rina.get<{ rows: { id: string; ownAccess: boolean; needsSecondReviewer: boolean }[] }>(`/api/v1/ms/${part.ms}/access-reviews/${review!.id}`)).body.rows;
      for (const item of items) {
        if (item.needsSecondReviewer) continue;
        const by = item.ownAccess ? await signIn(ctx as never, db, others[part.ms!]!, 'ndt') : rina;
        expect((await by.post(`/api/v1/ms/${part.ms}/access-reviews/${review!.id}/items/${item.id}/decision`, { decision: 'keep' })).status).toBe(200);
      }
      const signed = await rina.post<CommandResult>(`/api/v1/ms/${part.ms}/access-reviews/${review!.id}/sign-off`, {});
      expect(signed.status, `${part.ms}: ${JSON.stringify(signed.body)}`).toBe(200);
    }
    const done = await rina.post<CommandResult & { data: { filed: unknown[] } }>(`${ADMIN}/${review!.id}/complete`, {});
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data.filed).toEqual([]);
    expect(done.body.warnings).toEqual([expect.objectContaining({ rule: 'REVIEW-SINGLE-ADMIN' })]);
    expect(done.body.warnings![0]!.messages.en).toContain('one Tenant Admin');
    // The overdue notices stop with the completion.
    ctx.setToday('2026-10-30');
    expect((await ctx.daily('ndt')).overdueSent).toBe(0);
    const tasks = await rowsOf<{ n: number }>(db, 'ndt', sql`select count(*)::int as n from task where source_rule = 'access_review' and status = 'open'`);
    expect(tasks[0]!.n).toBe(0);
  });
});
