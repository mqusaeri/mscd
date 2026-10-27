#!/usr/bin/env node
// GitHub Actions workflow check (Milestone 2 plan K.1, rule S-4; package M2-S01). Fails when a workflow:
//
//   1. has no top-level `permissions` (or sets it to write-all);
//   2. uses a third-party action or reusable workflow that is not pinned to a full 40-character commit SHA with
//      the tag in a comment (`uses: owner/repo@<sha> # v1.2.3`), or a `docker://` image without a digest.
//      Third party means every `uses:` outside this repository (`./...`), GitHub's own actions included;
//   3. puts a secret into script text: `${{ secrets.* }}` or `${{ github.token }}` inside `run:` (or the
//      `script:` input of actions/github-script). Secrets reach scripts only through `env`;
//   4. has a job whose environment is `production` or `staging`, or is chosen by an expression, without a
//      concurrency group with `cancel-in-progress: false` (on the job or the workflow), so two deploys never
//      run at once and a running deploy is never cancelled.
//
// Usage:
//   node tools/scripts/check-workflows.mjs <workflow file>...
//   node tools/scripts/check-workflows.mjs --saas [--require-all] [<workflow file>...]
//   node tools/scripts/check-workflows.mjs --self-test
//
//   --saas          also check the SaaS workflows of .github/workflows that exist (SAAS_WORKFLOWS below)
//   --require-all   with --saas: fail when one of the SaaS workflows is missing
//   --self-test     run the built-in cases of every check and exit
//
// Exit codes: 0 every workflow passes, 1 a finding, 2 usage error or a file that cannot be read.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LineCounter, isMap, isScalar, isSeq, parseDocument } from 'yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW_DIR = path.join(ROOT, '.github', 'workflows');

/** The workflows of the SaaS production track (K.6): release and scans (M2-S01), bootstrap, deploy, restore, ops. */
export const SAAS_WORKFLOWS = ['release.yml', 'security-scan.yml', 'bootstrap-prod.yml', 'deploy-prod.yml', 'restore-test.yml', 'ops-cli.yml'];
/** Environments whose jobs must never run twice at once or be cancelled half way. */
const SERIALISED_ENVIRONMENTS = new Set(['production', 'staging']);
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /@sha256:[0-9a-f]{64}$/;
/** An expression `${{ ... }}` that names the secrets context or the job token. */
const SECRET_EXPRESSION = /\$\{\{(?:(?!\}\}).)*?\b(?:secrets\b|github\s*\.\s*token\b|github\s*\[\s*['"]token['"]\s*\])(?:(?!\}\}).)*\}\}/gs;

const USAGE = `Usage: node tools/scripts/check-workflows.mjs [--saas [--require-all]] [<workflow file>...]
       node tools/scripts/check-workflows.mjs --self-test

Checks GitHub Actions workflows (rule S-4): top-level permissions, third-party actions pinned to a full
commit SHA with the tag in a comment, no secret inside run: text, and a concurrency group with
cancel-in-progress: false for jobs of the production and staging environments.

  --saas          also check the SaaS workflows that exist: ${SAAS_WORKFLOWS.join(', ')}
  --require-all   with --saas, fail when one of them is missing
  --self-test     run the built-in cases of every check
`;

/** Value of `key` in a YAML map node, as a node (or undefined). */
function child(map, key) {
  if (!isMap(map)) return undefined;
  for (const pair of map.items) {
    const name = isScalar(pair.key) ? pair.key.value : pair.key;
    if (name === key) return pair.value ?? null;
  }
  return undefined;
}

const scalarValue = (node) => (isScalar(node) ? node.value : undefined);

/**
 * Checks one workflow text. Returns the findings as `{ line, message }`, in file order.
 */
export function checkWorkflowText(text) {
  const findings = [];
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, prettyErrors: false });
  const lineOf = (node) => (node?.range ? lineCounter.linePos(node.range[0]).line : 1);
  const add = (node, message) => findings.push({ line: lineOf(node), message });

  for (const error of doc.errors) {
    findings.push({ line: error.linePos?.[0]?.line ?? 1, message: `YAML error: ${error.message.split('\n')[0]}` });
  }
  if (doc.errors.length > 0) return findings;
  const root = doc.contents;
  if (!isMap(root)) {
    findings.push({ line: 1, message: 'a workflow is a YAML mapping with on, permissions and jobs' });
    return findings;
  }

  // 1. Top-level permissions.
  const permissions = child(root, 'permissions');
  if (permissions === undefined) {
    add(root, 'top-level permissions is not set; add for example "permissions: contents: read" and grant more per job');
  } else if (permissions === null || (isScalar(permissions) && (permissions.value === null || permissions.value === ''))) {
    add(permissions ?? root, 'top-level permissions is empty; use {} for none or name each permission');
  } else if (isScalar(permissions) && String(permissions.value).trim() === 'write-all') {
    add(permissions, 'top-level permissions is write-all; name the permissions each job needs');
  }

  // 2. Pinned actions; the version comment is read from the source line.
  const checkUses = (node) => {
    const value = scalarValue(node);
    if (typeof value !== 'string') {
      add(node, 'uses: must be a text value');
      return;
    }
    const uses = value.trim();
    if (uses.startsWith('./')) return;
    if (uses.startsWith('docker://')) {
      if (!IMAGE_DIGEST.test(uses)) add(node, `${uses} is not pinned by digest; use docker://<image>:<tag>@sha256:<digest>`);
      return;
    }
    const at = uses.lastIndexOf('@');
    if (at <= 0) {
      add(node, `${uses} has no version; pin it to a full commit SHA with the tag in a comment (S-4)`);
      return;
    }
    const ref = uses.slice(at + 1);
    if (!COMMIT_SHA.test(ref)) {
      add(node, `${uses} is not pinned to a full 40-character commit SHA; use ${uses.slice(0, at)}@<sha> # ${ref} (S-4)`);
      return;
    }
    const end = node.range[1];
    const lineEnd = text.indexOf('\n', end);
    const rest = text.slice(end, lineEnd === -1 ? text.length : lineEnd);
    if (!/^\s*#\s*\S/.test(rest)) add(node, `${uses} has no tag comment; add the release it pins, for example "# v1.2.3" (S-4)`);
  };

  // 3. Secrets inside script text.
  const checkScript = (node, what) => {
    const value = scalarValue(node);
    if (typeof value !== 'string') return;
    for (const match of value.matchAll(SECRET_EXPRESSION)) {
      const expression = match[0].replace(/\s+/g, ' ');
      add(node, `${what} contains ${expression}; pass it through env: and use the variable in the script (S-4)`);
    }
  };

  const jobs = child(root, 'jobs');
  if (!isMap(jobs)) {
    add(jobs ?? root, 'jobs is missing or is not a mapping');
    return findings;
  }
  const workflowConcurrency = child(root, 'concurrency');

  for (const pair of jobs.items) {
    const jobId = scalarValue(pair.key);
    const job = pair.value;
    if (!isMap(job)) {
      add(pair.key, `job ${jobId} is not a mapping`);
      continue;
    }
    const jobUses = child(job, 'uses');
    if (jobUses !== undefined) checkUses(jobUses);
    const steps = child(job, 'steps');
    if (isSeq(steps)) {
      for (const step of steps.items) {
        if (!isMap(step)) continue;
        const uses = child(step, 'uses');
        if (uses !== undefined) checkUses(uses);
        const run = child(step, 'run');
        if (run !== undefined) checkScript(run, `job ${jobId}: run:`);
        const usesValue = scalarValue(uses);
        if (typeof usesValue === 'string' && usesValue.startsWith('actions/github-script@')) {
          const script = child(child(step, 'with'), 'script');
          if (script !== undefined) checkScript(script, `job ${jobId}: the github-script script:`);
        }
      }
    }

    // 4. Deploy environments are serialised and never cancelled.
    const environment = child(job, 'environment');
    if (environment === undefined || environment === null) continue;
    const environmentName = isMap(environment) ? scalarValue(child(environment, 'name')) : scalarValue(environment);
    if (typeof environmentName !== 'string') continue;
    const name = environmentName.trim().toLowerCase();
    const dynamic = name.includes('${{');
    if (!dynamic && !SERIALISED_ENVIRONMENTS.has(name)) continue;
    const jobConcurrency = child(job, 'concurrency');
    const concurrency = jobConcurrency !== undefined ? jobConcurrency : workflowConcurrency;
    const label = dynamic ? `job ${jobId} (environment ${environmentName.trim()}, which can be production or staging)` : `job ${jobId} (environment ${name})`;
    if (concurrency === undefined || concurrency === null) {
      add(pair.key, `${label} has no concurrency group; add concurrency: { group: <name>, cancel-in-progress: false }`);
    } else if (!isMap(concurrency)) {
      add(concurrency, `${label}: write concurrency as a mapping with group and cancel-in-progress: false`);
    } else {
      const group = child(concurrency, 'group');
      const cancel = child(concurrency, 'cancel-in-progress');
      if (group === undefined || group === null || scalarValue(group) === '' || scalarValue(group) === null) {
        add(concurrency, `${label}: the concurrency has no group`);
      }
      if (!isScalar(cancel) || cancel.value !== false) {
        add(cancel ?? concurrency, `${label}: the concurrency needs cancel-in-progress: false, so a running deploy is never cancelled`);
      }
    }
  }
  findings.sort((a, b) => a.line - b.line);
  return findings;
}

// ---------------------------------------------------------------------------------------------------------------
// Self-test: every check on a passing and a failing case.
// ---------------------------------------------------------------------------------------------------------------
const PIN = 'actions/checkout@0123456789abcdef0123456789abcdef01234567';
const GOOD = `name: Good
on: workflow_dispatch
permissions:
  contents: read
concurrency:
  group: deploy
  cancel-in-progress: false
jobs:
  build:
    runs-on: ubuntu-24.04
    environment: production
    steps:
      - uses: ${PIN} # v7.0.1
      - uses: ./.github/actions/local
      - uses: docker://alpine:3.22@sha256:${'a'.repeat(64)}
      - name: Secret through env
        env:
          TOKEN: \${{ secrets.TOKEN }}
          GH_TOKEN: \${{ github.token }}
        run: echo "$TOKEN" | wc -c
`;

const SELF_TESTS = [
  { name: 'a pinned workflow passes', text: GOOD, expect: [] },
  { name: 'no top-level permissions', text: GOOD.replace('permissions:\n  contents: read\n', ''), expect: ['top-level permissions is not set'] },
  { name: 'write-all permissions', text: GOOD.replace('permissions:\n  contents: read\n', 'permissions: write-all\n'), expect: ['write-all'] },
  { name: 'empty permissions block', text: GOOD.replace('permissions:\n  contents: read\n', 'permissions: {}\n'), expect: [] },
  { name: 'tag instead of a SHA', text: GOOD.replace(`${PIN} # v7.0.1`, 'actions/checkout@v7'), expect: ['not pinned to a full 40-character commit SHA'] },
  { name: 'short SHA', text: GOOD.replace(PIN, 'actions/checkout@0123456'), expect: ['not pinned to a full 40-character commit SHA'] },
  { name: 'SHA without a tag comment', text: GOOD.replace(`${PIN} # v7.0.1`, PIN), expect: ['has no tag comment'] },
  { name: 'no version at all', text: GOOD.replace(`${PIN} # v7.0.1`, 'actions/checkout'), expect: ['has no version'] },
  { name: 'docker image without digest', text: GOOD.replace(/docker:\/\/alpine:3\.22@sha256:a+/, 'docker://alpine:3.22'), expect: ['not pinned by digest'] },
  {
    name: 'reusable workflow by tag',
    text: GOOD.replace('jobs:\n', 'jobs:\n  scan:\n    uses: google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@v2.7.0\n'),
    expect: ['not pinned to a full 40-character commit SHA'],
  },
  { name: 'secret in run', text: GOOD.replace('run: echo "$TOKEN" | wc -c', 'run: echo "${{ secrets.TOKEN }}"'), expect: ['contains ${{ secrets.TOKEN }}'] },
  { name: 'secret in run, no spaces', text: GOOD.replace('run: echo "$TOKEN" | wc -c', 'run: echo ${{secrets.TOKEN}}'), expect: ['contains ${{secrets.TOKEN}}'] },
  { name: 'secret by index in run', text: GOOD.replace('run: echo "$TOKEN" | wc -c', "run: echo ${{ secrets['TOKEN'] }}"), expect: ["contains ${{ secrets['TOKEN'] }}"] },
  { name: 'all secrets in run', text: GOOD.replace('run: echo "$TOKEN" | wc -c', 'run: echo ${{ toJSON(secrets) }}'), expect: ['contains ${{ toJSON(secrets) }}'] },
  { name: 'job token in run', text: GOOD.replace('run: echo "$TOKEN" | wc -c', 'run: echo ${{ github.token }} | gh auth login --with-token'), expect: ['contains ${{ github.token }}'] },
  {
    name: 'secret in a block scalar run',
    text: GOOD.replace('run: echo "$TOKEN" | wc -c', 'run: |\n          set -e\n          curl -u "x:${{ secrets.TOKEN }}" https://example.test'),
    expect: ['contains ${{ secrets.TOKEN }}'],
  },
  {
    name: 'secret in a github-script script',
    text: GOOD.replace(
      '      - name: Secret through env',
      `      - uses: actions/github-script@${'b'.repeat(40)} # v8.0.0\n        with:\n          script: console.log('\${{ secrets.TOKEN }}')\n      - name: Secret through env`,
    ),
    expect: ['the github-script script: contains ${{ secrets.TOKEN }}'],
  },
  { name: 'other expressions in run are fine', text: GOOD.replace('run: echo "$TOKEN" | wc -c', 'run: echo "${{ github.sha }} ${{ inputs.version }}"'), expect: [] },
  {
    name: 'production job without concurrency',
    text: GOOD.replace('concurrency:\n  group: deploy\n  cancel-in-progress: false\n', ''),
    expect: ['has no concurrency group'],
  },
  {
    name: 'staging job with cancel-in-progress true',
    text: GOOD.replace('cancel-in-progress: false', 'cancel-in-progress: true').replace('environment: production', 'environment: staging'),
    expect: ['needs cancel-in-progress: false'],
  },
  {
    name: 'concurrency as a plain group name',
    text: GOOD.replace('concurrency:\n  group: deploy\n  cancel-in-progress: false\n', 'concurrency: deploy\n'),
    expect: ['write concurrency as a mapping'],
  },
  {
    name: 'expression environment needs concurrency',
    text: GOOD.replace('concurrency:\n  group: deploy\n  cancel-in-progress: false\n', '').replace('environment: production', 'environment: ${{ inputs.target }}'),
    expect: ['which can be production or staging'],
  },
  {
    name: 'job-level concurrency counts',
    text: GOOD.replace('concurrency:\n  group: deploy\n  cancel-in-progress: false\n', '').replace(
      '    environment: production\n',
      '    environment:\n      name: production\n      url: https://example.test\n    concurrency:\n      group: deploy-production\n      cancel-in-progress: false\n',
    ),
    expect: [],
  },
  {
    name: 'other environments need no concurrency',
    text: GOOD.replace('concurrency:\n  group: deploy\n  cancel-in-progress: false\n', '').replace('environment: production', 'environment: release'),
    expect: [],
  },
  { name: 'YAML error', text: 'on: [push\njobs: {}\n', expect: ['YAML error'] },
];

function runSelfTest() {
  let failed = 0;
  for (const test of SELF_TESTS) {
    const findings = checkWorkflowText(test.text).map((f) => f.message);
    const ok =
      test.expect.length === 0
        ? findings.length === 0
        : findings.length === test.expect.length && test.expect.every((part, i) => findings[i].includes(part));
    if (!ok) {
      failed += 1;
      process.stdout.write(`FAIL ${test.name}\n  expected: ${JSON.stringify(test.expect)}\n  found:    ${JSON.stringify(findings)}\n`);
    } else {
      process.stdout.write(`pass ${test.name}\n`);
    }
  }
  process.stdout.write(`check-workflows self-test: ${SELF_TESTS.length - failed} of ${SELF_TESTS.length} cases pass\n`);
  return failed === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------------------------
function main(argv) {
  const files = [];
  let saas = false;
  let requireAll = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      return 0;
    }
    if (arg === '--self-test') return runSelfTest();
    if (arg === '--saas') saas = true;
    else if (arg === '--require-all') requireAll = true;
    else if (arg.startsWith('-')) {
      process.stderr.write(`check-workflows: unknown option ${arg}\n\n${USAGE}`);
      return 2;
    } else files.push(path.resolve(arg));
  }
  if (requireAll && !saas) {
    process.stderr.write('check-workflows: --require-all works with --saas\n');
    return 2;
  }
  if (files.length === 0 && !saas) {
    process.stderr.write(USAGE);
    return 2;
  }

  let findings = 0;
  if (saas) {
    for (const name of SAAS_WORKFLOWS) {
      const file = path.join(WORKFLOW_DIR, name);
      if (existsSync(file)) {
        if (!files.includes(file)) files.push(file);
      } else if (requireAll) {
        process.stdout.write(`check-workflows: ${path.relative(process.cwd(), file)}: missing (--require-all)\n`);
        findings += 1;
      }
    }
  }
  for (const file of files) {
    const shown = path.relative(process.cwd(), file) || file;
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch (error) {
      process.stderr.write(`check-workflows: cannot read ${shown}: ${error.message}\n`);
      return 2;
    }
    const result = checkWorkflowText(text);
    if (result.length === 0) {
      process.stdout.write(`check-workflows: ${shown}: pass\n`);
      continue;
    }
    for (const finding of result) process.stdout.write(`check-workflows: ${shown}:${finding.line}: ${finding.message}\n`);
    findings += result.length;
  }
  if (files.length === 0) process.stdout.write('check-workflows: no SaaS workflow exists yet\n');
  if (findings > 0) {
    process.stdout.write(`check-workflows: ${findings} finding(s)\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
