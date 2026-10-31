#!/usr/bin/env node
// Third-party notices (Milestone 3, M3-M01): writes THIRD-PARTY-NOTICES.md at the repository root from the
// production dependency tree of package-lock.json, plus the SecLists notice of the common password list.
//
// Usage: node tools/scripts/third-party-notices.mjs [--check] [--out FILE]
//   (no option)  write THIRD-PARTY-NOTICES.md
//   --check      write nothing; exit 1 when the file is missing or differs from what would be written
//   --out FILE   another output file (for tests)
//
// The tree starts at the workspaces that the release images run: @mscd/server, @mscd/shared and
// @mscd/pack-tools (server image; deploy/docker/server.Dockerfile installs their production dependencies) and
// @mscd/web (web image; Vite bundles its production dependencies). It follows dependencies,
// optionalDependencies and peerDependencies that are not optional, resolved the way Node.js does through the
// node_modules folders of the lockfile; devDependencies are never followed. Each package is listed once per
// name and version with the licence of its lockfile entry and the text of its licence files (LICENSE, LICENCE,
// COPYING, UNLICENSE with any suffix) and NOTICE files, read from node_modules. Identical texts are printed once.
//
// Platform builds (optional packages limited to an operating system or processor, such as
// @node-rs/argon2-linux-x64-musl) are listed when they can run in a Linux image on x64 or arm64. Their folders
// are never read, because npm installs only those of the machine it runs on, so the file is the same on every
// machine: they carry no licence file of their own and are listed with the licence text of the package they
// belong to, when both declare the same licence.
//
// Exit codes: 0 done (or up to date with --check); 1 the file is missing or out of date (--check only); 2 a
// wrong option, or node_modules does not match package-lock.json (run npm ci); 3 the file cannot be generated,
// because package-lock.json cannot be read or walked, or the common password list has no SecLists notice.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_OUT = path.join(REPO, 'THIRD-PARTY-NOTICES.md');
const PASSWORD_LIST = 'apps/server/src/modules/identity/common-passwords.txt';

/** Release images and the workspaces whose production dependencies each one runs. */
const IMAGES = [
  { label: 'server', roots: ['apps/server', 'packages/shared', 'packages/pack-tools'] },
  { label: 'web', roots: ['apps/web'] },
];
/** Platforms of the release images: Linux on x64 or arm64 (build-bundle.sh saves linux/<arch>). */
const IMAGE_OS = 'linux';
const IMAGE_CPUS = ['x64', 'arm64'];

const LICENCE_FILE = /^(licen[cs]e|copying|unlicense)([-._].*)?$/i;
const NOTICE_FILE = /^notice([-._].*)?$/i;

class UsageError extends Error {}
class MissingPackageError extends Error {}
/** package-lock.json or the common password list cannot be used: exit 3 ("cannot be generated"). */
class SourceError extends Error {}

function parseArgs(argv) {
  const options = { check: false, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') options.check = true;
    else if (arg === '--out') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new UsageError('--out needs a file name');
      options.out = path.resolve(value);
      i += 1;
    } else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new UsageError(`Unknown option ${arg}`);
  }
  return options;
}

const USAGE = `Usage: node tools/scripts/third-party-notices.mjs [--check] [--out FILE]

Writes THIRD-PARTY-NOTICES.md from the production dependency tree of package-lock.json
(the packages of the server and web release images) and the SecLists notice of the
common password list. --check writes nothing and exits 1 when the file is out of date.
Run "npm ci" first: the licence texts are read from node_modules.

Exit codes: 0 done or up to date, 1 missing or out of date (--check), 2 wrong option or
node_modules does not match package-lock.json, 3 package-lock.json or the common password
list cannot be used (the file cannot be generated).
`;

/** The lockfile key that Node.js resolves `name` to from the package folder `from`. */
function resolveDependency(packages, from, name) {
  let base = from;
  for (;;) {
    const candidate = `${base ? `${base}/` : ''}node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!base) return null;
    const nested = base.lastIndexOf('/node_modules/');
    base = nested >= 0 ? base.slice(0, nested) : '';
  }
}

/** The name of the package at a lockfile key (the part after the last node_modules/). */
function nameOf(key) {
  return key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

function isPlatformBuild(entry) {
  return entry.optional === true && Boolean(entry.os || entry.cpu || entry.libc);
}

/** True when the npm `os` or `cpu` list of a package (names, or names with "!" to exclude) allows `value`. */
function allows(list, value) {
  if (!list || list.length === 0) return true;
  const allowed = list.filter((v) => !v.startsWith('!'));
  const excluded = list.filter((v) => v.startsWith('!')).map((v) => v.slice(1));
  return (allowed.length === 0 || allowed.includes(value)) && !excluded.includes(value);
}

/** A platform build that can run in a release image (Linux on x64 or arm64). */
function runsInImage(entry) {
  return allows(entry.os, IMAGE_OS) && IMAGE_CPUS.some((cpu) => allows(entry.cpu, cpu));
}

function licenceOf(entry, key) {
  const value = entry.license;
  if (typeof value === 'string' && value) return value;
  if (value && typeof value === 'object' && typeof value.type === 'string') return value.type;
  if (Array.isArray(entry.licenses)) {
    const types = entry.licenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter(Boolean);
    if (types.length) return types.join(' OR ');
  }
  if (!isPlatformBuild(entry)) {
    const manifest = readManifest(key);
    if (typeof manifest.license === 'string' && manifest.license) return manifest.license;
    if (manifest.license?.type) return manifest.license.type;
    if (Array.isArray(manifest.licenses)) {
      const types = manifest.licenses.map((l) => (typeof l === 'string' ? l : l?.type)).filter(Boolean);
      if (types.length) return types.join(' OR ');
    }
  }
  return 'not declared';
}

function readManifest(key) {
  try {
    return JSON.parse(readFileSync(path.join(REPO, key, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** Walks the production tree from the image roots. Returns one record per lockfile key of a package. */
function walkTree(lock) {
  const packages = lock.packages ?? {};
  const records = new Map();
  for (const image of IMAGES) {
    const queue = image.roots.map((root) => ({ key: root, parent: null, via: 'root' }));
    const visited = new Set();
    while (queue.length > 0) {
      const item = queue.shift();
      let key = item.key;
      let entry = packages[key];
      if (!entry) throw new SourceError(`package-lock.json has no entry ${key}`);
      if (entry.link) {
        key = entry.resolved;
        entry = packages[key];
        if (!entry) throw new SourceError(`package-lock.json links to ${key}, which has no entry`);
      }
      if (visited.has(key)) continue;
      visited.add(key);
      const isWorkspace = !key.includes('node_modules/');
      if (!isWorkspace) {
        if (isPlatformBuild(entry) && !runsInImage(entry)) continue;
        let record = records.get(key);
        if (!record) {
          record = { key, entry, name: nameOf(key), version: entry.version ?? '', images: new Set(), parent: null };
          records.set(key, record);
        }
        record.images.add(image.label);
        if (!record.parent && item.via === 'optional' && item.parent) record.parent = item.parent;
      }
      const optional = new Set(Object.keys(entry.optionalDependencies ?? {}));
      const wanted = [
        ...Object.keys(entry.dependencies ?? {}).map((name) => [name, 'dependency']),
        ...[...optional].map((name) => [name, 'optional']),
        ...Object.keys(entry.peerDependencies ?? {})
          .filter((name) => !entry.peerDependenciesMeta?.[name]?.optional)
          .map((name) => [name, 'peer']),
      ];
      for (const [name, via] of wanted) {
        const target = resolveDependency(packages, key, name);
        if (!target) {
          if (via === 'optional') continue;
          throw new SourceError(`package-lock.json does not resolve ${name}, a ${via} of ${key || 'the root'}`);
        }
        queue.push({ key: target, parent: isWorkspace ? null : key, via });
      }
    }
  }
  return [...records.values()];
}

/** Licence text of a file: no BOM, LF line ends, no trailing spaces, no blank lines around it. */
function normaliseText(text) {
  const lines = text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''));
  while (lines.length && lines[0] === '') lines.shift();
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

function byCodePoint(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The licence and notice files of an installed package, as [{ file, text }], licence files first. */
function licenceFiles(record) {
  const dir = path.join(REPO, record.key);
  if (!existsSync(dir)) {
    throw new MissingPackageError(`${record.key} is not installed (needed for ${record.name} ${record.version}). Run npm ci.`);
  }
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((item) => item.isFile())
    .map((item) => item.name);
  const licences = names.filter((name) => LICENCE_FILE.test(name)).sort(byCodePoint);
  const notices = names.filter((name) => NOTICE_FILE.test(name)).sort(byCodePoint);
  return [...licences, ...notices]
    .map((file) => ({ file, text: normaliseText(readFileSync(path.join(dir, file), 'utf8')) }))
    .filter((part) => part.text !== '');
}

/** Compares two semantic versions (release part numerically, then the pre-release text). */
function compareVersions(a, b) {
  const [ra, pa = ''] = a.split(/-(.*)/s);
  const [rb, pb = ''] = b.split(/-(.*)/s);
  const na = ra.split('.').map(Number);
  const nb = rb.split('.').map(Number);
  for (let i = 0; i < Math.max(na.length, nb.length); i += 1) {
    const d = (na[i] || 0) - (nb[i] || 0);
    if (d !== 0 && !Number.isNaN(d)) return d;
  }
  if (pa === pb) return byCodePoint(a, b);
  if (!pa) return 1;
  if (!pb) return -1;
  return byCodePoint(pa, pb);
}

function cell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function fence(text) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function codeBlock(text) {
  const f = fence(text);
  return `${f}text\n${text}\n${f}`;
}

function sourceOf(record) {
  const manifest = readManifest(record.key);
  let repo = manifest.repository;
  if (repo && typeof repo === 'object') repo = repo.url;
  if (typeof repo === 'string' && repo) {
    return repo.replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '');
  }
  if (typeof manifest.homepage === 'string' && manifest.homepage) return manifest.homepage;
  return 'not given';
}

/** The SecLists part of the header of the common password list (from "Source:" to the first empty line). */
function passwordListNotice() {
  const file = path.join(REPO, PASSWORD_LIST);
  const header = [];
  for (const line of readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').split('\n')) {
    if (line.trim() === '') break;
    if (!line.startsWith('#')) break;
    header.push(line.replace(/^# ?/, '').replace(/\s+$/, ''));
  }
  const start = header.findIndex((line) => line.startsWith('Source:'));
  if (start < 0 || !header.some((line) => line.includes('SecLists'))) {
    throw new SourceError(`${PASSWORD_LIST} has no SecLists notice in its header (a line starting with "# Source:")`);
  }
  return normaliseText(header.slice(start).join('\n'));
}

function render(lock) {
  const records = walkTree(lock);
  // One row per name and version; a package installed at several paths keeps every image it is in.
  const rows = new Map();
  for (const record of records) {
    const id = `${record.name}@${record.version}`;
    const row = rows.get(id);
    if (!row) {
      rows.set(id, { ...record, images: new Set(record.images) });
    } else {
      for (const image of record.images) row.images.add(image);
      if (!row.parent && record.parent) row.parent = record.parent;
    }
  }
  const sorted = [...rows.values()].sort((a, b) => byCodePoint(a.name, b.name) || compareVersions(a.version, b.version));

  // Licence texts of the installed packages first, then the platform builds take the text of their package.
  const keyOf = new Map();
  const partsOf = new Map();
  for (const row of sorted) {
    row.licence = licenceOf(row.entry, row.key);
    if (isPlatformBuild(row.entry)) continue;
    const parts = licenceFiles(row);
    if (parts.length === 0) continue;
    const textKey = parts.length === 1 ? parts[0].text : parts.map((p) => `${p.file}\0${p.text}`).join('\0\0');
    keyOf.set(row.key, textKey);
    partsOf.set(textKey, parts);
  }
  for (const row of sorted) {
    if (!isPlatformBuild(row.entry)) continue;
    const parent = row.parent ? records.find((r) => r.key === row.parent) : null;
    if (parent && keyOf.has(parent.key) && licenceOf(parent.entry, parent.key) === row.licence) {
      keyOf.set(row.key, keyOf.get(parent.key));
      row.platformOf = `${parent.name} ${parent.version}`;
    }
  }

  const textNumber = new Map();
  const usedBy = new Map();
  for (const row of sorted) {
    const textKey = keyOf.get(row.key);
    if (textKey === undefined) continue;
    if (!textNumber.has(textKey)) textNumber.set(textKey, textNumber.size + 1);
    if (!usedBy.has(textKey)) usedBy.set(textKey, []);
    usedBy.get(textKey).push(row);
  }

  const out = [];
  out.push('# Third-party notices', '');
  out.push(
    'MSCD (Management System Compliance Dashboard) by CyberLentera includes the third-party software listed in this file: ' +
      'the npm packages that the MSCD release images run (the production dependencies of the MSCD server and web app, read ' +
      'from `package-lock.json`) and the common password list of the password policy. Each package is used under the ' +
      'licence shown, and its licence text is reproduced below.',
    '',
    'The container images also hold software that this file does not list and whose licence information is inside each ' +
      'image: Node.js and Alpine Linux in the server image, NGINX and Alpine Linux in the web image, and the PostgreSQL, ' +
      'SeaweedFS and Valkey images of the on-premise bundle.',
    '',
    'This file is generated by `node tools/scripts/third-party-notices.mjs`. Do not edit it by hand; ' +
      '`node tools/scripts/third-party-notices.mjs --check` fails when it is out of date.',
    '',
  );
  out.push('## Contents', '');
  out.push('1. [Packages](#packages)', '2. [Common password list](#common-password-list)');
  const missing = sorted.filter((row) => !keyOf.has(row.key));
  if (missing.length) out.push('3. [Packages without a licence file](#packages-without-a-licence-file)');
  out.push(`${missing.length ? 4 : 3}. [Licence texts](#licence-texts)`, '');

  out.push('## Packages', '');
  out.push(
    `${sorted.length} packages. "Image" names the release images whose production dependencies include the package. ` +
      'A platform build is a prebuilt native program of a package for one operating system and processor; it carries no ' +
      'licence file of its own and is shown with the licence text of the package it belongs to.',
    '',
  );
  out.push('| Package | Version | Licence | Image | Licence text |', '|---|---|---|---|---|');
  for (const row of sorted) {
    const images = IMAGES.map((image) => image.label).filter((label) => row.images.has(label)).join(', ');
    const textKey = keyOf.get(row.key);
    let text = 'none in the package';
    if (textKey !== undefined) {
      const n = textNumber.get(textKey);
      text = `[${n}](#licence-text-${n})${row.platformOf ? `, platform build of \`${cell(row.platformOf)}\`` : ''}`;
    }
    out.push(`| \`${cell(row.name)}\` | ${cell(row.version)} | ${cell(row.licence)} | ${images} | ${text} |`);
  }
  out.push('');

  out.push('## Common password list', '');
  out.push(
    `The password policy of the server refuses common passwords from a list (\`${PASSWORD_LIST}\`, shipped in the server ` +
      'image next to the compiled module). The list is taken from SecLists under the following notice:',
    '',
    codeBlock(passwordListNotice()),
    '',
  );

  if (missing.length) {
    out.push('## Packages without a licence file', '');
    out.push(
      'These packages hold no licence file. They are used under the licence their package.json declares; the source ' +
        'names where the package is published.',
      '',
    );
    out.push('| Package | Version | Licence | Source |', '|---|---|---|---|');
    for (const row of missing) {
      const source = isPlatformBuild(row.entry) ? 'platform build, not read' : sourceOf(row);
      out.push(`| \`${cell(row.name)}\` | ${cell(row.version)} | ${cell(row.licence)} | ${cell(source)} |`);
    }
    out.push('');
  }

  out.push('## Licence texts', '');
  for (const [textKey, n] of textNumber) {
    out.push(`### Licence text ${n}`, '');
    const users = usedBy.get(textKey).map((row) => `\`${row.name}\` ${row.version}`);
    out.push(`Used by ${users.join(', ')}.`, '');
    const parts = partsOf.get(textKey);
    if (parts.length === 1) {
      out.push(codeBlock(parts[0].text), '');
    } else {
      for (const part of parts) out.push(`From \`${part.file}\`:`, '', codeBlock(part.text), '');
    }
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

function firstDifference(a, b) {
  const la = a.split('\n');
  const lb = b.split('\n');
  for (let i = 0; i < Math.max(la.length, lb.length); i += 1) {
    if (la[i] !== lb[i]) return { line: i + 1, expected: la[i] ?? '(end of file)', actual: lb[i] ?? '(end of file)' };
  }
  return null;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (!existsSync(path.join(REPO, 'node_modules'))) {
    process.stderr.write('node_modules is missing: run npm ci first (the licence texts are read from it).\n');
    process.exit(2);
  }
  let lock;
  try {
    lock = JSON.parse(readFileSync(path.join(REPO, 'package-lock.json'), 'utf8'));
  } catch (error) {
    process.stderr.write(`package-lock.json cannot be read: ${error.message}\n`);
    process.exit(3);
  }
  let content;
  try {
    content = render(lock);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    // Exit 1 is kept for "missing or out of date", so build-bundle.sh can name the cause.
    process.exit(error instanceof MissingPackageError ? 2 : 3);
  }
  const inRepo = !path.relative(REPO, options.out).startsWith('..');
  const shown = inRepo ? path.relative(REPO, options.out) : options.out;
  if (options.check) {
    const current = existsSync(options.out) ? readFileSync(options.out, 'utf8') : null;
    if (current === content) {
      process.stdout.write(`${shown} is up to date.\n`);
      return;
    }
    if (current === null) {
      process.stderr.write(`${shown} is missing. Run: node tools/scripts/third-party-notices.mjs\n`);
    } else {
      const diff = firstDifference(content, current);
      process.stderr.write(
        `${shown} is out of date (first difference at line ${diff.line}).\n` +
          `  expected: ${diff.expected.slice(0, 160)}\n` +
          `  found:    ${diff.actual.slice(0, 160)}\n` +
          'Run node tools/scripts/third-party-notices.mjs and commit the result.\n',
      );
    }
    process.exit(1);
  }
  writeFileSync(options.out, content);
  process.stdout.write(`${shown} written (${Buffer.byteLength(content)} bytes).\n`);
}

main();
