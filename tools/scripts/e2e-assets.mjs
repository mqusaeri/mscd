// Static files of the browser suites' web servers (Milestone 2 M2-21): a `vite preview` plugin that serves the files
// of a build's assets/ folder from memory, the way NGINX serves them in production (deploy/nginx/site.conf and
// nginx.conf): text files pre-compressed with gzip (gzip_static), files with a content hash in their name cached for a
// year (immutable), other assets for an hour. Without it, `vite preview` reads every file from disk again and
// compresses it again on every request, and marks it no-cache, so each page load of a test asks for every file again.
// index.html and the app routes stay with `vite preview` (no-cache, as NGINX serves them).
//
// Usage: preview({ ..., plugins: [memoryAssets(distDir)] })
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const TYPES = {
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.map': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};
/** The types NGINX compresses (gzip_types of deploy/nginx/nginx.conf), from 1024 bytes (gzip_min_length). */
const COMPRESSED = new Set(['application/javascript', 'text/css', 'application/json', 'image/svg+xml', 'text/plain']);
const MIN_GZIP_BYTES = 1024;
/** A build file with a content hash in its name (name-AbCd1234.ext), as site.conf matches it. */
const HASHED = /-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/;

/** Every file under `dir` (relative paths with forward slashes). */
function filesUnder(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, `${prefix}${entry}/`));
    else out.push(`${prefix}${entry}`);
  }
  return out;
}

/** Loads the assets/ folder of `distDir` into memory: { '/assets/x.js': { body, gzip, type, cache } }. */
export function loadAssets(distDir) {
  const root = path.join(distDir, 'assets');
  const files = new Map();
  for (const name of filesUnder(root)) {
    const body = readFileSync(path.join(root, name));
    const type = TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
    const gzip = COMPRESSED.has(type) && body.length >= MIN_GZIP_BYTES ? gzipSync(body, { level: 6 }) : null;
    const cache = HASHED.test(name) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
    files.set(`/assets/${name}`, { body, gzip, type, cache });
  }
  return files;
}

/** The `vite preview` plugin: answers GET and HEAD requests for files of assets/ from memory. */
export function memoryAssets(distDir) {
  const files = loadAssets(distDir);
  return {
    name: 'mscd-e2e-memory-assets',
    configurePreviewServer(server) {
      // Added here (not in a returned hook), so it runs before the proxy, compression and static files of vite.
      server.middlewares.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return next();
        let pathname;
        try {
          pathname = decodeURIComponent((req.url ?? '').split('?')[0]);
        } catch {
          return next();
        }
        const file = files.get(pathname);
        if (!file) return next();
        const gzip = file.gzip && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
        const body = gzip ? file.gzip : file.body;
        res.statusCode = 200;
        res.setHeader('Content-Type', file.type);
        res.setHeader('Content-Length', String(body.length));
        res.setHeader('Cache-Control', file.cache);
        if (file.gzip) res.setHeader('Vary', 'Accept-Encoding');
        if (gzip) res.setHeader('Content-Encoding', 'gzip');
        res.end(req.method === 'HEAD' ? undefined : body);
      });
    },
  };
}
