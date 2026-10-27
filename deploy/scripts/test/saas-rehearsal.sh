#!/usr/bin/env bash
# shellcheck disable=SC2016  # Node scripts are in single quotes on purpose
# MSCD SaaS: rehearsal of deploy, upgrade, automatic rollback and manual rollback with
# saas-deploy.sh on the build host (Milestone 2 plan K, M2-S05).
#
#   flock /tmp/mscd-stack.lock bash deploy/scripts/test/saas-rehearsal.sh
#   bash deploy/scripts/test/saas-rehearsal.sh --down       remove what an earlier run left
#   bash deploy/scripts/test/saas-rehearsal.sh --workflow   the SSH, copy and deploy steps of
#                                                           deploy-prod.yml against a test server
#
# The stack publishes ports 18080 and 18443 like the other Compose test stacks of this
# repository, so it runs under the host lock (R-05).
#
# What it does:
#   1. Starts a local registry on 127.0.0.1:5000 (registry:3.0.0, data in memory).
#   2. Makes a throwaway release key set with saas-keys.sh (S-2), builds the release images
#      1.1.0-rc.1 and 1.1.0-rc.2 with it and pushes both to the registry.
#   3. Makes broken versions from them:
#        rc.3  the rc.2 web image tagged as the server image (the plan's broken version);
#        rc.4  the rc.2 server image with one more migration that fails;
#        rc.5  the rc.1 server image, also tagged as the web image, which never serves.
#   4. Copies each release into /tmp/mscd-rehearsal/releases/<tag> the way deploy-prod.yml
#      does (saas_stage_release), then removes the local images, so every deploy pulls.
#   5. Runs saas-deploy.sh as a user that is not root but is in the docker group, as the
#      deploy account of a server does, with the values on standard input:
#        deploy rc.1    first deploy; then the key files, the derived anchor key, the owners,
#                       a test mail through the cli service to Mailpit with the MSCD_SMTP_*
#                       values and smtp.password, and the audit anchor check;
#        deploy rc.1    with a wrong PLATFORM_KEY: refused, the key file stays;
#        deploy rc.2    upgrade with a pre-deploy dump, while the API is polled;
#        refusals       a release folder with config/demo-secrets, --no-verify-signature for
#                       images of another registry, and a failing cosign;
#        deploy rc.3    refused before anything changes; rc.2 keeps running;
#        deploy rc.4    migrate fails: automatic restore of rc.2;
#        deploy rc.5    health check fails after the services were replaced: automatic
#                       restore of rc.2;
#        rollback       back to rc.1;
#        check-only     on the result.
#   6. Removes every container, network, volume, image and folder it made.
#
# --workflow runs the steps "Open the SSH connection", "Copy the release to the server",
# "Deploy on the server", "Summary" and "Close the connection" of deploy-prod.yml in a runner
# container (Ubuntu 24.04 of deploy/host/test/ubuntu-image, openssh-client and rsync from the
# Ubuntu archive) against a server container with sshd on port 2222, the deploy account with a
# "restrict" key and a stand-in docker command. It checks the pinned host key (the port-22 lines
# through HostKeyAlias), one SSH login for the whole run, the rsync copy without demo files, the
# registry login with the job token on standard input and the logout, and that saas-deploy.sh
# gets every value on standard input and none on a command line or in its output. It needs no
# host lock and publishes no port.
#
# Settings (environment):
#   MSCD_TEST_CONTAINER_PREFIX     prefix of the Compose project, containers and image paths
#                                  (default mscd-; the project is <prefix>rehearsal)
#   MSCD_REHEARSAL_DIR             install folder (default /tmp/mscd-rehearsal); work files go
#                                  to <folder>-work. Both are deleted at the end
#   MSCD_REHEARSAL_REGISTRY_PORT   port of the local registry on 127.0.0.1 (default 5000)
#   MSCD_REHEARSAL_HTTP_PORT       HTTP port of Caddy (default 18080)
#   MSCD_REHEARSAL_HTTPS_PORT      HTTPS port of Caddy (default 18443)
#   MSCD_REHEARSAL_UID             user id of the deploy runs (default 61005)
#   MSCD_REHEARSAL_OVERLAYS        repo (default): the release as the repository holds it, with
#                                  the backup and monitoring parts when they exist; none: the
#                                  release without them (docker-compose.{backup,ops}.yml,
#                                  deploy/{backup,ops}, config/caddy/conf.d/*.caddy)
#   MSCD_REHEARSAL_KEEP            true: keep everything for a look; remove it with --down
#   MSCD_SAAS_TEST_SCAN            gate (default): build-release-images.sh --load and its Trivy
#                                  gate. auto: for build hosts that cannot reach the Alpine
#                                  mirrors (as saas-stack.sh)
#   MSCD_BUILD_CA                  CA certificate of a TLS-inspecting proxy for the image builds
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$SCRIPT_DIR/../../.." && pwd)

PREFIX=${MSCD_TEST_CONTAINER_PREFIX:-mscd-}
PROJECT=${PREFIX}rehearsal
INSTALL=${MSCD_REHEARSAL_DIR:-/tmp/mscd-rehearsal}
WORK=$INSTALL-work
REGISTRY_PORT=${MSCD_REHEARSAL_REGISTRY_PORT:-5000}
HTTP_PORT=${MSCD_REHEARSAL_HTTP_PORT:-18080}
HTTPS_PORT=${MSCD_REHEARSAL_HTTPS_PORT:-18443}
RUN_UID=${MSCD_REHEARSAL_UID:-61005}
OVERLAYS=${MSCD_REHEARSAL_OVERLAYS:-repo}
KEEP=${MSCD_REHEARSAL_KEEP:-false}
SCAN=${MSCD_SAAS_TEST_SCAN:-gate}

export COMPOSE_PROJECT_NAME=$PROJECT
# shellcheck source=SCRIPTDIR/../lib/common.sh
. "$REPO_DIR/deploy/scripts/lib/common.sh"
# shellcheck source=SCRIPTDIR/../lib/saas.sh
. "$REPO_DIR/deploy/scripts/lib/saas.sh"

# K.4: the local registry of deploy rehearsals (tests only), exact version and digest.
readonly REGISTRY_IMAGE=registry:3.0.0@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e
readonly MAILPIT_IMAGE=axllent/mailpit:v1.31.3
readonly ANCHOR_MISMATCH='not among the anchor keys compiled into this build'
readonly V1=1.1.0-rc.1 V2=1.1.0-rc.2 V3=1.1.0-rc.3 V4=1.1.0-rc.4 V5=1.1.0-rc.5
readonly APP_HOST=localhost
readonly OPERATOR_EMAIL=operator@rehearsal.invalid

REGISTRY=127.0.0.1:$REGISTRY_PORT/$PROJECT
REGISTRY_CONTAINER=$PROJECT-registry
MAILPIT_CONTAINER=$PROJECT-mailpit
LOCAL_SERVER=localhost/$PROJECT/mscd-server
LOCAL_WEB=localhost/$PROJECT/mscd-web
INSTALL_DIR=$INSTALL
RC=0
CHECKS=0
DOCKER_GID=''
SMTP_SECRET=''
SUBNET_MSCD='' SUBNET_EDGE=''
declare -A SERVER_DIGEST=() WEB_DIGEST=()

usage() {
    sed -n '3,/^set -euo pipefail$/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

ok() {
    CHECKS=$((CHECKS + 1))
    pass "$*"
}

bad() {
    fail "$@"
}

curl_local() {
    curl --noproxy '*' --silent --show-error --max-time 20 "$@"
}

# caddy_get PATH: the body of https://localhost:<port>PATH through Caddy.
caddy_get() {
    curl_local -k --resolve "$APP_HOST:$HTTPS_PORT:127.0.0.1" "https://$APP_HOST:$HTTPS_PORT$1" 2>/dev/null || true
}

caddy_version() {
    caddy_get /api/v1/system/profile | grep -o '"version":"[^"]*"' | head -n 1 | cut -d'"' -f4 || true
}

state_value() {
    kv_get "$INSTALL/state/current.env" "$1"
}

log_file() {
    printf '%s/logs/%s.log' "$WORK" "$1"
}

log_has() {
    grep -qF -- "$2" "$(log_file "$1")"
}

show_log() {
    detail "Last lines of $(log_file "$1"):"
    tail -n "${2:-30}" "$(log_file "$1")" | sed 's/^/          /'
}

# temp_folder PATH: a plain absolute path below /tmp or /var/tmp (the end deletes it).
temp_folder() {
    [[ $1 == /* && $1 != */ && $1 != *//* ]] || return 1
    case "$1/" in */./* | */../*) return 1 ;; esac
    case "$1" in /tmp/?* | /var/tmp/?*) return 0 ;; esac
    return 1
}

valid_settings() {
    [[ $PROJECT =~ ^[a-z0-9][a-z0-9_-]{0,40}$ ]] ||
        die "MSCD_TEST_CONTAINER_PREFIX gives the project name '$PROJECT'; use lower-case letters, digits, '-' or '_'"
    temp_folder "$INSTALL" ||
        die "MSCD_REHEARSAL_DIR must be a plain absolute path below /tmp or /var/tmp (the rehearsal deletes it), got '$INSTALL'"
    for port in "$REGISTRY_PORT" "$HTTP_PORT" "$HTTPS_PORT"; do
        valid_port "$port" || die "Ports must be numbers from 1 to 65535, got '$port'"
    done
    [[ $RUN_UID =~ ^[1-9][0-9]{2,6}$ ]] || die "MSCD_REHEARSAL_UID must be a user id other than root, got '$RUN_UID'"
    case "$OVERLAYS" in repo | none) ;; *) die "MSCD_REHEARSAL_OVERLAYS must be repo or none, got '$OVERLAYS'" ;; esac
    case "$SCAN" in gate | auto) ;; *) die "MSCD_SAAS_TEST_SCAN must be gate or auto, got '$SCAN'" ;; esac
}

# free_subnets: two 172.31.x.0/24 ranges that no other Docker network uses.
free_subnets() {
    docker network ls -q | xargs -r docker network inspect \
        --format '{{index .Labels "com.docker.compose.project"}}|{{range .IPAM.Config}}{{.Subnet}} {{end}}' |
        node -e '
const project = process.argv[1];
const used = [];
for (const line of require("fs").readFileSync(0, "utf8").split("\n")) {
  const [label, subnets = ""] = line.split("|");
  if (label === project) continue;
  for (const s of subnets.trim().split(/\s+/)) {
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(s);
    if (!m) continue;
    const base = ((+m[1] << 24) | (+m[2] << 16) | (+m[3] << 8) | +m[4]) >>> 0;
    const size = 2 ** (32 - +m[5]);
    used.push([base - (base % size), size]);
  }
}
const free = (octet) => {
  const base = ((172 << 24) | (31 << 16) | (octet << 8)) >>> 0;
  return !used.some(([b, size]) => base < b + size && b < base + 256);
};
const order = [250, 251, ...Array.from({ length: 248 }, (_, i) => 249 - i)];
const picks = order.filter(free);
if (picks.length < 2) process.exit(1);
process.stdout.write(`${picks[0]} ${picks[1]}\n`);
' "$PROJECT"
}

wait_for() {
    local timeout=$1 start=$SECONDS
    shift
    until "$@" >/dev/null 2>&1; do
        ((SECONDS - start < timeout)) || return 1
        sleep 2
    done
}

# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------

start_registry() {
    docker run -d --name "$REGISTRY_CONTAINER" --restart no -p "127.0.0.1:$REGISTRY_PORT:5000" \
        --tmpfs /var/lib/registry:size=4g --security-opt no-new-privileges:true \
        "$REGISTRY_IMAGE" >/dev/null
    wait_for 60 curl_local -f "http://127.0.0.1:$REGISTRY_PORT/v2/" || die "The registry on 127.0.0.1:$REGISTRY_PORT did not answer"
    ok "Local registry $REGISTRY_IMAGE on 127.0.0.1:$REGISTRY_PORT (data in memory)"
}

# build_version VERSION FIRST: release images with the throwaway keys, as
# localhost/<project>/mscd-{server,web}:VERSION.
build_version() {
    local version=$1 first=$2 log=$WORK/build-$1.log
    local -a build
    if [[ $SCAN == gate ]]; then
        build=(bash "$REPO_DIR/deploy/scripts/build-release-images.sh" --version "$version"
            --trusted-keys-dir "$WORK/keys/trusted" --pack-signing-key "$WORK/keys/pack-signing.key"
            --registry "localhost/$PROJECT" --load --digest-file "$WORK/local-$version.json")
        [[ $first == true ]] || build+=(--no-pull)
    else
        build=(bash "$REPO_DIR/deploy/scripts/build-bundle.sh" --images-only --version "$version"
            --trusted-keys-dir "$WORK/keys/trusted" --pack-signing-key "$WORK/keys/pack-signing.key"
            --server-image "$LOCAL_SERVER" --web-image "$LOCAL_WEB" --os-updates auto --scan auto
            --output "$WORK/build")
        [[ $first == true ]] && build+=(--pull)
        if docker info --format '{{json .DriverStatus}}' 2>/dev/null | grep -q 'io.containerd.snapshotter.v1'; then
            build+=(--attest)
        fi
    fi
    if [[ -n ${MSCD_BUILD_CA:-} ]]; then build+=(--build-ca "$MSCD_BUILD_CA"); fi
    info "Building $version (log: $log)"
    if ! "${build[@]}" >"$log" 2>&1; then
        grep -E 'FAIL|ERROR' "$log" | tail -n 15 | sed 's/^/        /' || true
        if grep -q 'did not pass the release gate' "$log"; then
            detail "On a build host without access to the Alpine mirrors, run again with MSCD_SAAS_TEST_SCAN=auto."
        fi
        move_build_logs "$version"
        die "The image build of $version failed (log: $log)"
    fi
    move_build_logs "$version"
    [[ $(docker image inspect --format '{{index .Config.Labels "com.cyberlentera.mscd.flavor"}}' "$LOCAL_SERVER:$version") == release ]] ||
        die "$LOCAL_SERVER:$version is not a release build"
    ok "Release images $version built with the throwaway keys"
}

move_build_logs() {
    local logs=$REPO_DIR/deploy/dist/mscd-images-$1.logs
    if [[ -d $logs ]]; then
        rm -rf -- "$WORK/build-logs-$1"
        mv -- "$logs" "$WORK/build-logs-$1"
    fi
}

# push_image LOCAL TARGET: tags and pushes LOCAL as TARGET and prints the pushed digest.
push_image() {
    local src=$1 target=$2 out digest
    docker tag "$src" "$target"
    out=$(docker push "$target" 2>&1) || { printf '%s\n' "$out" | tail -n 10 >&2; die "docker push $target failed"; }
    digest=$(printf '%s\n' "$out" | sed -n 's/.*digest: \(sha256:[0-9a-f]\{64\}\).*/\1/p' | tail -n 1)
    [[ -n $digest ]] || die "docker push $target reported no digest"
    printf '%s' "$digest"
}

# write_digests VERSION: digests.json of a rehearsal release (the format of M2-S01).
write_digests() {
    local version=$1 server=${SERVER_DIGEST[$1]} web=${WEB_DIGEST[$1]}
    cat >"$WORK/digests-$version.json" <<EOF
{
  "version": "$version",
  "revision": "rehearsal",
  "created": "$(saas_now)",
  "pushed": true,
  "attested": false,
  "server": "$server",
  "web": "$web",
  "serverImage": "$REGISTRY/mscd-server",
  "webImage": "$REGISTRY/mscd-web",
  "serverRef": "$REGISTRY/mscd-server@$server",
  "webRef": "$REGISTRY/mscd-web@$web"
}
EOF
}

build_and_push() {
    local v ctx
    step "Release images"
    build_version "$V1" true
    build_version "$V2" false
    for v in "$V1" "$V2"; do
        SERVER_DIGEST[$v]=$(push_image "$LOCAL_SERVER:$v" "$REGISTRY/mscd-server:$v")
        WEB_DIGEST[$v]=$(push_image "$LOCAL_WEB:$v" "$REGISTRY/mscd-web:$v")
        ok "Pushed $v: server ${SERVER_DIGEST[$v]:7:12}, web ${WEB_DIGEST[$v]:7:12}"
    done

    step "Broken versions"
    SERVER_DIGEST[$V3]=$(push_image "$LOCAL_WEB:$V2" "$REGISTRY/mscd-server:$V3")
    WEB_DIGEST[$V3]=$(push_image "$LOCAL_WEB:$V2" "$REGISTRY/mscd-web:$V3")
    ok "$V3: the web image of $V2 tagged as the server image"
    ctx=$WORK/rc4
    install -d -m 0755 "$ctx"
    printf -- '-- Rehearsal: a migration that always fails (division by zero).\nSELECT 1 / 0;\n' >"$ctx/9999_rehearsal_fails.sql"
    printf 'FROM %s\nCOPY 9999_rehearsal_fails.sql /app/apps/server/migrations/platform/9999_rehearsal_fails.sql\n' \
        "$LOCAL_SERVER:$V2" >"$ctx/Dockerfile"
    if ! docker build --quiet -t "$LOCAL_SERVER:$V4" "$ctx" >"$WORK/build-$V4.log" 2>&1; then
        # A builder that does not read the local image store takes the pushed image instead.
        printf 'FROM %s\nCOPY 9999_rehearsal_fails.sql /app/apps/server/migrations/platform/9999_rehearsal_fails.sql\n' \
            "$REGISTRY/mscd-server@${SERVER_DIGEST[$V2]}" >"$ctx/Dockerfile"
        docker build --quiet -t "$LOCAL_SERVER:$V4" "$ctx" >>"$WORK/build-$V4.log" 2>&1 ||
            { tail -n 10 "$WORK/build-$V4.log"; die "The broken image $V4 could not be built"; }
    fi
    SERVER_DIGEST[$V4]=$(push_image "$LOCAL_SERVER:$V4" "$REGISTRY/mscd-server:$V4")
    WEB_DIGEST[$V4]=$(push_image "$LOCAL_WEB:$V2" "$REGISTRY/mscd-web:$V4")
    ok "$V4: the server image of $V2 with a migration that fails"
    SERVER_DIGEST[$V5]=$(push_image "$LOCAL_SERVER:$V1" "$REGISTRY/mscd-server:$V5")
    WEB_DIGEST[$V5]=$(push_image "$LOCAL_SERVER:$V1" "$REGISTRY/mscd-web:$V5")
    ok "$V5: the server image of $V1, also tagged as the web image"
    for v in "$V1" "$V2" "$V3" "$V4" "$V5"; do write_digests "$v"; done
    # Every deploy pulls from the registry, as on a server.
    remove_local_images
    ok "Local copies removed: every deploy pulls its images by digest"
}

# local_image_refs: every image reference of this rehearsal on this host, one per line.
local_image_refs() {
    docker image ls --digests --format '{{.Repository}} {{.Tag}} {{.Digest}}' 2>/dev/null |
        awk -v a="$REGISTRY/" -v b="localhost/$PROJECT/" 'index($1, a) == 1 || index($1, b) == 1 {
            if ($2 != "<none>") print $1 ":" $2; if ($3 != "<none>") print $1 "@" $3 }' | sort -u
}

remove_local_images() {
    local ref
    while IFS= read -r ref; do
        [[ -n $ref ]] && docker image rm "$ref" >/dev/null 2>&1 || true
    done < <(local_image_refs)
}

# ---------------------------------------------------------------------------
# Release folders and deploy runs
# ---------------------------------------------------------------------------

# stage_release TAG VERSION: the release folder as deploy-prod.yml copies it.
stage_release() {
    local tag=$1 version=$2 dest=$INSTALL/releases/$1
    rm -rf -- "$dest"
    saas_stage_release "$REPO_DIR" "$dest"
    if [[ $OVERLAYS == none ]]; then
        rm -rf -- "$dest/deploy/compose/docker-compose.backup.yml" "$dest/deploy/compose/docker-compose.ops.yml" \
            "$dest/deploy/backup" "$dest/deploy/ops"
        find "$dest/deploy/compose/config/caddy/conf.d" -name '*.caddy' -delete 2>/dev/null || true
    fi
    install -m 0644 "$WORK/digests-$version.json" "$dest/digests.json"
    chown -R "$RUN_UID:$RUN_UID" "$dest"
}

# write_input FILE [PLATFORM_KEY_FILE]: standard input of a deploy, as deploy-prod.yml
# builds it (saas_encode_input), with the rehearsal's settings.
write_input() {
    local file=$1 platform=${2:-$WORK/keys/production/platform.key}
    (
        umask 077
        {
            printf 'PLATFORM_KEY=%s\n' "$(base64 -w0 <"$platform")"
            printf 'STORAGE_KEY=%s\n' "$(base64 -w0 <"$WORK/keys/production/storage.key")"
            printf 'AUDIT_ANCHOR_KEY=%s\n' "$(base64 -w0 <"$WORK/keys/production/audit-anchor.key")"
            # shellcheck disable=SC2030,SC2034  # read by saas_encode_input in this subshell
            (
                SMTP_PASSWORD=$SMTP_SECRET
                MSCD_SMTP_USER=rehearsal MSCD_SMTP_HOST=mailpit MSCD_SMTP_PORT=1025 MSCD_SMTP_SECURE=false
                MSCD_MAIL_FROM='MSCD rehearsal <mscd@rehearsal.invalid>'
                MSCD_DOMAIN=$APP_HOST MSCD_TLS_MODE=internal ACME_EMAIL='' MSCD_SITE_DOMAIN=''
                MSCD_HTTP_PORT=$HTTP_PORT MSCD_HTTPS_PORT=$HTTPS_PORT
                MSCD_SUBNET=172.31.$SUBNET_MSCD.0/24 MSCD_WEB_ADDRESS=172.31.$SUBNET_MSCD.10
                MSCD_EDGE_SUBNET=172.31.$SUBNET_EDGE.0/24 MSCD_CADDY_ADDRESS=172.31.$SUBNET_EDGE.2
                MSCD_WEB_EDGE_ADDRESS=172.31.$SUBNET_EDGE.3
                BACKUP_S3_ENDPOINT=https://backup.rehearsal.invalid BACKUP_S3_BUCKET=mscd-rehearsal
                BACKUP_S3_ACCESS_KEY=rehearsal-access BACKUP_S3_SECRET_KEY=rehearsal-secret
                BACKUP_SECRETS_ACCESS_KEY=rehearsal-secrets-access BACKUP_SECRETS_SECRET_KEY=rehearsal-secrets-secret
                BACKUP_RESTIC_PASSWORD=rehearsal-restic HEARTBEAT_BACKUP_URL=https://heartbeat.rehearsal.invalid/backup
                HEARTBEAT_WATCHDOG_URL=https://heartbeat.rehearsal.invalid/watchdog TELEGRAM_BOT_TOKEN=''
                TELEGRAM_CHAT_ID='' ALERT_EMAIL_TO=alerts@rehearsal.invalid
                OPS_DOMAIN='' OPS_BASIC_AUTH_USER='' OPS_BASIC_AUTH_HASH=''
                saas_encode_input SMTP_PASSWORD MSCD_SMTP_USER MSCD_SMTP_HOST MSCD_SMTP_PORT MSCD_SMTP_SECURE \
                    MSCD_MAIL_FROM MSCD_DOMAIN MSCD_TLS_MODE ACME_EMAIL MSCD_SITE_DOMAIN MSCD_HTTP_PORT MSCD_HTTPS_PORT \
                    MSCD_SUBNET MSCD_WEB_ADDRESS MSCD_EDGE_SUBNET MSCD_CADDY_ADDRESS MSCD_WEB_EDGE_ADDRESS \
                    "${SAAS_BACKUP_INPUTS[@]}" "${SAAS_OPS_INPUTS[@]}"
            )
        } >"$file"
    )
}

SIGNATURE_ARGS=(--no-verify-signature)

# deploy_run NAME ACTION TAG [OPTION...]: saas-deploy.sh of the release folder TAG as the
# deploy user (not root, in the docker group), standard input from INPUT (default
# <work>/input); the output goes to <work>/logs/NAME.log and the exit code to RC.
deploy_run() {
    local name=$1 action=$2 tag=$3 start=$SECONDS release=$INSTALL/releases/$3
    shift 3
    RC=0
    # The docker group is also the primary group: a group without a name in /etc/group
    # would make "id -nG" fail in the docker group check of lib/common.sh.
    setpriv --reuid "$RUN_UID" --regid "$DOCKER_GID" --groups "$DOCKER_GID" --inh-caps=-all --no-new-privs \
        env -i HOME="$WORK/home" PATH="$PATH" LANG=C.UTF-8 COMPOSE_PROJECT_NAME="$PROJECT" \
        bash "$release/deploy/scripts/saas-deploy.sh" "$action" --target test --install-dir "$INSTALL" \
        --release-dir "$release" "${SIGNATURE_ARGS[@]}" --timeout 180 --verify-timeout 120 --min-free-disk 1024 "$@" \
        <"${INPUT:-$WORK/input}" >"$(log_file "$name")" 2>&1 || RC=$?
    info "$action $tag: exit code $RC after $((SECONDS - start))s (log: $(log_file "$name"))"
}

compose() {
    saas_compose "$@"
}

# expect_version VERSION LABEL: Caddy serves VERSION and the state names it.
expect_version() {
    local got
    got=$(caddy_version)
    if [[ $got == "$1" && $(state_value VERSION) == "$1" ]]; then
        ok "$2: $1 answers through Caddy and is the current release in $INSTALL/state"
    else
        bad "$2: Caddy reports '${got:-nothing}' and the state '$(state_value VERSION)', expected $1"
    fi
}

# expect_digests VERSION: the .env in place names the images of VERSION.
expect_digests() {
    if [[ $(kv_get "$INSTALL/.env" MSCD_SERVER_DIGEST) == "${SERVER_DIGEST[$1]}" &&
        $(kv_get "$INSTALL/.env" MSCD_WEB_DIGEST) == "${WEB_DIGEST[$1]}" ]]; then
        ok ".env names the images of $1"
    else
        bad ".env does not name the images of $1"
    fi
}

all_healthy() {
    local svc id state
    for svc in postgres objectstore storage-gateway api worker web caddy; do
        id=$(project_containers "$svc" | head -n 1)
        state=$(container_state "${id:-missing}")
        [[ $state == healthy ]] || { printf '%s is %s' "$svc" "$state"; return 1; }
    done
}

expect_healthy() {
    local out
    if out=$(all_healthy); then
        ok "$1: every service is healthy"
    else
        bad "$1: $out"
    fi
}

# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

check_first_deploy() {
    local f mode
    if ((RC == 0)) && log_has deploy-rc1 "is deployed to test and healthy"; then
        ok "First deploy of $V1 finished"
    else
        bad "The first deploy of $V1 failed (exit code $RC)"
        show_log deploy-rc1 40
        return 1
    fi
    expect_version "$V1" "First deploy"
    expect_digests "$V1"
    expect_healthy "First deploy"
    for f in platform.key storage.key audit-anchor.key; do
        if cmp -s "$INSTALL/secrets/$f" "$WORK/keys/production/$f"; then
            ok "$f equals the value on standard input"
        else
            bad "$f differs from the value on standard input"
        fi
    done
    if openssl pkey -in "$INSTALL/secrets/audit-anchor.key" -pubout 2>/dev/null | cmp -s - "$INSTALL/secrets/audit-anchor.pub" &&
        cmp -s "$INSTALL/secrets/audit-anchor.pub" "$WORK/keys/production/audit-anchor.pub"; then
        ok "audit-anchor.pub matches the private key, in the format of mscd-server keys generate"
    else
        bad "audit-anchor.pub does not match audit-anchor.key or the format of keys generate"
    fi
    for f in platform.key storage.key audit-anchor.key gateway.token db-app.url smtp.password; do
        mode=$(stat -c '%u:%g %a' "$INSTALL/secrets/$f")
        [[ $mode == "10001:0 400" ]] || bad "$f is $mode, expected 10001:0 400"
    done
    [[ $(stat -c '%a' "$INSTALL/secrets/audit-anchor.pub") == 444 ]] || bad "audit-anchor.pub is not mode 0444"
    ok "Secret files belong to the server user with mode 0400 (audit-anchor.pub 0444)"
    if [[ $(cat "$INSTALL/secrets/smtp.password") == "$SMTP_SECRET" ]]; then
        ok "smtp.password holds SMTP_PASSWORD of standard input"
    else
        bad "smtp.password does not hold SMTP_PASSWORD"
    fi
    if [[ $(cat "$INSTALL/secrets/backup/BACKUP_S3_BUCKET") == mscd-rehearsal &&
        $(stat -c '%a' "$INSTALL/secrets/backup/BACKUP_RESTIC_PASSWORD") == 400 &&
        $(cat "$INSTALL/secrets/ops/ALERT_EMAIL_TO") == alerts@rehearsal.invalid &&
        -f $INSTALL/secrets/ops/TELEGRAM_BOT_TOKEN && ! -s $INSTALL/secrets/ops/TELEGRAM_BOT_TOKEN ]]; then
        ok "Off-site backup and monitoring values are files in secrets/backup and secrets/ops (mode 0400, empty when not set)"
    else
        bad "The files of secrets/backup and secrets/ops are not as sent"
    fi
    if [[ $(stat -c '%a' "$INSTALL/.env") == 600 ]] && grep -q '^MSCD_SMTP_HOST=mailpit$' "$INSTALL/.env" &&
        grep -q '^MSCD_SMTP_USER=rehearsal$' "$INSTALL/.env" && grep -q '^MSCD_SMTP_PORT=1025$' "$INSTALL/.env" &&
        grep -q '^MSCD_MAIL_FROM=MSCD rehearsal <mscd@rehearsal.invalid>$' "$INSTALL/.env" &&
        grep -q "^MSCD_EDGE_IPV6=$(saas_host_has_ipv6 && echo true || echo false)$" "$INSTALL/.env" &&
        grep -q "^COMPOSE_PROJECT_NAME=$PROJECT$" "$INSTALL/.env" && ! grep -q '^MSCD_DEMO' "$INSTALL/.env"; then
        ok ".env (mode 0600) holds the mail settings, MSCD_EDGE_IPV6 of this host and the project name"
    else
        bad ".env does not hold the expected settings"
    fi
    if [[ -L $INSTALL/deploy/compose/.env && -f $INSTALL/deploy/compose/docker-compose.saas.yml &&
        ! -e $INSTALL/deploy/compose/config/demo-secrets && ! -e $INSTALL/deploy/compose/docker-compose.demo.yml ]] &&
        (cd "$INSTALL/deploy/compose" && docker compose ps --services >/dev/null 2>&1); then
        ok "deploy/compose is installed without demo files; docker compose works there by hand"
    else
        bad "The installed deploy/compose folder is not as expected"
    fi
    if log_has deploy-rc1 "No database runs yet (first deploy): no pre-deploy dump"; then
        ok "First deploy takes no dump (no database yet)"
    else
        bad "The first deploy did not report the missing database"
    fi
}

check_mail() {
    local ip out
    step "Mail through the cli service"
    docker run -d --name "$MAILPIT_CONTAINER" --network "${PROJECT}_egress" --network-alias mailpit \
        -e MP_SMTP_AUTH="rehearsal:$SMTP_SECRET" -e MP_SMTP_AUTH_ALLOW_INSECURE=true \
        --security-opt no-new-privileges:true "$MAILPIT_IMAGE" >/dev/null
    wait_for 60 docker exec "$MAILPIT_CONTAINER" wget -q -O /dev/null http://127.0.0.1:8025/livez ||
        { bad "Mailpit did not start"; return 0; }
    ip=$(docker inspect --format "{{(index .NetworkSettings.Networks \"${PROJECT}_egress\").IPAddress}}" "$MAILPIT_CONTAINER")
    printf 'Subject: probe\r\n\r\nprobe\r\n' >"$WORK/probe.eml"
    if ! curl_local "smtp://$ip:1025" --mail-from probe@rehearsal.invalid --mail-rcpt probe@rehearsal.invalid \
        --user rehearsal:wrong-password -T "$WORK/probe.eml" >/dev/null 2>&1; then
        ok "Mailpit refuses a wrong SMTP password, so a delivered mail proves smtp.password"
    else
        bad "Mailpit accepted a wrong SMTP password; the mail check would prove nothing"
    fi
    if out=$(compose run --rm --no-deps -T cli admin create-operator --email "$OPERATOR_EMAIL" --name "Rehearsal operator" 2>&1) &&
        [[ $out == *"Invitation sent to $OPERATOR_EMAIL"* ]]; then
        ok "cli admin create-operator sent the invitation (MSCD_SMTP_* values and smtp.password)"
    else
        bad "cli admin create-operator did not send its invitation" "$(printf '%s' "$out" | tail -n 3 | tr '\n' ' ')"
    fi
    if wait_for 30 bash -c "curl --noproxy '*' -s 'http://$ip:8025/api/v1/messages' | grep -q '$OPERATOR_EMAIL'"; then
        ok "Mailpit holds the mail to $OPERATOR_EMAIL"
    else
        bad "No mail to $OPERATOR_EMAIL arrived in Mailpit"
    fi
}

check_anchor() {
    local slug out since start request
    step "Audit anchor key"
    slug=rehearsal_$(date +%s)
    request=rehearsal-$(random_hex 6)
    since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    if out=$(compose run --rm --no-deps -T cli tenant create --slug "$slug" --name "Rehearsal check" 2>&1); then
        ok "cli tenant create: a new row in the platform audit chain"
    else
        bad "cli tenant create failed" "$(printf '%s' "$out" | tail -n 3 | tr '\n' ' ')"
        return 0
    fi
    if ! out=$(compose exec -T worker node --input-type=module -e '
import { readFileSync } from "node:fs";
import { PgBoss } from "pg-boss";
const boss = new PgBoss({
  connectionString: readFileSync("/run/secrets/db-app.url", "utf8").trim(),
  schema: "pgboss", migrate: false, createSchema: false, supervise: false, schedule: false, max: 1,
});
boss.on("error", (error) => process.stderr.write(`pg-boss: ${error.message}\n`));
await boss.start();
const id = await boss.send("audit.verify-chain", { orgId: null, requestId: process.argv[1], payload: {} },
  { singletonKey: process.argv[1], retryLimit: 0 });
await boss.stop({ graceful: false, close: true });
if (!id) { process.stderr.write("the job was not queued\n"); process.exit(1); }
process.stdout.write(`queued ${id}\n`);
' "$request" 2>&1); then
        bad "The audit anchor job could not be queued" "$(printf '%s' "$out" | tail -n 3 | tr '\n' ' ')"
        return 0
    fi
    start=$SECONDS
    until compose logs --since "$since" worker 2>/dev/null | grep -q 'audit.verify-chain done'; do
        if ((SECONDS - start > 90)); then
            bad "The worker did not finish audit.verify-chain within 90 seconds"
            return 0
        fi
        sleep 2
    done
    if compose logs worker 2>/dev/null | grep -q "$ANCHOR_MISMATCH"; then
        bad "The worker log says the anchor key is $ANCHOR_MISMATCH"
    else
        ok "The worker log has no line \"$ANCHOR_MISMATCH\" after the audit anchor job"
    fi
    if compose logs --since "$since" worker 2>/dev/null | grep -q '"event":"audit.anchor"'; then
        ok "The worker signed an anchor with the deployed key (audit.anchor line)"
    else
        bad "The worker wrote no audit.anchor line, so the key was not used"
    fi
}

check_wrong_key() {
    local before
    step "Deploy with a wrong PLATFORM_KEY"
    openssl rand -base64 32 >"$WORK/wrong-platform.key"
    write_input "$WORK/input-wrong" "$WORK/wrong-platform.key"
    before=$(sha256sum <"$INSTALL/secrets/platform.key")
    INPUT=$WORK/input-wrong deploy_run wrong-key deploy "v$V1"
    if ((RC != 0)) && log_has wrong-key "platform.key does not match PLATFORM_KEY" &&
        [[ $(sha256sum <"$INSTALL/secrets/platform.key") == "$before" ]]; then
        ok "A different PLATFORM_KEY is refused and platform.key stays as it was"
    else
        bad "A wrong PLATFORM_KEY was not refused as expected (exit code $RC)"
        show_log wrong-key
    fi
    expect_version "$V1" "After the refused deploy"
}

# probe_start / probe_stop: polls the API through Caddy every half second during a deploy.
probe_start() {
    rm -f -- "$WORK/probe.stop"
    (
        while [[ ! -e $WORK/probe.stop ]]; do
            printf '%s %s\n' "$(date +%s.%N)" "$(curl_local -k -o /dev/null -w '%{http_code}' --max-time 10 \
                --resolve "$APP_HOST:$HTTPS_PORT:127.0.0.1" "https://$APP_HOST:$HTTPS_PORT/api/v1/system/profile" 2>/dev/null || true)"
            sleep 0.5
        done
    ) >"$WORK/probe.txt" 2>/dev/null &
    PROBE_PID=$!
}

probe_stop() {
    touch "$WORK/probe.stop"
    wait "$PROBE_PID" 2>/dev/null || true
    awk '{ t = $1; ok = ($2 == "200") }
        !ok && start == "" { start = t }
        ok && start != "" { gap = t - start; if (gap > longest) longest = gap; start = "" }
        !ok { failed++ }
        { total++; last = t }
        END { if (start != "") { gap = last - start; if (gap > longest) longest = gap }
              printf "%d %d %.1f\n", total, failed, longest }' "$WORK/probe.txt"
}

check_upgrade() {
    local probe total failed longest
    step "Upgrade to $V2"
    probe_start
    deploy_run deploy-rc2 deploy "v$V2"
    probe=$(probe_stop)
    read -r total failed longest <<<"$probe"
    if ((RC == 0)) && log_has deploy-rc2 "is deployed to test and healthy"; then
        ok "Upgrade from $V1 to $V2 finished"
    else
        bad "The upgrade to $V2 failed (exit code $RC)"
        show_log deploy-rc2 40
        return 1
    fi
    expect_version "$V2" "Upgrade"
    expect_digests "$V2"
    expect_healthy "Upgrade"
    if [[ $(kv_get "$INSTALL/state/previous.env" VERSION) == "$V1" ]]; then
        ok "state/previous.env names $V1, the rollback target"
    else
        bad "state/previous.env does not name $V1"
    fi
    local dump
    dump=$(find "$INSTALL/backup/pre-deploy" -name "*-$V1-to-$V2.dump" | head -n 1)
    local toc=''
    if [[ -n $dump ]]; then toc=$(compose exec -T postgres pg_restore --list <"$dump" 2>/dev/null || true); fi
    if [[ -n $dump && $(head -c 5 -- "$dump") == PGDMP && $(stat -c '%a' "$dump") == 600 ]] &&
        grep -qE 'SCHEMA - platform( |$)' <<<"$toc" && grep -qE 'SCHEMA - pgboss( |$)' <<<"$toc"; then
        ok "Pre-deploy dump in pg_dump custom format, readable by pg_restore: $(basename -- "$dump")"
    else
        bad "No pre-deploy dump of the upgrade in $INSTALL/backup/pre-deploy"
    fi
    if compgen -G "$INSTALL/logs/migrate-$V2-*.log" >/dev/null && log_has deploy-rc2 "Migrate log ("; then
        ok "The migrate log is in $INSTALL/logs and printed back"
    else
        bad "The migrate log of $V2 is missing or was not printed"
    fi
    info "During the upgrade the API answered $((total - failed)) of $total requests (every 0.5s) through Caddy; the longest gap was ${longest}s"
    printf '%s %s %s\n' "$total" "$failed" "$longest" >"$WORK/upgrade-gap.txt"
}

check_refusals() {
    local dest
    step "Refusals that change nothing"
    dest=$INSTALL/releases/v$V2-demo
    rm -rf -- "$dest"
    cp -a -- "$INSTALL/releases/v$V2" "$dest"
    install -d -o "$RUN_UID" -g "$RUN_UID" "$dest/deploy/compose/config/demo-secrets"
    deploy_run demo-files deploy "v$V2-demo"
    if ((RC != 0)) && log_has demo-files "demo files are refused" && log_has demo-files "Nothing was changed"; then
        ok "A release folder with config/demo-secrets is refused (\"demo files are refused\")"
    else
        bad "A release folder with config/demo-secrets was not refused (exit code $RC)"
        show_log demo-files
    fi
    rm -rf -- "$dest"

    dest=$INSTALL/releases/v$V2-ghcr
    rm -rf -- "$dest"
    cp -a -- "$INSTALL/releases/v$V2" "$dest"
    sed -i "s#$REGISTRY/#ghcr.io/mqusaeri/#g" "$dest/digests.json"
    deploy_run other-registry deploy "v$V2-ghcr"
    if ((RC != 0)) && log_has other-registry "accepted only for images from a registry on 127.0.0.1"; then
        ok "--no-verify-signature is refused for images of ghcr.io"
    else
        bad "--no-verify-signature was not refused for ghcr.io images (exit code $RC)"
        show_log other-registry
    fi
    rm -rf -- "$dest"

    install -d -o "$RUN_UID" -g "$RUN_UID" "$WORK/home/bin"
    cat >"$WORK/home/bin/cosign" <<EOF
#!/bin/sh
printf '%s\n' "\$*" >>"$WORK/home/cosign-args.txt"
echo "error: no matching signatures" >&2
exit 1
EOF
    chmod 0755 "$WORK/home/bin/cosign"
    chown "$RUN_UID:$RUN_UID" "$WORK/home/bin/cosign"
    SIGNATURE_ARGS=(--cosign "$WORK/home/bin/cosign")
    deploy_run cosign deploy "v$V2"
    SIGNATURE_ARGS=(--no-verify-signature)
    if ((RC != 0)) && log_has cosign "does not check out" &&
        grep -qxF "verify --certificate-identity https://github.com/mqusaeri/mscd/.github/workflows/release.yml@refs/tags/v$V2 --certificate-oidc-issuer https://token.actions.githubusercontent.com $REGISTRY/mscd-server@${SERVER_DIGEST[$V2]}" \
            "$WORK/home/cosign-args.txt"; then
        ok "Without --no-verify-signature the deploy runs cosign verify with the identity of release.yml for the tag, and stops when it fails"
    else
        bad "The cosign check did not run or did not stop the deploy (exit code $RC)"
        show_log cosign
    fi
    expect_version "$V2" "After the refusals"
    expect_digests "$V2"
}

check_rc3() {
    step "Broken $V3: web image as server image"
    deploy_run deploy-rc3 deploy "v$V3"
    if ((RC != 0)) && log_has deploy-rc3 "is not an MSCD release server image" && log_has deploy-rc3 "Nothing was changed"; then
        ok "$V3 is refused before anything changes"
    else
        bad "$V3 was not refused as expected (exit code $RC)"
        show_log deploy-rc3
    fi
    expect_version "$V2" "After $V3"
    expect_healthy "After $V3"
    if local_image_refs | grep -qF "$REGISTRY/mscd-server@${SERVER_DIGEST[$V3]}"; then
        bad "The refused image of $V3 is still on this host"
    else
        ok "The pulled images of the refused $V3 were removed"
    fi
}

check_rc4() {
    step "Broken $V4: a migration that fails"
    deploy_run deploy-rc4 deploy "v$V4"
    if ((RC != 0)) && log_has deploy-rc4 "The migrations of $V4 failed" && log_has deploy-rc4 "rolled back automatically" &&
        log_has deploy-rc4 "9999_rehearsal_fails"; then
        ok "$V4: migrate fails, the migrate log is printed, the deploy rolls back by itself"
    else
        bad "$V4 did not fail at migrate and roll back (exit code $RC)"
        show_log deploy-rc4 40
    fi
    expect_version "$V2" "After $V4"
    expect_digests "$V2"
    expect_healthy "After $V4"
}

check_rc5() {
    local id
    step "Broken $V5: services replaced, then the health check fails"
    deploy_run deploy-rc5 deploy "v$V5"
    if ((RC != 0)) && log_has deploy-rc5 "Migrations of $V5 applied" && log_has deploy-rc5 "web did not become healthy" &&
        log_has deploy-rc5 "rolled back automatically" && log_has deploy-rc5 "(health)" &&
        ! grep -qE '"(remote_ip|client_ip)":"[0-9]' "$(log_file deploy-rc5)"; then
        ok "$V5: migrate passes, the health check fails, the deploy rolls back by itself"
    else
        bad "$V5 did not roll back after the health check (exit code $RC)"
        show_log deploy-rc5 40
    fi
    expect_version "$V2" "After $V5"
    expect_digests "$V2"
    expect_healthy "After $V5"
    id=$(project_containers api | head -n 1)
    if [[ $(docker inspect --format '{{.Config.Image}}' "$id" 2>/dev/null) == "$REGISTRY/mscd-server@${SERVER_DIGEST[$V2]}" ]]; then
        ok "The api runs the server image of $V2 again"
    else
        bad "The api does not run the server image of $V2"
    fi
    if [[ $(kv_get "$INSTALL/state/previous.env" VERSION) == "$V1" ]]; then
        ok "The failed attempts left the rollback target $V1 in place"
    else
        bad "state/previous.env no longer names $V1"
    fi
}

check_images_kept() {
    local refs expected unexpected
    refs=$(local_image_refs | grep '@' || true)
    expected=$(printf '%s\n' "$REGISTRY/mscd-server@${SERVER_DIGEST[$V1]}" "$REGISTRY/mscd-server@${SERVER_DIGEST[$V2]}" \
        "$REGISTRY/mscd-web@${WEB_DIGEST[$V1]}" "$REGISTRY/mscd-web@${WEB_DIGEST[$V2]}" | sort -u)
    unexpected=$(comm -23 <(printf '%s\n' "$refs" | sort -u) <(printf '%s\n' "$expected"))
    if [[ -z $unexpected ]] && [[ -z $(comm -13 <(printf '%s\n' "$refs" | sort -u) <(printf '%s\n' "$expected")) ]]; then
        ok "Only the images of $V1 and $V2 stay on this host (the releases kept for rollback)"
    else
        bad "Images on this host differ from those of $V1 and $V2: ${unexpected:-missing ones}"
    fi
}

check_rollback() {
    step "Rollback to $V1"
    deploy_run rollback rollback "v$V1" --version "$V1"
    if ((RC == 0)) && log_has rollback "MSCD is back on $V1 and healthy"; then
        ok "Rollback from $V2 to $V1 finished"
    else
        bad "The rollback to $V1 failed (exit code $RC)"
        show_log rollback 40
    fi
    expect_version "$V1" "Rollback"
    expect_digests "$V1"
    expect_healthy "Rollback"
    if [[ ! -e $INSTALL/state/previous.env && $(state_value ACTION) == rollback ]]; then
        ok "The state records the rollback; no earlier release is left to roll back to"
    else
        bad "The state after the rollback is not as expected"
    fi
    deploy_run check-only check-only "v$V1"
    if ((RC == 0)) && log_has check-only "Every check passed"; then
        ok "check-only passes on the rolled back install"
    else
        bad "check-only failed after the rollback (exit code $RC)"
        show_log check-only
    fi
}

# ---------------------------------------------------------------------------
# --workflow: the SSH and copy steps of deploy-prod.yml against a test server
# ---------------------------------------------------------------------------

WF_NET=$PROJECT-wf-net
WF_SERVER=$PROJECT-wf-server
WF_RUNNER=$PROJECT-wf-runner

workflow_down() {
    docker rm -f "$WF_SERVER" "$WF_RUNNER" >/dev/null 2>&1 || true
    docker network rm "$WF_NET" >/dev/null 2>&1 || true
}

wf_server() { docker exec "$WF_SERVER" bash -c "$1"; }
wf_runner() { docker exec "$WF_RUNNER" bash -c "$1"; }

# wf_expect NAME COMMAND...: ok when COMMAND succeeds, otherwise its output.
wf_expect() {
    local name=$1
    shift
    if "$@" >"$WORK/wf.out" 2>&1; then
        ok "$name"
    else
        bad "$name"
        tail -n 30 "$WORK/wf.out" | sed 's/^/          /'
    fi
}

# wf_steps OUT KNOWN_HOSTS: the run scripts of deploy-prod.yml with test inputs, secrets
# and variables, one file per step.
wf_steps() {
    local out=$1 hosts=$2 key
    key=$(docker exec "$WF_RUNNER" cat /keys/deploy)
    rm -rf -- "$out"
    install -d -m 0700 "$out"
    (cd "$REPO_DIR" && node - "$REPO_DIR/.github/workflows/deploy-prod.yml" "$out" "$WF_SERVER" "$hosts" "$key") <<'EOF'
const fs = require('fs');
const yaml = require(require.resolve('yaml', { paths: [process.cwd()] }));
const [file, out, host, known, key] = process.argv.slice(2);
const wf = yaml.parse(fs.readFileSync(file, 'utf8'));
const inputs = { version: 'v1.1.0', action: 'deploy', target: 'staging', skip_backup: false };
const secrets = {
  DEPLOY_HOST: host, DEPLOY_USER: 'deploy', DEPLOY_SSH_KEY: key, DEPLOY_SSH_KNOWN_HOSTS: known,
  PLATFORM_KEY: 'workflow-test-platform-key', STORAGE_KEY: 'workflow-test-storage-key',
  AUDIT_ANCHOR_KEY: '-----BEGIN PRIVATE KEY-----\nworkflow-test\n-----END PRIVATE KEY-----\n',
  SMTP_PASSWORD: "smtp pass with spaces $and 'quotes'", SMTP_USER: 'mailer@mscd-wf.net',
  BACKUP_S3_ENDPOINT: 'https://s3.backup.mscd-wf.net', BACKUP_S3_BUCKET: 'bucket', BACKUP_S3_ACCESS_KEY: 'ak',
  BACKUP_S3_SECRET_KEY: 'sk', BACKUP_SECRETS_ACCESS_KEY: 'sak', BACKUP_SECRETS_SECRET_KEY: 'ssk',
  BACKUP_RESTIC_PASSWORD: 'restic', HEARTBEAT_BACKUP_URL: 'https://hc.mscd-wf.net/b',
  HEARTBEAT_WATCHDOG_URL: 'https://hc.mscd-wf.net/w', TELEGRAM_BOT_TOKEN: '', OPS_BASIC_AUTH_HASH: '$2a$14$abc',
};
const vars = {
  DEPLOY_SSH_PORT: '2222', SMTP_HOST: 'smtp.mscd-wf.net', SMTP_PORT: '587', MAIL_FROM: 'MSCD <no-reply@mscd-wf.net>',
  MSCD_DOMAIN: 'app.mscd-wf.net', MSCD_SITE_DOMAIN: '', ACME_EMAIL: 'ops@mscd-wf.net', ACME_CA: '',
  TELEGRAM_CHAT_ID: '', ALERT_EMAIL_TO: 'alerts@mscd-wf.net', OPS_DOMAIN: '', OPS_BASIC_AUTH_USER: '',
};
const context = { 'github.token': 'ghs_workflowtesttoken12', 'github.actor': 'owner-test', 'job.status': 'failure' };
const expr = (value) => String(value).replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, e) => {
  let m = /^inputs\.(\w+)$/.exec(e);
  if (m) return String(inputs[m[1]]);
  m = /^(secrets|vars|env)\.(\w+)$/.exec(e);
  if (m) return String({ secrets, vars, env: wf.env }[m[1]][m[2]] ?? '');
  if (e in context) return context[e];
  if (e === "inputs.skip_backup && 'true' || 'false'") return 'false';
  throw new Error(`unknown expression ${e}`);
});
const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
const head = Object.entries(wf.env).map(([k, v]) => `export ${k}=${q(String(v))}`).join('\n');
Object.values(wf.jobs)[0].steps.forEach((step, i) => {
  if (!step.run) return;
  const env = Object.entries(step.env || {}).map(([k, v]) => `export ${k}=${q(expr(v))}`).join('\n');
  const name = String(i).padStart(2, '0') + '-' + step.name.replace(/[^A-Za-z]+/g, '-').toLowerCase();
  fs.writeFileSync(`${out}/${name}.sh`,
    `${head}\n${env}\nif [ -f /work/env ]; then set -a; . /work/env; set +a; fi\ncd /repo\n${step.run}`);
});
EOF
}

# wf_run_step NUMBER: one step script in the runner container, as GitHub runs it (bash -e).
wf_run_step() {
    docker exec -e RUNNER_TEMP=/work/tmp -e GITHUB_ENV=/work/env -e GITHUB_STEP_SUMMARY=/work/summary.md \
        -e GITHUB_REPOSITORY=mqusaeri/mscd "$WF_RUNNER" bash -c "bash -e /work/steps/$1-*.sh"
}

# wf_new_run STEPS: a fresh work folder in the runner, with the digests.json of a release.
wf_new_run() {
    local server web
    server=sha256:$(printf '1%.0s' {1..64})
    web=sha256:$(printf '2%.0s' {1..64})
    docker exec "$WF_RUNNER" rm -rf /work
    docker exec "$WF_RUNNER" mkdir -p /work/tmp
    docker cp "$1" "$WF_RUNNER:/work/steps" >/dev/null
    wf_run_step 00 >/dev/null
    docker exec -i "$WF_RUNNER" bash -c 'install -d -m 0700 /work/tmp/mscd-deploy && cat >/work/tmp/mscd-deploy/digests.json' <<EOF
{"version": "1.1.0", "server": "$server", "web": "$web",
 "serverImage": "ghcr.io/mqusaeri/mscd-server", "webImage": "ghcr.io/mqusaeri/mscd-web",
 "serverRef": "ghcr.io/mqusaeri/mscd-server@$server", "webRef": "ghcr.io/mqusaeri/mscd-web@$web"}
EOF
}

# workflow_test: the steps "Open the SSH connection", "Copy the release to the server", "Deploy on
# the server", "Summary" and "Close the connection" of deploy-prod.yml, run in a runner container
# against a server container with sshd on port 2222, the deploy account (restrict key) and a stand-in
# docker command that answers the host checks, records the registry login and refuses the pull.
# The steps that need GitHub (checkout, release download, signature check on the runner, the check
# from outside) are left out; the rehearsal proves the server side.
workflow_test() {
    local image pinned_lines other_lines proxy=(-e http_proxy -e https_proxy -e HTTP_PROXY -e HTTPS_PROXY -e no_proxy -e NO_PROXY)
    image=$(<"$REPO_DIR/deploy/host/test/ubuntu-image")
    title "deploy-prod.yml against a test server (project $PROJECT)"
    [[ $EUID -eq 0 ]] || die "Run the workflow test as root, like the rehearsal"
    for tool in docker node; do command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"; done
    workflow_down
    install -d -m 0755 "$WORK"
    trap 'workflow_down; rm -rf -- "$WORK"' EXIT

    step "Test runner and server ($image)"
    docker network create "$WF_NET" >/dev/null
    docker run -d --name "$WF_SERVER" --network "$WF_NET" "${proxy[@]}" --tmpfs /dockerdata:size=20g \
        "$image" sleep 3600 >/dev/null
    docker run -d --name "$WF_RUNNER" --network "$WF_NET" "${proxy[@]}" -v "$REPO_DIR:/repo:ro" \
        "$image" sleep 3600 >/dev/null
    wf_expect "Server: openssh-server, rsync, openssl and curl from the Ubuntu archive; the deploy account" wf_server '
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -q >/dev/null && apt-get install -y -q openssh-server rsync openssl curl >/dev/null &&
        groupadd docker && useradd --create-home --shell /bin/bash --groups docker deploy && passwd -l deploy >/dev/null &&
        install -d -m 0755 -o deploy -g deploy /opt/mscd /opt/mscd/releases /opt/mscd/state /opt/mscd/logs &&
        install -d -m 0700 -o deploy -g deploy /opt/mscd/secrets /opt/mscd/backup &&
        install -d -m 0755 /run/sshd &&
        printf "Port 2222\nPasswordAuthentication no\nPermitRootLogin no\nAllowUsers deploy\nLogLevel VERBOSE\n" \
            >/etc/ssh/sshd_config.d/10-test.conf'
    wf_expect "Runner: openssh-client, rsync and jq; the deploy key" wf_runner '
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -q >/dev/null && apt-get install -y -q openssh-client rsync jq >/dev/null &&
        mkdir -p /keys && ssh-keygen -q -t ed25519 -N "" -C deploy-test -f /keys/deploy &&
        printf "#!/bin/sh\necho \"\$@\" >>/tmp/cosign-calls.txt\n" >/usr/local/bin/cosign && chmod 0755 /usr/local/bin/cosign'
    docker exec -i "$WF_SERVER" bash -c 'cat >/usr/local/bin/docker && chmod 0755 /usr/local/bin/docker' <<'EOF'
#!/bin/bash
# Stand-in docker of the workflow test: answers the host checks, records the registry login,
# refuses the image pull (there is no registry in this test).
printf '%s\n' "$*" >>/tmp/docker-calls.txt
case "$1 $2" in
    "version --format") echo 29.0.0 ;;
    "compose version") echo 5.0.0 ;;
    "info --format") echo /dockerdata ;;
    "login ghcr.io") token=$(cat); printf 'login %s %s\n' "$4" "${#token}" >>/tmp/docker-login.txt ;;
    "logout ghcr.io") echo logout >>/tmp/docker-login.txt ;;
    "pull --quiet") echo "denied: no registry in this test" >&2; exit 1 ;;
    "ps -aq") ;;
    compose*) for a in "$@"; do [[ $a == config ]] && exit 0; done; exit 1 ;;
    *) exit 1 ;;
esac
EOF
    docker exec "$WF_RUNNER" cat /keys/deploy.pub | docker exec -i "$WF_SERVER" bash -c '
        install -d -m 0700 -o deploy -g deploy ~deploy/.ssh && { printf "restrict "; cat; } >~deploy/.ssh/authorized_keys &&
        chown deploy:deploy ~deploy/.ssh/authorized_keys && chmod 0600 ~deploy/.ssh/authorized_keys'
    wf_expect "Server: sshd on port 2222, deploy key with restrict" wf_server '/usr/sbin/sshd -E /var/log/sshd.log && sleep 1 && test -s /run/sshd.pid'
    # The lines of DEPLOY_SSH_KNOWN_HOSTS as bootstrap-prod.yml prints them: hashed, for port 22.
    pinned_lines=$(docker exec "$WF_RUNNER" bash -c "printf '%s %s\n' '$WF_SERVER' \"\$1\" >/tmp/kh && ssh-keygen -H -f /tmp/kh >/dev/null 2>&1 && grep -v '^#' /tmp/kh" \
        _ "$(wf_server 'cut -d" " -f1,2 /etc/ssh/ssh_host_ed25519_key.pub')")
    other_lines=$(docker exec "$WF_RUNNER" bash -c "ssh-keygen -q -t ed25519 -N '' -f /tmp/other && printf '%s %s\n' '$WF_SERVER' \"\$(cut -d' ' -f1,2 /tmp/other.pub)\" >/tmp/kh2 && ssh-keygen -H -f /tmp/kh2 >/dev/null 2>&1 && grep -v '^#' /tmp/kh2")

    step "Another host key"
    wf_steps "$WORK/steps-wrong" "$other_lines"
    wf_new_run "$WORK/steps-wrong"
    if wf_run_step 06 >"$WORK/wf.out" 2>&1; then
        bad "A server with another host key was accepted"
    elif grep -q 'Host key verification failed' "$WORK/wf.out"; then
        ok "A server with another host key is refused before any login (port 2222, port-22 lines through HostKeyAlias)"
    else
        bad "The run with another host key stopped for another reason"
        tail -n 20 "$WORK/wf.out" | sed 's/^/          /'
    fi

    step "Run with the pinned host key"
    wf_steps "$WORK/steps" "$pinned_lines"
    wf_new_run "$WORK/steps"
    wf_expect "Open the SSH connection: port 2222 with the port-22 known_hosts lines (HostKeyAlias)" wf_run_step 06
    wf_expect "Copy the release to the server: rsync over the same connection" wf_run_step 07
    if wf_run_step 08 >"$WORK/wf-deploy.out" 2>&1; then
        bad "Deploy on the server should stop at the image pull of the stand-in docker"
    else
        ok "Deploy on the server reaches saas-deploy.sh, which stops at the image pull as expected"
    fi
    if grep -q '26 values read (not shown)' "$WORK/wf-deploy.out" &&
        grep -q 'Signature of ghcr.io/mqusaeri/mscd-server made by release.yml for v1.1.0' "$WORK/wf-deploy.out" &&
        grep -q 'docker pull ghcr.io/mqusaeri/mscd-server@sha256:1111' "$WORK/wf-deploy.out"; then
        ok "saas-deploy.sh read 26 values on standard input, ran the copied cosign and pulled by digest"
    else
        bad "saas-deploy.sh did not get the values, run cosign or pull by digest"
        tail -n 30 "$WORK/wf-deploy.out" | sed 's/^/          /'
    fi
    if grep -q 'smtp pass\|workflowtesttoken\|workflow-test-platform\|BEGIN PRIVATE' "$WORK/wf-deploy.out"; then
        bad "A secret value reached the output of the deploy step"
    else
        ok "No secret value in the output of the deploy step"
    fi
    wf_expect "The registry login got the job token on standard input, then the server logged out" wf_server \
        'grep -qx "login owner-test 23" /tmp/docker-login.txt && tail -n 1 /tmp/docker-login.txt | grep -qx logout && ! grep -q "workflowtesttoken\|smtp pass" /tmp/docker-calls.txt'
    wf_expect "The release folder holds digests.json, the deploy files and the site, and no demo files" wf_server '
        r=/opt/mscd/releases/v1.1.0; test -f $r/digests.json && test -f $r/deploy/scripts/saas-deploy.sh &&
        test -f $r/deploy/compose/docker-compose.saas.yml && test -f $r/deploy/compose/config/caddy/Caddyfile &&
        test -f $r/site/index.html && test ! -e $r/deploy/compose/config/demo-secrets &&
        test ! -e $r/deploy/compose/docker-compose.demo.yml && test ! -e $r/deploy/compose/dev &&
        test "$(stat -c %U $r/deploy)" = deploy && test -x /opt/mscd/bin/cosign'
    wf_expect "One SSH login for the whole run (ControlMaster), no terminal" wf_server \
        'test "$(grep -c "Accepted publickey for deploy" /var/log/sshd.log)" = 1 && ! grep -qi "pty allocation" /var/log/sshd.log'
    wf_expect "Summary" wf_run_step 10
    wf_expect "Close the connection and remove the key" wf_run_step 11
    wf_expect "The key and the work folder are gone from the runner" wf_runner 'test ! -e /work/tmp/mscd-ssh && test ! -e /work/tmp/mscd-deploy'

    step "Clean-up"
    workflow_down
    if docker container inspect "$WF_SERVER" >/dev/null 2>&1 || docker network inspect "$WF_NET" >/dev/null 2>&1; then
        bad "The test containers could not be removed"
    else
        pass "Test containers and network removed"
    fi
    if ((FAILURES > 0)); then
        printf '\n%s%d check(s) failed%s, %d passed.\n' "$C_RED" "$FAILURES" "$C_RESET" "$CHECKS"
        exit 1
    fi
    printf '\n%sEvery check passed (%d).%s\n' "$C_GREEN$C_BOLD" "$CHECKS" "$C_RESET"
}

# ---------------------------------------------------------------------------
# Set-up and clean-up
# ---------------------------------------------------------------------------

project_resources() {
    local filter="label=com.docker.compose.project=$PROJECT" count refs
    count=$(docker ps -aq --filter "$filter" | wc -l)
    ((count == 0)) || printf 'containers: %d\n' "$count"
    count=$(docker volume ls -q --filter "$filter" | wc -l)
    ((count == 0)) || printf 'volumes: %d\n' "$count"
    count=$(docker network ls -q --filter "$filter" | wc -l)
    ((count == 0)) || printf 'networks: %d\n' "$count"
    for name in "$REGISTRY_CONTAINER" "$MAILPIT_CONTAINER"; do
        if docker container inspect "$name" >/dev/null 2>&1; then printf 'container: %s\n' "$name"; fi
    done
    refs=$(local_image_refs | xargs)
    [[ -z $refs ]] || printf 'images: %s\n' "$refs"
    for name in "$INSTALL" "$WORK"; do
        if [[ -e $name ]]; then printf 'folder: %s\n' "$name"; fi
    done
}

down_quiet() {
    local id
    docker rm -f "$MAILPIT_CONTAINER" "$REGISTRY_CONTAINER" >/dev/null 2>&1 || true
    if [[ -f $INSTALL/.env && -d $INSTALL/deploy/compose ]]; then
        compose --profile cli down --volumes --remove-orphans --timeout 20 >/dev/null 2>&1 || true
    fi
    for id in $(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT"); do
        docker rm -f "$id" >/dev/null 2>&1 || true
    done
    for id in $(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT"); do
        docker volume rm "$id" >/dev/null 2>&1 || true
    done
    for id in $(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT"); do
        docker network rm "$id" >/dev/null 2>&1 || true
    done
    remove_local_images
    rm -rf -- "$INSTALL" "$WORK"
    for id in "$V1" "$V2"; do rm -rf -- "$REPO_DIR/deploy/dist/mscd-images-$id.logs"; done
}

down() {
    local left
    title "MSCD deploy rehearsal: down (project $PROJECT)"
    docker info >/dev/null 2>&1 || die "Cannot reach the Docker daemon"
    down_quiet
    left=$(project_resources)
    if [[ -n $left ]]; then
        printf '%s\n' "$left" | sed 's/^/        left: /'
        die "Some parts of $PROJECT could not be removed (listed above)"
    fi
    pass "Containers, networks, volumes, images and folders of $PROJECT removed"
}

finish() {
    local status=$?
    if [[ -n ${PROBE_PID:-} ]]; then kill "$PROBE_PID" 2>/dev/null || true; fi
    if [[ $KEEP == true ]]; then
        printf '\nKept for a look (MSCD_REHEARSAL_KEEP=true): %s, %s. Remove with: %s --down\n' "$INSTALL" "$WORK" "$0"
        return
    fi
    step "Clean-up"
    if [[ -d $WORK/logs ]]; then
        # The deploy logs survive the clean-up; they hold no secret value.
        rm -rf -- "$INSTALL-logs"
        cp -R -- "$WORK/logs" "$INSTALL-logs" 2>/dev/null || true
    fi
    down_quiet
    if [[ -n $(project_resources) ]]; then
        project_resources | sed 's/^/        left: /'
        fail "Some parts of $PROJECT could not be removed"
        status=1
    else
        pass "Everything of $PROJECT removed (the deploy logs are kept in $INSTALL-logs)"
    fi
    exit "$status"
}

setup() {
    local octets tool
    step "Clean start"
    [[ $EUID -eq 0 ]] || die "Run the rehearsal as root: it runs saas-deploy.sh as a user of the docker group (setpriv) and reads the secret files to check them"
    for tool in docker node openssl curl setpriv base64 cmp; do
        command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"
    done
    docker info >/dev/null 2>&1 || die "Cannot reach the Docker daemon"
    if [[ -n $(project_resources) ]]; then
        info "Removing what an earlier run of $PROJECT left behind"
        down_quiet
    fi
    # shellcheck disable=SC2034  # read by check_port of lib/common.sh
    DOCKER_OK=true
    check_port "$HTTP_PORT" "Caddy HTTP" MSCD_REHEARSAL_HTTP_PORT
    check_port "$HTTPS_PORT" "Caddy HTTPS" MSCD_REHEARSAL_HTTPS_PORT
    check_port "$REGISTRY_PORT" "local registry" MSCD_REHEARSAL_REGISTRY_PORT
    abort_if_failed
    DOCKER_GID=$(stat -c '%g' /var/run/docker.sock)
    octets=$(free_subnets) || die "No two free 172.31.x.0/24 ranges for the networks of the stack"
    read -r SUBNET_MSCD SUBNET_EDGE <<<"$octets"
    pass "Networks: mscd 172.31.$SUBNET_MSCD.0/24, edge 172.31.$SUBNET_EDGE.0/24"
    install -d -m 0755 -o "$RUN_UID" -g "$RUN_UID" "$INSTALL" "$INSTALL/releases"
    install -d -m 0755 "$WORK" "$WORK/logs"
    install -d -m 0700 -o "$RUN_UID" -g "$RUN_UID" "$WORK/home"
    pass "Install folder $INSTALL (owner $RUN_UID, like /opt/mscd of the deploy account); work folder $WORK"
    SMTP_SECRET=$(random_hex 16)

    step "Throwaway release keys (saas-keys.sh)"
    bash "$REPO_DIR/deploy/scripts/saas-keys.sh" --out "$WORK/keys" --print-only >"$WORK/keys.log" 2>&1 ||
        { tail -n 20 "$WORK/keys.log"; die "saas-keys.sh failed"; }
    ok "Key set in $WORK/keys (deleted at the end)"
}

main() {
    case "${1:-}" in
        '') ;;
        --down) valid_settings; workflow_down; down; exit 0 ;;
        --workflow) valid_settings; WORK=$(mktemp -d); workflow_test; exit 0 ;;
        -h | --help) usage; exit 0 ;;
        *) usage >&2; exit 2 ;;
    esac
    valid_settings
    title "MSCD deploy rehearsal (project $PROJECT, install $INSTALL, overlays $OVERLAYS)"
    trap finish EXIT
    setup
    start_registry
    build_and_push

    step "Release folders"
    for v in "$V1" "$V2" "$V3" "$V4" "$V5"; do stage_release "v$v" "$v"; done
    ok "Release folders in $INSTALL/releases, copied as deploy-prod.yml does ($(saas_compose_list "$INSTALL/releases/v$V1/deploy/compose" | paste -sd ' ' -))"
    write_input "$WORK/input"

    step "First deploy of $V1"
    deploy_run deploy-rc1 deploy "v$V1"
    check_first_deploy || exit 1
    check_mail
    check_anchor
    check_wrong_key
    check_upgrade || exit 1
    check_refusals
    check_rc3
    check_rc4
    check_rc5
    check_images_kept
    check_rollback

    if ((FAILURES > 0)); then
        printf '\n%s%d check(s) failed%s, %d passed.\n' "$C_RED" "$FAILURES" "$C_RESET" "$CHECKS"
        exit 1
    fi
    printf '\n%sEvery check passed (%d).%s\n' "$C_GREEN$C_BOLD" "$CHECKS" "$C_RESET"
}

main "$@"
