#!/usr/bin/env node
// Web server of the sample browser suite (Milestone 2 M2-21, apps/web/playwright.config.js): builds the app with the
// sample data source when its sources changed since the last build (tools/scripts/e2e-cache.mjs), else reuses that
// build, and serves it with `vite preview` on the given port; the files of assets/ come from memory with the cache
// and compression headers NGINX gives them in production (e2e-assets.mjs). A server already listening on the port
// makes it stop with an error instead of testing a stale build.
//
// Usage: node tools/scripts/e2e-web-serve.mjs <sample|api> <port>
import path from 'node:path';
import { preview } from 'vite';
import { memoryAssets } from './e2e-assets.mjs';
import { ROOT, webBuild } from './e2e-cache.mjs';

const [source, port] = process.argv.slice(2);
if (!['sample', 'api'].includes(source) || !Number(port)) {
  process.stderr.write('Usage: node tools/scripts/e2e-web-serve.mjs <sample|api> <port>\n');
  process.exit(2);
}

const log = (message) => process.stdout.write(`e2e web: ${message}\n`);
const started = Date.now();
const dist = await webBuild(source, { log });
const server = await preview({
  root: path.join(ROOT, 'apps/web'),
  configFile: false,
  logLevel: 'warn',
  base: source === 'api' ? '/' : './',
  plugins: [memoryAssets(dist)],
  build: { outDir: dist },
  preview: { port: Number(port), strictPort: true },
});
log(`serving the ${source} build on http://localhost:${port} (ready in ${((Date.now() - started) / 1000).toFixed(1)} s)`);

async function close() {
  await server.close().catch(() => undefined);
  process.exit(0);
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => void close());
