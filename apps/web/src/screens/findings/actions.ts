// Detail extension of "Findings and actions" (MILESTONE-2 C.5, M2-14): the open findings of a clause or control in
// the requirement detail (`req`) of Controls & requirements, read with `findings.list?targetCode=`, so the match uses
// the code stored with the finding (`targetCode`) instead of its free-text clause reference.
import type { ScreenActions } from '../types';
import { OpenFindingsExtension } from './extension';

export const detailExtensions: ScreenActions['detailExtensions'] = [
  { id: 'findings.open', kind: 'req', order: 40, Component: OpenFindingsExtension, visible: (ctx, props) => ctx.can(props.ms, 'ms.read') },
];
