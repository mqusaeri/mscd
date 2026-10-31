#!/usr/bin/env node
// The stack of the API end-to-end project (build plan J.6, Milestone 2 M2-21), started by Playwright as the
// `webServer` of playwright.api.config.js and stopped by it (SIGTERM) when the run ends. It runs several lanes, so
// the tests run in parallel: each Playwright worker uses the lane of its `parallelIndex` (e2e-api/fixtures.js).
//
//   1. node tools/scripts/ensure-built.mjs (shared packages and development packs); the server, the mock providers
//      and the API web build are built only when their sources changed (tools/scripts/e2e-cache.mjs);
//   2. one PostgreSQL container (fsync, synchronous_commit and full_page_writes off: test settings only), one SeaweedFS
//      and one Mailpit per lane, each with a memory limit, labelled mscd.test=true, started at once, on random host
//      ports. The host reaches PostgreSQL over its Unix socket (its socket folder is shared with the host) and the
//      others on their own container addresses, so no query goes through Docker's port proxy; where the host cannot
//      (Docker Desktop), it uses the published ports;
//   3. the template database mscd_e2e_tpl (db bootstrap, migrate, `seed demo`) comes from a cache volume
//      `mscd-e2e-cache-pg-<key>` while its key matches (the migrations, the server sources the seed runs, the
//      development licences, the packs and the inputs below); a cold start builds that volume first. The cluster of the run is a copy of it, and each
//      lane gets mscd_e2e_<lane> created from the template with STRATEGY FILE_COPY;
//   4. per lane: mock providers (port 4310 + 10 x lane) with the demo fixtures and their DNS responder (UDP 4312 +
//      10 x lane), storage gateway (4311 + 10 x lane, TLS off, bucket mscd-vault-<lane>) and api (3174 + lane) from
//      apps/server/dist with profiles/test.yaml, test.endpoints_enabled, test.template_database and the administrator
//      URL file; the api's SMTP goes to the lane's Mailpit and its DNS lookups of email domains to the lane's responder;
//   5. one process (e2e-api/web-server.mjs) serves the API web build on 4174 + lane for every lane (its assets from
//      memory, with the cache and compression headers of production) and forwards /api to the lane's api.
//
// Nothing a lane writes is visible to another lane: its own database, bucket, mock provider state and Mailpit. No
// worker runs: jobs stay queued, and the suite asserts command results, not job effects. The addresses of the run are
// written to node_modules/.cache/mscd/e2e-api-stack.json (`lanes`, and lane 0 at the top level). On SIGTERM, SIGINT, a
// failed start, the end of a child process or the end of the process that started the stack, everything is stopped
// and every container and run volume is removed; the cache volumes stay. At start, containers and volumes of an
// earlier stack that was killed are removed once their mscd.test.expires label has passed (3 hours) and their name
// carries the same prefix.
//
// Environment: E2E_API_LANES sets the number of lanes (default: what the memory budget allows, at most 6,
// tools/scripts/e2e-budget.mjs; playwright.api.config.js sets it so its workers match); MSCD_TEST_CONTAINER_PREFIX
// names the containers and run volumes <prefix>e2e-<service>-<random> (default "mscd-"); MSCD_TEST_PG_IMAGE replaces
// postgres:16.15-alpine; E2E_STACK_SKIP_BUILD=1 skips the server and mock provider builds; E2E_STACK_CACHE=off builds
// the template and every build again without the caches; E2E_STACK_RESET=always makes every test reset recreate the
// database (MSCD_TEST_RESET_ALWAYS=1); E2E_STACK_TENANCY=multi runs every server command (seed, gateway, api) with
// tenancy mode multi and one schema per organisation, as profiles/saas.yaml does (default single); E2E_STACK_DIRECT=off
// reaches every container on its published port on 127.0.0.1.
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { apiLanesFor, budgetMb, memorySampler, peakLine } from '../../../tools/scripts/e2e-budget.mjs';
import { cacheOff, ensureMockBuilt, ensureServerBuilt, hashTree, serverKey, webBuild, withLock } from '../../../tools/scripts/e2e-cache.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, '..');
const ROOT = path.resolve(WEB, '../..');
const SERVER = path.join(ROOT, 'apps/server');
const MAIN = path.join(SERVER, 'dist/main.js');
const TEST_PROFILE = path.join(SERVER, 'profiles/test.yaml');
export const STATE_FILE = path.join(ROOT, 'node_modules/.cache/mscd/e2e-api-stack.json');

/** The ports of a lane: lane 0 keeps the ports of R-05 (web 4174, api 3174, mock 4310, gateway 4311, DNS 4312). */
export function lanePorts(lane) {
  return { web: 4174 + lane, api: 3174 + lane, mock: 4310 + 10 * lane, gateway: 4311 + 10 * lane, dns: 4312 + 10 * lane };
}
export const PORTS = lanePorts(0);
const LANES = Number(process.env.E2E_API_LANES) || apiLanesFor();
const TENANCY = process.env.E2E_STACK_TENANCY || 'single';
/** Profile overrides of a multi-tenant stack: tenancy mode multi with schema isolation, as saas.yaml runs. */
const TENANCY_ENV = TENANCY === 'multi' ? { MSCD__TENANCY__MODE: 'multi', MSCD__TENANCY__ISOLATION: 'schema' } : {};
const IMAGES = {
  postgres: process.env.MSCD_TEST_PG_IMAGE || 'postgres:16.15-alpine',
  seaweed: 'chrislusf/seaweedfs:4.48',
  mailpit: 'axllent/mailpit:v1.31.3',
};
/** Memory limits of the containers (M2-21: every test container has one). */
const LIMITS = { postgres: '1536m', seaweed: '512m', mailpit: '128m' };
/**
 * Test-only settings of the PostgreSQL server (M2-21): no fsync, no synchronous commit, no full page writes, so
 * clones and commits do not wait for the disk; no JIT compilation and no autovacuum, which only cost CPU in databases
 * that live for one test; room for the connections of every lane. Never in deploy/ or the integration test containers.
 */
const PG_SETTINGS = [
  ...['fsync=off', 'synchronous_commit=off', 'full_page_writes=off'],
  ...['jit=off', 'autovacuum=off', 'max_connections=400', 'max_wal_size=4GB', 'checkpoint_timeout=30min'],
].flatMap((setting) => ['-c', setting]);
const PGDATA_MOUNT = '/var/lib/postgresql/data';
const PGDATA = `${PGDATA_MOUNT}/pgdata`;
const PASSWORD_FILE = `${PGDATA_MOUNT}/mscd-admin.password`;
const CACHE_MARKER = `${PGDATA_MOUNT}/mscd-cache-complete`;
/** Bump when the cache volume layout changes. */
const CACHE_LAYOUT = 'e2e-template-1';
const VITE_PREVIEW_SCRIPT = path.join(HERE, 'web-server.mjs');
const TEMPLATE_DB = 'mscd_e2e_tpl';
const laneDb = (lane) => `mscd_e2e_${lane}`;
const laneBucket = (lane) => `mscd-vault-${lane}`;
/** Development role passwords (R-11), the same as the developer stack and the integration tests. */
const ROLE_PASSWORDS = { mscd_migrator: 'migrator-dev', mscd_app: 'app-dev', mscd_pack_installer: 'pack-dev' };
/** Leftovers of a killed run are removed by later test runs once this old (R-06). */
const CONTAINER_LIFETIME_MS = 3 * 60 * 60 * 1000;
const PREFIX = process.env.MSCD_TEST_CONTAINER_PREFIX || 'mscd-';
const RUN_ID = randomBytes(4).toString('hex');
const STARTED = Date.now();

const containers = [];
const volumes = [];
/** The memory in use on the machine while the stack runs; its peak is logged when the stack stops (M2-21). */
const memory = memorySampler({ intervalMs: 2000 });
const children = [];
let work = null;
let stopping = false;

function log(message) {
  process.stdout.write(`e2e-api stack: ${message}\n`);
}

function run(title, command, args, options = {}) {
  log(title);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-40).join('\n');
    throw new Error(`${title} failed (${result.error?.message ?? `exit ${result.status ?? result.signal}`})\n${output}`);
  }
  return result.stdout;
}

function docker(args, options = {}) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

const execFileAsync = promisify(execFile);
/** `docker` without blocking, so several containers start at once. */
async function dockerAsync(args) {
  return (await execFileAsync('docker', args, { encoding: 'utf8' })).stdout.trim();
}

/** Labels of everything this run creates: removed at its end, or by a later run once expired. */
function runLabels() {
  return ['--label', 'mscd.test=true', '--label', `mscd.test.expires=${Date.now() + CONTAINER_LIFETIME_MS}`, '--label', `mscd.e2e.run=${RUN_ID}`, '--label', `mscd.e2e.pid=${process.pid}`];
}

/** Creates a container with a random host port for each container port, starts it and returns its host ports. */
async function startContainer(service, image, ports, args = [], command = [], files = []) {
  const name = `${PREFIX}e2e-${service}-${RUN_ID}`;
  const publish = ports.flatMap((p) => ['-p', `127.0.0.1::${p}`]);
  const id = await dockerAsync(['create', '--name', name, ...runLabels(), ...publish, ...args, image, ...command]);
  containers.push(id);
  for (const [source, target] of files) await dockerAsync(['cp', source, `${id}:${target}`]);
  await dockerAsync(['start', id]);
  const mapped = { id };
  const lines = (await dockerAsync(['port', id])).split('\n');
  for (const p of ports) {
    // `docker port <id>` lists "5432/tcp -> 127.0.0.1:49153" per published port.
    const line = lines.find((l) => l.startsWith(`${p}/tcp -> 127.0.0.1:`)) ?? '';
    mapped[p] = Number(line.split(':').pop());
    if (!mapped[p]) throw new Error(`No host port for ${service} ${p}`);
  }
  log(`${service} started as ${name}`);
  return mapped;
}

async function waitFor(title, check, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  for (;;) {
    try {
      if (await check()) return;
    } catch (error) {
      last = error.message;
    }
    if (stopping) throw new Error('stopping');
    if (Date.now() > deadline) throw new Error(`${title} did not become ready within ${timeoutMs / 1000} s${last ? `: ${last}` : ''}`);
    await sleep(250);
  }
}

async function httpOk(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  await response.arrayBuffer();
  return response.ok;
}

const EXPECTED_NOISE = /^PostgreSQL idle client error: terminating connection due to administrator command$/;

/** A child process whose output is prefixed; its end before the stack stops ends the stack. */
function startChild(name, command, args, env, cwd = ROOT) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const forward = (stream, target) => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        // Every reset that recreates the database ends the idle connections of the api's pool (DROP DATABASE ... WITH
        // (FORCE)); expected noise.
        if (EXPECTED_NOISE.test(line)) continue;
        target.write(`[${name}] ${line}\n`);
      }
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  child.on('exit', (code, signal) => {
    if (stopping) return;
    process.stderr.write(`e2e-api stack: ${name} ended (${signal ?? `exit ${code}`}); stopping the stack\n`);
    void stop(1);
  });
  return child;
}

async function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  const deadline = Date.now() + 10_000;
  while (children.some((c) => c.exitCode === null && c.signalCode === null) && Date.now() < deadline) await sleep(100);
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  if (containers.length > 0) {
    try {
      docker(['rm', '-f', '-v', ...containers]);
      log(`removed ${containers.length} container(s)`);
    } catch (error) {
      process.stderr.write(`e2e-api stack: removing the containers failed: ${error.message}\n`);
    }
  }
  if (volumes.length > 0) {
    try {
      docker(['volume', 'rm', '-f', ...volumes]);
      log(`removed ${volumes.length} run volume(s)`);
    } catch (error) {
      process.stderr.write(`e2e-api stack: removing the run volumes failed: ${error.message}\n`);
    }
  }
  if (work) {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch (error) {
      // The PostgreSQL container owns the socket folder; a user without the right to delete its files leaves it.
      process.stderr.write(`e2e-api stack: removing ${work} failed: ${error.message}\n`);
    }
  }
  rmSync(STATE_FILE, { force: true });
  log(peakLine(`API suite (${LANES} lane(s))`, memory.stop(), budgetMb()));
  process.exit(code);
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => void stop(0));
// When Playwright goes away, its end of the output pipes closes: writes fail with EPIPE, which must not end this
// process before the containers are removed.
for (const stream of [process.stdout, process.stderr]) stream.on('error', () => undefined);
process.on('uncaughtException', (error) => {
  try {
    process.stderr.write(`e2e-api stack: ${error.stack ?? error.message}\n`);
  } catch {
    // the output may be gone
  }
  void stop(1);
});

/** Parent and grandparent (Playwright runs the command through a shell); the stack stops when either ends. */
function ancestors() {
  const pids = [process.ppid];
  try {
    const stat = readFileSync(`/proc/${process.ppid}/stat`, 'utf8');
    const grandparent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    if (grandparent > 1) pids.push(grandparent);
  } catch {
    // no /proc: only the parent is watched
  }
  return pids;
}
const WATCHED = ancestors();
setInterval(() => {
  for (const pid of WATCHED) {
    try {
      process.kill(pid, 0);
    } catch {
      log(`process ${pid} that started the stack has ended; stopping`);
      void stop(1);
      return;
    }
  }
}, 2000).unref();

/** A PostgreSQL URL; `socket` (a folder holding the server's Unix socket) wins over `host` and `port`. */
function pgUrl({ host, port, socket }, database, user = 'postgres', password) {
  const at = socket ? encodeURIComponent(socket) : `${host}:${port}`;
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${at}/${database}`;
}

/** True when the Unix socket at `file` accepts a connection. */
function socketAnswers(file, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = connect({ path: file });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * True when the host reaches `host:port` over TCP: a connection, or a refusal because nothing listens there yet. A
 * time-out or an unreachable network means the host does not route to that address.
 */
function routes(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', (error) => done(error.code === 'ECONNREFUSED'));
  });
}

/**
 * The address the host reaches a container port on (M2-21): the container's own address on its Docker network when
 * the host routes to it (Docker on Linux, as on this build host and in CI), which skips Docker's userland port proxy
 * that otherwise carries every query of every lane; else the published port on 127.0.0.1 (Docker Desktop).
 * E2E_STACK_DIRECT=off always uses the published port.
 */
async function addressOf(container, port) {
  const published = { host: '127.0.0.1', port: container[port] };
  if (process.env.E2E_STACK_DIRECT === 'off') return published;
  const ip = (await dockerAsync(['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}', container.id])).split(' ').find(Boolean);
  if (ip && (await routes(ip, port))) return { host: ip, port };
  return published;
}

/**
 * Leftovers of an earlier API E2E stack that was killed before it could remove them (R-06): containers or volumes
 * whose `mscd.test.expires` time has passed and whose name carries this run's MSCD_TEST_CONTAINER_PREFIX. A stack that
 * is still running, in this session or in another one on the same Docker host (its process may live in another PID
 * namespace), keeps its containers until they expire. Cache volumes carry no expiry label and are never removed here.
 */
function leftoverIds(rows, now = Date.now(), prefix = PREFIX) {
  return rows
    .split('\n')
    .filter(Boolean)
    .map((row) => row.split('\t'))
    .filter(([, name, expires]) => String(name || '').replace(/^\//, '').startsWith(prefix) && Number(expires) > 0 && Number(expires) <= now)
    .map(([id]) => id);
}

function removeLeftovers() {
  try {
    const rows = docker(['ps', '-a', '--filter', 'label=mscd.e2e.run', '--format', '{{.ID}}\t{{.Names}}\t{{.Label "mscd.test.expires"}}']);
    const list = leftoverIds(rows);
    if (list.length) {
      docker(['rm', '-f', '-v', ...list]);
      log(`removed ${list.length} expired container(s) left over by an earlier run`);
    }
  } catch {
    // no Docker answer: the start fails below with a clearer message
  }
  try {
    const rows = docker(['volume', 'ls', '--filter', 'label=mscd.e2e.run', '--format', '{{.Name}}\t{{.Name}}\t{{.Label "mscd.test.expires"}}']);
    const list = leftoverIds(rows);
    if (list.length) {
      docker(['volume', 'rm', '-f', ...list]);
      log(`removed ${list.length} expired volume(s) left over by an earlier run`);
    }
  } catch {
    // as above
  }
}

/**
 * Key of the template database: the key of the server build (every server source and the inputs of its prebuild, so a
 * change to code the seed runs, such as the password hasher, the credential sealing or the data keys, builds the
 * template again), the migrations, the test profile, the development secrets the seed encrypts with, the development
 * licences `seed demo` loads, the packs, the PostgreSQL image, the tenancy mode and the layout of the cache volume.
 */
function templateKey() {
  const inputs = ['apps/server/migrations', 'apps/server/profiles/test.yaml', 'apps/server/test/fixtures/secrets', 'packages/pack-tools/dev-licences', 'packs/dist'];
  return hashTree(inputs, {
    extra: `${serverKey()}\n${IMAGES.postgres}\n${TENANCY}\n${CACHE_LAYOUT}\n`,
  });
}

/** Name, labels and memory limit of a short-lived helper container (removed when it ends: `docker run --rm`). */
function utilityArgs(service) {
  return ['--name', `${PREFIX}e2e-${service}-${RUN_ID}`, ...runLabels(), '--memory', '256m'];
}

function volumeExists(name) {
  return docker(['volume', 'ls', '-q', '--filter', `name=^${name}$`]).split('\n').includes(name);
}

/** Environment of a server command against `database`. */
function serverEnvOf({ pgAddress, password, database, extra = {}, baseEnv, mail, s3Endpoint, lane = 0 }) {
  const ports = lanePorts(lane);
  const mock = `http://localhost:${ports.mock}`;
  return {
    ...baseEnv,
    MSCD_PROFILE_FILE: TEST_PROFILE,
    MSCD_DATABASE_ADMIN_URL: pgUrl(pgAddress, database, 'postgres', password),
    MSCD_DATABASE_MIGRATOR_URL: pgUrl(pgAddress, database, 'mscd_migrator', ROLE_PASSWORDS.mscd_migrator),
    MSCD_DATABASE_URL: pgUrl(pgAddress, database, 'mscd_app', ROLE_PASSWORDS.mscd_app),
    MSCD_DATABASE_PACK_URL: pgUrl(pgAddress, database, 'mscd_pack_installer', ROLE_PASSWORDS.mscd_pack_installer),
    MSCD__OBSERVABILITY__METRICS_PORT: 'null',
    MSCD__GATEWAY__VAULT__ENDPOINT: s3Endpoint,
    MSCD__GATEWAY__VAULT__BUCKET: laneBucket(lane),
    MSCD__GATEWAY__PROVIDERS__M365__GRAPH_BASE_URL: `${mock}/v1.0`,
    MSCD__GATEWAY__PROVIDERS__M365__LOGIN_BASE_URL: mock,
    MSCD__GATEWAY__PROVIDERS__GOOGLE__API_BASE_URL: mock,
    MSCD__GATEWAY__PROVIDERS__GOOGLE__TOKEN_URL: `${mock}/token`,
    MSCD__MAIL__SMTP__HOST: mail.host,
    MSCD__MAIL__SMTP__PORT: String(mail.port),
    ...TENANCY_ENV,
    ...extra,
  };
}

/**
 * psql as the superuser inside the PostgreSQL container: `sql` is one statement or a list, run one after the other in
 * one psql session (each in its own transaction, so CREATE DATABASE works), stopping at the first error.
 */
function psqlIn(container, database, sql) {
  const statements = Array.isArray(sql) ? sql : [sql];
  const title = `psql ${database}: ${statements[0].split('\n')[0].slice(0, 70)}${statements.length > 1 ? ` and ${statements.length - 1} more` : ''}`;
  return run(title, 'docker', ['exec', '-i', container, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database, ...statements.flatMap((statement) => ['-c', statement])]);
}

async function waitForPostgres(container) {
  await waitFor('PostgreSQL', async () => spawnSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres', '-h', '127.0.0.1'], { encoding: 'utf8' }).status === 0);
  await waitFor('PostgreSQL connections', async () => {
    psqlIn(container, 'postgres', 'select 1');
    return true;
  }, 60_000);
}

/**
 * Builds the template cache volume: a PostgreSQL cluster in `volume` with the migrated and seeded template, shut down
 * cleanly, with the administrator password and a marker file next to the data folder.
 */
async function buildTemplateCache(volume, { baseEnv, mail, s3Endpoint, ephemeral }) {
  const started = Date.now();
  if (volumeExists(volume)) docker(['volume', 'rm', '-f', volume]);
  const labels = ephemeral ? runLabels() : ['--label', 'mscd.e2e.cache=true', '--label', `mscd.e2e.cache.layout=${CACHE_LAYOUT}`];
  docker(['volume', 'create', ...labels, volume]);
  if (ephemeral) volumes.push(volume);
  const password = randomBytes(12).toString('hex');
  const pg = await startContainer('pgbuild', IMAGES.postgres, [5432], [
    '--memory', LIMITS.postgres, '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=postgres', '-e', `PGDATA=${PGDATA}`, '-v', `${volume}:${PGDATA_MOUNT}`,
  ], PG_SETTINGS);
  await waitForPostgres(pg.id);
  psqlIn(pg.id, 'postgres', `CREATE DATABASE ${TEMPLATE_DB}`);
  const env = serverEnvOf({ pgAddress: await addressOf(pg, 5432), password, database: TEMPLATE_DB, baseEnv, mail, s3Endpoint });
  run('db bootstrap', process.execPath, [MAIN, 'db', 'bootstrap'], { env });
  run('migrate', process.execPath, [MAIN, 'migrate'], { env });
  run('seed demo', process.execPath, [MAIN, 'seed', 'demo'], { env });
  psqlIn(pg.id, 'postgres', 'CHECKPOINT');
  docker(['exec', pg.id, 'sh', '-c', `printf '%s' '${password}' > ${PASSWORD_FILE}`]);
  // A clean shutdown, so the copy of the cluster starts without recovery (fsync is off).
  docker(['stop', '-t', '120', pg.id]);
  docker(['rm', '-f', '-v', pg.id]);
  containers.splice(containers.indexOf(pg.id), 1);
  docker(['run', '--rm', ...utilityArgs('cachemark'), '-v', `${volume}:${PGDATA_MOUNT}`, '--entrypoint', 'touch', IMAGES.postgres, CACHE_MARKER]);
  log(`template database built into ${volume} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

/** Creates the buckets of the lanes in the object store (the gateway writes to its lane's bucket). */
async function createBuckets(endpoint, accessKeyId, secretAccessKey) {
  const require = createRequire(path.join(SERVER, 'package.json'));
  const { S3Client, CreateBucketCommand } = require('@aws-sdk/client-s3');
  const client = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
  try {
    for (let lane = 0; lane < LANES; lane += 1) {
      await waitFor(`bucket ${laneBucket(lane)}`, async () => {
        try {
          await client.send(new CreateBucketCommand({ Bucket: laneBucket(lane) }));
        } catch (error) {
          if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(error.name)) throw error;
        }
        return true;
      }, 60_000);
    }
  } finally {
    client.destroy();
  }
}

/** The demo fixtures of the mock providers with the storage consent callback of every lane's web address. */
function laneFixtures() {
  const fixtures = JSON.parse(readFileSync(path.join(ROOT, 'tools/mock-providers/fixtures/demo.json'), 'utf8'));
  for (const credential of fixtures.credentials ?? []) {
    if (!Array.isArray(credential.redirectUris)) continue;
    for (let lane = 0; lane < LANES; lane += 1) {
      const uri = `http://localhost:${lanePorts(lane).web}/api/v1/admin/storage/repositories/oauth/callback`;
      if (!credential.redirectUris.includes(uri)) credential.redirectUris.push(uri);
    }
  }
  const file = path.join(work, 'mock-fixtures.json');
  writeFileSync(file, JSON.stringify(fixtures));
  return file;
}

/** Starts the mock providers, the storage gateway and the api of one lane. */
async function startLane(lane, { pgAddress, password, adminUrlFile, baseEnv, mail, s3Endpoint, fixtures }) {
  const ports = lanePorts(lane);
  const dns = `127.0.0.1:${ports.dns}`;
  const database = laneDb(lane);
  const env = (extra) => serverEnvOf({ pgAddress, password, database, extra, baseEnv, mail, s3Endpoint, lane });
  startChild(
    `mock-providers-${lane}`,
    process.execPath,
    [path.join(ROOT, 'tools/mock-providers/dist/server.js'), '--port', String(ports.mock), '--host', '127.0.0.1', '--fixtures', fixtures, '--dns-port', String(ports.dns)],
    baseEnv,
  );
  startChild(`storage-gateway-${lane}`, process.execPath, [MAIN, 'storage-gateway'], env({ MSCD__GATEWAY__PORT: String(ports.gateway) }));
  await waitFor(`mock providers of lane ${lane}`, () => httpOk(`http://127.0.0.1:${ports.mock}/_admin/health`));
  await waitFor(`mock DNS responder of lane ${lane}`, async () => {
    const response = await fetch(`http://127.0.0.1:${ports.mock}/_admin/dns`, { signal: AbortSignal.timeout(3000) });
    return response.ok && (await response.json()).address === dns;
  });
  startChild(
    `api-${lane}`,
    process.execPath,
    [MAIN, 'api'],
    env({
      MSCD__HTTP__PORT: String(ports.api),
      MSCD__HTTP__PUBLIC_URL: `http://localhost:${ports.web}`,
      // The TXT lookups of the email domain checks (M2-S11) go to the lane's mock responder only.
      MSCD__NETWORK__DNS_RESOLVERS: JSON.stringify([dns]),
      MSCD__STORAGE__GATEWAY__URL: `http://127.0.0.1:${ports.gateway}`,
      MSCD__TEST__ENDPOINTS_ENABLED: 'true',
      MSCD__TEST__TEMPLATE_DATABASE: TEMPLATE_DB,
      MSCD__TEST__ADMIN_DATABASE_URL_FILE: adminUrlFile,
      ...(process.env.E2E_STACK_RESET === 'always' ? { MSCD_TEST_RESET_ALWAYS: '1' } : {}),
    }),
  );
  await waitFor(`storage gateway of lane ${lane}`, () => httpOk(`http://127.0.0.1:${ports.gateway}/healthz`));
  await waitFor(`api of lane ${lane}`, () => httpOk(`http://127.0.0.1:${ports.api}/readyz`));
}

const seconds = (since) => `${((Date.now() - since) / 1000).toFixed(1)} s`;

async function main() {
  if (TENANCY !== 'single' && TENANCY !== 'multi') throw new Error(`E2E_STACK_TENANCY must be single or multi, got "${TENANCY}"`);
  if (!Number.isInteger(LANES) || LANES < 1 || LANES > 9) throw new Error(`E2E_API_LANES must be a whole number from 1 to 9, got "${process.env.E2E_API_LANES}"`);
  log(`${LANES} lane(s), tenancy ${TENANCY}`);
  removeLeftovers();
  work = mkdtempSync(path.join(tmpdir(), 'mscd-e2e-api-'));

  // 1. Builds, each only when its sources changed. They run while the containers start; the server must be built
  // before the template, the rest before the lanes.
  run('ensure-built (shared packages and development packs)', process.execPath, [path.join(ROOT, 'tools/scripts/ensure-built.mjs'), '--quiet']);
  const skipBuild = process.env.E2E_STACK_SKIP_BUILD === '1';
  const serverBuilt = skipBuild ? Promise.resolve(false) : ensureServerBuilt({ log });
  const mockBuilt = skipBuild ? Promise.resolve(false) : ensureMockBuilt({ log });
  const webDist = webBuild('api', { log });
  // A failed build is reported where it is awaited; this keeps an early failure from being an unhandled rejection.
  for (const pending of [serverBuilt, mockBuilt, webDist]) pending.catch(() => undefined);

  // 2. Object store and Mailpit of each lane.
  const s3Access = readFileSync(path.join(SERVER, 'test/fixtures/secrets/s3.access'), 'utf8').trim();
  const s3Secret = readFileSync(path.join(SERVER, 'test/fixtures/secrets/s3.secret'), 'utf8').trim();
  const s3Config = path.join(work, 's3.json');
  writeFileSync(
    s3Config,
    JSON.stringify({ identities: [{ name: 'mscd', credentials: [{ accessKey: s3Access, secretKey: s3Secret }], actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'] }] }),
  );
  const seaweedStarted = startContainer('seaweedfs', IMAGES.seaweed, [8333], ['--memory', LIMITS.seaweed], ['mini', '-dir=/data', '-s3.config=/etc/seaweedfs/s3.json', `-bucket=${laneBucket(0)}`], [
    [s3Config, '/etc/seaweedfs/s3.json'],
  ]);
  const [seaweed, ...mailContainers] = await Promise.all([
    seaweedStarted,
    ...Array.from({ length: LANES }, (_, lane) => startContainer(`mailpit-${lane}`, IMAGES.mailpit, [1025, 8025], ['--memory', LIMITS.mailpit])),
  ]);
  // The addresses the host reaches the containers on (their own addresses where the host routes to them).
  const [seaweedAddress, ...mailAddresses] = await Promise.all([addressOf(seaweed, 8333), ...mailContainers.flatMap((c) => [addressOf(c, 1025), addressOf(c, 8025)])]);
  const s3Endpoint = `http://${seaweedAddress.host}:${seaweedAddress.port}`;
  const mails = mailContainers.map((_, lane) => ({ smtp: mailAddresses[2 * lane], api: mailAddresses[2 * lane + 1] }));
  log(`containers reached ${seaweedAddress.host === '127.0.0.1' ? 'through their published ports' : 'on their own addresses'}`);
  const baseEnv = { ...process.env };
  for (const key of Object.keys(baseEnv)) if (key.startsWith('MSCD_') && key !== 'MSCD_BUILD_CA') delete baseEnv[key];
  for (const key of ['E2E_API_LANES', 'E2E_STACK_RESET', 'E2E_STACK_CACHE']) delete baseEnv[key];

  // 3. The template database (from the cache volume while its key matches) and the cluster of this run.
  await serverBuilt;
  const templateStarted = Date.now();
  const key = templateKey();
  const ephemeral = cacheOff();
  const cacheVolume = ephemeral ? `${PREFIX}e2e-pgcache-${RUN_ID}` : `mscd-e2e-cache-pg-${key}`;
  const runVolume = `${PREFIX}e2e-pgdata-${RUN_ID}`;
  docker(['volume', 'create', ...runLabels(), runVolume]);
  volumes.push(runVolume);
  // Copies the cache volume into the run volume when it holds a complete template (its marker file), in one helper
  // container; false when it does not.
  const markerInCopy = `/from/${path.posix.relative(PGDATA_MOUNT, CACHE_MARKER)}`;
  const copyFromCache = (whenComplete) => {
    if (whenComplete && !volumeExists(cacheVolume)) return false;
    const script = `${whenComplete ? `test -f ${markerInCopy} || exit 3; ` : ''}cp -a /from/. /to/`;
    const copied = spawnSync('docker', ['run', '--rm', ...utilityArgs('cachecopy'), '-v', `${cacheVolume}:/from:ro`, '-v', `${runVolume}:/to`, '--entrypoint', 'sh', IMAGES.postgres, '-c', script], { encoding: 'utf8' });
    if (whenComplete && copied.status === 3) return false;
    if (copied.status !== 0) throw new Error(`copying the template cache failed: ${`${copied.stdout ?? ''}${copied.stderr ?? ''}`.trim()}`);
    return true;
  };
  let cacheHit = !ephemeral && copyFromCache(true);
  if (!cacheHit) {
    await withLock(`template-${key}`, async () => {
      if (!ephemeral && copyFromCache(true)) {
        cacheHit = true;
        return;
      }
      log(ephemeral ? 'template cache off (E2E_STACK_CACHE=off): building the template' : `no template cache for key ${key}: building it`);
      await buildTemplateCache(cacheVolume, { baseEnv, mail: mails[0].smtp, s3Endpoint, ephemeral });
    }, { log });
    if (!cacheHit) copyFromCache(false);
  }
  // The server's Unix socket folder is shared with the host (M2-21): the api and the reset reach PostgreSQL over the
  // socket, a third faster per query than over the Docker network and without its password exchange per connection.
  const socketDir = path.join(work, 'pgsock');
  mkdirSync(socketDir, { recursive: true, mode: 0o777 });
  chmodSync(socketDir, 0o777);
  const pg = await startContainer('postgres', IMAGES.postgres, [5432], [
    '--memory', LIMITS.postgres, '-e', `PGDATA=${PGDATA}`, '-v', `${runVolume}:${PGDATA_MOUNT}`, '-v', `${socketDir}:/var/run/postgresql`,
  ], PG_SETTINGS);
  await waitForPostgres(pg.id);
  // Over the socket where the host sees it (Docker on Linux); else over TCP (Docker Desktop, or E2E_STACK_DIRECT=off).
  const viaSocket = process.env.E2E_STACK_DIRECT !== 'off' && (await socketAnswers(path.join(socketDir, '.s.PGSQL.5432')));
  const pgAddress = viaSocket ? { socket: socketDir } : await addressOf(pg, 5432);
  log(`PostgreSQL reached ${viaSocket ? 'over its Unix socket' : `on ${pgAddress.host}:${pgAddress.port}`}`);
  const password = docker(['exec', pg.id, 'cat', PASSWORD_FILE]);
  const lanesSql = [];
  for (let lane = 0; lane < LANES; lane += 1) {
    const db = laneDb(lane);
    lanesSql.push(
      `CREATE DATABASE ${db} TEMPLATE ${TEMPLATE_DB} STRATEGY FILE_COPY`,
      // Database privileges are not copied by CREATE DATABASE ... TEMPLATE (C.2).
      `GRANT CONNECT, CREATE ON DATABASE ${db} TO mscd_migrator`,
      `GRANT CONNECT ON DATABASE ${db} TO mscd_app, mscd_pack_installer`,
    );
  }
  psqlIn(pg.id, 'postgres', lanesSql);
  log(`template ${cacheHit ? 'from the cache volume' : 'built'} and ${LANES} lane database(s) created in ${seconds(templateStarted)}`);
  const adminUrlFile = path.join(work, 'db-admin.url');
  writeFileSync(adminUrlFile, pgUrl(pgAddress, 'postgres', 'postgres', password), { mode: 0o600 });

  // 4. Buckets, then the lanes, all at once.
  await createBuckets(s3Endpoint, s3Access, s3Secret);
  await mockBuilt;
  const fixtures = laneFixtures();
  const lanesStarted = Date.now();
  await Promise.all(
    Array.from({ length: LANES }, (_, lane) => startLane(lane, { pgAddress, password, adminUrlFile, baseEnv, mail: mails[lane].smtp, s3Endpoint, fixtures })),
  );
  log(`${LANES} lane(s) ready in ${seconds(lanesStarted)}`);

  const lanes = Array.from({ length: LANES }, (_, lane) => {
    const ports = lanePorts(lane);
    return {
      lane,
      web: `http://localhost:${ports.web}`,
      api: `http://127.0.0.1:${ports.api}`,
      mock: `http://127.0.0.1:${ports.mock}`,
      dns: `127.0.0.1:${ports.dns}`,
      mailApi: `http://${mails[lane].api.host}:${mails[lane].api.port}/api/v1`,
    };
  });
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ runId: RUN_ID, tenancy: TENANCY, ...lanes[0], lanes }, null, 2));

  // 5. The web app in API mode, one server per lane in one process.
  const dist = await webDist;
  assertNoSampleMaterial(dist);
  startChild('web', process.execPath, [VITE_PREVIEW_SCRIPT, '--dist', dist, ...lanes.flatMap((l, lane) => ['--lane', `${lanePorts(lane).web}=${l.api}`])], baseEnv, WEB);
  for (const l of lanes) await waitFor(`web of lane ${l.lane}`, () => httpOk(`${l.web}/api/v1/system/profile`));
  log(`ready in ${seconds(STARTED)} (tenancy ${TENANCY}, ${LANES} lane(s)): web ${lanes.map((l) => l.web).join(', ')}`);
}

// Texts only the sample build carries: the sample organisations of src/data/sample-orgs.js and the sample licence id
// of the Licence screen's sample adapter. An api build holds no sample code or records (R-13, createDataSource.js);
// a screen that imports its sample.ts statically instead of in the build's sample branch (C.6) puts them back.
const SAMPLE_MARKERS = ['PT Nusantara Digital Teknologi', 'PT Bank Sentosa Digital', 'RS Medika Nusantara', 'LIC-SAMPLE'];
function assertNoSampleMaterial(dist) {
  const dir = path.join(dist, 'assets');
  const hits = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    const text = readFileSync(path.join(dir, name), 'utf8');
    for (const marker of SAMPLE_MARKERS) if (text.includes(marker)) hits.push(`${name} (${marker})`);
  }
  if (hits.length) throw new Error(`the api build holds sample material: ${hits.join(', ')}`);
  log('the api build holds no sample material');
}

main().catch((error) => {
  if (!stopping) process.stderr.write(`e2e-api stack: ${error.stack ?? error.message}\n`);
  void stop(1);
});
