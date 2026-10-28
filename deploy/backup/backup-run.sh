#!/usr/bin/env bash
# MSCD SaaS backups: the commands of the backup container (Milestone 2 plan K, M2-S07). Runs inside
# the image of deploy/docker/backup.Dockerfile as the owner of the off-site value files, started by
# backup.sh, restore.sh and restore-test.sh with "docker compose run --rm -T backup <command>".
#
# Commands (messages go to standard error; standard output carries data and key=value lines):
#   check                   the off-site values are set and both restic repositories open
#                           (each is made the first time)
#   open                    the data repository opens, read only (works with a read-only key;
#                           nothing is made)
#   database                pg_dump --format=custom of the database mscd, every org_ schema with it,
#                           into the restic repository <bucket>/restic (tag database)
#   pre-deploy FILE NAME    the pre-deploy dump FILE (mounted) into the same repository (tag pre-deploy)
#   vault                   rclone sync of the vault bucket to <bucket>/vault, user metadata included
#   host-files              /run/backup-run/host-files.tar into the restic repository <bucket>/secrets,
#                           opened with the second key pair (BACKUP_SECRETS_*)
#   forget [--prune]        retention of both repositories: 14 daily, 8 weekly, 12 monthly (D-S6)
#   snapshots               key=value lines about the newest snapshots (times, versions, counts)
#   list                    one line per database and pre-deploy dump: time, id, file and tags
#   show ID                 key=value lines about one snapshot of the data repository
#   dump-database [ID]      the database dump of snapshot ID (default: the newest database
#                           snapshot; a pre-deploy snapshot works too) on standard output
#   dump-host-files [ID]    the host files archive of snapshot ID (default: the newest) on standard output
#   restore-vault [TIME]    rclone copy of <bucket>/vault back to the vault bucket (nothing is deleted);
#                           with TIME (RFC 3339), the copy as it was then, from the versions the
#                           off-site bucket keeps
#   restore-vault-sample    the same for the keys listed in /run/backup-run/vault-sample.txt only
#   vault-size              objects=<n> bytes=<n> of the off-site vault copy (needs no vault keys)
#
# The read-only commands (open, snapshots, list, show, dump-*, vault-size) take no restic lock, so the restore test can
# use a read-only key.
#
# Inputs: /run/backup-values/<NAME> (BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY,
# BACKUP_S3_SECRET_KEY, BACKUP_SECRETS_ACCESS_KEY, BACKUP_SECRETS_SECRET_KEY, BACKUP_RESTIC_PASSWORD,
# and optional BACKUP_S3_REGION), /run/backup-run/<file> (s3.access, s3.secret, host-files.tar,
# vault-sample.txt, and postgres.password for the database dump), and the environment of
# docker-compose.backup.yml. No secret value is ever printed.
set -euo pipefail
umask 077

readonly VALUES=/run/backup-values
readonly RUN=/run/backup-run
readonly HOST_NAME=mscd
readonly DB_HOST=${MSCD_BACKUP_DB_HOST:-postgres}
readonly DB_NAME=mscd
readonly KEEP=(--keep-daily 14 --keep-weekly 8 --keep-monthly 12)

say() { printf 'backup-run: %s\n' "$*" >&2; }
die() {
    say "ERROR: $*"
    exit 1
}

# The temporary files of restic go to the cache folder on the disk (TMPDIR of the overlay); files
# that a stopped run left there are removed first.
if [[ -n ${TMPDIR:-} && $TMPDIR == /var/cache/mscd-backup/* ]]; then
    mkdir -p -- "$TMPDIR" 2>/dev/null || TMPDIR=/tmp
    find "$TMPDIR" -mindepth 1 -maxdepth 1 -mmin +360 -exec rm -rf -- {} + 2>/dev/null || true
    export TMPDIR
fi

# value NAME: the off-site value NAME (a file without a final line break), carriage returns removed.
value() {
    tr -d '\r' <"$VALUES/$1"
}

need_values() {
    local name missing=()
    [[ -d $VALUES && -r $VALUES ]] || die "The off-site values ($VALUES) cannot be read by user $(id -u)"
    for name in "$@"; do
        [[ -s $VALUES/$name && -r $VALUES/$name ]] || missing+=("$name")
    done
    ((${#missing[@]} == 0)) ||
        die "The off-site value(s) ${missing[*]} are missing: set them in the GitHub environment and deploy (docs/saas/backup-restore.md)"
}

# The off-site bucket: endpoint (https://host[:port], http only in test stacks), bucket and region.
ENDPOINT='' BUCKET='' REGION=''
load_bucket() {
    need_values BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_RESTIC_PASSWORD
    ENDPOINT=$(value BACKUP_S3_ENDPOINT)
    ENDPOINT=${ENDPOINT%/}
    BUCKET=$(value BACKUP_S3_BUCKET)
    if [[ ! $ENDPOINT =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]]; then
        if [[ ${MSCD_SAAS_TEST:-} == 1 && $ENDPOINT =~ ^http://[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]]; then
            say "Test stack: the off-site endpoint uses plain http"
        else
            die "BACKUP_S3_ENDPOINT must be https://<host> or https://<host>:<port> without a path"
        fi
    fi
    [[ $BUCKET =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "BACKUP_S3_BUCKET must be an S3 bucket name (3 to 63 lower-case letters, digits, '.' and '-')"
    if [[ -s $VALUES/BACKUP_S3_REGION ]]; then
        REGION=$(value BACKUP_S3_REGION)
    else
        local host=${ENDPOINT#*://}
        host=${host%%:*}
        if [[ $host =~ ^s3[.-]([a-z]{2}(-gov)?-[a-z]+-[0-9])\.amazonaws\.com$ ]]; then REGION=${BASH_REMATCH[1]}; fi
    fi
    [[ -z $REGION || $REGION =~ ^[a-z0-9-]{2,40}$ ]] || die "BACKUP_S3_REGION is not a region name"
}

# use_repo data|secrets: restic settings of a repository (process environment only).
RESTIC_OPTS=()
use_repo() {
    load_bucket
    case $1 in
        data)
            need_values BACKUP_S3_ACCESS_KEY BACKUP_S3_SECRET_KEY
            export RESTIC_REPOSITORY="s3:$ENDPOINT/$BUCKET/restic"
            AWS_ACCESS_KEY_ID=$(value BACKUP_S3_ACCESS_KEY)
            AWS_SECRET_ACCESS_KEY=$(value BACKUP_S3_SECRET_KEY)
            ;;
        secrets)
            need_values BACKUP_SECRETS_ACCESS_KEY BACKUP_SECRETS_SECRET_KEY
            export RESTIC_REPOSITORY="s3:$ENDPOINT/$BUCKET/secrets"
            AWS_ACCESS_KEY_ID=$(value BACKUP_SECRETS_ACCESS_KEY)
            AWS_SECRET_ACCESS_KEY=$(value BACKUP_SECRETS_SECRET_KEY)
            ;;
        *) die "unknown repository $1" ;;
    esac
    export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
    export RESTIC_PASSWORD_FILE=$VALUES/BACKUP_RESTIC_PASSWORD
    RESTIC_OPTS=()
    if [[ -n $REGION ]]; then RESTIC_OPTS=(-o "s3.region=$REGION"); fi
}

# ensure_repo NAME [read-only]: opens the repository; makes it when it does not exist yet (restic
# exit code 10), unless read-only. A wrong password (exit code 12) or any other error stops the run.
ensure_repo() {
    local name=$1 mode=${2:-} rc=0 out
    out=$(restic "${RESTIC_OPTS[@]}" --no-lock cat config 2>&1 >/dev/null) || rc=$?
    case $rc in
        0) say "Repository $name opens" ;;
        10)
            [[ $mode != read-only ]] || die "There is no repository $name at $BUCKET/${RESTIC_REPOSITORY##*/}: no backup was taken yet, or BACKUP_S3_BUCKET names another bucket"
            restic "${RESTIC_OPTS[@]}" init >/dev/null 2>&1 || die "The repository $name could not be made at $BUCKET/${RESTIC_REPOSITORY##*/}"
            say "Repository $name made at $BUCKET/${RESTIC_REPOSITORY##*/}"
            ;;
        12) die "The repository $name does not open with BACKUP_RESTIC_PASSWORD (wrong password)" ;;
        *) die "The repository $name cannot be read (restic exit code $rc): $(printf '%s\n' "$out" | tail -n 1)" ;;
    esac
}

# summary_field JSON NAME: a number or string field of restic's JSON summary line.
summary_field() {
    printf '%s\n' "$1" | grep -o "\"$2\":\"\{0,1\}[^,\"}]*" | head -n 1 | sed -E 's/^"[^"]*":"?//'
}

# restic_backup TAG... -- NAME COMMAND...: restic backup --stdin-from-command; restic makes no
# snapshot when COMMAND fails. Prints "snapshot=<id> bytes=<processed> added=<bytes added>".
restic_backup() {
    local -a tags=()
    while [[ $1 != -- ]]; do
        tags+=(--tag "$1")
        shift
    done
    shift
    local name=$1
    shift
    local line
    line=$(restic "${RESTIC_OPTS[@]}" backup --json --host "$HOST_NAME" "${tags[@]}" --stdin-filename "$name" \
        --stdin-from-command -- "$@" | grep '"message_type":"summary"' | tail -n 1) || die "restic backup of $name failed"
    [[ -n $line ]] || die "restic backup of $name wrote no summary"
    printf 'snapshot=%s bytes=%s added=%s\n' "$(summary_field "$line" snapshot_id | cut -c1-8)" \
        "$(summary_field "$line" total_bytes_processed)" "$(summary_field "$line" data_added)"
}

safe_tag() {
    printf '%s' "$1" | tr -c 'A-Za-z0-9._=-' '_' | cut -c1-80
}

cmd_check() {
    use_repo data
    ensure_repo data
    use_repo secrets
    ensure_repo secrets
}

cmd_open() {
    use_repo data
    ensure_repo data read-only
}

cmd_database() {
    local password orgs version
    use_repo data
    [[ -r $RUN/postgres.password ]] || die "The database password of this run is missing ($RUN/postgres.password)"
    ensure_repo data
    password=$(tr -d '\r\n' <"$RUN/postgres.password")
    # .pgpass format: backslash and colon are escaped.
    password=${password//\\/\\\\}
    password=${password//:/\\:}
    printf '%s:5432:*:postgres:%s\n' "$DB_HOST" "$password" >/tmp/pgpass
    chmod 0600 /tmp/pgpass
    export PGPASSFILE=/tmp/pgpass PGCONNECT_TIMEOUT=15
    orgs=$(psql -h "$DB_HOST" -U postgres -d "$DB_NAME" -w -XAtq \
        -c "select count(*) from platform.organization where deleted_at is null") || die "PostgreSQL ($DB_HOST) cannot be reached as postgres"
    version=$(safe_tag "${MSCD_BACKUP_VERSION:-unknown}")
    say "Dumping the database $DB_NAME ($orgs organisations, release $version)"
    restic_backup database "version=$version" "orgs=$orgs" -- mscd.dump \
        pg_dump -h "$DB_HOST" -U postgres -w --format=custom --dbname="$DB_NAME"
    rm -f /tmp/pgpass
}

cmd_pre_deploy() {
    local file=${1:-} name=${2:-pre-deploy}
    [[ -n $file && -r $file ]] || die "pre-deploy: the dump file is missing or cannot be read"
    [[ $(head -c 5 -- "$file") == PGDMP ]] || die "pre-deploy: the file is not a pg_dump custom-format archive"
    use_repo data
    ensure_repo data
    restic_backup pre-deploy "file=$(safe_tag "$name")" "version=$(safe_tag "${MSCD_BACKUP_VERSION:-unknown}")" -- pre-deploy.dump cat -- "$file"
}

# rclone remotes: "vault" (the stack's bucket) and "offsite" (the off-site bucket), from the
# process environment only.
use_rclone() {
    load_bucket
    need_values BACKUP_S3_ACCESS_KEY BACKUP_S3_SECRET_KEY
    [[ -r $RUN/s3.access && -r $RUN/s3.secret ]] || die "The vault keys of this run are missing ($RUN/s3.access, $RUN/s3.secret)"
    export RCLONE_CONFIG=/tmp/rclone.conf
    : >"$RCLONE_CONFIG"
    export RCLONE_CONFIG_VAULT_TYPE=s3 RCLONE_CONFIG_VAULT_PROVIDER=Other RCLONE_CONFIG_VAULT_FORCE_PATH_STYLE=true
    export RCLONE_CONFIG_VAULT_ENDPOINT=${MSCD_VAULT_ENDPOINT:-http://objectstore:8333}
    export RCLONE_CONFIG_VAULT_REGION=${MSCD_VAULT_REGION:-us-east-1}
    RCLONE_CONFIG_VAULT_ACCESS_KEY_ID=$(tr -d '\r\n' <"$RUN/s3.access")
    RCLONE_CONFIG_VAULT_SECRET_ACCESS_KEY=$(tr -d '\r\n' <"$RUN/s3.secret")
    export RCLONE_CONFIG_VAULT_ACCESS_KEY_ID RCLONE_CONFIG_VAULT_SECRET_ACCESS_KEY
    export RCLONE_CONFIG_OFFSITE_TYPE=s3 RCLONE_CONFIG_OFFSITE_PROVIDER=Other RCLONE_CONFIG_OFFSITE_ENDPOINT=$ENDPOINT
    export RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET=true
    if [[ -n $REGION ]]; then export RCLONE_CONFIG_OFFSITE_REGION=$REGION; fi
    RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID=$(value BACKUP_S3_ACCESS_KEY)
    RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY=$(value BACKUP_S3_SECRET_KEY)
    export RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY
    VAULT_BUCKET=${MSCD_VAULT_BUCKET:-mscd-vault}
    [[ $VAULT_BUCKET =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "MSCD_S3_BUCKET is not a bucket name"
}

# count REMOTE: number of objects below REMOTE (empty when it cannot be listed).
count() {
    rclone size --json "$1" 2>/dev/null | grep -o '"count":[0-9]*' | cut -d: -f2 || true
}

# rclone_copy MODE SRC DST [FLAGS...]: rclone sync or copy with user metadata (the encryption
# header of each vault object travels as S3 metadata); prints "copied=<n> deleted=<n> errors=<n>".
rclone_copy() {
    local mode=$1 src=$2 dst=$3 log=/tmp/rclone.log rc=0
    shift 3
    rclone "$mode" "$src" "$dst" --metadata --checkers 8 --transfers 4 --retries 3 --low-level-retries 10 \
        --stats 1h --stats-log-level NOTICE --log-level NOTICE --use-json-log "$@" 2>"$log" || rc=$?
    printf 'copied=%s deleted=%s errors=%s\n' \
        "$(grep -o '"transfers":[0-9]*' "$log" | tail -n 1 | cut -d: -f2)" \
        "$(grep -o '"deletes":[0-9]*' "$log" | tail -n 1 | cut -d: -f2)" \
        "$(grep -o '"errors":[0-9]*' "$log" | tail -n 1 | cut -d: -f2)"
    if ((rc != 0)); then
        # rclone's messages name the bucket and object keys (organisation ids, never names).
        grep -o '"msg":"[^"]*"' "$log" | grep -v '^"msg":"$' | tail -n 5 | sed 's/^"msg":/  rclone: /' >&2 || true
        return "$rc"
    fi
}

cmd_vault() {
    local before held max limit
    use_rclone
    held=$(count "vault:$VAULT_BUCKET")
    [[ -n $held ]] || die "The vault bucket $VAULT_BUCKET cannot be listed at ${RCLONE_CONFIG_VAULT_ENDPOINT}"
    before=$(count "offsite:$BUCKET/vault")
    before=${before:-0}
    # A source that lost objects (a wrong or empty volume, a new server waiting for its restore)
    # must not empty the copy, however small the copy is. The app deletes vault objects only when
    # an organisation is purged, so the counts decide first: when the vault holds fewer objects
    # than the copy by more than a tenth of the copy (an empty vault always), nothing is touched.
    # rclone's --max-delete (a tenth of the copy, at least 100) stays as a second stop, for
    # deletions that new objects hide in the counts. MSCD_BACKUP_MAX_DELETE sets both limits
    # (-1: no limit, from --allow-vault-deletes).
    max=${MSCD_BACKUP_MAX_DELETE:-}
    if [[ -n $max ]]; then
        [[ $max =~ ^-?[0-9]+$ ]] || die "MSCD_BACKUP_MAX_DELETE must be a number (-1: no limit)"
        limit=$max
    else
        limit=$((before / 10))
        max=$limit
        if ((max < 100)); then max=100; fi
    fi
    if ((limit >= 0 && before - held > limit)); then
        die "The vault bucket holds $held objects and the off-site copy $before: the sync would delete more than $limit. Nothing was copied or deleted. Find out why the vault lost objects (or restore it first); when the deletions are right, run backup.sh run --allow-vault-deletes"
    fi
    say "Copying the vault bucket $VAULT_BUCKET ($held objects) to $BUCKET/vault ($before objects there; at most $max deletions)"
    rclone_copy sync "vault:$VAULT_BUCKET" "offsite:$BUCKET/vault" --max-delete "$max" ||
        die "rclone sync of the vault failed (more than $max deletions also stop it: run backup.sh run --allow-vault-deletes after checking why)"
    printf 'objects=%s\n' "$(count "offsite:$BUCKET/vault")"
}

cmd_host_files() {
    local file=$RUN/host-files.tar
    [[ -r $file ]] || die "The host files archive of this run is missing ($file)"
    use_repo secrets
    ensure_repo secrets
    restic_backup host-files -- host-files.tar cat -- "$file"
}

cmd_forget() {
    local prune=()
    if [[ ${1:-} == --prune ]]; then prune=(--prune); fi
    use_repo data
    restic "${RESTIC_OPTS[@]}" forget --host "$HOST_NAME" "${KEEP[@]}" "${prune[@]}" --quiet ||
        die "restic forget of the data repository failed"
    use_repo secrets
    restic "${RESTIC_OPTS[@]}" forget --host "$HOST_NAME" "${KEEP[@]}" "${prune[@]}" --quiet ||
        die "restic forget of the secrets repository failed"
    say "Retention applied (14 daily, 8 weekly, 12 monthly${prune:+, unused data pruned})"
}

# describe PREFIX JSON_OBJECT: key=value lines of one snapshot (time, id, tags, path).
describe() {
    local prefix=$1 object=$2
    # The time in whole seconds (restic gives nanoseconds).
    printf '%s_time=%s\n' "$prefix" "$(printf '%s' "$object" | grep -o '"time":"[^"]*"' | head -n 1 | cut -d'"' -f4 | sed -E 's/\.[0-9]+//')"
    printf '%s_id=%s\n' "$prefix" "$(printf '%s' "$object" | grep -o '"short_id":"[^"]*"' | head -n 1 | cut -d'"' -f4)"
    printf '%s_tags=%s\n' "$prefix" "$(printf '%s' "$object" | grep -o '"tags":\[[^]]*\]' | head -n 1 | sed -e 's/^"tags":\[//' -e 's/\]$//' -e 's/"//g')"
    printf '%s_path=%s\n' "$prefix" "$(printf '%s' "$object" | grep -o '"paths":\[[^]]*\]' | head -n 1 | sed -e 's/^"paths":\[//' -e 's/\]$//' -e 's/"//g' | cut -d, -f1)"
}

# newest TAG: key=value lines of the newest snapshot with TAG, and the count.
newest() {
    local tag=$1 json count
    json=$(restic "${RESTIC_OPTS[@]}" --no-lock snapshots --json --host "$HOST_NAME" --tag "$tag") || die "restic snapshots failed"
    count=$(printf '%s' "$json" | grep -o '"short_id"' | wc -l | tr -d ' ' || true)
    printf '%s_count=%s\n' "${tag//-/_}" "$count"
    ((count > 0)) || return 0
    # restic lists snapshots oldest first; the last object is the newest.
    describe "${tag//-/_}" "$(printf '%s' "$json" | sed 's/},{"time"/}\n{"time"/g' | tail -n 1)"
}

cmd_snapshots() {
    use_repo data
    newest database
    newest pre-deploy
    if [[ -s $VALUES/BACKUP_SECRETS_ACCESS_KEY ]]; then
        use_repo secrets
        newest host-files
    fi
}

cmd_list() {
    local json object
    use_repo data
    json=$(restic "${RESTIC_OPTS[@]}" --no-lock snapshots --json --host "$HOST_NAME") || die "restic snapshots failed"
    while IFS= read -r object; do
        [[ $object == *'"short_id"'* ]] || continue
        printf '%s %s %s %s\n' \
            "$(printf '%s' "$object" | grep -o '"time":"[^"]*"' | head -n 1 | cut -d'"' -f4 | cut -c1-19)Z" \
            "$(printf '%s' "$object" | grep -o '"short_id":"[^"]*"' | head -n 1 | cut -d'"' -f4)" \
            "$(printf '%s' "$object" | grep -o '"paths":\[[^]]*\]' | head -n 1 | sed -e 's/^"paths":\["//' -e 's/".*$//')" \
            "$(printf '%s' "$object" | grep -o '"tags":\[[^]]*\]' | head -n 1 | sed -e 's/^"tags":\[//' -e 's/\]$//' -e 's/"//g')"
    done < <(printf '%s' "$json" | sed 's/},{"time"/}\n{"time"/g')
}

# snapshot_ref ID: a snapshot id (hex) or "latest".
snapshot_ref() {
    local id=${1:-latest}
    [[ $id == latest || $id =~ ^[0-9a-f]{8,64}$ ]] || die "A snapshot is 'latest' or a hexadecimal id"
    printf '%s' "$id"
}

# snapshot_json ID: restic's JSON of one snapshot of the current repository.
snapshot_json() {
    local json
    json=$(restic "${RESTIC_OPTS[@]}" --no-lock snapshots --json "$1" 2>/dev/null) || die "There is no snapshot $1"
    [[ $(printf '%s' "$json" | grep -o '"short_id"' | wc -l) -eq 1 ]] || die "There is no snapshot $1"
    printf '%s' "$json"
}

cmd_show() {
    local id
    id=$(snapshot_ref "${1:-}")
    [[ $id != latest ]] || die "show needs a snapshot id"
    use_repo data
    describe snapshot "$(snapshot_json "$id")"
}

cmd_dump_database() {
    local id path
    id=$(snapshot_ref "${1:-}")
    use_repo data
    if [[ $id == latest ]]; then
        restic "${RESTIC_OPTS[@]}" --no-lock dump --host "$HOST_NAME" --tag database latest /mscd.dump
        return
    fi
    # A database snapshot holds /mscd.dump, a pre-deploy snapshot /pre-deploy.dump.
    path=$(snapshot_json "$id" | grep -o '"paths":\[[^]]*\]' | head -n 1 | sed -e 's/^"paths":\["//' -e 's/".*$//' || true)
    case $path in
        /mscd.dump | /pre-deploy.dump) ;;
        *) die "Snapshot $id holds no database dump" ;;
    esac
    restic "${RESTIC_OPTS[@]}" --no-lock dump "$id" "$path"
}

cmd_dump_host_files() {
    local id
    id=$(snapshot_ref "${1:-}")
    use_repo secrets
    restic "${RESTIC_OPTS[@]}" --no-lock dump --host "$HOST_NAME" --tag host-files "$id" /host-files.tar
}

cmd_restore_vault() {
    local at=${1:-} args=()
    use_rclone
    if [[ -n $at ]]; then
        [[ $at =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$ ]] ||
            die "restore-vault: the time must be RFC 3339, such as 2026-10-01T02:00:00Z"
        args=(--s3-version-at "$at")
        say "Copying $BUCKET/vault as it was at $at back to the vault bucket $VAULT_BUCKET"
    else
        say "Copying $BUCKET/vault back to the vault bucket $VAULT_BUCKET"
    fi
    rclone_copy copy "offsite:$BUCKET/vault" "vault:$VAULT_BUCKET" "${args[@]}" || die "rclone copy of the vault failed"
    printf 'objects=%s\n' "$(count "vault:$VAULT_BUCKET")"
}

cmd_vault_size() {
    local json
    load_bucket
    need_values BACKUP_S3_ACCESS_KEY BACKUP_S3_SECRET_KEY
    export RCLONE_CONFIG=/tmp/rclone.conf
    : >"$RCLONE_CONFIG"
    export RCLONE_CONFIG_OFFSITE_TYPE=s3 RCLONE_CONFIG_OFFSITE_PROVIDER=Other RCLONE_CONFIG_OFFSITE_ENDPOINT=$ENDPOINT
    export RCLONE_CONFIG_OFFSITE_NO_CHECK_BUCKET=true
    if [[ -n $REGION ]]; then export RCLONE_CONFIG_OFFSITE_REGION=$REGION; fi
    RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID=$(value BACKUP_S3_ACCESS_KEY)
    RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY=$(value BACKUP_S3_SECRET_KEY)
    export RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY
    json=$(rclone size --json "offsite:$BUCKET/vault" 2>/dev/null) || die "The off-site vault copy cannot be listed"
    printf 'objects=%s bytes=%s\n' "$(printf '%s' "$json" | grep -o '"count":[0-9]*' | cut -d: -f2)" \
        "$(printf '%s' "$json" | grep -o '"bytes":[0-9]*' | cut -d: -f2)"
}

cmd_restore_vault_sample() {
    local list=$RUN/vault-sample.txt
    [[ -r $list ]] || die "The sample list of this run is missing ($list)"
    use_rclone
    say "Copying $(grep -c . "$list" || true) sampled objects of $BUCKET/vault back to the vault bucket $VAULT_BUCKET"
    rclone_copy copy "offsite:$BUCKET/vault" "vault:$VAULT_BUCKET" --files-from-raw "$list" --no-traverse ||
        die "rclone copy of the sampled objects failed"
}

usage() {
    sed -n '2,/^set -euo pipefail$/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
}

main() {
    local command=${1:-help}
    shift || true
    case $command in
        check) cmd_check ;;
        open) cmd_open ;;
        database) cmd_database ;;
        pre-deploy) cmd_pre_deploy "$@" ;;
        vault) cmd_vault ;;
        host-files) cmd_host_files ;;
        forget) cmd_forget "$@" ;;
        snapshots) cmd_snapshots ;;
        list) cmd_list ;;
        show) cmd_show "$@" ;;
        dump-database) cmd_dump_database "$@" ;;
        dump-host-files) cmd_dump_host_files "$@" ;;
        restore-vault) cmd_restore_vault "$@" ;;
        restore-vault-sample) cmd_restore_vault_sample ;;
        vault-size) cmd_vault_size ;;
        help | -h | --help) usage ;;
        *)
            usage >&2
            die "unknown command $command"
            ;;
    esac
}

main "$@"
