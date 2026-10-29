#!/usr/bin/env node
// SaaS end-to-end run of MSCD (Milestone 2 plan K.6, M2-S13).
//
// 1. Starts the SaaS test stack of M2-S02 (deploy/scripts/test/saas-stack.sh up): release-flavour images built with a
//    throwaway key set, Caddy with its own local certificate authority (tls internal), Mailpit as the mail relay.
// 2. Runs the M2-S02 checks on it (saas-stack.sh check: tenancy multi, ports, TLS, HSTS, rate limits, logs, the audit
//    anchor key).
// 3. Adds the run overlay <state folder>/compose.run.yml: the provider mocks (image built here, tagged under
//    localhost/<project>/ so saas-stack.sh down removes it) answering DNS on UDP 5353 at a fixed address, which the
//    api and the worker use as their only resolver (network.dns_resolvers, M2-S11); Mailpit's API on 127.0.0.1; the
//    privacy notice and terms links of the sign-in page (MSCD_LEGAL_PRIVACY_URL and MSCD_LEGAL_TERMS_URL in .env).
//    With --with-ops also the monitoring overlay docker-compose.ops.yml (M2-S08), with the alerts to the app's
//    Mailpit and the HTTPS probe pointed at Caddy over the edge network.
// 4. Runs "saas-ops.sh create-operator" locally, as ops-cli.yml runs it on a server (--input-stdin --public): the
//    allow-list script of M2-S09 against a view of this stack as an install folder. The set-password email goes to
//    Mailpit.
// 5. Runs tests/saas.spec.mjs with Playwright (saas.config.mjs): every step in the browser.
// 6. With --with-ops: every Prometheus target is up (Prometheus API inside its container), and the HTTPS probe of the
//    public URL succeeds.
// 7. Removes everything (saas-stack.sh down): on success, on failure and on Ctrl-C.
//
// The stack publishes 127.0.0.1:18080, 18443 and 18025 like the other Compose test stacks, so run it under the host
// lock (R-05): flock /tmp/mscd-stack.lock npm run saas -w @mscd/smoke [-- --with-ops]
//
// Usage: npm run saas -w @mscd/smoke [-- --with-ops]
//        node tools/smoke/run-saas.mjs [options] [-- <Playwright arguments>]
//   --with-ops          also start the monitoring overlay and check that every Prometheus target is up
//   --build-ca <file>   CA certificate of a TLS-inspecting proxy for the image builds (default: $MSCD_BUILD_CA)
//   --keep              leave the stack running after the run (same as SMOKE_KEEP=1; remove it with --down)
//   --down              only remove the stack of an earlier --keep run, then exit
//   -h, --help          show this text
// Arguments after "--" go to "playwright test" (for example --headed or --trace on).
//
// Environment:
//   MSCD_SAAS_TEST_PROJECT     Compose project, also the image path (default mscd-saas-run)
//   MSCD_SAAS_TEST_DIR         state folder of the stack (default /tmp/mscd-saas-run): keys, secrets, .env, the run
//                              state; a plain absolute path below /tmp, /var/tmp or $TMPDIR, deleted at the end
//   MSCD_SAAS_TEST_HTTP_PORT, MSCD_SAAS_TEST_HTTPS_PORT
//                              published ports of Caddy (defaults 18080 and 18443)
//   MSCD_MAILPIT_PORT          published port of Mailpit's API on 127.0.0.1 (default 18025)
//   MSCD_EDGE_SUBNET6          IPv6 range of the edge network when the host has IPv6 (default: a unique local range
//                              made from the project name, so the run can sit next to another SaaS stack, whose edge
//                              network keeps the range of .env.saas.example)
//   MSCD_SAAS_TEST_SCAN        gate (default) or auto, as saas-stack.sh (auto for build hosts that cannot reach the
//                              Alpine mirrors)
//   MSCD_BUILD_CA              CA certificate of a TLS-inspecting proxy for the image builds
//   SAAS_OUTPUT_DIR            folder for the logs, the Playwright report and traces (default
//                              tools/smoke/test-results/saas)
//   SMOKE_KEEP=1               leave the stack running after the run
//
// Exit codes: 0 every step passed, 1 the stack, a check or a step failed, 2 wrong usage or a missing requirement.
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { OPERATOR } from './lib/saas-data.mjs';
import { HERE, ROOT, UsageError, capture, checkDocker, current, run, tail, usageOf, userPath } from './lib/stack.mjs';
import { selfTest } from './lib/totp.mjs';

const COMPOSE_DIR = path.join(ROOT, 'deploy/compose');
const SAAS_STACK = path.join(ROOT, 'deploy/scripts/test/saas-stack.sh');
const SAAS_OPS = path.join(ROOT, 'deploy/scripts/saas-ops.sh');
const UP_TIMEOUT_SECONDS = 600;
/** The privacy notice and terms of the run: the sign-in page must link both (M2-S11, GL-41). */
export const LEGAL = { privacyUrl: 'https://legal.example/privacy-notice', termsUrl: 'https://legal.example/terms-of-service' };
/** Where the alerts of the monitoring overlay go in the run (the app's Mailpit). */
const ALERT_EMAIL = 'alerts@saas-run.invalid';
/** Every job Prometheus scrapes (deploy/ops/prometheus/prometheus.yml). */
const PROMETHEUS_JOBS = ['prometheus', 'alertmanager', 'api', 'worker', 'storage-gateway', 'node', 'postgres', 'blackbox', 'public-url'];

function log(message) {
  process.stdout.write(`saas: ${message}\n`);
}

function parseCommandLine(argv) {
  const split = argv.indexOf('--');
  const own = split === -1 ? argv : argv.slice(0, split);
  const playwrightArgs = split === -1 ? [] : argv.slice(split + 1);
  const { values } = parseArgs({
    args: own,
    options: {
      'with-ops': { type: 'boolean', default: false },
      'build-ca': { type: 'string' },
      keep: { type: 'boolean', default: false },
      down: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  return { ...values, playwrightArgs };
}

const PORT = /^[1-9][0-9]{0,4}$/;
function portOf(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!PORT.test(raw) || Number(raw) > 65535) throw new UsageError(`${name} must be a TCP port (1 to 65535), got "${raw}"`);
  return Number(raw);
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)));
  });
}

/** A key=value line of an .env file (the format of lib/common.sh: no quotes, no export). */
function envValue(file, key) {
  const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith(`${key}=`));
  return line === undefined ? undefined : line.slice(key.length + 1);
}

/** Sets key=value in an .env file, replacing the line of the key or adding one. */
function envSet(file, key, value) {
  if (/[\n\r$'"\\`]/.test(value)) throw new Error(`${key}: the value holds a character .env cannot carry`);
  const lines = readFileSync(file, 'utf8').replace(/\n$/, '').split('\n');
  const at = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (at === -1) lines.push(`${key}=${value}`);
  else lines[at] = `${key}=${value}`;
  writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
}

/** The address of host number `host` in a 172.31.x.0/24 range of the stack's .env. */
function addressIn(subnet, host, name) {
  const m = /^(172\.31\.\d{1,3})\.0\/24$/.exec(subnet ?? '');
  if (!m) throw new Error(`${name} in the stack's .env is "${subnet}", not a 172.31.x.0/24 range`);
  return `${m[1]}.${host}`;
}

/** A JSON field of <state>/digests.json, written by saas-stack.sh up. */
function digestsField(state, field) {
  const value = JSON.parse(readFileSync(path.join(state, 'digests.json'), 'utf8'))[field];
  if (typeof value !== 'string' || value === '') throw new Error(`${field} is missing in ${state}/digests.json`);
  return value;
}

/** The test settings of the monitoring overlay: the files deploy-prod.yml would write, and the probe of Caddy. */
function writeOpsFiles(state, edgeSubnet) {
  const ops = path.join(state, 'ops-run');
  mkdirSync(path.join(ops, 'metrics'), { recursive: true, mode: 0o755 });
  chmodSync(ops, 0o755);
  chmodSync(path.join(ops, 'metrics'), 0o755);
  // A backup an hour ago, as the backup timer of a server writes it (node exporter text file collector).
  writeFileSync(
    path.join(ops, 'metrics/backup.prom'),
    '# HELP mscd_backup_last_success_timestamp_seconds Time of the last successful backup.\n' +
      '# TYPE mscd_backup_last_success_timestamp_seconds gauge\n' +
      `mscd_backup_last_success_timestamp_seconds ${Math.floor(Date.now() / 1000) - 3600}\n`,
    { mode: 0o644 },
  );
  const secrets = path.join(state, 'secrets/ops');
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  const alertTo = path.join(secrets, 'ALERT_EMAIL_TO');
  rmSync(alertTo, { force: true });
  writeFileSync(alertTo, `${ALERT_EMAIL}\n`, { mode: 0o400 });
  // The public address of the test (127.0.0.1 of this host) cannot be reached from a container, so the probe reaches
  // Caddy by name over edge and trusts Caddy's local root certificate; the rest is the production module.
  copyFileSync(path.join(state, 'caddy-root.crt'), path.join(ops, 'caddy-root.crt'));
  chmodSync(path.join(ops, 'caddy-root.crt'), 0o644);
  writeFileSync(
    path.join(ops, 'blackbox.yml'),
    `# Test copy of deploy/ops/blackbox/blackbox.yml (tools/smoke/run-saas.mjs): the probe of Caddy over edge.
modules:
  https_healthz:
    prober: http
    timeout: 10s
    http:
      method: GET
      valid_status_codes: [200]
      fail_if_not_ssl: true
      follow_redirects: false
      preferred_ip_protocol: ip4
      ip_protocol_fallback: false
      headers:
        User-Agent: MSCD monitoring probe
        Host: localhost
      tls_config:
        ca_file: /etc/blackbox_exporter/caddy-root.crt
        server_name: localhost
`,
    { mode: 0o644 },
  );
  return {
    metricsDir: path.join(ops, 'metrics'),
    overlay: `
  ops-init:
    environment:
      MSCD_OPS_PROBE_URL: https://caddy/healthz
      MSCD_OPS_SMTP_REQUIRE_TLS: "false"

  blackbox-exporter:
    volumes:
      - ${ops}/blackbox.yml:/etc/blackbox_exporter/config.yml:ro
      - ${ops}/caddy-root.crt:/etc/blackbox_exporter/caddy-root.crt:ro
    networks:
      edge:
        ipv4_address: ${addressIn(edgeSubnet, 20, 'MSCD_EDGE_SUBNET')}
`,
  };
}

/** The run overlay: provider mocks with their DNS responder, the resolvers of api and worker, Mailpit's API port. */
function runOverlay({ mockImage, mockAddress, mailpitPort, opsOverlay }) {
  const resolvers = `"[${mockAddress}:5353]"`;
  return `# Additions of tools/smoke/run-saas.mjs (test only, never for a server; deleted by saas-stack.sh down).
#   - mock-providers: the provider mocks, whose DNS responder (UDP 5353, fixed address) stands in for the customer's
#     DNS when the operator verifies an email domain; the api and the worker ask only it (network.dns_resolvers).
#   - mailpit: its API on 127.0.0.1, where the run reads the emails the people receive.
services:
  api:
    environment:
      MSCD__NETWORK__DNS_RESOLVERS: ${resolvers}
  worker:
    environment:
      MSCD__NETWORK__DNS_RESOLVERS: ${resolvers}

  mock-providers:
    image: ${mockImage}
    pull_policy: never
    restart: unless-stopped
    command: ["--port", "4310", "--fixtures", "demo", "--dns-port", "5353"]
    user: "10001:0"
    read_only: true
    tmpfs:
      - /tmp:size=16m,mode=1777
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    init: true
    networks:
      mscd:
        ipv4_address: ${mockAddress}
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:4310/_admin/health"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 20s
      start_interval: 1s

  mailpit:
    # Published ports need a network with a route to the host; mscd is internal.
    networks:
      - mscd
      - egress
    ports:
      - "127.0.0.1:${mailpitPort}:8025"
${opsOverlay ?? ''}`;
}

/**
 * A view of the stack as the install folder of a server, for saas-ops.sh (--install-dir): its .env names the project,
 * and deploy/compose/docker-compose.yml is the stack's own configuration as Compose resolved it (every overlay
 * applied, paths absolute), so "docker compose run cli" of the script starts the same cli service as the stack.
 */
function writeInstallView(state, project, files, env) {
  const dir = path.join(state, 'install');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'deploy/compose'), { recursive: true, mode: 0o700 });
  // The profiles of the stack (the bundled database and object store) and the cli profile.
  const profiles = [...new Set([...(envValue(path.join(state, '.env'), 'COMPOSE_PROFILES') ?? '').split(','), 'cli'].filter(Boolean))];
  const resolved = capture('docker', [...composeBase(project, files, state), ...profiles.flatMap((p) => ['--profile', p]), 'config'], env);
  writeFileSync(path.join(dir, 'deploy/compose/docker-compose.yml'), resolved, { mode: 0o600 });
  writeFileSync(path.join(dir, '.env'), `COMPOSE_PROJECT_NAME=${project}\nCOMPOSE_PROFILES=${profiles.filter((p) => p !== 'cli').join(',')}\n`, { mode: 0o600 });
  return dir;
}

function composeBase(project, files, state) {
  return ['compose', '--project-name', project, '--project-directory', COMPOSE_DIR, ...files.flatMap((f) => ['-f', f]), '--env-file', path.join(state, '.env')];
}

/** Runs saas-stack.sh with the project, folder and ports of the run; output to the terminal. */
function saasStack(command, env) {
  return run('bash', [SAAS_STACK, command], { env });
}

/** "job (service)" of every active Prometheus target, or the problems (missing jobs, targets not up). */
function prometheusTargets(project, files, state, env) {
  const out = capture('docker', [...composeBase(project, files, state), 'exec', '-T', 'prometheus', 'wget', '-q', '-O', '-', 'http://127.0.0.1:9090/api/v1/targets?state=active'], env);
  const targets = JSON.parse(out).data.activeTargets;
  const jobs = new Set(targets.map((t) => t.labels.job));
  const missing = PROMETHEUS_JOBS.filter((j) => !jobs.has(j));
  const down = targets.filter((t) => t.health !== 'up').map((t) => `${t.labels.job} (${t.health}: ${t.lastError || 'not scraped yet'})`);
  return { ok: missing.length === 0 && down.length === 0, missing, down, up: targets.map((t) => `${t.labels.job} (${t.labels.service ?? '-'})`).sort() };
}

/** The value of probe_success of the HTTPS probe (job public-url), or null when Prometheus has none yet. */
function probeSuccess(project, files, state, env) {
  const out = capture('docker', [...composeBase(project, files, state), 'exec', '-T', 'prometheus', 'wget', '-q', '-O', '-', `http://127.0.0.1:9090/api/v1/query?query=${encodeURIComponent('probe_success{job="public-url"}')}`], env);
  const result = JSON.parse(out).data.result;
  return result.length ? Number(result[0].value[1]) : null;
}

async function waitForTargets(project, files, state, env, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    try {
      last = prometheusTargets(project, files, state, env);
      if (last.ok) return last;
    } catch (e) {
      last = { ok: false, missing: [], down: [`the Prometheus API did not answer: ${e.message.split('\n')[0]}`], up: [] };
    }
    if (Date.now() > deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

let cleanup = null;
let interrupted = false;

async function main() {
  let options;
  try {
    options = parseCommandLine(process.argv.slice(2));
  } catch (e) {
    throw new UsageError(e.message);
  }
  if (options.help) {
    process.stdout.write(usageOf(fileURLToPath(import.meta.url), '// SaaS end-to-end'));
    return 0;
  }
  const withOps = options['with-ops'];

  const env = { ...process.env };
  for (const name of ['COMPOSE_FILE', 'COMPOSE_PROJECT_NAME', 'COMPOSE_PROFILES', 'COMPOSE_ENV_FILES']) delete env[name];
  const project = env.MSCD_SAAS_TEST_PROJECT || 'mscd-saas-run';
  const state = env.MSCD_SAAS_TEST_DIR || '/tmp/mscd-saas-run';
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(project)) throw new UsageError(`MSCD_SAAS_TEST_PROJECT "${project}" is not a valid Compose project name`);
  const httpPort = portOf(env, 'MSCD_SAAS_TEST_HTTP_PORT', 18080);
  const httpsPort = portOf(env, 'MSCD_SAAS_TEST_HTTPS_PORT', 18443);
  const mailpitPort = portOf(env, 'MSCD_MAILPIT_PORT', 18025);
  if (new Set([httpPort, httpsPort, mailpitPort]).size !== 3) throw new UsageError('MSCD_SAAS_TEST_HTTP_PORT, MSCD_SAAS_TEST_HTTPS_PORT and MSCD_MAILPIT_PORT must differ');
  // Docker refuses two networks with the same IPv6 range, and every SaaS stack's edge network takes the range of
  // .env.saas.example. The variable of the environment wins over .env in every Compose call of the run.
  if (!env.MSCD_EDGE_SUBNET6) {
    const h = createHash('sha256').update(`mscd-saas-run:${project}`).digest('hex');
    env.MSCD_EDGE_SUBNET6 = `fd${h.slice(0, 2)}:${h.slice(2, 6)}:${h.slice(6, 10)}:${h.slice(10, 14)}::/64`;
  }
  Object.assign(env, {
    MSCD_SAAS_TEST_PROJECT: project,
    MSCD_SAAS_TEST_DIR: state,
    MSCD_SAAS_TEST_HTTP_PORT: String(httpPort),
    MSCD_SAAS_TEST_HTTPS_PORT: String(httpsPort),
    MSCD_MAILPIT_PORT: String(mailpitPort),
  });
  if (options['build-ca'] !== undefined) env.MSCD_BUILD_CA = userPath(options['build-ca']);
  else if (env.MSCD_BUILD_CA) env.MSCD_BUILD_CA = userPath(env.MSCD_BUILD_CA);
  if (env.MSCD_BUILD_CA && !(existsSync(env.MSCD_BUILD_CA) && statSync(env.MSCD_BUILD_CA).isFile())) throw new UsageError(`the build CA ${env.MSCD_BUILD_CA} is not a file`);

  const versions = checkDocker();
  if (options.down) {
    log(`removing the stack ${project} (saas-stack.sh down)`);
    return (await saasStack('down', env)) === 0 ? 0 : 1;
  }
  const failedVectors = selfTest();
  if (failedVectors.length > 0) throw new Error(`the TOTP helper fails the RFC 6238 vectors at ${failedVectors.join(', ')}`);
  for (const [name, port] of [['MSCD_SAAS_TEST_HTTP_PORT', httpPort], ['MSCD_SAAS_TEST_HTTPS_PORT', httpsPort], ['MSCD_MAILPIT_PORT', mailpitPort]]) {
    if (!(await portFree(port))) throw new UsageError(`port ${port} (${name}) on 127.0.0.1 is already in use; stop what listens there or set ${name}`);
  }

  const outputDir = env.SAAS_OUTPUT_DIR ? userPath(env.SAAS_OUTPUT_DIR) : path.join(HERE, 'test-results', 'saas');
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  log(`Docker ${versions.docker}, Compose ${versions.compose}; project ${project}, state ${state}, IPv6 range of edge ${env.MSCD_EDGE_SUBNET6}${withOps ? ', with the monitoring overlay' : ''}; output in ${outputDir}`);

  const keep = options.keep || env.SMOKE_KEEP === '1' || env.SMOKE_KEEP === 'true';
  let stackStarted = false;
  let files = [];
  cleanup = async () => {
    if (!stackStarted) return;
    stackStarted = false;
    if (keep) {
      log(`the stack is still running (--keep): https://localhost:${httpsPort}/ (Caddy's root certificate: ${state}/caddy-root.crt), Mailpit http://127.0.0.1:${mailpitPort}; remove it with "MSCD_SAAS_TEST_PROJECT=${project} MSCD_SAAS_TEST_DIR=${state} node tools/smoke/run-saas.mjs --down"`);
      return;
    }
    if (files.length > 0 && existsSync(path.join(state, '.env'))) {
      await run('docker', [...composeBase(project, files, state), '--profile', 'cli', 'down', '--volumes', '--remove-orphans', '--timeout', '20'], { env, quiet: true });
    }
    log(`removing the stack (saas-stack.sh down)`);
    const code = await saasStack('down', env);
    if (code !== 0) throw new Error(`saas-stack.sh down failed (exit ${code}); remove what is left with "MSCD_SAAS_TEST_PROJECT=${project} MSCD_SAAS_TEST_DIR=${state} bash deploy/scripts/test/saas-stack.sh down"`);
  };

  let result = 1;
  try {
    stackStarted = true;
    let started = Date.now();
    log('saas-stack.sh up: release images with a throwaway key set, TLS internal, Mailpit');
    if ((await saasStack('up', env)) !== 0) {
      if (interrupted) return 130;
      throw new Error('saas-stack.sh up failed (see above)');
    }
    log(`the SaaS test stack is up after ${Math.round((Date.now() - started) / 1000)} s`);
    log('saas-stack.sh check: the M2-S02 checks on the same stack');
    if ((await saasStack('check', env)) !== 0) {
      if (interrupted) return 130;
      throw new Error('saas-stack.sh check failed (see above)');
    }

    // The provider mocks, as a local image of this project.
    const version = digestsField(state, 'version');
    const mockImage = `localhost/${project}/mscd-mock-providers:${version}`;
    let buildCa = env.MSCD_BUILD_CA;
    if (!buildCa) {
      buildCa = path.join(state, 'empty-build-ca.pem');
      writeFileSync(buildCa, '');
    }
    const buildLog = path.join(outputDir, 'build-mock-providers.log');
    log(`building ${mockImage} (log: ${path.relative(ROOT, buildLog)})`);
    const built = await run(
      'docker',
      ['buildx', 'build', '--load', '--progress=plain', '--secret', `id=build_ca,src=${buildCa}`, '-f', 'deploy/docker/mock-providers.Dockerfile', '-t', mockImage, ROOT],
      { env, logFile: buildLog },
    );
    if (built !== 0) {
      process.stderr.write(`${tail(buildLog)}\n`);
      throw new Error(`the build of ${mockImage} failed (exit ${built}); full log in ${buildLog}`);
    }

    // The run overlay and the settings of the run.
    const dotenv = path.join(state, '.env');
    const mockAddress = addressIn(envValue(dotenv, 'MSCD_SUBNET'), 20, 'MSCD_SUBNET');
    envSet(dotenv, 'MSCD_LEGAL_PRIVACY_URL', LEGAL.privacyUrl);
    envSet(dotenv, 'MSCD_LEGAL_TERMS_URL', LEGAL.termsUrl);
    let opsOverlay = null;
    if (withOps) {
      const ops = writeOpsFiles(state, envValue(dotenv, 'MSCD_EDGE_SUBNET'));
      envSet(dotenv, 'MSCD_METRICS_DIR', ops.metricsDir);
      opsOverlay = ops.overlay;
    }
    const overlay = path.join(state, 'compose.run.yml');
    writeFileSync(overlay, runOverlay({ mockImage, mockAddress, mailpitPort, opsOverlay }), { mode: 0o644 });
    files = [
      path.join(COMPOSE_DIR, 'docker-compose.yml'),
      path.join(COMPOSE_DIR, 'docker-compose.saas.yml'),
      path.join(state, 'compose.test.yml'),
      ...(withOps ? [path.join(COMPOSE_DIR, 'docker-compose.ops.yml')] : []),
      overlay,
    ];
    if ((await run('docker', [...composeBase(project, files, state), 'config', '-q'], { env })) !== 0) throw new Error('docker compose config refused the run overlay');
    started = Date.now();
    const upLog = path.join(outputDir, 'up.log');
    writeFileSync(upLog, '');
    log(`starting the provider mocks${withOps ? ' and the monitoring overlay' : ''}; api and worker get the mock DNS and the legal links (log: ${path.relative(ROOT, upLog)})`);
    // In phases, so the web container keeps its fixed addresses: a container Compose creates while web is being
    // recreated could otherwise take web's address on mscd from Docker's free addresses.
    const phases = [
      ['mock-providers', 'mailpit'],
      ['api', 'worker'],
      ['web', 'caddy'],
      ...(withOps ? [['prometheus', 'alertmanager', 'node-exporter', 'postgres-exporter', 'blackbox-exporter', 'caddy']] : []),
      [],
    ];
    for (const services of phases) {
      const up = await run('docker', [...composeBase(project, files, state), 'up', '-d', '--wait', '--wait-timeout', String(UP_TIMEOUT_SECONDS), ...services], { env, logFile: upLog });
      if (up !== 0) {
        if (interrupted) return 130;
        process.stderr.write(`${tail(upLog, 30)}\n`);
        throw new Error(`docker compose up --wait ${services.join(' ') || '(every service)'} with the run overlay failed (exit ${up})`);
      }
    }
    log(`the run overlay is up after ${Math.round((Date.now() - started) / 1000)} s`);

    // The first platform operator, as ops-cli.yml makes it on a server: saas-ops.sh, values on standard input, output
    // fit for a public log.
    const install = writeInstallView(state, project, files, env);
    const input = [`EMAIL=${Buffer.from(OPERATOR.email).toString('base64')}`, `NAME=${Buffer.from(OPERATOR.name).toString('base64')}`].join('\n');
    const out = capture('bash', [SAAS_OPS, 'create-operator', '--input-stdin', '--public', '--install-dir', install], { ...env, NO_COLOR: '1' }, { input: `${input}\n` });
    if (out.includes(OPERATOR.email) || out.includes(OPERATOR.email.split('@')[0])) throw new Error(`saas-ops.sh --public printed the operator's email:\n${out}`);
    if (!/Invitation sent to \[email\]/.test(out) || !/create-operator finished/.test(out)) throw new Error(`saas-ops.sh create-operator did not email the set-password link:\n${out}`);
    log(`saas-ops.sh create-operator --input-stdin --public: the operator was created, the log shows "[email]" only; the set-password email is in Mailpit`);

    const runState = {
      project,
      stateDir: state,
      outputDir,
      files,
      envFile: dotenv,
      baseUrl: `https://localhost:${httpsPort}`,
      mailpitUrl: `http://127.0.0.1:${mailpitPort}`,
      operator: OPERATOR,
      legal: LEGAL,
      ops: withOps,
    };
    const statePath = path.join(state, 'run-state.json');
    writeFileSync(statePath, `${JSON.stringify(runState, null, 2)}\n`, { mode: 0o600 });

    const require = createRequire(import.meta.url);
    const playwright = require.resolve('@playwright/test/cli');
    result = await run(process.execPath, [playwright, 'test', '--config', path.join(HERE, 'saas.config.mjs'), ...options.playwrightArgs], {
      env: { ...env, SAAS_RUN_STATE: statePath, SAAS_OUTPUT_DIR: outputDir },
      cwd: HERE,
    });
    if (interrupted) return 130;
    result = result === 0 ? 0 : 1;

    if (withOps) {
      log('every Prometheus target must be up (Prometheus API inside its container)');
      const targets = await waitForTargets(project, files, state, env);
      if (targets.ok) {
        log(`every Prometheus target is up: ${targets.up.join(', ')}`);
        const probe = probeSuccess(project, files, state, env);
        if (probe === 1) {
          log('the HTTPS probe of the public URL through Caddy succeeds (probe_success 1)');
        } else {
          process.stderr.write(`saas: the HTTPS probe of the public URL answered probe_success ${probe}\n`);
          result = 1;
        }
      } else {
        process.stderr.write(`saas: Prometheus targets: missing ${targets.missing.join(', ') || 'none'}; not up: ${targets.down.join('; ') || 'none'}\n`);
        result = 1;
      }
    }

    if (result !== 0) {
      const file = path.join(outputDir, 'compose.log');
      writeFileSync(file, '');
      await run('docker', [...composeBase(project, files, state), 'ps', '-a'], { env, logFile: file });
      await run('docker', [...composeBase(project, files, state), 'logs', '--no-color', '--timestamps'], { env, logFile: file });
      log(`the SaaS run failed; report in ${path.join(outputDir, 'report')}, service logs in ${file}`);
    } else {
      log(`every step of the SaaS run passed${withOps ? ', and every Prometheus target is up' : ''}`);
    }
  } finally {
    await cleanup();
  }
  return result;
}

async function onSignal(signal) {
  interrupted = true;
  process.stderr.write(`\nsaas: ${signal} received, stopping\n`);
  for (const child of current) child.kill('SIGTERM');
  try {
    if (cleanup) await cleanup();
  } finally {
    process.exit(130);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.once('SIGINT', () => void onSignal('SIGINT'));
  process.once('SIGTERM', () => void onSignal('SIGTERM'));
  main().then(
    (code) => {
      process.exitCode = code;
    },
    async (e) => {
      process.stderr.write(`saas: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = e instanceof UsageError ? 2 : 1;
    },
  );
}
