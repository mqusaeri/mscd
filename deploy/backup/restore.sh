#!/usr/bin/env bash
# MSCD SaaS: full restore of a server from the off-site backup (Milestone 2 plan K, M2-S07).
# docs/saas/backup-restore.md, "Full restore onto a new server", is the runbook around it.
#
#   sudo bash /opt/mscd/deploy/backup/restore.sh [--install-dir DIR] [--snapshot ID]
#        [--host-files-snapshot ID] [--vault-at TIME] [--keep-secrets] [--no-timer] [--yes]
#
# Before it runs, the server is bootstrapped (bootstrap-prod.yml, M2-S03) and deploy-prod.yml has
# deployed a release at least as new as the backup, with the same PLATFORM_KEY, STORAGE_KEY and
# AUDIT_ANCHOR_KEY and the BACKUP_* values. That deploy brings the release files, the images, the
# key files and the off-site values; this script brings back the data:
#   1. Checks: the off-site values, the backup tools image, the snapshot to restore (default: the
#      newest database dump; --snapshot names another one, a pre-deploy dump too) and its release,
#      which must not be newer than the release that runs here.
#   2. Fetch: the database dump and the archive of the host files (--host-files-snapshot, default
#      the newest) into <install>/backup/restore-<time> (0700).
#   3. Secrets: the key files of the server must equal those of the backup (else it stops: the
#      data opens only with the keys it was sealed with). Every other secret file of the backup
#      (database passwords, gateway token, object store identity, internal certificates) replaces
#      the one of the deploy; smtp.password and the off-site and monitoring values stay as the
#      deploy wrote them. The files it replaces are kept in secrets-before/ of the restore folder.
#      --keep-secrets skips this step (a restore on the same server, whose secrets are intact).
#   4. Stop: every service stops; the database and vault volumes are deleted.
#   5. Database: PostgreSQL starts on an empty volume (its start-up scripts make the roles with the
#      restored passwords), then pg_restore in one transaction.
#   6. Vault: SeaweedFS starts empty, then rclone copies the off-site vault copy back (--vault-at
#      TIME: the copy as it was then, from the versions the bucket keeps).
#   7. Start: migrate brings the database to the running release; storage-gateway, api, worker,
#      web and caddy start; then ops-init runs once (it makes the database role mscd_monitor of
#      the monitoring again, M2-S08) and the monitoring services start.
#   8. Checks: /readyz of api, worker and storage-gateway, /healthz through Caddy, "mscd-server
#      backup verify" (tenant data keys, vault objects, sealed values, audit chains against their
#      signed anchors) and the organisation count of the dump.
#   9. Timer: on /opt/mscd, mscd-backup.timer is installed (--no-timer skips it).
#
# The output holds steps, versions, timings, sizes and counts; never a secret value, an email
# address or an organisation name. It also goes to <install>/logs/restore-<time>.log.
set -euo pipefail
umask 027

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"
bk_prescan_project "$@"
# shellcheck source=../scripts/lib/common.sh
. "$SCRIPT_DIR/../scripts/lib/common.sh"

readonly LOCK_WAIT_SECONDS=600
readonly WAIT_SECONDS=${MSCD_RESTORE_TIMEOUT:-300}
readonly VERIFY_SAMPLE=3
# Key files that the deploy writes from GitHub and that must equal those of the backup.
readonly KEY_FILES=(platform.key storage.key audit-anchor.key)
# Secret files the deploy owns: kept as they are on the server.
readonly KEEP_FILES=(smtp.password)
readonly APP_ORDER=(storage-gateway api worker web caddy)
readonly NOT_OVERLAY='^(postgres|objectstore|valkey|migrate|cli|backup|storage-gateway|api|worker|web|caddy)$'

usage() {
    sed -n '2,/^set -euo pipefail$/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
}

OPT_INSTALL_DIR=${MSCD_INSTALL_DIR:-/opt/mscd} SNAPSHOT=latest HOST_SNAPSHOT=latest VAULT_AT='' KEEP_SECRETS=false INSTALL_TIMER=true
RESTORE_DIR='' PHASE=checks STARTED=$SECONDS

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --install-dir)
                [[ $# -ge 2 && -n $2 ]] || die "--install-dir needs a folder"
                OPT_INSTALL_DIR=$2
                shift
                ;;
            --install-dir=*) OPT_INSTALL_DIR=${1#*=} ;;
            --snapshot)
                [[ $# -ge 2 && $2 =~ ^(latest|[0-9a-f]{8,64})$ ]] || die "--snapshot needs a snapshot id (backup.sh status lists them) or latest"
                SNAPSHOT=$2
                shift
                ;;
            --host-files-snapshot)
                [[ $# -ge 2 && $2 =~ ^(latest|[0-9a-f]{8,64})$ ]] || die "--host-files-snapshot needs a snapshot id or latest"
                HOST_SNAPSHOT=$2
                shift
                ;;
            --vault-at)
                [[ $# -ge 2 && -n $2 ]] || die "--vault-at needs a time such as 2026-10-01T02:00:00Z"
                VAULT_AT=$2
                shift
                ;;
            --keep-secrets) KEEP_SECRETS=true ;;
            --no-timer) INSTALL_TIMER=false ;;
            -y | --yes) ASSUME_YES=true ;;
            -h | --help)
                usage
                exit 0
                ;;
            *) die "Unknown option $1. See --help" ;;
        esac
        shift
    done
}

start_log() {
    local log
    install -d -m 0750 "$LOG_DIR"
    log=$LOG_DIR/restore-$(bk_stamp).log
    exec > >(tee -a "$log") 2>&1
    info "Log: $log"
}

on_exit() {
    local status=$?
    bk_cleanup
    bk_unlock_note
    if ((status != 0)) && [[ $PHASE != checks && $PHASE != 'done' ]]; then
        printf '\n'
        warn "The restore stopped in the step \"$PHASE\" after $((SECONDS - STARTED)) s."
        detail "Fix the cause shown above and run restore.sh again: it starts over from the off-site copy."
        if [[ -n $RESTORE_DIR ]]; then
            detail "The fetched files and the secret files it replaced are in $RESTORE_DIR."
        fi
        detail "docs/saas/backup-restore.md, Troubleshooting."
    fi
}

running_version() {
    local version
    version=$(kv_get "$STATE_DIR/current.env" VERSION 2>/dev/null || true)
    [[ -n $version ]] || version=$(kv_get "$ENV_FILE" MSCD_VERSION)
    printf '%s' "$version"
}

# choose_snapshot: SNAP_ID, SNAP_TIME, SNAP_VERSION, SNAP_ORGS of the database dump to restore, and
# HOST_ID of the host files.
SNAP_ID='' SNAP_TIME='' SNAP_VERSION='' SNAP_ORGS='' HOST_ID='' HOST_TIME=''
choose_snapshot() {
    local tags key
    bk_read_lines < <(bk_run snapshots </dev/null)
    if [[ $SNAPSHOT == latest ]]; then
        ((${BK_INFO[database_count]:-0} > 0)) || die "The off-site repository holds no database dump yet"
        SNAP_ID=${BK_INFO[database_id]} SNAP_TIME=${BK_INFO[database_time]} tags=${BK_INFO[database_tags]:-}
    else
        local -A all=()
        for key in "${!BK_INFO[@]}"; do all[$key]=${BK_INFO[$key]}; done
        bk_read_lines < <(bk_run show "$SNAPSHOT" </dev/null) || die "Snapshot $SNAPSHOT cannot be read"
        case ${BK_INFO[snapshot_path]:-} in
            /mscd.dump | /pre-deploy.dump) ;;
            *) die "Snapshot $SNAPSHOT holds no database dump" ;;
        esac
        SNAP_ID=${BK_INFO[snapshot_id]} SNAP_TIME=${BK_INFO[snapshot_time]} tags=${BK_INFO[snapshot_tags]:-}
        BK_INFO=()
        for key in "${!all[@]}"; do BK_INFO[$key]=${all[$key]}; done
    fi
    SNAP_VERSION=$(bk_tag "$tags" version)
    SNAP_ORGS=$(bk_tag "$tags" orgs)
    if [[ $KEEP_SECRETS != true ]]; then
        if [[ $HOST_SNAPSHOT == latest ]]; then
            ((${BK_INFO[host_files_count]:-0} > 0)) || die "The off-site repository holds no copy of the host files yet (restore.sh --keep-secrets restores on the server whose secrets are intact)"
            HOST_ID=${BK_INFO[host_files_id]} HOST_TIME=${BK_INFO[host_files_time]}
        else
            HOST_ID=$HOST_SNAPSHOT HOST_TIME='(given)'
        fi
    fi
}

checks() {
    local running svc services
    step "1. Checks"
    bk_check_values || true
    abort_if_failed
    bk_image || true
    abort_if_failed
    bk_prepare_run
    bk_run open </dev/null || die "The off-site repository cannot be opened (see above)"
    choose_snapshot
    pass "Database dump to restore: snapshot $SNAP_ID of $SNAP_TIME ($(bk_age_hours "$SNAP_TIME") hours old), release ${SNAP_VERSION:-unknown}, ${SNAP_ORGS:-?} organisation(s)"
    if [[ $KEEP_SECRETS == true ]]; then
        info "--keep-secrets: the secret files of this server stay as they are"
    else
        pass "Host files to restore: snapshot $HOST_ID of $HOST_TIME"
    fi
    running=$(running_version)
    [[ -n $running ]] || die "No release runs in $INSTALL_DIR (state/current.env). Deploy the release of the backup first with deploy-prod.yml (docs/saas/backup-restore.md, Full restore)"
    if [[ -n $SNAP_VERSION && $SNAP_VERSION != unknown ]] && bk_version_newer "$SNAP_VERSION" "$running"; then
        die "The backup comes from release $SNAP_VERSION, newer than the release $running that runs here. Deploy $SNAP_VERSION (or newer) first with deploy-prod.yml; nothing was changed"
    fi
    pass "Release here: $running (migrate brings the restored database to it)"
    if [[ -n $VAULT_AT ]]; then info "The vault is restored as it was at $VAULT_AT"; fi
    services=$(bk_compose config --services 2>/dev/null || true)
    for svc in postgres objectstore; do
        grep -qx "$svc" <<<"$services" ||
            die "The Compose files of $INSTALL_DIR have no $svc service (COMPOSE_PROFILES needs bundled-db and bundled-s3)"
    done
    if [[ $ASSUME_YES != true ]]; then
        require_terminal_or_yes
        printf '\n'
        warn "This replaces the database and the vault of $INSTALL_DIR with the backup of $SNAP_TIME."
        warn "Every change made after that time is lost. The services stop until the restore ends."
        confirm "Restore now?" || die "Nothing was changed"
    fi
}

fetch() {
    local size
    PHASE=fetch
    step "2. Fetching the backup"
    RESTORE_DIR=$BACKUP_DIR/restore-$(bk_stamp)
    install -d -m 0700 "$RESTORE_DIR"
    if ! bk_run dump-database "$SNAP_ID" </dev/null >"$RESTORE_DIR/mscd.dump"; then
        die "The database dump could not be fetched"
    fi
    [[ $(head -c 5 -- "$RESTORE_DIR/mscd.dump") == PGDMP ]] || die "The fetched file is not a pg_dump custom-format archive"
    size=$(stat -c %s "$RESTORE_DIR/mscd.dump")
    pass "Database dump fetched ($(bk_human "$size"))"
    if [[ $KEEP_SECRETS != true ]]; then
        bk_run dump-host-files "$HOST_ID" </dev/null >"$RESTORE_DIR/host-files.tar" || die "The archive of the host files could not be fetched"
        tar -tf "$RESTORE_DIR/host-files.tar" >/dev/null 2>&1 || die "The archive of the host files cannot be read"
        install -d -m 0700 "$RESTORE_DIR/files"
        tar --numeric-owner -xpf "$RESTORE_DIR/host-files.tar" -C "$RESTORE_DIR/files"
        pass "Host files fetched ($(tar -tf "$RESTORE_DIR/host-files.tar" | grep -vc '/$') files)"
    fi
}

# compact FILE: the content of FILE without white space.
compact() {
    tr -d '[:space:]' <"$1"
}

restore_secrets() {
    local found from name file copied=0 kept=() env_from
    PHASE=secrets
    step "3. Secrets"
    if [[ $KEEP_SECRETS == true ]]; then
        info "Skipped (--keep-secrets)"
        return 0
    fi
    found=$(find "$RESTORE_DIR/files" -mindepth 2 -maxdepth 2 -type f -name postgres-roles.env | head -n 1)
    [[ -n $found ]] || die "The archive holds no secret files (postgres-roles.env)"
    from=$(dirname -- "$found")
    for name in "${KEY_FILES[@]}"; do
        [[ -f $from/$name ]] || die "The archive holds no $name"
        if [[ -f $SECRETS_DIR/$name ]]; then
            if [[ $(compact "$SECRETS_DIR/$name") != "$(compact "$from/$name")" ]]; then
                die "$name of this server differs from $name of the backup. The data opens only with the keys of the backup: set the GitHub secret $(case $name in platform.key) echo PLATFORM_KEY ;; storage.key) echo STORAGE_KEY ;; *) echo AUDIT_ANCHOR_KEY ;; esac) to the key the backup was made with (the owner's offline copy), deploy again, then run restore.sh again. Nothing was changed."
            fi
        else
            cp -p -- "$from/$name" "$SECRETS_DIR/$name"
            info "$name was missing here: taken from the backup"
        fi
    done
    pass "platform.key, storage.key and audit-anchor.key of this server are the keys of the backup"
    install -d -m 0700 "$RESTORE_DIR/secrets-before"
    find "$SECRETS_DIR" -mindepth 1 -maxdepth 1 -type f -exec cp -p -- {} "$RESTORE_DIR/secrets-before/" \;
    for file in "$from"/*; do
        [[ -f $file ]] || continue
        name=$(basename -- "$file")
        if saas_member "$name" "${KEY_FILES[@]}"; then continue; fi
        if saas_member "$name" "${KEEP_FILES[@]}" "audit-anchor.pub" && [[ -f $SECRETS_DIR/$name ]]; then
            kept+=("$name")
            continue
        fi
        cp -p -- "$file" "$SECRETS_DIR/$name.restore"
        mv -f -- "$SECRETS_DIR/$name.restore" "$SECRETS_DIR/$name"
        copied=$((copied + 1))
    done
    fix_secret_owners "$SECRETS_DIR" "" || die "The owners of the secret files could not be set"
    pass "$copied secret file(s) of the backup restored (database passwords, gateway token, object store identity, internal certificates); kept as deployed: ${kept[*]:-none}"
    detail "The files they replaced: $RESTORE_DIR/secrets-before"
    env_from=$(find "$RESTORE_DIR/files" -mindepth 1 -maxdepth 1 -type f -name '.env' | head -n 1)
    if [[ -n $env_from ]]; then
        local differ
        differ=$(diff <(grep -E '^[A-Z_][A-Z0-9_]*=' "$env_from" | LC_ALL=C sort) \
            <(grep -E '^[A-Z_][A-Z0-9_]*=' "$ENV_FILE" | LC_ALL=C sort) | sed -n 's/^[<>] \([A-Z_][A-Z0-9_]*\)=.*/\1/p' |
            LC_ALL=C sort -u | xargs)
        if [[ -n $differ ]]; then
            info "Settings of .env that differ from the backup (the deployed ones stay): $differ"
        else
            info ".env equals the one of the backup"
        fi
    fi
}

# saas_member WORD LIST...: true when WORD is one of LIST.
saas_member() {
    local word=$1 item
    shift
    for item in "$@"; do [[ $item == "$word" ]] && return 0; done
    return 1
}

stop_stack() {
    local name volume
    PHASE=stop
    step "4. Stopping the services and emptying the database and the vault"
    bk_compose stop --timeout 30 >/dev/null 2>&1 || true
    bk_compose rm -f -s postgres objectstore >/dev/null 2>&1 || true
    for name in pgdata s3data; do
        volume=$(bk_volume "$name")
        [[ -n $volume ]] || continue
        docker volume rm "$volume" >/dev/null || die "The volume $volume could not be removed (a container still uses it: docker ps -a)"
        pass "Volume $volume removed"
    done
    pass "Every service of $MSCD_PROJECT is stopped"
}

restore_database() {
    local orgs log start=$SECONDS
    log=$LOG_DIR/restore-pg_restore-$(bk_stamp).log
    PHASE=database
    step "5. Database"
    bk_compose up -d --no-deps --wait --wait-timeout "$WAIT_SECONDS" postgres >/dev/null 2>&1 ||
        die "PostgreSQL did not start on the empty volume (docker compose logs postgres)"
    pass "PostgreSQL started on an empty volume (roles made with the restored passwords)"
    bk_restore_database "$RESTORE_DIR/mscd.dump" "$log" || die "pg_restore failed; the database stays empty (log: $log)"
    orgs=$(bk_db_value "select count(*) from platform.organization where deleted_at is null")
    pass "Database restored in $((SECONDS - start)) s: $orgs organisation(s)"
    if [[ -n $SNAP_ORGS && $orgs != "$SNAP_ORGS" ]]; then
        die "The restored database holds $orgs organisation(s), the dump was taken with $SNAP_ORGS"
    fi
}

restore_vault() {
    local line start=$SECONDS args=()
    PHASE=vault
    step "6. Vault"
    bk_compose up -d --no-deps --wait --wait-timeout "$WAIT_SECONDS" objectstore >/dev/null 2>&1 ||
        die "SeaweedFS did not start on the empty volume (docker compose logs objectstore)"
    bk_put_file "$SECRETS_DIR/s3.access" s3.access || die "s3.access cannot be read"
    bk_put_file "$SECRETS_DIR/s3.secret" s3.secret || die "s3.secret cannot be read"
    if [[ -n $VAULT_AT ]]; then args=("$VAULT_AT"); fi
    line=$(bk_run restore-vault "${args[@]}" </dev/null) || die "The vault copy failed"
    pass "Vault restored in $((SECONDS - start)) s: $(bk_field "$line" copied) object(s) copied, $(bk_field "$line" objects) in the vault bucket"
}

overlay_services() {
    bk_compose config --services 2>/dev/null | grep -Ev "$NOT_OVERLAY" || true
}

# wait_exit SERVICE SECONDS: the one-shot SERVICE ended with exit code 0.
wait_exit() {
    local svc=$1 timeout=$2 start=$SECONDS id state
    while ((SECONDS - start < timeout)); do
        id=$(bk_service_ids "$svc" | head -n 1)
        state=$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$id" 2>/dev/null || echo 'missing 1')
        case $state in
            'exited 0') return 0 ;;
            exited* | dead*) return 1 ;;
        esac
        sleep 2
    done
    return 1
}

start_services() {
    local svc log start=$SECONDS services others=() rest=()
    log=$LOG_DIR/restore-migrate-$(bk_stamp).log
    PHASE=start
    step "7. Migrating and starting"
    bk_migrate "$log" || die "migrate failed on the restored database (log: $log)"
    pass "migrate brought the restored database to $(running_version) in $((SECONDS - start)) s"
    services=$(bk_compose config --services 2>/dev/null)
    for svc in "${APP_ORDER[@]}"; do
        grep -qx "$svc" <<<"$services" || continue
        if bk_compose up -d --no-deps --wait --wait-timeout "$WAIT_SECONDS" --force-recreate "$svc" >/dev/null 2>&1; then
            pass "$svc is healthy"
        else
            die "$svc did not become healthy (docker compose logs $svc)"
        fi
    done
    mapfile -t others < <(overlay_services)
    ((${#others[@]} > 0)) || return 0
    if saas_member ops-init "${others[@]}"; then
        # The restored database has no role mscd_monitor: ops-init makes it again (M2-S08).
        if bk_compose up -d --no-deps --force-recreate ops-init >/dev/null 2>&1 && wait_exit ops-init "$WAIT_SECONDS"; then
            pass "ops-init ran: the monitoring role mscd_monitor exists again"
        else
            warn "ops-init did not finish: the monitoring cannot read the database until it runs (docker compose up -d ops-init, docs/saas/monitoring.md)"
        fi
    fi
    for svc in "${others[@]}"; do [[ $svc == ops-init ]] || rest+=("$svc"); done
    if ((${#rest[@]} > 0)); then
        if bk_compose up -d --no-deps --force-recreate "${rest[@]}" >/dev/null 2>&1; then
            pass "Overlay services started: ${rest[*]}"
        else
            warn "Overlay services did not all start: ${rest[*]} (docker compose ps -a)"
        fi
    fi
    if saas_member ops-init "${others[@]}" && grep -qx caddy <<<"$services"; then
        bk_compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 ||
            warn "Caddy refused the configuration of the monitoring overlay (docs/saas/monitoring.md, Troubleshooting)"
    fi
}

check_restore() {
    local entry svc port domain https_port code verify=$RESTORE_DIR/verify.json newest
    PHASE=check
    step "8. Checks"
    for entry in api:3000 worker:9464 storage-gateway:9464; do
        svc=${entry%%:*} port=${entry#*:}
        if bk_wait "$WAIT_SECONDS" bk_readyz "$svc" "$port"; then
            pass "$svc reports ready (/readyz)"
        else
            fail "$svc does not report ready (/readyz)"
        fi
    done
    if grep -qx caddy <<<"$(bk_compose config --services 2>/dev/null || true)"; then
        domain=$(kv_get "$ENV_FILE" MSCD_DOMAIN)
        https_port=$(kv_get "$ENV_FILE" MSCD_HTTPS_PORT)
        https_port=${https_port:-443}
        # The certificate is not checked here: a new server may still wait for it.
        code=$(curl -sk --noproxy '*' --max-time 30 --resolve "$domain:$https_port:127.0.0.1" -o /dev/null \
            -w '%{http_code}' "https://$domain:$https_port/healthz" 2>/dev/null || true)
        if [[ $code == 200 ]]; then pass "/healthz answers 200 through Caddy"; else fail "/healthz through Caddy answered ${code:-nothing}"; fi
    fi
    if bk_backup_verify "$VERIFY_SAMPLE" "$verify"; then
        pass "backup verify: $(bk_verify_summary "$verify"); data keys, sealed values and audit chains with their signed anchors pass"
    else
        fail "backup verify found problems ($(bk_verify_summary "$verify"))"
        bk_verify_failures "$verify"
        if [[ ! -s $verify ]]; then bk_redact <"$verify.err" | tail -n 5 | sed 's/^/          /'; fi
    fi
    newest=$(bk_db_value "select to_char(max(occurred_at) at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"') from platform.audit_log")
    info "Newest entry of the platform audit log: ${newest:-none} (dump taken $SNAP_TIME)"
    if ((FAILURES > 0)); then
        die "$FAILURES check(s) failed after the restore. The services run; see above and docs/saas/backup-restore.md, Troubleshooting"
    fi
}

finish() {
    PHASE='done'
    if [[ -d $STATE_DIR ]]; then
        printf '%s restore done %s snapshot=%s backup=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(running_version)" \
            "$SNAP_ID" "${SNAP_VERSION:-unknown}" >>"$STATE_DIR/history.log"
    fi
    # The dump and the extracted host files are off-site anyway; what stays is small: the .env and
    # the audit anchor lines of the backup, the replaced secret files and the verify summary.
    if [[ -d $RESTORE_DIR/files ]]; then
        find "$RESTORE_DIR/files" -mindepth 1 -maxdepth 1 -type f -name '.env' -exec mv -f -- {} "$RESTORE_DIR/env-of-the-backup" \;
        find "$RESTORE_DIR/files" -mindepth 1 -maxdepth 1 -type f -name 'anchors.ndjson' -exec mv -f -- {} "$RESTORE_DIR/" \;
        rm -rf -- "$RESTORE_DIR/files"
    fi
    rm -f -- "$RESTORE_DIR/mscd.dump" "$RESTORE_DIR/host-files.tar"
    step "9. Backup timer"
    if [[ $INSTALL_TIMER == true && $INSTALL_DIR == /opt/mscd ]] && command -v systemctl >/dev/null 2>&1; then
        bash "$SCRIPT_DIR/backup.sh" install-timer --install-dir "$INSTALL_DIR" | sed -n 's/^ *\(PASS\|INFO\|WARN\) */\1 /p' | sed 's/^/        /' ||
            warn "mscd-backup.timer could not be installed: sudo bash $SCRIPT_DIR/backup.sh install-timer"
    else
        info "Not installed here (--no-timer, or not /opt/mscd)"
    fi
    printf '\n%sThe restore is done (%s s).%s Snapshot %s of %s, now running release %s.\n' "$C_GREEN$C_BOLD" \
        "$((SECONDS - STARTED))" "$C_RESET" "$SNAP_ID" "$SNAP_TIME" "$(running_version)"
    printf '  Next: take a backup now (sudo systemctl start mscd-backup.service), then follow\n'
    printf '  docs/saas/backup-restore.md, "After a restore". Delete %s once all is well.\n' "$RESTORE_DIR"
}

main() {
    parse_args "$@"
    [[ $EUID -eq 0 ]] || die "restore.sh reads and writes the secret files of every service: run it with sudo"
    bk_init "$OPT_INSTALL_DIR"
    start_log
    title "MSCD restore of $INSTALL_DIR from the off-site backup"
    bk_lock "$LOCK_WAIT_SECONDS" "restore from the off-site backup"
    trap on_exit EXIT
    checks
    fetch
    restore_secrets
    stop_stack
    restore_database
    restore_vault
    start_services
    check_restore
    finish
}

main "$@"
