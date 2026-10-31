// Record tables of the routes of M3-07: periodic access review (docs/platform/MILESTONE-3.md D.1, F).
// Owned by M3-07; merged by ../record-tables.ts. Written by M3-01 with the tables of the stubs.
// The `{id}` of the system routes is the access review, which spans every system; its system part
// (`access_review_part`, one per system) carries `management_system_id`.

import type { RecordTables } from '../record-tables';

export const RECORD_TABLES: RecordTables = {
  direct: ['access_review_part'],
  idTables: {
    'access-reviews.ms.get': 'access_review',
    'access-reviews.ms.decide': 'access_review',
    'access-reviews.ms.apply': 'access_review',
    'access-reviews.ms.sign-off': 'access_review',
  },
  reads: {
    'access-reviews.settings.get': null,
    'access-reviews.list': null,
    'access-reviews.get': 'access_review',
    'access-reviews.report': 'access_review',
    'access-reviews.ms.list': null,
    'access-reviews.ms.get': 'access_review',
  },
};
