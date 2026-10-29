// Helpers shared by the two runners of this folder: run-smoke.mjs (the smoke test of the demo stack) and
// run-journey.mjs (the fresh-organisation journey, MILESTONE-2 M2-18). Both start the on-premise Compose file with
// overlays, publish the same fixed ports (R-05, so both run under the host lock), build the same three images and
// remove their stack with its volumes at the end.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT = path.resolve(HERE, '../..');
export const COMPOSE_DIR = path.join(ROOT, 'deploy/compose');
export const DEFAULT_SUBNET_OCTET = 250;
export const UP_TIMEOUT_SECONDS = 900;

/** A wrong command line or a missing requirement: the runners exit 2. */
export class UsageError extends Error {}

/** Child processes that run now, so a signal handler can stop them. */
export const current = new Set();

/** The usage text: the comment block at the top of a runner, from the line that starts with `first`. */
export function usageOf(file, first) {
  const text = readFileSync(file, 'utf8').split('\n');
  const start = text.findIndex((l) => l.startsWith(first));
  const end = text.findIndex((l, i) => i > start && !l.startsWith('//'));
  return text.slice(start, end).map((l) => l.replace(/^\/\/ ?/, '')).join('\n') + '\n';
}

/** Runs a command; resolves with its exit code. Output goes to the terminal or to `logFile`. */
export function run(command, args, { env = process.env, cwd = ROOT, logFile = null, quiet = false } = {}) {
  return new Promise((resolve, reject) => {
    const out = logFile ? createWriteStream(logFile, { flags: 'a' }) : null;
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', out || quiet ? 'pipe' : 'inherit', out || quiet ? 'pipe' : 'inherit'] });
    if (out) {
      child.stdout.pipe(out, { end: false });
      child.stderr.pipe(out, { end: false });
    } else if (quiet) {
      child.stdout.resume();
      child.stderr.resume();
    }
    current.add(child);
    child.on('error', (e) => {
      current.delete(child);
      reject(e);
    });
    child.on('close', (code, signal) => {
      current.delete(child);
      if (out) out.end();
      resolve(code ?? (signal ? 128 : 1));
    });
  });
}

/** Runs a command and returns its standard output (throws on a non-zero exit). */
export function capture(command, args, env = process.env, { input } = {}) {
  const r = spawnSync(command, args, { cwd: ROOT, env, encoding: 'utf8', input, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

export function tail(file, lines = 60) {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/** A path given by the user: relative to the folder npm was started in (INIT_CWD), else to the current folder. */
export function userPath(p) {
  return path.resolve(process.env.INIT_CWD || process.cwd(), p);
}

// ---- preflight --------------------------------------------------------------------------------------------------

export function checkDocker() {
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new UsageError('Docker is not available (docker version failed). Start the Docker daemon first.');
  const c = spawnSync('docker', ['compose', 'version', '--short'], { encoding: 'utf8' });
  if (c.error || c.status !== 0) throw new UsageError('Docker Compose v2 is not available (docker compose version failed).');
  return { docker: r.stdout.trim(), compose: c.stdout.trim() };
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export async function checkPorts(settings) {
  const wanted = [
    ['MSCD_HTTP_PORT', settings.httpPort],
    ['MSCD_HTTPS_PORT', settings.httpsPort],
    ['MSCD_KEYCLOAK_PORT', settings.keycloakPort],
    ['MSCD_MAILPIT_PORT', settings.mailpitPort],
  ];
  const seen = new Map();
  for (const [name, port] of wanted) {
    if (seen.has(port)) throw new UsageError(`${name} and ${seen.get(port)} are both ${port}; every published port must differ.`);
    seen.set(port, name);
  }
  const busy = [];
  for (const [name, port] of wanted) if (!(await portFree(port))) busy.push(`${port} (${name})`);
  if (busy.length > 0) {
    throw new UsageError(
      `port ${busy.join(', ')} on 127.0.0.1 is already in use. Stop what listens there, or set ` +
        'MSCD_HTTP_PORT, MSCD_HTTPS_PORT, MSCD_KEYCLOAK_PORT and MSCD_MAILPIT_PORT to free ports.',
    );
  }
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, part) => acc * 256 + Number(part), 0);
}

/** True when two IPv4 CIDR ranges share an address. IPv6 ranges never overlap an IPv4 range. */
function overlaps(a, b) {
  const [ipA, lenA = '32'] = a.split('/');
  const [ipB, lenB = '32'] = b.split('/');
  if (ipA.includes(':') || ipB.includes(':')) return false;
  const size = 2 ** (32 - Math.min(Number(lenA), Number(lenB)));
  return Math.floor(ipv4ToInt(ipA) / size) === Math.floor(ipv4ToInt(ipB) / size);
}

/** Subnets of every Docker network except the ones of our own project (those are removed before the start). */
function dockerSubnets(project) {
  const ids = capture('docker', ['network', 'ls', '-q']).split('\n').filter(Boolean);
  if (ids.length === 0) return [];
  const lines = capture('docker', [
    'network',
    'inspect',
    '--format',
    '{{.Name}}|{{index .Labels "com.docker.compose.project"}}|{{range .IPAM.Config}}{{.Subnet}} {{end}}',
    ...ids,
  ]).split('\n');
  const out = [];
  for (const line of lines) {
    const [name, label, subnets = ''] = line.trim().split('|');
    if (!name || label === project) continue;
    for (const s of subnets.split(/\s+/)) if (/^[0-9.]+\/\d+$/.test(s)) out.push({ name, subnet: s });
  }
  return out;
}

/** The internal network of the stack: MSCD_SUBNET when set, else 172.31.250.0/24 or the first free 172.31.x.0/24. */
export function chooseSubnet(env, project) {
  if (env.MSCD_SUBNET) {
    if (!env.MSCD_WEB_ADDRESS) throw new UsageError('MSCD_SUBNET is set without MSCD_WEB_ADDRESS (the fixed web address inside it).');
    return { subnet: env.MSCD_SUBNET, webAddress: env.MSCD_WEB_ADDRESS, chosen: false };
  }
  const used = dockerSubnets(project);
  const candidates = [DEFAULT_SUBNET_OCTET];
  for (let o = 249; o >= 200; o -= 1) candidates.push(o);
  for (const octet of candidates) {
    const subnet = `172.31.${octet}.0/24`;
    if (!used.some((u) => overlaps(u.subnet, subnet))) {
      return { subnet, webAddress: `172.31.${octet}.10`, chosen: octet !== DEFAULT_SUBNET_OCTET };
    }
  }
  throw new UsageError('no free 172.31.x.0/24 range for the internal network; set MSCD_SUBNET and MSCD_WEB_ADDRESS.');
}

// ---- images -----------------------------------------------------------------------------------------------------

export function imageRefs(env) {
  const tag = env.MSCD_VERSION;
  return {
    server: `${env.MSCD_SERVER_DEMO_IMAGE || 'cyberlentera/mscd-server-demo'}:${tag}`,
    web: `${env.MSCD_IMAGE || 'cyberlentera/mscd-web'}:${tag}`,
    mock: `${env.MSCD_MOCK_IMAGE || 'cyberlentera/mscd-mock-providers'}:${tag}`,
  };
}

export function imageExists(ref) {
  return spawnSync('docker', ['image', 'inspect', ref], { stdio: 'ignore' }).status === 0;
}

/** Builds the three images with the build CA (R-12); `log` prints one progress line. */
export async function buildImages(refs, buildCa, outputDir, log) {
  const builds = [
    ['server', refs.server, ['-f', 'deploy/docker/server.Dockerfile', '--target', 'demo']],
    ['web', refs.web, ['-f', 'deploy/docker/web.Dockerfile', '--build-context', `nginx-config=${path.join(ROOT, 'deploy/nginx')}`]],
    ['mock-providers', refs.mock, ['-f', 'deploy/docker/mock-providers.Dockerfile']],
  ];
  for (const [name, ref, args] of builds) {
    const logFile = path.join(outputDir, `build-${name}.log`);
    writeFileSync(logFile, '');
    const started = Date.now();
    log(`building ${ref} (log: ${path.relative(ROOT, logFile)})`);
    const code = await run(
      'docker',
      ['buildx', 'build', '--load', '--progress=plain', '--secret', `id=build_ca,src=${buildCa}`, ...args, '-t', ref, ROOT],
      { logFile },
    );
    if (code !== 0) {
      process.stderr.write(`${tail(logFile)}\n`);
      throw new Error(`the build of ${ref} failed (exit ${code}); full log in ${logFile}`);
    }
    log(`built ${ref} in ${Math.round((Date.now() - started) / 1000)} s`);
  }
}

// ---- stack ------------------------------------------------------------------------------------------------------

/**
 * The arguments of `docker compose` for a project and its files. --env-file /dev/null: Compose would otherwise read
 * deploy/compose/.env (the operator's file of an on-premise install, which publishes 0.0.0.0:80 and 443 and sets
 * COMPOSE_PROFILES). The test stacks take every setting from the variables the runner passes.
 */
export function composeArgs(project, files, ...rest) {
  return ['compose', '-p', project, '--env-file', os.devNull, ...files.flatMap((f) => ['-f', f]), ...rest];
}

export async function stackDown(project, files, env, log) {
  log(`removing the stack (docker compose -p ${project} down -v)`);
  const code = await run('docker', composeArgs(project, files, '--profile', 'cli', 'down', '-v', '--remove-orphans', '--timeout', '20'), { env, quiet: true });
  if (code !== 0) process.stderr.write(`docker compose down -v exited with ${code}; check "docker compose -p ${project} ps -a"\n`);
  return code;
}

export async function saveComposeLogs(project, files, env, outputDir) {
  const file = path.join(outputDir, 'compose.log');
  writeFileSync(file, '');
  await run('docker', composeArgs(project, files, 'ps', '-a'), { env, logFile: file });
  await run('docker', composeArgs(project, files, 'logs', '--no-color', '--timestamps'), { env, logFile: file });
  return file;
}

/** Prints the last log lines of every service that is not running and healthy (or a one-shot that failed). */
export function showUnhealthy(project, files, env) {
  let rows = [];
  try {
    rows = capture('docker', composeArgs(project, files, 'ps', '-a', '--format', '{{.Service}}\t{{.State}}\t{{.Health}}\t{{.ExitCode}}'), env)
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('\t'));
  } catch {
    return;
  }
  for (const [service, state, health, exitCode] of rows) {
    const bad = (state === 'running' && health && health !== 'healthy') || (state === 'exited' && exitCode !== '0') || ['dead', 'restarting', 'created'].includes(state);
    if (!bad) continue;
    process.stderr.write(`\n---- ${service}: ${state} ${health || ''} ${state === 'exited' ? `exit ${exitCode}` : ''}\n`);
    const r = spawnSync('docker', composeArgs(project, files, 'logs', '--no-color', '--tail', '40', service), { env, encoding: 'utf8' });
    process.stderr.write(`${(r.stdout || '') + (r.stderr || '')}\n`);
  }
}
