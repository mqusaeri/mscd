// Page action "Import" of Controls & requirements and Document register (MILESTONE-2 M2-08, C.5 `extraPageActions`):
// opens the Import screen with the kind of the screen, for whoever may manage that kind in the selected system. Both
// builds show it: the sample adapter checks and imports CSV files of controls and documents, and `e2e/shell.spec.js`
// counts the page actions packages add to built-in screens from the screen host.
import type { ExtraPageAction, HostContext } from '../types';
import { sessionMayImport } from './model';
import type { ImportKind } from './model';
import { TEXT } from './text';

const ICON = 'M12 3v12M7 10l5 5 5-5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4';

function importFor(screen: 'controls' | 'docs', id: string, kind: ImportKind): ExtraPageAction {
  return {
    screen,
    id,
    label: [TEXT.importAction[0], TEXT.importAction[1]],
    icon: ICON,
    visible: (ctx: HostContext) => Boolean(ctx.msObj) && sessionMayImport(ctx, ctx.msObj!.id, kind),
    run: (ctx: HostContext) => ctx.go('import', { params: { kind, at: Date.now() } }),
  };
}

export const extraPageActions: ExtraPageAction[] = [
  importFor('controls', 'controls.import', 'applicability'),
  importFor('docs', 'docs.import', 'documents'),
];
