#!/usr/bin/env bash
# MSCD SaaS: a local test stack of the SaaS Compose files (Milestone 2 plan K, M2-S02).
#
#   deploy/scripts/test/saas-stack.sh up      build release images, configure and start the stack
#   deploy/scripts/test/saas-stack.sh check   check the SaaS settings on the running stack
#   deploy/scripts/test/saas-stack.sh down    remove the stack, its volumes, images and files
#
# The stack publishes 127.0.0.1:18080 and 127.0.0.1:18443 like every other Compose test
# stack of this repository, so run the three steps under the host lock (R-05):
#
#   flock /tmp/mscd-stack.lock bash -c 'bash deploy/scripts/test/saas-stack.sh up &&
#     bash deploy/scripts/test/saas-stack.sh check; s=$?; bash deploy/scripts/test/saas-stack.sh down; exit $s'
#
# up:
#   1. Makes a throwaway release key set with saas-keys.sh in the state folder (S-2).
#   2. Builds the release images with those keys (build-release-images.sh --load, M2-S01) as
#      localhost/<project>/mscd-server and localhost/<project>/mscd-web.
#   3. Fills the secrets folder: platform.key, storage.key and the audit anchor key of the
#      key set's production folder, plus database passwords, gateway token, S3 identity and
#      internal certificates (the generators of install.sh, lib/common.sh).
#   4. Writes .env from deploy/compose/.env.saas.example with MSCD_TLS_MODE=internal,
#      MSCD_DOMAIN=localhost, the image digests and the marketing site on site.localhost,
#      and a test overlay that adds Mailpit as the mail relay (no published port) and
#      binds Caddy's ports to 127.0.0.1.
#   5. Starts the stack (migrate runs first) and copies Caddy's local root certificate to
#      <state folder>/caddy-root.crt.
#
# check asserts:
#   - tenancy mode multi (and the release flavour) through the cli service;
#   - only Caddy publishes ports;
#   - HSTS on HTTPS, /healthz through Caddy's certificate, 308 from HTTP to HTTPS;
#   - the NGINX rate limit answers 429 with a problem body;
#   - after the audit anchor job ran, the worker log has no line "not among the anchor
#     keys compiled into this build" and holds a signed anchor, which proves that the
#     deployed anchor key matches the key compiled into the image;
#   and also the client address and log redaction through Caddy, the security headers of
#   the app page, the public system profile and the marketing site.
#
# Settings (environment):
#   MSCD_SAAS_TEST_PROJECT      Compose project, also the image path (default mscd-saas-test)
#   MSCD_SAAS_TEST_DIR          state folder: keys, secrets, .env, logs, caddy-root.crt
#                               (default /tmp/mscd-saas-test)
#   MSCD_SAAS_TEST_HTTP_PORT    published HTTP port of Caddy (default 18080)
#   MSCD_SAAS_TEST_HTTPS_PORT   published HTTPS port of Caddy (default 18443)
#   MSCD_SAAS_TEST_KEEP_IMAGES  true: down keeps the two built images (default false)
#   MSCD_SAAS_TEST_SCAN         gate (default): build-release-images.sh and its Trivy gate.
#                               auto: for build machines that cannot reach the Alpine mirrors;
#                               the scan only reports when the Alpine updates could not be
#                               applied (see build_images)
#   MSCD_BUILD_CA               CA certificate of a TLS-inspecting proxy for the image builds
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$SCRIPT_DIR/../../.." && pwd)
COMPOSE_DIR=$REPO_DIR/deploy/compose

PROJECT=${MSCD_SAAS_TEST_PROJECT:-mscd-saas-test}
STATE=${MSCD_SAAS_TEST_DIR:-/tmp/mscd-saas-test}
HTTP_PORT=${MSCD_SAAS_TEST_HTTP_PORT:-18080}
HTTPS_PORT=${MSCD_SAAS_TEST_HTTPS_PORT:-18443}
KEEP_IMAGES=${MSCD_SAAS_TEST_KEEP_IMAGES:-false}

# lib/common.sh reads the project name once, when it is sourced.
export COMPOSE_PROJECT_NAME=$PROJECT
# shellcheck source=../lib/common.sh
. "$REPO_DIR/deploy/scripts/lib/common.sh"

readonly APP_HOST=localhost
readonly SITE_HOST=site.localhost
readonly MAILPIT_IMAGE=axllent/mailpit:v1.31.3
readonly ANCHOR_MISMATCH='not among the anchor keys compiled into this build'

usage() {
    sed -n '2,/^set -euo pipefail$/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

compose() {
    docker compose --project-name "$PROJECT" --project-directory "$COMPOSE_DIR" \
        -f "$COMPOSE_DIR/docker-compose.yml" -f "$COMPOSE_DIR/docker-compose.saas.yml" \
        -f "$STATE/compose.test.yml" --env-file "$STATE/.env" "$@"
}

# curl_local ARGS...: curl to this host, never through HTTPS_PROXY.
curl_local() {
    curl --noproxy '*' --silent --show-error --max-time 15 "$@"
}

# https ARGS...: curl over HTTPS with Caddy's local root certificate.
https() {
    curl_local --cacert "$STATE/caddy-root.crt" "$@"
}

# header NAME < HEADERS: value of the first header NAME (any case), without CR.
header() {
    awk -v n="$(printf '%s' "$1" | tr 'A-Z' 'a-z')" 'BEGIN { FS = ": " }
        { name = tolower($1); sub(/\r$/, "") }
        name == n { sub(/^[^:]*: /, ""); print; exit }'
}

# env_value KEY: the value of KEY in the stack's .env.
env_value() {
    kv_get "$STATE/.env" "$1"
}

state_ready() {
    [[ -f $STATE/.env && -f $STATE/compose.test.yml ]]
}

valid_settings() {
    [[ $PROJECT =~ ^[a-z0-9][a-z0-9_-]{0,40}$ ]] ||
        die "MSCD_SAAS_TEST_PROJECT must be lower-case letters, digits, '-' or '_' (at most 41), got '$PROJECT'"
    valid_port "$HTTP_PORT" || die "MSCD_SAAS_TEST_HTTP_PORT must be a port number, got '$HTTP_PORT'"
    valid_port "$HTTPS_PORT" || die "MSCD_SAAS_TEST_HTTPS_PORT must be a port number, got '$HTTPS_PORT'"
    [[ $HTTP_PORT != "$HTTPS_PORT" ]] || die "The HTTP and HTTPS ports must differ"
    case "$STATE" in
        /tmp/?* | /var/tmp/?* | "${TMPDIR:-/nonexistent}"/?*) ;;
        *) die "MSCD_SAAS_TEST_DIR must be a folder under /tmp or \$TMPDIR (down deletes it), got '$STATE'" ;;
    esac
    [[ $STATE != *[[:space:]]* ]] || die "MSCD_SAAS_TEST_DIR must not contain spaces"
}

# free_subnets: prints "<mscd octet> <edge octet>": two 172.31.x.0/24 ranges that no
# Docker network outside this project uses (172.31.250 and 172.31.251 when free).
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

# wait_for SECONDS COMMAND...: runs COMMAND every 2 seconds until it succeeds.
wait_for() {
    local timeout=$1 start=$SECONDS
    shift
    until "$@" >/dev/null 2>&1; do
        ((SECONDS - start < timeout)) || return 1
        sleep 2
    done
}

https_ok() {
    [[ $(https -o /dev/null -w '%{http_code}' "https://$APP_HOST:$HTTPS_PORT/healthz" 2>/dev/null) == 200 ]]
}

# ---------------------------------------------------------------------------
# up
# ---------------------------------------------------------------------------

write_test_overlay() {
    cat >"$STATE/compose.test.yml" <<EOF
# Test additions of deploy/scripts/test/saas-stack.sh (not for a server): Caddy on
# 127.0.0.1 only, and Mailpit as the SMTP relay on the internal network, no port.
services:
  caddy:
    ports: !override
      - "127.0.0.1:\${MSCD_HTTP_PORT}:80/tcp"
      - "127.0.0.1:\${MSCD_HTTPS_PORT}:443/tcp"
      - "127.0.0.1:\${MSCD_HTTPS_PORT}:443/udp"

  mailpit:
    image: $MAILPIT_IMAGE
    pull_policy: missing
    restart: unless-stopped
    environment:
      MP_SMTP_AUTH_ACCEPT_ANY: "true"
      MP_SMTP_AUTH_ALLOW_INSECURE: "true"
    security_opt:
      - no-new-privileges:true
    networks:
      - mscd
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8025/livez"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 30s
      start_interval: 1s
    logging:
      driver: local
      options:
        max-size: "20m"
        max-file: "10"
EOF
}

# write_env MSCD_OCTET EDGE_OCTET VERSION
write_env() {
    local mscd=$1 edge=$2 env=$STATE/.env ipv6=false
    install -m 0600 "$COMPOSE_DIR/.env.saas.example" "$env"
    if [[ -e /proc/net/if_inet6 ]]; then ipv6=true; fi
    env_set "$env" MSCD_SERVER_IMAGE "$(json_field serverImage)"
    env_set "$env" MSCD_SERVER_DIGEST "$(json_field server)"
    env_set "$env" MSCD_IMAGE "$(json_field webImage)"
    env_set "$env" MSCD_WEB_DIGEST "$(json_field web)"
    env_set "$env" MSCD_DOMAIN "$APP_HOST"
    env_set "$env" MSCD_PUBLIC_URL "https://$APP_HOST:$HTTPS_PORT"
    env_set "$env" MSCD_SITE_DOMAIN "$SITE_HOST"
    env_set "$env" MSCD_SITE_DIR "$STATE/site"
    env_set "$env" MSCD_TLS_MODE internal
    env_set "$env" ACME_EMAIL ""
    env_set "$env" MSCD_MAIL_FROM "MSCD SaaS test <mscd@saas-test.invalid>"
    env_set "$env" MSCD_SMTP_HOST mailpit
    env_set "$env" MSCD_SMTP_PORT 1025
    env_set "$env" MSCD_SMTP_SECURE false
    env_set "$env" MSCD_SMTP_USER ""
    env_set "$env" MSCD_SMTP_PASSWORD_FILE ""
    env_set "$env" MSCD_SECRETS_DIR "$STATE/secrets"
    env_set "$env" MSCD_SUBNET "172.31.$mscd.0/24"
    env_set "$env" MSCD_WEB_ADDRESS "172.31.$mscd.10"
    env_set "$env" MSCD_EDGE_SUBNET "172.31.$edge.0/24"
    env_set "$env" MSCD_CADDY_ADDRESS "172.31.$edge.2"
    env_set "$env" MSCD_WEB_EDGE_ADDRESS "172.31.$edge.3"
    env_set "$env" MSCD_EDGE_IPV6 "$ipv6"
    env_set "$env" MSCD_HTTP_PORT "$HTTP_PORT"
    env_set "$env" MSCD_HTTPS_PORT "$HTTPS_PORT"
}

# json_field NAME: a string field of digests.json.
json_field() {
    node -e 'const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const v = d[process.argv[2]];
        if (typeof v !== "string" || v === "") process.exit(1); process.stdout.write(v);' "$STATE/digests.json" "$1"
}

package_version() {
    node -p 'require(process.argv[1]).version' "$REPO_DIR/apps/server/package.json"
}

copy_site() {
    rm -rf -- "$STATE/site"
    install -d -m 0755 "$STATE/site"
    cp -R -- "$REPO_DIR/apps/site/index.html" "$REPO_DIR/apps/site/id" "$REPO_DIR/apps/site/assets" "$STATE/site/"
    chmod -R a+rX "$STATE/site"
}

make_secrets() {
    local dir=$STATE/secrets name
    install -d -m 0700 "$dir"
    for name in platform.key storage.key audit-anchor.key audit-anchor.pub; do
        install -m 0600 "$STATE/keys/production/$name" "$dir/$name"
    done
    # The rest as install.sh makes them; the files copied above are kept.
    DOCKER_OK=true
    ensure_secrets "$dir" "$(env_value MSCD_SERVER_IMAGE)@$(env_value MSCD_SERVER_DIGEST)" ||
        die "The secrets could not be created in $dir"
}

copy_root_certificate() {
    local target=$STATE/caddy-root.crt
    compose cp caddy:/data/caddy/pki/authorities/local/root.crt "$target" >/dev/null 2>&1 &&
        openssl x509 -in "$target" -noout >/dev/null 2>&1
}

up() {
    local version octets mscd edge
    title "MSCD SaaS test stack: up (project $PROJECT, state $STATE)"
    command -v docker >/dev/null 2>&1 || die "docker is not installed"
    docker info >/dev/null 2>&1 || die "Cannot reach the Docker daemon"
    for tool in node openssl curl; do command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"; done

    step "Clean start"
    if [[ -n $(project_containers) ]] || [[ -e $STATE ]]; then
        info "Removing what an earlier run of $PROJECT left behind"
        down_quiet
    fi
    DOCKER_OK=true
    check_port "$HTTP_PORT" "Caddy HTTP" MSCD_SAAS_TEST_HTTP_PORT
    check_port "$HTTPS_PORT" "Caddy HTTPS" MSCD_SAAS_TEST_HTTPS_PORT
    abort_if_failed
    octets=$(free_subnets) || die "No two free 172.31.x.0/24 ranges for the networks of the stack"
    read -r mscd edge <<<"$octets"
    pass "Networks: mscd 172.31.$mscd.0/24, edge 172.31.$edge.0/24"
    (umask 077 && mkdir -p -- "$STATE")
    chmod 0711 "$STATE"

    step "Throwaway release keys (saas-keys.sh)"
    bash "$REPO_DIR/deploy/scripts/saas-keys.sh" --out "$STATE/keys" --print-only >"$STATE/keys.log" 2>&1 ||
        { tail -n 20 "$STATE/keys.log" | sed 's/^/        /'; die "saas-keys.sh failed (log: $STATE/keys.log)"; }
    pass "Key set in $STATE/keys (deleted by down)"

    version=$(package_version)
    build_images "$version"
    pass "Server $(json_field serverRef)"
    pass "Web $(json_field webRef)"

    step "Configuration"
    write_test_overlay
    write_env "$mscd" "$edge"
    pass ".env written from .env.saas.example (TLS internal, domain $APP_HOST, site $SITE_HOST)"
    make_secrets
    copy_site
    pass "Marketing site copied to $STATE/site"
    compose config -q || die "docker compose config failed"
    pass "Compose configuration is valid"

    step "Starting the stack"
    if ! compose up -d --wait --wait-timeout 600 >"$STATE/up.log" 2>&1; then
        tail -n 20 "$STATE/up.log" | sed 's/^/        /'
        show_unhealthy_logs 40
        die "The stack did not start (log: $STATE/up.log). Remove it with: $0 down"
    fi
    local code
    code=$(docker inspect --format '{{.State.ExitCode}}' "$(project_containers migrate | head -n 1)" 2>/dev/null || echo missing)
    [[ $code == 0 ]] || die "migrate did not finish with exit code 0 (got $code)"
    pass "migrate finished, every service is healthy"

    wait_for 60 copy_root_certificate || die "Caddy's local root certificate did not appear in the caddy_data volume"
    pass "Caddy's local root certificate copied to $STATE/caddy-root.crt"
    wait_for 60 https_ok || die "https://$APP_HOST:$HTTPS_PORT/healthz did not answer 200 through Caddy"
    pass "https://$APP_HOST:$HTTPS_PORT/healthz answers 200"

    printf '\n%sSaaS test stack is up.%s App https://%s:%s/ (curl --cacert %s/caddy-root.crt), site https://%s:%s/.\n' \
        "$C_GREEN$C_BOLD" "$C_RESET" "$APP_HOST" "$HTTPS_PORT" "$STATE" "$SITE_HOST" "$HTTPS_PORT"
    printf 'Next: %s check, then %s down.\n' "$0" "$0"
}

# build_images VERSION: the release images, built with the throwaway key set, and
# <state>/digests.json. MSCD_SAAS_TEST_SCAN=gate (default) runs build-release-images.sh
# --load, whose Trivy gate refuses an image with a HIGH or CRITICAL vulnerability that has
# a fix. MSCD_SAAS_TEST_SCAN=auto is for build machines that cannot reach the Alpine
# mirrors: the same build through build-bundle.sh --images-only, where the scan stays a gate
# when the Alpine updates were applied and only reports when they could not be. These test
# images are never pushed.
build_images() {
    local version=$1 scan=${MSCD_SAAS_TEST_SCAN:-gate} server web
    local server_image=localhost/$PROJECT/mscd-server web_image=localhost/$PROJECT/mscd-web
    local -a build
    case "$scan" in
        gate)
            step "Release images (build-release-images.sh --load)"
            build=(bash "$REPO_DIR/deploy/scripts/build-release-images.sh" --version "$version"
                --trusted-keys-dir "$STATE/keys/trusted" --pack-signing-key "$STATE/keys/pack-signing.key"
                --registry "localhost/$PROJECT" --load --digest-file "$STATE/digests.json")
            ;;
        auto)
            step "Release images (build-bundle.sh --images-only --scan auto)"
            warn "MSCD_SAAS_TEST_SCAN=auto: the vulnerability scan only reports when the Alpine updates cannot be applied"
            build=(bash "$REPO_DIR/deploy/scripts/build-bundle.sh" --images-only --version "$version"
                --trusted-keys-dir "$STATE/keys/trusted" --pack-signing-key "$STATE/keys/pack-signing.key"
                --server-image "$server_image" --web-image "$web_image" --os-updates auto --scan auto --pull)
            if docker info --format '{{json .DriverStatus}}' 2>/dev/null | grep -q 'io.containerd.snapshotter.v1'; then
                build+=(--attest)
            fi
            ;;
        *) die "MSCD_SAAS_TEST_SCAN must be gate or auto, got '$scan'" ;;
    esac
    if [[ -n ${MSCD_BUILD_CA:-} ]]; then build+=(--build-ca "$MSCD_BUILD_CA"); fi
    info "Building version $version as $server_image and $web_image (log: $STATE/build.log)"
    if ! "${build[@]}" >"$STATE/build.log" 2>&1; then
        grep -E 'FAIL|ERROR|WARN' "$STATE/build.log" | tail -n 20 | sed 's/^/        /' || true
        save_build_logs "$version"
        if grep -q 'did not pass the release gate' "$STATE/build.log"; then
            detail "On a build machine without access to the Alpine mirrors, run again with MSCD_SAAS_TEST_SCAN=auto."
        fi
        die "The image build failed (log: $STATE/build.log, scan report: $STATE/build-logs/SECURITY-SCAN.txt)"
    fi
    save_build_logs "$version"
    if [[ $scan == auto ]]; then
        if grep -q 'scan only reports' "$STATE/build.log"; then
            warn "The Alpine updates were not applied; findings of the scan: $STATE/build-logs/SECURITY-SCAN.txt"
            grep -E '^  CVE-|^  GHSA-' "$STATE/build-logs/SECURITY-SCAN.txt" 2>/dev/null | sed 's/^/      /' || true
        fi
        [[ $(docker image inspect --format '{{index .Config.Labels "com.cyberlentera.mscd.flavor"}}' "$server_image:$version") == release ]] ||
            die "$server_image:$version is not a release build (label com.cyberlentera.mscd.flavor)"
        server=$(docker image inspect --format '{{.Id}}' "$server_image:$version")
        web=$(docker image inspect --format '{{.Id}}' "$web_image:$version")
        cat >"$STATE/digests.json" <<EOF
{
  "version": "$version",
  "pushed": false,
  "server": "$server",
  "web": "$web",
  "serverImage": "$server_image",
  "webImage": "$web_image",
  "serverRef": "$server_image@$server",
  "webRef": "$web_image@$web"
}
EOF
    fi
}

# save_build_logs VERSION: moves the image build logs of build-bundle.sh into the state folder.
save_build_logs() {
    local logs=$REPO_DIR/deploy/dist/mscd-images-$1.logs
    if [[ -d $logs ]]; then
        rm -rf -- "$STATE/build-logs"
        mv -- "$logs" "$STATE/build-logs" 2>/dev/null || true
    fi
}

# ---------------------------------------------------------------------------
# check
# ---------------------------------------------------------------------------

check_tenancy() {
    local out
    out=$(compose run --rm --no-deps -T --entrypoint node cli -e '
const { MscdConfig } = require("./apps/server/dist/config/mscd-config.js");
const c = MscdConfig.load({ runMode: "cli" });
process.stdout.write(`tenancy.mode=${c.profile.tenancy.mode} flavor=${c.flavor} profile=${c.profileFile}\n`);
' 2>&1) || true
    if [[ $out == *"tenancy.mode=multi"* ]]; then
        pass "Tenancy mode multi through the cli service ($(printf '%s' "$out" | grep -o 'tenancy.mode=.*' | head -n 1))"
    else
        fail "The cli service does not run with tenancy mode multi" "Output: $(printf '%s' "$out" | tail -n 3 | tr '\n' ' ')"
    fi
    if [[ $out == *"flavor=release"* ]]; then
        pass "The server image is a release build"
    else
        fail "The server image is not a release build"
    fi
}

check_ports() {
    local lines services
    lines=$(project_containers | xargs -r docker inspect --format \
        '{{index .Config.Labels "com.docker.compose.service"}} {{range $p, $b := .NetworkSettings.Ports}}{{if $b}}{{$p}} {{end}}{{end}}')
    services=$(awk 'NF > 1 { print $1 }' <<<"$lines" | sort -u | tr '\n' ' ')
    if [[ $services == "caddy " ]]; then
        pass "Only Caddy publishes ports ($(awk '$1 == "caddy" { $1 = ""; print }' <<<"$lines" | xargs))"
    else
        fail "Services with published ports: ${services:-none} (expected caddy only)"
    fi
    if awk '$1 == "caddy"' <<<"$lines" | grep -q '80/tcp' && awk '$1 == "caddy"' <<<"$lines" | grep -q '443/tcp' &&
        awk '$1 == "caddy"' <<<"$lines" | grep -q '443/udp'; then
        pass "Caddy publishes 80/tcp, 443/tcp and 443/udp"
    else
        fail "Caddy does not publish 80/tcp, 443/tcp and 443/udp"
    fi
}

check_tls() {
    local headers code location hsts
    code=$(https -o /dev/null -w '%{http_code}' "https://$APP_HOST:$HTTPS_PORT/healthz" || true)
    if [[ $code == 200 ]]; then
        pass "curl --cacert caddy-root.crt https://$APP_HOST:$HTTPS_PORT/healthz answers 200"
    else
        fail "https://$APP_HOST:$HTTPS_PORT/healthz answered ${code:-nothing}"
    fi
    headers=$(curl_local -o /dev/null -D - "http://$APP_HOST:$HTTP_PORT/" || true)
    code=$(head -n 1 <<<"$headers" | awk '{ print $2 }')
    location=$(header Location <<<"$headers")
    if [[ $code == 308 && $location == https://$APP_HOST* ]]; then
        pass "http://$APP_HOST:$HTTP_PORT/ answers 308 to $location"
    else
        fail "http://$APP_HOST:$HTTP_PORT/ answered ${code:-nothing} ${location:+to $location} (expected 308 to https)"
    fi
    headers=$(https -o "$STATE/page.html" -D - "https://$APP_HOST:$HTTPS_PORT/" || true)
    hsts=$(header Strict-Transport-Security <<<"$headers")
    if [[ $hsts == "max-age=31536000; includeSubDomains" ]]; then
        pass "HSTS on the app: $hsts"
    else
        fail "Strict-Transport-Security is '${hsts:-missing}' (expected max-age=31536000; includeSubDomains)"
    fi
    if [[ $(header Content-Security-Policy <<<"$headers") == *"frame-ancestors 'none'"* &&
        $(header X-Frame-Options <<<"$headers") == DENY && -z $(header Server <<<"$headers") ]]; then
        pass "App page: Content-Security-Policy with frame-ancestors 'none', X-Frame-Options DENY, no Server header"
    else
        fail "App page security headers are not as expected"
    fi
    if grep -q '<div id="root"\|<script' "$STATE/page.html" && ! grep -q 'fonts.googleapis.com' "$STATE/page.html"; then
        pass "App page served without external fonts"
    else
        fail "The app page is missing or loads fonts.googleapis.com"
    fi
}

check_rate_limit() {
    local probe urls=() i out count429 others
    probe="https://$APP_HOST:$HTTPS_PORT/api/v1/auth/mscd-rate-limit-probe"
    for ((i = 0; i < 80; i++)); do urls+=("$probe"); done
    out=$(https --parallel --parallel-immediate --parallel-max 80 -o /dev/null \
        -w '%{http_code} %header{retry-after} %header{content-type}\n' "${urls[@]}" 2>/dev/null || true)
    count429=$(grep -c '^429 1 application/problem+json' <<<"$out" || true)
    others=$(awk '$1 != 429 && $1 != 404 { print $1 }' <<<"$out" | sort | uniq -c | xargs)
    if ((count429 > 0)) && [[ -z $others ]]; then
        pass "Rate limit: $count429 of 80 requests at once to /api/v1/auth/ answered 429 (problem body, Retry-After 1)"
    else
        fail "Rate limit: no 429 among 80 requests at once to /api/v1/auth/ (${others:+other answers: $others})" \
            "Check MSCD_RATE_LIMITS and the web log"
    fi
    sleep 3
    out=$(https -o /dev/null -w '%{http_code}' "$probe" || true)
    if [[ $out == 404 ]]; then
        pass "After a pause the same address is served again (404 from the api for the probe path)"
    else
        fail "After a pause the probe path answered $out (expected 404 from the api)"
    fi
}

# check_client_address: Caddy replaces a client's X-Forwarded-For, NGINX logs the address
# Caddy saw (not Caddy's own), and neither log holds a query string value.
check_client_address() {
    local tag secret line client caddy_address
    tag=xff-probe-$(random_hex 6)
    secret=secret-$(random_hex 8)
    caddy_address=$(env_value MSCD_CADDY_ADDRESS)
    https -o /dev/null -H 'X-Forwarded-For: 203.0.113.99' "https://$APP_HOST:$HTTPS_PORT/$tag?token=$secret" || true
    curl_local -o /dev/null "http://$APP_HOST:$HTTP_PORT/$tag-plain?token=$secret" || true
    sleep 1
    line=$(compose logs --no-log-prefix web 2>/dev/null | grep "GET /$tag" | tail -n 1 || true)
    client=${line%% *}
    if [[ -n $client && $client != 203.0.113.99 && $client != "$caddy_address" ]]; then
        pass "NGINX logs the client address Caddy saw ($client), not the sent X-Forwarded-For and not Caddy ($caddy_address)"
    else
        fail "NGINX logged '${client:-no line}' for a request with X-Forwarded-For 203.0.113.99"
    fi
    if compose logs caddy web 2>/dev/null | grep -q "$secret"; then
        fail "A query string value reached the Caddy or NGINX log"
    elif compose logs --no-log-prefix caddy 2>/dev/null | grep -q "\"uri\":\"/$tag\""; then
        pass "Caddy logs JSON with the query string removed (also the Location of the 308)"
    else
        fail "No JSON access log line of Caddy for the probe request"
    fi
}

check_profile() {
    local body
    body=$(https "https://$APP_HOST:$HTTPS_PORT/api/v1/system/profile" || true)
    if [[ $body == *'"deploy":"saas"'* ]]; then
        pass "GET /api/v1/system/profile through Caddy: deploy saas"
    else
        fail "GET /api/v1/system/profile did not report deploy saas"
    fi
}

check_site() {
    local resolve=(--resolve "$SITE_HOST:$HTTPS_PORT:127.0.0.1") headers code
    headers=$(https "${resolve[@]}" -o "$STATE/site.html" -D - "https://$SITE_HOST:$HTTPS_PORT/" || true)
    code=$(head -n 1 <<<"$headers" | awk '{ print $2 }')
    if [[ $code == 200 ]] && grep -q '<title>' "$STATE/site.html" &&
        [[ $(header Strict-Transport-Security <<<"$headers") == max-age=31536000 ]] &&
        [[ $(header Content-Security-Policy <<<"$headers") == "default-src 'self';"* ]]; then
        pass "Marketing site on $SITE_HOST: 200, HSTS without includeSubDomains, its own Content-Security-Policy"
    else
        fail "The marketing site on $SITE_HOST answered ${code:-nothing} or lacks its headers"
    fi
    code=$(https "${resolve[@]}" -o /dev/null -w '%{http_code}' "https://$SITE_HOST:$HTTPS_PORT/check.mjs" || true)
    if [[ $code == 404 ]]; then
        pass "The tools of apps/site are not served (check.mjs answers 404)"
    else
        fail "https://$SITE_HOST:$HTTPS_PORT/check.mjs answered $code (expected 404)"
    fi
}

# check_anchor: a new organisation adds a row to the platform audit chain; the audit
# anchor job (audit.verify-chain) then signs the chain head with the deployed key.
check_anchor() {
    local slug request out since start
    slug=saascheck_$(date +%s)
    request=saas-stack-check-$(random_hex 6)
    since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    if out=$(compose run --rm --no-deps -T cli tenant create --slug "$slug" --name "SaaS stack check" 2>&1); then
        pass "cli tenant create: organisation $slug created (a new row in the platform audit chain)"
    else
        fail "cli tenant create failed" "$(printf '%s' "$out" | tail -n 3 | tr '\n' ' ')"
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
        fail "The audit anchor job could not be queued" "$(printf '%s' "$out" | tail -n 3 | tr '\n' ' ')"
        return 0
    fi
    pass "Audit anchor job audit.verify-chain ${out#queued } queued"
    start=$SECONDS
    until compose logs --since "$since" worker 2>/dev/null | grep -q 'audit.verify-chain done'; do
        if ((SECONDS - start > 90)); then
            fail "The worker did not finish audit.verify-chain within 90 seconds"
            return 0
        fi
        sleep 2
    done
    if compose logs worker 2>/dev/null | grep -q "$ANCHOR_MISMATCH"; then
        fail "The worker log says the anchor key is $ANCHOR_MISMATCH" \
            "The deployed audit-anchor.key does not belong to this image's key set"
    else
        pass "The worker log has no line \"$ANCHOR_MISMATCH\""
    fi
    if compose logs --since "$since" worker 2>/dev/null | grep -q '"event":"audit.anchor"'; then
        pass "The worker signed an anchor with the deployed key, which matches the key compiled into the image"
    else
        fail "The worker wrote no audit.anchor line, so the anchor key was not used" \
            "See: docker compose -p $PROJECT logs worker"
    fi
}

check() {
    title "MSCD SaaS test stack: check (project $PROJECT)"
    state_ready || die "No test stack configuration in $STATE. Run: $0 up"
    [[ -n $(project_containers caddy) ]] || die "The stack $PROJECT is not running. Run: $0 up"
    [[ -f $STATE/caddy-root.crt ]] || die "$STATE/caddy-root.crt is missing. Run: $0 up"

    step "Tenancy and image"
    check_tenancy
    step "Published ports"
    check_ports
    step "TLS, redirect and HSTS"
    check_tls
    step "Rate limit"
    check_rate_limit
    step "Client address and logs"
    check_client_address
    step "Public profile and marketing site"
    check_profile
    check_site
    step "Audit anchor key"
    check_anchor

    if ((FAILURES > 0)); then
        printf '\n%s%d check(s) failed.%s\n' "$C_RED" "$FAILURES" "$C_RESET"
        exit 1
    fi
    printf '\n%sEvery check passed.%s\n' "$C_GREEN$C_BOLD" "$C_RESET"
}

# ---------------------------------------------------------------------------
# down
# ---------------------------------------------------------------------------

# down_quiet: removes containers, networks and volumes of the project, the built images
# and the state folder. Works without the state folder (by the Compose labels).
down_quiet() {
    local server_ref='' web_ref='' id
    if [[ -f $STATE/digests.json ]]; then
        server_ref=$(node -p 'const d=require(process.argv[1]); `${d.serverImage}:${d.version}`' "$STATE/digests.json" 2>/dev/null || true)
        web_ref=$(node -p 'const d=require(process.argv[1]); `${d.webImage}:${d.version}`' "$STATE/digests.json" 2>/dev/null || true)
    fi
    if state_ready; then
        compose --profile cli down --volumes --remove-orphans --timeout 20 >/dev/null 2>&1 || true
    fi
    # Anything the Compose files did not cover (an interrupted up, a missing state folder).
    for id in $(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT"); do
        docker rm -f "$id" >/dev/null 2>&1 || true
    done
    for id in $(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT"); do
        docker volume rm "$id" >/dev/null 2>&1 || true
    done
    for id in $(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT"); do
        docker network rm "$id" >/dev/null 2>&1 || true
    done
    if [[ $KEEP_IMAGES != true ]]; then
        for id in $server_ref $web_ref; do
            [[ $id == localhost/"$PROJECT"/* ]] || continue
            docker image rm "$id" >/dev/null 2>&1 || true
        done
    fi
    if [[ -d $STATE ]]; then
        # The secrets belong to the container users; root of a helper container removes them
        # when this user cannot.
        rm -rf -- "$STATE" 2>/dev/null ||
            docker run --rm --network none -v "$(dirname -- "$STATE"):/w" --entrypoint sh "$MAILPIT_IMAGE" \
                -c 'rm -rf -- "/w/$1"' sh "$(basename -- "$STATE")" >/dev/null 2>&1 || true
    fi
}

down() {
    title "MSCD SaaS test stack: down (project $PROJECT)"
    down_quiet
    local left
    left=$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT" | wc -l)
    left=$((left + $(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT" | wc -l)))
    if ((left > 0)) || [[ -e $STATE ]]; then
        die "Some parts of $PROJECT could not be removed (containers, volumes or $STATE)"
    fi
    pass "Containers, networks, volumes, images and $STATE removed"
}

main() {
    case "${1:-}" in
        up | check | down) ;;
        -h | --help) usage; exit 0 ;;
        '') usage >&2; exit 2 ;;
        *) printf 'Unknown command: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
    esac
    [[ $# -eq 1 ]] || die "Use one command: up, check or down"
    valid_settings
    "$1"
}

main "$@"
