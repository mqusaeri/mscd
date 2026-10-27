// API helpers of host screens (MILESTONE-2 C.6, R-17). Screens call the api only through the ApiClient of the host
// context; the route constants come from the screen's own `routes.ts` (`[method, path]`), so no schema or zod code of
// @mscd/shared reaches the bundle (types only).
//
// - `call(client, route, {params, query, body, ifMatch, idempotencyKey})` sends one request and answers the client's
//   ApiResult: a problem keeps its slug, rule, message pair and field errors.
// - `fieldErrors(error)` maps `errors[].path` to messages, so a form shows each one next to its field.
// - `useList(route, options)` pages a list route of the D.1 shape `{items, page, pageSize, total}`.
// - `useMutation(run)` keeps a form open on failure: Save is disabled while busy, the error and field errors stay.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient, ApiError, ApiResult, HttpMethod, QueryValue } from '../data/api/ApiClient';
import { useHost } from './ui/host-context';

/** A route of a screen's `routes.ts`: `[method, path]` with `:name` segments. */
export type RouteRef = readonly [HttpMethod, string];

export interface CallOptions {
  params?: Record<string, string | number>;
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** The record's ETag, sent as `If-Match` (D.1 optimistic concurrency). */
  ifMatch?: string | null;
  /** Sent as `Idempotency-Key` on routes that accept one (D.1). */
  idempotencyKey?: string | null;
  signal?: AbortSignal;
}

export const NO_CLIENT: [string, string] = ['This action needs the server, which is not available here.', 'Tindakan ini memerlukan server, yang tidak tersedia di sini.'];

/** Sends one request of `route` through the host's client. Without a client (sample mode) it answers status 0. */
export function call<T = unknown>(client: ApiClient | null | undefined, route: RouteRef, options: CallOptions = {}): Promise<ApiResult<T>> {
  if (!client) return Promise.resolve({ ok: false, status: 0, error: { status: 0, message: NO_CLIENT } });
  const [method, path] = route;
  const headers: Record<string, string> = {};
  if (options.ifMatch) headers['If-Match'] = options.ifMatch;
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  return client.request<T>(method, path, {
    params: options.params,
    query: options.query,
    body: options.body,
    headers,
    signal: options.signal,
  });
}

/** A new `Idempotency-Key` value. */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Field errors of a problem by field: `body.name` and `name` both point to the message of `errors[].path`
 * `body.name`, and several messages of one path are joined. The whole-body errors (`body`) are under `''`.
 */
export function fieldErrors(error: ApiError | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of error?.errors ?? []) {
    const path = String(e.path ?? '');
    const short = path === 'body' ? '' : path.replace(/^(body|query|params)\./, '');
    for (const key of new Set([path, short])) out[key] = out[key] ? `${out[key]}; ${e.message}` : e.message;
  }
  return out;
}

/** One page of a D.1 list route. */
export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ListOptions {
  params?: Record<string, string | number>;
  query?: Record<string, QueryValue>;
  /** Rows per page (default 50, at most 200). */
  pageSize?: number;
  /** False while a parameter is not known yet; nothing is requested then. */
  enabled?: boolean;
}

export interface ListState<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  loading: boolean;
  error: ApiError | null;
  setPage(page: number): void;
  reload(): void;
}

/** Pages a list route with the host's client; a new set of params or query starts again at page 1. */
export function useList<T>(route: RouteRef, options: ListOptions = {}): ListState<T> {
  const { client } = useHost();
  const pageSize = Math.min(200, Math.max(1, options.pageSize ?? 50));
  const enabled = options.enabled !== false;
  const key = JSON.stringify([route, options.params ?? {}, options.query ?? {}, pageSize]);
  const [page, setPage] = useState(1);
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<{ data: Page<T> | null; loading: boolean; error: ApiError | null }>({ data: null, loading: enabled, error: null });
  const lastKey = useRef(key);
  if (lastKey.current !== key) {
    lastKey.current = key;
    if (page !== 1) setPage(1);
  }
  useEffect(() => {
    if (!enabled) return undefined;
    const abort = typeof AbortController !== 'undefined' ? new AbortController() : null;
    setState((s) => ({ ...s, loading: true, error: null }));
    call<Page<T>>(client, route, { params: options.params, query: { ...options.query, page, pageSize }, signal: abort?.signal }).then(
      (res) => {
        if (abort?.signal.aborted) return;
        if (res.ok) setState({ data: res.data, loading: false, error: null });
        else setState({ data: null, loading: false, error: res.error });
      },
      () => undefined,
    );
    return () => abort?.abort();
    // `key` stands for route, params, query and page size, so the effect runs again when one of them changes.
  }, [client, key, page, tick, enabled]);
  const data = state.data;
  const total = data?.total ?? 0;
  return {
    items: data?.items ?? [],
    total,
    page,
    pageSize,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    loading: state.loading,
    error: state.error,
    setPage: (p) => setPage(Math.max(1, Math.floor(p))),
    reload: () => setTick((t) => t + 1),
  };
}

export interface MutationState<I, O> {
  /** Runs the mutation; resolves with its result. A second call while one runs answers the first one's promise. */
  submit(input: I): Promise<ApiResult<O>>;
  busy: boolean;
  error: ApiError | null;
  /** `fieldErrors(error)`. */
  fields: Record<string, string>;
  reset(): void;
}

/** A write of a form: busy while it runs, its error and field errors kept until the next submit or `reset()`. */
export function useMutation<I, O = unknown>(run: (input: I) => Promise<ApiResult<O>>): MutationState<I, O> {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const running = useRef<Promise<ApiResult<O>> | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const submit = useCallback((input: I) => {
    if (running.current) return running.current;
    setBusy(true);
    setError(null);
    const p = run(input).then(
      (res) => {
        if (mounted.current) {
          setBusy(false);
          setError(res.ok ? null : res.error);
        }
        running.current = null;
        return res;
      },
      (e: unknown) => {
        running.current = null;
        if (mounted.current) setBusy(false);
        throw e;
      },
    );
    running.current = p;
    return p;
  }, [run]);
  return { submit, busy, error, fields: fieldErrors(error), reset: () => setError(null) };
}
