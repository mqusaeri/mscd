// Build cache of the browser suites (Milestone 2 M2-21). A build runs only when the content of its sources changed:
// each build has a key, the SHA-256 of its source files (paths and bytes), kept in node_modules/.cache/mscd/e2e/.
//
//   server         npm run build -w @mscd/server, when apps/server/src (without src/generated), its tsconfig files,
//                  package.json, the migrations, the prebuild script that writes src/generated (scripts/gen-build-info.mjs),
//                  the development keys it compiles in (packages/pack-tools/dev-keys) or the sources of @mscd/shared and
//                  @mscd/pack-tools changed, or dist/main.js is missing
//   mock providers npm run build -w @mscd/mock-providers, when tools/mock-providers/src changed
//   web build      `vite build` of apps/web with a data source (api or sample) into web-<source>-<key>/, reused while
//                  the sources of the app, @mscd/shared and the build settings are the same
//
// The template database of the API stack has its own key (`templateKey`, e2e-api/stack.mjs). Builds of the same key
// in two processes at once wait for each other through a lock folder. E2E_STACK_CACHE=off builds everything again.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CACHE_DIR = path.join(ROOT, 'node_modules', '.cache', 'mscd', 'e2e');
const WEB = path.join(ROOT, 'apps/web');
/** Web builds kept per data source (older ones are removed). */
const KEEP_WEB_BUILDS = 3;
/** A lock older than this is left over from a killed run. */
const STALE_LOCK_MS = 10 * 60 * 1000;

export const cacheOff = (env = process.env) => env.E2E_STACK_CACHE === 'off';

/** SHA-256 over the files under `paths` (relative to the repository root), in path order; `skip` filters paths. */
export function hashTree(paths, { skip = () => false, extra = '' } = {}) {
  const hash = createHash('sha256');
  hash.update(extra);
  const files = [];
  const visit = (relative) => {
    const full = path.join(ROOT, relative);
    let info;
    try {
      info = statSync(full);
    } catch {
      return;
    }
    if (skip(relative)) return;
    if (info.isDirectory()) {
      for (const entry of readdirSync(full).sort()) {
        if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
        visit(path.join(relative, entry));
      }
    } else if (info.isFile()) {
      files.push(relative);
    }
  };
  for (const p of paths) visit(p);
  for (const file of files.sort()) {
    hash.update(`${file}\0`);
    hash.update(readFileSync(path.join(ROOT, file)));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 20);
}

/** Holds a lock folder while `fn` runs; waits for another holder, takes over a stale lock. */
export async function withLock(name, fn, { waitMs = 15 * 60 * 1000, log = () => undefined } = {}) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const lock = path.join(CACHE_DIR, `${name}.lock`);
  const deadline = Date.now() + waitMs;
  let told = false;
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(path.join(lock, 'pid'), String(process.pid));
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue;
      }
      if (age > STALE_LOCK_MS) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) throw new Error(`The lock ${lock} is still held after ${waitMs / 1000} s`);
      if (!told) log(`waiting for ${name} (another run holds ${path.relative(ROOT, lock)})`);
      told = true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function stampFile(name) {
  return path.join(CACHE_DIR, `${name}.key`);
}
function readStamp(name) {
  try {
    return readFileSync(stampFile(name), 'utf8').trim();
  } catch {
    return '';
  }
}
function writeStamp(name, key) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(stampFile(name), `${key}\n`);
}

/** Runs a build command without blocking the event loop; rejects with the end of its output when it fails. */
function run(title, command, args, options, log) {
  log(title);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let output = '';
    const keep = (chunk) => {
      output = (output + chunk).slice(-64 * 1024);
    };
    child.stdout.setEncoding('utf8').on('data', keep);
    child.stderr.setEncoding('utf8').on('data', keep);
    child.on('error', (error) => reject(new Error(`${title} failed (${error.message})`)));
    child.on('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${title} failed (exit ${code ?? signal})\n${output.trim().split('\n').slice(-40).join('\n')}`));
    });
  });
}

const SHARED_SOURCES = ['packages/shared/src', 'packages/shared/package.json', 'packages/pack-tools/src', 'packages/pack-tools/package.json'];

/**
 * Inputs of the server prebuild (scripts/gen-build-info.mjs), which writes src/generated (left out of the hash below):
 * the script itself, the migrations it lists and the development keys it compiles in as trust anchors.
 */
const SERVER_PREBUILD_INPUTS = ['apps/server/scripts/gen-build-info.mjs', 'apps/server/migrations', 'packages/pack-tools/dev-keys'];

/** Key of the server build (notes such as a module's README.md do not change the build and are left out). */
export function serverKey() {
  return hashTree(
    ['apps/server/src', 'apps/server/package.json', 'apps/server/tsconfig.json', 'apps/server/tsconfig.build.json', ...SERVER_PREBUILD_INPUTS, ...SHARED_SOURCES],
    {
      skip: (p) => p.startsWith(path.join('apps', 'server', 'src', 'generated')) || p.endsWith('.md'),
    },
  );
}

/** Builds the server when its key changed or its output is missing. Returns true when it built. */
export async function ensureServerBuilt({ log = () => undefined, env = process.env } = {}) {
  return withLock('server-build', async () => {
    const key = serverKey();
    if (!cacheOff(env) && readStamp('server') === key && existsSync(path.join(ROOT, 'apps/server/dist/main.js'))) {
      log('server build is up to date (cached)');
      return false;
    }
    await run('build the server', 'npm', ['run', 'build', '-w', '@mscd/server'], {}, log);
    writeStamp('server', key);
    return true;
  }, { log });
}

/** Key of the mock providers build. */
export function mockKey() {
  return hashTree(['tools/mock-providers/src', 'tools/mock-providers/package.json', 'tools/mock-providers/tsconfig.json', 'tools/mock-providers/tsconfig.build.json']);
}

/** Builds the mock providers when their key changed or their output is missing. Returns true when it built. */
export async function ensureMockBuilt({ log = () => undefined, env = process.env } = {}) {
  return withLock('mock-build', async () => {
    const key = mockKey();
    if (!cacheOff(env) && readStamp('mock-providers') === key && existsSync(path.join(ROOT, 'tools/mock-providers/dist/server.js'))) {
      log('mock providers build is up to date (cached)');
      return false;
    }
    await run('build the mock providers', 'npm', ['run', 'build', '-w', '@mscd/mock-providers'], {}, log);
    writeStamp('mock-providers', key);
    return true;
  }, { log });
}

/** Key of a web build with `source` (api or sample). */
export function webKey(source) {
  return hashTree(
    ['apps/web/src', 'apps/web/public', 'apps/web/index.html', 'apps/web/vite.config.js', 'apps/web/package.json', 'packages/shared/src', 'package-lock.json'],
    { extra: `VITE_DATA_SOURCE=${source}\n` },
  );
}

const viteBin = () => path.join(path.dirname(createRequire(path.join(WEB, 'package.json')).resolve('vite/package.json')), 'bin/vite.js');

/**
 * A `vite build` of apps/web with VITE_DATA_SOURCE=`source`, from the cache when its key matches. Returns the folder
 * of the build (node_modules/.cache/mscd/e2e/web-<source>-<key>); never write into it.
 */
export async function webBuild(source, { log = () => undefined, env = process.env } = {}) {
  if (source !== 'api' && source !== 'sample') throw new Error(`web build source must be api or sample, got "${source}"`);
  const key = webKey(source);
  const dir = path.join(CACHE_DIR, `web-${source}-${key}`);
  return withLock(`web-${source}-build`, async () => {
    if (!cacheOff(env) && existsSync(path.join(dir, 'index.html'))) {
      log(`web build (VITE_DATA_SOURCE=${source}) is up to date (cached)`);
      return dir;
    }
    const temp = `${dir}.tmp-${process.pid}`;
    rmSync(temp, { recursive: true, force: true });
    const buildEnv = { ...env };
    if (source === 'api') buildEnv.VITE_DATA_SOURCE = 'api';
    else delete buildEnv.VITE_DATA_SOURCE;
    await run(`build the web app (VITE_DATA_SOURCE=${source})`, process.execPath, [viteBin(), 'build', '--outDir', temp, '--emptyOutDir', '--logLevel', 'warn'], { cwd: WEB, env: buildEnv }, log);
    rmSync(dir, { recursive: true, force: true });
    renameSync(temp, dir);
    pruneWebBuilds(source, dir);
    return dir;
  }, { log });
}

/** Keeps the newest KEEP_WEB_BUILDS builds of a data source. */
function pruneWebBuilds(source, keep) {
  const prefix = `web-${source}-`;
  const builds = readdirSync(CACHE_DIR)
    .filter((name) => name.startsWith(prefix) && !name.includes('.tmp-'))
    .map((name) => ({ dir: path.join(CACHE_DIR, name), mtime: statSync(path.join(CACHE_DIR, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { dir } of builds.slice(KEEP_WEB_BUILDS)) if (dir !== keep) rmSync(dir, { recursive: true, force: true });
}
