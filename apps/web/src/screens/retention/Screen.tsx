// Retention and disposal (MILESTONE-3 M3-06, D.8): the retention periods of a system and their disposal review, in five
// tabs that are part of the address (`tab=`, M2-20): Rules, Due for review (opened first), Awaiting approval, Holds and
// Disposal register. Management System Managers (`retention.manage`) change rules, decide, place and release holds;
// another manager or a Programme Owner (`retention.approve`) approves or rejects disposals.
import type { ScreenProps } from '../types';
import { Tabs } from '../ui';
import { useScreenTab } from '../../routing';
import { HoldsTab } from './holds';
import { RegisterTab } from './register';
import { ApprovalTab, DueTab } from './reviews';
import { RulesTab } from './rules';
import { TEXT } from './text';

export const TABS = ['rules', 'due', 'approval', 'holds', 'register'] as const;
export type RetentionTab = (typeof TABS)[number];

export default function RetentionScreen({ ctx }: ScreenProps) {
  const ms = ctx.msObj?.id ?? null;
  const [tab, setTab] = useScreenTab<RetentionTab>(ctx, TABS, 'due');
  if (!ms) return null;
  return (
    <>
      <Tabs
        label={TEXT.tabsLabel}
        active={tab}
        onChange={(id) => setTab(id as RetentionTab)}
        tabs={[
          { id: 'rules', label: TEXT.tabRules },
          { id: 'due', label: TEXT.tabDue },
          { id: 'approval', label: TEXT.tabApproval },
          { id: 'holds', label: TEXT.tabHolds },
          { id: 'register', label: TEXT.tabRegister },
        ]}
      />
      {tab === 'due' ? <DueTab key={ms} ctx={ctx} ms={ms} /> : null}
      {tab === 'approval' ? <ApprovalTab key={ms} ctx={ctx} ms={ms} /> : null}
      {tab === 'holds' ? <HoldsTab key={ms} ctx={ctx} ms={ms} /> : null}
      {tab === 'register' ? <RegisterTab key={ms} ctx={ctx} ms={ms} /> : null}
      {tab === 'rules' ? <RulesTab key={ms} ctx={ctx} ms={ms} /> : null}
    </>
  );
}
