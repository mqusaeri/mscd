#!/usr/bin/env bash
# Rehearsal of the on-premise installer's internal network (MILESTONE-3, M3-M03). It installs
# an offline bundle twice on this host, the way an operator does, and removes it each time:
#
#   Case 1  install.sh --yes without --org-slug and with COMPOSE_PROJECT_NAME set (the default
#           organisation and the saved project name), then uninstall.sh --purge with
#           COMPOSE_PROJECT_NAME unset; no volume of the project may be left.
#   Case 2  a throwaway Docker network first takes the default range 172.31.250.0/24 (unless
#           something on this host uses it already); install.sh --yes without --subnet must
#           take the first free range from 172.31.250.0/24 to 172.31.254.0/24 and start; then
#           the installation is removed the same way.
#
# Between the steps it checks that .env holds the range and the web address Docker uses, that
# the API answers, that install.sh run again keeps the range, that --subnet moves the
# installation to another free range, that MSCD_SUBNET in the environment that differs from the
# saved range stops upgrade.sh, that an installation started on a /25 written into .env by hand
# (as the guide allowed before M3-M03) keeps it through install.sh and upgrade.sh with a
# warning, and that --subnet with a range in use stops install.sh before it writes anything.
#
# It creates and removes only what carries the prefix (default mscdm03): the Compose project
# <prefix>, the network <prefix>-block and the install directories in its work folder, plus the
# bundle's MSCD images and the mscd system account, which uninstall.sh --purge removes. A
# network, route or container of anyone else counts as taken and is never touched.
#
# Run it as root (install.sh creates the mscd system account). On a shared build host, run it
# under flock /tmp/mscd-stack.lock, so that no other stack starts beside it:
#   flock /tmp/mscd-stack.lock bash deploy/scripts/test/subnet-rehearsal.sh
set -uo pipefail
export TZ=UTC

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$SCRIPT_DIR/../../.." && pwd)

usage() {
    cat <<'EOF'
Usage: bash deploy/scripts/test/subnet-rehearsal.sh [options]

Installs an offline bundle twice on this host and removes it again: once with
COMPOSE_PROJECT_NAME set and without --org-slug, once while a throwaway network
holds the default internal range, so install.sh must take a free range.

Options:
  --bundle FILE       The bundle (default: the newest deploy/dist/mscd-onprem-*.tar.gz)
  --verify-key FILE   Public key of a signed bundle (default: mscd-release.pub next to
                      the bundle file, when the bundle is signed)
  --prefix NAME       Compose project and network name prefix (default: mscdm03)
  --http-port PORT    HTTP port of the installations (default: 18090)
  --https-port PORT   HTTPS port of the installations (default: 18453)
  --work-dir DIR      Folder for the extracted bundle, the install directories and the logs
                      (default: a new folder in /var/tmp, deleted when every check passed;
                      a folder given here is kept, without the extracted bundle)
  -h, --help          Show this help

Exit codes: 0 every check passed, 1 a check failed, 2 a wrong option or no bundle.
EOF
}

BUNDLE='' VERIFY_KEY='' PREFIX=mscdm03 HTTP_PORT=18090 HTTPS_PORT=18453 WORK='' KEEP_WORK=false

usage_error() {
    printf 'subnet-rehearsal: %s\n' "$1" >&2
    exit 2
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --bundle) [[ $# -ge 2 ]] || usage_error "--bundle needs a file"; BUNDLE=$2; shift 2 ;;
        --verify-key) [[ $# -ge 2 ]] || usage_error "--verify-key needs a file"; VERIFY_KEY=$2; shift 2 ;;
        --prefix) [[ $# -ge 2 ]] || usage_error "--prefix needs a name"; PREFIX=$2; shift 2 ;;
        --http-port) [[ $# -ge 2 ]] || usage_error "--http-port needs a port"; HTTP_PORT=$2; shift 2 ;;
        --https-port) [[ $# -ge 2 ]] || usage_error "--https-port needs a port"; HTTPS_PORT=$2; shift 2 ;;
        --work-dir) [[ $# -ge 2 ]] || usage_error "--work-dir needs a folder"; WORK=$2; KEEP_WORK=true; shift 2 ;;
        -h | --help) usage; exit 0 ;;
        *) usage_error "unknown option $1 (see --help)" ;;
    esac
done

# The prefix names a Compose project of its own; "mscd" is the project of a real installation.
[[ $PREFIX =~ ^[a-z][a-z0-9]{2,30}$ && $PREFIX != mscd ]] ||
    usage_error "--prefix must be 3 to 31 lower-case letters and digits, starting with a letter, and not mscd"
[[ $HTTP_PORT =~ ^[0-9]{1,5}$ && $HTTPS_PORT =~ ^[0-9]{1,5}$ && $HTTP_PORT != "$HTTPS_PORT" ]] ||
    usage_error "--http-port and --https-port must be two different port numbers"
if [[ -z $BUNDLE ]]; then
    BUNDLE=$(find "$REPO_DIR/deploy/dist" -maxdepth 1 -type f -name 'mscd-onprem-*.tar.gz' -printf '%T@ %p\n' 2>/dev/null |
        sort -rn | head -n 1 | cut -d' ' -f2-)
fi
[[ -n $BUNDLE && -f $BUNDLE ]] || usage_error "no bundle found (build one with deploy/scripts/build-bundle.sh, or pass --bundle)"
BUNDLE=$(realpath -- "$BUNDLE")
if [[ -n $VERIFY_KEY ]]; then
    [[ -f $VERIFY_KEY ]] || usage_error "cannot read --verify-key $VERIFY_KEY"
    VERIFY_KEY=$(realpath -- "$VERIFY_KEY")
fi
if ! command -v docker >/dev/null 2>&1 || ! docker version >/dev/null 2>&1; then
    usage_error "Docker is not running or not reachable"
fi
command -v curl >/dev/null 2>&1 || usage_error "curl is needed for the API checks"

if [[ -z $WORK ]]; then
    WORK=$(mktemp -d "/var/tmp/$PREFIX-rehearsal.XXXXXX") || usage_error "cannot create a work folder in /var/tmp"
fi
install -d -m 0755 "$WORK" "$WORK/logs" || usage_error "cannot create $WORK"
WORK=$(realpath -- "$WORK")
LOGS=$WORK/logs
RESULTS=$LOGS/results.log
: >"$RESULTS"
PROJECT=$PREFIX
BLOCK_NET=$PREFIX-block
BLOCK_CREATED=false
DIR1=$WORK/install-1
DIR2=$WORK/install-2
FAILED=0

result() {
    printf '%-5s %s\n' "$1" "$2" | tee -a "$RESULTS"
    if [[ $1 == FAIL ]]; then FAILED=$((FAILED + 1)); fi
}

# check TEXT COMMAND...: PASS when COMMAND succeeds, FAIL otherwise.
check() {
    local text=$1
    shift
    if "$@"; then result PASS "$text"; else result FAIL "$text"; fi
}

# Checks that check() calls by name.
# shellcheck disable=SC2329
has() { grep -qF -- "$2" "$1"; }
# shellcheck disable=SC2329
env_is() { [[ $(kv_get "$1/.env" "$2") == "$3" ]]; }
# shellcheck disable=SC2329
api_ok() {
    [[ $(curl -ks --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 10 \
        "https://127.0.0.1:$HTTPS_PORT/api/v1/system/profile" 2>/dev/null) == 200 ]]
}
net_subnet() { docker network inspect --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}' "${PROJECT}_mscd" 2>/dev/null || true; }
web_ip() {
    local id
    id=$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=web | head -n 1)
    [[ -n $id ]] || return 0
    docker inspect --format "{{with index .NetworkSettings.Networks \"${PROJECT}_mscd\"}}{{.IPAddress}}{{end}}" "$id" 2>/dev/null || true
}
# shellcheck disable=SC2329
web_running() {
    [[ -n $(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.service=web) ]]
}
nothing_left() {
    [[ -z $(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT") &&
        -z $(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT") &&
        -z $(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT") ]]
}

# run_script NAME LOG [VAR=VALUE...] -- ARGS...: runs a script of the bundle, writes its
# output to LOG and prints its exit code. COMPOSE_PROJECT_NAME, MSCD_SUBNET and
# MSCD_WEB_ADDRESS are unset unless given as VAR=VALUE.
run_script() {
    local name=$1 log=$2 vars=()
    shift 2
    while [[ $# -gt 0 && $1 != -- ]]; do vars+=("$1"); shift; done
    shift
    (cd "$BUNDLE_DIR" && env -u COMPOSE_PROJECT_NAME -u MSCD_SUBNET -u MSCD_WEB_ADDRESS \
        "${vars[@]}" "./$name" "$@") >"$log" 2>&1 </dev/null
    echo $?
}

# remove_installation DIR: uninstall.sh --purge for an installation that is still there.
# shellcheck disable=SC2329  # called by cleanup, the EXIT trap
remove_installation() {
    if [[ -f $1/.mscd-install ]]; then
        run_script uninstall.sh "$LOGS/cleanup-$(basename -- "$1").log" -- --dir "$1" --purge --yes >/dev/null
    fi
}

# shellcheck disable=SC2329  # the EXIT trap
cleanup() {
    local ids=()
    trap - EXIT INT TERM
    if [[ -n ${BUNDLE_DIR:-} && -d ${BUNDLE_DIR:-} ]]; then
        remove_installation "$DIR1"
        remove_installation "$DIR2"
    fi
    # Leftovers of this rehearsal's own project only (the label value matches exactly).
    mapfile -t ids < <(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")
    if ((${#ids[@]} > 0)); then docker rm -f "${ids[@]}" >/dev/null 2>&1 || true; fi
    mapfile -t ids < <(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT")
    if ((${#ids[@]} > 0)); then docker network rm "${ids[@]}" >/dev/null 2>&1 || true; fi
    mapfile -t ids < <(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT")
    if ((${#ids[@]} > 0)); then docker volume rm "${ids[@]}" >/dev/null 2>&1 || true; fi
    if [[ $BLOCK_CREATED == true ]]; then docker network rm "$BLOCK_NET" >/dev/null 2>&1 || true; fi
    rm -rf -- "$WORK/bundle" "$DIR1" "$DIR2"
    if [[ $KEEP_WORK == false && $FAILED -eq 0 ]]; then
        rm -rf -- "$WORK"
    else
        printf 'Logs: %s\n' "$LOGS"
    fi
}
trap cleanup EXIT
trap 'exit 1' INT TERM

printf 'Subnet rehearsal of %s (project %s, ports %s and %s)\n' "$BUNDLE" "$PROJECT" "$HTTP_PORT" "$HTTPS_PORT"
if [[ -f $DIR1/.mscd-install || -f $DIR2/.mscd-install ]] || ! nothing_left ||
    docker network inspect "$BLOCK_NET" >/dev/null 2>&1; then
    BLOCK_CREATED=true
    result FAIL "leftovers of an earlier run exist (containers, networks or volumes of the Compose project $PROJECT, or the network $BLOCK_NET); they are removed now, run the rehearsal again"
    exit 1
fi

install -d -m 0755 "$WORK/bundle"
if ! tar -xzf "$BUNDLE" -C "$WORK/bundle"; then
    result FAIL "extract $BUNDLE"
    exit 1
fi
BUNDLE_DIR=$(find "$WORK/bundle" -mindepth 1 -maxdepth 1 -type d -name 'mscd-onprem-*' | head -n 1)
[[ -n $BUNDLE_DIR && -x $BUNDLE_DIR/install.sh ]] || { result FAIL "the bundle holds no mscd-onprem-* folder with install.sh"; exit 1; }
KEY_ARGS=()
if [[ -n $VERIFY_KEY ]]; then
    KEY_ARGS=(--verify-key "$VERIFY_KEY")
elif [[ -f $BUNDLE_DIR/SHA256SUMS.sig && -f $(dirname -- "$BUNDLE")/mscd-release.pub ]]; then
    KEY_ARGS=(--verify-key "$(dirname -- "$BUNDLE")/mscd-release.pub")
fi
result INFO "bundle $(basename -- "$BUNDLE_DIR") extracted to $BUNDLE_DIR${KEY_ARGS[1]:+ (signature key ${KEY_ARGS[1]})}"

# The helpers of the bundle's lib/common.sh find what uses a range, as install.sh does.
# shellcheck source=../lib/common.sh disable=SC1091
. "$BUNDLE_DIR/lib/common.sh"
# shellcheck disable=SC2034  # read by subnet_users of lib/common.sh
MSCD_PROJECT=$PROJECT
CHOICES=("${MSCD_SUBNET_CHOICES[@]}")
DEFAULT=$MSCD_DEFAULT_SUBNET

# next_free_choice CURRENT: the first range of the choices other than CURRENT that is free.
next_free_choice() {
    local cidr
    for cidr in "${CHOICES[@]}"; do
        if [[ $cidr != "$1" && -z $(subnet_users "$cidr") ]]; then
            echo "$cidr"
            return 0
        fi
    done
}

# check_installation_network CASE DIR SUBNET: .env, the Docker network and the web
# container agree on SUBNET and its tenth address, and the API answers.
check_installation_network() {
    local label=$1 dir=$2 want=$3 web
    web=$(default_web_address "$want")
    check "$label: .env saves MSCD_SUBNET=$want" env_is "$dir" MSCD_SUBNET "$want"
    check "$label: .env saves MSCD_WEB_ADDRESS=$web" env_is "$dir" MSCD_WEB_ADDRESS "$web"
    check "$label: the network ${PROJECT}_mscd has the range $want (it has '$(net_subnet)')" test "$(net_subnet)" == "$want"
    check "$label: the web container has the address $web (it has '$(web_ip)')" test "$(web_ip)" == "$web"
    check "$label: the API answers 200 on https://127.0.0.1:$HTTPS_PORT" api_ok
}

# ---------------------------------------------------------------------------
# Case 1: COMPOSE_PROJECT_NAME set, no --org-slug, then uninstall without the variable
# ---------------------------------------------------------------------------
printf '\n== Case 1: install with COMPOSE_PROJECT_NAME=%s and without --org-slug\n' "$PROJECT"
expect=$(first_free_subnet)
if [[ -z $expect ]]; then
    result FAIL "case 1: no range from ${CHOICES[0]} to ${CHOICES[-1]} is free on this host: $(subnet_users_text "$DEFAULT")"
    exit 1
fi
if [[ $expect != "$DEFAULT" ]]; then
    result INFO "case 1: the default range $DEFAULT is in use on this host ($(subnet_users_text "$DEFAULT")); install.sh should take $expect"
fi
start=$SECONDS
rc=$(run_script install.sh "$LOGS/case1-install.log" "COMPOSE_PROJECT_NAME=$PROJECT" -- \
    --yes --self-signed --admin-email "admin@$PREFIX.example" --dir "$DIR1" \
    --http-port "$HTTP_PORT" --https-port "$HTTPS_PORT" "${KEY_ARGS[@]}")
check "case 1: install.sh --yes without --org-slug, COMPOSE_PROJECT_NAME=$PROJECT (exit $rc, $((SECONDS - start)) s)" test "$rc" == 0
if [[ $rc != 0 ]]; then
    tail -n 30 "$LOGS/case1-install.log"
else
    check "case 1: .env saves COMPOSE_PROJECT_NAME=$PROJECT" env_is "$DIR1" COMPOSE_PROJECT_NAME "$PROJECT"
    check "case 1: .env saves the default organisation (MSCD_ORG_SLUG=default)" env_is "$DIR1" MSCD_ORG_SLUG default
    check "case 1: install.sh created the organisation default" has "$LOGS/case1-install.log" "Organisation Default organisation (default) created"
    check_installation_network "case 1" "$DIR1" "$expect"
    if [[ $expect != "$DEFAULT" ]]; then
        check "case 1: install.sh printed the range it took" has "$LOGS/case1-install.log" "MSCD takes $expect"
    fi

    # install.sh again, without any variable or flag: the saved range stays.
    start=$SECONDS
    rc=$(run_script install.sh "$LOGS/case1-install-again.log" -- --yes --dir "$DIR1" "${KEY_ARGS[@]}")
    check "case 1: install.sh run again without variables keeps the project and the range (exit $rc, $((SECONDS - start)) s)" test "$rc" == 0
    check "case 1: install.sh run again counts the installation's own network as its own" \
        has "$LOGS/case1-install-again.log" "Internal range $expect is the network of this installation"
    check_installation_network "case 1, run again" "$DIR1" "$expect"

    # A different MSCD_SUBNET in the environment stops upgrade.sh before anything changes.
    other=$(next_free_choice "$expect")
    other=${other:-10.250.0.0/24}
    rc=$(run_script upgrade.sh "$LOGS/case1-upgrade-env.log" "MSCD_SUBNET=$other" -- --dir "$DIR1" --yes "${KEY_ARGS[@]}")
    check "case 1: upgrade.sh with MSCD_SUBNET=$other stops (exit $rc)" test "$rc" != 0
    check "case 1: upgrade.sh names the saved range and the variable" has "$LOGS/case1-upgrade-env.log" "uses the internal range $expect (saved in $DIR1/.env), but MSCD_SUBNET is set to $other"
    check "case 1: the installation keeps running after the refused upgrade" web_running
    rc=$(run_script upgrade.sh "$LOGS/case1-upgrade.log" -- --dir "$DIR1" --yes "${KEY_ARGS[@]}")
    check "case 1: upgrade.sh without the variables reads the range from .env (exit $rc)" test "$rc" == 0
    check "case 1: upgrade.sh reports the saved range" has "$LOGS/case1-upgrade.log" "Internal network $expect, web address $(default_web_address "$expect") (saved in $DIR1/.env)"

    # An installation that runs on a range smaller than /24, written into .env by hand as the
    # guide allowed before M3-M03, keeps it: install.sh and upgrade.sh warn and go on.
    current=$expect
    small=${expect%/*}/25
    start=$SECONDS
    (
        unset COMPOSE_PROJECT_NAME MSCD_SUBNET MSCD_WEB_ADDRESS
        compose_in "$DIR1" --profile '*' down --remove-orphans &&
            env_set "$DIR1/.env" MSCD_SUBNET "$small" &&
            compose_in "$DIR1" up -d --remove-orphans --wait --wait-timeout 600
    ) >"$LOGS/case1-small-start.log" 2>&1
    rc=$?
    check "case 1: the installation starts on $small written into .env by hand (exit $rc, $((SECONDS - start)) s)" test "$rc" == 0
    if [[ $rc == 0 ]]; then
        current=$small
        check_installation_network "case 1, $small by hand" "$DIR1" "$small"
        start=$SECONDS
        rc=$(run_script install.sh "$LOGS/case1-small-install.log" -- --yes --dir "$DIR1" "${KEY_ARGS[@]}")
        check "case 1: install.sh run again keeps the /25 of the running installation (exit $rc, $((SECONDS - start)) s)" test "$rc" == 0
        check "case 1: install.sh counts the /25 as the installation's own network" \
            has "$LOGS/case1-small-install.log" "Internal range $small is the network of this installation"
        check "case 1: install.sh warns that the kept range is smaller than /24" \
            has "$LOGS/case1-small-install.log" "The internal range $small is smaller than /24. MSCD keeps it"
        check_installation_network "case 1, $small kept by install.sh" "$DIR1" "$small"
        rc=$(run_script upgrade.sh "$LOGS/case1-small-upgrade.log" -- --dir "$DIR1" --yes "${KEY_ARGS[@]}")
        check "case 1: upgrade.sh keeps the /25 of the running installation (exit $rc)" test "$rc" == 0
        check "case 1: upgrade.sh reports the saved /25" has "$LOGS/case1-small-upgrade.log" \
            "Internal network $small, web address $(default_web_address "$small") (saved in $DIR1/.env)"
        check "case 1: upgrade.sh warns that the kept range is smaller than /24" \
            has "$LOGS/case1-small-upgrade.log" "The internal range $small is smaller than /24. MSCD keeps it"
    else
        tail -n 30 "$LOGS/case1-small-start.log"
    fi

    # --subnet moves the installation to another free range.
    move=$(next_free_choice "$expect")
    if [[ -z $move ]]; then
        result INFO "case 1: no second free range for the move test; skipped"
    else
        start=$SECONDS
        rc=$(run_script install.sh "$LOGS/case1-move.log" -- --yes --dir "$DIR1" --subnet "$move" "${KEY_ARGS[@]}")
        check "case 1: install.sh --subnet $move moves the installation (exit $rc, $((SECONDS - start)) s)" test "$rc" == 0
        check "case 1: install.sh announced the move from $current" has "$LOGS/case1-move.log" "the installation moves to it from $current"
        check_installation_network "case 1, moved" "$DIR1" "$move"
    fi
fi

# uninstall.sh with COMPOSE_PROJECT_NAME unset reads the project from .env.
start=$SECONDS
rc=$(run_script uninstall.sh "$LOGS/case1-uninstall.log" -- --dir "$DIR1" --purge --yes)
check "case 1: uninstall.sh --purge with COMPOSE_PROJECT_NAME unset (exit $rc, $((SECONDS - start)) s)" test "$rc" == 0
check "case 1: uninstall.sh read the project from .env" has "$LOGS/case1-uninstall.log" "Compose project $PROJECT (saved in $DIR1/.env)"
check "case 1: no volume of the project $PROJECT is left" test -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT")"
check "case 1: no container or network of the project $PROJECT is left" nothing_left
check "case 1: the install directory is deleted" test ! -e "$DIR1"

# ---------------------------------------------------------------------------
# Case 2: the default range is taken, install.sh --yes takes a free one
# ---------------------------------------------------------------------------
printf '\n== Case 2: the default range %s is taken\n' "$DEFAULT"
users=$(subnet_users_text "$DEFAULT")
if [[ -n $users ]]; then
    result INFO "case 2: the default range is in use on this host already ($users); no network is added"
elif docker network create --internal --subnet "$DEFAULT" --label "com.cyberlentera.mscd.rehearsal=$PREFIX" "$BLOCK_NET" >/dev/null; then
    BLOCK_CREATED=true
    users=$(subnet_users_text "$DEFAULT")
    check "case 2: the throwaway network $BLOCK_NET holds $DEFAULT" has <(printf '%s\n' "$users") "$BLOCK_NET"
else
    result FAIL "case 2: docker network create $BLOCK_NET with $DEFAULT"
fi
expect=$(first_free_subnet)
check "case 2: a free range from ${CHOICES[0]} to ${CHOICES[-1]} other than the default exists ('$expect')" \
    test -n "$expect" -a "$expect" != "$DEFAULT"

# --subnet with the taken range and a range that is too small stop install.sh before it writes anything.
rc=$(run_script install.sh "$LOGS/case2-taken.log" "COMPOSE_PROJECT_NAME=$PROJECT" -- \
    --yes --self-signed --dir "$DIR2" --org-slug rehearsal --org-name "Subnet rehearsal" \
    --http-port "$HTTP_PORT" --https-port "$HTTPS_PORT" --subnet "$DEFAULT" "${KEY_ARGS[@]}")
check "case 2: install.sh --subnet $DEFAULT (taken) stops (exit $rc)" test "$rc" != 0
check "case 2: the message names what is in the way" has "$LOGS/case2-taken.log" "The internal range $DEFAULT (from --subnet) is in use on this host: ${users%%;*}"
check "case 2: the message names the option to use" has "$LOGS/case2-taken.log" "Fix: Choose a free private range of /24 or larger with --subnet"
check "case 2: nothing was written (no install directory, no container)" test ! -e "$DIR2" -a -z "$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")"
rc=$(run_script install.sh "$LOGS/case2-small.log" "COMPOSE_PROJECT_NAME=$PROJECT" -- --yes --dir "$DIR2" --subnet 172.31.252.0/25)
check "case 2: install.sh --subnet 172.31.252.0/25 stops (exit $rc)" test "$rc" != 0
check "case 2: the message says the range is smaller than /24" has "$LOGS/case2-small.log" "is smaller than /24"

start=$SECONDS
rc=$(run_script install.sh "$LOGS/case2-install.log" "COMPOSE_PROJECT_NAME=$PROJECT" -- \
    --yes --self-signed --dir "$DIR2" --org-slug rehearsal --org-name "Subnet rehearsal" \
    --http-port "$HTTP_PORT" --https-port "$HTTPS_PORT" "${KEY_ARGS[@]}")
check "case 2: install.sh --yes without --subnet starts on a free range (exit $rc, $((SECONDS - start)) s)" test "$rc" == 0
if [[ $rc != 0 ]]; then
    tail -n 30 "$LOGS/case2-install.log"
else
    check "case 2: install.sh said the default range is in use" has "$LOGS/case2-install.log" "The default internal range $DEFAULT is in use on this host"
    check "case 2: install.sh printed the range it took" has "$LOGS/case2-install.log" "MSCD takes $expect, the first free range from ${CHOICES[0]} to ${CHOICES[-1]}"
    check "case 2: the summary names the range" has "$LOGS/case2-install.log" "The containers use the internal range $expect"
    check_installation_network "case 2" "$DIR2" "$expect"
fi
start=$SECONDS
rc=$(run_script uninstall.sh "$LOGS/case2-uninstall.log" -- --dir "$DIR2" --purge --yes)
check "case 2: uninstall.sh --purge with COMPOSE_PROJECT_NAME unset (exit $rc, $((SECONDS - start)) s)" test "$rc" == 0
check "case 2: no volume, container or network of the project $PROJECT is left" nothing_left
check "case 2: the install directory is deleted" test ! -e "$DIR2"
if [[ $BLOCK_CREATED == true ]]; then
    if docker network rm "$BLOCK_NET" >/dev/null; then
        BLOCK_CREATED=false
        result PASS "case 2: the throwaway network $BLOCK_NET is removed"
    else
        result FAIL "case 2: docker network rm $BLOCK_NET"
    fi
fi

printf '\n== Summary\n'
cat "$RESULTS"
if ((FAILED > 0)); then
    printf '%d check(s) failed.\n' "$FAILED"
    exit 1
fi
printf 'Every check passed.\n'
exit 0
