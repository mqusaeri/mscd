# shellcheck shell=bash
# MSCD SaaS backups: helpers of backup.sh, restore.sh and restore-test.sh (Milestone 2 plan K,
# M2-S07). Sourced after deploy/scripts/lib/common.sh, which it uses and does not change.
#
# Layout of a server (M2-S03, M2-S05): the install folder /opt/mscd holds .env, deploy/ (the files
# of the running release, with deploy/compose the Compose project folder), secrets/ (secrets/backup:
# one file per off-site value, written by deploy-prod.yml), state/, logs/, metrics/ and backup/
# (pre-deploy dumps, the restic cache and the run folders of this script).
#
# Settings (environment), for test stacks and a run by hand:
#   MSCD_BACKUP_COMPOSE_DIR     Compose project folder (default: deploy/compose next to this file)
#   MSCD_BACKUP_COMPOSE_FILES   Compose files, ':' between them, relative to that folder or absolute
#                               (default: the SaaS files present, as saas-deploy.sh uses them)
#   MSCD_BACKUP_ENV_FILE        settings of the stack (default: <install>/.env)
#   MSCD_BACKUP_IMAGE_NAME      name of the backup tools image (default: mscd-backup)
#   MSCD_BUILD_CA               CA certificate of a TLS-inspecting proxy for the image build (R-12)
#   MSCD_SAAS_TEST=1            test stacks only: the off-site endpoint and heartbeat may use http

BK_LIB_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# deploy/ of the release (on a server: /opt/mscd/deploy, or /opt/mscd/releases/<tag>/deploy for the
# pre-deploy copy) or of the repository.
BK_DEPLOY_DIR=$(cd -- "$BK_LIB_DIR/.." && pwd)
readonly BK_LIB_DIR BK_DEPLOY_DIR
readonly BK_SAAS_FILES=(docker-compose.yml docker-compose.saas.yml docker-compose.backup.yml docker-compose.ops.yml)
# The off-site values of K.2 that every backup needs (HEARTBEAT_BACKUP_URL is optional).
readonly BK_REQUIRED_VALUES=(BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY BACKUP_S3_SECRET_KEY
    BACKUP_SECRETS_ACCESS_KEY BACKUP_SECRETS_SECRET_KEY BACKUP_RESTIC_PASSWORD)
# The values that bk_check_values asks for: all of them, except in the weekly restore test, which
# reads the data repository with its read-only key and has no second key pair.
BK_NEEDED_VALUES=("${BK_REQUIRED_VALUES[@]}")

BK_COMPOSE=()
BK_IMAGE=''
BK_USER=''
BK_RUN_DIR=''
BK_RUN_ARGS=()

bk_stamp() {
    date -u +%Y%m%dT%H%M%SZ
}

# bk_prescan_project ARGS...: the Compose project name of the install folder named by
# --install-dir (default /opt/mscd or MSCD_INSTALL_DIR), read from its .env, so lib/common.sh
# (which reads COMPOSE_PROJECT_NAME once) sees it.
bk_prescan_project() {
    local dir=${MSCD_INSTALL_DIR:-/opt/mscd} env name
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --install-dir) if [[ $# -ge 2 ]]; then dir=$2; shift; fi ;;
            --install-dir=*) dir=${1#*=} ;;
        esac
        shift
    done
    env=${MSCD_BACKUP_ENV_FILE:-$dir/.env}
    if [[ -z ${COMPOSE_PROJECT_NAME:-} && -f $env && -r $env ]]; then
        name=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$env" | tail -n 1)
        if [[ $name =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]; then export COMPOSE_PROJECT_NAME=$name; fi
    fi
}

# bk_init INSTALL_DIR: the paths and the Compose command of an install folder (read by the scripts
# that source this file).
# shellcheck disable=SC2034
bk_init() {
    local name file
    INSTALL_DIR=$(cd -- "$1" 2>/dev/null && pwd) || die "The install folder $1 does not exist"
    ENV_FILE=${MSCD_BACKUP_ENV_FILE:-$INSTALL_DIR/.env}
    [[ -f $ENV_FILE && -r $ENV_FILE ]] || die "$ENV_FILE is missing or cannot be read. Deploy MSCD first (docs/saas/deploy.md)."
    SECRETS_DIR=$(kv_get "$ENV_FILE" MSCD_SECRETS_DIR)
    SECRETS_DIR=${SECRETS_DIR:-$INSTALL_DIR/secrets}
    VALUES_DIR=$SECRETS_DIR/backup
    METRICS_DIR=$(kv_get "$ENV_FILE" MSCD_METRICS_DIR)
    METRICS_DIR=${METRICS_DIR:-$INSTALL_DIR/metrics}
    BACKUP_DIR=$INSTALL_DIR/backup
    LOG_DIR=$INSTALL_DIR/logs
    STATE_DIR=$INSTALL_DIR/state
    COMPOSE_DIR=${MSCD_BACKUP_COMPOSE_DIR:-$BK_DEPLOY_DIR/compose}
    [[ -f $COMPOSE_DIR/docker-compose.yml ]] || die "No docker-compose.yml in $COMPOSE_DIR"
    BK_COMPOSE=(docker compose -p "$MSCD_PROJECT" --project-directory "$COMPOSE_DIR")
    if [[ -n ${MSCD_BACKUP_COMPOSE_FILES:-} ]]; then
        local -a files
        IFS=: read -r -a files <<<"$MSCD_BACKUP_COMPOSE_FILES"
        for file in "${files[@]}"; do
            [[ $file == /* ]] || file=$COMPOSE_DIR/$file
            [[ -f $file ]] || die "Compose file $file is missing"
            BK_COMPOSE+=(-f "$file")
        done
    else
        for name in "${BK_SAAS_FILES[@]}"; do
            if [[ -f $COMPOSE_DIR/$name ]]; then BK_COMPOSE+=(-f "$COMPOSE_DIR/$name"); fi
        done
    fi
    BK_COMPOSE+=(--env-file "$ENV_FILE")
    [[ " ${BK_COMPOSE[*]} " == *"/docker-compose.backup.yml "* ]] ||
        die "The backup overlay docker-compose.backup.yml is not among the Compose files (this release has no backups)"
}

bk_compose() {
    "${BK_COMPOSE[@]}" "$@"
}

# bk_version: the release that runs (state/current.env of the deploy, else MSCD_VERSION of .env).
bk_version() {
    local version
    version=$(kv_get "$STATE_DIR/current.env" VERSION 2>/dev/null || true)
    [[ -n $version ]] || version=$(kv_get "$ENV_FILE" MSCD_VERSION)
    printf '%s' "${version:-unknown}"
}

# bk_missing_values: the names of the needed off-site values that the folder does not hold, one
# per line.
bk_missing_values() {
    local name
    for name in "${BK_NEEDED_VALUES[@]}"; do
        if [[ ! -s $VALUES_DIR/$name ]]; then printf '%s\n' "$name"; fi
    done
}

# bk_check_values: FAIL lines when the off-site values cannot be used; sets BK_USER, the user the
# backup container runs as: the owner of the values folder (the deploy account on a server, which
# deploy-prod.yml writes them as), never root.
bk_check_values() {
    local missing owner
    if [[ ! -d $VALUES_DIR ]]; then
        fail "The off-site backup is not set up: $VALUES_DIR does not exist" \
            "Set the BACKUP_* secrets of the GitHub environment and deploy (docs/saas/backup-restore.md, Setting up)"
        return 1
    fi
    if [[ $EUID -ne 0 && ! -r $VALUES_DIR ]]; then
        fail "$VALUES_DIR cannot be read by $(id -un)" "Run as the deploy account or as root"
        return 1
    fi
    missing=$(bk_missing_values | xargs)
    if [[ -n $missing ]]; then
        fail "The off-site backup is not set up: $missing missing in $VALUES_DIR" \
            "Set these secrets of the GitHub environment and deploy (docs/saas/backup-restore.md, Setting up)"
        return 1
    fi
    owner=$(stat -c '%u:%g' -- "$VALUES_DIR")
    if [[ ${owner%%:*} == 0 ]]; then
        fail "$VALUES_DIR belongs to root; the backup container never runs as root" \
            "Give the folder and its files to the deploy account (chown -R deploy:deploy $VALUES_DIR), or deploy again"
        return 1
    fi
    BK_USER=$owner
    pass "Off-site values: ${#BK_NEEDED_VALUES[@]} set in $VALUES_DIR (the backup runs as user ${BK_USER%%:*})"
}

# bk_image: the backup tools image mscd-backup:<hash of backup.Dockerfile>, built when this host
# does not hold it (R-12: every build passes the build_ca secret, an empty file without a proxy).
# Older tags of the image that no container uses are removed.
bk_image() {
    local dockerfile=$BK_DEPLOY_DIR/docker/backup.Dockerfile name=${MSCD_BACKUP_IMAGE_NAME:-mscd-backup} tag ctx ca log rc=0 old detail
    [[ $name =~ ^[a-z0-9][a-z0-9._/-]{0,100}$ ]] || die "MSCD_BACKUP_IMAGE_NAME must be an image name in lower case"
    if [[ ! -f $dockerfile ]]; then
        fail "The release has no deploy/docker/backup.Dockerfile ($dockerfile)"
        return 1
    fi
    tag=$(sha256sum <"$dockerfile" | cut -c1-12)
    BK_IMAGE=$name:$tag
    if image_exists "$BK_IMAGE"; then
        pass "Backup tools image $BK_IMAGE is on this host"
    else
        ctx=$(mktemp -d)
        ca=$(mktemp)
        log=$(mktemp)
        if [[ -n ${MSCD_BUILD_CA:-} ]]; then
            if [[ ! -r $MSCD_BUILD_CA ]]; then
                rm -rf -- "$ctx" "$ca" "$log"
                fail "MSCD_BUILD_CA names $MSCD_BUILD_CA, which cannot be read"
                return 1
            fi
            cat -- "$MSCD_BUILD_CA" >"$ca"
        fi
        info "Building the backup tools image $BK_IMAGE (postgres:16.15-alpine with restic and rclone)"
        DOCKER_BUILDKIT=1 docker build -f "$dockerfile" --secret "id=build_ca,src=$ca" \
            --label "com.cyberlentera.mscd.backup-dockerfile=$tag" -t "$BK_IMAGE" "$ctx" >"$log" 2>&1 || rc=$?
        if ((rc != 0)); then
            # The output of the failed step, which BuildKit repeats with a time in front ("1.265
            # apk could not install ..."); else the end of the log without the Dockerfile lines.
            detail=$(grep -E '^[0-9]+\.[0-9]+ ' "$log" | sed -E 's/^[0-9]+\.[0-9]+ +//' | tail -n 6 || true)
            [[ -n $detail ]] || detail=$(grep -vE '^ *[0-9]+ \| |^-+$|^$' "$log" | tail -n 6 || true)
            printf '%s\n' "$detail" | cut -c1-300 | sed 's/^/          /'
            rm -rf -- "$ctx" "$ca" "$log"
            fail "The backup tools image could not be built (docs/saas/backup-restore.md, Updating the backup tools)"
            return 1
        fi
        rm -rf -- "$ctx" "$ca" "$log"
        pass "Backup tools image $BK_IMAGE built"
    fi
    while IFS= read -r old; do
        [[ -n $old && $old != "$BK_IMAGE" ]] || continue
        if [[ -z $(docker ps -aq --filter "ancestor=$old") ]]; then docker image rm "$old" >/dev/null 2>&1 || true; fi
    done < <(docker image ls --format '{{.Repository}}:{{.Tag}}' "$name" 2>/dev/null | grep -v ':<none>$' || true)
}

# bk_prepare_run: the run folder <backup>/run/<stamp> (0700) and the restic cache, both owned by the
# user of the backup container; removed by bk_cleanup.
bk_prepare_run() {
    install -d -m 0700 "$BACKUP_DIR" "$BACKUP_DIR/run" "$BACKUP_DIR/cache"
    BK_RUN_DIR=$(mktemp -d "$BACKUP_DIR/run/$(bk_stamp)-XXXXXX")
    chmod 0700 "$BK_RUN_DIR"
    if [[ $EUID -eq 0 ]]; then
        chown "$BK_USER" "$BK_RUN_DIR" "$BACKUP_DIR/run" "$BACKUP_DIR/cache"
    fi
}

bk_cleanup() {
    if [[ -n $BK_RUN_DIR && -d $BK_RUN_DIR ]]; then rm -rf -- "$BK_RUN_DIR"; fi
    BK_RUN_DIR=''
}

# bk_put_file SRC NAME: copies a file (a secret of another user) into the run folder for the
# container: owner the container user, mode 0400. Needs root unless this user can read SRC.
bk_put_file() {
    local src=$1 name=$2
    [[ -r $src ]] || {
        fail "$src cannot be read"
        return 1
    }
    # Written while 0600 and then made 0400: only root may write into a file of mode 0400, and
    # the weekly restore test runs as the runner's user.
    if ! install -m 0600 /dev/null "$BK_RUN_DIR/$name" || ! cat -- "$src" >"$BK_RUN_DIR/$name" ||
        ! chmod 0400 "$BK_RUN_DIR/$name"; then
        fail "$src could not be copied into the run folder $BK_RUN_DIR"
        return 1
    fi
    if [[ $EUID -eq 0 ]]; then chown "$BK_USER" "$BK_RUN_DIR/$name"; fi
}

# bk_run COMMAND ARGS...: the backup container with COMMAND of backup-run.sh (the copy next to this
# file, whatever the Compose project folder is). BK_RUN_ARGS adds options of "docker compose run"
# (volumes, environment).
bk_run() {
    MSCD_BACKUP_IMAGE=$BK_IMAGE MSCD_BACKUP_USER=$BK_USER MSCD_BACKUP_RUN_DIR=$BK_RUN_DIR \
        MSCD_BACKUP_CACHE_DIR=$BACKUP_DIR/cache MSCD_BACKUP_VERSION=$(bk_version) MSCD_BACKUP_SCRIPTS_DIR=$BK_LIB_DIR \
        bk_compose run --rm --no-deps -T --name "$MSCD_PROJECT-backup-$(bk_stamp | tr 'TZ' 'tz')-$RANDOM" \
        "${BK_RUN_ARGS[@]}" backup "$@"
}

# bk_field LINE KEY: the value of KEY in a "key=value key=value" line.
bk_field() {
    printf '%s\n' "$1" | tr ' ' '\n' | sed -n "s/^$2=//p" | head -n 1
}

# bk_human BYTES: a size for people (MB with one decimal).
bk_human() {
    local bytes=${1:-0}
    [[ $bytes =~ ^[0-9]+$ ]] || bytes=0
    awk -v b="$bytes" 'BEGIN { if (b >= 1073741824) printf "%.1f GB", b / 1073741824; else printf "%.1f MB", b / 1048576 }'
}

# bk_lock WAIT_SECONDS WHAT: the lock of the install folder that saas-deploy.sh holds during a
# deploy, so a backup or restore never runs while the files or the database are switched. While
# this script holds it, <backup>/run.active names it ("<pid> <start time> <what>"), so a deploy
# that finds the folder locked waits for it (saas-deploy.sh, lock_install).
bk_lock() {
    command -v flock >/dev/null 2>&1 || die "flock is not installed (package util-linux)"
    exec 8<"$INSTALL_DIR"
    if ! flock -n 8; then
        info "A deploy, backup or restore holds $INSTALL_DIR; waiting up to $1 seconds"
        flock -w "$1" 8 || die "$INSTALL_DIR stayed locked for $1 seconds; nothing was done"
    fi
    install -d -m 0700 "$BACKUP_DIR"
    printf '%s %s %s\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${2:-off-site backup}" >"$BACKUP_DIR/run.active"
    chmod 0644 "$BACKUP_DIR/run.active"
}

# bk_unlock_note: removes run.active (the lock itself ends with the process).
bk_unlock_note() {
    if [[ -n ${BACKUP_DIR:-} && -f $BACKUP_DIR/run.active ]] &&
        [[ $(cut -d ' ' -f 1 "$BACKUP_DIR/run.active" 2>/dev/null) == "$$" ]]; then
        rm -f -- "$BACKUP_DIR/run.active"
    fi
}

# bk_db_psql SQL: a query of the database mscd as postgres, inside the PostgreSQL container
# (no password needed); prints the unaligned result. Standard input is /dev/null: "docker compose
# exec" forwards it, and inside a "while read" loop it would eat the lines of the loop.
bk_db_psql() {
    bk_compose exec -T postgres psql -U postgres -d mscd -v ON_ERROR_STOP=1 -XAtq -c "$1" </dev/null
}

# bk_read_lines: reads key=value lines (snapshots, show) from standard input into BK_INFO.
declare -gA BK_INFO=()
bk_read_lines() {
    local line
    BK_INFO=()
    while IFS= read -r line; do
        [[ $line == *=* ]] || continue
        # shellcheck disable=SC2034  # read by the scripts that source this file
        BK_INFO[${line%%=*}]=${line#*=}
    done
}

# bk_tag TAGS NAME: the value of tag NAME=value in a comma list of restic tags.
bk_tag() {
    printf '%s\n' "$1" | tr ',' '\n' | sed -n "s/^$2=//p" | head -n 1
}

# bk_age_hours TIME: whole hours from TIME (RFC 3339) until now.
bk_age_hours() {
    local since
    since=$(date -u -d "$1" +%s 2>/dev/null) || {
        echo '?'
        return 0
    }
    echo $((($(date +%s) - since) / 3600))
}

# bk_volume NAME: the Docker volume NAME of the Compose project (empty when there is none).
bk_volume() {
    docker volume ls -q --filter "label=com.docker.compose.project=$MSCD_PROJECT" \
        --filter "label=com.docker.compose.volume=$1" | head -n 1
}

# bk_service_ids SERVICE: the containers of SERVICE in the Compose project.
bk_service_ids() {
    docker ps -aq --filter "label=com.docker.compose.project=$MSCD_PROJECT" \
        --filter "label=com.docker.compose.service=$1"
}

# bk_readyz SERVICE PORT: GET /readyz inside the container answers status ready.
bk_readyz() {
    bk_compose exec -T "$1" wget -q -T 5 -O - "http://127.0.0.1:$2/readyz" 2>/dev/null | grep -q '"status":"ready"'
}

# bk_wait SECONDS COMMAND...: runs COMMAND every 2 seconds until it succeeds or the time is up.
bk_wait() {
    local timeout=$1 start=$SECONDS
    shift
    until "$@" >/dev/null 2>&1; do
        ((SECONDS - start < timeout)) || return 1
        sleep 2
    done
}

# bk_verify_summary FILE: one line about the JSON summary of "mscd-server backup verify" (counts
# only), and its failures (they name organisations by id only).
bk_verify_summary() {
    local file=$1 orgs counts
    orgs=$(grep -c '"dataKey"' "$file" 2>/dev/null || true)
    counts=$(awk '/"objects": \{/ { inside = 1; next }
        inside && /\}/ { inside = 0 }
        inside && /"opened":/ { gsub(/[^0-9]/, "", $2); opened += $2 }
        inside && /"failed":/ { gsub(/[^0-9]/, "", $2); failed += $2 }
        END { printf "%d %d", opened, failed }' "$file" 2>/dev/null || echo '0 0')
    printf '%s organisation(s) checked, %s vault object(s) opened, %s did not open' "${orgs:-0}" "${counts% *}" "${counts#* }"
}

# bk_verify_failures FILE: the failure lines of a backup verify summary, indented.
bk_verify_failures() {
    sed -n '/"failures": \[/,/\]/p' "$1" | sed -n 's/^ *"\(.*\)",\{0,1\}$/\1/p' | sed 's/^/          /'
}

# bk_redact: hides organisation schema names and email addresses in log excerpts (workflow logs of
# a public repository are public, M2-S04 GL-50).
bk_redact() {
    sed -E -e 's/org_[a-z0-9_]+/org_[hidden]/g' -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/[email]/g'
}

# bk_version_newer A B: true when release version A is newer than B (x.y.z-rc.n before x.y.z).
bk_version_newer() {
    local a=$1 b=$2 ia ib i
    local -a pa pb
    [[ $a =~ ^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ && $b =~ ^[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] || return 1
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

# bk_restore_database FILE LOG: pg_restore of the dump FILE into the database mscd of the running
# postgres service, made by its initialisation scripts with the roles of postgres-roles.env. One
# transaction: a failure leaves the database as it was. Then the planner statistics.
bk_restore_database() {
    local file=$1 log=$2
    if bk_compose exec -T postgres pg_restore -U postgres --dbname=mscd --clean --if-exists --single-transaction \
        --exit-on-error <"$file" >"$log" 2>&1; then
        bk_compose exec -T postgres vacuumdb -U postgres --analyze-only --quiet --dbname=mscd >>"$log" 2>&1 || true
        return 0
    fi
    tail -n 8 "$log" | bk_redact | sed 's/^/          /'
    return 1
}

# bk_migrate LOG: migrate of the server image alone (the restored database to this release).
bk_migrate() {
    if bk_compose run --rm --no-deps -T migrate >"$1" 2>&1; then return 0; fi
    tail -n 12 "$1" | bk_redact | sed 's/^/          /'
    return 1
}

# bk_backup_verify SAMPLE FILE: "mscd-server backup verify --sample SAMPLE" through the cli service;
# the JSON summary goes to FILE and the messages to FILE.err.
bk_backup_verify() {
    bk_compose run --rm --no-deps -T cli backup verify --sample "$1" >"$2" 2>"$2.err"
}

# bk_db_value SQL: one value of the database mscd (empty on an error).
bk_db_value() {
    bk_db_psql "$1" 2>/dev/null | head -n 1 || true
}
