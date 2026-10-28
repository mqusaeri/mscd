#!/usr/bin/env bash
# MSCD SaaS: restore tests (Milestone 2 plan K, M2-S07; docs/saas/backup-restore.md).
#
#   flock /tmp/mscd-stack.lock bash deploy/backup/restore-test.sh --local
#   bash deploy/backup/restore-test.sh --down        remove what an earlier --local run left
#   bash deploy/backup/restore-test.sh --ci-version  [options]   (restore-test.yml)
#   bash deploy/backup/restore-test.sh --ci          [options]   (restore-test.yml)
#
# --local: the whole backup and restore end to end on this host, on the SaaS test stack of M2-S02
# (deploy/scripts/test/saas-stack.sh, ports 18080 and 18443, so under the host lock):
#   1. Starts the test stack (release images built with a throwaway key set), makes two
#      organisations with "tenant create", lets the worker sign the audit chain heads, and writes
#      probe objects and a sealed probe value ("backup verify --write-probe", MSCD_SAAS_TEST=1).
#   2. Starts a second SeaweedFS that stands in for the off-site bucket. It sits outside the
#      network mscd: the backup container reaches it only through the network egress, which proves
#      the outbound path (mscd is internal). It holds three keys: data, secrets and read-only.
#   3. backup.sh run (database, vault, host files, retention, heartbeat, backup.prom), the
#      pre-deploy copy of saas-deploy.sh (backup.sh --pre-deploy, exit code 3 without values),
#      and the vault guard (a sync that would delete more than allowed, or from an empty vault,
#      changes nothing).
#   4. Loses the server: deletes the stack volumes and every secret file except the keys and the
#      off-site values, makes new secrets and starts an empty stack, as the first deploy of a
#      new server does; checks that a backup now refuses to run on the empty database.
#   5. restore.sh, then checks: backup verify (the same organisations, the probe objects open,
#      data keys, sealed values, audit chains and anchors), the restored secrets, /healthz through
#      Caddy, and a normal backup of the restored server.
#   6. The weekly restore test (--ci below) with the read-only key into a second scratch stack,
#      as a user that is not root, in the docker group (as on a GitHub runner).
#   7. Removes everything it made: containers, networks, volumes, images and folders.
#
# --ci-version: prints version=, snapshot=, time= and orgs= of the newest database dump.
# --ci: the weekly restore test of restore-test.yml. It restores the newest database dump and a
# sample of vault objects into scratch containers, runs migrate of the target release on the
# restored database (the migration rehearsal), starts storage-gateway and api, checks /readyz,
# runs backup verify and SQL checks (organisation count; newest audit_log entry under 26 hours
# old), and writes the measured restore time to the summary.
#   Environment: BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY, BACKUP_S3_SECRET_KEY
#   (the read-only key), BACKUP_RESTIC_PASSWORD, optional BACKUP_S3_REGION; PLATFORM_KEY and
#   STORAGE_KEY (--ci only).
#   Options: --work DIR (default $RUNNER_TEMP/mscd-restore-test), --project NAME (default
#   mscd-restore-test), --release-dir DIR (the repository at the target release; default this
#   repository), --digests FILE (digests.json of the target release) or --server-image REF and
#   --web-image REF, --target-version V, --snapshot ID, --sample N (default 3), --summary FILE,
#   --offsite-network NAME (tests: an extra network of the backup container), --keep.
#
# The output holds versions, timings, sizes and counts, and organisations by id at most; never a
# secret value, an email address or an organisation name (M2-S04, GL-50).
#
# Settings of --local (environment):
#   MSCD_RESTORE_TEST_PROJECT     Compose project, prefix of every name (default mscd-restore-test)
#   MSCD_RESTORE_TEST_DIR         state folder (default /var/tmp/<project>), directly below /tmp or
#                                 /var/tmp; the throwaway key set is made in it, and saas-keys.sh
#                                 refuses a folder with a .git folder above it
#   MSCD_RESTORE_TEST_UID         owner of the off-site values, as the deploy account (default 61007)
#   MSCD_RESTORE_TEST_KEEP        true: keep everything for a look; remove it with --down
#   MSCD_SAAS_TEST_SCAN, MSCD_BUILD_CA   passed to saas-stack.sh (image build)
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$SCRIPT_DIR/../.." && pwd)

MODE='' WORK='' RELEASE_DIR=$REPO_DIR DIGESTS='' SERVER_REF='' WEB_REF='' TARGET_VERSION='' SNAPSHOT=latest
SAMPLE=3 SUMMARY='' OFFSITE_NETWORK='' KEEP=false
PROJECT=${MSCD_RESTORE_TEST_PROJECT:-mscd-restore-test}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --local | --ci | --ci-version | --down)
                [[ -z $MODE ]] || { echo "Give one mode" >&2; exit 2; }
                MODE=${1#--}
                ;;
            --work) WORK=${2:?--work needs a folder}; shift ;;
            --project) PROJECT=${2:?--project needs a name}; shift ;;
            --release-dir) RELEASE_DIR=${2:?--release-dir needs a folder}; shift ;;
            --digests) DIGESTS=${2:?--digests needs a file}; shift ;;
            --server-image) SERVER_REF=${2:?--server-image needs an image reference}; shift ;;
            --web-image) WEB_REF=${2:?--web-image needs an image reference}; shift ;;
            --target-version) TARGET_VERSION=${2:?--target-version needs a version}; shift ;;
            --snapshot) SNAPSHOT=${2:?--snapshot needs an id}; shift ;;
            --sample) SAMPLE=${2:?--sample needs a number}; shift ;;
            --summary) SUMMARY=${2:?--summary needs a file}; shift ;;
            --offsite-network) OFFSITE_NETWORK=${2:?--offsite-network needs a name}; shift ;;
            --keep) KEEP=true ;;
            -h | --help)
                sed -n '2,/^set -euo pipefail$/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
                exit 0
                ;;
            *) echo "Unknown option $1. See --help" >&2; exit 2 ;;
        esac
        shift
    done
    [[ -n $MODE ]] || { echo "Give a mode: --local, --ci-version, --ci or --down. See --help" >&2; exit 2; }
    [[ $PROJECT =~ ^[a-z0-9][a-z0-9_-]{0,36}$ ]] || { echo "The project name must be lower-case letters, digits, '-' or '_' (at most 37)" >&2; exit 2; }
    [[ $SAMPLE =~ ^[0-9]{1,3}$ ]] || { echo "--sample must be a whole number from 0 to 999" >&2; exit 2; }
}

parse_args "$@"

# lib/common.sh reads the project name once, when it is sourced; the --local mode works on the
# test stack of saas-stack.sh, the CI modes on their scratch project.
export COMPOSE_PROJECT_NAME=$PROJECT
# shellcheck source=../scripts/lib/common.sh
. "$REPO_DIR/deploy/scripts/lib/common.sh"
# shellcheck source=lib.sh
. "$SCRIPT_DIR/lib.sh"

readonly SEAWEED_IMAGE=chrislusf/seaweedfs:4.48
readonly OFFSITE_ALIAS=offsite-backup
readonly OFFSITE_BUCKET=mscd-offsite
readonly AUDIT_MAX_HOURS=26
readonly KEEP_KEYS=(platform.key storage.key audit-anchor.key audit-anchor.pub)

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

# free_octets N: N third octets x of 172.31.x.0/24 that no Docker network uses.
free_octets() {
    local want=$1 x base used=() s ip bits b size n=0 ok
    while IFS= read -r s; do
        [[ $s =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)\.([0-9]+)/([0-9]+)$ ]] || continue
        b=$(((BASH_REMATCH[1] << 24) | (BASH_REMATCH[2] << 16) | (BASH_REMATCH[3] << 8) | BASH_REMATCH[4]))
        size=$((1 << (32 - BASH_REMATCH[5])))
        used+=("$((b - b % size)) $size")
    done < <(docker network ls -q | xargs -r docker network inspect --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}' | tr ' ' '\n')
    for x in 250 251 $(seq 249 -1 2); do
        base=$(((172 << 24) | (31 << 16) | (x << 8)))
        ok=true
        for s in "${used[@]}"; do
            ip=${s% *} bits=${s#* }
            if ((base < ip + bits && ip < base + 256)); then ok=false; break; fi
        done
        [[ $ok == true ]] || continue
        printf '%s\n' "$x"
        n=$((n + 1))
        ((n < want)) || return 0
    done
    return 1
}

# json_string FILE NAME: a string field of a flat JSON file (digests.json).
json_string() {
    grep -o "\"$2\" *: *\"[^\"]*\"" "$1" | head -n 1 | sed -E 's/^"[^"]*" *: *"//; s/"$//'
}

# summary LINE: one line of the Markdown summary (--summary FILE), and of the output.
summary() {
    if [[ -n $SUMMARY ]]; then printf '%s\n' "$1" >>"$SUMMARY"; fi
}

# ---------------------------------------------------------------------------
# --ci-version and --ci: the weekly restore test
# ---------------------------------------------------------------------------

CI_COMPOSE_FILES=''

# ci_prepare: the work folder as an install folder of backup.sh: .env, secrets/ (backup/ with the
# off-site values), backup/, logs/; the Compose files of the release with the backup overlay of
# this checkout.
ci_prepare() {
    local name values dir mscd edge owner
    command -v docker >/dev/null 2>&1 || die "docker is not installed"
    docker info >/dev/null 2>&1 || die "Cannot reach the Docker daemon"
    WORK=${WORK:-${RUNNER_TEMP:-/tmp}/mscd-restore-test}
    [[ $WORK == /* && $WORK != / ]] || die "--work must be an absolute folder"
    RELEASE_DIR=$(cd -- "$RELEASE_DIR" && pwd) || die "--release-dir does not exist"
    for name in docker-compose.yml docker-compose.saas.yml .env.saas.example; do
        [[ -f $RELEASE_DIR/deploy/compose/$name ]] || die "$RELEASE_DIR/deploy/compose/$name is missing"
    done
    install -d -m 0700 "$WORK" "$WORK/secrets" "$WORK/backup" "$WORK/logs"
    values=$WORK/secrets/backup
    install -d -m 0700 "$values"
    for name in BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY BACKUP_S3_SECRET_KEY BACKUP_RESTIC_PASSWORD; do
        [[ -n ${!name:-} ]] || die "$name is not set (environment restore-test, docs/saas/backup-restore.md)"
    done
    for name in BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY BACKUP_S3_SECRET_KEY BACKUP_RESTIC_PASSWORD BACKUP_S3_REGION; do
        rm -f -- "$values/$name"
        [[ -n ${!name:-} ]] || continue
        (umask 077 && printf '%s' "${!name}" >"$values/$name")
        chmod 0400 "$values/$name"
    done
    # The backup container never runs as root: as root (a test on a build host) the values
    # belong to a test account, as they belong to the deploy account on a server.
    if [[ $EUID -eq 0 ]]; then
        owner=${MSCD_RESTORE_TEST_UID:-61007}
        chown -R "$owner:$owner" "$values"
    fi
    if [[ ! -f $WORK/.env ]]; then
        read -r mscd edge < <(free_octets 2 | xargs) || die "No two free 172.31.x.0/24 ranges for the scratch networks"
        install -m 0600 "$RELEASE_DIR/deploy/compose/.env.saas.example" "$WORK/.env"
        env_set "$WORK/.env" MSCD_DOMAIN restore-test.invalid
        env_set "$WORK/.env" MSCD_PUBLIC_URL https://restore-test.invalid
        env_set "$WORK/.env" MSCD_TLS_MODE internal
        env_set "$WORK/.env" ACME_EMAIL ''
        env_set "$WORK/.env" MSCD_SMTP_HOST smtp.restore-test.invalid
        env_set "$WORK/.env" MSCD_SMTP_USER ''
        env_set "$WORK/.env" MSCD_SECRETS_DIR "$WORK/secrets"
        env_set "$WORK/.env" MSCD_METRICS_DIR "$WORK/metrics"
        env_set "$WORK/.env" MSCD_SITE_DIR "$WORK/site"
        env_set "$WORK/.env" MSCD_SUBNET "172.31.$mscd.0/24"
        env_set "$WORK/.env" MSCD_WEB_ADDRESS "172.31.$mscd.10"
        env_set "$WORK/.env" MSCD_EDGE_SUBNET "172.31.$edge.0/24"
        env_set "$WORK/.env" MSCD_CADDY_ADDRESS "172.31.$edge.2"
        env_set "$WORK/.env" MSCD_WEB_EDGE_ADDRESS "172.31.$edge.3"
        env_set "$WORK/.env" MSCD_EDGE_IPV6 false
        env_set "$WORK/.env" COMPOSE_PROJECT_NAME "$PROJECT"
    fi
    CI_COMPOSE_FILES=$RELEASE_DIR/deploy/compose/docker-compose.yml:$RELEASE_DIR/deploy/compose/docker-compose.saas.yml:$SCRIPT_DIR/../compose/docker-compose.backup.yml
    if [[ -n $OFFSITE_NETWORK ]]; then
        cat >"$WORK/compose.offsite.yml" <<EOF
# Test only (restore-test.sh --local): the stand-in of the off-site bucket on an extra network.
services:
  backup:
    networks:
      - offsite
networks:
  offsite:
    external: true
    name: $OFFSITE_NETWORK
EOF
        CI_COMPOSE_FILES=$CI_COMPOSE_FILES:$WORK/compose.offsite.yml
    fi
    export MSCD_BACKUP_COMPOSE_DIR=$RELEASE_DIR/deploy/compose MSCD_BACKUP_COMPOSE_FILES=$CI_COMPOSE_FILES
    dir=$WORK
    bk_init "$dir"
}

# ci_images: the server and web images of the target release (digests.json or the options), set
# in .env; the server image is pulled when missing (the workflow logged in to ghcr.io).
ci_images() {
    local server_image server_digest web_image web_digest
    if [[ -n $DIGESTS ]]; then
        [[ -f $DIGESTS ]] || die "$DIGESTS is missing"
        SERVER_REF=$(json_string "$DIGESTS" serverRef)
        WEB_REF=$(json_string "$DIGESTS" webRef)
        [[ -n $TARGET_VERSION ]] || TARGET_VERSION=$(json_string "$DIGESTS" version)
    fi
    [[ $SERVER_REF == *@sha256:* && $WEB_REF == *@sha256:* ]] || die "The images of the target release are unknown: give --digests or --server-image and --web-image (image@sha256:...)"
    server_image=${SERVER_REF%@*} server_digest=${SERVER_REF#*@}
    web_image=${WEB_REF%@*} web_digest=${WEB_REF#*@}
    env_set "$WORK/.env" MSCD_SERVER_IMAGE "$server_image"
    env_set "$WORK/.env" MSCD_SERVER_DIGEST "$server_digest"
    env_set "$WORK/.env" MSCD_IMAGE "$web_image"
    env_set "$WORK/.env" MSCD_WEB_DIGEST "$web_digest"
    env_set "$WORK/.env" MSCD_VERSION "${TARGET_VERSION:-unknown}"
    if ! image_exists "$SERVER_REF"; then
        docker pull --quiet "$SERVER_REF" >/dev/null || die "The server image $SERVER_REF could not be pulled"
    fi
    pass "Server image of the target release ${TARGET_VERSION:-?}: ${server_image##*/}@${server_digest:0:19}"
}

# ci_backup_tools: the backup tools image and an open repository (read only). The restore test
# has the read-only key of the data repository and no second key pair.
ci_backup_tools() {
    step "Backup tools"
    BK_NEEDED_VALUES=(BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY BACKUP_S3_SECRET_KEY BACKUP_RESTIC_PASSWORD)
    bk_check_values || true
    abort_if_failed
    bk_image || true
    abort_if_failed
    bk_prepare_run
    bk_run open </dev/null || die "The off-site repository cannot be opened with the read-only key"
    pass "The off-site repository opens with the read-only key"
}

ci_version_main() {
    local tags
    title "MSCD restore test: the newest database dump" >&2
    ci_prepare >&2
    trap 'bk_cleanup; ci_teardown' EXIT
    ci_backup_tools >&2
    bk_read_lines < <(bk_run snapshots </dev/null)
    ((${BK_INFO[database_count]:-0} > 0)) || die "The off-site repository holds no database dump yet"
    tags=${BK_INFO[database_tags]:-}
    printf 'version=%s\nsnapshot=%s\ntime=%s\norgs=%s\n' "$(bk_tag "$tags" version)" "${BK_INFO[database_id]}" \
        "${BK_INFO[database_time]}" "$(bk_tag "$tags" orgs)"
}

# ci_secrets: the keys from the environment and every other secret new, made as install.sh does;
# the vault keys are copied into the run folder before the files get their service owners.
ci_secrets() {
    local dir=$WORK/secrets name
    step "Secrets"
    for name in PLATFORM_KEY STORAGE_KEY; do
        [[ -n ${!name:-} ]] || die "$name is not set (environment restore-test, decision D-S12)"
    done
    for name in "$dir"/*; do
        if [[ -f $name ]]; then rm -f -- "$name"; fi
    done
    write_secret "$dir" platform.key "$PLATFORM_KEY"
    write_secret "$dir" storage.key "$STORAGE_KEY"
    # shellcheck disable=SC2034  # read by lib/common.sh
    DOCKER_OK=true
    ensure_database_secrets "$dir" >/dev/null || die "The database secrets could not be made"
    ensure_key_secrets "$dir" >/dev/null || die "The gateway token and object store identity could not be made"
    ensure_anchor_key "$dir" "$SERVER_REF" >/dev/null || die "The audit anchor key could not be made"
    ensure_certificates "$dir" >/dev/null || die "The internal certificates could not be made"
    bk_put_file "$dir/s3.access" s3.access || die "s3.access"
    bk_put_file "$dir/s3.secret" s3.secret || die "s3.secret"
    fix_secret_owners "$dir" "$SERVER_REF" || die "The owners of the secret files could not be set"
    pass "platform.key and storage.key of the environment; every other secret made for this test"
}

# ci_vault_sample: the newest N vault objects of each organisation, the objects backup verify
# opens, copied from the off-site copy into the scratch vault.
ci_vault_sample() {
    local list=$BK_RUN_DIR/vault-sample.txt schema line count
    : >"$list"
    if ((SAMPLE > 0)); then
        while IFS= read -r schema; do
            [[ $schema =~ ^org_[a-z0-9_]+$ ]] || continue
            bk_db_psql "select o.external_item_id from $schema.storage_object o
                join $schema.storage_repository r on r.id = o.storage_repository_id
                where r.adapter = 'managed_vault' and o.deleted_at is null and o.hash_algorithm = 'sha256'
                order by o.created_at desc, o.id desc limit $SAMPLE" >>"$list"
        done < <(bk_db_psql "select schema_name from platform.organization
            where deleted_at is null and to_regnamespace(schema_name) is not null order by created_at")
    fi
    count=$(grep -c . "$list" || true)
    if [[ $EUID -eq 0 ]]; then chown "$BK_USER" "$list"; fi
    chmod 0400 "$list"
    if ((count > 0)); then
        line=$(bk_run restore-vault-sample </dev/null) || die "The vault sample could not be copied"
    fi
    VAULT_SAMPLE=$count
    pass "Vault sample: $count object(s) copied ($SAMPLE newest per organisation)"
}

ci_main() {
    local started tags dump_size orgs got audit_age migrate_s verify=$WORK/backup/verify.json line elapsed vault entry svc port
    local snap_id snap_time snap_version snap_orgs restore_start db_start
    VAULT_SAMPLE=0
    title "MSCD restore test (project $PROJECT)"
    started=$SECONDS
    if [[ -n $SUMMARY ]]; then : >"$SUMMARY"; fi
    ci_prepare
    trap 'bk_cleanup; ci_teardown' EXIT
    ci_teardown
    ci_backup_tools

    step "Newest backup"
    if [[ $SNAPSHOT == latest ]]; then
        bk_read_lines < <(bk_run snapshots </dev/null)
        ((${BK_INFO[database_count]:-0} > 0)) || die "The off-site repository holds no database dump yet"
        snap_id=${BK_INFO[database_id]} snap_time=${BK_INFO[database_time]} tags=${BK_INFO[database_tags]:-}
    else
        bk_read_lines < <(bk_run show "$SNAPSHOT" </dev/null)
        [[ -n ${BK_INFO[snapshot_id]:-} ]] || die "Snapshot $SNAPSHOT cannot be read"
        snap_id=${BK_INFO[snapshot_id]} snap_time=${BK_INFO[snapshot_time]} tags=${BK_INFO[snapshot_tags]:-}
    fi
    snap_version=$(bk_tag "$tags" version)
    snap_orgs=$(bk_tag "$tags" orgs)
    pass "Snapshot $snap_id of $snap_time ($(bk_age_hours "$snap_time") hours old), release ${snap_version:-unknown}, ${snap_orgs:-?} organisation(s)"
    if line=$(bk_run vault-size </dev/null); then
        vault="$(bk_field "$line" objects) objects, $(bk_human "$(bk_field "$line" bytes)")"
        info "Off-site vault copy: $vault"
    fi
    ci_images
    [[ -n $TARGET_VERSION ]] || TARGET_VERSION=$snap_version

    restore_start=$SECONDS
    step "Database"
    bk_run dump-database "$snap_id" </dev/null >"$WORK/backup/mscd.dump" || die "The database dump could not be fetched"
    [[ $(head -c 5 -- "$WORK/backup/mscd.dump") == PGDMP ]] || die "The fetched file is not a pg_dump custom-format archive"
    dump_size=$(stat -c %s "$WORK/backup/mscd.dump")
    pass "Dump fetched ($(bk_human "$dump_size")) in $((SECONDS - restore_start)) s"
    ci_secrets
    db_start=$SECONDS
    bk_compose up -d --no-deps --wait --wait-timeout 300 postgres >/dev/null 2>&1 || die "PostgreSQL did not start"
    bk_restore_database "$WORK/backup/mscd.dump" "$WORK/logs/pg_restore.log" || die "pg_restore failed"
    rm -f -- "$WORK/backup/mscd.dump"
    orgs=$(bk_db_value "select count(*) from platform.organization where deleted_at is null")
    pass "Database restored in $((SECONDS - db_start)) s: $orgs organisation(s)"

    step "Vault"
    bk_compose up -d --no-deps --wait --wait-timeout 300 objectstore >/dev/null 2>&1 || die "SeaweedFS did not start"
    ci_vault_sample

    step "Migration to ${TARGET_VERSION:-the target release}"
    line=$SECONDS
    bk_migrate "$WORK/logs/migrate.log" || die "migrate of ${TARGET_VERSION:-the target release} failed on the restored database"
    migrate_s=$((SECONDS - line))
    pass "migrate of ${TARGET_VERSION:-the target release} passed in $migrate_s s"

    step "storage-gateway and api"
    for svc in storage-gateway api; do
        bk_compose up -d --no-deps --wait --wait-timeout 300 "$svc" >/dev/null 2>&1 || die "$svc did not become healthy"
    done
    for entry in api:3000 storage-gateway:9464; do
        svc=${entry%%:*} port=${entry#*:}
        if bk_wait 120 bk_readyz "$svc" "$port"; then pass "$svc reports ready (/readyz)"; else fail "$svc does not report ready (/readyz)"; fi
    done

    step "Checks"
    if bk_backup_verify "$SAMPLE" "$verify"; then
        pass "backup verify: $(bk_verify_summary "$verify")"
    else
        fail "backup verify found problems ($(bk_verify_summary "$verify"))"
        bk_verify_failures "$verify"
        if [[ ! -s $verify ]]; then bk_redact <"$verify.err" | tail -n 5 | sed 's/^/          /'; fi
    fi
    elapsed=$((SECONDS - restore_start))
    if [[ -n $snap_orgs ]]; then
        if [[ $orgs == "$snap_orgs" ]]; then pass "Organisations: $orgs, as when the dump was taken"; else fail "Organisations: $orgs, but the dump was taken with $snap_orgs"; fi
    elif [[ $orgs =~ ^[0-9]+$ ]]; then
        pass "Organisations: $orgs"
    else
        fail "The organisations cannot be counted"
    fi
    audit_age=$(bk_db_value "select coalesce(extract(epoch from now() - max(occurred_at))::bigint, -1) from platform.audit_log")
    if [[ $audit_age =~ ^[0-9]+$ ]] && ((audit_age < AUDIT_MAX_HOURS * 3600)); then
        pass "Newest platform audit_log entry: $((audit_age / 3600)) hours old (under $AUDIT_MAX_HOURS)"
    else
        fail "Newest platform audit_log entry: $([[ $audit_age =~ ^[0-9]+$ ]] && echo "$((audit_age / 3600)) hours old" || echo none), not under $AUDIT_MAX_HOURS hours" \
            "The backup holds no activity of the last day: check the nightly backup (BackupTooOld) and that the server is in use"
    fi

    got=$([[ $FAILURES -eq 0 ]] && echo passed || echo failed)
    summary "## Restore test: $got"
    summary ""
    summary "| Item | Result |"
    summary "|---|---|"
    summary "| Backup | snapshot \`$snap_id\` of $snap_time ($(bk_age_hours "$snap_time") hours old), release ${snap_version:-unknown} |"
    summary "| Target release (migration rehearsal) | ${TARGET_VERSION:-unknown}: migrate passed in $migrate_s s |"
    summary "| Database | dump $(bk_human "$dump_size"), $orgs organisation(s) |"
    summary "| Vault | $VAULT_SAMPLE sampled object(s) restored and opened; off-site copy ${vault:-not counted} |"
    summary "| backup verify | $(bk_verify_summary "$verify") |"
    summary "| Newest platform audit entry | $([[ $audit_age =~ ^[0-9]+$ ]] && echo "$((audit_age / 3600)) hours old" || echo none) |"
    summary "| Restore time objective (measured) | **$((elapsed / 60)) min $((elapsed % 60)) s** for the database, the migration and a vault sample; a full restore also copies the whole off-site vault (docs/saas/backup-restore.md) |"
    summary "| Duration of this job step | $((SECONDS - started)) s |"
    info "Restore time (database, migration, vault sample, checks): $elapsed s"
    if ((FAILURES > 0)); then
        printf '\n%s%d check(s) failed.%s\n' "$C_RED" "$FAILURES" "$C_RESET"
        exit 1
    fi
    printf '\n%sThe restore test passed (restore time %s s).%s\n' "$C_GREEN$C_BOLD" "$elapsed" "$C_RESET"
}

# ci_teardown: the scratch containers, networks and volumes of the project, and the work files
# that hold data (the run folder is removed by bk_cleanup).
ci_teardown() {
    local id
    [[ $KEEP != true ]] || return 0
    bk_compose --profile '*' down --volumes --remove-orphans --timeout 10 >/dev/null 2>&1 || true
    for id in $(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT"); do docker rm -f "$id" >/dev/null 2>&1 || true; done
    for id in $(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT"); do docker volume rm "$id" >/dev/null 2>&1 || true; done
    for id in $(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT"); do docker network rm "$id" >/dev/null 2>&1 || true; done
    rm -f -- "$WORK/backup/mscd.dump"
}

# ---------------------------------------------------------------------------
# --local: end to end on the SaaS test stack
# ---------------------------------------------------------------------------

STATE='' LOGS='' RUN_UID='' OFFSITE='' OFFSITE_NET='' OFFSITE_PORT='' CHECKS=0
declare -A BEFORE=()

ok() {
    CHECKS=$((CHECKS + 1))
    pass "$*"
}

local_settings() {
    STATE=${MSCD_RESTORE_TEST_DIR:-/var/tmp/$PROJECT}
    [[ $STATE =~ ^/(tmp|var/tmp)/[A-Za-z0-9._-]+$ && $STATE != */. && $STATE != */.. ]] ||
        die "MSCD_RESTORE_TEST_DIR must be a folder directly below /tmp or /var/tmp (it is deleted at the end), got '$STATE'"
    LOGS=$STATE-logs
    RUN_UID=${MSCD_RESTORE_TEST_UID:-61007}
    [[ $RUN_UID =~ ^[1-9][0-9]{2,6}$ ]] || die "MSCD_RESTORE_TEST_UID must be a user id (not root)"
    OFFSITE=$PROJECT-offsite
    OFFSITE_NET=$PROJECT-offsite
    export MSCD_SAAS_TEST_PROJECT=$PROJECT MSCD_SAAS_TEST_DIR=$STATE
    export MSCD_BACKUP_IMAGE_NAME=$PROJECT-backup
    unset MSCD_BACKUP_MAX_DELETE
}

stack() {
    bash "$REPO_DIR/deploy/scripts/test/saas-stack.sh" "$@"
}

# compose ARGS...: docker compose of the test stack with the backup overlay.
compose() {
    docker compose --project-name "$PROJECT" --project-directory "$REPO_DIR/deploy/compose" \
        -f "$REPO_DIR/deploy/compose/docker-compose.yml" -f "$REPO_DIR/deploy/compose/docker-compose.saas.yml" \
        -f "$REPO_DIR/deploy/compose/docker-compose.backup.yml" -f "$STATE/compose.test.yml" \
        --env-file "$STATE/.env" "$@"
}

# backup_env: the environment of backup.sh and restore.sh on the test stack. A setting given for
# one call ("MSCD_BACKUP_MAX_DELETE=0 run_backup ...") stays; local_settings clears it once.
backup_env() {
    export COMPOSE_PROJECT_NAME=$PROJECT MSCD_SAAS_TEST=1
    export MSCD_BACKUP_COMPOSE_FILES=docker-compose.yml:docker-compose.saas.yml:docker-compose.backup.yml:$STATE/compose.test.yml
    unset MSCD_BACKUP_COMPOSE_DIR MSCD_BACKUP_ENV_FILE
}

log_has() {
    grep -q -- "$2" "$LOGS/$1.log"
}

show_log() {
    tail -n "${2:-25}" "$LOGS/$1.log" | sed 's/^/        | /'
}

# db SQL: a query of the database mscd as postgres. Standard input is /dev/null: "docker compose
# exec" forwards it, and inside a "while read" loop it would eat the lines of the loop.
db() {
    compose exec -T postgres psql -U postgres -d mscd -v ON_ERROR_STOP=1 -XAtq -c "$1" </dev/null
}

# worker_audit_log: the audit lines of the worker log (redacted) for a failure report.
worker_audit_log() {
    compose logs --no-color --no-log-prefix worker 2>/dev/null | grep -E 'audit' | bk_redact | tail -n 30 >"$LOGS/worker-audit.log" || true
}

# org_ids FILE: the organisation ids of a backup verify summary, sorted, on one line.
org_ids() {
    grep -o '"id": "[0-9a-f-]*"' "$1" | cut -d'"' -f4 | LC_ALL=C sort | xargs
}

# offsite_count PREFIX: objects below PREFIX in the stand-in bucket.
offsite_count() {
    docker run --rm --network "$OFFSITE_NET" -e RCLONE_CONFIG_O_TYPE=s3 -e RCLONE_CONFIG_O_PROVIDER=Other \
        -e RCLONE_CONFIG_O_ENDPOINT="http://$OFFSITE_ALIAS:8333" -e RCLONE_CONFIG_O_ACCESS_KEY_ID=rt-readonly-access \
        -e RCLONE_CONFIG_O_SECRET_ACCESS_KEY=rt-readonly-secret -e RCLONE_CONFIG=/tmp/r.conf --entrypoint sh \
        "$(backup_image)" -c ': >/tmp/r.conf; rclone size --json "o:'"$OFFSITE_BUCKET"'/$1"' sh "$1" 2>/dev/null |
        grep -o '"count":[0-9]*' | cut -d: -f2 || true
}

# caddy_root: Caddy's local root certificate (a new caddy_data volume makes a new one).
caddy_root() {
    compose cp caddy:/data/caddy/pki/authorities/local/root.crt "$STATE/caddy-root.crt" >/dev/null 2>&1 &&
        openssl x509 -in "$STATE/caddy-root.crt" -noout >/dev/null 2>&1
}

backup_image() {
    printf '%s:%s' "$MSCD_BACKUP_IMAGE_NAME" "$(sha256sum <"$REPO_DIR/deploy/docker/backup.Dockerfile" | cut -c1-12)"
}

# docker_shim: a docker command first in PATH for this test, for two kinds of Docker hosts that
# the test stack of saas-stack.sh (M2-S02) does not run on as it is:
#   - Docker before 28 has no "docker save --platform", which the image build uses
#     (build-bundle.sh, M2-S01): the shim drops the option (the test images exist for this host's
#     platform only);
#   - a Docker without the containerd image store finds a locally built image by its tag only,
#     never by the digest that digests.json names: the shim gives the test images by tag to every
#     docker command (an argument equal to serverRef or webRef of <state>/digests.json) and to
#     every docker compose command of the SaaS stack (an added Compose file images.yml).
# Every other command passes through unchanged. Prints the folder of the shim, nothing when this
# Docker needs neither.
docker_shim() {
    local real dir=$STATE-bin save=true store=true
    if [[ $(docker save --help 2>/dev/null | grep -c -- '--platform') -gt 0 ]]; then save=false; fi
    if [[ $(docker info --format '{{json .DriverStatus}}' 2>/dev/null | grep -c 'io.containerd.snapshotter.v1') -gt 0 ]]; then store=false; fi
    [[ $save == true || $store == true ]] || return 0
    real=$(command -v docker)
    install -d -m 0755 "$dir"
    cat >"$dir/docker" <<EOF
#!/usr/bin/env bash
# Test shim of deploy/backup/restore-test.sh (see docker_shim there). Not for a server.
real=$real state=$STATE save=$save store=$store
args=("\$@")
if [[ \$save == true && \${args[0]:-} == save ]]; then
    kept=()
    for ((i = 0; i < \${#args[@]}; i++)); do
        case \${args[i]} in
            --platform) i=\$((i + 1)) ;;
            --platform=*) ;;
            *) kept+=("\${args[i]}") ;;
        esac
    done
    args=("\${kept[@]}")
fi
if [[ \$store == true && -r \$state/digests.json ]]; then
    field() { sed -n "s/.*\"\$1\": *\"\\([^\"]*\\)\".*/\\1/p" "\$state/digests.json" | head -n 1; }
    server_ref=\$(field serverRef) web_ref=\$(field webRef) version=\$(field version)
    server_tag=\${server_ref%@*}:\$version web_tag=\${web_ref%@*}:\$version
    for ((i = 0; i < \${#args[@]}; i++)); do
        [[ \${args[i]} != "\$server_ref" ]] || args[i]=\$server_tag
        [[ \${args[i]} != "\$web_ref" ]] || args[i]=\$web_tag
    done
    if [[ \${args[0]:-} == compose ]] && printf '%s\\n' "\${args[@]}" | grep -q 'docker-compose\.saas\.yml\$'; then
        # Written by root, read by the user of the weekly restore test (check_ci): the same
        # content for both, from digests.json.
        images=\$state-bin/images.yml
        [[ ! -w \$state-bin ]] || {
            echo "# Test only: the test images by tag (restore-test.sh, docker_shim)."
            echo "services:"
            for svc in migrate storage-gateway api worker cli; do
                printf '  %s:\\n    image: %s\\n    pull_policy: never\\n' "\$svc" "\$server_tag"
            done
            printf '  web:\\n    image: %s\\n    pull_policy: never\\n' "\$web_tag"
        } >"\$images"
        out=(compose)
        for ((i = 1; i < \${#args[@]}; i++)); do
            case \${args[i]} in
                -f | --file | -p | --project-name | --project-directory | --env-file | --profile | --ansi | --progress | --parallel)
                    out+=("\${args[i]}" "\${args[i + 1]}")
                    i=\$((i + 1))
                    ;;
                -*) out+=("\${args[i]}") ;;
                *) break ;;
            esac
        done
        out+=(-f "\$images" "\${args[@]:i}")
        args=("\${out[@]}")
    fi
fi
exec "\$real" "\${args[@]}"
EOF
    chmod 0755 "$dir/docker"
    printf '%s' "$dir"
}

start_stack() {
    local shim log
    step "Test stack (saas-stack.sh up)"
    shim=$(docker_shim)
    if [[ -n $shim ]]; then
        export PATH=$shim:$PATH
        warn "Docker $(docker version --format '{{.Client.Version}}' 2>/dev/null) lacks \"docker save --platform\" (Docker 28) or the containerd image store, which the test stack needs: this test runs with the shim $shim/docker (see docker_shim)"
    fi
    if ! stack up >"$LOGS/stack-up.log" 2>&1; then
        show_log stack-up 30
        for log in "$STATE/build.log" "$STATE/build-logs"; do
            if [[ -e $log ]]; then cp -R -- "$log" "$LOGS/" 2>/dev/null || true; fi
        done
        die "The test stack did not start (logs: $LOGS/stack-up.log and the build logs next to it)"
    fi
    ok "Test stack $PROJECT is up (release images built with a throwaway key set)"
    install -d -m 0750 "$STATE/state" "$STATE/backup" "$STATE/logs"
    install -d -m 0755 "$STATE/metrics"
    # The state of a deployed server (saas-deploy.sh writes it), so the backup names the release.
    printf 'VERSION=%s\nSERVER_IMAGE=%s\nSERVER_DIGEST=%s\n' "$(node -p 'require(process.argv[1]).version' "$REPO_DIR/apps/server/package.json")" \
        "$(kv_get "$STATE/.env" MSCD_SERVER_IMAGE)" "$(kv_get "$STATE/.env" MSCD_SERVER_DIGEST)" >"$STATE/state/current.env"
    printf '%s deploy done %s from=none\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(kv_get "$STATE/state/current.env" VERSION)" >"$STATE/state/history.log"
}

# anchor_done SINCE: the worker logged the end of audit.verify-chain after SINCE.
anchor_done() {
    [[ $(compose logs --since "$1" worker 2>/dev/null | grep -c 'audit.verify-chain done') -gt 0 ]]
}

# run_anchor_job: the worker signs the heads of the audit chains (audit.verify-chain), as every night.
run_anchor_job() {
    local since request
    since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    request=restore-test-$(random_hex 6)
    # shellcheck disable=SC2016  # JavaScript, not shell
    compose exec -T worker node --input-type=module -e '
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
if (!id) process.exit(1);
' "$request" >/dev/null 2>&1 || return 1
    bk_wait 120 anchor_done "$since"
}

seed() {
    local slug anchored id schema
    step "Organisations, signed anchors and probes"
    for slug in rtalpha rtbeta; do
        compose run --rm --no-deps -T cli tenant create --slug "$slug" --name "Restore test $slug" >"$LOGS/tenant-$slug.log" 2>&1 ||
            { show_log "tenant-$slug"; die "tenant create $slug failed"; }
    done
    ok "Two organisations made with tenant create"
    # One entry in the audit trail of each organisation, so every chain has a head to sign.
    while IFS='|' read -r id schema; do
        [[ $schema =~ ^org_[a-z0-9_]+$ ]] || continue
        db "insert into $schema.audit_trail (organization_id, actor_kind, action) values ('$id', 'system', 'restore.test')" >/dev/null
    done < <(db "select id, schema_name from platform.organization where deleted_at is null")
    if ! run_anchor_job; then
        worker_audit_log
        die "The worker did not sign the audit chains (audit.verify-chain; log: $LOGS/worker-audit.log)"
    fi
    anchored=$(db "select count(distinct chain) from platform.audit_anchor")
    if ((anchored < 3)); then
        worker_audit_log
        die "Expected signed anchors of the platform chain and both organisations, found $anchored (log: $LOGS/worker-audit.log)"
    fi
    ok "The worker signed the heads of $anchored audit chains (audit.verify-chain)"
    if ! compose run --rm --no-deps -T -e MSCD_SAAS_TEST=1 cli backup verify --write-probe --sample 3 >"$LOGS/verify-before.json" 2>"$LOGS/verify-before.err"; then
        bk_verify_failures "$LOGS/verify-before.json"
        die "backup verify --write-probe failed before the backup"
    fi
    BEFORE[orgs]=$(org_ids "$LOGS/verify-before.json")
    BEFORE[count]=$(db "select count(*) from platform.organization where deleted_at is null")
    BEFORE[dbapp]=$(sha256sum <"$STATE/secrets/db-app.url" | cut -c1-16)
    [[ $(wc -w <<<"${BEFORE[orgs]}") == 2 ]] || die "backup verify did not list the two organisations"
    ok "backup verify --write-probe passed: $(bk_verify_summary "$LOGS/verify-before.json"), one probe object per organisation and a sealed probe value"
}

start_offsite() {
    step "Stand-in of the off-site bucket"
    docker network create --label "com.cyberlentera.mscd.test=$PROJECT" "$OFFSITE_NET" >/dev/null
    install -d -m 0755 "$STATE/offsite"
    cat >"$STATE/offsite/s3.json" <<'EOF'
{"identities":[
 {"name":"data","credentials":[{"accessKey":"rt-data-access","secretKey":"rt-data-secret"}],"actions":["Admin","Read","Write","List","Tagging"]},
 {"name":"secrets","credentials":[{"accessKey":"rt-secrets-access","secretKey":"rt-secrets-secret"}],"actions":["Admin","Read","Write","List","Tagging"]},
 {"name":"readonly","credentials":[{"accessKey":"rt-readonly-access","secretKey":"rt-readonly-secret"}],"actions":["Read","List"]}
]}
EOF
    chmod 0644 "$STATE/offsite/s3.json"
    docker run -d --name "$OFFSITE" --network "$OFFSITE_NET" --network-alias "$OFFSITE_ALIAS" \
        --label "com.cyberlentera.mscd.test=$PROJECT" -p 127.0.0.1::8333 --tmpfs /data:size=1g,mode=1777 \
        -v "$STATE/offsite/s3.json:/etc/offsite-s3.json:ro" --security-opt no-new-privileges:true \
        "$SEAWEED_IMAGE" mini -dir=/data -s3.config=/etc/offsite-s3.json "-bucket=$OFFSITE_BUCKET" >/dev/null
    bk_wait 120 docker exec "$OFFSITE" wget -q -O /dev/null "http://127.0.0.1:8888/buckets/$OFFSITE_BUCKET/" ||
        die "The stand-in of the off-site bucket did not start"
    OFFSITE_PORT=$(docker port "$OFFSITE" 8333/tcp | head -n 1 | sed 's/.*://')
    connect_offsite
    ok "SeaweedFS $SEAWEED_IMAGE stands in for the off-site bucket: outside mscd, joined to the egress network of the stack only"
    write_values
}

# connect_offsite: the stand-in joins the egress network of the stack (the network the backup
# container reaches the internet through); it is never on mscd.
connect_offsite() {
    docker network connect --alias "$OFFSITE_ALIAS" "${PROJECT}_egress" "$OFFSITE" >/dev/null ||
        die "The stand-in could not join ${PROJECT}_egress"
}

disconnect_offsite() {
    docker network disconnect -f "${PROJECT}_egress" "$OFFSITE" >/dev/null 2>&1 || true
}

write_values() {
    local dir=$STATE/secrets/backup
    install -d -m 0700 "$dir"
    printf '%s' "http://$OFFSITE_ALIAS:8333" >"$dir/BACKUP_S3_ENDPOINT"
    printf '%s' "$OFFSITE_BUCKET" >"$dir/BACKUP_S3_BUCKET"
    printf '%s' rt-data-access >"$dir/BACKUP_S3_ACCESS_KEY"
    printf '%s' rt-data-secret >"$dir/BACKUP_S3_SECRET_KEY"
    printf '%s' rt-secrets-access >"$dir/BACKUP_SECRETS_ACCESS_KEY"
    printf '%s' rt-secrets-secret >"$dir/BACKUP_SECRETS_SECRET_KEY"
    random_hex 24 >"$dir/BACKUP_RESTIC_PASSWORD"
    printf '%s' "http://127.0.0.1:$OFFSITE_PORT/healthz" >"$dir/HEARTBEAT_BACKUP_URL"
    chmod 0400 "$dir"/*
    chown -R "$RUN_UID:$RUN_UID" "$dir"
    ok "Off-site values written as deploy-prod.yml does: one file per name in secrets/backup (mode 0400, owner $RUN_UID, not root)"
}

run_backup() {
    local name=$1
    shift
    backup_env
    local rc=0
    bash "$SCRIPT_DIR/backup.sh" "$@" --install-dir "$STATE" >"$LOGS/$name.log" 2>&1 || rc=$?
    return "$rc"
}

check_backup() {
    local metric mode stamp before after line rc schema key dump
    step "Nightly backup (backup.sh run)"
    if run_backup backup-run run && log_has backup-run "The off-site backup is done"; then
        ok "backup.sh run finished: database, vault and host files sent off-site, retention applied"
    else
        show_log backup-run 30
        die "backup.sh run failed (log: $LOGS/backup-run.log)"
    fi
    for line in "Database dump: snapshot" "Vault copy:" "Host files: snapshot" "Retention: 14 daily, 8 weekly, 12 monthly" "Heartbeat sent" "audit anchor line(s) of the last 25 hours"; do
        log_has backup-run "$line" || fail "The backup log has no line \"$line\""
    done
    metric=$STATE/metrics/backup.prom
    mode=$(stat -c '%a' "$metric" 2>/dev/null || true)
    stamp=$(sed -n 's/^mscd_backup_last_success_timestamp_seconds \([0-9]*\)$/\1/p' "$metric" 2>/dev/null || true)
    if [[ $mode == 644 && $(grep -c . "$metric") == 1 && -n $stamp ]] && (($(date +%s) - stamp < 600)); then
        ok "backup.prom holds the single line mscd_backup_last_success_timestamp_seconds $stamp (mode 0644) for node-exporter"
    else
        fail "backup.prom is not as M2-S08 reads it (mode ${mode:-none})"
    fi
    if log_has backup-run "Heartbeat sent" && log_has backup-run "Host files archived:" && ! grep -qiE 'rt-data-secret|rt-secrets-secret|@[a-z0-9.-]+\.[a-z]{2,}|Restore test rt' "$LOGS/backup-run.log"; then
        ok "The heartbeat was pinged; the log names no secret, email address or organisation name"
    else
        fail "The heartbeat or the log is not as expected"
    fi
    before=$(offsite_count vault)
    if [[ ${before:-0} -ge 2 ]]; then
        ok "The off-site vault copy holds $before object(s), the probe objects among them"
    else
        fail "The off-site vault copy holds ${before:-no} objects"
    fi
    if run_backup status status && log_has status "database_count: 1" && log_has status "host_files_count: 1"; then
        ok "backup.sh status lists the database dump and the host files off-site"
    else
        show_log status 20
        fail "backup.sh status does not list the snapshots"
    fi

    step "Pre-deploy copy (the interface of saas-deploy.sh)"
    install -d -m 0700 "$STATE/backup/pre-deploy"
    dump=$STATE/backup/pre-deploy/$(bk_stamp)-1.0.0-to-1.1.0.dump
    compose exec -T postgres pg_dump -U postgres --format=custom --dbname=mscd >"$dump"
    # As saas-deploy.sh leaves it: mode 0600, owned by the deploy account.
    chmod 0600 "$dump"
    chown "$RUN_UID:$RUN_UID" "$dump"
    if run_backup pre-deploy --pre-deploy "$dump" &&
        log_has pre-deploy "Pre-deploy dump sent off-site: snapshot"; then
        ok "backup.sh --pre-deploy <dump> --install-dir <dir> sends the dump off-site with exit code 0"
    else
        show_log pre-deploy 20
        fail "backup.sh --pre-deploy failed"
    fi
    install -d -m 0700 "$STATE/novalues/secrets"
    cp "$STATE/.env" "$STATE/novalues/.env"
    env_set "$STATE/novalues/.env" MSCD_SECRETS_DIR "$STATE/novalues/secrets"
    rc=0
    backup_env
    bash "$SCRIPT_DIR/backup.sh" --pre-deploy "$dump" --install-dir "$STATE/novalues" >"$LOGS/pre-deploy-novalues.log" 2>&1 || rc=$?
    if ((rc == 3)) && log_has pre-deploy-novalues "The off-site backup is not set up"; then
        ok "Without the off-site values --pre-deploy exits with code 3, so the deploy stops (or runs with skip_backup)"
    else
        fail "Without the off-site values --pre-deploy exited with code $rc, expected 3"
    fi
    rm -rf -- "$STATE/novalues"

    step "Vault guard"
    after=$(offsite_count vault)
    # One vault object less in the stack, and no deletion allowed: the sync must change nothing.
    schema=$(db "select schema_name from platform.organization where deleted_at is null order by created_at limit 1")
    key=$(db "select external_item_id from $schema.storage_object order by created_at limit 1")
    docker run --rm --network "${PROJECT}_mscd" -e RCLONE_CONFIG=/tmp/r.conf -e RCLONE_CONFIG_V_TYPE=s3 \
        -e RCLONE_CONFIG_V_PROVIDER=Other -e RCLONE_CONFIG_V_ENDPOINT=http://objectstore:8333 \
        -e RCLONE_CONFIG_V_ACCESS_KEY_ID="$(cat "$STATE/secrets/s3.access")" \
        -e RCLONE_CONFIG_V_SECRET_ACCESS_KEY="$(cat "$STATE/secrets/s3.secret")" --entrypoint sh "$(backup_image)" \
        -c ': >/tmp/r.conf; rclone deletefile "v:mscd-vault/$1"' sh "$key" >"$LOGS/guard-delete.log" 2>&1 ||
        { show_log guard-delete; die "The vault object for the guard test could not be deleted"; }
    rc=0
    MSCD_BACKUP_MAX_DELETE=0 run_backup guard-vault run || rc=$?
    if ((rc != 0)) && log_has guard-vault "the sync would delete more than 0" && [[ $(offsite_count vault) == "$after" ]]; then
        ok "A vault sync that would delete more than allowed stops before it copies or deletes anything ($after objects stay off-site)"
    else
        show_log guard-vault 15
        fail "The vault guard did not stop the sync (exit code $rc)"
    fi
    # An empty vault with the default limits: a copy of far fewer than 100 objects stays whole.
    docker run --rm --network "${PROJECT}_mscd" -e RCLONE_CONFIG=/tmp/r.conf -e RCLONE_CONFIG_V_TYPE=s3 \
        -e RCLONE_CONFIG_V_PROVIDER=Other -e RCLONE_CONFIG_V_ENDPOINT=http://objectstore:8333 \
        -e RCLONE_CONFIG_V_ACCESS_KEY_ID="$(cat "$STATE/secrets/s3.access")" \
        -e RCLONE_CONFIG_V_SECRET_ACCESS_KEY="$(cat "$STATE/secrets/s3.secret")" --entrypoint sh "$(backup_image)" \
        -c ': >/tmp/r.conf; rclone delete v:mscd-vault' >"$LOGS/guard-vault-empty-delete.log" 2>&1 ||
        { show_log guard-vault-empty-delete; die "The vault objects for the empty vault test could not be deleted"; }
    rc=0
    run_backup guard-vault-empty run || rc=$?
    if ((rc != 0)) && log_has guard-vault-empty "The vault bucket holds 0 objects" && log_has guard-vault-empty "the sync would delete more than" &&
        [[ $(offsite_count vault) == "$after" ]]; then
        ok "An empty vault stops the sync with the default limits ($after objects stay off-site, fewer than 100)"
    else
        show_log guard-vault-empty 15
        fail "An empty vault did not stop the sync (exit code $rc)"
    fi
}

lose_server() {
    local name
    step "Losing the server"
    disconnect_offsite
    # Every profile: postgres and objectstore sit in bundled-db and bundled-s3 of COMPOSE_PROFILES,
    # which a --profile option replaces.
    compose --profile '*' down --volumes --remove-orphans --timeout 20 >"$LOGS/down.log" 2>&1 ||
        { show_log down; die "The stack could not be removed"; }
    for name in "$STATE/secrets"/*; do
        [[ -f $name ]] || continue
        saas_member_of "$(basename -- "$name")" "${KEEP_KEYS[@]}" || rm -f -- "$name"
    done
    rm -rf -- "$STATE/metrics/backup.prom" "$STATE/backup/cache"
    ok "Stack volumes and every secret file deleted, except the key files and the off-site values that a deploy brings"
    # A new server: its first deploy makes new secrets and starts an empty stack.
    # shellcheck disable=SC2034  # read by lib/common.sh
    DOCKER_OK=true
    ensure_secrets "$STATE/secrets" "$(kv_get "$STATE/.env" MSCD_SERVER_IMAGE)@$(kv_get "$STATE/.env" MSCD_SERVER_DIGEST)" >"$LOGS/new-secrets.log" 2>&1 ||
        { show_log new-secrets; die "New secrets could not be made"; }
    if ! compose up -d --wait --wait-timeout 600 >"$LOGS/up-empty.log" 2>&1; then
        show_log up-empty
        die "The empty stack did not start"
    fi
    connect_offsite
    bk_wait 60 caddy_root || fail "Caddy's new local root certificate could not be copied"
    if [[ $(db "select count(*) from platform.organization") == 0 &&
        $(sha256sum <"$STATE/secrets/db-app.url" | cut -c1-16) != "${BEFORE[dbapp]}" ]]; then
        ok "New server: an empty database with new passwords, as after the first deploy"
    else
        fail "The new stack is not empty or kept the old passwords"
    fi
    local rc=0
    run_backup guard-empty run || rc=$?
    if ((rc != 0)) && log_has guard-empty "looks like a new server waiting for its restore"; then
        ok "A backup of the empty database is refused while the newest off-site dump holds organisations"
    else
        show_log guard-empty 15
        fail "The backup of the empty database was not refused (exit code $rc)"
    fi
}

saas_member_of() {
    local word=$1 item
    shift
    for item in "$@"; do [[ $item == "$word" ]] && return 0; done
    return 1
}

check_restore() {
    local rc=0 code line summary_line
    step "Restore (restore.sh)"
    backup_env
    bash "$SCRIPT_DIR/restore.sh" --install-dir "$STATE" --yes --no-timer >"$LOGS/restore.log" 2>&1 || rc=$?
    if ((rc == 0)) && log_has restore "The restore is done"; then
        ok "restore.sh finished in $(grep -o 'The restore is done ([0-9]* s)' "$LOGS/restore.log" | grep -o '[0-9]* s')"
    else
        show_log restore 40
        die "restore.sh failed with exit code $rc (log: $LOGS/restore.log)"
    fi
    for line in "are the keys of the backup" "secret file(s) of the backup restored" "Database restored in" "Vault restored in" \
        "migrate brought the restored database" "backup verify:"; do
        log_has restore "$line" || fail "The restore log has no line \"$line\""
    done

    step "After the restore"
    if compose run --rm --no-deps -T cli backup verify --sample 5 >"$LOGS/verify-after.json" 2>"$LOGS/verify-after.err"; then
        ok "backup verify passed: $(bk_verify_summary "$LOGS/verify-after.json")"
    else
        bk_verify_failures "$LOGS/verify-after.json"
        fail "backup verify failed after the restore"
    fi
    if [[ $(org_ids "$LOGS/verify-after.json") == "${BEFORE[orgs]}" && $(db "select count(*) from platform.organization where deleted_at is null") == "${BEFORE[count]}" ]]; then
        ok "The same organisations as before the loss (${BEFORE[count]}, compared by id)"
    else
        fail "The organisations differ from before the loss"
    fi
    summary_line=$(bk_verify_summary "$LOGS/verify-after.json")
    if [[ $summary_line =~ ([0-9]+)\ vault\ object\(s\)\ opened,\ ([0-9]+)\ did\ not ]] && ((BASH_REMATCH[1] >= 2 && BASH_REMATCH[2] == 0)); then
        ok "The probe object of each organisation opens through the gateway (restored vault, restored data keys)"
    else
        fail "The probe objects do not all open"
    fi
    if [[ $(sha256sum <"$STATE/secrets/db-app.url" | cut -c1-16) == "${BEFORE[dbapp]}" ]]; then
        ok "The secret files of the backup are back (db-app.url as before the loss)"
    else
        fail "db-app.url is not the one of the backup"
    fi
    code=$(curl --noproxy '*' -s --max-time 15 --cacert "$STATE/caddy-root.crt" -o /dev/null -w '%{http_code}' \
        "https://localhost:$(kv_get "$STATE/.env" MSCD_HTTPS_PORT)/healthz" || true)
    if [[ $code == 200 ]]; then ok "/healthz answers 200 through Caddy"; else fail "/healthz answered ${code:-nothing} through Caddy"; fi
    if grep -q 'restore done' "$STATE/state/history.log"; then
        ok "state/history.log records the restore"
    else
        fail "state/history.log has no restore line"
    fi
    if run_backup backup-after run && log_has backup-after "The off-site backup is done" && log_has backup-after "Vault copy:"; then
        ok "The restored server backs up as before"
    else
        show_log backup-after 20
        fail "The backup after the restore failed"
    fi
}

check_ci() {
    local rc=0 work=$STATE-ci src=$STATE-ci-src line docker_gid
    step "Weekly restore test (--ci) with the read-only key, as a user that is not root"
    rm -rf -- "$work" "$src"
    # restore-test.yml runs --ci as the runner's user, which is not root and reaches Docker
    # through the docker group: so does this test (setpriv, the user of the off-site values in the
    # group of the Docker socket), from a copy of deploy/ that this user can read (the repository
    # may sit in a home folder of mode 0700). The demo secrets stay out of the copy.
    docker_gid=$(stat -c '%g' /var/run/docker.sock)
    ((docker_gid != 0)) || die "The Docker socket belongs to the group root: the weekly restore test needs a docker group"
    install -d -m 0755 "$src" "$src/deploy"
    cp -R -- "$REPO_DIR/deploy/backup" "$REPO_DIR/deploy/compose" "$REPO_DIR/deploy/docker" "$REPO_DIR/deploy/scripts" "$src/deploy/"
    rm -rf -- "$src/deploy/compose/config/demo-secrets"
    chmod -R a+rX,go-w "$src"
    install -d -m 0700 -o "$RUN_UID" -g "$docker_gid" "$src/home"
    install -m 0644 -o "$RUN_UID" -g "$docker_gid" /dev/null "$LOGS/ci-summary.md"
    setpriv --reuid "$RUN_UID" --regid "$docker_gid" --groups "$docker_gid" --inh-caps=-all --no-new-privs \
        env -i HOME="$src/home" PATH="$PATH" LANG=C.UTF-8 NO_COLOR=1 \
        BACKUP_S3_ENDPOINT="http://$OFFSITE_ALIAS:8333" BACKUP_S3_BUCKET="$OFFSITE_BUCKET" \
        BACKUP_S3_ACCESS_KEY=rt-readonly-access BACKUP_S3_SECRET_KEY=rt-readonly-secret \
        BACKUP_RESTIC_PASSWORD="$(cat "$STATE/secrets/backup/BACKUP_RESTIC_PASSWORD")" \
        PLATFORM_KEY="$(cat "$STATE/keys/production/platform.key")" STORAGE_KEY="$(cat "$STATE/keys/production/storage.key")" \
        MSCD_SAAS_TEST=1 MSCD_BACKUP_IMAGE_NAME="$MSCD_BACKUP_IMAGE_NAME" \
        bash "$src/deploy/backup/restore-test.sh" --ci --project "$PROJECT-ci" --work "$work" --release-dir "$src" \
        --server-image "$(kv_get "$STATE/.env" MSCD_SERVER_IMAGE)@$(kv_get "$STATE/.env" MSCD_SERVER_DIGEST)" \
        --web-image "$(kv_get "$STATE/.env" MSCD_IMAGE)@$(kv_get "$STATE/.env" MSCD_WEB_DIGEST)" \
        --target-version "$(kv_get "$STATE/state/current.env" VERSION)" --offsite-network "$OFFSITE_NET" \
        --summary "$LOGS/ci-summary.md" </dev/null >"$LOGS/ci.log" 2>&1 || rc=$?
    if ((rc == 0)) && log_has ci "The restore test passed" && grep -q 'Restore time objective (measured)' "$LOGS/ci-summary.md"; then
        ok "The weekly restore test passed with the read-only key, as user $RUN_UID of the docker group: $(grep -o 'restore time [0-9]* s' "$LOGS/ci.log" | head -n 1)"
    else
        show_log ci 40
        fail "The weekly restore test failed (exit code $rc, log: $LOGS/ci.log)"
    fi
    for line in "opens with the read-only key" "migrate of" "storage-gateway reports ready" "api reports ready" "backup verify:" "Newest platform audit_log entry"; do
        log_has ci "$line" || fail "The restore test log has no line \"$line\""
    done
    if grep -qiE 'rt-readonly-secret|Restore test rt|@[a-z0-9.-]+\.[a-z]{2,}' "$LOGS/ci.log" "$LOGS/ci-summary.md"; then
        fail "The restore test output names a secret, an organisation or an email address"
    else
        ok "The restore test output and summary hold no secret, organisation name or email address"
    fi
    # As the clean-up step of restore-test.yml: the same user removes the work folder, which holds
    # secret files that --ci gave to the service users.
    if setpriv --reuid "$RUN_UID" --regid "$docker_gid" --groups "$docker_gid" --inh-caps=-all --no-new-privs \
        rm -rf -- "$work" 2>"$LOGS/ci-cleanup.log" && [[ ! -e $work ]]; then
        ok "The user of the weekly restore test removes its work folder, as the clean-up step of restore-test.yml does"
    else
        show_log ci-cleanup 5
        fail "The user of the weekly restore test cannot remove its work folder $work"
    fi
    rm -rf -- "$work" "$src"
}

local_down_quiet() {
    local id
    if [[ -n $OFFSITE ]]; then docker rm -f -v "$OFFSITE" >/dev/null 2>&1 || true; fi
    for id in $(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT-ci"); do docker rm -f -v "$id" >/dev/null 2>&1 || true; done
    for id in $(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT-ci"); do docker volume rm "$id" >/dev/null 2>&1 || true; done
    for id in $(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT-ci"); do docker network rm "$id" >/dev/null 2>&1 || true; done
    if [[ -f $STATE/.env && -f $STATE/compose.test.yml ]]; then
        compose --profile '*' down --volumes --remove-orphans --timeout 20 >/dev/null 2>&1 || true
    fi
    stack down >/dev/null 2>&1 || true
    if [[ -n $OFFSITE_NET ]]; then docker network rm "$OFFSITE_NET" >/dev/null 2>&1 || true; fi
    for id in $(docker images --format '{{.Repository}}:{{.Tag}}' "$MSCD_BACKUP_IMAGE_NAME" 2>/dev/null); do
        docker image rm "$id" >/dev/null 2>&1 || true
    done
    rm -rf -- "$STATE" "$STATE-ci" "$STATE-ci-src" "$STATE-bin"
    # The shim is gone: docker is the real one again.
    PATH=${PATH#"$STATE-bin:"}
    hash -r
}

local_resources() {
    local filter
    for filter in "$PROJECT" "$PROJECT-ci"; do
        [[ -z $(docker ps -aq --filter "label=com.docker.compose.project=$filter") ]] || echo "containers of $filter"
        [[ -z $(docker volume ls -q --filter "label=com.docker.compose.project=$filter") ]] || echo "volumes of $filter"
        [[ -z $(docker network ls -q --filter "label=com.docker.compose.project=$filter") ]] || echo "networks of $filter"
    done
    if docker container inspect "$OFFSITE" >/dev/null 2>&1; then echo "container $OFFSITE"; fi
    if docker network inspect "$OFFSITE_NET" >/dev/null 2>&1; then echo "network $OFFSITE_NET"; fi
    [[ -z $(docker images -q "$MSCD_BACKUP_IMAGE_NAME") ]] || echo "images $MSCD_BACKUP_IMAGE_NAME"
    [[ -z $(docker images -q --filter "reference=localhost/$PROJECT/*") ]] || echo "images localhost/$PROJECT/*"
    for filter in "$STATE" "$STATE-ci" "$STATE-ci-src"; do [[ ! -e $filter ]] || echo "folder $filter"; done
}

local_finish() {
    local status=$?
    if [[ $KEEP == true || ${MSCD_RESTORE_TEST_KEEP:-false} == true ]]; then
        printf '\nKept for a look: project %s, %s. Remove with: %s --down\n' "$PROJECT" "$STATE" "$0"
        exit "$status"
    fi
    step "Clean-up"
    local_down_quiet
    if [[ -n $(local_resources) ]]; then
        local_resources | sed 's/^/        left: /'
        fail "Some parts of $PROJECT could not be removed"
        status=1
    else
        pass "Everything of $PROJECT removed (logs kept in $LOGS)"
    fi
    exit "$status"
}

local_main() {
    local tool
    local_settings
    title "MSCD backup and restore test on the SaaS test stack (project $PROJECT)"
    [[ $EUID -eq 0 ]] || die "Run it as root: it reads and writes the secret files of every service, as the timer and restore.sh do"
    for tool in docker node openssl curl flock tar sha256sum setpriv; do
        command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"
    done
    docker info >/dev/null 2>&1 || die "Cannot reach the Docker daemon"
    step "Clean start"
    if [[ -n $(local_resources) ]]; then
        info "Removing what an earlier run of $PROJECT left behind"
        local_down_quiet
    fi
    rm -rf -- "$LOGS"
    install -d -m 0755 "$LOGS"
    trap local_finish EXIT
    pass "Logs in $LOGS"

    start_stack
    seed
    start_offsite
    check_backup
    lose_server
    check_restore
    check_ci

    if ((FAILURES > 0)); then
        printf '\n%s%d check(s) failed%s, %d passed.\n' "$C_RED" "$FAILURES" "$C_RESET" "$CHECKS"
        exit 1
    fi
    printf '\n%sEvery check passed (%d).%s\n' "$C_GREEN$C_BOLD" "$CHECKS" "$C_RESET"
}

case $MODE in
    local) local_main ;;
    down)
        local_settings
        local_down_quiet
        if [[ -n $(local_resources) ]]; then
            local_resources | sed 's/^/        left: /'
            die "Some parts of $PROJECT could not be removed"
        fi
        pass "Everything of $PROJECT removed"
        ;;
    ci-version) ci_version_main ;;
    ci) ci_main ;;
esac
