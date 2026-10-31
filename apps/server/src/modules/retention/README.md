# retention module
Retention and disposal review of records (Milestone 3 D.8, M3-06): the retention period per record class of each
system (36 months by default), the daily `retention.review` job that opens a disposal review when a period ends, the
decision (keep, extend, dispose), the second person's approval and the disposal itself, legal holds, and the disposal
register with its CSV. Files kept in a customer's SharePoint or Google Drive are never deleted by MSCD: their owner is
asked through a task. Owner: M3-06.

| File | Content |
|---|---|
| `retention.controller.ts` | The eleven routes of `packages/shared/src/api/retention.ts` |
| `retention.service.ts` | Rules, reviews, decisions with RET-HOLD, RET-NOT-DUE, RET-CURRENT and SOD-SELF-APPROVE, register (with the period in force at each decision), holds |
| `retention-items.ts` | The items of each record class: code, home system, period start, current flag, objects |
| `retention-disposal.ts` | What an approved disposal does: vault delete, owner task, record marked deleted, `record.disposed`; after a failed approval, the objects already deleted marked disposed |
| `retention-review.service.ts`, `retention-review.job.ts` | The daily job: `replaced_at` backfill, new reviews, the digest |
| `retention-model.ts` | Default period, class names, month arithmetic |
