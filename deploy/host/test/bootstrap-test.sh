#!/usr/bin/env bash
# Tests of deploy/scripts/bootstrap-host.sh on the build host (docs/saas/bootstrap.md).
# Nothing on the build host changes: the script runs with --render-only into a
# temporary folder, and every other mode runs in throwaway containers of the
# pinned image in deploy/host/test/ubuntu-image.
#
#   bash deploy/host/test/bootstrap-test.sh
#
# Containers are named with MSCD_TEST_CONTAINER_PREFIX (default
# "mscd-bootstrap-test-") and removed at the end. The apply test installs
# sudo, openssh-server and ufw inside its container, so it needs the Ubuntu
# archive (the proxy variables of this shell are passed on). Set
# MSCD_BOOTSTRAP_TEST_OFFLINE=1 to skip it.
set -Eeuo pipefail

REPO_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)
SCRIPT=$REPO_DIR/deploy/scripts/bootstrap-host.sh
IMAGE=$(<"$REPO_DIR/deploy/host/test/ubuntu-image")
PREFIX=${MSCD_TEST_CONTAINER_PREFIX:-mscd-bootstrap-test-}
CONTAINER=${PREFIX}apply
WORK=$(mktemp -d)
FAILED=0
PASSED=0

cleanup() {
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
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
    if [[ -n ${2:-} && -f $2 ]]; then
        sed 's/^/        | /' "$2" | tail -n 40
    fi
}
# expect NAME COMMAND...: the command succeeds.
expect() {
    local name=$1
    shift
    if "$@" >"$WORK/out" 2>&1; then pass "$name"; else fail "$name" "$WORK/out"; fi
}
# expect_fail NAME CODE PATTERN COMMAND...: exits with CODE and prints PATTERN.
expect_fail() {
    local name=$1 code=$2 pattern=$3 rc=0
    shift 3
    "$@" >"$WORK/out" 2>&1 || rc=$?
    if [[ $rc == "$code" ]] && grep -q -- "$pattern" "$WORK/out"; then
        pass "$name"
    else
        echo "exit $rc, expected $code and: $pattern" >>"$WORK/out"
        fail "$name" "$WORK/out"
    fi
}

printf '==> Syntax\n'
expect "bash -n bootstrap-host.sh" bash -n "$SCRIPT"
expect "sh -n reboot marker" sh -n "$REPO_DIR/deploy/host/system/mscd-reboot-marker"
expect "image pinned by tag and digest" \
    grep -Eqx 'ubuntu:noble-[0-9]{8}(\.[0-9]+)?@sha256:[0-9a-f]{64}' "$REPO_DIR/deploy/host/test/ubuntu-image"
expect "daemon.json is JSON and keeps 172.31.0.0/16 free" node -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const pools = d["default-address-pools"].map((p) => p.base);
    if (d["live-restore"] !== true || d["log-driver"] !== "local") process.exit(1);
    if (pools.some((b) => b.startsWith("172.31."))) process.exit(1);
    if (!pools.includes("172.16.0.0/13")) process.exit(1);' "$REPO_DIR/deploy/host/docker/daemon.json"
if command -v dockerd >/dev/null 2>&1; then
    expect "dockerd accepts daemon.json" dockerd --validate --config-file="$REPO_DIR/deploy/host/docker/daemon.json"
fi

printf '\n==> Options\n'
expect_fail "--admin-user is required" 2 'admin-user is required' \
    bash "$SCRIPT" --dry-run --deploy-key-file "$REPO_DIR/deploy/host/test/deploy.pub"
expect_fail "reserved admin name refused" 2 'cannot be deploy' \
    bash "$SCRIPT" --dry-run --admin-user deploy --deploy-key-file "$REPO_DIR/deploy/host/test/deploy.pub"
expect_fail "unknown step refused" 2 'unknown step' \
    bash "$SCRIPT" --dry-run --admin-user owner --deploy-key-file "$REPO_DIR/deploy/host/test/deploy.pub" --only nothing
expect_fail "--root / refused" 2 'would change the machine' \
    bash "$SCRIPT" --render-only --root / --admin-user owner --deploy-key-file "$REPO_DIR/deploy/host/test/deploy.pub"
expect_fail "modes cannot be combined" 2 'cannot be combined' \
    bash "$SCRIPT" --check --dry-run --admin-user owner --deploy-key-file "$REPO_DIR/deploy/host/test/deploy.pub"
printf -- '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n' >"$WORK/private"
expect_fail "private key refused" 2 'holds a private key' \
    bash "$SCRIPT" --dry-run --admin-user owner --deploy-key-file "$WORK/private"
printf 'command="echo hi" %s\n' "$(<"$REPO_DIR/deploy/host/test/deploy.pub")" >"$WORK/options.pub"
expect_fail "key options refused" 2 'not an SSH public key' \
    bash "$SCRIPT" --dry-run --admin-user owner --deploy-key-file "$WORK/options.pub"
expect_fail "--format-data-device needs a device" 2 'needs --data-device' \
    bash "$SCRIPT" --dry-run --admin-user owner --deploy-key-file "$REPO_DIR/deploy/host/test/deploy.pub" --format-data-device

printf '\n==> Render only\n'
R=$WORK/root
mkdir -p "$R"
expect "render" bash "$SCRIPT" --render-only --root "$R" --admin-user owner \
    --deploy-key-file "$REPO_DIR/deploy/host/test/deploy.pub" --admin-key-file "$REPO_DIR/deploy/host/test/deploy.pub"
expect "sshd: no passwords, no root" bash -c \
    'grep -qx "PasswordAuthentication no" "$1" && grep -qx "PermitRootLogin no" "$1" && grep -qx "AllowUsers deploy owner" "$1"' \
    _ "$R/etc/ssh/sshd_config.d/10-mscd.conf"
expect "journald 1 GB" grep -qx 'SystemMaxUse=1G' "$R/etc/systemd/journald.conf.d/10-mscd.conf"
expect "swappiness 10" grep -qx 'vm.swappiness = 10' "$R/etc/sysctl.d/90-mscd.conf"
expect "deploy key with restrict" grep -q '^restrict ssh-ed25519 ' "$R/home/deploy/.ssh/authorized_keys"
expect "admin key without restrict" grep -q '^ssh-ed25519 ' "$R/home/owner/.ssh/authorized_keys"
expect "sudoers names the admin" grep -qx 'owner ALL=(ALL:ALL) NOPASSWD: ALL' "$R/etc/sudoers.d/90-mscd-admin"
expect "docker apt source for noble" grep -qx 'Suites: noble' "$R/etc/apt/sources.list.d/docker.sources"
expect "fail2ban jail for sshd" grep -qx 'enabled = true' "$R/etc/fail2ban/jail.d/mscd.local"
expect "no placeholder left" bash -c '! grep -rq "@[A-Z_]*@" "$1"' _ "$R"
expect "render twice gives the same files" bash -c '
    a=$(cd "$1" && find . -type f -exec sha256sum {} + | sort)
    bash "$2" --render-only --root "$1" --admin-user owner --deploy-key-file "$3" --admin-key-file "$3" >/dev/null
    b=$(cd "$1" && find . -type f -exec sha256sum {} + | sort)
    [[ $a == "$b" ]]' _ "$R" "$SCRIPT" "$REPO_DIR/deploy/host/test/deploy.pub"
R2=$WORK/root-data
mkdir -p "$R2"
expect "render with a data device" bash "$SCRIPT" --render-only --root "$R2" --admin-user owner \
    --deploy-key-file "$REPO_DIR/deploy/host/test/deploy.pub" --data-device /dev/m2-test-none --only data-volume
expect "docker waits for the data volume" \
    grep -qx 'RequiresMountsFor=/var/lib/docker' "$R2/etc/systemd/system/docker.service.d/10-mscd-data.conf"
expect "mount unit for /var/lib/docker" grep -qx 'Where=/var/lib/docker' "$R2/etc/systemd/system/var-lib-docker.mount"

printf '\n==> Reboot marker\n'
mkdir -p "$WORK/metrics"
expect "marker 0 without the flag" bash -c '
    MSCD_METRICS_DIR="$1" MSCD_REBOOT_FLAG="$1/none" sh "$2" && grep -qx "mscd_host_reboot_required 0" "$1/reboot.prom"' \
    _ "$WORK/metrics" "$REPO_DIR/deploy/host/system/mscd-reboot-marker"
expect "marker 1 with the flag" bash -c '
    touch "$1/flag" && MSCD_METRICS_DIR="$1" MSCD_REBOOT_FLAG="$1/flag" sh "$2" &&
    grep -qx "mscd_host_reboot_required 1" "$1/reboot.prom" &&
    grep -Eq "^mscd_host_reboot_required_since_timestamp_seconds [1-9][0-9]+$" "$1/reboot.prom" &&
    [[ $(stat -c %a "$1/reboot.prom") == 644 ]] && ! ls "$1"/.reboot* >/dev/null 2>&1' \
    _ "$WORK/metrics" "$REPO_DIR/deploy/host/system/mscd-reboot-marker"

printf '\n==> Dry run in %s\n' "$IMAGE"
DRY=(docker run --rm --name "${PREFIX}dry-run" --network none -v "$REPO_DIR/deploy:/deploy:ro" "$IMAGE"
    bash /deploy/scripts/bootstrap-host.sh --dry-run --admin-user owner --deploy-key-file /deploy/host/test/deploy.pub)
"${DRY[@]}" >"$WORK/dry" 2>&1 || true
expect "dry run exits 0" "${DRY[@]}"
for line in 'ufw limit 22/tcp' 'ufw allow 80/tcp' 'ufw allow 443/tcp' 'ufw allow 443/udp' 'ufw --force enable' \
    'apt-get .* install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin' \
    'useradd .*--groups docker .*deploy' 'useradd .*--groups sudo .*owner' 'write /etc/docker/daemon.json' \
    'systemctl try-reload-or-restart ssh.service' 'install -d -m 0700 -o deploy -g deploy /opt/mscd/secrets'; do
    expect "dry run prints: $line" grep -Eq -- "$line" "$WORK/dry"
done
expect "dry run reports no error" bash -c '! grep -q ERROR "$1"' _ "$WORK/dry"
expect_fail "check mode reports differences" 1 'differ from the target state' \
    docker run --rm --name "${PREFIX}check" --network none -v "$REPO_DIR/deploy:/deploy:ro" "$IMAGE" \
    bash /deploy/scripts/bootstrap-host.sh --check --admin-user owner --deploy-key-file /deploy/host/test/deploy.pub
expect_fail "a real run refuses the test key" 1 'test key of deploy/host/test' \
    docker run --rm --name "${PREFIX}test-key" --network none -v "$REPO_DIR/deploy:/deploy:ro" "$IMAGE" \
    bash /deploy/scripts/bootstrap-host.sh --admin-user owner --deploy-key-file /deploy/host/test/deploy.pub --only folders
# A smaller swap file, for example from a provider image, is a difference.
SMALL_SWAP='dd if=/dev/zero of=/swapfile bs=1M count=64 status=none && chmod 0600 /swapfile && mkswap /swapfile >/dev/null &&
    bash /deploy/scripts/bootstrap-host.sh --admin-user owner --deploy-key-file /deploy/host/test/deploy.pub --only system'
expect_fail "check finds a swap file smaller than 4 GB" 1 '/swapfile is 64 MB, smaller than 4096 MB' \
    docker run --rm --name "${PREFIX}swap-check" --network none -v "$REPO_DIR/deploy:/deploy:ro" "$IMAGE" \
    bash -c "$SMALL_SWAP --check"
docker run --rm --name "${PREFIX}swap-dry-run" --network none -v "$REPO_DIR/deploy:/deploy:ro" "$IMAGE" \
    bash -c "$SMALL_SWAP --dry-run" >"$WORK/swap" 2>&1 || true
expect "dry run replaces a smaller swap file" bash -c '
    grep -q "+ rm -f /swapfile" "$1" && grep -q "count=4096" "$1" && grep -q "+ mkswap /swapfile" "$1"' _ "$WORK/swap"

if [[ ${MSCD_BOOTSTRAP_TEST_OFFLINE:-0} == 1 ]]; then
    printf '\n==> Apply in a container: skipped (MSCD_BOOTSTRAP_TEST_OFFLINE=1)\n'
else
    printf '\n==> Apply of accounts, folders, firewall and ssh in a container\n'
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    # NET_ADMIN lets ufw load its rules into the container's own network namespace.
    docker run -d --name "$CONTAINER" --cap-add NET_ADMIN \
        -e http_proxy -e https_proxy -e HTTP_PROXY -e HTTPS_PROXY -e no_proxy -e NO_PROXY \
        -v "$REPO_DIR/deploy:/deploy:ro" "$IMAGE" sleep 1800 >/dev/null
    in_box() { docker exec -e NO_COLOR=1 "$CONTAINER" bash -c "$1"; }
    expect "install sudo, openssh-server and ufw" in_box '
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -q >/dev/null && apt-get install -y -q sudo openssh-server ufw >/dev/null &&
        groupadd docker && install -d -m 0700 /root/.ssh && mkdir -p /keys &&
        ssh-keygen -q -t ed25519 -N "" -C deploy-test -f /keys/deploy &&
        ssh-keygen -q -t ed25519 -N "" -C admin-test -f /keys/admin'
    BOOT='bash /deploy/scripts/bootstrap-host.sh --admin-user owner --deploy-key-file /keys/deploy.pub --admin-key-file /keys/admin.pub'
    expect_fail "first apply stops at fail2ban without systemd" 1 'systemd is not running' \
        in_box "$BOOT --only accounts,folders,firewall,ssh"
    expect "apply of accounts, folders and ssh" in_box "$BOOT --only accounts,folders,ssh"
    in_box "$BOOT --only accounts,folders,ssh" >"$WORK/second" 2>&1 || true
    expect "second apply changes nothing" bash -c '! grep -Eq "^  (changed|differs) " "$1" && grep -q "^  done " "$1"' \
        _ "$WORK/second"
    expect "check passes after apply" in_box "$BOOT --check --only accounts,folders,ssh"
    expect "accounts and groups" in_box '
        id -nG deploy | tr " " "\n" | grep -qx docker && ! id -nG deploy | tr " " "\n" | grep -qx sudo &&
        id -nG owner | tr " " "\n" | grep -qx sudo && [[ $(passwd -S deploy | cut -d" " -f2) == L ]] &&
        [[ $(getent passwd mscd | cut -d: -f7) == /usr/sbin/nologin ]] && (( $(id -u mscd) < 1000 ))'
    expect "authorized keys" in_box '
        grep -q "^restrict ssh-ed25519 .* deploy-test$" /home/deploy/.ssh/authorized_keys &&
        grep -q "^ssh-ed25519 .* admin-test$" /home/owner/.ssh/authorized_keys &&
        [[ $(stat -c "%a %U" /home/deploy/.ssh /home/deploy/.ssh/authorized_keys | tr "\n" " ") == "700 deploy 600 deploy " ]]'
    expect "folders with owner and mode" in_box '
        [[ $(stat -c "%n %a %U" /opt/mscd /opt/mscd/releases /opt/mscd/state /opt/mscd/logs /opt/mscd/secrets /opt/mscd/backup /opt/mscd/metrics | tr "\n" " ") == "/opt/mscd 755 deploy /opt/mscd/releases 755 deploy /opt/mscd/state 750 deploy /opt/mscd/logs 750 deploy /opt/mscd/secrets 700 deploy /opt/mscd/backup 700 deploy /opt/mscd/metrics 755 deploy " ]]'
    expect "sudo works for the admin without a password" in_box 'su -s /bin/bash owner -c "sudo -n true"'
    expect "sshd settings in effect" in_box '
        out=$(sshd -T) && grep -qx "passwordauthentication no" <<<"$out" && grep -qx "permitrootlogin no" <<<"$out" &&
        grep -qx "allowusers deploy" <<<"$out" && grep -qx "allowusers owner" <<<"$out" &&
        grep -qx "authenticationmethods publickey" <<<"$out"'
    expect "known_hosts line saved" in_box 'grep -q " ssh-ed25519 AAAA" /opt/mscd/state/ssh-known-hosts'
    expect "ufw rules and policy" in_box '
        ufw show added | grep -qx "ufw limit 22/tcp comment '"'"'mscd-ssh'"'"'" &&
        ufw show added | grep -qx "ufw allow 443/udp comment '"'"'mscd-http3'"'"'" &&
        ufw status verbose | grep -q "^Status: active" && ufw status verbose | grep -q "Default: deny (incoming)" &&
        ufw status verbose | grep -Eq "^22/tcp +LIMIT IN +Anywhere" &&
        { [[ ! -e /proc/sys/net/ipv6 ]] || ufw status verbose | grep -Eq "^22/tcp \(v6\) +LIMIT IN"; }'
    expect_fail "check of the firewall reports only fail2ban" 1 'fail2ban watches the SSH logins' \
        in_box "$BOOT --check --only firewall"
    expect "check of the firewall finds no ufw difference" bash -c '! grep -q "differs  ufw" "$1"' _ "$WORK/out"
    in_box 'chmod 0777 /opt/mscd/secrets && echo "PasswordAuthentication yes" >/etc/ssh/sshd_config.d/05-other.conf' \
        >/dev/null 2>&1
    in_box "$BOOT --check --only folders,ssh" >"$WORK/drift" 2>&1 || true
    expect "check finds a changed folder mode" grep -q 'differs  /opt/mscd/secrets/ (mode and owner 777' "$WORK/drift"
    expect "check finds an overriding sshd file" grep -q 'differs  sshd settings in effect' "$WORK/drift"
    expect_fail "apply refuses an overriding sshd file" 1 'overrides /etc/ssh/sshd_config.d/10-mscd.conf (passwordauthentication yes)' \
        in_box "$BOOT --only ssh"
    in_box 'rm /etc/ssh/sshd_config.d/05-other.conf' >/dev/null 2>&1
    expect "apply repairs the folder mode" in_box "$BOOT --only folders,ssh"
    expect "check passes again" in_box "$BOOT --check --only accounts,folders,ssh"
    expect_fail "an admin key file stays required when root has no key" 1 'root has none to copy' \
        in_box 'userdel -r owner >/dev/null 2>&1; bash /deploy/scripts/bootstrap-host.sh --admin-user owner --deploy-key-file /keys/deploy.pub --only accounts'
    # A key that is commented out opens nothing, so it must not count.
    in_box 'printf "# ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOld old-key-removed\n" >/home/owner/.ssh/authorized_keys &&
        chown owner:owner /home/owner/.ssh/authorized_keys && chmod 0600 /home/owner/.ssh/authorized_keys' >/dev/null 2>&1
    expect_fail "a commented key is not an admin key" 1 'root has none to copy' \
        in_box 'bash /deploy/scripts/bootstrap-host.sh --admin-user owner --deploy-key-file /keys/deploy.pub --only accounts'
    expect_fail "the lockout guard ignores a commented key" 1 'The account owner has no SSH key' \
        in_box 'bash /deploy/scripts/bootstrap-host.sh --admin-user owner --deploy-key-file /keys/deploy.pub --only ssh'
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
fi

printf '\n==> Workflow\n'
# yaml is resolved from the repository, so the test runs from any folder.
expect "bootstrap-prod.yml parses" node -e '
    const y = require(require.resolve("yaml", { paths: [process.argv[2]] }));
    const w = y.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const job = Object.values(w.jobs)[0];
    if (!w.on.workflow_dispatch || w.on.push || w.on.pull_request) process.exit(1);
    if (!String(job.environment).includes("inputs.target")) process.exit(1);
    if (!job.concurrency || job.concurrency["cancel-in-progress"] !== false) process.exit(1);
    if (!w.permissions || w.permissions.contents !== "read") process.exit(1);' \
    "$REPO_DIR/.github/workflows/bootstrap-prod.yml" "$REPO_DIR"
if [[ -f $REPO_DIR/tools/scripts/check-workflows.mjs ]]; then
    expect "check-workflows.mjs" node "$REPO_DIR/tools/scripts/check-workflows.mjs" "$REPO_DIR/.github/workflows/bootstrap-prod.yml"
fi

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
((FAILED == 0))
