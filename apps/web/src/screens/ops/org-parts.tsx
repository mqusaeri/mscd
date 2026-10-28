// Small parts of the organisation views of the operator console (MILESTONE-2 M2-S12): the status badge, the end of a
// plan with its days left, and the users of an organisation against its limit.
import type { HostContext } from '../types';
import { Badge, Meter } from '../ui';
import { ORG_TEXT } from './org-text';
import { STATUS_LABEL, STATUS_TONE, dayText, daysLeftOf, isOpenEnded, todayOf } from './org-model';
import type { OrgStatus } from './org-model';

export function StatusBadge({ ctx, status }: { ctx: HostContext; status: OrgStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{ctx.li(STATUS_LABEL[status])}</Badge>;
}

/** The days left until the last day of a plan, as a badge whose tone warns from 30 days and when it ended. */
export function DaysLeft({ ctx, validUntil }: { ctx: HostContext; validUntil: string }) {
  const left = daysLeftOf(validUntil, todayOf(ctx));
  return <Badge tone={left.tone}>{ctx.fill(left.text, { n: left.n })}</Badge>;
}

/** The last day of a plan with the days left; "No end date" when open-ended, `-` without a plan. */
export function ValidUntil({ ctx, validUntil, hasPlan }: { ctx: HostContext; validUntil: string | null; hasPlan: boolean }) {
  if (!hasPlan) return <span className="mx-muted">-</span>;
  if (isOpenEnded(validUntil)) return <span>{ctx.li(ORG_TEXT.noEndDate)}</span>;
  return (
    <>
      <div style={{ whiteSpace: 'nowrap' }}>{dayText(ctx, validUntil)}</div>
      <div style={{ marginTop: 4 }}><DaysLeft ctx={ctx} validUntil={validUntil!} /></div>
    </>
  );
}

/** "41 of 50" with a bar, or the members alone when the limit is not known. */
export function UsersOf({ ctx, used, limit }: { ctx: HostContext; used: number; limit: number | null }) {
  if (limit === null) return <span>{used}</span>;
  return (
    <>
      <span style={{ whiteSpace: 'nowrap' }}>{ctx.fill(ORG_TEXT.usersOf, { used, limit })}</span>
      <Meter used={used} limit={limit} />
    </>
  );
}

/** A domain name that wraps only after its dots. */
export function DomainName({ name }: { name: string }) {
  const parts = name.split('.');
  return (
    <span className="mx-mono">
      {parts.map((p, i) => (
        <span key={i}>{p}{i < parts.length - 1 ? <>.<wbr /></> : null}</span>
      ))}
    </span>
  );
}
