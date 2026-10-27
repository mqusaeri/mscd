#!/usr/bin/env bash
# Rehearsal of .github/workflows/bootstrap-prod.yml on the build host
# (docs/saas/bootstrap.md). Two throwaway containers of the pinned image in
# deploy/host/test/ubuntu-image stand in for the GitHub runner and the new
# server (sshd with a bootstrap key for root). The steps of the workflow run
# in the runner container in their order, with test values for the inputs and
# secrets. The bootstrap itself runs with --only accounts,folders,ssh, because
# the other steps need systemd. Then the test checks the results:
#   - a wrong fingerprint stops the run before any login;
#   - the pinned connection survives the end of root logins;
#   - root and passwords are refused, deploy and the admin get in with the
#     hashed known_hosts lines of the summary.
#
#   bash deploy/host/test/workflow-test.sh
#
# Names start with MSCD_TEST_CONTAINER_PREFIX (default "mscd-bootstrap-test-").
# The containers install openssh from the Ubuntu archive; the proxy variables
# of this shell are passed on. Everything is removed at the end.
set -Eeuo pipefail

REPO_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
IMAGE=$(<"$REPO_DIR/deploy/host/test/ubuntu-image")
PREFIX=${MSCD_TEST_CONTAINER_PREFIX:-mscd-bootstrap-test-}
NET=${PREFIX}wf-net
SERVER=${PREFIX}wf-server
RUNNER=${PREFIX}wf-runner
WORK=$(mktemp -d)
FAILED=0
PASSED=0

cleanup() {
    docker rm -f "$SERVER" "$RUNNER" >/dev/null 2>&1 || true
    docker network rm "$NET" >/dev/null 2>&1 || true
    rm -rf -- "$WORK"
}
trap cleanup EXIT

pass() {
    PASSED=$((PASSED + 1))
    printf '  pass  %s\n' "$1"
}
fail() {
    FAILED=$((FAILED + 1))
    printf '  FAIL  %s\n' "$1"
    [[ -z ${2:-} || ! -f $2 ]] || sed 's/^/        | /' "$2" | tail -n 40
}
expect() {
    local name=$1
    shift
    if "$@" >"$WORK/out" 2>&1; then pass "$name"; else fail "$name" "$WORK/out"; fi
}
expect_fail() {
    local name=$1 pattern=$2
    shift 2
    if "$@" >"$WORK/out" 2>&1; then
        fail "$name (it succeeded)" "$WORK/out"
    elif grep -q -- "$pattern" "$WORK/out"; then
        pass "$name"
    else
        fail "$name" "$WORK/out"
    fi
}
on_server() { docker exec "$SERVER" bash -c "$1"; }
on_runner() { docker exec "$RUNNER" bash -c "$1"; }

proxy=(-e http_proxy -e https_proxy -e HTTP_PROXY -e HTTPS_PROXY -e no_proxy -e NO_PROXY)
printf '==> Containers\n'
docker network create "$NET" >/dev/null
docker run -d --name "$SERVER" --network "$NET" "${proxy[@]}" -v "$REPO_DIR/deploy:/deploy:ro" "$IMAGE" sleep 1800 >/dev/null
docker run -d --name "$RUNNER" --network "$NET" "${proxy[@]}" -v "$REPO_DIR:/repo:ro" "$IMAGE" sleep 1800 >/dev/null
# The runner also needs the proxy to reach the Ubuntu archive, but never for the server.
expect "server: openssh-server and sudo" on_server '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -q >/dev/null && apt-get install -y -q openssh-server sudo >/dev/null && groupadd docker &&
    install -d -m 0755 /run/sshd'
expect "runner: openssh-client and the test keys" on_runner '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -q >/dev/null && apt-get install -y -q openssh-client >/dev/null && mkdir -p /work/tmp /keys &&
    for k in bootstrap admin deploy; do ssh-keygen -q -t ed25519 -N "" -C "$k-test" -f /keys/$k; done'
docker exec "$RUNNER" cat /keys/bootstrap.pub | docker exec -i "$SERVER" bash -c \
    'install -d -m 0700 /root/.ssh && cat >/root/.ssh/authorized_keys && chmod 0600 /root/.ssh/authorized_keys'
expect "server: sshd running" on_server '/usr/sbin/sshd -E /var/log/sshd.log && sleep 1 && test -s /run/sshd.pid'
FINGERPRINT=$(on_server 'ssh-keygen -l -E sha256 -f /etc/ssh/ssh_host_ed25519_key.pub' | awk '{print $2}')

# Step scripts: env of each step (inputs and secrets filled in) and its run text.
write_steps() {
    local fingerprint=$1 out=$2
    rm -rf -- "$out"
    mkdir -p "$out"
    (cd "$REPO_DIR" && node - "$REPO_DIR/.github/workflows/bootstrap-prod.yml" "$out" "$fingerprint" "$SERVER" \
        "$(docker exec "$RUNNER" cat /keys/admin.pub)" "$(docker exec "$RUNNER" cat /keys/deploy.pub)" \
        "$(docker exec "$RUNNER" cat /keys/bootstrap)") <<'EOF'
const fs = require('fs');
const yaml = require(require.resolve('yaml', { paths: [process.cwd()] }));
const [file, out, fingerprint, host, adminPub, deployPub, bootstrapKey] = process.argv.slice(2);
const wf = yaml.parse(fs.readFileSync(file, 'utf8'));
const inputs = { target: 'staging', admin_user: 'owner', admin_public_key: adminPub, deploy_public_key: deployPub,
  host_key_fingerprint: fingerprint, data_device: '', format_data_device: 'false' };
const secrets = { DEPLOY_HOST: host, BOOTSTRAP_SSH_KEY: bootstrapKey };
const expr = (value) => String(value).replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, e) => {
  let m = /^inputs\.(\w+)$/.exec(e);
  if (m) return inputs[m[1]];
  m = /^secrets\.(\w+)$/.exec(e);
  if (m) return secrets[m[1]];
  if (e === "inputs.format_data_device && 'true' || 'false'") return inputs.format_data_device;
  throw new Error(`unknown expression ${e}`);
});
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const job = Object.values(wf.jobs)[0];
job.steps.forEach((step, i) => {
  if (!step.run) return;
  const env = Object.entries(step.env || {}).map(([k, v]) => `export ${k}=${q(expr(v))}`).join('\n');
  const name = String(i).padStart(2, '0') + '-' + step.name.replace(/[^A-Za-z]+/g, '-').toLowerCase();
  fs.writeFileSync(`${out}/${name}.sh`, `${env}\n${step.run}`);
});
EOF
}

# new_run DIR: a fresh runner work folder with the step scripts of DIR.
new_run() {
    docker exec "$RUNNER" rm -rf /work/steps /work/tmp /work/env /work/summary.md
    docker exec "$RUNNER" mkdir -p /work/tmp
    docker cp "$1" "$RUNNER:/work/steps" >/dev/null
}

# run_steps FROM UNTIL: runs the step scripts numbered FROM to UNTIL in order,
# as GitHub would (environment from GITHUB_ENV, bash -eo pipefail).
run_steps() {
    local from=$1 until=$2 step
    for step in $(docker exec "$RUNNER" ls /work/steps); do
        ((10#${step:0:2} >= 10#$from && 10#${step:0:2} <= 10#$until)) || continue
        printf '    step %s\n' "$step"
        docker exec -w /repo -e RUNNER_TEMP=/work/tmp -e GITHUB_ENV=/work/env -e GITHUB_STEP_SUMMARY=/work/summary.md \
            "$RUNNER" bash -c 'set -a; [[ ! -f /work/env ]] || . /work/env; set +a; exec bash --noprofile --norc -eo pipefail "$1"' \
            _ "/work/steps/$step" || return 1
    done
}

printf '\n==> Wrong fingerprint\n'
write_steps "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" "$WORK/steps-wrong"
new_run "$WORK/steps-wrong"
expect_fail "the run stops at the host key check" 'No host key of the server has the fingerprint' run_steps 00 03
expect "no login happened" on_server '! grep -q "Accepted publickey for root" /var/log/sshd.log'

printf '\n==> Bootstrap run\n'
write_steps "$FINGERPRINT" "$WORK/steps"
sed -i 's|bootstrap-host.sh \$(printf|bootstrap-host.sh --only accounts,folders,ssh $(printf|' "$WORK"/steps/*-run-bootstrap-host-sh.sh
new_run "$WORK/steps"
expect "steps up to the bootstrap run pass" run_steps 00 05
expect "the script ran on the server" on_server 'grep -qx "AllowUsers deploy owner" /etc/ssh/sshd_config.d/10-mscd.conf'
# A server with systemd reloads sshd here; this one gets the signal by hand.
on_server 'kill -HUP "$(cat /run/sshd.pid)"; sleep 1'
expect_fail "a new root login is refused" 'Permission denied' on_runner \
    'ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes -i /keys/bootstrap root@'"$SERVER"' true'
expect "the open connection still runs the last steps" run_steps 06 99
docker exec "$RUNNER" cat /work/summary.md >"$WORK/summary.md" 2>/dev/null || true
expect "summary names the next steps" bash -c 'grep -q "gh secret delete BOOTSTRAP_SSH_KEY --env staging" "$1" &&
    grep -q "gh secret set DEPLOY_SSH_KNOWN_HOSTS --env staging" "$1" && grep -q "gh secret set DEPLOY_SSH_KEY" "$1"' \
    _ "$WORK/summary.md"
expect "summary lines are hashed" bash -c 'grep -Eq "^\|1\|[^ ]+ ssh-ed25519 AAAA" "$1" && ! grep -q "'"$SERVER"'" "$1"' \
    _ "$WORK/summary.md"
expect "the key and the connection are gone" on_runner '! ls /work/tmp/mscd-ssh >/dev/null 2>&1'
sed -n '/^```text$/,/^```$/p' "$WORK/summary.md" | sed '1d;$d' >"$WORK/known_hosts"
docker cp "$WORK/known_hosts" "$RUNNER:/work/known_hosts" >/dev/null
SSH_TEST="ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/work/known_hosts -o IdentitiesOnly=yes"
expect "deploy signs in with the summary's known_hosts" on_runner "$SSH_TEST -i /keys/deploy deploy@$SERVER id -nG | grep -qw docker"
expect_fail "deploy gets no terminal" 'PTY allocation request failed' on_runner "$SSH_TEST -tt -i /keys/deploy deploy@$SERVER tty"
expect "the admin signs in and has sudo" on_runner "$SSH_TEST -i /keys/admin owner@$SERVER sudo -n true"
expect_fail "the bootstrap key no longer opens root" 'Permission denied' on_runner "$SSH_TEST -i /keys/bootstrap root@$SERVER true"
expect_fail "passwords are not offered" 'Permission denied (publickey)' on_runner \
    "$SSH_TEST -o PreferredAuthentications=password,keyboard-interactive -o PubkeyAuthentication=no owner@$SERVER true"

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
((FAILED == 0))
