#!/usr/bin/env node
// The web app of the API end-to-end stack (M2-21): one `vite preview` server per lane, all in this one process, each
// serving the same API build (VITE_DATA_SOURCE=api) and forwarding /api to the api of its lane. The browser keeps
// talking to one origin per lane, so the session cookie and the Origin check of the api (F.2) work as behind NGINX;
// the api of each lane has its web address as `http.public_url`. The files of assets/ come from memory with the
// cache and compression headers NGINX gives them in production (tools/scripts/e2e-assets.mjs).
//
// Usage: node e2e-api/web-server.mjs --dist <folder> --lane <web port>=<api url> [--lane ...]
// Started and stopped by e2e-api/stack.mjs; it ends when that process ends.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { preview } from 'vite';
import { memoryAssets } from '../../../tools/scripts/e2e-assets.mjs';

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { values } = parseArgs({ options: { dist: { type: 'string' }, lane: { type: 'string', multiple: true } }, strict: true });
if (!values.dist || !values.lane?.length) {
  process.stderr.write('Usage: node e2e-api/web-server.mjs --dist <folder> --lane <web port>=<api url> [--lane ...]\n');
  process.exit(2);
}

const servers = [];
const assets = memoryAssets(path.resolve(values.dist));
for (const lane of values.lane) {
  const [port, target] = lane.split('=');
  const server = await preview({
    root: WEB,
    configFile: false,
    logLevel: 'warn',
    base: '/',
    plugins: [assets],
    build: { outDir: path.resolve(values.dist) },
    preview: { port: Number(port), strictPort: true, proxy: { '/api': { target, changeOrigin: false } } },
  });
  servers.push(server);
  process.stdout.write(`web on http://localhost:${port} (api ${target})\n`);
}

async function close() {
  await Promise.allSettled(servers.map((s) => s.close()));
  process.exit(0);
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => void close());
// The stack watches this process; when the stack goes away, so does this one.
const parent = process.ppid;
setInterval(() => {
  try {
    process.kill(parent, 0);
  } catch {
    void close();
  }
}, 2000).unref();
