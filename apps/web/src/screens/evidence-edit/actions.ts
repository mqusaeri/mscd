// Page actions and detail extensions of the evidence forms (MILESTONE-2 C.5, M2-11):
// - "New evidence" and "Freshness limits" on Evidence freshness (`fresh`). They show in API builds only: the sample
//   build keeps the page actions of the generated screen as `e2e/shell.spec.js` counts them (R-15), as M2-08 did for
//   "Import" (its deviation 1). The sample build reaches New evidence through "Define evidence" of an entry and the
//   freshness limits through the evidence panel;
// - the detail extension of `ev` (Edit evidence, Add target, Remove target, Freshness limits) and of `req` (Define
//   evidence).
import type { ExtraPageAction, HostContext, ScreenActions } from '../types';
import { DefineExtension, EvidenceExtension, EvidenceLayer } from './extension';
import { requestEvidence } from './store';
import { TEXT } from './text';

const NEW_ICON = 'M12 5v14M5 12h14';
const LIMITS_ICON = 'M12 8v4l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z';

const inApi = (ctx: HostContext) => ctx.mode === 'api' && Boolean(ctx.msObj);

export const extraPageActions: ExtraPageAction[] = [
  {
    screen: 'fresh',
    id: 'fresh.newEvidence',
    label: [TEXT.newEvidence[0], TEXT.newEvidence[1]],
    icon: NEW_ICON,
    visible: (ctx) => inApi(ctx) && ctx.can(ctx.msObj!.id, 'evidence.manage'),
    run: (ctx) => requestEvidence({ kind: 'new', ms: ctx.msObj!.id, at: Date.now() }),
  },
  {
    screen: 'fresh',
    id: 'fresh.freshnessLimits',
    label: [TEXT.freshnessLimits[0], TEXT.freshnessLimits[1]],
    icon: LIMITS_ICON,
    visible: (ctx) => inApi(ctx) && ctx.can(ctx.msObj!.id, 'ms.read'),
    run: (ctx) => requestEvidence({ kind: 'limits', ms: ctx.msObj!.id, at: Date.now() }),
  },
];

export const detailExtensions: ScreenActions['detailExtensions'] = [
  { id: 'evidence-edit.evidence', kind: 'ev', order: 10, Component: EvidenceExtension },
  { id: 'evidence-edit.define', kind: 'req', order: 20, Component: DefineExtension },
];

export const layerItems: ScreenActions['layerItems'] = [{ id: 'evidence-edit.forms', order: 31, Component: EvidenceLayer }];
