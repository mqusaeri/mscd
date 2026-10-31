import { describe, expect, it } from 'vitest';
import { routeById } from '@mscd/shared';
import type { JobQueue } from '../../../src/common/jobs/job-queue';
import type { AuditWriter } from '../../../src/common/tokens';
import { MscdConfig } from '../../../src/config/mscd-config';
import { TestWriteTracker, isWriteRequest, pathOf } from '../../../src/modules/test-support/write-tracker';

// The write tracker of the test reset (Milestone 2 M2-21): which requests, audit entries and job runs make the next
// `POST /test/reset` recreate the database, and what a reset without a write leaves to undo.
const TEST_PROFILE = `${__dirname}/../../../profiles/test.yaml`;

function config(env: Record<string, string> = {}): MscdConfig {
  return MscdConfig.load({ runMode: 'api', flavor: 'dev', env: { MSCD_PROFILE_FILE: TEST_PROFILE, MSCD__TEST__ENDPOINTS_ENABLED: 'true', ...env } });
}

/** A route path with its parameters filled in. */
const filled = (id: Parameters<typeof routeById>[0]) => routeById(id).path.replace(/:[^/]+/g, 'x1');

function fakeAudit(): AuditWriter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    record: async (_trx, entry) => {
      calls.push(`record ${entry.action}`);
      return {} as never;
    },
    recordDetached: async (entry) => {
      calls.push(`detached ${entry.action}`);
      return {} as never;
    },
  } as AuditWriter & { calls: string[] };
}

function fakeQueue(): JobQueue & { handlers: Map<string, (job: unknown) => unknown> } {
  const handlers = new Map<string, (job: unknown) => unknown>();
  return {
    handlers,
    send: async () => null,
    schedule: async () => undefined,
    work: async (name: string, _opts: unknown, handler: (job: unknown) => unknown) => {
      handlers.set(name, handler);
    },
    stats: async () => [],
    stop: async () => undefined,
  } as unknown as JobQueue & { handlers: Map<string, (job: unknown) => unknown> };
}

describe('isWriteRequest (M2-21)', () => {
  it('counts every method but GET, HEAD and OPTIONS as a write', () => {
    expect(isWriteRequest('GET', '/api/v1/me')).toBe(false);
    expect(isWriteRequest('head', '/api/v1/me')).toBe(false);
    expect(isWriteRequest('OPTIONS', '/api/v1/admin/users')).toBe(false);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) expect(isWriteRequest(method, '/api/v1/admin/users'), method).toBe(true);
  });

  it('leaves out the test routes themselves, with or without a query or a trailing slash', () => {
    expect(isWriteRequest('POST', '/api/v1/test/reset')).toBe(false);
    expect(isWriteRequest('POST', '/api/v1/test/session?x=1')).toBe(false);
    expect(isWriteRequest('POST', '/api/v1/test/session/')).toBe(false);
  });

  it('counts the GET routes that change state: sign-in starts and callbacks, the storage consent callback', () => {
    for (const id of ['auth.oidc.start', 'auth.oidc.callback', 'auth.saml.start', 'admin.storage.oauth.callback'] as const) {
      expect(isWriteRequest('GET', `${filled(id)}?code=abc&state=def`), id).toBe(true);
      expect(isWriteRequest('HEAD', filled(id)), `${id} HEAD`).toBe(false);
    }
  });

  it('matches the route pattern Fastify reports as well as the path', () => {
    const callback = routeById('auth.oidc.callback').path;
    expect(isWriteRequest('GET', '/somewhere/else', callback)).toBe(true);
    expect(isWriteRequest('POST', '/somewhere/else', routeById('test.reset').path)).toBe(false);
    expect(pathOf('/api/v1/me?x=1')).toBe('/api/v1/me');
  });
});

describe('TestWriteTracker (M2-21)', () => {
  it('starts dirty, so the first reset after start always recreates the database', () => {
    const tracker = new TestWriteTracker(config());
    expect(tracker.changed).toBe(true);
    expect(tracker.changedBy).toBe('api start');
    tracker.resetDone();
    expect(tracker.changed).toBe(false);
    expect(tracker.changedBy).toBeNull();
  });

  it('turns dirty on the first write after a reset and keeps the first reason', () => {
    const tracker = new TestWriteTracker(config());
    tracker.resetDone();
    tracker.noteRequest('GET', '/api/v1/ui/org');
    tracker.noteRequest('POST', '/api/v1/test/session');
    expect(tracker.changed).toBe(false);
    tracker.noteRequest('PATCH', '/api/v1/ms/isms/controls/x1', '/api/v1/ms/:ms/controls/:id');
    tracker.noteRequest('DELETE', '/api/v1/admin/users/x2');
    expect(tracker.changed).toBe(true);
    expect(tracker.changedBy).toBe('PATCH /api/v1/ms/:ms/controls/:id');
  });

  it('counts every audit entry the api writes, also from a GET request', async () => {
    const audit = fakeAudit();
    const tracker = new TestWriteTracker(config(), audit);
    tracker.onModuleInit();
    tracker.resetDone();
    await audit.recordDetached({ action: 'evidence.downloaded' } as never);
    expect(tracker.changedBy).toBe('audit evidence.downloaded');
    tracker.resetDone();
    await audit.record({} as never, { action: 'export.created' } as never);
    expect(tracker.changedBy).toBe('audit export.created');
    expect(audit.calls).toEqual(['detached evidence.downloaded', 'record export.created']);
  });

  it('counts every job a handler of the api process runs', async () => {
    const queue = fakeQueue();
    const tracker = new TestWriteTracker(config(), undefined, queue);
    tracker.onModuleInit();
    let ran = 0;
    await queue.work('mail.send' as never, { concurrency: 1 }, async () => {
      ran += 1;
    });
    tracker.resetDone();
    await queue.handlers.get('mail.send')!({});
    expect(ran).toBe(1);
    expect(tracker.changedBy).toBe('job mail.send');
  });

  it('keeps the sessions minted since the last reset until the reset is done', () => {
    const tracker = new TestWriteTracker(config());
    tracker.rememberSession(Buffer.from('aa', 'hex'));
    tracker.rememberSession(Buffer.from('bb', 'hex'));
    tracker.rememberSession(Buffer.from('aa', 'hex'));
    expect(tracker.mintedSessions().map((b) => b.toString('hex'))).toEqual(['aa', 'bb']);
    tracker.resetDone();
    expect(tracker.mintedSessions()).toEqual([]);
  });

  it('always reports a change with MSCD_TEST_RESET_ALWAYS=1', () => {
    const tracker = new TestWriteTracker(config({ MSCD_TEST_RESET_ALWAYS: '1' }));
    tracker.resetDone();
    expect(tracker.changed).toBe(true);
    expect(tracker.changedBy).toBe('MSCD_TEST_RESET_ALWAYS');
  });

  it('wraps nothing when the profile does not enable the test endpoints', async () => {
    const audit = fakeAudit();
    const queue = fakeQueue();
    const record = audit.record;
    const work = queue.work;
    const tracker = new TestWriteTracker(config({ MSCD__TEST__ENDPOINTS_ENABLED: 'false' }), audit, queue);
    tracker.onModuleInit();
    expect(audit.record).toBe(record);
    expect(queue.work).toBe(work);
  });
});
