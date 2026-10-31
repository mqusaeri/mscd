// Test helpers: repository paths, a small RFC 4180 CSV reader for the pack sources, and readers of the plan tables
// that the contract must match: the build plan (Milestone 1, cited as BP), section J of the Milestone 2 plan
// (docs/platform/MILESTONE-2.md) and section J of the Milestone 3 plan (docs/platform/MILESTONE-3.md), merged so the
// shared tests stay as strict as in Milestone 1 (Milestone 2 F, M2-02; Milestone 3 F, M3-01). A Milestone 3 CHECK list
// replaces the earlier list of the same column, and a Milestone 3 machine row replaces the earlier row of the same entity.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export function readRepoFile(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

/** Parses RFC 4180 CSV with LF line endings into arrays of fields; throws on a stray quote. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"') {
      if (field !== '') throw new Error(`Quote inside an unquoted field at offset ${i}`);
      quoted = true; i += 1; continue;
    }
    if (c === ',') { row.push(field); field = ''; i += 1; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += c; i += 1;
  }
  if (quoted) throw new Error('Unterminated quoted field');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** CSV text to records keyed by the header row. */
export function csvRecords(text: string): { header: string[]; records: Record<string, string>[] } {
  const [header = [], ...rows] = parseCsv(text);
  return {
    header,
    records: rows.map((r) => {
      if (r.length !== header.length) throw new Error(`Row has ${r.length} fields, header has ${header.length}`);
      return Object.fromEntries(header.map((h, i) => [h, r[i] as string]));
    }),
  };
}

export const BUILD_PLAN = 'docs/platform/BUILD-PLAN.md';
export const MILESTONE_2_PLAN = 'docs/platform/MILESTONE-2.md';
export const MILESTONE_3_PLAN = 'docs/platform/MILESTONE-3.md';

function sectionOf(file: string, startHeading: string, endHeading: string): string {
  const md = readRepoFile(file);
  const start = md.indexOf(startHeading);
  const end = md.indexOf(endHeading, start + 1);
  if (start < 0 || end < 0) throw new Error(`Headings not found in ${file}: ${startHeading} / ${endHeading}`);
  return md.slice(start, end);
}

/** The text of the build plan between two headings (start inclusive, end exclusive). */
export function planSection(startHeading: string, endHeading: string): string {
  return sectionOf(BUILD_PLAN, startHeading, endHeading);
}

/** The text of the Milestone 2 plan between two headings (start inclusive, end exclusive). */
export function m2Section(startHeading: string, endHeading: string): string {
  return sectionOf(MILESTONE_2_PLAN, startHeading, endHeading);
}

/** The text of the Milestone 3 plan between two headings (start inclusive, end exclusive). */
export function m3Section(startHeading: string, endHeading: string): string {
  return sectionOf(MILESTONE_3_PLAN, startHeading, endHeading);
}

/** Backticked codes of a line of text. */
export function codesOf(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
}

/** The row of a two-column table whose first cell starts with `label` (`| Problem slugs | ... |`). */
export function tableRow(section: string, label: string): string {
  const row = section.split('\n').find((l) => l.startsWith(`| ${label}`));
  if (!row) throw new Error(`No table row ${label}`);
  return row;
}

/** CHECK lists of the `CREATE TABLE` fragments of some SQL, keyed `table.column` (schema prefix dropped). */
function checkListsOf(sql: string, out: Map<string, string[]>): Map<string, string[]> {
  for (const statement of sql.split(/CREATE TABLE /).slice(1)) {
    const table = (statement.match(/^([\w.]+)/)?.[1] ?? '').replace(/^(platform|ref)\./, '');
    const re = /(\w+)\s+(?:varchar\(\d+\)|text\[\])[^,]*?CHECK\s*\(\s*(?:\1\s+IN\s*\(([^)]*)\)|cardinality\(\1\)\s*>=\s*\d+\s+AND\s+\1\s*<@\s*ARRAY\[([^\]]*)\]|\1\s*<@\s*ARRAY\[([^\]]*)\])/g;
    for (const m of statement.matchAll(re)) {
      const list = (m[2] ?? m[3] ?? m[4] ?? '').split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
      out.set(`${table}.${m[1]}`, list);
    }
  }
  return out;
}

function sqlBlocks(text: string): string {
  return [...text.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
}

/** CHECK lists of the Milestone 2 migrations (J.7), keyed `table.column`. */
export function m2CheckLists(): Map<string, string[]> {
  return checkListsOf(sqlBlocks(m2Section('### J.7 CHECK lists', '### J.8')), new Map());
}

/** CHECK lists of the Milestone 3 migrations (J.7), keyed `table.column`. */
export function m3CheckLists(): Map<string, string[]> {
  return checkListsOf(sqlBlocks(m3Section('### J.7 CHECK lists', '### J.8')), new Map());
}

/**
 * Every `varchar` or `text[]` column CHECK list of the DDL in C.4 to C.6, keyed `table.column`, with the lists of
 * Milestone 2 J.7 and then Milestone 3 J.7 merged in: a later list replaces the earlier list of the same column.
 */
export function planCheckLists(): Map<string, string[]> {
  const out = checkListsOf(sqlBlocks(planSection('### C.4 Platform migrations', '### C.6a')), new Map());
  for (const [column, values] of m2CheckLists()) out.set(column, values);
  for (const [column, values] of m3CheckLists()) out.set(column, values);
  return out;
}

export interface PermissionRow {
  permissions: string[];
  scope: string;
  cells: string[];
}

function permissionRowsOf(part: string): PermissionRow[] {
  const rows: PermissionRow[] = [];
  for (const line of part.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    const permissions = [...(cells[0] ?? '').matchAll(/`([a-z_.]+)`/g)].map((m) => m[1] as string);
    rows.push({ permissions, scope: cells[1] ?? '', cells: cells.slice(2) });
  }
  return rows;
}

/** Rows of the Milestone 2 permission matrix (J.2), in the F.6 format. */
export function m2PermissionRows(): PermissionRow[] {
  return permissionRowsOf(m2Section('### J.2 Permission matrix', '### J.3'));
}

/** Rows of the Milestone 3 permission matrix (J.2), in the F.6 format. */
export function m3PermissionRows(): PermissionRow[] {
  return permissionRowsOf(m3Section('### J.2 Permission matrix', '### J.3'));
}

/**
 * Rows of the F.6 permission matrix, then the rows of Milestone 2 J.2 and of Milestone 3 J.2: permission codes, scope
 * cell and the eleven role cells.
 */
export function planPermissionRows(): PermissionRow[] {
  return [...permissionRowsOf(planSection('### F.6 Permission matrix', '### F.7')), ...m2PermissionRows(), ...m3PermissionRows()];
}

export interface PlanEndpoint {
  method: string;
  /** Path as written in the plan, without query string (`/ms/{ms}/documents`). */
  path: string;
}

/** Method and path of a table cell such as `POST /a/{id}/approve`, `/reject` (a sibling) or `/{id}` (a child). */
function endpointsOfCell(cell: string, defaultMethod: string | null): PlanEndpoint[] {
  const out: PlanEndpoint[] = [];
  for (const [, code] of cell.matchAll(/`([^`]+)`/g)) {
    const text = (code as string).replace(/\?.*$/, '').trim();
    const full = text.match(/^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/);
    if (full) {
      out.push({ method: full[1] as string, path: full[2] as string });
      continue;
    }
    if (!text.startsWith('/')) continue;
    const previous = out[out.length - 1];
    if (previous) {
      // `/{id}` after a collection is a child; `/reject` after `/approve` is a sibling.
      const parent = text.startsWith('/{') ? previous.path : previous.path.replace(/\/[^/]+$/, '');
      out.push({ method: previous.method, path: `${parent}${text}` });
    } else if (defaultMethod) {
      out.push({ method: defaultMethod, path: text });
    }
  }
  return out;
}

/** A route of the Milestone 2 or Milestone 3 endpoint table (J.1): method and path, route id and building package. */
export interface M2PlanRoute extends PlanEndpoint {
  id: string;
  owner: string;
}
export type M3PlanRoute = M2PlanRoute;

/** The rows of an endpoint table in the J.1 format: `| \`METHOD /path\` | \`route.id\` | owner |`. */
function planRoutesOf(part: string): M2PlanRoute[] {
  const out: M2PlanRoute[] = [];
  for (const line of part.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    const [endpoint] = endpointsOfCell(cells[0] ?? '', null);
    const id = codesOf(cells[1] ?? '')[0];
    if (!endpoint || !id) throw new Error(`Unreadable J.1 row: ${line}`);
    out.push({ ...endpoint, id, owner: cells[2] ?? '' });
  }
  return out;
}

/** Every row of the Milestone 2 endpoint table (J.1). */
export function m2PlanRoutes(): M2PlanRoute[] {
  return planRoutesOf(m2Section('### J.1 Endpoints', '### J.2'));
}

/**
 * Every row of the Milestone 3 endpoint table (J.1): paths below `/api/v1`, and the storage gateway routes, whose paths
 * start with `/v1/` and carry no `/api/v1` prefix.
 */
export function m3PlanRoutes(): M3PlanRoute[] {
  return planRoutesOf(m3Section('### J.1 Endpoints', '### J.2'));
}

/** The Milestone 3 J.1 rows of `/api/v1` routes (the rows whose path does not start with `/v1/`). */
export function m3ApiRoutes(): M3PlanRoute[] {
  return m3PlanRoutes().filter((r) => !r.path.startsWith('/v1/'));
}

/** The Milestone 3 J.1 rows of storage gateway routes (paths starting with `/v1/`). */
export function m3GatewayRoutes(): M3PlanRoute[] {
  return m3PlanRoutes().filter((r) => r.path.startsWith('/v1/'));
}

/** Every endpoint of the D.3 tables, of Milestone 2 J.1 and of Milestone 3 J.1 (paths below `/api/v1`), health and metrics excluded. */
export function planApiEndpoints(): PlanEndpoint[] {
  return [...bpApiEndpoints(), ...[...m2PlanRoutes(), ...m3ApiRoutes()].map(({ method, path }) => ({ method, path }))];
}

/** Every endpoint of the BP D.3 tables (paths below `/api/v1`), health and metrics excluded. */
export function bpApiEndpoints(): PlanEndpoint[] {
  const part = planSection('### D.3 Endpoints', '**Health and metrics**');
  const out: PlanEndpoint[] = [];
  let defaultMethod: string | null = null;
  for (const line of part.split('\n')) {
    if (line.startsWith('| Path |')) defaultMethod = 'GET';
    else if (line.startsWith('| Method and path |')) defaultMethod = null;
    if (!line.startsWith('| `')) continue;
    const first = line.split('|')[1] ?? '';
    out.push(...endpointsOfCell(first, defaultMethod));
  }
  return out;
}

/** Every endpoint of the BP D.5 gateway protocol table. */
export function bpGatewayEndpoints(): PlanEndpoint[] {
  const part = planSection('### D.5 Storage gateway protocol', '## E. Worker jobs');
  const out: PlanEndpoint[] = [];
  for (const line of part.split('\n')) {
    if (!line.startsWith('| `')) continue;
    out.push(...endpointsOfCell(line.split('|')[1] ?? '', null).filter((e) => e.path.startsWith('/v1/')));
  }
  return out;
}

/** Every endpoint of the D.5 gateway protocol table, then the gateway rows of Milestone 3 J.1. */
export function planGatewayEndpoints(): PlanEndpoint[] {
  return [...bpGatewayEndpoints(), ...m3GatewayRoutes().map(({ method, path }) => ({ method, path }))];
}

/** Route path in Fastify form (`/api/v1/ms/:ms`) of a plan path (`/ms/{ms}`). */
export function fastifyPath(planPath: string, prefix: string): string {
  return `${prefix}${planPath.replace(/\{([A-Za-z]+)\}/g, ':$1')}`;
}

/**
 * The work package ids of BP K.2 (`#### WP-nn`), of Milestone 2 G.2 and K.6 (`#### M2-nn`, `#### M2-Snn`) and of
 * Milestone 3 G.2 and K.3 (`#### M3-nn`, `#### M3-Mnn`).
 */
export function planWorkPackages(): string[] {
  return [
    ...[...readRepoFile(BUILD_PLAN).matchAll(/^#### (WP-\d\d)\b/gm)].map((m) => m[1] as string),
    ...[...readRepoFile(MILESTONE_2_PLAN).matchAll(/^#### (M2-S?\d\d)\b/gm)].map((m) => m[1] as string),
    ...[...readRepoFile(MILESTONE_3_PLAN).matchAll(/^#### (M3-M?\d\d)\b/gm)].map((m) => m[1] as string),
  ];
}

/** Problem slugs with their status: the 17 of BP D.1, then the slugs Milestone 2 J.6 and Milestone 3 J.6 add. */
export function planProblemSlugs(): [string, number][] {
  const read = (row: string) => [...row.matchAll(/`([a-z-]+)` (\d{3})/g)].map((m) => [m[1] as string, Number(m[2])] as [string, number]);
  return [
    ...read(tableRow(planSection('### D.1 Conventions', '### D.2'), 'Problem slugs')),
    ...read(tableRow(m2Section('### J.6 Problems and rules', '### J.7'), 'Problem slugs')),
    ...read(tableRow(m3Section('### J.6 Problems and rules', '### J.7'), 'Problem slugs')),
  ];
}

/** Platform rule ids of the problem `rule` member: BP D.1, then Milestone 2 J.6, then Milestone 3 J.6. */
export function planPlatformRuleIds(): string[] {
  const read = (row: string) => codesOf(row.slice(row.indexOf('`rule`'))).filter((c) => /^[A-Z]+(-[A-Z]+)+$/.test(c));
  return [
    ...read(tableRow(planSection('### D.1 Conventions', '### D.2'), 'Errors')),
    ...read(tableRow(m2Section('### J.6 Problems and rules', '### J.7'), 'Errors')),
    ...read(tableRow(m3Section('### J.6 Problems and rules', '### J.7'), 'Errors')),
  ];
}

/** Warning rule ids: the business rules of BP D.1, then the rule ids of Milestone 2 J.6 and of Milestone 3 J.6. */
export function planWarningRuleIds(): string[] {
  const ruleIds = (section: string) => codesOf(tableRow(section, 'Warnings')).filter((c) => /^[A-Z]+(-[A-Z]+)+$/.test(c));
  return [
    ...[...tableRow(planSection('### D.1 Conventions', '### D.2'), 'Warnings').matchAll(/BR-\d\d/g)].map((m) => m[0]),
    ...ruleIds(m2Section('### J.6 Problems and rules', '### J.7')),
    ...ruleIds(m3Section('### J.6 Problems and rules', '### J.7')),
  ];
}

/** Job names of BP E.2, then of Milestone 2 J.3, then of Milestone 3 J.3, in plan order. */
export function planJobNames(): string[] {
  const read = (part: string) => part.split('\n').filter((l) => /^\| `[a-z-]+\.[a-z-]+`/.test(l)).map((l) => codesOf(l)[0] as string);
  return [...read(planSection('### E.2 Jobs', '### E.3')), ...read(m2Section('### J.3 Jobs', '### J.4')), ...read(m3Section('### J.3 Jobs', '### J.4'))];
}

/** Notification kinds of BP E.6, Milestone 2 J.4 and Milestone 3 J.4 (first column codes). */
export function planNotificationKinds(): string[] {
  const read = (part: string) => part.split('\n').filter((l) => l.startsWith('| `')).flatMap((l) => codesOf(l.split('|')[1] ?? ''));
  return [
    ...read(planSection('### E.6 Notifications', '### E.7')), ...read(m2Section('### J.4 Notifications', '### J.5')),
    ...read(m3Section('### J.4 Notifications', '### J.5')),
  ];
}

/** Audit actions of the BP F.11 actions line and of the Milestone 2 and Milestone 3 J.5 lists. */
export function planAuditActions(): string[] {
  const actionCodes = (line: string) => codesOf(line).filter((c) => /^[a-z_]+(\.[a-z_]+)+$/.test(c) && c !== 'platform.audit_log');
  const f11 = planSection('### F.11 Keys, secrets and the audit chain', '### F.12').split('\n').find((l) => l.startsWith('- Actions:')) as string;
  const j5 = m2Section('### J.5 Audit actions', '### J.6').split('\n').filter((l) => l.startsWith('- '));
  const m3j5 = m3Section('### J.5 Audit actions', '### J.6').split('\n').filter((l) => l.startsWith('- '));
  return [...actionCodes(f11), ...j5.flatMap(actionCodes), ...m3j5.flatMap(actionCodes)];
}

/** Machine rows of a state machine table: entity with its owner work package (`WP-nn`, `M2-nn`, `M2-Snn` or `M3-nn`). */
function machineRowsOf(part: string): [string, string][] {
  return [...part.matchAll(/^\| `([a-z_]+\.[a-z_]+)`(?:, `([a-z_]+\.[a-z_]+)`)? \(((?:WP|M2|M3)-S?\d\d)\)/gm)].flatMap((m) => [
    [m[1] as string, m[3] as string] as [string, string],
    ...(m[2] ? [[m[2], m[3] as string] as [string, string]] : []),
  ]);
}

/** The machine rows of Milestone 3 J.8 (entity and owner). */
export function m3Machines(): [string, string][] {
  return machineRowsOf(m3Section('### J.8 State machines', '## K. Maintenance track'));
}

/**
 * Machine entities with their owner work package: the rows of BP C.13, then of Milestone 2 J.8, then of Milestone 3
 * J.8; a later row replaces the earlier row of the same entity (Milestone 3 J.8 replaces `organization.status`).
 */
export function planMachines(): [string, string][] {
  const merged = new Map<string, string>();
  for (const [entity, owner] of [
    ...machineRowsOf(planSection('### C.13 State machines', '## D. API contract')),
    ...machineRowsOf(m2Section('### J.8 State machines', '## K. SaaS')),
    ...m3Machines(),
  ]) {
    merged.delete(entity);
    merged.set(entity, owner);
  }
  return [...merged];
}
