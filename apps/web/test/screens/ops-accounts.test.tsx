// The accounts and platform operators of the operator console (MILESTONE-2 M2-19): the routes against the shared table,
// the API adapter over a fake fetch (the list query, the detail, each action with its reason, idempotency key and, for
// the status, If-Match; the operators), the model rules (which actions an account offers, the reason check, the Add
// operator form, the refusal texts), the parts in both languages and both themes, and the sample adapter with the
// refusals of the server.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { routeById } from '@mscd/shared';
import type { OpsAccountDetail, OpsAccountItem, OpsOperatorItem } from '@mscd/shared';
import { ApiClient } from '../../src/data/api/ApiClient';
import { AccountView, ActionDialog, SessionsTable } from '../../src/screens/ops/AccountDrawer';
import { AccountsTable, AccountsTab } from '../../src/screens/ops/AccountsTab';
import {
  ACTION_EFFECTS, ACTION_LABEL, accountName, accountRefusal, actionsFor, operatorErrors, reasonError, resendable, rolesText,
} from '../../src/screens/ops/account-model';
import type { AccountItem } from '../../src/screens/ops/account-model';
import { ACCOUNT_TEXT } from '../../src/screens/ops/account-text';
import { createApiAdapter, fromAccount, fromAccountDetail, fromOperator } from '../../src/screens/ops/api';
import { AddOperatorDialog, OperatorsTable, RemoveOperatorDialog } from '../../src/screens/ops/OperatorsCard';
import { ROUTES, ROUTE_IDS } from '../../src/screens/ops/routes';
import { createSampleAdapter, resetSampleOps } from '../../src/screens/ops/sample';
import { SAMPLE_SELF_ID, SYSTEM_ACCOUNT_ID } from '../../src/screens/ops/sample-accounts';
import type { Lang } from '../../src/screens/types';
import { fakeFetch, json, problem } from '../auth/helpers';
import { ctxOf, esc, loadSampleD, render, sampleD, t, textProblems } from './ctx-m2-16';

const RINA: OpsAccountItem = {
  id: '00000000-0000-4000-8000-0000000f0019', handle: 'rina', email: 'rina.kusuma@nusantaradigital.co.id', displayName: 'Rina Kusuma', kind: 'person',
  status: 'active', mfaEnrolled: true, locked: true, lastSignInAt: '2026-10-29T02:10:00Z', createdAt: '2026-02-01T03:00:00Z', platformOperator: false,
  memberships: [
    { org: 'ndt', orgName: 'PT Nusantara Digital Teknologi', status: 'active', adminRoles: ['tenant_admin'] },
    { org: 'bsd', orgName: 'PT Bank Sentosa Digital', status: 'invited', adminRoles: [] },
  ],
  etag: 'W/"1793239800000"',
};
const DETAIL: OpsAccountDetail = {
  ...RINA,
  sessions: [{ startedAt: '2026-10-29T02:10:00Z', lastSeenAt: '2026-10-29T02:40:00Z', method: 'local', state: 'active', network: '203.0.113.0/24', browser: 'Chrome 130, Windows', org: 'ndt' }],
  audit: [{ at: '2026-10-29T02:12:00Z', action: 'auth.mfa_reset', actorKind: 'operator', actor: { handle: 'ops', displayName: 'Platform Operator' }, org: null, reason: 'Lost phone, checked by video call' }],
};
const OPERATOR: OpsOperatorItem = {
  id: '00000000-0000-4000-8000-0000000f0001', handle: 'ops', email: 'ops@mscd.example', displayName: 'Platform Operator', status: 'active',
  mfaEnrolled: true, passwordSet: true, lastSignInAt: '2026-10-29T01:00:00Z', grantedAt: '2026-09-01T03:00:00Z', grantedBy: null, self: true,
};
const RESULT = (data: Record<string, unknown>, message?: [string, string]) => ({ ok: true, changed: [], ...(message ? { message } : {}), data: { id: RINA.id, sessionsRevoked: 0, emailed: true, status: 'active', ...data } });
/** An operator session of a multi tenancy service. */
const OPERATOR_RIGHTS = ['ops.read', 'ops.jobs.run', 'ops.users.manage', 'ops.tenants.manage', 'license.manage', 'pack.install'];

function client(routes: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(routes);
  const c = new ApiClient({ fetch: f.fetch });
  c.setCsrfToken('csrf-token-0123456789');
  return { ...f, client: c };
}

beforeAll(async () => {
  await loadSampleD();
});
beforeEach(() => resetSampleOps());

describe('Accounts routes', () => {
  it('match the shared route table, with the permissions of reading and acting', () => {
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      const route = routeById(ROUTE_IDS[name as keyof typeof ROUTES]);
      expect([route.method, route.path], name).toEqual([method, path]);
    }
    for (const name of ['accounts', 'account', 'operators'] as const) expect(routeById(ROUTE_IDS[name]).permission, name).toBe('ops.read');
    for (const name of ['accountResetMfa', 'accountPassword', 'accountResend', 'accountSessions', 'accountStatus', 'operatorAdd', 'operatorRemove'] as const) {
      expect(routeById(ROUTE_IDS[name]).permission, name).toBe('ops.users.manage');
    }
    expect(routeById(ROUTE_IDS.accountStatus).ifMatch).toBe(true);
  });

  it('every text has both languages, Indonesian that differs, and no em dash or centre dot', () => {
    expect(textProblems(ACCOUNT_TEXT, ['colStatus', 'factStatus', 'confirmTitle', 'colOperator'])).toEqual([]);
  });
});

describe('Accounts API adapter', () => {
  it('lists accounts with the search, the filters and the page, and reads one account', async () => {
    const f = client({
      'GET /api/v1/ops/accounts': json({ items: [RINA], page: 2, pageSize: 25, total: 26 }),
      [`GET /api/v1/ops/accounts/${RINA.id}`]: json(DETAIL),
    });
    const adapter = createApiAdapter(f.client);
    const page = await adapter.accounts({ page: 2, pageSize: 25, q: 'rina', org: 'ndt', status: 'active', kind: 'person' });
    expect(page).toEqual({ ok: true, data: { items: [fromAccount(RINA)], page: 2, pageSize: 25, total: 26 } });
    expect(f.calls[0].url).toBe('/api/v1/ops/accounts?page=2&pageSize=25&q=rina&org=ndt&status=active&kind=person');
    await adapter.accounts({ page: 1, pageSize: 25 });
    expect(f.calls[1].url).toBe('/api/v1/ops/accounts?page=1&pageSize=25');
    expect(await adapter.account(RINA.id)).toEqual({ ok: true, data: fromAccountDetail(DETAIL) });
  });

  it('reads the organisations of the filter with one request, without the detail of each', async () => {
    const f = client({
      'GET /api/v1/ops/organizations': [
        json({ items: [{ id: '00000000-0000-4000-8000-00000000a001', slug: 'ndt', name: 'PT Nusantara Digital Teknologi', status: 'active', licence: null, memberCount: 1, systemCount: 1, plan: null, validUntil: null, verifiedDomains: [], createdAt: '2026-02-01T03:00:00Z' }], page: 1, pageSize: 200, total: 1 }),
        problem(409, 'conflict', { messageKey: 'single_tenancy' }),
      ],
    });
    const adapter = createApiAdapter(f.client);
    expect(await adapter.organizationNames()).toEqual({ ok: true, data: [{ slug: 'ndt', name: 'PT Nusantara Digital Teknologi' }] });
    expect(f.calls.map((c) => c.url)).toEqual(['/api/v1/ops/organizations?page=1&pageSize=200']);
    // One organisation (single tenancy): no filter.
    expect((await adapter.organizationNames()).ok).toBe(false);
  });

  it('sends each action with its reason and idempotency key, and the status with If-Match', async () => {
    const f = client({
      [`POST /api/v1/ops/accounts/${RINA.id}/reset-mfa`]: json(RESULT({ sessionsRevoked: 2 }, ['Reset.', 'Diatur ulang.'])),
      [`POST /api/v1/ops/accounts/${RINA.id}/password-reset`]: json(RESULT({ emailed: false, link: 'https://mscd.example.id/reset-password#token=abc', expiresAt: '2026-10-29T03:00:00Z' })),
      [`POST /api/v1/ops/accounts/${RINA.id}/invitations/bsd/resend`]: json(RESULT({})),
      [`POST /api/v1/ops/accounts/${RINA.id}/sessions/revoke`]: json(RESULT({ sessionsRevoked: 1, emailed: false })),
      [`POST /api/v1/ops/accounts/${RINA.id}/status`]: [json(RESULT({ status: 'disabled', sessionsRevoked: 1, emailed: false })), problem(412, 'precondition-failed')],
    });
    const adapter = createApiAdapter(f.client);
    expect(await adapter.resetMfa(RINA.id, 'Lost phone', 'k-1')).toEqual({ ok: true, data: { status: 'active', sessionsRevoked: 2, emailed: true, link: null, message: ['Reset.', 'Diatur ulang.'] } });
    const link = await adapter.sendPasswordLink(RINA.id, 'Asked by ticket 4411', 'k-2');
    expect(link.ok && link.data.link).toBe('https://mscd.example.id/reset-password#token=abc');
    expect((await adapter.resendInvitation(RINA.id, 'bsd', 'Lost the first email', 'k-3')).ok).toBe(true);
    expect((await adapter.endSessions(RINA.id, 'Laptop stolen', 'k-4')).ok).toBe(true);
    const disabled = await adapter.setAccountStatus(RINA.id, 'disabled', 'Left the company', RINA.etag);
    expect(disabled.ok && disabled.data.status).toBe('disabled');
    const stale = await adapter.setAccountStatus(RINA.id, 'active', 'Back again', 'W/"1"');
    expect(!stale.ok && accountRefusal(stale.error)).toEqual(ACCOUNT_TEXT.changedMeanwhile);
    const posts = f.calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.body)).toEqual([
      { reason: 'Lost phone' }, { reason: 'Asked by ticket 4411' }, { reason: 'Lost the first email' }, { reason: 'Laptop stolen' },
      { status: 'disabled', reason: 'Left the company' }, { status: 'active', reason: 'Back again' },
    ]);
    expect(posts.slice(0, 4).map((c) => c.headers['idempotency-key'])).toEqual(['k-1', 'k-2', 'k-3', 'k-4']);
    expect(posts[4].headers['if-match']).toBe(RINA.etag);
    expect(posts.every((c) => c.headers['x-csrf-token'] === 'csrf-token-0123456789')).toBe(true);
  });

  it('lists, adds and removes platform operators; a refusal keeps the server text', async () => {
    const f = client({
      'GET /api/v1/ops/operators': json([OPERATOR]),
      'POST /api/v1/ops/operators': [
        json({ ok: true, changed: [], message: ['Added.', 'Ditambahkan.'], data: { id: OPERATOR.id, handle: 'nadia', email: 'nadia@mscd.example', newAccount: true, emailed: true } }, 201),
        problem(409, 'conflict', { title: 'Conflict', messageKey: 'mail_required', detail: 'Mail is required on this installation and the SMTP server does not answer.' }),
      ],
      [`DELETE /api/v1/ops/operators/${OPERATOR.id}`]: problem(403, 'forbidden', { messageKey: 'own_account', messages: { en: 'You cannot do this to your own account.', id: 'Anda tidak dapat melakukan ini pada akun Anda sendiri.' } }),
    });
    const adapter = createApiAdapter(f.client);
    expect(await adapter.operators()).toEqual({ ok: true, data: [fromOperator(OPERATOR)] });
    const added = await adapter.addOperator({ email: 'nadia@mscd.example', name: 'Nadia', reason: 'On-call rota' }, 'k-5');
    expect(added).toEqual({ ok: true, data: { id: OPERATOR.id, email: 'nadia@mscd.example', newAccount: true, emailed: true, link: null, message: ['Added.', 'Ditambahkan.'] } });
    const refused = await adapter.addOperator({ email: 'nadia@mscd.example', name: 'Nadia', reason: 'On-call rota' }, 'k-6');
    // The detail of a problem without a message pair is what the form shows, never only "Conflict".
    expect(!refused.ok && accountRefusal(refused.error)[0]).toBe('Mail is required on this installation and the SMTP server does not answer.');
    const own = await adapter.removeOperator(OPERATOR.id, 'Leaving');
    expect(!own.ok && own.error.messageKey).toBe('own_account');
    const remove = f.calls.find((c) => c.method === 'DELETE')!;
    expect(remove.body).toEqual({ reason: 'Leaving' });
  });
});

describe('Accounts model', () => {
  const item = fromAccount(RINA);

  it('offers the actions an account can take, never on the system account, never ending the own sessions', () => {
    expect(actionsFor(item, null)).toEqual(['reset-mfa', 'password', 'sessions', 'disable']);
    // A reset of the own second factor would end the operator's own sessions too.
    expect(actionsFor(item, item.id)).toEqual(['password']);
    expect(actionsFor({ ...item, status: 'disabled', mfaEnrolled: false }, null)).toEqual(['sessions', 'enable']);
    // An invited account is neither disabled nor enabled: it becomes active when the person accepts.
    expect(actionsFor({ ...item, status: 'invited', mfaEnrolled: false }, null)).toEqual(['sessions']);
    expect(actionsFor({ ...item, kind: 'guest', mfaEnrolled: false }, null)).toEqual(['sessions', 'disable']);
    expect(actionsFor({ ...item, kind: 'system' }, null)).toEqual([]);
    expect(resendable(item).map((m) => m.org)).toEqual(['bsd']);
    expect(resendable({ ...item, status: 'disabled' })).toEqual([]);
  });

  it('checks the reason and the Add operator form before sending', () => {
    expect(reasonError('ok')).toBe(ACCOUNT_TEXT.reasonShort);
    expect(reasonError('  fix  ')).toBeNull();
    expect(reasonError('x'.repeat(501))).toBe(ACCOUNT_TEXT.reasonLong);
    expect(operatorErrors({ email: 'nadia', name: '', reason: 'no' })).toEqual({ email: ACCOUNT_TEXT.emailInvalid, name: ACCOUNT_TEXT.nameRequired, reason: ACCOUNT_TEXT.reasonShort });
    expect(operatorErrors({ email: 'nadia@mscd.example', name: 'Nadia', reason: 'On-call rota' })).toEqual({});
  });

  it('names the account in a confirmation and the admin roles in words', () => {
    const ctx = ctxOf({ lang: 'id' });
    expect(accountName(item)).toBe('Rina Kusuma (rina.kusuma@nusantaradigital.co.id)');
    expect(rolesText(ctx, ['tenant_admin'])).toBe(t(ACCOUNT_TEXT.roleTenantAdmin, 'id'));
    expect(rolesText(ctx, [])).toBe(t(ACCOUNT_TEXT.roleMember, 'id'));
    for (const action of Object.keys(ACTION_EFFECTS) as (keyof typeof ACTION_EFFECTS)[]) {
      expect(ACTION_EFFECTS[action].length, action).toBeGreaterThan(0);
      expect(ACTION_LABEL[action][1], action).not.toBe(ACTION_LABEL[action][0]);
    }
  });
});

describe('Accounts parts', () => {
  for (const lang of ['en', 'id'] as Lang[]) {
    for (const theme of ['light', 'dark'] as const) {
      it(`render in ${lang}, ${theme} theme`, () => {
        const ctx = ctxOf({ lang, theme, mode: 'api', org: OPERATOR_RIGHTS });
        const adapter = createSampleAdapter(() => sampleD());
        const detail = fromAccountDetail(DETAIL);
        const html = render(
          <>
            <AccountsTab ctx={ctx} adapter={adapter} />
            <AccountsTable ctx={ctx} accounts={[detail]} onOpen={() => undefined} />
            <AccountView ctx={ctx} detail={detail} selfId={null} onAction={() => undefined} />
            <SessionsTable ctx={ctx} sessions={detail.sessions} />
            <ActionDialog ctx={ctx} adapter={adapter} account={detail} target={{ action: 'disable' }} onClose={() => undefined} onDone={() => undefined} />
            <OperatorsTable ctx={ctx} operators={[fromOperator(OPERATOR), fromOperator({ ...OPERATOR, id: 'x', self: false, passwordSet: false, displayName: 'Nadia Putri' })]} canManage onRemove={() => undefined} />
            <AddOperatorDialog ctx={ctx} adapter={adapter} open onClose={() => undefined} onAdded={() => undefined} />
            <RemoveOperatorDialog ctx={ctx} adapter={adapter} operator={fromOperator({ ...OPERATOR, self: false })} onClose={() => undefined} onRemoved={() => undefined} />
          </>,
          ctx,
          theme,
        );
        for (const text of [
          ACCOUNT_TEXT.accountsSub, ACCOUNT_TEXT.locked, ACCOUNT_TEXT.factorOn, ACCOUNT_TEXT.roleTenantAdmin, ACCOUNT_TEXT.actResetMfa, ACCOUNT_TEXT.actPassword,
          ACCOUNT_TEXT.actSessions, ACCOUNT_TEXT.actDisable, ACCOUNT_TEXT.effDisable1, ACCOUNT_TEXT.reasonHint, ACCOUNT_TEXT.operatorsSub, ACCOUNT_TEXT.waitingPassword,
          ACCOUNT_TEXT.you, ACCOUNT_TEXT.addSub, ACCOUNT_TEXT.removeEffect1, ACCOUNT_TEXT.auditMfaReset, ACCOUNT_TEXT.sessionsSub, ACCOUNT_TEXT.statusInvited,
        ]) {
          expect(html, text[0]).toContain(esc(t(text, lang)));
        }
        // The confirmation names the account; the sessions show the cut network and the browser, never the address.
        expect(html).toContain(esc(accountName(detail)));
        expect(html).toContain(esc(ctx.fill(ACCOUNT_TEXT.resendTitle, { org: 'PT Bank Sentosa Digital' })));
        expect(html).toContain('203.0.113.0/24');
        expect(html).toContain('Chrome 130, Windows');
        expect(html).toContain('Lost phone, checked by video call');
        expect(html).not.toMatch(/[—·]/);
        expect(html).not.toMatch(/font-size:\s*(?:[0-9]|1[01])(?:\.\d+)?px/);
      });
    }
  }

  it('the system account and a reader without the right to act get no action buttons', () => {
    const detail = fromAccountDetail(DETAIL);
    const reader = ctxOf({ mode: 'api', org: ['ops.read'] });
    const html = render(<AccountView ctx={reader} detail={detail} selfId={null} onAction={() => undefined} />, reader);
    expect(html).toContain(esc(t(ACCOUNT_TEXT.readOnlyRights)));
    expect(html).not.toContain(esc(t(ACCOUNT_TEXT.actDisable)));
    const operator = ctxOf({ mode: 'api', org: OPERATOR_RIGHTS });
    const system = render(<AccountView ctx={operator} detail={{ ...detail, kind: 'system', memberships: [] }} selfId={null} onAction={() => undefined} />, operator);
    expect(system).toContain(esc(t(ACCOUNT_TEXT.systemNote)));
    expect(system).not.toContain(esc(t(ACCOUNT_TEXT.actResetMfa)));
    const self = render(<AccountView ctx={operator} detail={detail} selfId={detail.id} onAction={() => undefined} />, operator);
    expect(self).toContain(esc(t(ACCOUNT_TEXT.selfNote)));
    expect(self).not.toContain(esc(t(ACCOUNT_TEXT.actSessions)));
    expect(self).not.toContain(esc(t(ACCOUNT_TEXT.actResetMfa)));
    const invited = render(<AccountView ctx={operator} detail={{ ...detail, status: 'invited', mfaEnrolled: false }} selfId={null} onAction={() => undefined} />, operator);
    expect(invited).toContain(esc(t(ACCOUNT_TEXT.invitedNote)));
    expect(invited).not.toContain(esc(t(ACCOUNT_TEXT.actDisable)));
    expect(invited).not.toContain(esc(t(ACCOUNT_TEXT.actEnable)));
  });
});

describe('Accounts sample adapter', () => {
  it('lists the sample accounts with the filters and refuses as the server does', async () => {
    const adapter = createSampleAdapter(() => sampleD());
    const all = await adapter.accounts({ page: 1, pageSize: 100 });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const handles = all.data.items.map((a) => a.handle);
    expect(handles).toEqual(expect.arrayContaining(['ops', 'nadia.putri', 'system', 'rina', 'lina', 'agus.salim', 'auditor.ext']));
    const ndt = await adapter.accounts({ page: 1, pageSize: 100, org: 'ndt' });
    expect(ndt.ok && ndt.data.items.every((a) => a.memberships.some((m) => m.org === 'ndt'))).toBe(true);
    const invited = await adapter.accounts({ page: 1, pageSize: 100, status: 'invited' });
    expect(invited.ok && invited.data.items.map((a) => a.handle).sort()).toEqual(['lina', 'nurul.huda']);
    const search = await adapter.accounts({ page: 1, pageSize: 100, q: 'rina kusuma' });
    expect(search.ok && search.data.items.map((a) => a.handle)).toEqual(['rina']);
    const system = await adapter.resetMfa(SYSTEM_ACCOUNT_ID, 'Test of the refusal', 'k');
    expect(!system.ok && system.error.messageKey).toBe('system_account');
    const own = await adapter.endSessions(SAMPLE_SELF_ID, 'Test of the refusal', 'k');
    expect(!own.ok && own.error.messageKey).toBe('own_account');
    const ownFactor = await adapter.resetMfa(SAMPLE_SELF_ID, 'Test of the refusal', 'k');
    expect(!ownFactor.ok && [ownFactor.error.status, ownFactor.error.messageKey]).toEqual([403, 'own_account']);
    const unknown = await adapter.account('00000000-0000-4000-8000-00000000dead');
    expect(!unknown.ok && [unknown.error.status, unknown.error.messageKey]).toEqual([404, 'unknown_account']);
    const lina = (await adapter.accounts({ page: 1, pageSize: 100, q: 'lina' }));
    const linaId = lina.ok ? lina.data.items[0]!.id : '';
    const invitedOff = await adapter.setAccountStatus(linaId, 'disabled', 'Test of the refusal', '');
    expect(!invitedOff.ok && [invitedOff.error.status, invitedOff.error.messageKey]).toEqual([409, 'account_invited']);
    expect(!invitedOff.ok && invitedOff.error.message[0]).toContain('It can be disabled after that.');
  });

  it('runs the actions on an account with the reason in its recent activity', async () => {
    const adapter = createSampleAdapter(() => sampleD());
    const page = await adapter.accounts({ page: 1, pageSize: 100, q: 'rina' });
    const rina = page.ok ? page.data.items[0] as AccountItem : null;
    expect(rina).not.toBeNull();
    const reset = await adapter.resetMfa(rina!.id, 'Lost phone, checked by video call', 'k');
    expect(reset.ok && reset.data.sessionsRevoked).toBe(2);
    const again = await adapter.resetMfa(rina!.id, 'Lost phone, checked by video call', 'k');
    expect(!again.ok && again.error.messageKey).toBe('no_second_factor');
    const detail = await adapter.account(rina!.id);
    expect(detail.ok && detail.data.audit[0]).toMatchObject({ action: 'auth.mfa_reset', reason: 'Lost phone, checked by video call', actorKind: 'operator' });
    expect(detail.ok && detail.data.sessions).toEqual([]);
    const stale = await adapter.setAccountStatus(rina!.id, 'disabled', 'Left', rina!.etag);
    expect(!stale.ok && stale.error.status).toBe(412);
    const fresh = detail.ok ? detail.data.etag : '';
    const disabled = await adapter.setAccountStatus(rina!.id, 'disabled', 'Left the company', fresh);
    expect(disabled.ok && disabled.data.status).toBe('disabled');
    const link = await adapter.sendPasswordLink(rina!.id, 'Asked by ticket', 'k');
    expect(!link.ok && link.error.messageKey).toBe('account_not_active');
    const lina = (await adapter.accounts({ page: 1, pageSize: 10, q: 'lina' }));
    const resend = await adapter.resendInvitation(lina.ok ? lina.data.items[0].id : '', 'ndt', 'First email lost', 'k');
    expect(resend.ok).toBe(true);
  });

  it('adds and removes platform operators, never the own account or the last one', async () => {
    const adapter = createSampleAdapter(() => sampleD());
    const added = await adapter.addOperator({ email: 'dimas@mscd.example', name: 'Dimas Pratama', reason: 'On-call rota' }, 'k');
    expect(added.ok && added.data.newAccount).toBe(true);
    const twice = await adapter.addOperator({ email: 'ops@mscd.example', name: 'Ops', reason: 'On-call rota' }, 'k');
    expect(!twice.ok && twice.error.messageKey).toBe('already_operator');
    const list = await adapter.operators();
    expect(list.ok && list.data.map((o) => [o.email, o.self])).toEqual(expect.arrayContaining([['ops@mscd.example', true], ['dimas@mscd.example', false]]));
    const own = await adapter.removeOperator(SAMPLE_SELF_ID, 'Leaving');
    expect(!own.ok && own.error.messageKey).toBe('own_account');
    const dimas = list.ok ? list.data.find((o) => o.email === 'dimas@mscd.example')! : null;
    const removed = await adapter.removeOperator(dimas!.id, 'Rota ended');
    expect(removed.ok && removed.data.operatorsLeft).toBeGreaterThanOrEqual(1);
  });
});
