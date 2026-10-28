# shellcheck shell=bash disable=SC2034  # the constants and tables are read by saas-deploy.sh
# MSCD SaaS: helpers of saas-deploy.sh (Milestone 2 plan K, M2-S05). Sourced after
# lib/common.sh, which it uses and does not change. The deploy workflow
# (.github/workflows/deploy-prod.yml) and the rehearsal (test/saas-rehearsal.sh) also
# source it for saas_stage_release and saas_encode_input.
#
# Globals the functions read (set by saas-deploy.sh):
#   INSTALL_DIR   install folder (/opt/mscd)
#   RELEASE_DIR   release folder that holds deploy/ (/opt/mscd/releases/<tag>)
#   MSCD_PROJECT  Compose project name (lib/common.sh)
#   TIMEOUT       seconds to wait for one service to become healthy
#   LOG_DIR       folder of the deploy and migrate logs
#
# Layout of an install folder:
#   .env                   settings of the stack (written by every deploy, mode 0600)
#   deploy/                the deploy/ tree of the running release (Compose files and
#                          their config, scripts, and the backup and monitoring parts),
#                          copied in place so that bind mounts keep their paths;
#                          deploy/compose is the Compose project folder, and its .env is a
#                          link to ../../.env, so "docker compose ps" works there
#   site/                  the marketing site (MSCD_SITE_DIR)
#   secrets/               secret files; secrets/backup and secrets/ops hold one file per
#                          off-site backup and monitoring value
#   releases/<tag>/        release folders received from deploy-prod.yml
#   state/                 current.env, previous.env, history.log and saved/<stamp>-<version>
#                          (the files of earlier releases: the rollback points)
#   logs/, backup/pre-deploy/, metrics/, bin/cosign

# Signatures: release.yml of this repository signs every release digest with keyless
# cosign, so the certificate names the workflow file and the tag it ran from (M2-S01).
readonly SAAS_SIGNER_REPO=mqusaeri/mscd
readonly SAAS_OIDC_ISSUER=https://token.actions.githubusercontent.com
readonly SAAS_PROFILE_FILE=/app/apps/server/profiles/saas.yaml
readonly SAAS_ZERO_DIGEST=sha256:0000000000000000000000000000000000000000000000000000000000000000

# Compose files of the SaaS stack in the order they are applied. The first two are
# required; the overlays of M2-S07 (backups) and M2-S08 (monitoring) are used when the
# release has them.
readonly SAAS_COMPOSE_FILES=(docker-compose.yml docker-compose.saas.yml docker-compose.backup.yml docker-compose.ops.yml)

# Values on standard input (saas_read_input), one line each: NAME=<base64 of the value>.
#   Key files: compared with the files of the secrets folder or written when missing.
readonly SAAS_KEY_INPUTS=(PLATFORM_KEY STORAGE_KEY AUDIT_ANCHOR_KEY)
#   Written to the secret file smtp.password.
readonly SAAS_SMTP_INPUT=SMTP_PASSWORD
#   One file per name in <secrets>/backup (M2-S07 reads them) and <secrets>/ops (M2-S08).
readonly SAAS_BACKUP_INPUTS=(BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY BACKUP_S3_SECRET_KEY
    BACKUP_SECRETS_ACCESS_KEY BACKUP_SECRETS_SECRET_KEY BACKUP_RESTIC_PASSWORD HEARTBEAT_BACKUP_URL)
readonly SAAS_OPS_INPUTS=(HEARTBEAT_WATCHDOG_URL TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID ALERT_EMAIL_TO
    OPS_DOMAIN OPS_BASIC_AUTH_USER OPS_BASIC_AUTH_HASH)

# Settings of .env that a deploy sets. Each comes from standard input, else the
# environment, else the .env in place, else .env.saas.example of the release.
readonly SAAS_SETTINGS=(
    MSCD_DOMAIN MSCD_SITE_DOMAIN MSCD_TLS_MODE ACME_EMAIL ACME_CA
    MSCD_MAIL_FROM MSCD_SMTP_HOST MSCD_SMTP_PORT MSCD_SMTP_SECURE MSCD_SMTP_USER
    MSCD_HTTP_PORT MSCD_HTTPS_PORT MSCD_LOG_LEVEL
    MSCD_SUBNET MSCD_WEB_ADDRESS MSCD_EDGE_SUBNET MSCD_CADDY_ADDRESS MSCD_WEB_EDGE_ADDRESS MSCD_EDGE_SUBNET6
)
# The mail settings of .env, which go with the secret file smtp.password (MSCD_SMTP_USER
# is the account the password belongs to). Every deploy and rollback writes smtp.password
# from standard input, so a .env put back from saved files gets the mail settings of the
# run as well (saas_restore_files); every other setting is the saved one.
readonly SAAS_MAIL_SETTINGS=(MSCD_SMTP_HOST MSCD_SMTP_PORT MSCD_SMTP_SECURE MSCD_SMTP_USER MSCD_MAIL_FROM)
# Settings that come from the environment or the files only, never from standard input:
# the images (from digests.json), the profile and the Compose profiles.
readonly SAAS_FILE_SETTINGS=(MSCD_PROFILE_FILE COMPOSE_PROFILES)
# Settings worked out by the deploy unless they are given (standard input or environment).
readonly SAAS_DERIVED_SETTINGS=(MSCD_PUBLIC_URL MSCD_EDGE_IPV6)

# Services: the bundled data services (with their Compose profile), the services
# restarted in this order by every deploy, and those never started by it.
readonly SAAS_DATA_SERVICES=(postgres:bundled-db objectstore:bundled-s3)
readonly SAAS_APP_SERVICES=(storage-gateway api worker web caddy)
readonly SAAS_SERVER_SERVICES=(storage-gateway api worker)
readonly SAAS_NOT_STARTED='^(postgres|objectstore|valkey|migrate|cli|storage-gateway|api|worker|web|caddy)$'

readonly SAAS_KEEP_RELEASES=3   # releases whose images stay on the server
readonly SAAS_KEEP_SAVED=3      # saved settings of earlier releases (rollback points)
readonly SAAS_KEEP_DUMPS=3      # pre-deploy database dumps
readonly SAAS_KEEP_LOGS=20      # logs of each kind in LOG_DIR (saas_prune_logs)

declare -gA SAAS_IN=()      # standard input: NAME -> base64 value
declare -gA SAAS_VALUE=()   # settings of the new .env: NAME -> value
declare -gA SAAS_SOURCE=()  # where each setting came from

# ---------------------------------------------------------------------------
# Small utilities
# ---------------------------------------------------------------------------

saas_now() {
    date -u +%Y-%m-%dT%H:%M:%SZ
}

saas_stamp() {
    date -u +%Y%m%dT%H%M%SZ
}

# saas_in_list WORD LIST...: true when WORD is one of LIST.
saas_in_list() {
    local word=$1 item
    shift
    for item in "$@"; do
        [[ $item == "$word" ]] && return 0
    done
    return 1
}

# saas_redact: copies standard input to standard output with organisation schema names,
# email addresses and IP addresses hidden. Every log excerpt the deploy prints goes through
# it, because workflow logs of a public repository are public (M2-S04 follow-up 1): the
# migrate log and the output of docker and Compose commands. It does not hide organisation
# slugs or names, so service logs, which hold them, are never printed (service_logs of
# saas-deploy.sh). The full logs stay on the server in LOG_DIR.
saas_redact() {
    sed -E -e 's/org_[a-z0-9_]+/org_[hidden]/g' \
        -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/[email]/g' \
        -e 's/([0-9]{1,3}\.){3}[0-9]{1,3}/[address]/g' \
        -e 's/([0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}/[address]/g' \
        -e 's/[0-9a-fA-F]{0,4}(:[0-9a-fA-F]{1,4})*::([0-9a-fA-F]{1,4}(:[0-9a-fA-F]{1,4})*)?/[address]/g'
}

# saas_print_log FILE [LINES]: the last LINES lines of FILE, redacted and indented.
saas_print_log() {
    local file=$1 lines=${2:-60}
    [[ -f $file ]] || return 0
    tail -n "$lines" -- "$file" | saas_redact | sed 's/^/          /'
}

# saas_image_repository REF: REF without its tag or digest.
saas_image_repository() {
    local name=${1%%@*} last
    last=${name##*/}
    if [[ $last == *:* ]]; then name=${name%:*}; fi
    printf '%s' "$name"
}

saas_is_demo_image() {
    [[ $(saas_image_repository "$1") == *-demo ]]
}

# saas_valid_image NAME: a registry image name without tag or digest, lower case.
saas_valid_image() {
    [[ $1 =~ ^[a-z0-9]+([._-][a-z0-9]+)*(:[0-9]{1,5})?(/[a-z0-9]+([._-]{1,2}[a-z0-9]+)*)+$ ]]
}

saas_valid_digest() {
    [[ $1 =~ ^sha256:[0-9a-f]{64}$ && $1 != "$SAAS_ZERO_DIGEST" ]]
}

# saas_registry_host NAME: the registry part of an image name ("docker.io" when none).
saas_registry_host() {
    local first=${1%%/*}
    if [[ $1 == */* && ($first == *.* || $first == *:* || $first == localhost) ]]; then
        printf '%s' "$first"
    else
        printf 'docker.io'
    fi
}

# saas_loopback_registry NAME: true when the image comes from a registry on 127.0.0.1.
saas_loopback_registry() {
    [[ $(saas_registry_host "$1") =~ ^127\.0\.0\.1(:[0-9]{1,5})?$ ]]
}

saas_valid_version() {
    [[ $1 =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.(0|[1-9][0-9]*))?$ ]]
}

# saas_json_string FILE KEY: the string value of KEY in a flat JSON file such as
# digests.json (no JSON tool is installed on the server). Values are checked by the caller.
saas_json_string() {
    { grep -o "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" -- "$1" 2>/dev/null || true; } | head -n 1 |
        sed -E 's/^"[^"]*"[[:space:]]*:[[:space:]]*"(.*)"$/\1/'
}

# saas_tree_hash DIR: one hash over the names and contents of the files in DIR.
saas_tree_hash() {
    if [[ -d $1 ]]; then
        (cd -- "$1" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum) | sha256sum | cut -c1-16
    else
        echo none
    fi
}

# saas_sync_dir SRC DST: makes DST hold exactly the files of SRC. DST keeps its own inode,
# so a bind mount of DST in a running container (Caddy's /etc/caddy) sees the new files.
saas_sync_dir() {
    local src=$1 dst=$2 rel
    install -d -m 0755 "$dst"
    if [[ -d $src ]]; then
        cp -R -- "$src/." "$dst/"
    fi
    while IFS= read -r -d '' rel; do
        if [[ ! -e $src/$rel && ! -L $src/$rel ]]; then rm -rf -- "${dst:?}/$rel"; fi
    done < <(cd -- "$dst" && find . -mindepth 1 -depth -print0)
    find "$dst" -type d -exec chmod 0755 {} +
    find "$dst" -type f -name '*.sh' -exec chmod 0755 {} +
    find "$dst" -type f ! -name '*.sh' -exec chmod 0644 {} +
}

# saas_prune_dir DIR PATTERN KEEP: deletes all but the newest KEEP entries of DIR whose
# names match PATTERN (names start with a time stamp, so they sort by age).
saas_prune_dir() {
    local dir=$1 pattern=$2 keep=$3 entries=() i
    [[ -d $dir ]] || return 0
    mapfile -t entries < <(find "$dir" -mindepth 1 -maxdepth 1 -name "$pattern" -printf '%f\n' | LC_ALL=C sort)
    for ((i = 0; i < ${#entries[@]} - keep; i++)); do
        rm -rf -- "${dir:?}/${entries[i]}"
    done
}

# saas_prune_logs DIR KEEP: keeps the newest KEEP logs of each kind in DIR and deletes the
# older ones. Each kind has its own count: the run log, the Compose log and the service
# log of deploy and of rollback, the migrate log, and the log of the off-site copy of the
# pre-deploy dump. The age is the time stamp of saas_stamp in the name, because a migrate
# log name starts with the version, which does not sort by age.
saas_prune_logs() {
    local dir=$1 keep=$2 pattern name entries=() i re='([0-9]{8}T[0-9]{6}Z)'
    [[ -d $dir ]] || return 0
    for pattern in 'deploy-*Z.log' 'deploy-*Z-compose.log' 'deploy-*Z-services.log' \
        'rollback-*Z.log' 'rollback-*Z-compose.log' 'rollback-*Z-services.log' \
        'migrate-*Z.log' 'backup-pre-deploy-*Z.log'; do
        mapfile -t entries < <(
            find "$dir" -mindepth 1 -maxdepth 1 -type f -name "$pattern" -printf '%f\n' |
                while IFS= read -r name; do
                    if [[ $name =~ $re ]]; then
                        printf '%s %s\n' "${BASH_REMATCH[1]}" "$name"
                    else
                        printf '0 %s\n' "$name"
                    fi
                done | LC_ALL=C sort | cut -d ' ' -f 2-
        )
        for ((i = 0; i < ${#entries[@]} - keep; i++)); do
            rm -f -- "${dir:?}/${entries[i]}"
        done
    done
}

# ---------------------------------------------------------------------------
# Release folder (what the server receives)
# ---------------------------------------------------------------------------

# saas_stage_release REPO DEST: copies the files a server needs from the repository REPO
# into the empty folder DEST, in the layout of /opt/mscd/releases/<tag>:
#   deploy/compose/{docker-compose.yml, docker-compose.saas.yml, .env.saas.example}
#   deploy/compose/docker-compose.{backup,ops}.yml when present
#   deploy/compose/config/{postgres,caddy}
#   deploy/scripts, and deploy/backup and deploy/ops when present
#   site/{index.html,id,assets}: the marketing site of apps/site (MSCD_SITE_DOMAIN)
# The demo secrets, the demo overlay and the development files are never copied; the
# workflow's rsync excludes them again.
saas_stage_release() {
    local repo=$1 dest=$2 name
    [[ -d $repo/deploy/compose && -d $repo/deploy/scripts ]] || die "$repo is not an MSCD repository (no deploy/compose)"
    install -d -m 0755 "$dest/deploy/compose/config" "$dest/deploy/scripts"
    for name in docker-compose.yml docker-compose.saas.yml .env.saas.example; do
        [[ -f $repo/deploy/compose/$name ]] || die "$repo/deploy/compose/$name is missing"
        install -m 0644 "$repo/deploy/compose/$name" "$dest/deploy/compose/$name"
    done
    for name in docker-compose.backup.yml docker-compose.ops.yml; do
        if [[ -f $repo/deploy/compose/$name ]]; then
            install -m 0644 "$repo/deploy/compose/$name" "$dest/deploy/compose/$name"
        fi
    done
    for name in postgres caddy; do
        [[ -d $repo/deploy/compose/config/$name ]] || die "$repo/deploy/compose/config/$name is missing"
        cp -R -- "$repo/deploy/compose/config/$name" "$dest/deploy/compose/config/$name"
    done
    cp -R -- "$repo/deploy/scripts/." "$dest/deploy/scripts/"
    for name in backup ops; do
        if [[ -d $repo/deploy/$name ]]; then cp -R -- "$repo/deploy/$name" "$dest/deploy/$name"; fi
    done
    if [[ -f $repo/apps/site/index.html ]]; then
        install -d -m 0755 "$dest/site"
        cp -R -- "$repo/apps/site/index.html" "$dest/site/"
        for name in id assets; do
            if [[ -d $repo/apps/site/$name ]]; then cp -R -- "$repo/apps/site/$name" "$dest/site/"; fi
        done
    fi
    # Second guard, as build-bundle.sh and install_config: nothing of the demo stack.
    rm -rf -- "$dest/deploy/compose/config/demo-secrets" "$dest/deploy/compose/docker-compose.demo.yml" \
        "$dest/deploy/compose/dev"
    chmod -R u+rwX,go+rX,go-w "$dest"
}

# saas_check_release DIR: the release folder holds the files the deploy needs.
saas_check_release() {
    local dir=$1 name ok=0
    for name in deploy/compose/docker-compose.yml deploy/compose/docker-compose.saas.yml \
        deploy/compose/.env.saas.example deploy/compose/config/postgres deploy/compose/config/caddy/Caddyfile \
        deploy/scripts/lib/common.sh deploy/scripts/lib/saas.sh; do
        if [[ ! -e $dir/$name ]]; then
            fail "The release folder $dir has no $name" "Copy the release again (deploy-prod.yml does this)"
            ok=1
        fi
    done
    return "$ok"
}

# ---------------------------------------------------------------------------
# Refusals (S-7): nothing of the demo stack runs on a SaaS server
# ---------------------------------------------------------------------------

# saas_refuse_demo DIGESTS_FILE ENV_FILE...: FAIL lines for demo images, demo and test
# profiles, MSCD_DEMO settings and demo files. Reads the environment, the digests file
# and every ENV_FILE that exists. Never reads standard input.
saas_refuse_demo() {
    local digests=$1 file key value name dir
    shift
    local -a sources=()
    for key in MSCD_SERVER_IMAGE MSCD_IMAGE; do
        if [[ -n ${!key:-} ]]; then sources+=("$key (environment)|${!key}"); fi
    done
    if [[ -f $digests ]]; then
        for key in serverImage webImage serverRef webRef; do
            value=$(saas_json_string "$digests" "$key")
            if [[ -n $value ]]; then sources+=("$key ($digests)|$value"); fi
        done
    fi
    for file in "$@"; do
        [[ -f $file ]] || continue
        for key in MSCD_SERVER_IMAGE MSCD_IMAGE; do
            value=$(kv_get "$file" "$key")
            if [[ -n $value ]]; then sources+=("$key ($file)|$value"); fi
        done
    done
    for value in "${sources[@]}"; do
        if saas_is_demo_image "${value#*|}"; then
            fail "demo images are refused: ${value#*|} from ${value%%|*} ends in -demo" \
                "Deploy the release images ghcr.io/mqusaeri/mscd-server and mscd-web (S-7)"
        fi
    done

    sources=()
    if [[ -n ${MSCD_PROFILE_FILE:-} ]]; then sources+=("MSCD_PROFILE_FILE (environment)|$MSCD_PROFILE_FILE"); fi
    for file in "$@"; do
        [[ -f $file ]] || continue
        value=$(kv_get "$file" MSCD_PROFILE_FILE)
        if [[ -n $value ]]; then sources+=("MSCD_PROFILE_FILE ($file)|$value"); fi
    done
    for value in "${sources[@]}"; do
        case "$(basename -- "${value#*|}")" in
            demo.yaml | test.yaml)
                fail "demo and test profiles are refused: ${value#*|} from ${value%%|*}" \
                    "A SaaS server runs $SAAS_PROFILE_FILE only (S-7)"
                ;;
        esac
    done
    while IFS= read -r name; do
        [[ -n $name ]] || continue
        fail "demo and test profiles are refused: the demo setting $name is set in the environment" \
            "Remove it; MSCD_DEMO settings belong to the demo stack (S-7)"
    done < <(compgen -e | grep '^MSCD_DEMO' || true)
    for file in "$@"; do
        [[ -f $file ]] || continue
        while IFS= read -r name; do
            [[ -n $name ]] || continue
            fail "demo and test profiles are refused: the demo setting $name is in $file" \
                "Remove it; MSCD_DEMO settings belong to the demo stack (S-7)"
        done < <(sed -n 's/^\(MSCD_DEMO[A-Z0-9_]*\)=.*/\1/p' "$file")
    done

    for dir in "$RELEASE_DIR/deploy/compose" "$INSTALL_DIR"; do
        for name in config/demo-secrets docker-compose.demo.yml; do
            if [[ -e $dir/$name ]]; then
                fail "demo files are refused: $dir/$name" \
                    "Deploy a release folder copied by deploy-prod.yml, which leaves the demo files out; the demo stack never reaches a SaaS server (S-7)"
            fi
        done
    done
}

# ---------------------------------------------------------------------------
# Host checks
# ---------------------------------------------------------------------------

# saas_check_host MIN_DISK_MB: memory, free disk for Docker and for the install folder,
# and the tools the deploy uses.
saas_check_host() {
    local min_disk=$1 total_kb avail_kb total_mb avail_mb docker_root tool
    total_kb=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null || true)
    avail_kb=$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo 2>/dev/null || true)
    total_mb=$((${total_kb:-0} / 1024))
    avail_mb=$((${avail_kb:-0} / 1024))
    # An "8 GB" server reports a little less than 8192 MB. The stack's memory limits add
    # up to 12 GB, so production wants 16 GB (K.2).
    if ((total_mb >= 7400)); then
        pass "Memory: $total_mb MB total, $avail_mb MB available"
    else
        fail "Memory: $total_mb MB total; the SaaS stack needs 8 GB or more (16 GB for production)" \
            "Use a larger server (docs/saas/bootstrap.md)"
    fi
    if ((avail_mb > 0 && avail_mb < 1024)); then
        warn "Only $avail_mb MB of memory is available; the new containers start next to the old ones"
    fi
    docker_root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
    check_disk "$docker_root" "Docker data ($docker_root)" "$min_disk"
    check_disk "$INSTALL_DIR" "the install folder ($INSTALL_DIR)" 1024
    for tool in openssl curl flock timeout base64 sha256sum; do
        command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed" "Install it with apt-get (bootstrap-host.sh installs it)"
    done
}

# saas_host_has_ipv6: true when the server has a global IPv6 address (MSCD_EDGE_IPV6).
saas_host_has_ipv6() {
    [[ -r /proc/net/if_inet6 ]] && awk '$4 == "00" && $6 != "lo" { found = 1 } END { exit !found }' /proc/net/if_inet6
}

# ---------------------------------------------------------------------------
# Standard input: NAME=<base64> lines
# ---------------------------------------------------------------------------

# saas_input_names: every name accepted on standard input.
saas_input_names() {
    printf '%s\n' "${SAAS_KEY_INPUTS[@]}" "$SAAS_SMTP_INPUT" "${SAAS_BACKUP_INPUTS[@]}" "${SAAS_OPS_INPUTS[@]}" \
        "${SAAS_SETTINGS[@]}" "${SAAS_DERIVED_SETTINGS[@]}"
}

# saas_encode_input NAME...: prints NAME=<base64 of $NAME> for each NAME whose variable
# is set (empty values included). The deploy workflow builds standard input with it, so
# no value ever appears on a command line.
saas_encode_input() {
    local name
    for name in "$@"; do
        if [[ -n ${!name+x} ]]; then
            printf '%s=%s\n' "$name" "$(printf '%s' "${!name}" | base64 -w0)"
        fi
    done
}

# saas_read_input: reads standard input into SAAS_IN. Lines are NAME=<base64 value>; empty
# lines are skipped. Unknown or repeated names and values that are not base64 stop the
# deploy. The values are never printed.
saas_read_input() {
    local line name value count=0 ok=0
    local -a known
    mapfile -t known < <(saas_input_names)
    if [[ -t 0 ]]; then
        fail "Standard input is a terminal" \
            "Send the secret values on standard input as NAME=<base64> lines (docs/saas/deploy.md); deploy-prod.yml does this"
        return 1
    fi
    while IFS= read -r line || [[ -n $line ]]; do
        line=${line%$'\r'}
        [[ -n $line ]] || continue
        count=$((count + 1))
        if ((count > 200)); then
            fail "Standard input has more than 200 lines"
            return 1
        fi
        if [[ ! $line =~ ^([A-Z][A-Z0-9_]{0,63})=([A-Za-z0-9+/]*={0,2})$ ]]; then
            fail "Line $count of standard input is not NAME=<base64 value> (the line is not shown)"
            ok=1
            continue
        fi
        name=${BASH_REMATCH[1]} value=${BASH_REMATCH[2]}
        if ! saas_in_list "$name" "${known[@]}"; then
            fail "Standard input names $name, which the deploy does not take" \
                "Accepted: the key files, SMTP_PASSWORD, the BACKUP_*, HEARTBEAT_*, TELEGRAM_* and ALERT_EMAIL_TO values and the settings of docs/saas/deploy.md"
            ok=1
            continue
        fi
        if [[ -n ${SAAS_IN[$name]+x} ]]; then
            fail "$name appears twice on standard input"
            ok=1
            continue
        fi
        if ! printf '%s' "$value" | base64 -d >/dev/null 2>&1; then
            fail "The value of $name on standard input is not valid base64"
            ok=1
            continue
        fi
        SAAS_IN[$name]=$value
    done
    for name in "${SAAS_KEY_INPUTS[@]}" "$SAAS_SMTP_INPUT"; do
        if [[ -z ${SAAS_IN[$name]+x} ]]; then
            fail "$name is missing on standard input" "deploy-prod.yml sends it from the secret of the GitHub environment"
            ok=1
        fi
    done
    return "$ok"
}

saas_has_input() {
    [[ -n ${SAAS_IN[$1]+x} ]]
}

# saas_input NAME: the decoded value (a final line break is dropped).
saas_input() {
    printf '%s' "${SAAS_IN[$1]:-}" | base64 -d
}

# saas_input_to_file NAME FILE: the decoded value, byte for byte, into FILE (mode 0600).
saas_input_to_file() {
    (umask 077 && printf '%s' "${SAAS_IN[$1]:-}" | base64 -d >"$2")
}

# ---------------------------------------------------------------------------
# Settings and .env
# ---------------------------------------------------------------------------

# saas_setting_from NAME CURRENT_ENV EXAMPLE [EXAMPLE_LABEL]: sets SAAS_VALUE[NAME] and
# SAAS_SOURCE[NAME] from standard input, the environment, the .env in place or the example
# (named EXAMPLE_LABEL in SAAS_SOURCE, default .env.saas.example), in that order.
saas_setting_from() {
    local name=$1 current=$2 example=$3 label=${4:-.env.saas.example}
    if saas_has_input "$name"; then
        SAAS_VALUE[$name]=$(saas_input "$name")
        SAAS_SOURCE[$name]="standard input"
    elif [[ -n ${!name+x} ]]; then
        SAAS_VALUE[$name]=${!name}
        SAAS_SOURCE[$name]=environment
    elif [[ -f $current ]] && grep -q "^$name=" "$current"; then
        SAAS_VALUE[$name]=$(kv_get "$current" "$name")
        SAAS_SOURCE[$name]=".env in place"
    elif [[ -f $example ]] && grep -q "^$name=" "$example"; then
        SAAS_VALUE[$name]=$(kv_get "$example" "$name")
        SAAS_SOURCE[$name]=$label
    fi
}

# saas_given NAME: true when NAME came from standard input or the environment.
saas_given() {
    saas_has_input "$1" || [[ -n ${!1+x} ]]
}

# saas_resolve_settings CURRENT_ENV EXAMPLE: every setting of the new .env except the
# images (saas_set_images).
saas_resolve_settings() {
    local current=$1 example=$2 name port
    for name in "${SAAS_SETTINGS[@]}" "${SAAS_FILE_SETTINGS[@]}"; do
        saas_setting_from "$name" "$current" "$example"
    done
    if saas_given MSCD_EDGE_IPV6; then
        saas_setting_from MSCD_EDGE_IPV6 "" "$example"
    elif saas_host_has_ipv6; then
        SAAS_VALUE[MSCD_EDGE_IPV6]=true SAAS_SOURCE[MSCD_EDGE_IPV6]="this server has a global IPv6 address"
    else
        SAAS_VALUE[MSCD_EDGE_IPV6]=false SAAS_SOURCE[MSCD_EDGE_IPV6]="this server has no global IPv6 address"
    fi
    # The Grafana host of the monitoring overlay (OPS_DOMAIN) needs the grafana profile.
    if [[ -n $(saas_input OPS_DOMAIN 2>/dev/null) && ,${SAAS_VALUE[COMPOSE_PROFILES]:-}, != *,grafana,* ]]; then
        SAAS_VALUE[COMPOSE_PROFILES]=${SAAS_VALUE[COMPOSE_PROFILES]:+${SAAS_VALUE[COMPOSE_PROFILES]},}grafana
        SAAS_SOURCE[COMPOSE_PROFILES]+=", grafana added because OPS_DOMAIN is set"
    fi
    if saas_given MSCD_PUBLIC_URL; then
        saas_setting_from MSCD_PUBLIC_URL "" "$example"
    else
        port=${SAAS_VALUE[MSCD_HTTPS_PORT]:-443}
        SAAS_VALUE[MSCD_PUBLIC_URL]=https://${SAAS_VALUE[MSCD_DOMAIN]:-}
        if [[ $port != 443 ]]; then SAAS_VALUE[MSCD_PUBLIC_URL]+=":$port"; fi
        SAAS_SOURCE[MSCD_PUBLIC_URL]="https://MSCD_DOMAIN"
    fi
}

# saas_set_images SERVER_IMAGE SERVER_DIGEST WEB_IMAGE WEB_DIGEST VERSION
saas_set_images() {
    SAAS_VALUE[MSCD_SERVER_IMAGE]=$1
    SAAS_VALUE[MSCD_SERVER_DIGEST]=$2
    SAAS_VALUE[MSCD_IMAGE]=$3
    SAAS_VALUE[MSCD_WEB_DIGEST]=$4
    SAAS_VALUE[MSCD_VERSION]=$5
}

# saas_check_value NAME: FAIL when a setting holds characters that .env cannot carry
# literally (Compose would expand $ and drop text after " #").
saas_check_value() {
    local name=$1 value=${SAAS_VALUE[$1]:-}
    if [[ $value == *[\$\'\"\\\`]* || $value == *' #'* || $value == *$'\n'* || $value == *$'\r'* ]]; then
        fail "$name holds a character that .env cannot carry (\$, quotes, backslash, backtick, ' #' or a line break)"
        return 1
    fi
}

# saas_validate_settings TARGET: FAIL lines for settings that cannot work.
saas_validate_settings() {
    local target=$1 name value
    local -A v=()
    for name in "${!SAAS_VALUE[@]}"; do
        v[$name]=${SAAS_VALUE[$name]}
        saas_check_value "$name" || true
    done
    value=${v[MSCD_DOMAIN]:-}
    if ! valid_host "$value" || is_ipv4 "$value"; then
        fail "MSCD_DOMAIN '$value' is not a host name" "Set the variable MSCD_DOMAIN of the GitHub environment, for example app.example.co.id"
    elif [[ $target != test && ($value == localhost || $value == *.localhost || $value == example.* || $value == *.example.* || $value == *.invalid || $value == *.test) ]]; then
        fail "MSCD_DOMAIN '$value' is a placeholder or test name" "Set the variable MSCD_DOMAIN of the GitHub environment"
    fi
    value=${v[MSCD_PUBLIC_URL]:-}
    if [[ ! $value =~ ^https://([A-Za-z0-9.-]+)(:[0-9]{1,5})?$ || ${BASH_REMATCH[1]} != "${v[MSCD_DOMAIN]:-}" ]]; then
        fail "MSCD_PUBLIC_URL '$value' must be https://<MSCD_DOMAIN> (with the port when it is not 443)"
    fi
    value=${v[MSCD_SITE_DOMAIN]:-}
    if [[ -n $value ]] && { ! valid_host "$value" || [[ $value == "${v[MSCD_DOMAIN]:-}" ]]; }; then
        fail "MSCD_SITE_DOMAIN '$value' must be empty or a host name other than MSCD_DOMAIN"
    fi
    case "${v[MSCD_TLS_MODE]:-}" in
        acme) ;;
        internal)
            if [[ $target != test ]]; then
                fail "MSCD_TLS_MODE internal is for test stacks only, not for $target" \
                    "Remove the setting; a server uses acme (Let's Encrypt)"
            fi
            ;;
        *) fail "MSCD_TLS_MODE must be acme or internal, got '${v[MSCD_TLS_MODE]:-}'" ;;
    esac
    value=${v[ACME_CA]:-}
    if [[ ! $value =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/[^[:space:]]*$ ]]; then
        fail "ACME_CA '$value' is not an https address"
    fi
    value=${v[ACME_EMAIL]:-}
    if [[ -n $value && ! $value =~ ^[^[:space:]@]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
        fail "ACME_EMAIL '$value' is not an email address (it may be empty)"
    elif [[ $target != test && $value == *@example.* ]]; then
        fail "ACME_EMAIL '$value' is the placeholder of .env.saas.example; Let's Encrypt refuses it" \
            "Set the variable ACME_EMAIL of the GitHub environment, or leave it empty"
    fi
    saas_validate_mail_settings "$target"
    for name in MSCD_HTTP_PORT MSCD_HTTPS_PORT; do
        value=${v[$name]:-}
        if [[ -n $value ]] && ! valid_port "$value"; then
            fail "$name '$value' is not a port number"
        fi
    done
    if [[ -n ${v[MSCD_HTTP_PORT]:-} && ${v[MSCD_HTTP_PORT]:-} == "${v[MSCD_HTTPS_PORT]:-}" ]]; then
        fail "MSCD_HTTP_PORT and MSCD_HTTPS_PORT must differ"
    fi
    case "${v[MSCD_EDGE_IPV6]:-}" in
        true | false) ;;
        *) fail "MSCD_EDGE_IPV6 must be true or false, got '${v[MSCD_EDGE_IPV6]:-}'" ;;
    esac
    case "${v[MSCD_LOG_LEVEL]:-info}" in
        fatal | error | warn | info | debug | trace) ;;
        *) fail "MSCD_LOG_LEVEL must be fatal, error, warn, info, debug or trace" ;;
    esac
    for name in MSCD_SUBNET MSCD_EDGE_SUBNET; do
        if [[ ! ${v[$name]:-} =~ ^172\.31\.[0-9]{1,3}\.0/24$ ]]; then
            fail "$name '${v[$name]:-}' must be a 172.31.x.0/24 range (the range the Docker address pools of the server leave free)"
        fi
    done
    for name in MSCD_WEB_ADDRESS:MSCD_SUBNET MSCD_CADDY_ADDRESS:MSCD_EDGE_SUBNET MSCD_WEB_EDGE_ADDRESS:MSCD_EDGE_SUBNET; do
        value=${v[${name%%:*}]:-}
        if ! is_ipv4 "$value" || [[ ${value%.*}.0/24 != "${v[${name#*:}]:-}" ]]; then
            fail "${name%%:*} '$value' must be an address inside ${name#*:} (${v[${name#*:}]:-})"
        fi
    done
    value=${v[MSCD_PROFILE_FILE]:-}
    if [[ $value != "$SAAS_PROFILE_FILE" ]]; then
        case "$(basename -- "$value")" in
            demo.yaml | test.yaml) ;; # reported by saas_refuse_demo
            *) fail "MSCD_PROFILE_FILE '$value' is not $SAAS_PROFILE_FILE" "A SaaS server runs the saas.yaml profile only" ;;
        esac
    fi
    value=,${v[COMPOSE_PROFILES]:-},
    if [[ $value != *,bundled-db,* || $value != *,bundled-s3,* || ! $value =~ ^,[a-z0-9_,-]*,$ || $value == *demo* ]]; then
        fail "COMPOSE_PROFILES '${v[COMPOSE_PROFILES]:-}' must list bundled-db and bundled-s3 (and optional profiles such as grafana)"
    fi
}

# saas_validate_mail_settings TARGET: FAIL lines for mail settings of SAAS_VALUE that cannot
# work (saas_validate_settings, and the rollback, which sets only these).
saas_validate_mail_settings() {
    local target=$1 value
    value=${SAAS_VALUE[MSCD_SMTP_HOST]:-}
    if ! valid_host "$value"; then
        fail "MSCD_SMTP_HOST '$value' is not a host name" "Set the variable SMTP_HOST of the GitHub environment"
    elif [[ $target != test && ($value == *example.* || $value == *.invalid) ]]; then
        fail "MSCD_SMTP_HOST '$value' is the placeholder of .env.saas.example" "Set the variable SMTP_HOST of the GitHub environment"
    fi
    value=${SAAS_VALUE[MSCD_SMTP_PORT]:-}
    valid_port "$value" || fail "MSCD_SMTP_PORT '$value' is not a port number"
    case "${SAAS_VALUE[MSCD_SMTP_SECURE]:-}" in
        true | false) ;;
        *) fail "MSCD_SMTP_SECURE must be true or false, got '${SAAS_VALUE[MSCD_SMTP_SECURE]:-}'" ;;
    esac
    value=${SAAS_VALUE[MSCD_MAIL_FROM]:-}
    if [[ ! $value =~ @[A-Za-z0-9.-]+\.[A-Za-z]{2,} ]]; then
        fail "MSCD_MAIL_FROM '$value' holds no email address" "Set the variable MAIL_FROM of the GitHub environment"
    elif [[ $target != test && $value == *@example.* ]]; then
        fail "MSCD_MAIL_FROM '$value' is the placeholder of .env.saas.example" "Set the variable MAIL_FROM of the GitHub environment"
    fi
}

# saas_write_env OUT EXAMPLE: the new .env: the release's example with every setting of
# SAAS_VALUE written into it (mode 0600).
saas_write_env() {
    local out=$1 example=$2 name
    install -m 0600 "$example" "$out"
    for name in $(printf '%s\n' "${!SAAS_VALUE[@]}" | LC_ALL=C sort); do
        env_set "$out" "$name" "${SAAS_VALUE[$name]}"
    done
}

# saas_compose_list DIR: the Compose files of DIR in their order, one per line.
saas_compose_list() {
    local name
    for name in "${SAAS_COMPOSE_FILES[@]}"; do
        if [[ -f $1/$name ]]; then printf '%s\n' "$name"; fi
    done
}

# saas_compose_cmd [DIR [ENV_FILE]]: fills SAAS_COMPOSE_CMD with the docker compose
# command of the stack: project folder DIR (default: the installed deploy/compose), every
# Compose file of DIR and ENV_FILE (default: the .env of the install folder).
saas_compose_cmd() {
    local dir=${1:-$INSTALL_DIR/deploy/compose} env=${2:-$INSTALL_DIR/.env} name
    SAAS_COMPOSE_CMD=(docker compose -p "$MSCD_PROJECT" --project-directory "$dir")
    while IFS= read -r name; do SAAS_COMPOSE_CMD+=(-f "$dir/$name"); done < <(saas_compose_list "$dir")
    SAAS_COMPOSE_CMD+=(--env-file "$env")
}

# saas_compose ARGS...: docker compose for the installed stack.
saas_compose() {
    saas_compose_cmd
    "${SAAS_COMPOSE_CMD[@]}" "$@"
}

# saas_compose_check ENV_FILE: docker compose config -q with the release's Compose files
# and ENV_FILE, before anything is installed.
saas_compose_check() {
    local env=$1 out
    saas_compose_cmd "$RELEASE_DIR/deploy/compose" "$env"
    if out=$("${SAAS_COMPOSE_CMD[@]}" config -q 2>&1); then
        pass "Compose configuration is valid ($(saas_compose_list "$RELEASE_DIR/deploy/compose" | paste -sd ' ' -))"
        return 0
    fi
    fail "docker compose config refused the new settings"
    printf '%s\n' "$out" | tail -n 10 | saas_redact | sed 's/^/          /'
    return 1
}

# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------

# saas_cosign_verify COSIGN REF IDENTITY LOG: keyless signature of REF made by release.yml
# for the tag in IDENTITY.
saas_cosign_verify() {
    local cosign=$1 ref=$2 identity=$3 log=$4
    "$cosign" verify --certificate-identity "$identity" --certificate-oidc-issuer "$SAAS_OIDC_ISSUER" \
        "$ref" >>"$log" 2>&1
}

# saas_pull REF: pulls REF (image@digest) when this server does not hold it. Pulled
# references are listed in SAAS_PULLED, so a refused release can be removed again.
SAAS_PULLED=()
saas_pull() {
    local ref=$1 out
    if image_exists "$ref"; then
        pass "Image $ref is on this server"
        return 0
    fi
    if out=$(docker pull --quiet "$ref" 2>&1); then
        SAAS_PULLED+=("$ref")
        pass "Pulled $ref"
        return 0
    fi
    fail "docker pull $ref failed" "Check the registry login (deploy-prod.yml logs in to ghcr.io with the job token)"
    printf '%s\n' "$out" | tail -n 5 | saas_redact | sed 's/^/          /'
    return 1
}

# saas_check_server_image REF LOG: the server image is a release build and starts.
saas_check_server_image() {
    local ref=$1 log=$2 flavor
    flavor=$(docker image inspect --format '{{index .Config.Labels "com.cyberlentera.mscd.flavor"}}' "$ref" 2>/dev/null || true)
    case "$flavor" in
        release) pass "The server image is a release build" ;;
        demo)
            fail "demo images are refused: $ref is a demo build (label com.cyberlentera.mscd.flavor=demo)"
            return 1
            ;;
        *)
            fail "$ref is not an MSCD release server image (label com.cyberlentera.mscd.flavor is '${flavor:-missing}')"
            return 1
            ;;
    esac
    if docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
        "$ref" --help >>"$log" 2>&1; then
        pass "The new server image starts (mscd-server --help)"
        return 0
    fi
    fail "The new server image does not start (mscd-server --help failed)"
    saas_print_log "$log" 8
    return 1
}

# saas_discard_pulled: removes the images this run pulled (a refused release); an image
# that a container uses stays.
saas_discard_pulled() {
    local ref
    for ref in "${SAAS_PULLED[@]}"; do
        docker image rm "$ref" >/dev/null 2>&1 || true
    done
    SAAS_PULLED=()
}

# saas_prune_images KEEP_REF...: removes the images of the MSCD server and web
# repositories that are not in KEEP_REF (image@digest) and that no container uses.
saas_prune_images() {
    local ref repo tag digest name removed=0
    local -A keep_refs=() repos=()
    for ref in "$@"; do
        [[ -n $ref ]] || continue
        keep_refs[$ref]=1
        repos[$(saas_image_repository "$ref")]=1
    done
    local -A used=()
    while IFS= read -r ref; do
        [[ -n $ref ]] && used[$ref]=1
    done < <(docker ps -aq | xargs -r docker inspect --format '{{.Image}}' 2>/dev/null || true)
    for repo in "${!repos[@]}"; do
        while read -r name tag digest; do
            [[ -n $digest && $digest != '<none>' ]] || continue
            [[ -z ${keep_refs[$name@$digest]+x} ]] || continue
            [[ -z ${used[$digest]+x} ]] || continue
            if [[ $tag != '<none>' ]]; then docker image rm "$name:$tag" >/dev/null 2>&1 || true; fi
            if docker image rm "$name@$digest" >/dev/null 2>&1; then removed=$((removed + 1)); fi
        done < <(docker image ls --digests --format '{{.Repository}} {{.Tag}} {{.Digest}}' "$repo" 2>/dev/null)
    done
    pass "Images of the last $SAAS_KEEP_RELEASES releases kept; $removed older image(s) removed"
}

# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------

# saas_read_secret DIR NAME IMAGE: prints the secret file DIR/NAME. A file this user cannot
# read (it belongs to the container user) is read by a short-lived container of IMAGE that
# runs as the file's owner, with no network and no capabilities. Only the file is mounted,
# because the secrets folder (0700) is closed to that user.
saas_read_secret() {
    local dir=$1 name=$2 image=$3 owner
    if [[ -r $dir/$name ]]; then
        cat -- "$dir/$name"
        return
    fi
    owner=$(stat -c '%u:%g' -- "$dir/$name") || return 1
    # The key reaches this script through the attached output only: with the log driver
    # none, the Docker daemon writes none of it to its log store (the local driver of the
    # server writes container output to disk, journald or syslog would keep it).
    docker run --rm --log-driver none --network none --read-only --cap-drop ALL \
        --security-opt no-new-privileges:true --user "$owner" --entrypoint cat \
        -v "$dir/$name:/run/mscd-secret:ro,z" "$image" /run/mscd-secret
}

# saas_compact: standard input without any white space (key files compare by content,
# whatever their line breaks).
saas_compact() {
    tr -d '[:space:]'
}

# saas_install_keys DIR IMAGE WORK: platform.key, storage.key and audit-anchor.key from
# standard input. A missing file is written; an existing file must hold the same key, and
# a difference stops the deploy before anything is written. audit-anchor.pub is derived
# from the private key in the format of "mscd-server keys generate" (SPKI PEM).
saas_install_keys() {
    local dir=$1 image=$2 work=$3 entry file input kind existing new pub ok=0
    local -a missing=()
    for entry in platform.key:PLATFORM_KEY:kek storage.key:STORAGE_KEY:kek audit-anchor.key:AUDIT_ANCHOR_KEY:pem; do
        IFS=: read -r file input kind <<<"$entry"
        saas_input_to_file "$input" "$work/$file"
        if [[ $kind == kek ]]; then
            new=$(saas_compact <"$work/$file")
            if [[ ! $new =~ ^[A-Za-z0-9+/]+={0,2}$ ]] || (($(printf '%s' "$new" | base64 -d 2>/dev/null | wc -c) != 32)); then
                fail "$input is not a key-encryption key (base64 of 32 bytes)" \
                    "Set the secret $input of the GitHub environment from the key set of saas-keys.sh"
                ok=1
                continue
            fi
        elif ! openssl pkey -in "$work/$file" -noout -text 2>/dev/null | grep -q '^ED25519 Private-Key'; then
            fail "$input is not an Ed25519 private key in PEM format" \
                "Set the secret $input of the GitHub environment from the key set of saas-keys.sh"
            ok=1
            continue
        fi
        if [[ -e $dir/$file ]]; then
            if ! existing=$(saas_read_secret "$dir" "$file" "$image" | saas_compact); then
                fail "$dir/$file exists but cannot be read" "Check its owner and mode (ls -l $dir)"
                ok=1
            elif [[ $existing == "$(saas_compact <"$work/$file")" ]]; then
                pass "$file matches $input"
            else
                fail "$dir/$file does not match $input of this deploy. The file is kept and nothing was changed." \
                    "Wrong environment or a replaced secret: compare the secret with the offline copy (docs/saas/deploy.md, Keys)"
                ok=1
            fi
        else
            missing+=("$file")
        fi
    done
    if cmp -s "$work/platform.key" "$work/storage.key"; then
        fail "PLATFORM_KEY and STORAGE_KEY are the same key; they must differ"
        ok=1
    fi
    ((ok == 0)) || return 1
    for file in "${missing[@]}"; do
        mv -f -- "$work/$file" "$dir/$file"
        pass "$file written from standard input"
    done
    pub=$work/audit-anchor.pub
    if ! openssl pkey -in "$work/audit-anchor.key" -pubout -out "$pub" 2>/dev/null &&
        ! openssl pkey -in "$dir/audit-anchor.key" -pubout -out "$pub" 2>/dev/null; then
        fail "openssl could not derive the public anchor key"
        return 1
    fi
    if [[ -f $dir/audit-anchor.pub ]] && cmp -s "$pub" "$dir/audit-anchor.pub"; then
        pass "audit-anchor.pub belongs to audit-anchor.key"
    else
        chmod 0644 "$pub"
        mv -f -- "$pub" "$dir/audit-anchor.pub"
        pass "audit-anchor.pub written (derived from audit-anchor.key)"
    fi
    rm -f -- "$work/platform.key" "$work/storage.key" "$work/audit-anchor.key"
}

# saas_write_value_files DIR NAME...: one file per NAME given on standard input, mode
# 0400, holding the value without a final line break. A NAME given with an empty value
# removes its file (a value removed from GitHub stops being used); names not given keep
# their files.
saas_write_value_files() {
    local dir=$1 name tmp count=0
    shift
    install -d -m 0700 "$dir"
    chmod 0700 "$dir"
    for name in "$@"; do
        saas_has_input "$name" || continue
        if [[ -z $(saas_input "$name" | tr -d '\r') ]]; then
            rm -f -- "$dir/$name"
            continue
        fi
        tmp=$(mktemp "$dir/.$name.XXXXXX")
        chmod 0600 "$tmp"
        printf '%s' "$(saas_input "$name" | tr -d '\r')" >"$tmp"
        chmod 0400 "$tmp"
        mv -f -- "$tmp" "$dir/$name"
        count=$((count + 1))
    done
    printf '%d' "$count"
}

# ---------------------------------------------------------------------------
# Installed files, saved settings and state
# ---------------------------------------------------------------------------

# saas_save_files DEST: copies the installed files of INSTALL_DIR (.env, the deploy/ tree
# and the site) to DEST, with release.env naming what ran with them.
saas_save_files() {
    local dest=$1
    install -d -m 0700 "$dest"
    cp -p -- "$INSTALL_DIR/.env" "$dest/.env"
    if [[ -d $INSTALL_DIR/deploy ]]; then cp -pR -- "$INSTALL_DIR/deploy" "$dest/deploy"; fi
    if [[ -d $INSTALL_DIR/site ]]; then cp -pR -- "$INSTALL_DIR/site" "$dest/site"; fi
    rm -f -- "$dest/deploy/compose/.env"
    if [[ -f $INSTALL_DIR/state/current.env ]]; then
        cp -p -- "$INSTALL_DIR/state/current.env" "$dest/release.env"
    fi
}

# saas_link_env: deploy/compose/.env points at the .env of the install folder, so docker
# compose run by hand in deploy/compose reads the same settings as the deploy.
saas_link_env() {
    ln -sfn ../../.env "$INSTALL_DIR/deploy/compose/.env"
}

# The .env names the images of the files in place, and while no run holds the lock it names
# the release of state/current.env. A run that is stopped hard while it switches the files
# must leave a .env that differs from state/current.env, so the next run sees it
# (repair_switch of saas-deploy.sh): moving away from the release of current.env, the .env
# is written first; moving back to it, the .env is written last.

# saas_apply_mail_settings FILE: writes the mail settings of SAAS_VALUE (SAAS_MAIL_SETTINGS)
# into the .env FILE; names without a value in SAAS_VALUE are left as they are.
saas_apply_mail_settings() {
    local file=$1 name
    for name in "${SAAS_MAIL_SETTINGS[@]}"; do
        if [[ -n ${SAAS_VALUE[$name]+x} ]]; then env_set "$file" "$name" "${SAAS_VALUE[$name]}"; fi
    done
}

# saas_restore_files SAVED ENV_ORDER: puts saved files back; ENV_ORDER first (moving away
# from the release of state/current.env) or last (moving back to it). Folders keep their
# inodes (bind mounts). The saved .env gets the mail settings of this run first: this run
# wrote smtp.password from standard input, and the saved MSCD_SMTP_USER and host may belong
# to another mail account (SAAS_MAIL_SETTINGS).
saas_restore_files() {
    local saved=$1 order=${2:-last} env
    env=$(mktemp "$INSTALL_DIR/state/.restore-env.XXXXXX")
    install -m 0600 "$saved/.env" "$env"
    saas_apply_mail_settings "$env"
    if [[ $order == first ]]; then mv -f -- "$env" "$INSTALL_DIR/.env"; fi
    saas_sync_dir "$saved/deploy" "$INSTALL_DIR/deploy"
    saas_sync_dir "$saved/site" "$INSTALL_DIR/site"
    if [[ $order != first ]]; then mv -f -- "$env" "$INSTALL_DIR/.env"; fi
    saas_link_env
}

# saas_install_release_files ENV_FILE: installs ENV_FILE as .env (first, see above), then
# the release's deploy/ tree and site.
saas_install_release_files() {
    local env=$1
    install -m 0600 "$env" "$INSTALL_DIR/.env"
    saas_sync_dir "$RELEASE_DIR/deploy" "$INSTALL_DIR/deploy"
    saas_sync_dir "$RELEASE_DIR/site" "$INSTALL_DIR/site"
    saas_link_env
}

# saas_env_names_release ENV_FILE RELEASE_ENV: the .env names the image digests of the
# release.env (state/current.env or a saved release).
saas_env_names_release() {
    [[ -f $1 && -f $2 && $(kv_get "$1" MSCD_SERVER_DIGEST) == "$(kv_get "$2" SERVER_DIGEST)" &&
        $(kv_get "$1" MSCD_WEB_DIGEST) == "$(kv_get "$2" WEB_DIGEST)" ]]
}

# saas_write_release_env FILE VERSION SERVER_REF WEB_REF RELEASE_DIR ACTION
saas_write_release_env() {
    local tmp
    tmp=$(mktemp "$1.XXXXXX")
    cat >"$tmp" <<EOF
VERSION=$2
SERVER_IMAGE=${3%@*}
SERVER_DIGEST=${3#*@}
WEB_IMAGE=${4%@*}
WEB_DIGEST=${4#*@}
RELEASE_DIR=$5
ACTION=$6
SWITCHED_AT=$(saas_now)
EOF
    chmod 0640 "$tmp"
    mv -f -- "$tmp" "$1"
}

# saas_ref_of ENV_FILE KIND: server or web reference (image@digest) of a release.env or .env.
saas_ref_of() {
    local file=$1 kind=$2
    if [[ $kind == server ]]; then
        printf '%s@%s' "$(kv_get "$file" SERVER_IMAGE)" "$(kv_get "$file" SERVER_DIGEST)"
    else
        printf '%s@%s' "$(kv_get "$file" WEB_IMAGE)" "$(kv_get "$file" WEB_DIGEST)"
    fi
}

# saas_saved_dirs: the saved settings of earlier releases, newest first.
saas_saved_dirs() {
    local dir=$INSTALL_DIR/state/saved
    [[ -d $dir ]] || return 0
    find "$dir" -mindepth 1 -maxdepth 1 -type d -name '20*' -printf '%f\n' | LC_ALL=C sort -r |
        while IFS= read -r name; do
            if [[ -f $dir/$name/.env && -f $dir/$name/release.env ]]; then printf '%s\n' "$dir/$name"; fi
        done
}

# saas_write_previous: state/previous.env from the newest saved settings (the rollback
# target), or no file when there is none.
saas_write_previous() {
    local newest
    newest=$(saas_saved_dirs | head -n 1)
    if [[ -n $newest ]]; then
        cp -p -- "$newest/release.env" "$INSTALL_DIR/state/previous.env"
    else
        rm -f -- "$INSTALL_DIR/state/previous.env"
    fi
}

# saas_history ACTION RESULT VERSION DETAIL: one line in state/history.log.
saas_history() {
    printf '%s %s %s %s %s\n' "$(saas_now)" "$1" "$2" "$3" "${4:-}" >>"$INSTALL_DIR/state/history.log"
}
