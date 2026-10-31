// Write tracker of the test reset (Milestone 2 M2-21): `POST /test/reset` recreates the database only when something
// may have changed it since the last reset. Most end-to-end tests only read, and the API suite calls the reset before
// every test, so a reset with nothing to undo answers at once.
//
// A write is any of:
// - a request other than GET, HEAD or OPTIONS, apart from the test routes themselves (they reset and mint sessions);
// - a GET of a route that changes state by design: the sign-in starts and callbacks and the storage consent callback
//   (WRITING_GET_ROUTES);
// - an audit entry written by the api (downloads, exports and file opens are GET requests that write one);
// - a job run in this process.
// Sessions minted by `POST /test/session` are not a write: the tracker keeps their ids, and a reset without a write
// deletes them, so the next test starts from the seed state as before. Rows changed directly in the database (not
// through the api) are not seen; such a test does its change through the api.
//
// The tracker does nothing unless the profile enables the test endpoints (`testEndpointsEnabled`): it wraps nothing,
// the request gate is not installed, and the reset route answers 404 as before. With MSCD_TEST_RESET_ALWAYS=1 every
// reset recreates the database, as before M2-21 (the API stack sets it for E2E_STACK_RESET=always).
import { Inject, Injectable, Optional, type OnModuleInit } from '@nestjs/common';
import { API_ROUTES, routeById } from '@mscd/shared';
import { JOB_QUEUE, type JobQueue } from '../../common/jobs/job-queue';
import { AUDIT_WRITER, type AuditWriter } from '../../common/tokens';
import { MscdConfig } from '../../config/mscd-config';
import { testEndpointsEnabled } from './test-mode';

/** Methods that never count as a write. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * GET routes that change state by design: a sign-in start stores its transaction, a callback creates a session and
 * signs the user in, the storage consent callback stores the repository's tokens.
 */
export const WRITING_GET_ROUTES = ['auth.oidc.start', 'auth.oidc.callback', 'auth.saml.start', 'admin.storage.oauth.callback'] as const;

interface RouteMatcher {
  path: string;
  pattern: RegExp;
}

/** A route path (`/api/v1/auth/oidc/:slug/callback`) as a regular expression on a request path. */
function matcherOf(path: string): RouteMatcher {
  const escaped = path
    .split('/')
    .map((part) => (part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return { path, pattern: new RegExp(`^${escaped}/?$`) };
}

let matchers: { tests: RouteMatcher[]; writingGets: RouteMatcher[] } | null = null;

/** Built on first use, so a module that never runs in test mode never reads the route table here. */
function routeMatchers(): { tests: RouteMatcher[]; writingGets: RouteMatcher[] } {
  matchers ??= {
    tests: API_ROUTES.filter((route) => route.testOnly).map((route) => matcherOf(route.path)),
    writingGets: WRITING_GET_ROUTES.map((id) => matcherOf(routeById(id).path)),
  };
  return matchers;
}

/** The path of a request URL without its query. */
export function pathOf(url: string): string {
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

const matches = (list: RouteMatcher[], path: string, routeUrl?: string) => list.some((m) => m.path === routeUrl || m.pattern.test(path));

/**
 * True when a request counts as a write. `routeUrl` is the route pattern Fastify matched (`request.routeOptions.url`),
 * when there is one.
 */
export function isWriteRequest(method: string, url: string, routeUrl?: string): boolean {
  const { tests, writingGets } = routeMatchers();
  const path = pathOf(url);
  if (matches(tests, path, routeUrl)) return false;
  const verb = method.toUpperCase();
  if (!READ_METHODS.has(verb)) return true;
  return verb === 'GET' && matches(writingGets, path, routeUrl);
}

@Injectable()
export class TestWriteTracker implements OnModuleInit {
  /**
   * True when the database may differ from the template. The first reset after start always recreates the database,
   * so writes made while the api started are undone as before.
   */
  private dirty = true;
  /** What first made the database dirty since the last reset. */
  private reason = 'api start';
  /** `id_hash` of each session `POST /test/session` minted since the last reset, by its hex form. */
  private readonly minted = new Map<string, Buffer>();

  constructor(
    private readonly config: MscdConfig,
    @Optional() @Inject(AUDIT_WRITER) private readonly audit?: AuditWriter,
    @Optional() @Inject(JOB_QUEUE) private readonly jobs?: JobQueue,
  ) {}

  onModuleInit(): void {
    if (!testEndpointsEnabled(this.config)) return;
    if (this.audit) this.watchAuditWriter(this.audit);
    if (this.jobs) this.watchJobQueue(this.jobs);
  }

  /** Records a write. */
  markWrite(reason: string): void {
    if (!this.dirty) this.reason = reason;
    this.dirty = true;
  }

  /** A request passed the request gate (`request-gate.ts`): a write unless it reads or is a test route. */
  noteRequest(method: string, url: string, routeUrl?: string): void {
    if (this.dirty) return;
    if (isWriteRequest(method, url, routeUrl)) this.markWrite(`${method.toUpperCase()} ${routeUrl ?? pathOf(url)}`);
  }

  /** True when something may have written since the last reset (always with MSCD_TEST_RESET_ALWAYS=1). */
  get changed(): boolean {
    return this.dirty || this.always;
  }

  /** What first made the database dirty since the last reset, or null. */
  get changedBy(): string | null {
    if (this.dirty) return this.reason;
    return this.always ? 'MSCD_TEST_RESET_ALWAYS' : null;
  }

  private get always(): boolean {
    return this.config.env.MSCD_TEST_RESET_ALWAYS === '1';
  }

  /** A session `POST /test/session` minted (its `id_hash`). */
  rememberSession(idHash: Buffer): void {
    this.minted.set(idHash.toString('hex'), idHash);
  }

  /** The sessions minted since the last reset. */
  mintedSessions(): Buffer[] {
    return [...this.minted.values()];
  }

  /**
   * The reset brought the database back to the template state (recreated it, or deleted the minted sessions). It runs
   * while the request gate holds new requests, so no write comes between.
   */
  resetDone(): void {
    this.dirty = false;
    this.reason = '';
    this.minted.clear();
  }

  /** Every audit entry the api writes counts as a write (`AuditWriter.record` and `recordDetached`). */
  private watchAuditWriter(writer: AuditWriter): void {
    const record = writer.record.bind(writer);
    const recordDetached = writer.recordDetached.bind(writer);
    writer.record = (trx, entry) => {
      this.markWrite(`audit ${entry.action}`);
      return record(trx, entry);
    };
    writer.recordDetached = (entry, target) => {
      this.markWrite(`audit ${entry.action}`);
      return recordDetached(entry, target);
    };
  }

  /** Every job a handler of this process runs counts as a write. */
  private watchJobQueue(queue: JobQueue): void {
    const work = queue.work.bind(queue) as JobQueue['work'];
    const wrapped: JobQueue['work'] = (name, opts, handler) =>
      work(name, opts, (job) => {
        this.markWrite(`job ${name}`);
        return handler(job);
      });
    queue.work = wrapped;
  }
}
