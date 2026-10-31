// Detail extensions of Retention and disposal (MILESTONE-3 M3-06, C.5, D.8): the retention end and any hold of a document
// (`doc`) and of an evidence item (`ev`), for holders of `retention.manage` or `retention.approve` in the system.
import type { ScreenActions } from '../types';
import { RetentionDocExtension, RetentionEvidenceExtension } from './extension';
import { mayRead } from './model';

export const detailExtensions: ScreenActions['detailExtensions'] = [
  { id: 'retention.doc', kind: 'doc', order: 60, Component: RetentionDocExtension, visible: (ctx, props) => mayRead(ctx, props.ms) },
  { id: 'retention.ev', kind: 'ev', order: 60, Component: RetentionEvidenceExtension, visible: (ctx, props) => mayRead(ctx, props.ms) },
];
