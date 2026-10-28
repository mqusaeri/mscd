#!/usr/bin/env bash
# MSCD SaaS backups (Milestone 2 plan K, M2-S07): the daily off-site backup of a SaaS server, the
# off-site copy of a pre-deploy dump, and the backup tools image. docs/saas/backup-restore.md
# explains the whole set-up, the restore and the weekly restore test.
#
#   backup.sh run [--install-dir DIR] [--allow-vault-deletes] [--allow-empty] [--prune|--no-prune]
#   backup.sh --pre-deploy FILE --install-dir DIR
#   backup.sh image [--install-dir DIR]
#   backup.sh status [--install-dir DIR]
#   backup.sh list [--install-dir DIR]
#   backup.sh install-timer
#   backup.sh timer-status [--install-dir DIR]
#   backup.sh deploy-check [--install-dir DIR]
#
# run (the systemd timer mscd-backup.timer, daily at 02:00 UTC, as root): with no downtime,
#   1. pg_dump --format=custom of the database mscd, every org_ schema with it, into the restic
#      repository <bucket>/restic of the off-site bucket;
#   2. rclone sync of the vault bucket to <bucket>/vault (objects are sealed by the gateway);
#   3. a restic copy of the secret files, .env and state/ of the install folder, plus the audit
#      anchor lines the worker logged in the last 25 hours, in the repository <bucket>/secrets,
#      opened with the second key pair;
#   then retention (14 daily, 8 weekly, 12 monthly; unused data pruned on Sundays), a ping of
#   HEARTBEAT_BACKUP_URL and mscd_backup_last_success_timestamp_seconds in
#   <install>/metrics/backup.prom for the monitoring (BackupTooOld, BackupMissing). It waits for a
#   deploy that holds the install folder. Output: <install>/logs/backup-run-<time>.log.
#   Two guards stop a run before it changes the off-site copy: a database without organisations
#   while the newest off-site dump holds some (a new server waiting for its restore; --allow-empty
#   lifts it), and a vault sync while the vault holds fewer objects than the copy by more than a
#   tenth of the copy, or none (--allow-vault-deletes lifts it).
# --pre-deploy (saas-deploy.sh, as the deploy account, while it holds the install folder): sends the
#   dump FILE to the restic repository (tag pre-deploy). Exit code 0: the off-site copy is done;
#   any other code stops the deploy before anything changes (3: the off-site backup is not set up).
# image: builds the backup tools image when this server does not hold it (the deploy runs it).
# status: the newest snapshots, the timer and the last success.
# list: every database and pre-deploy dump off-site (time, id, release), to restore an older one.
# install-timer (root, once per server): installs and starts mscd-backup.timer from
#   <deploy>/host/systemd.
# timer-status: exit code 0 when mscd-backup.timer is installed as this release has it and
#   enabled; otherwise 1 with the reason.
# deploy-check (saas-deploy.sh, at the end of a deploy, as the deploy account): the off-site values,
#   the backup tools image (built when missing) and the timer, as PASS, INFO and WARN lines; exit
#   code 0 whatever it finds (the workflow shows the WARN lines as warnings of the run).
#
# The output holds steps, versions, timings, sizes and counts; never a secret value, an email
# address or an organisation name.
set -euo pipefail
umask 027

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"
bk_prescan_project "$@"
# shellcheck source=../scripts/lib/common.sh
. "$SCRIPT_DIR/../scripts/lib/common.sh"

readonly LOCK_WAIT_SECONDS=10800   # a deploy takes minutes; the timer waits up to 3 hours
readonly KEEP_RUN_LOGS=30
readonly SYSTEMD_DIR=${MSCD_SYSTEMD_DIR:-/etc/systemd/system}
readonly TIMER_INSTALL_DIR=/opt/mscd   # the units run /opt/mscd/deploy/backup/backup.sh
readonly UNITS=(mscd-backup.service mscd-backup.timer)

usage() {
    sed -n '2,/^set -euo pipefail$/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
}

ACTION='' OPT_INSTALL_DIR=${MSCD_INSTALL_DIR:-/opt/mscd} DUMP_FILE='' ALLOW_DELETES=false ALLOW_EMPTY=false PRUNE=auto

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            run | image | status | list | install-timer | timer-status | deploy-check)
                [[ -z $ACTION ]] || die "Give one action"
                ACTION=$1
                ;;
            --install-dir)
                [[ $# -ge 2 && -n $2 ]] || die "--install-dir needs a folder"
                OPT_INSTALL_DIR=$2
                shift
                ;;
            --install-dir=*) OPT_INSTALL_DIR=${1#*=} ;;
            --pre-deploy)
                [[ $# -ge 2 && -n $2 ]] || die "--pre-deploy needs the dump file"
                DUMP_FILE=$2
                shift
                ;;
            --allow-vault-deletes) ALLOW_DELETES=true ;;
            --allow-empty) ALLOW_EMPTY=true ;;
            --prune) PRUNE=true ;;
            --no-prune) PRUNE=false ;;
            -h | --help)
                usage
                exit 0
                ;;
            *) die "Unknown option $1. See --help" ;;
        esac
        shift
    done
    if [[ -n $DUMP_FILE ]]; then
        [[ -z $ACTION ]] || die "--pre-deploy is an action of its own"
        ACTION=pre-deploy
    fi
    ACTION=${ACTION:-run}
}

# start_run_log: the output also goes to <install>/logs/backup-run-<time>.log (newest 30 kept).
start_run_log() {
    local log i
    local -a old
    install -d -m 0750 "$LOG_DIR"
    log=$LOG_DIR/backup-run-$(bk_stamp).log
    exec > >(tee -a "$log") 2>&1
    info "Log: $log"
    mapfile -t old < <(find "$LOG_DIR" -maxdepth 1 -type f -name 'backup-run-*Z.log' -printf '%f\n' | LC_ALL=C sort)
    for ((i = 0; i < ${#old[@]} - KEEP_RUN_LOGS; i++)); do rm -f -- "${LOG_DIR:?}/${old[i]}"; done
}

# host_files_archive: secrets/ (without the off-site and monitoring values, which every deploy writes
# again from GitHub, and the work folders of stopped deploys), .env, state/ and the audit anchor lines
# of the last 25 hours, as one tar file in the run folder (numeric owners and modes kept).
host_files_archive() {
    local archive=$BK_RUN_DIR/host-files.tar anchors=$BK_RUN_DIR/anchors.ndjson count secrets
    secrets=$(basename -- "$SECRETS_DIR")
    bk_compose logs --no-color --no-log-prefix --since 25h worker 2>/dev/null | grep '"event":"audit.anchor"' >"$anchors" || true
    count=$(grep -c . "$anchors" || true)
    local -a parts=(-C "$(dirname -- "$SECRETS_DIR")" "$secrets" -C "$(dirname -- "$ENV_FILE")" "$(basename -- "$ENV_FILE")")
    if [[ -d $STATE_DIR ]]; then parts+=(-C "$INSTALL_DIR" "$(basename -- "$STATE_DIR")"); fi
    parts+=(-C "$BK_RUN_DIR" anchors.ndjson)
    tar --numeric-owner --exclude="$secrets/backup" --exclude="$secrets/ops" \
        --exclude='.deploy.*' --exclude='.restore-env.*' -cf "$archive" "${parts[@]}" ||
        { fail "The archive of the host files could not be written"; return 1; }
    chmod 0400 "$archive"
    chown "$BK_USER" "$archive"
    pass "Host files archived: $(tar -tf "$archive" | grep -vc '/$') files, $count audit anchor line(s) of the last 25 hours ($(bk_human "$(stat -c %s "$archive")"))"
}

# write_metric: backup.prom for the text file collector of node-exporter (M2-S08): the single line
# "mscd_backup_last_success_timestamp_seconds <unix seconds>", written to a temporary file and
# renamed, mode 0644.
write_metric() {
    local tmp now
    now=$(date +%s)
    install -d -m 0755 "$METRICS_DIR"
    tmp=$(mktemp "$METRICS_DIR/.backup.prom.XXXXXX")
    printf 'mscd_backup_last_success_timestamp_seconds %s\n' "$now" >"$tmp"
    chmod 0644 "$tmp"
    if [[ $EUID -eq 0 ]]; then chown "$(stat -c '%u:%g' -- "$METRICS_DIR")" "$tmp"; fi
    mv -f -- "$tmp" "$METRICS_DIR/backup.prom"
    pass "Monitoring: $METRICS_DIR/backup.prom says $(date -u -d "@$now" +%Y-%m-%dT%H:%M:%SZ)"
}

# heartbeat: GET of HEARTBEAT_BACKUP_URL. The address is a secret: it goes to curl in a config on
# standard input, never on a command line or in the output.
heartbeat() {
    local file=$VALUES_DIR/HEARTBEAT_BACKUP_URL url
    if [[ ! -s $file ]]; then
        warn "HEARTBEAT_BACKUP_URL is not set: no heartbeat ping (docs/saas/monitoring.md, heartbeat)"
        return 0
    fi
    url=$(tr -d '\r\n' <"$file")
    if [[ ! $url =~ ^https://[^[:space:]\"]+$ && ! (${MSCD_SAAS_TEST:-} == 1 && $url =~ ^http://[^[:space:]\"]+$) ]]; then
        warn "HEARTBEAT_BACKUP_URL is not an https address: no heartbeat ping"
        return 0
    fi
    if printf 'url = "%s"\n' "$url" | curl -fsS --max-time 20 --retry 3 --retry-delay 5 \
        -o /dev/null -K - 2>/dev/null; then
        pass "Heartbeat sent"
    else
        warn "The heartbeat ping failed; the heartbeat service will report a missing backup"
    fi
}

# empty_database_guard: refuses a run on a database without organisations while the newest
# off-site dump holds some, so a new server waiting for its restore never adds empty dumps.
empty_database_guard() {
    local live held
    live=$(bk_db_psql "select count(*) from platform.organization where deleted_at is null" 2>/dev/null || true)
    [[ $live =~ ^[0-9]+$ ]] || die "The database cannot be read (is PostgreSQL running? docker compose ps postgres)"
    ((live == 0)) || return 0
    bk_read_lines < <(bk_run snapshots </dev/null 2>/dev/null || true)
    held=$(bk_tag "${BK_INFO[database_tags]:-}" orgs)
    if [[ $held =~ ^[0-9]+$ ]] && ((held > 0)); then
        if [[ $ALLOW_EMPTY == true ]]; then
            warn "--allow-empty: the database holds no organisation, the newest off-site dump holds $held"
            return 0
        fi
        die "The database holds no organisation, but the newest off-site dump (${BK_INFO[database_time]:-?}) holds $held. This looks like a new server waiting for its restore: restore it first (docs/saas/backup-restore.md, Full restore), or run backup.sh run --allow-empty when the organisations were really removed. Nothing was backed up."
    fi
}

run_cleanup() {
    bk_cleanup
    bk_unlock_note
}

run_main() {
    local started=$SECONDS line ok=true step_start prune=() vault_args=()
    [[ $EUID -eq 0 ]] || die "backup.sh run reads the secret files of every service: run it as root (the timer does)"
    bk_init "$OPT_INSTALL_DIR"
    start_run_log
    title "MSCD off-site backup of $INSTALL_DIR ($(bk_version))"
    bk_lock "$LOCK_WAIT_SECONDS" "off-site backup"
    trap run_cleanup EXIT

    step "Checks"
    bk_check_values || true
    abort_if_failed
    bk_image || true
    abort_if_failed
    bk_prepare_run
    bk_put_file "$SECRETS_DIR/postgres-admin.password" postgres.password || true
    bk_put_file "$SECRETS_DIR/s3.access" s3.access || true
    bk_put_file "$SECRETS_DIR/s3.secret" s3.secret || true
    abort_if_failed
    if ! bk_run check </dev/null; then die "The off-site repositories cannot be opened (see above)"; fi
    pass "Off-site repositories open"
    empty_database_guard

    step "1. Database"
    step_start=$SECONDS
    if line=$(bk_run database </dev/null); then
        pass "Database dump: snapshot $(bk_field "$line" snapshot), $(bk_human "$(bk_field "$line" bytes)") dumped, $(bk_human "$(bk_field "$line" added)") new off-site, $((SECONDS - step_start)) s"
    else
        fail "The database dump failed"
        ok=false
    fi

    step "2. Vault"
    step_start=$SECONDS
    if [[ $ALLOW_DELETES == true ]]; then
        vault_args=(-e MSCD_BACKUP_MAX_DELETE=-1)
        warn "--allow-vault-deletes: the sync may delete any number of objects in the copy"
    fi
    BK_RUN_ARGS=("${vault_args[@]}")
    if line=$(bk_run vault </dev/null); then
        pass "Vault copy: $(bk_field "$line" copied) object(s) copied, $(bk_field "$line" deleted) removed, $(bk_field "$line" objects) in the copy, $((SECONDS - step_start)) s"
    else
        fail "The vault copy failed"
        ok=false
    fi
    BK_RUN_ARGS=()

    step "3. Secrets, settings and state"
    step_start=$SECONDS
    if host_files_archive && line=$(bk_run host-files </dev/null); then
        pass "Host files: snapshot $(bk_field "$line" snapshot), $((SECONDS - step_start)) s"
    else
        fail "The copy of the host files failed"
        ok=false
    fi

    if [[ $ok != true ]]; then
        printf '\n'
        die "The backup failed after $((SECONDS - started)) s; retention, heartbeat and backup.prom were left as they were"
    fi

    step "Retention"
    if [[ $PRUNE == true || ($PRUNE == auto && $(date -u +%u) == 7) ]]; then prune=(--prune); fi
    if bk_run forget "${prune[@]}" </dev/null; then
        pass "Retention: 14 daily, 8 weekly, 12 monthly${prune:+; unused data pruned}"
    else
        die "Retention failed (the backup itself is done)"
    fi

    step "Reporting"
    heartbeat
    write_metric
    printf '\n%sThe off-site backup is done (%s s).%s\n' "$C_GREEN$C_BOLD" "$((SECONDS - started))" "$C_RESET"
}

pre_deploy_main() {
    local started=$SECONDS file line missing name
    bk_init "$OPT_INSTALL_DIR"
    title "MSCD off-site copy of the pre-deploy dump"
    [[ -f $DUMP_FILE && -r $DUMP_FILE ]] || die "The dump $DUMP_FILE is missing or cannot be read"
    [[ $(head -c 5 -- "$DUMP_FILE") == PGDMP ]] || die "$DUMP_FILE is not a pg_dump custom-format archive"
    file=$(cd -- "$(dirname -- "$DUMP_FILE")" && pwd)/$(basename -- "$DUMP_FILE")
    name=$(basename -- "$file" .dump)
    if [[ ! -d $VALUES_DIR ]]; then
        printf 'FAIL  The off-site backup is not set up (%s does not exist). Set the BACKUP_* secrets of the GitHub environment, or deploy with skip_backup (docs/saas/backup-restore.md)\n' "$VALUES_DIR"
        exit 3
    fi
    missing=$(bk_missing_values | xargs)
    if [[ -n $missing ]]; then
        printf 'FAIL  The off-site backup is not set up (%s missing). Set them in the GitHub environment, or deploy with skip_backup (docs/saas/backup-restore.md)\n' "$missing"
        exit 3
    fi
    trap bk_cleanup EXIT
    bk_check_values || true
    abort_if_failed
    bk_image || true
    abort_if_failed
    bk_prepare_run
    BK_RUN_ARGS=(-v "$file:/run/backup-dump/mscd.dump:ro")
    line=$(bk_run pre-deploy /run/backup-dump/mscd.dump "$name" </dev/null) || die "The off-site copy of the dump failed"
    pass "Pre-deploy dump sent off-site: snapshot $(bk_field "$line" snapshot), $(bk_human "$(bk_field "$line" bytes)"), $((SECONDS - started)) s"
}

image_main() {
    bk_init "$OPT_INSTALL_DIR"
    bk_image || exit 1
}

# timer_problem: why mscd-backup.timer does not run this release's backups (empty when it does).
timer_problem() {
    local unit src=$BK_DEPLOY_DIR/host/systemd
    if ! command -v systemctl >/dev/null 2>&1; then
        echo "systemctl is not available on this host"
        return 0
    fi
    for unit in "${UNITS[@]}"; do
        if [[ ! -f $SYSTEMD_DIR/$unit ]]; then
            echo "mscd-backup.timer is not installed"
            return 0
        fi
        if [[ -f $src/$unit ]] && ! cmp -s "$src/$unit" "$SYSTEMD_DIR/$unit"; then
            echo "$unit differs from the copy of this release"
            return 0
        fi
    done
    if [[ $(systemctl is-enabled mscd-backup.timer 2>/dev/null || true) != enabled ]]; then
        echo "mscd-backup.timer is not enabled"
    elif [[ $(systemctl is-active mscd-backup.timer 2>/dev/null || true) != active ]]; then
        echo "mscd-backup.timer is not active"
    fi
}

timer_status_main() {
    local problem dir
    dir=$(cd -- "$OPT_INSTALL_DIR" 2>/dev/null && pwd) || die "The install folder $OPT_INSTALL_DIR does not exist"
    if [[ $dir != "$TIMER_INSTALL_DIR" ]]; then
        echo "mscd-backup.timer serves $TIMER_INSTALL_DIR only; run backups of $dir with backup.sh run"
        exit 1
    fi
    problem=$(timer_problem)
    if [[ -n $problem ]]; then
        echo "$problem: sudo bash $TIMER_INSTALL_DIR/deploy/backup/backup.sh install-timer (docs/saas/backup-restore.md, Setting up)"
        exit 1
    fi
    echo "mscd-backup.timer is installed, enabled and active"
}

# bk_plain: lines without colour codes and leading spaces.
bk_plain() {
    sed -E -e $'s/\x1b\\[[0-9;]*m//g' -e 's/^ +//'
}

deploy_check_main() {
    local missing problem out value line
    bk_init "$OPT_INSTALL_DIR"
    if [[ ! -d $VALUES_DIR ]]; then
        missing="every BACKUP_* value"
    else
        missing=$(bk_missing_values | xargs)
    fi
    if [[ -n $missing ]]; then
        warn "The off-site backup is not set up ($missing missing): set the BACKUP_* secrets of the GitHub environment and deploy again. Until then no backup runs, and the next deploy stops at its pre-deploy copy unless skip_backup is set (docs/saas/backup-restore.md, Setting up)"
    else
        pass "Off-site backup values are set"
    fi
    if out=$(bk_image 2>&1); then
        pass "$(printf '%s\n' "$out" | bk_plain | sed -n 's/^PASS *//p' | head -n 1)"
    else
        warn "The backup tools image could not be built, so the nightly backup and the pre-deploy copy fail until it is (docs/saas/backup-restore.md, Updating the backup tools)"
        # INFO lines: the deploy (backup_setup of saas-deploy.sh) passes on PASS, INFO and WARN
        # lines only, and the reason (such as a pinned package that Alpine replaced) must reach
        # its log and the workflow summary.
        while IFS= read -r line; do
            info "Image build: $line"
        done < <(printf '%s\n' "$out" | bk_plain | grep -vE '^(FAIL|INFO|PASS)( |$)' | grep -v '^$' | tail -n 6 | bk_redact)
    fi
    if [[ $INSTALL_DIR != "$TIMER_INSTALL_DIR" ]]; then
        info "mscd-backup.timer serves $TIMER_INSTALL_DIR only; this install folder backs up with backup.sh run"
    else
        problem=$(timer_problem)
        if [[ -n $problem ]]; then
            warn "$problem, so no nightly backup runs. An admin of the server runs once: sudo bash $TIMER_INSTALL_DIR/deploy/backup/backup.sh install-timer (docs/saas/backup-restore.md, Setting up)"
        else
            pass "mscd-backup.timer is installed, enabled and active (02:00 UTC)"
        fi
    fi
    if [[ -f $METRICS_DIR/backup.prom ]]; then
        value=$(sed -n 's/^mscd_backup_last_success_timestamp_seconds //p' "$METRICS_DIR/backup.prom")
        if [[ $value =~ ^[0-9]+$ ]]; then info "Last successful off-site backup: $((($(date +%s) - value) / 3600)) hours ago"; fi
    fi
    return 0
}

status_main() {
    local line key value problem
    bk_init "$OPT_INSTALL_DIR"
    title "MSCD off-site backup status of $INSTALL_DIR"
    step "Last success"
    if [[ -f $METRICS_DIR/backup.prom ]]; then
        value=$(sed -n 's/^mscd_backup_last_success_timestamp_seconds //p' "$METRICS_DIR/backup.prom")
        info "Last successful backup: $(date -u -d "@${value:-0}" +%Y-%m-%dT%H:%M:%SZ) ($((($(date +%s) - ${value:-0}) / 3600)) hours ago)"
    else
        warn "No successful backup recorded yet ($METRICS_DIR/backup.prom)"
    fi
    step "Timer"
    if [[ $INSTALL_DIR != "$TIMER_INSTALL_DIR" ]]; then
        info "mscd-backup.timer serves $TIMER_INSTALL_DIR only"
    else
        problem=$(timer_problem)
        if [[ -n $problem ]]; then
            warn "$problem: sudo bash $SCRIPT_DIR/backup.sh install-timer"
        else
            info "mscd-backup.timer is installed, enabled and active"
            systemctl list-timers mscd-backup.timer --no-pager 2>/dev/null | sed 's/^/        /' || true
        fi
    fi
    step "Off-site snapshots"
    bk_check_values || true
    abort_if_failed
    image_exists "${MSCD_BACKUP_IMAGE_NAME:-mscd-backup}:$(sha256sum <"$BK_DEPLOY_DIR/docker/backup.Dockerfile" | cut -c1-12)" ||
        die "The backup tools image is not on this server yet: backup.sh image"
    bk_image >/dev/null
    trap bk_cleanup EXIT
    bk_prepare_run
    while IFS= read -r line; do
        key=${line%%=*}
        value=${line#*=}
        info "$key: $value"
    done < <(bk_run snapshots </dev/null)
}

list_main() {
    bk_init "$OPT_INSTALL_DIR"
    bk_check_values >/dev/null || true
    abort_if_failed
    bk_image >/dev/null || exit 1
    trap bk_cleanup EXIT
    bk_prepare_run
    printf '%-21s %-9s %-17s %s\n' TIME ID FILE TAGS
    bk_run list </dev/null | while read -r time id path tags; do
        printf '%-21s %-9s %-17s %s\n' "$time" "$id" "${path#/}" "$tags"
    done
}

install_timer_main() {
    local unit src=$BK_DEPLOY_DIR/host/systemd changed=false
    [[ $EUID -eq 0 ]] || die "install-timer writes $SYSTEMD_DIR: run it with sudo"
    command -v systemctl >/dev/null 2>&1 || die "systemctl is not available on this host"
    [[ $OPT_INSTALL_DIR == "$TIMER_INSTALL_DIR" ]] || die "The timer runs $TIMER_INSTALL_DIR/deploy/backup/backup.sh; other install folders are not supported"
    [[ -f $TIMER_INSTALL_DIR/deploy/backup/backup.sh ]] || die "$TIMER_INSTALL_DIR/deploy/backup/backup.sh is missing: deploy a release with backups first"
    title "Installing mscd-backup.timer"
    for unit in "${UNITS[@]}"; do
        [[ -f $src/$unit ]] || die "$src/$unit is missing in this release"
        if cmp -s "$src/$unit" "$SYSTEMD_DIR/$unit"; then
            pass "$SYSTEMD_DIR/$unit is up to date"
        else
            install -m 0644 -o root -g root "$src/$unit" "$SYSTEMD_DIR/$unit"
            pass "$SYSTEMD_DIR/$unit installed"
            changed=true
        fi
    done
    if [[ $changed == true ]]; then systemctl daemon-reload; fi
    systemctl enable --now mscd-backup.timer >/dev/null 2>&1 || die "systemctl enable --now mscd-backup.timer failed"
    pass "mscd-backup.timer is $(systemctl is-enabled mscd-backup.timer) and $(systemctl is-active mscd-backup.timer)"
    systemctl list-timers mscd-backup.timer --no-pager | sed 's/^/        /'
    info "Run a backup now with: sudo systemctl start mscd-backup.service (output: journalctl -u mscd-backup.service)"
}

main() {
    parse_args "$@"
    case $ACTION in
        run) run_main ;;
        pre-deploy) pre_deploy_main ;;
        image) image_main ;;
        status) status_main ;;
        list) list_main ;;
        install-timer) install_timer_main ;;
        timer-status) timer_status_main ;;
        deploy-check) deploy_check_main ;;
    esac
}

main "$@"
