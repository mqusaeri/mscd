#!/usr/bin/env node
// Full-stack smoke test of MSCD (build plan J.9, WP-31).
//
// 1. Builds the mscd-server-demo, mscd-web and mscd-mock-providers images with the build CA (R-12), or uses the
//    existing images when SMOKE_SKIP_BUILD=1.
// 2. Starts the on-premise Compose file with the demo overlay as project mscd-smoke and waits for every service.
// 3. Runs the Playwright suite in tools/smoke/tests against the stack (Chromium maps the name keycloak to this host).
// 4. Removes the stack with its volumes (docker compose down -v), on success, on failure and on Ctrl-C.
//
// Usage: npm run test:smoke                      (root script: every setting from the environment)
//        node tools/smoke/run-smoke.mjs [options] [-- <Playwright arguments>]
//   --build-ca <file>   CA certificate of a TLS-inspecting proxy for the image builds
//                       (default: $MSCD_BUILD_CA; an empty file when unset)
//   --keep              leave the stack running after the tests (same as SMOKE_KEEP=1; remove it with --down)
//   --down              only remove the stack of an earlier --keep run, then exit
//   -h, --help          show this text
// Arguments after "--" go to "playwright test" (for example --headed or --trace on).
//
// Environment:
//   SMOKE_SKIP_BUILD=1      use existing images instead of building them
//   SMOKE_KEEP=1            leave the stack running after the tests
//   SMOKE_PROJECT           Compose project name (default mscd-smoke)
//   MSCD_VERSION            tag of the three images (default smoke)
//   MSCD_SERVER_DEMO_IMAGE, MSCD_IMAGE, MSCD_MOCK_IMAGE
//                           image repositories (defaults cyberlentera/mscd-server-demo, cyberlentera/mscd-web,
//                           cyberlentera/mscd-mock-providers)
//   MSCD_HTTP_PORT, MSCD_HTTPS_PORT, MSCD_KEYCLOAK_PORT, MSCD_MAILPIT_PORT
//                           published ports on 127.0.0.1 (defaults 18080, 18443, 18088, 18025); deploy/compose/.env
//                           is not read
//   MSCD_BUILD_CA, SMOKE_OUTPUT_DIR and --build-ca: a relative path is taken from the folder npm was started in
//   MSCD_SUBNET, MSCD_WEB_ADDRESS
//                           internal network and the fixed web address (default 172.31.250.0/24 and .10; when
//                           another Docker network already uses that range a free 172.31.x.0/24 is chosen)
//   SMOKE_OUTPUT_DIR        folder for build logs, Compose logs, the Playwright report and traces
//                           (default tools/smoke/test-results)
//
// Exit codes: 0 every check passed, 1 a build, the stack or a test failed, 2 wrong usage or a missing requirement.
import { existsSync, mkdirSync, statSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { smokeSettings } from './lib/settings.mjs';
import {
  COMPOSE_DIR, DEFAULT_SUBNET_OCTET, HERE, UP_TIMEOUT_SECONDS, UsageError, buildImages, checkDocker, checkPorts, chooseSubnet,
  current, imageExists, imageRefs, composeArgs as stackComposeArgs, run, saveComposeLogs as stackLogs, showUnhealthy as stackUnhealthy,
  stackDown as stackRemove, usageOf, userPath,
} from './lib/stack.mjs';
import { selfTest } from './lib/totp.mjs';

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.demo.yml'].map((f) => path.join(COMPOSE_DIR, f));

function log(message) {
  process.stdout.write(`smoke: ${message}\n`);
}

function usage() {
  return usageOf(fileURLToPath(import.meta.url), '// Full-stack');
}

function parseCommandLine(argv) {
  const split = argv.indexOf('--');
  const own = split === -1 ? argv : argv.slice(0, split);
  const playwrightArgs = split === -1 ? [] : argv.slice(split + 1);
  const { values } = parseArgs({
    args: own,
    options: {
      'build-ca': { type: 'string' },
      keep: { type: 'boolean', default: false },
      down: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  return { ...values, playwrightArgs };
}

// The smoke stack: the on-premise file with the demo overlay (lib/stack.mjs has the shared helpers).
const composeArgs = (project, ...rest) => stackComposeArgs(project, COMPOSE_FILES, ...rest);
const stackDown = (project, env) => stackRemove(project, COMPOSE_FILES, env, log);
const saveComposeLogs = (project, env, outputDir) => stackLogs(project, COMPOSE_FILES, env, outputDir);
const showUnhealthy = (project, env) => stackUnhealthy(project, COMPOSE_FILES, env);

// ---- main -------------------------------------------------------------------------------------------------------

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
    process.stdout.write(usage());
    return 0;
  }

  const env = { ...process.env };
  // The stack is defined only by the two files and the variables below: composeArgs passes an empty --env-file, and
  // the Compose settings of the shell, meant for another Compose project, are removed.
  for (const name of ['COMPOSE_FILE', 'COMPOSE_PROJECT_NAME', 'COMPOSE_PROFILES', 'COMPOSE_ENV_FILES']) delete env[name];
  env.MSCD_VERSION = env.MSCD_VERSION || 'smoke';
  const project = env.SMOKE_PROJECT || 'mscd-smoke';
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) throw new UsageError(`SMOKE_PROJECT "${project}" is not a valid Compose project name`);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(env.MSCD_VERSION)) throw new UsageError(`MSCD_VERSION "${env.MSCD_VERSION}" is not a valid image tag`);

  let settings;
  try {
    settings = smokeSettings(env);
  } catch (e) {
    throw new UsageError(e.message);
  }
  // The runner and the browser use these values, so Compose gets them explicitly (also the defaults).
  env.MSCD_HTTP_PORT = String(settings.httpPort);
  env.MSCD_HTTPS_PORT = String(settings.httpsPort);
  env.MSCD_KEYCLOAK_PORT = String(settings.keycloakPort);
  env.MSCD_MAILPIT_PORT = String(settings.mailpitPort);
  env.MSCD_BIND_ADDRESS = '127.0.0.1';
  const versions = checkDocker();
  if (options.down) {
    return (await stackDown(project, env)) === 0 ? 0 : 1;
  }

  const failedVectors = selfTest();
  if (failedVectors.length > 0) throw new Error(`the TOTP helper fails the RFC 6238 vectors at ${failedVectors.join(', ')}`);

  const outputDir = env.SMOKE_OUTPUT_DIR ? userPath(env.SMOKE_OUTPUT_DIR) : path.join(HERE, 'test-results');
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  log(`Docker ${versions.docker}, Compose ${versions.compose}; project ${project}; output in ${outputDir}`);

  // An earlier run that was killed may have left the project behind: start from empty volumes.
  await stackDown(project, env);
  await checkPorts(settings);
  const network = chooseSubnet(env, project);
  env.MSCD_SUBNET = network.subnet;
  env.MSCD_WEB_ADDRESS = network.webAddress;
  if (network.chosen) log(`172.31.${DEFAULT_SUBNET_OCTET}.0/24 is used by another Docker network; the stack uses ${network.subnet}`);

  const refs = imageRefs(env);
  const skipBuild = env.SMOKE_SKIP_BUILD === '1' || env.SMOKE_SKIP_BUILD === 'true';
  if (skipBuild) {
    const missing = Object.values(refs).filter((ref) => !imageExists(ref));
    if (missing.length > 0) {
      throw new UsageError(`SMOKE_SKIP_BUILD is set but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing; run once without SMOKE_SKIP_BUILD (or set MSCD_VERSION to the tag you built).`);
    }
    log(`using the existing images ${Object.values(refs).join(', ')}`);
  } else {
    let buildCa = options['build-ca'] ?? env.MSCD_BUILD_CA ?? '';
    let tempCaDir = null;
    if (buildCa === '') {
      // BuildKit refuses /dev/null as a secret source (R-12): an empty file means "no extra CA".
      tempCaDir = mkdtempSync(path.join(os.tmpdir(), 'mscd-smoke-ca-'));
      buildCa = path.join(tempCaDir, 'empty-ca.pem');
      writeFileSync(buildCa, '');
    } else {
      buildCa = userPath(buildCa);
      if (!existsSync(buildCa) || !statSync(buildCa).isFile()) throw new UsageError(`--build-ca ${buildCa} is not a file`);
    }
    try {
      await buildImages(refs, buildCa, outputDir, log);
    } finally {
      if (tempCaDir) rmSync(tempCaDir, { recursive: true, force: true });
    }
  }

  const keep = options.keep || env.SMOKE_KEEP === '1' || env.SMOKE_KEEP === 'true';
  let stackStarted = false;
  cleanup = async () => {
    if (!stackStarted) return;
    stackStarted = false;
    if (keep) {
      log(`the stack is still running (--keep): ${settings.baseUrl}; remove it with "${project === 'mscd-smoke' ? '' : `SMOKE_PROJECT=${project} `}node tools/smoke/run-smoke.mjs --down"`);
      return;
    }
    await stackDown(project, env);
  };

  let result = 1;
  try {
    stackStarted = true;
    const started = Date.now();
    log(`starting the stack: web ${settings.baseUrl}, Keycloak 127.0.0.1:${settings.keycloakPort}, Mailpit ${settings.mailpitUrl}, network ${network.subnet}`);
    const up = await run('docker', composeArgs(project, 'up', '-d', '--wait', '--wait-timeout', String(UP_TIMEOUT_SECONDS)), { env });
    if (up !== 0) {
      if (interrupted) return 130;
      showUnhealthy(project, env);
      const file = await saveComposeLogs(project, env, outputDir);
      throw new Error(`docker compose up --wait failed (exit ${up}); service logs in ${file}`);
    }
    log(`the stack is healthy after ${Math.round((Date.now() - started) / 1000)} s`);

    const require = createRequire(import.meta.url);
    const cli = require.resolve('@playwright/test/cli');
    const testEnv = { ...env, SMOKE_OUTPUT_DIR: outputDir };
    result = await run(process.execPath, [cli, 'test', '--config', path.join(HERE, 'playwright.config.mjs'), ...options.playwrightArgs], {
      env: testEnv,
      cwd: HERE,
    });
    if (interrupted) return 130;
    if (result !== 0) {
      const file = await saveComposeLogs(project, env, outputDir);
      log(`the smoke tests failed; report in ${path.join(outputDir, 'report')}, service logs in ${file}`);
      result = 1;
    } else {
      log('every smoke check passed');
    }
  } finally {
    await cleanup();
  }
  return result;
}

async function onSignal(signal) {
  interrupted = true;
  process.stderr.write(`\nsmoke: ${signal} received, stopping\n`);
  for (const child of current) child.kill('SIGTERM');
  try {
    if (cleanup) await cleanup();
  } finally {
    process.exit(130);
  }
}
process.once('SIGINT', () => void onSignal('SIGINT'));
process.once('SIGTERM', () => void onSignal('SIGTERM'));

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    process.stderr.write(`smoke: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  },
);
