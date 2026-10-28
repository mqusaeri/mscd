// Getting started (MILESTONE-2 M2-16, `/admin/getting-started`): the onboarding checklist of D.5 for the Tenant Admin.
// Each step shows its state, its count and a button to the screen that completes it, with the progress "n of m done"
// and the single administrator warning (D2-12). The steps of the management system manager (`doneBy: ms_manager`)
// name the primary MS Manager and open a prepared email to that person, unless the session may do the step itself.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Illustration } from '../../illustrations';
import { canOpenHost, hostById } from '../host';
import type { HostContext, ScreenProps, TextPair } from '../types';
import { Alert, Badge, Button, Card, EmptyState, Meter } from '../ui';
import type { Tone } from '../ui';
import { adapterFor, loadSteps } from './adapter';
import {
  BUILTIN_LABELS, MANAGER_STEP_PERM, STATE_TEXT, STEP_TEXT, countText, groupsOf, mailtoOf, progressOf, singleAdmin, warningOf,
} from './model';
import type { Loaded, StepModel } from './model';
import { TEXT } from './text';
import './getting-started.css';

const STATE_TONE: Readonly<Record<StepModel['state'], Tone>> = { done: 'ok', pending: 'warn', optional: 'mute' };
const TICK = 'M5 12.5l4.5 4.5L19 7.5';

/** The label of a screen a step opens: a host screen of the registry or a built-in screen; null when unknown. */
export function screenLabel(screen: string): TextPair | null {
  const host = hostById(screen);
  if (host) return host.label;
  return BUILTIN_LABELS[screen] ?? null;
}

/** Whether the session may open the screen of a step (host screens through the registry's rule). */
export function canOpen(ctx: HostContext, screen: string): boolean {
  if (hostById(screen)) return canOpenHost(screen, ctx, ctx.role);
  return Boolean(BUILTIN_LABELS[screen]);
}

/** The heading of a system's group: its short name and standard from the snapshot, else the slug in capitals. */
export function systemName(ctx: HostContext, ms: string): string {
  const system = (ctx.D?.MS ?? []).find((m) => m.id === ms);
  return system ? `${system.short}, ${system.code}` : ms.toUpperCase();
}

/**
 * Whether the session does a step of the MS Manager itself: in API mode it holds the step's permission in the system;
 * in the sample build the persona's person is the system's manager.
 */
export function doesItself(ctx: HostContext, step: StepModel): boolean {
  const perm = MANAGER_STEP_PERM[step.key];
  if (!perm || !step.ms) return false;
  if (ctx.mode === 'api') return ctx.can(step.ms, perm);
  const system = (ctx.D?.MS ?? []).find((m) => m.id === step.ms);
  return Boolean(system && system.mgr === ctx.person.handle);
}

function StepAction({ ctx, step }: { ctx: HostContext; step: StepModel }) {
  const target = screenLabel(step.screen);
  const managerStep = step.doneBy === 'ms_manager' && !doesItself(ctx, step);
  // A step of the MS Manager done by the session opens its screen in that system; the others pass the system along.
  const extra = step.doneBy === 'ms_manager' && step.ms ? { ms: step.ms } : { params: step.ms ? { ms: step.ms } : {} };
  if (step.state === 'done' && !managerStep) {
    return target && canOpen(ctx, step.screen)
      ? <Button onClick={() => ctx.go(step.screen, extra)}>{ctx.fill(TEXT.open, { screen: ctx.li(target) })}</Button>
      : null;
  }
  if (managerStep) {
    const system = step.ms ? systemName(ctx, step.ms) : '';
    if (!step.assignee) return <span className="mx-small">{ctx.li(TEXT.noManager)}</span>;
    const href = mailtoOf(step.assignee, { step: ctx.li(STEP_TEXT[step.key].title), system }, (t, v) => ctx.fill(t, v));
    return (
      <>
        <span className="mx-small">{ctx.fill(TEXT.assignedTo, { name: step.assignee.name })}</span>
        {step.state === 'done' ? null : <a className="mx-btn" href={href}>{ctx.fill(TEXT.emailManager, { name: step.assignee.name })}</a>}
      </>
    );
  }
  if (!target) return null;
  if (!canOpen(ctx, step.screen)) return <span className="mx-small">{ctx.fill(TEXT.notAvailable, { screen: ctx.li(target) })}</span>;
  return (
    <Button variant={step.state === 'pending' ? 'primary' : 'default'} onClick={() => ctx.go(step.screen, extra)}>
      {ctx.fill(TEXT.open, { screen: ctx.li(target) })}
    </Button>
  );
}

/** One step of the checklist: state, title, explanation, count, warning and its action. */
export function StepRow({ ctx, step }: { ctx: HostContext; step: StepModel }) {
  const text = STEP_TEXT[step.key];
  const count = countText(step);
  const warning = warningOf(step);
  return (
    <li className="mx-gs-step" data-step={step.key} data-state={step.state}>
      <span className="mx-gs-mark" data-state={step.state} aria-hidden="true">
        {step.state === 'done' ? (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d={TICK} /></svg>
        ) : null}
      </span>
      <div className="mx-gs-body">
        <h3 className="mx-gs-title">{ctx.li(text.title)}</h3>
        <span className="mx-gs-help">{ctx.li(text.help)}</span>
        <div className="mx-gs-meta">
          <Badge tone={STATE_TONE[step.state]}>{ctx.li(STATE_TEXT[step.state])}</Badge>
          {step.doneBy === 'ms_manager' ? <Badge tone="info">{ctx.li(TEXT.forManager)}</Badge> : null}
          {count ? <span className="mx-small">{ctx.fill(count.text, count.values)}</span> : null}
        </div>
        {warning ? <div style={{ marginTop: 6 }}><Alert tone="warn">{ctx.li(warning)}</Alert></div> : null}
      </div>
      <div className="mx-gs-action"><StepAction ctx={ctx} step={step} /></div>
    </li>
  );
}

/** The checklist of a loaded set of steps. */
export function Checklist({ ctx, steps, onCheck }: { ctx: HostContext; steps: StepModel[]; onCheck?: () => void }) {
  const progress = progressOf(steps);
  const groups = groupsOf(steps);
  const hasSystems = groups.some((g) => g.ms);
  return (
    <>
      <Card>
        <div className="mx-gs-hero">
          <div className="mx-gs-hero-art">
            {progress.allDone
              ? <Illustration scene="all-done" decorative />
              : <Illustration scene="getting-started" progress={progress.share} />}
          </div>
          <div className="mx-gs-hero-text">
            <p className="mx-gs-progress">{progress.allDone ? ctx.li(TEXT.allDone) : ctx.fill(TEXT.progress, { done: progress.done, total: progress.total })}</p>
            <Meter used={progress.done} limit={Math.max(1, progress.total)} />
            <span className="mx-muted">{ctx.li(progress.allDone ? TEXT.allDoneText : TEXT.intro)}</span>
            <span className="mx-small">{ctx.li(TEXT.progressNote)}</span>
            {onCheck ? <div><Button onClick={onCheck}>{ctx.li(TEXT.checkAgain)}</Button></div> : null}
          </div>
        </div>
      </Card>
      {singleAdmin(steps) ? <Alert tone="warn" title={TEXT.singleAdminTitle}>{ctx.li(TEXT.singleAdmin)}</Alert> : null}
      {groups.map((group) => (
        group.steps.length ? (
          <Card
            key={group.ms ?? 'org'}
            title={group.ms ? systemName(ctx, group.ms) : TEXT.orgGroup}
            sub={group.ms ? TEXT.systemSub : TEXT.orgGroupSub}
          >
            <ol className="mx-gs-steps">
              {group.steps.map((step) => <StepRow key={`${step.key}:${step.ms ?? ''}`} ctx={ctx} step={step} />)}
            </ol>
          </Card>
        ) : null
      ))}
      {!hasSystems ? (
        <Card>
          <EmptyState
            title={TEXT.noSystems}
            text={TEXT.noSystemsText}
            illustration={<Illustration scene="no-systems" size="sm" decorative />}
            action={canOpen(ctx, 'systems') ? (
              <Button variant="primary" onClick={() => ctx.go('systems')}>{ctx.fill(TEXT.open, { screen: ctx.li(screenLabel('systems') ?? TEXT.systems) })}</Button>
            ) : null}
          />
        </Card>
      ) : null}
    </>
  );
}

export default function GettingStartedScreen({ ctx }: ScreenProps) {
  const data = useRef(ctx.D);
  data.current = ctx.D;
  const { client } = ctx;
  const adapter = useMemo(() => adapterFor(client, () => data.current), [client]);
  const [state, setState] = useState<{ loading: boolean; result: Loaded | null }>({ loading: true, result: null });
  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true }));
    loadSteps(adapter).then((result) => setState({ loading: false, result }));
  }, [adapter]);
  useEffect(() => load(), [load]);
  const result = state.result;
  if (!result) return <div className="mx-small" role="status">{ctx.li(TEXT.loading)}</div>;
  if (!result.ok) {
    return (
      <Alert tone="bad" title={TEXT.loadFailed}>
        <div>{ctx.li(result.error.message)}</div>
        <div style={{ marginTop: 8 }}><Button onClick={load}>{ctx.li(TEXT.tryAgain)}</Button></div>
      </Alert>
    );
  }
  return <Checklist ctx={ctx} steps={result.steps} onCheck={load} />;
}
