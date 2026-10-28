#!/usr/bin/env bash
# MSCD SaaS: deploy a signed release to a staging or production server, or roll back
# (Milestone 2 plan K, M2-S05). deploy-prod.yml copies the release to
# /opt/mscd/releases/<tag> and runs this script there over SSH as the deploy account;
# docs/saas/deploy.md explains the whole flow.
#
#   saas-deploy.sh deploy     --target production --version 1.1.0 < values
#   saas-deploy.sh rollback   --target production --version 1.0.2 < values
#   saas-deploy.sh check-only [--install-dir DIR]
#
# Standard input carries the secret values and the settings, one line each:
# NAME=<base64 of the value>. Secrets are never command line arguments.
#
# deploy, in order:
#   1. Lock the install folder, refuse anything of the demo stack (S-7), check Docker,
#      memory and disk.
#   2. Read digests.json of the release and the values on standard input; write the new
#      .env from .env.saas.example of the release (installed in step 7).
#   3. Verify the cosign signature of both digests, pull them while the old containers keep
#      running, and start the new server image once with --help.
#   4. Check that PostgreSQL is healthy and that the pre-deploy dump fits on the disk.
#   5. Key files from standard input (platform.key, storage.key, audit-anchor.key, and
#      audit-anchor.pub derived from the private key): a missing file is written, an
#      existing one must hold the same key. Then the generated secrets when missing,
#      smtp.password, and the off-site backup and monitoring values as files.
#   6. A pre-deploy pg_dump to <install>/backup/pre-deploy (last 3 kept), and an off-site
#      copy when the release has deploy/backup/backup.sh (M2-S07).
#   7. Save the files in place (the rollback point), install the release's Compose files,
#      configuration and .env, and run migrate alone while the old services keep running.
#   8. Restart storage-gateway, api, worker, web and caddy one by one (--no-deps --wait),
#      check /readyz of the server services, and /healthz and the version through Caddy.
#   9. Record the current and previous release in <install>/state and keep the images of
#      the last 3 releases.
# A failed migrate or check puts the saved files back and starts the previous digests
# again. There is no down migration: restoring the database is a manual step, needed only
# when a migration broke data (docs/saas/deploy.md). smtp.password is never put back: a
# .env put back gets the mail settings of the run, which go with the password it wrote.
#
# The output of a run is the workflow log of a public repository: it holds the steps, the
# settings that are not secret, versions, digests, timings and counts, and short excerpts of
# the migrate and Compose logs with organisation schema names, email and IP addresses
# hidden. Service logs, which can name organisations and people, go to <install>/logs only.
#
# A run does not depend on its SSH connection. deploy-prod.yml runs it in the foreground of
# that connection; when the connection ends (a cancelled workflow run, the job's time
# limit, a lost runner), the run carries on to its end, finishes or rolls back, and writes
# its whole output to <install>/logs. state/history.log gets a "started" line before the
# first change and a line with the result at the end, and the next run prints the last
# line. A run that is stopped hard (a restart of the server) can leave the files half
# switched; the next run puts the saved copy back before it switches them (repair_switch).
set -euo pipefail
umask 027

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

# The Compose project name of an install is kept in its .env. lib/common.sh reads
# COMPOSE_PROJECT_NAME once, when it is sourced, so it is looked up first.
prescan_install_dir() {
    local dir=/opt/mscd
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --install-dir) if [[ $# -ge 2 ]]; then dir=$2; shift; fi ;;
            --install-dir=*) dir=${1#*=} ;;
        esac
        shift
    done
    printf '%s' "$dir"
}
if [[ -z ${COMPOSE_PROJECT_NAME:-} ]]; then
    prescan_env=$(prescan_install_dir "$@")/.env
    if [[ -f $prescan_env && -r $prescan_env ]]; then
        prescan_name=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$prescan_env" | tail -n 1)
        if [[ $prescan_name =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]; then export COMPOSE_PROJECT_NAME=$prescan_name; fi
    fi
    unset prescan_env prescan_name
fi

# shellcheck source=lib/common.sh disable=SC1091  # followed with shellcheck -x
. "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/saas.sh disable=SC1091
. "$SCRIPT_DIR/lib/saas.sh"

readonly MIGRATE_BASE_SECONDS=600
readonly MIGRATE_SECONDS_PER_ORG=20

usage() {
    cat <<'EOF'
Usage: saas-deploy.sh deploy|rollback|check-only [options] [< values]

Deploys a signed MSCD release to this SaaS server, rolls back to the release that ran
before, or only checks (check-only changes nothing and reads no standard input).
deploy-prod.yml runs it; docs/saas/deploy.md explains every step.

Options:
  --target NAME          production, staging or test (required for deploy and rollback)
  --install-dir DIR      Install and Compose project folder (default: /opt/mscd)
  --release-dir DIR      Release folder that holds deploy/ (default: the release of this script)
  --digests FILE         digests.json of the release (default: <release-dir>/digests.json)
  --version VERSION      Expected version (1.1.0 or v1.1.0); for rollback, the release to return to
  --timeout SECONDS      Longest wait for one service to become healthy (default: 300)
  --verify-timeout SECONDS  Longest wait for the checks through Caddy (default: 180)
  --min-free-disk MB     Free space needed for Docker data (default: 10240)
  --skip-backup          No pre-deploy database dump (not recommended)
  --cosign FILE          cosign binary (default: <install-dir>/bin/cosign, then PATH)
  --no-verify-signature  Skip cosign; accepted only for images from a registry on 127.0.0.1
  -h, --help             Show this help

Standard input of deploy and rollback, one NAME=<base64 value> line each:
  PLATFORM_KEY, STORAGE_KEY, AUDIT_ANCHOR_KEY, SMTP_PASSWORD   required
  BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY, BACKUP_S3_SECRET_KEY,
  BACKUP_SECRETS_ACCESS_KEY, BACKUP_SECRETS_SECRET_KEY, BACKUP_RESTIC_PASSWORD,
  HEARTBEAT_BACKUP_URL                       files in <install-dir>/secrets/backup
  HEARTBEAT_WATCHDOG_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
  ALERT_EMAIL_TO                             files in <install-dir>/secrets/ops
  Settings of .env (also read from the environment): MSCD_DOMAIN, MSCD_SITE_DOMAIN,
  MSCD_TLS_MODE, ACME_EMAIL, ACME_CA, MSCD_MAIL_FROM, MSCD_SMTP_HOST, MSCD_SMTP_PORT,
  MSCD_SMTP_SECURE, MSCD_SMTP_USER, MSCD_HTTP_PORT, MSCD_HTTPS_PORT, MSCD_LOG_LEVEL,
  MSCD_PUBLIC_URL, MSCD_EDGE_IPV6, MSCD_SUBNET, MSCD_WEB_ADDRESS, MSCD_EDGE_SUBNET,
  MSCD_CADDY_ADDRESS, MSCD_WEB_EDGE_ADDRESS, MSCD_EDGE_SUBNET6
EOF
}

ACTION='' TARGET='' OPT_INSTALL_DIR='' OPT_RELEASE_DIR='' OPT_DIGESTS='' OPT_VERSION=''
TIMEOUT=300 VERIFY_TIMEOUT=180 MIN_DISK=10240 SKIP_BACKUP=false VERIFY_SIGNATURE=true OPT_COSIGN=''
# Set by restart_services when an overlay service (monitoring, backups) needs attention.
OVERLAY_PROBLEM=''
# state/history.log: the action and version of a run that wrote its "started" line, and
# the phase it is in (for the "stopped" line of a run that ends without a result).
HISTORY_ACTION='' HISTORY_VERSION='' PHASE=''
# True once the secret files may have been written; DUMP: a pre-deploy dump is taken.
SECRETS_TOUCHED=false DUMP=false

need_value() {
    if [[ $# -lt 2 || -z $2 || $2 == --* ]]; then die "Option $1 needs a value. See --help"; fi
}

parse_args() {
    [[ $# -gt 0 ]] || { usage >&2; exit 2; }
    case "$1" in
        deploy | rollback | check-only) ACTION=$1; shift ;;
        -h | --help) usage; exit 0 ;;
        *) die "The first argument must be deploy, rollback or check-only, got '$1'. See --help" ;;
    esac
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --target) need_value "$@"; TARGET=$2; shift 2 ;;
            --install-dir) need_value "$@"; OPT_INSTALL_DIR=$2; shift 2 ;;
            --install-dir=*) OPT_INSTALL_DIR=${1#*=}; shift ;;
            --release-dir) need_value "$@"; OPT_RELEASE_DIR=$2; shift 2 ;;
            --digests) need_value "$@"; OPT_DIGESTS=$2; shift 2 ;;
            --version) need_value "$@"; OPT_VERSION=${2#v}; shift 2 ;;
            --timeout) need_value "$@"; TIMEOUT=$2; shift 2 ;;
            --verify-timeout) need_value "$@"; VERIFY_TIMEOUT=$2; shift 2 ;;
            --min-free-disk) need_value "$@"; MIN_DISK=$2; shift 2 ;;
            --skip-backup) SKIP_BACKUP=true; shift ;;
            --cosign) need_value "$@"; OPT_COSIGN=$2; shift 2 ;;
            --no-verify-signature) VERIFY_SIGNATURE=false; shift ;;
            -h | --help) usage; exit 0 ;;
            *) die "Unknown option: $1. See --help" ;;
        esac
    done
    case "$TARGET" in
        production | staging | test) ;;
        '') [[ $ACTION == check-only ]] || die "--target is required: production, staging or test" ;;
        *) die "--target must be production, staging or test, got '$TARGET'" ;;
    esac
    for value in "$TIMEOUT" "$VERIFY_TIMEOUT" "$MIN_DISK"; do
        [[ $value =~ ^[1-9][0-9]{0,5}$ ]] || die "--timeout, --verify-timeout and --min-free-disk take a whole number"
    done
    if [[ -n $OPT_VERSION ]] && ! saas_valid_version "$OPT_VERSION"; then
        die "--version must be x.y.z or x.y.z-rc.n (with or without a leading v), got '$OPT_VERSION'"
    fi
}

# ---------------------------------------------------------------------------
# Common steps
# ---------------------------------------------------------------------------

lock_install() {
    command -v flock >/dev/null 2>&1 || die "flock is not installed (package util-linux)"
    exec 8<"$INSTALL_DIR"
    if flock -n 8; then return 0; fi
    if [[ -s $STATE_DIR/history.log ]]; then
        info "Last line of state/history.log: $(tail -n 1 -- "$STATE_DIR/history.log")"
    fi
    die "Another deploy or rollback is running in $INSTALL_DIR. Nothing was changed. A run whose workflow was cancelled or lost its connection keeps running on the server until it ends: wait for it, then start this run again (docs/saas/deploy.md, When a run is cut off)."
}

# start_log NAME: from here on, the output also goes to <install>/logs/NAME-<stamp>.log.
# The output of the run reaches its caller through tee. With -p, tee carries on writing
# the log file when the caller goes away (the SSH connection of the workflow ended), so
# neither tee nor this script is stopped by SIGPIPE; main ignores SIGHUP.
start_log() {
    local -a tee_args=(-a)
    install -d -m 0750 "$LOG_DIR"
    LOG_FILE=$LOG_DIR/$1-$STAMP.log
    COMPOSE_LOG=$LOG_DIR/$1-$STAMP-compose.log
    if tee -p /dev/null </dev/null >/dev/null 2>&1; then tee_args=(-p -a); fi
    exec > >(tee "${tee_args[@]}" "$LOG_FILE") 2>&1
    TEE_PID=$!
    if [[ ${tee_args[0]} != -p ]]; then
        warn "This tee has no option -p (GNU coreutils): the run stops when its SSH connection ends"
    fi
}

# last_run_note: the last line of state/history.log, so the log of a run also shows how the
# run before it ended (a run whose connection was cut off ends on the server alone).
last_run_note() {
    local line
    [[ -s $STATE_DIR/history.log ]] || return 0
    line=$(tail -n 1 -- "$STATE_DIR/history.log")
    info "Last line of state/history.log: $line"
    if [[ $(awk '{ print $3 }' <<<"$line") == started ]]; then
        warn "That run recorded no result: it was stopped hard (for example by a restart of the server). This run checks the files in place before it switches them."
    fi
}

# history_start ACTION VERSION DETAIL: the line "started" in state/history.log, written
# just before a run changes anything. history_end RESULT DETAIL writes its result. A run
# that ends without one (an error, a refusal after the start) gets the line "stopped" with
# its exit code and phase from cleanup.
history_start() {
    HISTORY_ACTION=$1 HISTORY_VERSION=$2
    saas_history "$1" started "$2" "${3:-}"
}

history_end() {
    saas_history "$HISTORY_ACTION" "$1" "$HISTORY_VERSION" "${2:-}"
    HISTORY_ACTION=''
}

# remove_stale_work: work folders that runs stopped hard left behind, the copies of the key
# files among them. Called only while this run holds the lock.
remove_stale_work() {
    local dir
    for dir in "$INSTALL_DIR"/secrets/.deploy.* "$STATE_DIR"/.deploy.*; do
        if [[ -d $dir ]]; then rm -rf -- "$dir"; fi
    done
    rm -f -- "$STATE_DIR"/.restore-env.*
}

# stop_if_failed: abort_if_failed of lib/common.sh for the steps after the "started"
# line, where the secret files may already have been written.
stop_if_failed() {
    ((FAILURES > 0)) || return 0
    if [[ $SECRETS_TOUCHED == true ]]; then
        printf '\n%s%d check(s) failed.%s Fix the items above and run %s again. The running release, its settings and the database were not changed; only the secret files were brought up to date (docs/saas/deploy.md, What a deploy does).\n' \
            "$C_RED" "$FAILURES" "$C_RESET" "$(basename "$0")"
    else
        printf '\n%s%d check(s) failed.%s Fix the items above and run %s again. Nothing was changed.\n' \
            "$C_RED" "$FAILURES" "$C_RESET" "$(basename "$0")"
    fi
    exit 1
}

cleanup() {
    local status=$?
    if [[ -n ${HISTORY_ACTION:-} ]]; then
        saas_history "$HISTORY_ACTION" stopped "$HISTORY_VERSION" "exit=$status phase=${PHASE:-checks}" 2>/dev/null || true
        HISTORY_ACTION=''
    fi
    if [[ -n ${WORK:-} && -d $WORK ]]; then rm -rf -- "$WORK"; fi
    if [[ -n ${KEY_WORK:-} && -d $KEY_WORK ]]; then rm -rf -- "$KEY_WORK"; fi
    # The caller sees the whole output before this script ends.
    if [[ -n ${TEE_PID:-} ]]; then
        exec 1>&- 2>&-
        wait "$TEE_PID" 2>/dev/null || true
    fi
}

host_checks() {
    step "Checking this server"
    check_privileges
    check_docker
    if [[ $DOCKER_OK == true ]]; then saas_check_host "$MIN_DISK"; fi
    abort_if_failed
}

# read_digests FILE: the release's image names and digests (NEW_*).
read_digests() {
    local file=$1 key
    if [[ ! -f $file ]]; then
        fail "The release has no digests file ($file)" "deploy-prod.yml copies digests.json of the GitHub Release into the release folder"
        return 1
    fi
    NEW_VERSION=$(saas_json_string "$file" version)
    NEW_SERVER_IMAGE=$(saas_json_string "$file" serverImage)
    NEW_SERVER_DIGEST=$(saas_json_string "$file" server)
    NEW_WEB_IMAGE=$(saas_json_string "$file" webImage)
    NEW_WEB_DIGEST=$(saas_json_string "$file" web)
    if ! saas_valid_version "$NEW_VERSION"; then
        fail "digests.json names no valid version (got '$NEW_VERSION')"
        return 1
    fi
    if [[ -n $OPT_VERSION && $OPT_VERSION != "$NEW_VERSION" ]]; then
        fail "digests.json is for version $NEW_VERSION, but --version is $OPT_VERSION"
        return 1
    fi
    for key in "$NEW_SERVER_IMAGE" "$NEW_WEB_IMAGE"; do
        saas_valid_image "$key" || fail "digests.json names '$key', which is not an image name without tag"
    done
    for key in "$NEW_SERVER_DIGEST" "$NEW_WEB_DIGEST"; do
        saas_valid_digest "$key" || fail "digests.json holds '$key', which is not a sha256 digest"
    done
    [[ $NEW_SERVER_IMAGE != "$NEW_WEB_IMAGE" ]] || fail "digests.json names the same image for server and web"
    NEW_SERVER_REF=$NEW_SERVER_IMAGE@$NEW_SERVER_DIGEST
    NEW_WEB_REF=$NEW_WEB_IMAGE@$NEW_WEB_DIGEST
    key=$(saas_json_string "$file" serverRef)
    [[ -z $key || $key == "$NEW_SERVER_REF" ]] || fail "serverRef of digests.json is not serverImage@server"
    key=$(saas_json_string "$file" webRef)
    [[ -z $key || $key == "$NEW_WEB_REF" ]] || fail "webRef of digests.json is not webImage@web"
    ((FAILURES == 0)) || return 1
    pass "Release $NEW_VERSION: server ${NEW_SERVER_DIGEST:7:12}, web ${NEW_WEB_DIGEST:7:12}"
}

# check_signature_option SERVER_REF WEB_REF
check_signature_option() {
    if [[ $VERIFY_SIGNATURE == false ]]; then
        if saas_loopback_registry "$1" && saas_loopback_registry "$2"; then
            warn "Image signatures are not checked (--no-verify-signature, registry on 127.0.0.1)"
        else
            fail "--no-verify-signature is accepted only for images from a registry on 127.0.0.1 (rehearsals)" \
                "Remove the option; a server runs signed release images only"
        fi
        return 0
    fi
    COSIGN=$OPT_COSIGN
    if [[ -z $COSIGN && -x $INSTALL_DIR/bin/cosign ]]; then COSIGN=$INSTALL_DIR/bin/cosign; fi
    if [[ -z $COSIGN ]]; then COSIGN=$(command -v cosign 2>/dev/null || true); fi
    if [[ -z $COSIGN || ! -x $COSIGN ]]; then
        fail "cosign is needed to check the image signatures and was not found" \
            "deploy-prod.yml copies it to $INSTALL_DIR/bin/cosign; or pass --cosign FILE"
    fi
}

# verify_images VERSION SERVER_REF WEB_REF: signatures, pull, server image check.
verify_images() {
    local version=$1 server=$2 web=$3 identity ref log=$WORK/images.log
    identity="https://github.com/$SAAS_SIGNER_REPO/.github/workflows/release.yml@refs/tags/v$version"
    if [[ $VERIFY_SIGNATURE == true ]]; then
        for ref in "$server" "$web"; do
            if saas_cosign_verify "$COSIGN" "$ref" "$identity" "$log"; then
                pass "Signature of ${ref%@*} made by release.yml for v$version"
            else
                fail "The signature of $ref does not check out (cosign verify, identity $identity)"
                saas_print_log "$log" 6
            fi
        done
        ((FAILURES == 0)) || return 1
    fi
    saas_pull "$server" || return 1
    saas_pull "$web" || return 1
    saas_check_server_image "$server" "$log"
}

# install_secrets SERVER_REF
install_secrets() {
    local image=$1 dir=$INSTALL_DIR/secrets count_backup count_ops
    install -d -m 0700 "$dir"
    chmod 0700 "$dir"
    KEY_WORK=$(mktemp -d "$dir/.deploy.XXXXXX")
    # shellcheck disable=SC2034  # read by ensure_certificates of lib/common.sh
    CERTS_CHANGED=false
    # A key that does not match stops the run here, before any file is written.
    saas_install_keys "$dir" "$image" "$KEY_WORK" || return 1
    SECRETS_TOUCHED=true
    ensure_database_secrets "$dir" || return 1
    ensure_key_secrets "$dir" || return 1
    ensure_certificates "$dir" || return 1
    # smtp.password is written before the owners are set, so the api, worker and cli
    # (user 10001) can read it.
    set_smtp_password "$dir" <(saas_input "$SAAS_SMTP_INPUT"; echo)
    if [[ -z $(saas_input "$SAAS_SMTP_INPUT") && -n ${SAAS_VALUE[MSCD_SMTP_USER]:-$(kv_get "$INSTALL_DIR/.env" MSCD_SMTP_USER)} ]]; then
        warn "SMTP_PASSWORD is empty while an SMTP user is set: sign-in mail will fail"
    fi
    pass "smtp.password written from standard input"
    fix_secret_owners "$dir" "$image" || {
        fail "Could not set the owners of the files in $dir"
        return 1
    }
    pass "Secret files are readable only by the service that uses them"
    count_backup=$(saas_write_value_files "$dir/backup" "${SAAS_BACKUP_INPUTS[@]}")
    count_ops=$(saas_write_value_files "$dir/ops" "${SAAS_OPS_INPUTS[@]}")
    pass "Off-site backup values: $count_backup file(s) in $dir/backup; monitoring values: $count_ops file(s) in $dir/ops"
    rm -rf -- "$KEY_WORK"
}

# predeploy_check FROM: before anything is written, decides whether a pre-deploy dump is
# taken (DUMP) and checks that it can be: PostgreSQL runs and is healthy, and the disk has
# room for the database.
predeploy_check() {
    local from=$1 pg dir=$INSTALL_DIR/backup size free_kb note=''
    DUMP=false
    if [[ $SKIP_BACKUP == true ]]; then
        warn "No pre-deploy database dump (--skip-backup)"
        return 0
    fi
    pg=$(project_containers postgres | head -n 1)
    if [[ -z $pg ]]; then
        if [[ -z $from ]]; then
            info "No database runs yet (first deploy): no pre-deploy dump"
            return 0
        fi
        fail "The PostgreSQL container of $MSCD_PROJECT is missing, so no pre-deploy dump can be taken" \
            "Find out why (docker compose ps -a in $INSTALL_DIR/deploy/compose), or deploy with skip_backup"
        return 1
    fi
    if [[ $(container_state "$pg") != healthy ]]; then
        fail "PostgreSQL is $(container_state "$pg"), so no pre-deploy dump can be taken" \
            "Find out why (docker compose logs postgres in $INSTALL_DIR/deploy/compose), or deploy with skip_backup"
        return 1
    fi
    [[ -d $dir ]] || dir=$INSTALL_DIR
    size=$(saas_compose exec -T postgres psql -U postgres -d mscd -Atc "select pg_database_size('mscd')" 2>/dev/null | tr -dc '0-9' || true)
    free_kb=$(df -Pk -- "$dir" | awk 'NR == 2 { print $4 }')
    if [[ -n $size && -n $free_kb ]] && ((size / 1024 > free_kb)); then
        fail "The database holds $((size / 1048576)) MB but $dir has only $((free_kb / 1024)) MB free" \
            "Free disk space on the server, or deploy with skip_backup"
        return 1
    fi
    if [[ -n $size ]]; then note=" (database $((size / 1048576)) MB)"; fi
    DUMP=true
    pass "PostgreSQL is healthy$note and the pre-deploy dump fits on the disk"
}

# predeploy_backup FROM TO: the dump that predeploy_check allowed, and its off-site copy.
predeploy_backup() {
    local from=$1 to=$2 dir file err=$WORK/pg_dump.err
    if [[ $DUMP != true ]]; then
        info "No pre-deploy dump (see the database check above)"
        return 0
    fi
    dir=$INSTALL_DIR/backup/pre-deploy
    install -d -m 0700 "$INSTALL_DIR/backup" "$dir"
    file=$dir/$(saas_stamp)-${from:-none}-to-$to.dump
    if saas_compose exec -T postgres pg_dump -U postgres --format=custom --dbname=mscd >"$file.partial" 2>"$err" &&
        [[ $(head -c 5 -- "$file.partial") == PGDMP ]]; then
        chmod 0600 "$file.partial"
        mv -f -- "$file.partial" "$file"
        pass "Pre-deploy dump $file ($(du -h -- "$file" | cut -f1))"
    else
        rm -f -- "$file.partial"
        fail "pg_dump of the database mscd failed"
        saas_print_log "$err" 10
        return 1
    fi
    saas_prune_dir "$dir" '*.dump' "$SAAS_KEEP_DUMPS"
    if [[ -f $RELEASE_DIR/deploy/backup/backup.sh ]]; then
        if bash "$RELEASE_DIR/deploy/backup/backup.sh" --pre-deploy "$file" --install-dir "$INSTALL_DIR" \
            >"$LOG_DIR/backup-pre-deploy-$STAMP.log" 2>&1; then
            pass "Off-site copy of the dump sent (deploy/backup/backup.sh)"
        else
            fail "The off-site copy of the dump failed (log: $LOG_DIR/backup-pre-deploy-$STAMP.log)"
            saas_print_log "$LOG_DIR/backup-pre-deploy-$STAMP.log" 10
            return 1
        fi
    else
        info "This release has no deploy/backup/backup.sh, so the dump stays on this server only"
    fi
}

# compose_logged ARGS...: saas_compose with its output in COMPOSE_LOG.
compose_logged() {
    printf '\n$ docker compose %s\n' "$*" >>"$COMPOSE_LOG"
    saas_compose "$@" >>"$COMPOSE_LOG" 2>&1
}

# service_logs SERVICE...: the last 200 log lines of each service go to the server's log
# folder only. Service logs can name organisations (their slugs) and people, and the output
# of a run is the workflow log of a public repository (M2-S04 follow-up 1, GL-50), so the
# output names only the state of each service and where its lines are.
service_logs() {
    local svc id file=$LOG_DIR/$ACTION-$STAMP-services.log state counts
    for svc in "$@"; do
        id=$(project_containers "$svc" | head -n 1)
        if [[ -z $id ]]; then
            printf '        Service %s has no container\n' "$svc"
            continue
        fi
        state=$(container_state "$id")
        { printf '\n== %s (%s)\n' "$svc" "$state"; docker logs --tail 200 "$id" 2>&1; } >>"$file" || true
        counts=$(docker inspect --format 'restarts {{.RestartCount}}, last exit code {{.State.ExitCode}}' "$id" 2>/dev/null || true)
        printf '        Service %s is %s (%s); its last log lines are in %s on the server\n' \
            "$svc" "$state" "${counts:-no details}" "$file"
    done
}

# service_healthy SERVICE: the container of SERVICE passes its health check.
service_healthy() {
    local id
    id=$(project_containers "$1" | head -n 1)
    [[ -n $id && $(container_state "$id") == healthy ]]
}

profile_active() {
    [[ ,$(kv_get "$INSTALL_DIR/.env" COMPOSE_PROFILES), == *,$1,* ]]
}

# start_data_services: PostgreSQL and SeaweedFS when they do not run yet (first deploy).
# Running ones are left alone here; restart_services applies their new settings.
start_data_services() {
    local entry svc id
    for entry in "${SAAS_DATA_SERVICES[@]}"; do
        svc=${entry%%:*}
        profile_active "${entry#*:}" || continue
        id=$(project_containers "$svc" | head -n 1)
        if [[ -n $id && $(container_state "$id") == healthy ]]; then continue; fi
        if compose_logged up -d --no-deps --wait --wait-timeout "$TIMEOUT" "$svc"; then
            pass "$svc started"
        else
            fail "$svc did not become healthy"
            service_logs "$svc"
            return 1
        fi
    done
}

# other_services: services of the overlays (monitoring) that the deploy also starts.
other_services() {
    saas_compose config --services 2>/dev/null | grep -Ev "$SAAS_NOT_STARTED" || true
}

# wait_started SERVICE...: each container is healthy, running without a health check,
# or a one-shot (restart policy no) that finished with exit code 0. Problems are
# warnings: these are the overlay services, which do not decide whether the app is
# healthy.
wait_started() {
    local svc id state code start=$SECONDS pending
    while true; do
        pending=()
        for svc in "$@"; do
            for id in $(project_containers "$svc"); do
                state=$(container_state "$id")
                code=$(docker inspect --format '{{.State.ExitCode}}' "$id" 2>/dev/null || echo 1)
                case "$state" in
                    healthy) ;;
                    running)
                        # Running without a health check: a one-shot (restart policy no) is
                        # still at work.
                        case $(docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' "$id" 2>/dev/null || true) in
                            no | '') pending+=("$svc") ;;
                        esac
                        ;;
                    exited) ((code == 0)) || { warn "$svc exited with code $code"; return 1; } ;;
                    unhealthy | dead) warn "$svc is $state"; return 1 ;;
                    *) pending+=("$svc") ;;
                esac
            done
        done
        ((${#pending[@]} == 0)) && return 0
        if ((SECONDS - start > TIMEOUT)); then
            warn "Still starting after ${TIMEOUT}s: ${pending[*]}"
            return 1
        fi
        sleep 2
    done
}

# restart_services FORCE CADDY_HASH_BEFORE: the services of the new .env one by one.
# FORCE=true recreates the server services also when their settings did not change (a
# restore after they ran other images, or secret files that were written again), and the
# overlay services. FORCE=false (the restore after a failed migrate, which stopped no
# service) recreates only a service whose settings differ from the ones it runs with, and
# leaves the overlay services alone.
restart_services() {
    local force=$1 caddy_before=$2 entry svc args caddy_id others
    for entry in "${SAAS_DATA_SERVICES[@]}"; do
        svc=${entry%%:*}
        profile_active "${entry#*:}" || continue
        if ! compose_logged up -d --no-deps --wait --wait-timeout "$TIMEOUT" "$svc" || ! service_healthy "$svc"; then
            fail "$svc did not become healthy"
            service_logs "$svc"
            return 1
        fi
    done
    for svc in "${SAAS_APP_SERVICES[@]}"; do
        args=(up -d --no-deps --wait --wait-timeout "$TIMEOUT")
        if [[ $force == true ]] && saas_in_list "$svc" "${SAAS_SERVER_SERVICES[@]}"; then args+=(--force-recreate); fi
        if [[ $svc == caddy ]]; then
            caddy_id=$(project_containers caddy | head -n 1)
            args+=(--remove-orphans)
        fi
        # Every one of these services has a health check; a container without one (or one
        # that restarts) does not count as started.
        if compose_logged "${args[@]}" "$svc" && service_healthy "$svc"; then
            pass "$svc is healthy"
        else
            fail "$svc did not become healthy"
            saas_print_log "$COMPOSE_LOG" 8
            service_logs "$svc"
            return 1
        fi
    done
    if [[ -n $caddy_id && $caddy_id == "$(project_containers caddy | head -n 1)" &&
        $caddy_before != "$(saas_tree_hash "$CADDY_CONFIG")" ]]; then
        if compose_logged exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
            pass "Caddy reloaded its changed configuration"
        else
            fail "Caddy refused its new configuration"
            saas_print_log "$COMPOSE_LOG" 8
            return 1
        fi
    fi
    # Overlay services (monitoring, backups) are recreated every time, so they read the new
    # configuration files of the release. The app is healthy at this point: a failure here
    # is reported (OVERLAY_PROBLEM) and does not roll the app back.
    if [[ $force != true ]]; then
        info "Overlay services left as they run (this run did not restart them)"
        return 0
    fi
    mapfile -t others < <(other_services)
    if ((${#others[@]} > 0)); then
        if compose_logged up -d --no-deps --force-recreate "${others[@]}" && wait_started "${others[@]}"; then
            pass "Overlay services started: ${others[*]}"
        else
            OVERLAY_PROBLEM="the overlay services did not all start (${others[*]})"
            warn "Overlay services did not all start: ${others[*]}. The app keeps running."
            saas_print_log "$COMPOSE_LOG" 8
            service_logs "${others[@]}"
        fi
        # ops-init writes the Caddy site of the Grafana host into a folder Caddy imports;
        # Caddy reads it on a reload. An unchanged configuration makes the reload a no-op,
        # and a refused one leaves the running configuration in place.
        if saas_in_list ops-init "${others[@]}"; then
            if compose_logged exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile; then
                pass "Caddy read the configuration of the monitoring overlay"
            else
                OVERLAY_PROBLEM="Caddy refused the configuration of the monitoring overlay"
                warn "Caddy refused the configuration of the monitoring overlay and keeps the one it runs"
                saas_print_log "$COMPOSE_LOG" 8
            fi
        fi
    fi
}

# overlay_note: the closing warning when an overlay service needs attention.
overlay_note() {
    [[ -n $OVERLAY_PROBLEM ]] || return 0
    printf '\n'
    warn "The app runs, but $OVERLAY_PROBLEM. Fix the cause and deploy the same release again (docs/saas/deploy.md, Troubleshooting)."
}

# readyz SERVICE PORT: GET /readyz inside the container answers 200 (status ready).
readyz() {
    saas_compose exec -T "$1" wget -q -T 5 -O - "http://127.0.0.1:$2/readyz" 2>/dev/null | grep -q '"status":"ready"'
}

# caddy_get PATH BODY_FILE: HTTP status of https://<domain>:<port>PATH through Caddy on
# this server. The certificate is not checked here (it may still be on its way from
# Let's Encrypt); deploy-prod.yml checks it from the runner.
caddy_get() {
    local domain port
    domain=$(kv_get "$INSTALL_DIR/.env" MSCD_DOMAIN)
    port=$(kv_get "$INSTALL_DIR/.env" MSCD_HTTPS_PORT)
    port=${port:-443}
    curl -sk --noproxy '*' --max-time 40 --resolve "$domain:$port:127.0.0.1" -o "$2" -w '%{http_code}' \
        "https://$domain:$port$1" 2>/dev/null || true
}

# verify_release VERSION: readiness of the server services and the answers through Caddy.
verify_release() {
    local version=$1 deadline=$((SECONDS + VERIFY_TIMEOUT)) entry svc port code body=$WORK/body ok=0 got
    for entry in api:3000 worker:9464 storage-gateway:9464; do
        svc=${entry%%:*} port=${entry#*:}
        while ! readyz "$svc" "$port"; do
            if ((SECONDS > deadline)); then
                fail "$svc does not report ready (/readyz)"
                service_logs "$svc"
                ok=1
                continue 2
            fi
            sleep 2
        done
        pass "$svc reports ready (/readyz)"
    done
    ((ok == 0)) || return 1
    until [[ $(caddy_get /healthz "$body") == 200 ]]; do
        if ((SECONDS > deadline)); then
            fail "https://$(kv_get "$INSTALL_DIR/.env" MSCD_DOMAIN)/healthz does not answer 200 through Caddy"
            service_logs caddy web
            return 1
        fi
        sleep 3
    done
    pass "/healthz answers 200 through Caddy"
    while true; do
        code=$(caddy_get /api/v1/system/profile "$body")
        got=$(grep -o '"version":"[^"]*"' "$body" 2>/dev/null | head -n 1 | cut -d'"' -f4 || true)
        if [[ $code == 200 && $got == "$version" ]] && grep -q '"deploy":"saas"' "$body"; then
            pass "/api/v1/system/profile through Caddy reports version $got (deploy saas)"
            return 0
        fi
        if ((SECONDS > deadline)); then
            fail "/api/v1/system/profile through Caddy answered ${code:-nothing} with version '${got:-none}', expected $version"
            return 1
        fi
        sleep 3
    done
}

# version_newer A B: true when version A is newer than B (x.y.z-rc.n before x.y.z).
version_newer() {
    local a=$1 b=$2 ia ib i
    local -a pa pb
    IFS=. read -r -a pa <<<"${a%%-*}"
    IFS=. read -r -a pb <<<"${b%%-*}"
    for i in 0 1 2; do
        ((pa[i] > pb[i])) && return 0
        ((pa[i] < pb[i])) && return 1
    done
    ia=${a#*-rc.} ib=${b#*-rc.}
    [[ $a == *-rc.* ]] || ia=999999
    [[ $b == *-rc.* ]] || ib=999999
    ((ia > ib))
}

# record_state ACTION VERSION SERVER_REF WEB_REF RELEASE_DIR SAVED
record_state() {
    local action=$1 version=$2 server=$3 web=$4 release=$5 saved=$6 dir keep=() kept=0 name
    saas_write_release_env "$STATE_DIR/current.env" "$version" "$server" "$web" "$release" "$action"
    if [[ -n $saved && -d $saved && $(saas_ref_of "$saved/release.env" server) == "$server" &&
        $(saas_ref_of "$saved/release.env" web) == "$web" ]]; then
        # The same release again (new settings or secrets): not a rollback point of its own.
        rm -rf -- "$saved"
    fi
    saas_prune_dir "$STATE_DIR/saved" '20*' "$SAAS_KEEP_SAVED"
    saas_write_previous
    pass "State: current $version$(if [[ -f $STATE_DIR/previous.env ]]; then printf ', previous %s' "$(kv_get "$STATE_DIR/previous.env" VERSION)"; fi) ($STATE_DIR)"
    keep=("$server" "$web")
    local -A releases=([$release]=1)
    while IFS= read -r dir; do
        kept=$((kept + 1))
        name=$(kv_get "$dir/release.env" RELEASE_DIR)
        if [[ -n $name ]]; then releases[$name]=1; fi
        if ((kept < SAAS_KEEP_RELEASES)); then
            keep+=("$(saas_ref_of "$dir/release.env" server)" "$(saas_ref_of "$dir/release.env" web)")
        fi
    done < <(saas_saved_dirs)
    saas_prune_images "${keep[@]}"
    # Release folders of older versions that no saved release needs; a newer folder may be
    # a release copied for the next deploy.
    if [[ -d $INSTALL_DIR/releases ]]; then
        while IFS= read -r name; do
            dir=$INSTALL_DIR/releases/$name
            [[ -z ${releases[$dir]+x} && $dir != "$RELEASE_DIR" && -f $dir/deploy/scripts/saas-deploy.sh ]] || continue
            if ! saas_valid_version "${name#v}" || ! version_newer "$version" "${name#v}"; then continue; fi
            rm -rf -- "$dir"
        done < <(find "$INSTALL_DIR/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n')
    fi
    saas_prune_logs "$LOG_DIR" "$SAAS_KEEP_LOGS"
}

# current_release: CURRENT_* of state/current.env, or of the .env in place when the state
# is missing. Empty when nothing was deployed.
current_release() {
    CURRENT_VERSION='' CURRENT_SERVER_REF='' CURRENT_WEB_REF=''
    if [[ -f $STATE_DIR/current.env ]]; then
        CURRENT_VERSION=$(kv_get "$STATE_DIR/current.env" VERSION)
        CURRENT_SERVER_REF=$(saas_ref_of "$STATE_DIR/current.env" server)
        CURRENT_WEB_REF=$(saas_ref_of "$STATE_DIR/current.env" web)
    elif [[ -f $INSTALL_DIR/.env ]] && saas_valid_digest "$(kv_get "$INSTALL_DIR/.env" MSCD_SERVER_DIGEST)"; then
        CURRENT_VERSION=$(kv_get "$INSTALL_DIR/.env" MSCD_VERSION)
        CURRENT_VERSION=${CURRENT_VERSION:-unknown}
        CURRENT_SERVER_REF=$(kv_get "$INSTALL_DIR/.env" MSCD_SERVER_IMAGE)@$(kv_get "$INSTALL_DIR/.env" MSCD_SERVER_DIGEST)
        CURRENT_WEB_REF=$(kv_get "$INSTALL_DIR/.env" MSCD_IMAGE)@$(kv_get "$INSTALL_DIR/.env" MSCD_WEB_DIGEST)
        warn "No $STATE_DIR/current.env; the .env in place names version $CURRENT_VERSION"
    fi
}

# save_current DEST: the files in place, with release.env naming the running release.
save_current() {
    local dest=$1
    saas_save_files "$dest"
    if [[ ! -f $dest/release.env ]]; then
        saas_write_release_env "$dest/release.env" "$CURRENT_VERSION" "$CURRENT_SERVER_REF" "$CURRENT_WEB_REF" "" unknown
    fi
}

# repair_switch: while no run holds the lock, the .env in place names the images of
# state/current.env (lib/saas.sh writes the .env first when it moves away from that
# release and last when it moves back). When it does not, an earlier run was stopped hard
# while it switched the files: the copy of the current files that run saved is put back
# first, so the files in place are never saved under the name of another release.
repair_switch() {
    local current=$STATE_DIR/current.env dir found='' version
    [[ -f $current && -f $INSTALL_DIR/.env ]] || return 0
    if saas_env_names_release "$INSTALL_DIR/.env" "$current"; then return 0; fi
    version=$(kv_get "$current" VERSION)
    warn "The files in place name $(in_place_version), but state/current.env names $version: an earlier run stopped while it switched the files"
    while IFS= read -r dir; do
        if saas_env_names_release "$dir/.env" "$current" &&
            [[ $(saas_ref_of "$dir/release.env" server) == "$(saas_ref_of "$current" server)" &&
                $(saas_ref_of "$dir/release.env" web) == "$(saas_ref_of "$current" web)" ]]; then
            found=$dir
            break
        fi
    done < <(saas_saved_dirs
        find "$STATE_DIR" -mindepth 1 -maxdepth 1 -type d -name 'rollback-undo-*' -printf '%p\n' | LC_ALL=C sort -r)
    if [[ -z $found ]]; then
        fail "No saved copy of the files of $version is left to put back" \
            "A person on the server makes /opt/mscd/.env name the images of state/current.env again (docs/saas/deploy.md, When a run is cut off)"
        return 1
    fi
    saas_restore_files "$found" last
    rm -rf -- "$found"
    saas_history repair "done" "$version" "files-from=$(basename -- "$found")"
    pass "The files of $version were put back from $found; this run goes on from there"
}

# in_place_version: the version that the .env in place names.
in_place_version() {
    local version
    version=$(kv_get "$INSTALL_DIR/.env" MSCD_VERSION)
    printf '%s' "${version:-another release}"
}

# rollback_target: the newest saved release other than the one of state/current.env. A
# copy of the current files that a stopped run left is no rollback target; repair_switch
# puts it back.
rollback_target() {
    local dir
    while IFS= read -r dir; do
        if [[ -f $STATE_DIR/current.env ]] && saas_env_names_release "$dir/.env" "$STATE_DIR/current.env"; then
            continue
        fi
        printf '%s\n' "$dir"
        return 0
    done < <(saas_saved_dirs)
}

# restore_saved SAVED VERSION SERVER_REF WEB_REF FORCE: puts the saved files back and
# starts that release again. True when it is healthy.
restore_saved() {
    local saved=$1 version=$2 server=$3 web=$4 force=$5 caddy_before
    caddy_before=$(saas_tree_hash "$CADDY_CONFIG")
    saas_restore_files "$saved" last
    pass "Saved files of $version put back, with the mail settings of this run (they go with smtp.password)"
    saas_pull "$server" && saas_pull "$web" && restart_services "$force" "$caddy_before" && verify_release "$version"
}

# ---------------------------------------------------------------------------
# deploy
# ---------------------------------------------------------------------------

# settings_for_deploy: SAAS_VALUE for the new .env, checked, written to WORK/.env.next.
settings_for_deploy() {
    local example=$RELEASE_DIR/deploy/compose/.env.saas.example name
    saas_resolve_settings "$INSTALL_DIR/.env" "$example"
    saas_set_images "$NEW_SERVER_IMAGE" "$NEW_SERVER_DIGEST" "$NEW_WEB_IMAGE" "$NEW_WEB_DIGEST" "$NEW_VERSION"
    SAAS_VALUE[COMPOSE_PROJECT_NAME]=$MSCD_PROJECT
    SAAS_VALUE[COMPOSE_FILE]=$(saas_compose_list "$RELEASE_DIR/deploy/compose" | paste -sd : -)
    SAAS_VALUE[MSCD_SECRETS_DIR]=$INSTALL_DIR/secrets
    SAAS_VALUE[MSCD_METRICS_DIR]=$INSTALL_DIR/metrics
    SAAS_VALUE[MSCD_SITE_DIR]=$INSTALL_DIR/site
    saas_validate_settings "$TARGET"
    ((FAILURES == 0)) || return 1
    saas_write_env "$WORK/.env.next" "$example"
    saas_compose_check "$WORK/.env.next" || return 1
    for name in MSCD_DOMAIN MSCD_PUBLIC_URL MSCD_TLS_MODE ACME_CA MSCD_SITE_DOMAIN MSCD_SMTP_HOST MSCD_SMTP_PORT MSCD_EDGE_IPV6; do
        detail "$name=${SAAS_VALUE[$name]:-} (${SAAS_SOURCE[$name]:-set by the deploy})"
    done
    if [[ $TARGET == production && ${SAAS_VALUE[ACME_CA]} == *staging* ]]; then
        warn "ACME_CA is the Let's Encrypt staging CA: browsers do not trust its certificates. Set the variable ACME_CA to https://acme-v02.api.letsencrypt.org/directory once the first certificate was issued"
    fi
}

deploy_main() {
    local saved='' caddy_before
    title "MSCD SaaS deploy to $TARGET ($INSTALL_DIR)"
    lock_install
    start_log deploy
    remove_stale_work
    WORK=$(mktemp -d "$INSTALL_DIR/state/.deploy.XXXXXX")
    last_run_note

    step "Refusals: demo images, profiles, settings and files (S-7)"
    saas_refuse_demo "$DIGESTS" "$INSTALL_DIR/.env" "$RELEASE_DIR/deploy/compose/.env.saas.example"
    abort_if_failed
    pass "Nothing of the demo stack"
    host_checks

    step "Release"
    saas_check_release "$RELEASE_DIR" || true
    abort_if_failed
    read_digests "$DIGESTS" || true
    abort_if_failed
    check_signature_option "$NEW_SERVER_REF" "$NEW_WEB_REF"
    abort_if_failed
    current_release
    if [[ -n $CURRENT_VERSION && $CURRENT_VERSION != unknown ]]; then
        if version_newer "$CURRENT_VERSION" "$NEW_VERSION"; then
            die "$NEW_VERSION is older than the running $CURRENT_VERSION. Use the action rollback; nothing was changed."
        fi
        info "Running now: $CURRENT_VERSION"
    else
        info "No release runs here yet: first deploy"
    fi

    step "Values on standard input"
    saas_read_input || true
    abort_if_failed
    pass "${#SAAS_IN[@]} values read (not shown)"

    step "Settings"
    settings_for_deploy || true
    abort_if_failed

    step "Images of $NEW_VERSION"
    verify_images "$NEW_VERSION" "$NEW_SERVER_REF" "$NEW_WEB_REF" || saas_discard_pulled
    abort_if_failed

    step "Database"
    predeploy_check "$CURRENT_VERSION" || true
    abort_if_failed

    # From here on the run changes files: history.log records its start and its result.
    history_start deploy "$NEW_VERSION" "from=${CURRENT_VERSION:-none}"
    PHASE=secrets
    step "Secrets"
    install_secrets "$NEW_SERVER_REF" || true
    stop_if_failed

    PHASE=backup
    step "Pre-deploy database backup"
    predeploy_backup "$CURRENT_VERSION" "$NEW_VERSION" || true
    stop_if_failed

    PHASE=switch
    step "Switching the files to $NEW_VERSION"
    repair_switch || true
    stop_if_failed
    install -d -m 0750 "$STATE_DIR/saved"
    caddy_before=$(saas_tree_hash "$CADDY_CONFIG")
    if [[ -n $CURRENT_VERSION && -f $INSTALL_DIR/.env ]]; then
        saved=$STATE_DIR/saved/$STAMP-$CURRENT_VERSION
        save_current "$saved"
        pass "Files of $CURRENT_VERSION saved to $saved"
    fi
    saas_install_release_files "$WORK/.env.next"
    install -d -m 0755 "$INSTALL_DIR/metrics"
    pass "deploy/ tree, site and .env of $NEW_VERSION installed in $INSTALL_DIR"
    if ! start_data_services; then
        deploy_failed "$saved" health
    fi

    PHASE=migrate
    step "Migrating the database to $NEW_VERSION"
    if ! run_migrate; then
        deploy_failed "$saved" migrate
    fi

    PHASE=restart
    step "Restarting the services"
    if ! restart_services true "$caddy_before"; then
        deploy_failed "$saved" health
    fi

    PHASE=check
    step "Checking $NEW_VERSION"
    if ! verify_release "$NEW_VERSION"; then
        deploy_failed "$saved" health
    fi

    PHASE=record
    step "Recording the release"
    record_state deploy "$NEW_VERSION" "$NEW_SERVER_REF" "$NEW_WEB_REF" "$RELEASE_DIR" "$saved"
    history_end "done" "from=${CURRENT_VERSION:-none}${OVERLAY_PROBLEM:+ overlay=problem}"
    printf '\n%sMSCD %s is deployed to %s and healthy.%s\n' "$C_GREEN$C_BOLD" "$NEW_VERSION" "$TARGET" "$C_RESET"
    overlay_note
    printf '  Log: %s\n' "$LOG_FILE"
}

# run_migrate: migrate of the new release alone; the running services are not touched.
run_migrate() {
    local orgs limit log=$LOG_DIR/migrate-$NEW_VERSION-$STAMP.log name=$MSCD_PROJECT-migrate-$STAMP code=0
    orgs=$(saas_compose exec -T postgres psql -U postgres -d mscd -Atc \
        "select count(*) from pg_namespace where nspname like 'org\_%'" 2>/dev/null | tr -dc '0-9' || true)
    orgs=${orgs:-0}
    limit=$((MIGRATE_BASE_SECONDS + MIGRATE_SECONDS_PER_ORG * orgs))
    info "Migrate of $NEW_VERSION runs alone for at most ${limit}s ($orgs organisation schemas); the services keep running"
    saas_compose_cmd
    timeout --kill-after=30 "$limit" "${SAAS_COMPOSE_CMD[@]}" run --rm --no-deps -T --name "$name" migrate \
        >"$log" 2>&1 || code=$?
    printf '        Migrate log (%s, organisation names hidden):\n' "$log"
    saas_print_log "$log" 200
    if ((code == 0)); then
        pass "Migrations of $NEW_VERSION applied"
        return 0
    fi
    if ((code == 124 || code == 137)); then
        docker rm -f "$name" >/dev/null 2>&1 || true
        fail "Migrate did not finish within ${limit}s and was stopped"
    else
        fail "The migrations of $NEW_VERSION failed (exit code $code)"
    fi
    return 1
}

# deploy_failed SAVED REASON: puts the previous release back (REASON migrate: the services
# never left it; health: they are recreated) and exits 1.
deploy_failed() {
    local saved=$1 reason=$2 force=false
    if [[ -z $saved ]]; then
        history_end failed "reason=$reason first-deploy"
        printf '\n%sThe first deploy of %s did not finish.%s Nothing ran before it, so there is nothing to go back to.\n' \
            "$C_RED$C_BOLD" "$NEW_VERSION" "$C_RESET"
        printf '  Fix the cause above and run the deploy again. Log: %s\n' "$LOG_FILE"
        exit 1
    fi
    [[ $reason == health ]] && force=true
    PHASE=restore
    step "Restoring $CURRENT_VERSION (automatic rollback)"
    if restore_saved "$saved" "$CURRENT_VERSION" "$CURRENT_SERVER_REF" "$CURRENT_WEB_REF" "$force"; then
        rm -rf -- "$saved"
        saas_write_previous
        local keep=("$CURRENT_SERVER_REF" "$CURRENT_WEB_REF") dir kept=0
        while IFS= read -r dir; do
            kept=$((kept + 1))
            ((kept < SAAS_KEEP_RELEASES)) || break
            keep+=("$(saas_ref_of "$dir/release.env" server)" "$(saas_ref_of "$dir/release.env" web)")
        done < <(saas_saved_dirs)
        saas_prune_images "${keep[@]}"
        history_end restored "reason=$reason running=$CURRENT_VERSION"
        printf '\n%sThe deploy of %s failed (%s) and was rolled back automatically. %s is running and healthy.%s\n' \
            "$C_YELLOW$C_BOLD" "$NEW_VERSION" "$reason" "$CURRENT_VERSION" "$C_RESET"
        if [[ $reason == migrate ]]; then
            printf '  The database is not rolled back. Each migration folder (platform, ref and every organisation\n'
            printf '  schema) runs in its own transaction: a folder that failed was rolled back, and the folders that\n'
            printf '  finished stay migrated (the migrate log above lists them). %s works with those migrations\n' "$CURRENT_VERSION"
            printf '  (expand and contract).\n'
        else
            printf '  The database keeps the migrations of %s, which %s supports (expand and contract).\n' "$NEW_VERSION" "$CURRENT_VERSION"
        fi
        printf '  Log: %s\n' "$LOG_FILE"
        exit 1
    fi
    history_end restore-failed "reason=$reason"
    die "The automatic rollback to $CURRENT_VERSION did not finish. The saved files are in $saved; see docs/saas/deploy.md, When a rollback fails."
}

# ---------------------------------------------------------------------------
# rollback
# ---------------------------------------------------------------------------

# mail_settings_for_rollback SAVED: the mail settings that go with the smtp.password this
# rollback writes (SAAS_MAIL_SETTINGS): from standard input, else the environment, else the
# .env in place, else the saved .env of the release to return to. saas_restore_files writes
# them into the .env it puts back.
mail_settings_for_rollback() {
    local saved=$1 name
    for name in "${SAAS_MAIL_SETTINGS[@]}"; do
        saas_setting_from "$name" "$INSTALL_DIR/.env" "$saved/.env" "saved .env of the release to return to"
        saas_check_value "$name" || true
    done
    saas_validate_mail_settings "$TARGET"
    ((FAILURES == 0)) || return 1
    for name in MSCD_SMTP_HOST MSCD_SMTP_PORT; do
        detail "$name=${SAAS_VALUE[$name]:-} (${SAAS_SOURCE[$name]:-not set})"
    done
    # SMTP_USER is a secret of the GitHub environment (K.2): its value is not shown.
    detail "MSCD_SMTP_USER (not shown; ${SAAS_SOURCE[MSCD_SMTP_USER]:-not set})"
    pass "Mail settings for the restored .env, with smtp.password from standard input"
}

rollback_main() {
    local target_saved to_version to_server to_web undo caddy_before file digest_server digest_web
    title "MSCD SaaS rollback on $TARGET ($INSTALL_DIR)"
    lock_install
    start_log rollback
    remove_stale_work
    WORK=$(mktemp -d "$INSTALL_DIR/state/.deploy.XXXXXX")
    last_run_note
    target_saved=$(rollback_target)

    step "Refusals: demo images, profiles, settings and files (S-7)"
    saas_refuse_demo "$DIGESTS" "$INSTALL_DIR/.env" ${target_saved:+"$target_saved/.env"}
    abort_if_failed
    pass "Nothing of the demo stack"
    host_checks

    step "Release to return to"
    current_release
    [[ -n $CURRENT_VERSION ]] || die "No release runs in $INSTALL_DIR, so there is nothing to roll back. Nothing was changed."
    [[ -n $target_saved ]] ||
        die "No earlier release is saved in $STATE_DIR/saved, so there is nothing to roll back to. Nothing was changed."
    to_version=$(kv_get "$target_saved/release.env" VERSION)
    to_server=$(saas_ref_of "$target_saved/release.env" server)
    to_web=$(saas_ref_of "$target_saved/release.env" web)
    if [[ -n $OPT_VERSION && $OPT_VERSION != "$to_version" ]]; then
        die "The release before $CURRENT_VERSION on this server is $to_version, not $OPT_VERSION. Nothing was changed."
    fi
    file=$DIGESTS
    if [[ -f $file && $(saas_json_string "$file" version) == "$to_version" ]]; then
        digest_server=$(saas_json_string "$file" serverImage)@$(saas_json_string "$file" server)
        digest_web=$(saas_json_string "$file" webImage)@$(saas_json_string "$file" web)
        if [[ $digest_server != "$to_server" || $digest_web != "$to_web" ]]; then
            die "digests.json of $to_version names other images than the ones that ran here. Nothing was changed."
        fi
        pass "digests.json of $to_version names the saved images"
    fi
    pass "Rolling back from $CURRENT_VERSION to $to_version (saved $(basename -- "$target_saved"))"
    check_signature_option "$to_server" "$to_web"
    abort_if_failed

    step "Values on standard input"
    saas_read_input || true
    abort_if_failed
    pass "${#SAAS_IN[@]} values read (not shown)"

    step "Mail settings"
    mail_settings_for_rollback "$target_saved" || true
    abort_if_failed

    step "Images of $to_version"
    verify_images "$to_version" "$to_server" "$to_web" || saas_discard_pulled
    abort_if_failed

    step "Database"
    predeploy_check "$CURRENT_VERSION" || true
    abort_if_failed

    history_start rollback "$to_version" "from=$CURRENT_VERSION"
    PHASE=secrets
    step "Secrets"
    install_secrets "$to_server" || true
    stop_if_failed

    PHASE=backup
    step "Pre-rollback database backup"
    predeploy_backup "$CURRENT_VERSION" "$to_version" || true
    stop_if_failed

    PHASE=switch
    step "Switching the files to $to_version"
    repair_switch || true
    stop_if_failed
    # The copy of the current files stays outside the work folder, so repair_switch finds it
    # when this run is stopped hard.
    undo=$STATE_DIR/rollback-undo-$STAMP
    caddy_before=$(saas_tree_hash "$CADDY_CONFIG")
    save_current "$undo"
    saas_restore_files "$target_saved" first
    pass "Saved files of $to_version put back, with the mail settings of this run (the database stays as it is: no down migration)"

    PHASE=restart
    step "Restarting the services"
    if restart_services true "$caddy_before" && { PHASE=check; step "Checking $to_version"; verify_release "$to_version"; }; then
        PHASE=record
        step "Recording the release"
        saas_write_release_env "$STATE_DIR/current.env" "$to_version" "$to_server" "$to_web" \
            "$(kv_get "$target_saved/release.env" RELEASE_DIR)" rollback
        rm -rf -- "$target_saved" "$undo"
        saas_write_previous
        history_end "done" "from=$CURRENT_VERSION"
        pass "State: current $to_version$(if [[ -f $STATE_DIR/previous.env ]]; then printf ', previous %s' "$(kv_get "$STATE_DIR/previous.env" VERSION)"; fi)"
        printf '\n%sMSCD is back on %s and healthy.%s The next rollback goes one release further back.\n' \
            "$C_GREEN$C_BOLD" "$to_version" "$C_RESET"
        overlay_note
        printf '  Log: %s\n' "$LOG_FILE"
        return 0
    fi
    PHASE=restore
    step "Returning to $CURRENT_VERSION"
    if restore_saved "$undo" "$CURRENT_VERSION" "$CURRENT_SERVER_REF" "$CURRENT_WEB_REF" true; then
        rm -rf -- "$undo"
        history_end failed "running=$CURRENT_VERSION"
        printf '\n%sThe rollback to %s failed; %s is running and healthy again.%s\n' \
            "$C_YELLOW$C_BOLD" "$to_version" "$CURRENT_VERSION" "$C_RESET"
        exit 1
    fi
    history_end restore-failed ""
    die "Neither $to_version nor $CURRENT_VERSION became healthy. The files of $CURRENT_VERSION are in $undo; see docs/saas/deploy.md, When a rollback fails."
}

# ---------------------------------------------------------------------------
# check-only
# ---------------------------------------------------------------------------

check_main() {
    local example=$RELEASE_DIR/deploy/compose/.env.saas.example name
    title "MSCD SaaS check-only ($INSTALL_DIR)"
    if [[ -d $INSTALL_DIR ]]; then lock_install; fi

    step "Refusals: demo images, profiles, settings and files (S-7)"
    saas_refuse_demo "$DIGESTS" "$INSTALL_DIR/.env" "$example"
    abort_if_failed
    pass "Nothing of the demo stack"

    step "Checking this server"
    check_privileges
    check_docker
    if [[ $DOCKER_OK == true ]]; then saas_check_host "$MIN_DISK"; fi

    step "Release"
    saas_check_release "$RELEASE_DIR" || true
    WORK=$(mktemp -d)
    if [[ -f $DIGESTS ]]; then
        read_digests "$DIGESTS" || true
    fi
    if [[ -f $example ]]; then
        saas_resolve_settings "$INSTALL_DIR/.env" "$example"
        if [[ -n ${NEW_VERSION:-} ]]; then
            saas_set_images "$NEW_SERVER_IMAGE" "$NEW_SERVER_DIGEST" "$NEW_WEB_IMAGE" "$NEW_WEB_DIGEST" "$NEW_VERSION"
        else
            for name in MSCD_SERVER_IMAGE MSCD_SERVER_DIGEST MSCD_IMAGE MSCD_WEB_DIGEST; do
                saas_setting_from "$name" "$INSTALL_DIR/.env" "$example"
            done
            for name in MSCD_SERVER_IMAGE MSCD_IMAGE; do
                saas_valid_image "${SAAS_VALUE[$name]:-}" || fail "$name '${SAAS_VALUE[$name]:-}' is not an image name"
            done
            for name in MSCD_SERVER_DIGEST MSCD_WEB_DIGEST; do
                saas_valid_digest "${SAAS_VALUE[$name]:-}" ||
                    fail "$name '${SAAS_VALUE[$name]:-}' is not a release digest (no digests.json in $RELEASE_DIR)"
            done
        fi
        SAAS_VALUE[COMPOSE_PROJECT_NAME]=$MSCD_PROJECT
        SAAS_VALUE[MSCD_SECRETS_DIR]=$INSTALL_DIR/secrets
        SAAS_VALUE[MSCD_METRICS_DIR]=$INSTALL_DIR/metrics
        SAAS_VALUE[MSCD_SITE_DIR]=$INSTALL_DIR/site
        step "Settings (checked as for ${TARGET:-production})"
        saas_validate_settings "${TARGET:-production}"
        saas_write_env "$WORK/.env.next" "$example"
        if [[ $DOCKER_OK == true ]]; then saas_compose_check "$WORK/.env.next" || true; fi
    fi

    step "State"
    if [[ -f $INSTALL_DIR/state/current.env ]]; then
        info "Running: $(kv_get "$INSTALL_DIR/state/current.env" VERSION) (since $(kv_get "$INSTALL_DIR/state/current.env" SWITCHED_AT))"
    else
        info "No release recorded in $INSTALL_DIR/state"
    fi
    if [[ -f $INSTALL_DIR/state/previous.env ]]; then
        info "Rollback target: $(kv_get "$INSTALL_DIR/state/previous.env" VERSION)"
    fi
    if [[ -s $STATE_DIR/history.log ]]; then
        info "Last line of state/history.log: $(tail -n 1 -- "$STATE_DIR/history.log")"
    fi
    if [[ -f $STATE_DIR/current.env && -f $INSTALL_DIR/.env ]] &&
        ! saas_env_names_release "$INSTALL_DIR/.env" "$STATE_DIR/current.env"; then
        warn "The files in place name $(in_place_version), but state/current.env names $(kv_get "$STATE_DIR/current.env" VERSION): a run stopped while it switched the files. The next deploy or rollback puts the saved files back first."
    fi
    if ((FAILURES > 0)); then
        printf '\n%s%d check(s) failed.%s Nothing was changed.\n' "$C_RED" "$FAILURES" "$C_RESET"
        exit 1
    fi
    printf '\n%sEvery check passed.%s Nothing was changed.\n' "$C_GREEN$C_BOLD" "$C_RESET"
}

main() {
    # The run carries on when its SSH connection ends (see start_log).
    trap '' HUP
    parse_args "$@"
    INSTALL_DIR=$(absolute_path "${OPT_INSTALL_DIR:-$MSCD_DEFAULT_DIR}")
    RELEASE_DIR=$(absolute_path "${OPT_RELEASE_DIR:-$SCRIPT_DIR/../..}")
    DIGESTS=$(absolute_path "${OPT_DIGESTS:-$RELEASE_DIR/digests.json}")
    STATE_DIR=$INSTALL_DIR/state
    LOG_DIR=$INSTALL_DIR/logs
    CADDY_CONFIG=$INSTALL_DIR/deploy/compose/config/caddy
    STAMP=$(saas_stamp)
    COMPOSE_LOG=/dev/null
    trap cleanup EXIT
    if [[ $ACTION != check-only ]]; then
        [[ -d $INSTALL_DIR && -w $INSTALL_DIR ]] ||
            die "$INSTALL_DIR does not exist or is not writable by $(id -un 2>/dev/null || echo "uid $EUID") (bootstrap-host.sh makes /opt/mscd for the deploy account)"
        install -d -m 0750 "$STATE_DIR"
    fi
    case "$ACTION" in
        deploy) deploy_main ;;
        rollback) rollback_main ;;
        check-only) check_main ;;
    esac
}

main "$@"
