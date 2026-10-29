#!/usr/bin/env node
// Fresh-organisation journey of MSCD (MILESTONE-2 M2-18).
//
// 1. Builds the mscd-server-demo, mscd-web and mscd-mock-providers images with the build CA (R-12), or uses the
//    existing images when SMOKE_SKIP_BUILD=1 (the same images and tag as the smoke test).
// 2. Starts the on-premise Compose file with the server demo image, whose build accepts the development keys, and the
//    overlay tools/smoke/compose/journey.yml, which turns the demo seed off; Mailpit, the provider mocks and Keycloak
//    come from the demo overlay. The database holds no organisation. With --saas the services also get
//    tools/smoke/compose/journey-saas.yml: tenancy mode multi, mail required and the plan presets.
// 3. Runs the installer step through the cli service (MILESTONE-2 A.2). On-premise: "tenant create" and
//    "admin create-user --tenant-admin", which emails the first administrator's invitation to Mailpit. With --saas:
//    "admin create-operator", which emails the platform operator's set-password link. On-premise the runner signs the
//    organisation's licence with the development licence key (packages/pack-tools/dist/cli.js licence sign) into a
//    temporary folder; with --saas the journey signs it once the operator has created the organisation on screen.
//    It also registers a certificate for an app of the mock SharePoint tenant, as the customer's Microsoft 365
//    administrator would before connecting the repository.
// 4. Runs tests/fresh-org.spec.mjs with Playwright: every person in their own browser session, every step on screen.
// 5. Removes the stack with its volumes and the temporary folder: on success, on failure and on Ctrl-C.
//
// Usage: npm run journey -w @mscd/smoke [-- --saas]
//        node tools/smoke/run-journey.mjs [options] [-- <Playwright arguments>]
//   --saas              the SaaS variant: the platform operator creates the organisation and installs its licence in
//                       the operator console, then the steps up to the creation of the management system
//   --build-ca <file>   CA certificate of a TLS-inspecting proxy for the image builds
//                       (default: $MSCD_BUILD_CA; an empty file when unset)
//   --keep              leave the stack running after the journey (same as SMOKE_KEEP=1; remove it with --down)
//   --down              only remove the stack of an earlier --keep run, then exit
//   -h, --help          show this text
// Arguments after "--" go to "playwright test" (for example --headed or --trace on).
//
// Environment (the image, port and network settings are those of run-smoke.mjs):
//   SMOKE_SKIP_BUILD=1      use existing images instead of building them
//   SMOKE_KEEP=1            leave the stack running after the journey
//   JOURNEY_PROJECT         Compose project name (default mscd-journey, or mscd-journey-saas with --saas)
//   JOURNEY_OUTPUT_DIR      folder for build logs, Compose logs, the Playwright report and traces
//                           (default tools/smoke/test-results/journey or journey-saas)
//   JOURNEY_TIME_ZONE       time zone of the new organisation (default Asia/Jakarta)
//   MSCD_VERSION            tag of the three images (default smoke)
//   MSCD_SERVER_DEMO_IMAGE, MSCD_IMAGE, MSCD_MOCK_IMAGE, MSCD_HTTP_PORT, MSCD_HTTPS_PORT, MSCD_KEYCLOAK_PORT,
//   MSCD_MAILPIT_PORT, MSCD_SUBNET, MSCD_WEB_ADDRESS, MSCD_BUILD_CA
//                           as for run-smoke.mjs (tools/smoke/README.md)
//
// Exit codes: 0 every step passed, 1 a build, the stack or a step failed, 2 wrong usage or a missing requirement.
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PEOPLE, ORGANISATION, OPERATOR, SHAREPOINT, isoDateIn } from './lib/journey-data.mjs';
import { DEV_LICENCE_KEY, PACK_TOOLS_CLI, signLicence } from './lib/licence.mjs';
import { smokeSettings } from './lib/settings.mjs';
import {
  COMPOSE_DIR, DEFAULT_SUBNET_OCTET, HERE, UP_TIMEOUT_SECONDS, UsageError, buildImages, capture, checkDocker, checkPorts,
  chooseSubnet, composeArgs, current, imageExists, imageRefs, run, saveComposeLogs, showUnhealthy, stackDown, usageOf, userPath,
} from './lib/stack.mjs';
import { selfTest } from './lib/totp.mjs';

function log(message) {
  process.stdout.write(`journey: ${message}\n`);
}

function parseCommandLine(argv) {
  const split = argv.indexOf('--');
  const own = split === -1 ? argv : argv.slice(0, split);
  const playwrightArgs = split === -1 ? [] : argv.slice(split + 1);
  const { values } = parseArgs({
    args: own,
    options: {
      saas: { type: 'boolean', default: false },
      'build-ca': { type: 'string' },
      keep: { type: 'boolean', default: false },
      down: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
  });
  return { ...values, playwrightArgs };
}

/** The Compose files of the journey stack. */
function composeFiles(saas) {
  return [
    path.join(COMPOSE_DIR, 'docker-compose.yml'),
    path.join(COMPOSE_DIR, 'docker-compose.demo.yml'),
    path.join(HERE, 'compose/journey.yml'),
    ...(saas ? [path.join(HERE, 'compose/journey-saas.yml')] : []),
  ];
}

/** Runs an operator command in the cli service ("docker compose run --rm cli ...") and returns its output. */
function cli(project, files, env, args) {
  return capture('docker', composeArgs(project, files, 'run', '--rm', '-T', 'cli', ...args), env);
}

/** The signing tool of @mscd/pack-tools; built from source when a fresh checkout has no build output yet. */
async function ensurePackTools() {
  if (existsSync(PACK_TOOLS_CLI)) return;
  log('building @mscd/pack-tools (packages/pack-tools/dist is missing)');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const code = await run(npm, ['run', 'build', '-w', '@mscd/shared', '-w', '@mscd/pack-tools'], { quiet: true });
  if (code !== 0 || !existsSync(PACK_TOOLS_CLI)) throw new UsageError('packages/pack-tools could not be built; run "npm run build -w @mscd/pack-tools" and try again.');
}

/**
 * Registers a certificate for an app of the mock SharePoint tenant, as the Microsoft 365 administrator registers the
 * MSCD app in Entra ID before the Tenant Admin connects the repository (docs/INSTALL-ONPREM.md, 10.1). The mock runs on
 * the internal network only, so the certificate is made and registered inside its container; the private key comes
 * back for the connect wizard, which seals it in the storage gateway.
 */
function registerSharePointApp(project, files, env) {
  const script = `
const { createSelfSignedCertificate } = await import('/app/tools/mock-providers/dist/certs.js');
const certificate = createSelfSignedCertificate({ commonName: 'MSCD journey connector', days: 30 });
const res = await fetch('http://127.0.0.1:4310/_admin/credentials', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ kind: 'm365_certificate', tenantId: ${JSON.stringify(SHAREPOINT.tenantId)}, clientId: ${JSON.stringify(SHAREPOINT.clientId)}, certificatePem: certificate.certificatePem, displayName: 'MSCD journey connector' }),
});
if (!res.ok) { process.stderr.write('mock registration answered ' + res.status + ' ' + (await res.text())); process.exit(1); }
process.stdout.write(JSON.stringify({ certificatePem: certificate.certificatePem, privateKeyPem: certificate.privateKeyPem }));`;
  const out = capture('docker', composeArgs(project, files, 'exec', '-T', 'mock-providers', 'node', '--input-type=module', '-e', script), env);
  return JSON.parse(out);
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
    process.stdout.write(usageOf(fileURLToPath(import.meta.url), '// Fresh-organisation'));
    return 0;
  }
  const saas = options.saas;
  const variant = saas ? 'saas' : 'onprem';

  const env = { ...process.env };
  // The stack is defined only by its files and the variables below (see run-smoke.mjs).
  for (const name of ['COMPOSE_FILE', 'COMPOSE_PROJECT_NAME', 'COMPOSE_PROFILES', 'COMPOSE_ENV_FILES']) delete env[name];
  env.MSCD_VERSION = env.MSCD_VERSION || 'smoke';
  const project = env.JOURNEY_PROJECT || (saas ? 'mscd-journey-saas' : 'mscd-journey');
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) throw new UsageError(`JOURNEY_PROJECT "${project}" is not a valid Compose project name`);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(env.MSCD_VERSION)) throw new UsageError(`MSCD_VERSION "${env.MSCD_VERSION}" is not a valid image tag`);
  const timeZone = env.JOURNEY_TIME_ZONE || ORGANISATION.timeZone;
  try {
    isoDateIn(timeZone);
  } catch {
    throw new UsageError(`JOURNEY_TIME_ZONE "${timeZone}" is not a time zone`);
  }
  const files = composeFiles(saas);

  let settings;
  try {
    settings = smokeSettings(env);
  } catch (e) {
    throw new UsageError(e.message);
  }
  env.MSCD_HTTP_PORT = String(settings.httpPort);
  env.MSCD_HTTPS_PORT = String(settings.httpsPort);
  env.MSCD_KEYCLOAK_PORT = String(settings.keycloakPort);
  env.MSCD_MAILPIT_PORT = String(settings.mailpitPort);
  env.MSCD_BIND_ADDRESS = '127.0.0.1';
  // The provider mocks get a fixed address next to the web container's, for the DNS answers of the SaaS variant
  // (journey-saas.yml). Set again once the network range is chosen; Compose needs a value for every command.
  const mockAddressOf = (webAddress) => webAddress.replace(/\.\d+$/, '.20');
  env.JOURNEY_MOCK_ADDRESS = mockAddressOf(env.MSCD_WEB_ADDRESS || `172.31.${DEFAULT_SUBNET_OCTET}.10`);
  const versions = checkDocker();
  if (options.down) {
    return (await stackDown(project, files, env, log)) === 0 ? 0 : 1;
  }

  const failedVectors = selfTest();
  if (failedVectors.length > 0) throw new Error(`the TOTP helper fails the RFC 6238 vectors at ${failedVectors.join(', ')}`);
  await ensurePackTools();

  const outputDir = env.JOURNEY_OUTPUT_DIR ? userPath(env.JOURNEY_OUTPUT_DIR) : path.join(HERE, 'test-results', saas ? 'journey-saas' : 'journey');
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  log(`Docker ${versions.docker}, Compose ${versions.compose}; project ${project} (${variant}); output in ${outputDir}`);

  await stackDown(project, files, env, log);
  await checkPorts(settings);
  const network = chooseSubnet(env, project);
  env.MSCD_SUBNET = network.subnet;
  env.MSCD_WEB_ADDRESS = network.webAddress;
  env.JOURNEY_MOCK_ADDRESS = mockAddressOf(network.webAddress);
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
      tempCaDir = mkdtempSync(path.join(os.tmpdir(), 'mscd-journey-ca-'));
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

  // The server date of the journey (journey.yml): today in the organisation's time zone, fixed for the run.
  env.JOURNEY_TODAY = isoDateIn(timeZone);
  // Licence, certificate key and the state of the run: a private temporary folder, removed at the end.
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'mscd-journey-'));
  chmodSync(stateDir, 0o700);

  const keep = options.keep || env.SMOKE_KEEP === '1' || env.SMOKE_KEEP === 'true';
  let stackStarted = false;
  cleanup = async () => {
    if (stackStarted) {
      stackStarted = false;
      if (keep) {
        log(`the stack is still running (--keep): ${settings.baseUrl}; state in ${stateDir}; remove it with "JOURNEY_PROJECT=${project} node tools/smoke/run-journey.mjs${saas ? ' --saas' : ''} --down"`);
        return;
      }
      await stackDown(project, files, env, log);
    }
    rmSync(stateDir, { recursive: true, force: true });
  };

  let result = 1;
  try {
    stackStarted = true;
    const started = Date.now();
    log(`starting the stack without demo data: web ${settings.baseUrl}, Keycloak 127.0.0.1:${settings.keycloakPort}, Mailpit ${settings.mailpitUrl}, network ${network.subnet}, server date ${env.JOURNEY_TODAY}`);
    const up = await run('docker', composeArgs(project, files, 'up', '-d', '--wait', '--wait-timeout', String(UP_TIMEOUT_SECONDS)), { env });
    if (up !== 0) {
      if (interrupted) return 130;
      showUnhealthy(project, files, env);
      const file = await saveComposeLogs(project, files, env, outputDir);
      throw new Error(`docker compose up --wait failed (exit ${up}); service logs in ${file}`);
    }
    log(`the stack is healthy after ${Math.round((Date.now() - started) / 1000)} s`);

    // The installer step (MILESTONE-2 A.2): everything after it happens in the browser.
    const state = {
      variant,
      today: env.JOURNEY_TODAY,
      timeZone,
      stateDir,
      outputDir,
      compose: { project, files, env: Object.fromEntries(Object.entries(env).filter(([k]) => /^(MSCD_|JOURNEY_)/.test(k))) },
      packTools: { cli: PACK_TOOLS_CLI, key: DEV_LICENCE_KEY },
      organisation: { ...ORGANISATION, timeZone },
      people: PEOPLE,
      operator: OPERATOR,
    };
    if (saas) {
      const out = cli(project, files, env, ['admin', 'create-operator', '--email', OPERATOR.email, '--name', OPERATOR.name]);
      if (!out.includes(`Invitation sent to ${OPERATOR.email}`)) throw new Error(`admin create-operator did not email the set-password link:\n${out}`);
      log(`platform operator ${OPERATOR.email} created; the set-password email is in Mailpit`);
    } else {
      const orgId = randomUUID();
      const created = cli(project, files, env, [
        'tenant', 'create', '--slug', ORGANISATION.slug, '--name', ORGANISATION.name, '--id', orgId, '--time-zone', timeZone, '--site-count', String(ORGANISATION.sites),
      ]);
      const id = created.match(/organisation \S+ \(([0-9a-f-]{36})\) created/)?.[1];
      if (id !== orgId) throw new Error(`tenant create did not create the organisation:\n${created}`);
      log(created.trim());
      const admin = PEOPLE.ana;
      const invited = cli(project, files, env, ['admin', 'create-user', '--org', ORGANISATION.slug, '--email', admin.email, '--name', admin.name, '--tenant-admin']);
      if (!invited.includes(`Invitation sent to ${admin.email}`)) throw new Error(`admin create-user did not email the invitation:\n${invited}`);
      log(`first administrator ${admin.email} invited by email`);
      state.organisation.id = orgId;
      state.licencePath = signLicence(stateDir, { orgId, orgName: ORGANISATION.name, today: env.JOURNEY_TODAY });
      log(`licence for organisation ${orgId} signed with the development licence key (valid from ${env.JOURNEY_TODAY})`);
    }
    state.sharepoint = { ...SHAREPOINT, ...registerSharePointApp(project, files, env) };
    log(`certificate of the SharePoint app ${SHAREPOINT.clientId} registered in the mock tenant`);
    const statePath = path.join(stateDir, 'state.json');
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

    const require = createRequire(import.meta.url);
    const playwright = require.resolve('@playwright/test/cli');
    const testEnv = { ...env, JOURNEY_STATE: statePath, JOURNEY_OUTPUT_DIR: outputDir };
    result = await run(process.execPath, [playwright, 'test', '--config', path.join(HERE, 'journey.config.mjs'), ...options.playwrightArgs], { env: testEnv, cwd: HERE });
    if (interrupted) return 130;
    if (result !== 0) {
      const file = await saveComposeLogs(project, files, env, outputDir);
      log(`the journey failed; report in ${path.join(outputDir, 'report')}, service logs in ${file}`);
      result = 1;
    } else {
      log(`every step of the ${saas ? 'SaaS' : 'on-premise'} journey passed`);
    }
  } finally {
    await cleanup();
  }
  return result;
}

async function onSignal(signal) {
  interrupted = true;
  process.stderr.write(`\njourney: ${signal} received, stopping\n`);
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
    (e) => {
      process.stderr.write(`journey: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exitCode = e instanceof UsageError ? 2 : 1;
    },
  );
}
