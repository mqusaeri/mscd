// The server-side allow-list `deploy/scripts/saas-ops.sh` and the input step of `.github/workflows/ops-cli.yml`
// (Milestone 2 K.6, M2-S09), run with bash against a stand-in `docker` that records its arguments: only the listed
// commands run, each value is checked, the values reach `mscd-server` as one `--option=value` argument each through
// `docker compose run --rm -T --no-deps cli`, standard input carries them as NAME=<base64>, `--public` masks every value
// given (with the user handle made from an email and link tokens) and the full output stays in the server's log folder
// for a limited time; the workflow step reads the personal fields from the run's event (never env, which the runner
// prints), masks them first, checks the form and maps it to the names saas-ops.sh reads.
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = path.resolve(__dirname, '../../../../..');
const SCRIPT = path.join(ROOT, 'deploy/scripts/saas-ops.sh');
const WORKFLOW = path.join(ROOT, '.github/workflows/ops-cli.yml');

const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');
const stdinOf = (values: Record<string, string>) => Object.entries(values).map(([name, value]) => `${name}=${b64(value)}`).join('\n') + '\n';

/** A stand-in for docker: records its arguments (one per line) and answers like the cli container would. */
const FAKE_DOCKER = `#!/usr/bin/env bash
printf '%s\\n' "$@" >"$FAKE_DOCKER_ARGS"
for arg in "$@"; do
  case "$arg" in
    diagnostics) printf 'ARCHIVE-BYTES'; echo 'diagnostics: archive written to standard output' >&2; exit 0 ;;
  esac
done
if [[ -n \${FAKE_DOCKER_OUTPUT:-} ]]; then cat "$FAKE_DOCKER_OUTPUT"; exit 0; fi
cat <<'EOF'
tenant set-status: organisation bank_sentosa moved from active to suspended
Organisation: PT Bank Sentosa, first administrator andi@banksentosa.test (Andi Wijaya)
Reason: Invoice overdue by 60 days; other contact rina@example.test; schema org_bank_sentosa from 10.1.2.3
EOF
exit "\${FAKE_DOCKER_EXIT:-0}"
`;

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

describe('saas-ops.sh and ops-cli.yml (Milestone 2 K.6, M2-S09)', () => {
  let dir: string;
  let install: string;
  let bin: string;
  let argsFile: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'm2-s09-saas-ops-'));
    install = path.join(dir, 'opt-mscd');
    bin = path.join(dir, 'bin');
    argsFile = path.join(dir, 'docker-args');
    await mkdir(path.join(install, 'deploy/compose'), { recursive: true });
    await writeFile(path.join(install, 'deploy/compose/docker-compose.yml'), 'services: {}\n');
    await writeFile(path.join(install, 'deploy/compose/docker-compose.saas.yml'), 'services: {}\n');
    await writeFile(path.join(install, '.env'), 'COMPOSE_PROJECT_NAME=mscd_saas\n');
    await mkdir(bin);
    await writeFile(path.join(bin, 'docker'), FAKE_DOCKER);
    await chmod(path.join(bin, 'docker'), 0o755);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = (args: string[], options: { input?: string; env?: Record<string, string> } = {}): Run => {
    const result = spawnSync('bash', [SCRIPT, ...args, '--install-dir', install], {
      input: options.input ?? '',
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_ARGS: argsFile, NO_COLOR: '1', COMPOSE_PROJECT_NAME: '', ...options.env },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const dockerArgs = async () => (await readFile(argsFile, 'utf8')).trimEnd().split('\n');

  describe('the allow-list', () => {
    it('refuses any other command with exit code 2 and runs nothing', async () => {
      await rm(argsFile, { force: true });
      for (const command of ['psql', 'bash', 'tenant', 'migrate', 'seed', '--org']) {
        const result = run([command]);
        expect(result.status, command).toBe(2);
        expect(result.stderr).toContain('unknown command');
      }
      await expect(stat(argsFile)).rejects.toThrow();
      expect(spawnSync('bash', ['-n', SCRIPT]).status).toBe(0);
    });

    it('checks every value and refuses unknown options, missing values and stray arguments', async () => {
      await rm(argsFile, { force: true });
      const refused: [string[], RegExp][] = [
        [['tenant-show'], /tenant-show needs --org/],
        [['tenant-show', '--org', 'Bank'], /--org must be an organisation slug/],
        [['tenant-show', '--org', 'bank', '--email', 'a@b.co'], /takes no option --email/],
        [['tenant-show', '--org', 'bank', 'extra'], /unexpected argument/],
        [['tenant-show', '--org', 'bank', '--tenant-admin'], /takes no option --tenant-admin/],
        [['create-operator', '--email', 'not-mail'], /--email must be an email address/],
        [['create-operator', '--email', 'a@b.co', '--name', '--tenant-admin'], /--name must be text/],
        [['tenant-set-status', '--org', 'bank', '--status', 'paused', '--reason', 'Late'], /--status must be active, suspended/],
        [['tenant-set-status', '--org', 'bank', '--status', 'suspended', '--reason', 'x'], /--reason must be text of 3 to 500/],
        [['tenant-set-status', '--org', 'bank', '--status', 'offboarding', '--reason', 'Ended', '--confirm', 'Bank X'], /--confirm must be the organisation slug/],
        [['tenant-onboard', '--slug', 'bank', '--name', 'PT Bank', '--time-zone', 'Asia/Jakarta', '--site-count', 'two', '--admin-email', 'a@b.co', '--admin-name', 'A'], /--site-count must be a whole number/],
        [['tenant-onboard', '--slug', 'bank', '--name', 'PT Bank', '--time-zone', 'Asia/Jakarta; rm -rf /', '--site-count', '1', '--admin-email', 'a@b.co', '--admin-name', 'A'], /--time-zone must be an IANA time zone/],
        [['license-entitlements-set', '--org', 'bank'], /needs --preset, or --max-users/],
        [['license-entitlements-set', '--org', 'bank', '--preset', 'trial', '--max-users', '5'], /--preset or limits, not both/],
        [['license-entitlements-set', '--org', 'bank', '--valid-until', '31-12-2027'], /--valid-until must be a date/],
      ];
      for (const [args, message] of refused) {
        const result = run(args);
        expect(result.status, args.join(' ')).toBe(2);
        expect(result.stderr, args.join(' ')).toMatch(message);
        // A refused value is never echoed.
        if (args.includes('Bank X')) expect(result.stderr).not.toContain('Bank X');
      }
      await expect(stat(argsFile)).rejects.toThrow();
    });

    it('maps each command to one mscd-server command in a one-off cli container', async () => {
      const cases: [string[], string[]][] = [
        [['create-operator', '--email', 'owner@example.test', '--name', 'The Owner'], ['admin', 'create-operator', '--email=owner@example.test', '--name=The Owner']],
        [['revoke-operator', '--email', 'owner@example.test'], ['admin', 'revoke-operator', '--email=owner@example.test']],
        [['tenant-list', '--status', 'active'], ['tenant', 'list', '--status=active']],
        [['tenant-show', '--org=bank_sentosa'], ['tenant', 'show', '--org=bank_sentosa']],
        [
          ['tenant-onboard', '--slug', 'bank_sentosa', '--name', 'PT Bank Sentosa', '--time-zone', 'Asia/Jakarta', '--site-count', '3', '--admin-email', 'andi@banksentosa.test', '--admin-name', 'Andi Wijaya', '--preset', 'trial'],
          ['tenant', 'onboard', '--slug=bank_sentosa', '--name=PT Bank Sentosa', '--time-zone=Asia/Jakarta', '--site-count=3', '--admin-email=andi@banksentosa.test', '--admin-name=Andi Wijaya', '--preset=trial'],
        ],
        [
          ['tenant-set-status', '--org', 'bank_sentosa', '--status', 'offboarding', '--reason', 'Contract ended; "quoted" $(not run)', '--confirm', 'bank_sentosa'],
          ['tenant', 'set-status', '--org=bank_sentosa', '--status=offboarding', '--reason=Contract ended; "quoted" $(not run)', '--confirm=bank_sentosa'],
        ],
        [['admin-create-user', '--org', 'bank_sentosa', '--email', 'it@banksentosa.test', '--tenant-admin'], ['admin', 'create-user', '--org=bank_sentosa', '--email=it@banksentosa.test', '--tenant-admin']],
        [['license-entitlements-show', '--org', 'bank_sentosa'], ['license', 'entitlements', 'show', '--org=bank_sentosa']],
        [
          ['license-entitlements-set', '--org', 'bank_sentosa', '--max-users', '20', '--max-systems', '2', '--valid-until', 'none'],
          ['license', 'entitlements', 'set', '--org=bank_sentosa', '--max-users=20', '--max-systems=2', '--valid-until=none'],
        ],
      ];
      for (const [args, cli] of cases) {
        const result = run(args);
        expect(result.status, `${args[0]}: ${result.stderr}`).toBe(0);
        const recorded = await dockerArgs();
        const compose = path.join(install, 'deploy/compose');
        expect(recorded.slice(0, 5)).toEqual(['compose', '-p', 'mscd_saas', '--project-directory', compose]);
        expect(recorded).toContain(path.join(compose, 'docker-compose.yml'));
        expect(recorded.slice(recorded.indexOf('--env-file'), recorded.indexOf('--env-file') + 2)).toEqual(['--env-file', path.join(install, '.env')]);
        const at = recorded.indexOf('run');
        expect(recorded.slice(at, at + 5)).toEqual(['run', '--rm', '-T', '--no-deps', 'cli']);
        expect(recorded.slice(at + 5), args[0]).toEqual(cli);
        expect(result.stdout).toContain(`${args[0]} finished. The full output is in ${install}/logs/ops-`);
      }
    });
  });

  describe('values on standard input and the public output', () => {
    it('reads NAME=<base64> lines, masks every value given and keeps the full output on the server', async () => {
      const input = stdinOf({ ORG: 'bank_sentosa', STATUS: 'suspended', REASON: 'Invoice overdue by 60 days', CONFIRM: '' });
      const result = run(['tenant-set-status', '--input-stdin', '--public'], { input });
      expect(result.status, result.stderr).toBe(0);
      expect((await dockerArgs()).slice(-4)).toEqual(['set-status', '--org=bank_sentosa', '--status=suspended', '--reason=Invoice overdue by 60 days']);
      // Public output: the values given, other emails, schema names and addresses are hidden.
      expect(result.stdout).toContain('saas-ops.sh: mscd-server tenant set-status --org=[organisation] --status=suspended --reason=[reason]');
      expect(result.stdout).toContain('tenant set-status: organisation [organisation] moved from active to suspended');
      expect(result.stdout).toContain('Reason: [reason]; other contact [email]; schema org_[organisation] from [address]');
      for (const hidden of ['bank_sentosa', 'Invoice overdue', 'rina@example.test', 'andi@banksentosa.test', '10.1.2.3']) expect(result.stdout).not.toContain(hidden);
      // The full output, mode 0600, in the log folder of the install.
      const logs = (await readdir(path.join(install, 'logs'))).filter((name) => name.endsWith('-tenant-set-status.log'));
      const log = path.join(install, 'logs', logs.at(-1)!);
      expect((await stat(log)).mode & 0o777).toBe(0o600);
      const text = await readFile(log, 'utf8');
      expect(text).toContain('--reason=Invoice overdue by 60 days');
      expect(text).toContain('andi@banksentosa.test');
      expect(text).toMatch(/exit code 0\n$/);
    });

    it('hides the user handle made from an email, the handle of an existing account and link tokens', async () => {
      const output = path.join(dir, 'create-user-output');
      const cases: { email: string; lines: string[]; shown: string[]; hidden: string[] }[] = [
        {
          email: 'Andi.Wijaya+MSCD@banksentosa.co.id',
          lines: [
            'admin create-user: created user andi.wijaya.mscd (andi.wijaya+mscd@banksentosa.co.id) to organisation bank_sentosa as tenant_admin',
            'admin create-user: invited existing user rturhan (andi.wijaya+mscd@banksentosa.co.id) to organisation bank_sentosa',
            'Handles andi.wijaya.mscd-2 and Andi.Wijaya+MSCD; also andi.wijaya.mscd andi.wijaya.mscd',
            'Mail is not configured, so give this one-time invitation link to the user (single use, valid until 2026-10-31T00:00:00.000Z):',
            'https://app.example.test/invite#token=abcDEF123_-xyz',
          ],
          shown: [
            'admin create-user: created user [user] ([email]) to organisation [organisation] as tenant_admin',
            'admin create-user: invited existing user [user] ([email]) to organisation [organisation]',
            'Handles [user]-2 and [user]; also [user] [user]',
            'https://app.example.test/invite#token=[hidden]',
          ],
          hidden: ['andi', 'wijaya', 'banksentosa', 'rturhan', 'abcdef123'],
        },
        {
          // A handle that is not the part before @: no leading digits, and "user" in front of a short one.
          email: '7.Ok@pt-sentosa.test',
          lines: ['Handle ok of 7.ok, and userx stays'],
          shown: ['Handle [user] of [user], and userx stays'],
          hidden: ['7.ok', ' ok '],
        },
        {
          email: 'x@pt-sentosa.test',
          lines: ['Handle userx-2, not user'],
          shown: ['Handle [user]-2, not user'],
          hidden: ['userx'],
        },
      ];
      for (const { email, lines, shown, hidden } of cases) {
        await writeFile(output, `${lines.join('\n')}\n`);
        const input = stdinOf({ ORG: 'bank_sentosa', EMAIL: email, TENANT_ADMIN: 'true' });
        const result = run(['admin-create-user', '--input-stdin', '--public'], { input, env: { FAKE_DOCKER_OUTPUT: output } });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain('saas-ops.sh: mscd-server admin create-user --org=[organisation] --email=[email] --tenant-admin');
        for (const line of shown) expect(result.stdout, email).toContain(line);
        const text = result.stdout.replaceAll(install, '<install>').toLowerCase();
        for (const value of hidden) expect(text, `${email}: ${value}`).not.toContain(value);
        // The server's log keeps the full output.
        const logs = (await readdir(path.join(install, 'logs'))).filter((name) => name.endsWith('-admin-create-user.log')).sort();
        expect(await readFile(path.join(install, 'logs', logs.at(-1)!), 'utf8')).toContain(lines[0]);
      }
    });

    it('refuses names the command does not take, lines that are not base64 and a terminal', async () => {
      const wrongName = run(['tenant-show', '--input-stdin'], { input: stdinOf({ ORG: 'bank', EMAIL: 'a@b.co' }) });
      expect(wrongName.status).toBe(2);
      expect(wrongName.stderr).toContain('standard input names EMAIL, which tenant-show does not take');
      const notBase64 = run(['tenant-show', '--input-stdin'], { input: 'ORG=not base64!\n' });
      expect(notBase64.status).toBe(2);
      expect(notBase64.stderr).toContain('is not NAME=<base64 value> (the line is not shown)');
      expect(notBase64.stderr).not.toContain('not base64!');
      const bad = run(['tenant-show', '--input-stdin'], { input: stdinOf({ ORG: 'Bank; ls' }) });
      expect(bad.status).toBe(2);
      expect(bad.stderr).not.toContain('Bank; ls');
    });

    it('passes the exit code of the command on and says where the full output is', async () => {
      const result = run(['tenant-show', '--org', 'bank_sentosa', '--public'], { env: { FAKE_DOCKER_EXIT: '1' } });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('tenant-show stopped with exit code 1');
      expect((await dockerArgs()).slice(-3)).toEqual(['show', '--org=bank_sentosa', '--summary']);
    });

    it('stores the diagnostics archive on the server with mode 0600 and prints its size and hash', async () => {
      const result = run(['diagnostics', '--public']);
      expect(result.status, result.stderr).toBe(0);
      expect((await dockerArgs()).slice(-3)).toEqual(['diagnostics', '--out', '-']);
      const files = await readdir(path.join(install, 'diagnostics'));
      expect(files).toHaveLength(1);
      const archive = path.join(install, 'diagnostics', files[0]!);
      expect(await readFile(archive, 'utf8')).toBe('ARCHIVE-BYTES');
      expect((await stat(archive)).mode & 0o777).toBe(0o600);
      expect(result.stdout).toMatch(/diagnostics: archive written on the server to .*mscd-diagnostics-\d{8}T\d{6}Z\.tar\.gz \(13 bytes, SHA-256 [0-9a-f]{64}\)/);
    });

    it('refuses to run when no stack is installed', () => {
      const result = spawnSync('bash', [SCRIPT, 'tenant-list', '--install-dir', path.join(dir, 'nothing-here')], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('no MSCD SaaS stack is installed');
    });

    it('removes its own run logs after 90 days and diagnostics archives after 14 days, and nothing else', async () => {
      const logs = path.join(install, 'logs');
      const archives = path.join(install, 'diagnostics');
      await mkdir(logs, { recursive: true });
      await mkdir(archives, { recursive: true });
      const now = Date.now() / 1000;
      const files: [string, number, boolean][] = [
        [path.join(logs, 'ops-20200101T000000Z-tenant-list.log'), 100, false],
        [path.join(logs, 'ops-20200102T000000Z-tenant-set-status.log'), 60, true],
        [path.join(logs, 'deploy-20200101T000000Z.log'), 100, true],
        [path.join(archives, 'mscd-diagnostics-20200101T000000Z.tar.gz'), 20, false],
        [path.join(archives, 'mscd-diagnostics-20200102T000000Z.tar.gz'), 8, true],
        [path.join(archives, 'notes.txt'), 100, true],
      ];
      for (const [file, days] of files) {
        await writeFile(file, 'old');
        await utimes(file, now - days * 86_400, now - days * 86_400);
      }
      const result = run(['tenant-list']);
      expect(result.status, result.stderr).toBe(0);
      for (const [file, , kept] of files) expect(await stat(file).then(() => true, () => false), path.basename(file)).toBe(kept);
      const runs = (await readdir(logs)).filter((name) => name.endsWith('-tenant-list.log')).sort();
      expect(await readFile(path.join(logs, runs.at(-1)!), 'utf8')).toContain('removed 1 run log(s) older than 90 days and 1 diagnostics archive(s) older than 14 days');
      await rm(path.join(archives, 'mscd-diagnostics-20200102T000000Z.tar.gz'));
      await rm(path.join(archives, 'notes.txt'));
    });
  });

  describe('the input step of ops-cli.yml', () => {
    interface Step {
      name: string;
      env?: Record<string, string>;
      run?: string;
    }
    interface Workflow {
      on: { workflow_dispatch: { inputs: Record<string, { type: string; default?: string | boolean }> } };
      env?: Record<string, string>;
      jobs: { ops: { steps: Step[]; environment: string; concurrency: Record<string, unknown>; env?: Record<string, string> } };
    }
    /** The form fields that can hold personal data or customer names (GL-50). */
    const PERSONAL = ['email', 'person_name', 'org', 'org_name', 'reason', 'confirm'];
    let text: string;
    let workflow: Workflow;
    let step: Step;

    beforeAll(async () => {
      text = await readFile(WORKFLOW, 'utf8');
      workflow = parse(text) as Workflow;
      step = workflow.jobs.ops.steps.find((s) => s.name === 'Check the inputs')!;
      expect(workflow.jobs.ops.environment).toBe('${{ inputs.target }}');
      expect(workflow.jobs.ops.concurrency).toEqual({ group: 'deploy-${{ inputs.target }}', 'cancel-in-progress': false });
      expect(workflow.jobs.ops.steps[0]).toBe(step);
    });

    /**
     * Runs the step's script as the runner would: the step's env rendered from the form (with the workflow's defaults),
     * and the run's event file holding the fields that were filled in, as `gh workflow run -f` sends them.
     */
    const check = async (command: string, form: Record<string, string> = {}) => {
      const temp = await mkdtemp(path.join(dir, 'runner-'));
      const defaults = Object.fromEntries(Object.entries(workflow.on.workflow_dispatch.inputs).map(([name, input]) => [name, String(input.default ?? '')]));
      const inputs: Record<string, string> = { ...defaults, target: 'staging', command, ...form };
      const event = path.join(temp, 'event.json');
      await writeFile(event, JSON.stringify({ inputs: { target: 'staging', command, ...form }, ref: 'refs/heads/main' }));
      const env: Record<string, string> = { ...(process.env as Record<string, string>), RUNNER_TEMP: temp, GITHUB_ENV: path.join(temp, 'github-env'), GITHUB_EVENT_PATH: event };
      for (const [name, expression] of Object.entries(step.env!)) {
        const field = /^\$\{\{ inputs\.([a-z_]+) \}\}$/.exec(expression)?.[1];
        expect(field, name).toBeDefined();
        env[name] = inputs[field!] ?? '';
      }
      const result = spawnSync('bash', ['-c', step.run!], { encoding: 'utf8', env });
      const values = await readFile(path.join(temp, 'mscd-ops/values'), 'utf8').catch(() => '');
      return { status: result.status, stdout: result.stdout, stderr: result.stderr, values };
    };

    it('reads the personal fields from the run event, never through env or an expression', () => {
      expect(step.run).not.toMatch(/\$\{\{/);
      // The runner prints the env of every step at the top of its log, before the step can mask anything.
      for (const name of PERSONAL) expect(text, name).not.toMatch(new RegExp(`\\$\\{\\{[^}]*\\b(inputs|github\\.event\\.inputs)\\.${name}\\b`));
      expect(text).not.toMatch(/\$\{\{[^}]*\b(inputs|github\.event\.inputs)\[/);
      expect(text).not.toMatch(/\$\{\{[^}]*toJSON\(\s*(inputs|github)/);
      const envs = [workflow.env ?? {}, workflow.jobs.ops.env ?? {}, ...workflow.jobs.ops.steps.map((s) => s.env ?? {})];
      for (const env of envs) for (const value of Object.values(env)) expect(String(value)).not.toMatch(/github\.event|toJSON/);
      expect(Object.keys(step.env!).filter((k) => k.startsWith('IN_')).sort()).toEqual(
        ['IN_GRACE_DAYS', 'IN_MAX_SYSTEMS', 'IN_MAX_USERS', 'IN_PRESET', 'IN_SITE_COUNT', 'IN_STATUS', 'IN_TENANT_ADMIN', 'IN_TIME_ZONE', 'IN_VALID_FROM', 'IN_VALID_UNTIL'],
      );
      expect(step.run).toContain('"$GITHUB_EVENT_PATH"');
    });

    it('masks every personal field before it prints anything else', async () => {
      const form = {
        org: 'bank_sentosa',
        org_name: 'PT Bank Sentosa',
        email: ' Andi.Wijaya@BankSentosa.test ',
        person_name: 'Andi Wijaya',
        reason: 'Signed at 50%0A off',
        confirm: 'bank_sentosa',
        site_count: '3',
      };
      const result = await check('tenant-onboard', form);
      expect(result.status, result.stdout).toBe(0);
      const lines = result.stdout.trimEnd().split('\n');
      const first = lines.findIndex((line) => !line.startsWith('::add-mask::'));
      const masks = lines.slice(0, first).map((line) => line.slice('::add-mask::'.length));
      for (const value of ['bank_sentosa', 'PT Bank Sentosa', 'pt bank sentosa', 'Andi.Wijaya@BankSentosa.test', 'andi.wijaya@banksentosa.test', 'Andi Wijaya', 'Signed at 50%250A off', 'Andi.Wijaya', 'andi.wijaya']) {
        expect(masks, value).toContain(value);
      }
      const rest = lines.slice(first).join('\n').toLowerCase();
      for (const value of ['bank_sentosa', 'bank sentosa', 'andi', 'wijaya', 'signed']) expect(rest, value).not.toContain(value);
      expect(rest).toBe('inputs are valid: tenant-onboard on staging with 6 value(s).');
    });

    it('masks each line of a value with more than one line, then refuses it', async () => {
      const result = await check('tenant-set-status', { org: 'bank', status: 'suspended', reason: 'First line\nSecond line' });
      expect(result.status).not.toBe(0);
      const lines = result.stdout.trimEnd().split('\n');
      expect(lines.slice(0, 4)).toEqual(['::add-mask::bank', '::add-mask::First line', '::add-mask::first line', '::add-mask::Second line']);
      expect(result.stdout).toContain('::add-mask::second line');
      expect(lines.at(-1)).toBe('::error::reason must have 3 to 500 characters and not start with -.');
    });

    it('maps the form to the names saas-ops.sh reads, and saas-ops.sh accepts them', async () => {
      const onboard = await check('tenant-onboard', {
        org: 'bank_sentosa',
        org_name: 'PT Bank Sentosa',
        email: ' andi@banksentosa.test ',
        person_name: 'Andi Wijaya',
        site_count: '3',
        preset: 'trial',
      });
      expect(onboard.status, onboard.stdout).toBe(0);
      expect(onboard.stdout).toContain('::add-mask::andi@banksentosa.test');
      expect(onboard.stdout).toContain('Inputs are valid: tenant-onboard on staging with 7 value(s).');
      const dry = run(['tenant-onboard', '--input-stdin', '--public', '--dry-run'], { input: onboard.values });
      expect(dry.status, dry.stderr).toBe(0);
      expect(dry.stdout).toContain(
        'would run mscd-server tenant onboard --slug=[organisation] --name=[organisation name] --time-zone=Asia/Jakarta --site-count=3 --admin-email=[email] --admin-name=[name] --preset=trial',
      );

      const status = await check('tenant-set-status', { org: 'bank_sentosa', status: 'offboarding', reason: 'Contract ended', confirm: 'bank_sentosa' });
      expect(status.status, status.stdout).toBe(0);
      const real = run(['tenant-set-status', '--input-stdin'], { input: status.values });
      expect(real.status, real.stderr).toBe(0);
      expect((await dockerArgs()).slice(-5)).toEqual(['set-status', '--org=bank_sentosa', '--status=offboarding', '--reason=Contract ended', '--confirm=bank_sentosa']);

      const user = await check('admin-create-user', { org: 'bank_sentosa', email: 'it@banksentosa.test', tenant_admin: 'true' });
      expect(user.status, user.stdout).toBe(0);
      expect(run(['admin-create-user', '--input-stdin'], { input: user.values }).status).toBe(0);
      expect((await dockerArgs()).slice(-4)).toEqual(['create-user', '--org=bank_sentosa', '--email=it@banksentosa.test', '--tenant-admin']);

      const diagnostics = await check('diagnostics', { email: 'ignored@example.test' });
      expect(diagnostics.status).toBe(0);
      expect(diagnostics.values).toBe('');
    });

    it('refuses a form with a value that does not pass its check or a missing value', async () => {
      const refusals: [string, Record<string, string>, string][] = [
        ['create-operator', {}, 'create-operator needs the input email.'],
        ['create-operator', { email: 'owner' }, 'email is not an email address.'],
        ['tenant-show', { org: 'Bank Sentosa' }, 'org must be a slug'],
        ['tenant-set-status', { org: 'bank', reason: 'Late' }, 'tenant-set-status needs the input status.'],
        ['tenant-set-status', { org: 'bank', status: 'suspended', reason: '--org=other' }, 'reason must have 3 to 500 characters and not start with -.'],
        ['tenant-onboard', { org: 'bank', org_name: 'PT Bank', email: 'a@b.co', person_name: 'A', time_zone: '$(id)' }, 'time_zone must be an IANA name'],
        ['license-entitlements-set', { org: 'bank', preset: 'trial', max_users: '9' }, 'Give a preset or limits, not both.'],
        ['rm -rf', {}, 'is not on the allow-list.'],
      ];
      for (const [command, form, message] of refusals) {
        const result = await check(command, form);
        expect(result.status, JSON.stringify(form)).not.toBe(0);
        expect(result.stdout, JSON.stringify(form)).toMatch(new RegExp(`::error::.*${message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      }
    });
  });
});
