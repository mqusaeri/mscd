#!/usr/bin/env bash
# MSCD SaaS: prepares a fresh Ubuntu 24.04 LTS server for the production stack.
# docs/saas/bootstrap.md explains each step. The workflow bootstrap-prod.yml
# runs it once as root on a new server; later the admin account can run it
# again with sudo.
#
#   sudo bash deploy/scripts/bootstrap-host.sh --admin-user NAME --deploy-key-file FILE [options]
#
# It is safe to run again. Each step compares the server with the target state
# first and reports "done" (already in place), "changed" or "skipped".
# The configuration files it installs live in deploy/host/ next to this folder.
set -Eeuo pipefail
umask 022

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
HOST_DIR=$SCRIPT_DIR/../host

readonly DEPLOY_USER=deploy
readonly SERVICE_USER=mscd
readonly SERVICE_USER_COMMENT="MSCD container user"
readonly MSCD_DIR=/opt/mscd
readonly SWAP_FILE=/swapfile
readonly SWAP_MB=4096
readonly LOG_FILE=/var/log/mscd-bootstrap.log
readonly LOCK_FILE=/run/mscd-bootstrap.lock
readonly KNOWN_HOSTS_FILE=$MSCD_DIR/state/ssh-known-hosts
# Comment of deploy/host/test/deploy.pub: nobody holds its private half, so a
# real run refuses it.
readonly TEST_KEY_MARKER=mscd-bootstrap-test-key
# SHA-256 of deploy/host/docker/docker.asc, Docker's apt signing key with the
# fingerprint 9DC8 5822 9FC7 DD38 854A E2D8 8D81 803C 0EBF CD88.
readonly DOCKER_KEY_SHA256=1500c1f56fa9e26b9b8f42452a553675796ade0807cdce11975eb98170b3a570

readonly SSHD_DROPIN=/etc/ssh/sshd_config.d/10-mscd.conf
readonly DOCKER_DAEMON_JSON=/etc/docker/daemon.json
readonly DOCKER_KEYRING=/etc/apt/keyrings/docker.asc
readonly DOCKER_SOURCES=/etc/apt/sources.list.d/docker.sources
readonly DATA_MOUNT_UNIT=/etc/systemd/system/var-lib-docker.mount
readonly DOCKER_DATA_DROPIN=/etc/systemd/system/docker.service.d/10-mscd-data.conf
readonly JOURNALD_DROPIN=/etc/systemd/journald.conf.d/10-mscd.conf
readonly SYSCTL_FILE=/etc/sysctl.d/90-mscd.conf
readonly SWAP_UNIT=/etc/systemd/system/swapfile.swap
readonly UNATTENDED_FILE=/etc/apt/apt.conf.d/52mscd-unattended-upgrades
readonly REBOOT_MARKER=/usr/local/lib/mscd/reboot-marker
readonly REBOOT_SERVICE=/etc/systemd/system/mscd-reboot-marker.service
readonly REBOOT_TIMER=/etc/systemd/system/mscd-reboot-marker.timer
readonly FAIL2BAN_JAIL=/etc/fail2ban/jail.d/mscd.local
readonly SUDOERS_FILE=/etc/sudoers.d/90-mscd-admin

readonly BASE_PACKAGES=(ca-certificates curl openssh-server rsync ufw fail2ban python3-systemd chrony
    unattended-upgrades update-notifier-common)
readonly DOCKER_PACKAGES=(docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin)
readonly CONFLICTING_PACKAGES=(docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc)
# Folders of the SaaS deployment: path and mode. Owner: the deploy account.
readonly FOLDERS=("$MSCD_DIR 0755" "$MSCD_DIR/releases 0755" "$MSCD_DIR/state 0750" "$MSCD_DIR/logs 0750"
    "$MSCD_DIR/secrets 0700" "$MSCD_DIR/backup 0700" "$MSCD_DIR/metrics 0755")

readonly STEPS=(data-volume packages docker system accounts folders updates firewall ssh)
declare -A STEP_TITLES=(
    [data-volume]="Data volume"
    [packages]="System packages"
    [docker]="Docker Engine"
    [system]="Time, swap and journal"
    [accounts]="Accounts"
    [folders]="Folders"
    [updates]="Security updates"
    [firewall]="Firewall"
    [ssh]="SSH"
)
readonly SSH_KEY_RE='^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)[[:space:]]+[A-Za-z0-9+/]+={0,3}([[:space:]].*)?$'

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
if [[ -t 1 && -z ${NO_COLOR:-} ]]; then
    C_RED=$'\033[31m' C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_BLUE=$'\033[36m'
    C_BOLD=$'\033[1m' C_RESET=$'\033[0m'
else
    C_RED='' C_GREEN='' C_YELLOW='' C_BLUE='' C_BOLD='' C_RESET=''
fi

section() { printf '\n%s==> %s%s\n' "$C_BOLD" "$*" "$C_RESET"; }
say() { printf '  %s\n' "$*"; }
info() { printf '  %sinfo%s     %s\n' "$C_BLUE" "$C_RESET" "$*"; }
warn() { printf '  %swarn%s     %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
die() {
    printf '\n%sERROR%s %s\n' "$C_RED" "$C_RESET" "$*" >&2
    exit 1
}
usage_error() {
    printf '%s: %s\nRun "%s --help" for the options.\n' "${0##*/}" "$*" "${0##*/}" >&2
    exit 2
}

# result STATUS TEXT: one result line of a step.
result() {
    local colour=$C_GREEN
    case $1 in
        changed) colour=$C_BLUE ;;
        skipped) colour=$C_YELLOW ;;
        differs) colour=$C_RED ;;
    esac
    printf '  %s%-8s%s %s\n' "$colour" "$1" "$C_RESET" "${2:-}"
}

on_error() {
    # A failing command inside $(...) does not stop the script; only report
    # failures of the script itself.
    ((BASH_SUBSHELL == 0)) || return 0
    printf '\n%sERROR%s The bootstrap stopped at line %s: %s\n' "$C_RED" "$C_RESET" "$1" "$2" >&2
    if [[ $MODE == apply ]]; then
        printf '      The log is in %s. Fix the cause and run the script again.\n' "$LOG_FILE" >&2
    fi
}

usage() {
    cat <<'EOF'
Usage: bootstrap-host.sh --admin-user NAME --deploy-key-file FILE [options]

Prepares a fresh Ubuntu 24.04 LTS server for MSCD SaaS: packages and Docker,
the Docker daemon settings, accounts, SSH, firewall, time, swap, journal,
automatic security updates and the /opt/mscd folders. Runs as root. Safe to
run again: each step reports done, changed or skipped.

Required:
  --admin-user NAME         Admin account for the owner (sudo, SSH key only)
  --deploy-key-file FILE    Public key (one or more lines) of the deploy
                            account that GitHub Actions uses

Options:
  --admin-key-file FILE     Public key(s) of the admin account. Without it, an
                            admin account without a key gets root's keys
  --data-device DEV         Block device mounted at /var/lib/docker
  --format-data-device      Format --data-device as ext4, only when it is empty
  --ssh-host NAME           Host name or address for the known_hosts line
                            (default: the server's outbound IPv4 address)
  --skip-upgrade            Do not run apt-get upgrade
  --only STEP[,STEP...]     Run only these steps:
                            data-volume, packages, docker, system, accounts,
                            folders, updates, firewall, ssh

Test modes (change nothing on the machine):
  --render-only --root DIR  Write every configuration file under DIR
  --dry-run                 Print each command a real run would make
  --check                   Report what differs from the target state;
                            exit 1 when anything does
  -h, --help                Show this help
EOF
}

# quote_args ARG...: the arguments as a shell command line.
quote_args() {
    local out='' arg
    for arg in "$@"; do
        if [[ $arg =~ ^[A-Za-z0-9_./:=@%+,-]+$ ]]; then
            out+=" $arg"
        else
            out+=" '${arg//\'/\'\\\'\'}'"
        fi
    done
    printf '%s' "${out# }"
}

log() {
    if [[ $MODE == apply ]]; then
        printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$LOG_FILE"
    fi
}

# run CMD [ARG...]: runs an external command (a real run) or prints it (dry run).
# The output goes to the log file; on failure the last lines are shown.
run() {
    local cmd out rc=0
    cmd=$(quote_args "$@")
    case $MODE in
        dry-run)
            printf '  + %s\n' "$cmd"
            return 0
            ;;
        apply) ;;
        *) die "Internal error: a command was started in $MODE mode: $cmd" ;;
    esac
    log "+ $cmd"
    out=$(mktemp)
    "$@" >"$out" 2>&1 </dev/null || rc=$?
    cat -- "$out" >>"$LOG_FILE"
    if ((rc != 0)); then
        printf '  %sfailed%s   %s (exit %s)\n' "$C_RED" "$C_RESET" "$cmd" "$rc" >&2
        tail -n 25 -- "$out" | sed 's/^/           /' >&2
        rm -f -- "$out"
        die "A command failed. The full output is in $LOG_FILE."
    fi
    rm -f -- "$out"
}

# ---------------------------------------------------------------------------
# State of the current step
# ---------------------------------------------------------------------------
MODE=apply
ROOT=''
DIFFS=()
NOTES=()
SKIP_REASON=''
CURRENT=''
LAST_CHANGED=false
RENDERED=()
DIFF_COUNT=0
SUMMARY=()
declare -A TPL=()
declare -A DRY_INSTALLED=()
declare -A DRY_CREATED=()
DEPLOY_KEYS=()
ADMIN_KEYS=()
APT_UPDATED=false
RESTART_DOCKER=false
RESTART_JOURNALD=false
RESTART_FAIL2BAN=false
RELOAD_SSHD=false
RELOAD_UFW=false

# ensure DESCRIPTION TEST [ARG...] -- ACTION [ARG...]
# TEST is a read-only check. When it fails: --check records a difference,
# a real run or a dry run runs ACTION (which uses run for its commands).
ensure() {
    local desc=$1 test=()
    shift
    while (($# > 0)) && [[ $1 != -- ]]; do
        test+=("$1")
        shift
    done
    [[ ${1:-} == -- ]] || die "Internal error: ensure without -- for: $desc"
    shift
    CURRENT=''
    if "${test[@]}"; then
        return 0
    fi
    case $MODE in
        check) DIFFS+=("$desc${CURRENT:+ (now: $CURRENT)}") ;;
        render) ;;
        *)
            NOTES+=("$desc")
            "$@"
            ;;
    esac
}

# ensure_file PATH MODE OWNER CONTENT [VALIDATOR]: the file holds CONTENT with
# that mode and owner. Sets LAST_CHANGED=true when it was (or would be) written.
# VALIDATOR FILE checks a new version before it replaces the old one.
ensure_file() {
    local path=$1 mode=$2 owner=$3 content=$4 validator=${5:-}
    LAST_CHANGED=false
    if [[ $MODE == render ]]; then
        local target=$ROOT$path
        mkdir -p -- "$(dirname -- "$target")"
        printf '%s\n' "$content" >"$target"
        chmod "$mode" "$target"
        RENDERED+=("$path")
        return 0
    fi
    CURRENT=''
    if file_matches "$path" "$mode" "$owner" "$content"; then
        return 0
    fi
    LAST_CHANGED=true
    case $MODE in
        check) DIFFS+=("$path ($CURRENT)") ;;
        dry-run)
            NOTES+=("$path")
            printf '  + write %s (mode %s, owner %s)\n' "$path" "$mode" "$owner"
            ;;
        apply)
            NOTES+=("$path")
            write_file "$path" "$mode" "$owner" "$content" "$validator"
            ;;
    esac
}

file_matches() {
    local path=$1 mode=$2 owner=$3 content=$4 actual
    if [[ -L $path || ! -f $path ]]; then
        CURRENT=missing
        return 1
    fi
    if [[ "$(cat -- "$path")" != "$content" ]]; then
        CURRENT="other content"
        return 1
    fi
    actual=$(stat -c '%a %U:%G' -- "$path")
    if [[ $actual != "${mode#0} $owner" ]]; then
        CURRENT="mode and owner $actual"
        return 1
    fi
}

# write_file PATH MODE OWNER CONTENT [VALIDATOR]: atomic replacement (real run).
write_file() {
    local path=$1 mode=$2 owner=$3 content=$4 validator=${5:-} dir tmp
    dir=$(dirname -- "$path")
    [[ -d $dir ]] || install -d -m 0755 -- "$dir"
    tmp=$(mktemp -- "$dir/.mscd-bootstrap.XXXXXX")
    printf '%s\n' "$content" >"$tmp"
    chmod "$mode" "$tmp"
    chown "$owner" "$tmp"
    if [[ -n $validator ]] && ! "$validator" "$tmp"; then
        rm -f -- "$tmp"
        die "The new version of $path did not pass its check ($validator). The old file is unchanged."
    fi
    mv -f -- "$tmp" "$path"
    log "wrote $path ($mode, $owner)"
}

# put_file PATH MODE OWNER CONTENT: writes without comparing first (inside actions).
put_file() {
    if [[ $MODE == dry-run ]]; then
        printf '  + write %s (mode %s, owner %s)\n' "$1" "$2" "$3"
        return 0
    fi
    write_file "$@"
}

# ensure_dir PATH MODE OWNER: a real folder with that mode and owner.
ensure_dir() {
    local path=$1 mode=$2 owner=$3 actual
    [[ $MODE != render ]] || return 0
    CURRENT=''
    if [[ -d $path && ! -L $path ]]; then
        actual=$(stat -c '%a %U:%G' -- "$path")
        [[ $actual == "${mode#0} $owner" ]] && return 0
        CURRENT="mode and owner $actual"
    else
        CURRENT=missing
    fi
    case $MODE in
        check) DIFFS+=("$path/ ($CURRENT)") ;;
        *)
            [[ ! -L $path ]] || die "$path is a symbolic link. Replace it with a folder and run the script again."
            NOTES+=("$path/")
            run install -d -m "$mode" -o "${owner%%:*}" -g "${owner#*:}" "$path"
            ;;
    esac
}

# ---------------------------------------------------------------------------
# Checks used by several steps (read only)
# ---------------------------------------------------------------------------
have_cmd() { command -v "$1" >/dev/null 2>&1; }
have_systemd() { [[ -d /run/systemd/system ]] && have_cmd systemctl; }

need_systemd() {
    [[ $MODE != dry-run ]] || return 0
    have_systemd || die "systemd is not running on this machine. Run the script on the server itself."
}

unit_enabled() {
    have_systemd || return 1
    local state
    state=$(systemctl is-enabled "$1" 2>/dev/null || true)
    [[ $state == enabled || $state == static || $state == generated || $state == alias ]]
}
unit_active() { have_systemd && systemctl is-active -q "$1" 2>/dev/null; }
units_enabled() {
    local unit
    for unit in "$@"; do
        unit_enabled "$unit" || {
            CURRENT="$unit not enabled"
            return 1
        }
    done
}
unit_on() {
    local unit
    for unit in "$@"; do
        if ! unit_enabled "$unit" || ! unit_active "$unit"; then
            CURRENT="$unit is not enabled and running"
            return 1
        fi
    done
}

# units_loaded CHANGED UNIT...: systemd has read the current unit files.
units_loaded() {
    local changed=$1 unit
    shift
    [[ $changed == false ]] || {
        CURRENT="unit files changed"
        return 1
    }
    have_systemd || {
        CURRENT="systemd is not running"
        return 1
    }
    for unit in "$@"; do
        if [[ "$(systemctl show -p NeedDaemonReload --value "$unit" 2>/dev/null || true)" == yes ]]; then
            CURRENT="$unit changed on disk"
            return 1
        fi
    done
}

pkg_installed() {
    [[ -n ${DRY_INSTALLED[$1]:-} ]] && return 0
    [[ "$(dpkg-query -W -f='${db:Status-Abbrev}' "$1" 2>/dev/null)" == ii* ]]
}

packages_installed() {
    local missing=() pkg
    for pkg in "$@"; do
        pkg_installed "$pkg" || missing+=("$pkg")
    done
    ((${#missing[@]} == 0)) && return 0
    CURRENT="missing ${missing[*]}"
    return 1
}

flag_false() { [[ $1 == false ]]; }

user_exists() {
    [[ -n ${DRY_CREATED[$1]:-} ]] && return 0
    getent passwd "$1" >/dev/null 2>&1
}
group_exists() {
    [[ $1 == docker && -n ${DRY_INSTALLED[docker-ce]:-} ]] && return 0
    getent group "$1" >/dev/null 2>&1
}
in_group() {
    [[ -n ${DRY_CREATED[$1]:-} ]] && return 0
    id -nG "$1" 2>/dev/null | tr ' ' '\n' | grep -qx -- "$2"
}
not_in_group() {
    [[ -n ${DRY_CREATED[$1]:-} ]] && return 0
    if id -nG "$1" 2>/dev/null | tr ' ' '\n' | grep -qx -- "$2"; then
        CURRENT="member of $2"
        return 1
    fi
}
password_locked() {
    [[ -n ${DRY_CREATED[$1]:-} ]] && return 0
    local state
    state=$(passwd -S "$1" 2>/dev/null | awk '{print $2}' || true)
    [[ $state == L ]] && return 0
    CURRENT="password status ${state:-unknown}"
    return 1
}
user_home() {
    local home
    home=$(getent passwd "$1" 2>/dev/null | cut -d: -f6 || true)
    printf '%s' "${home:-/home/$1}"
}
user_group() {
    local group
    group=$(id -gn "$1" 2>/dev/null || true)
    printf '%s' "${group:-$1}"
}

# has_key_lines FILE: true when FILE holds at least one SSH public key on a
# line that is not a comment (a key may follow options such as restrict).
has_key_lines() {
    local line re='(^|[[:space:]])(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp[0-9]+|sk-[a-z0-9-]+@openssh\.com)[[:space:]]+[A-Za-z0-9+/]'
    if [[ -f $1 && -r $1 ]]; then
        while IFS= read -r line || [[ -n $line ]]; do
            [[ $line =~ ^[[:space:]]*# ]] && continue
            [[ $line =~ $re ]] && return 0
        done <"$1"
    fi
    CURRENT="no key"
    return 1
}

fix_mode_owner() {
    run chown "$3" "$1"
    run chmod "$2" "$1"
}

mode_owner_ok() {
    local path=$1 mode=$2 owner=$3 actual
    [[ -e $path ]] || return 0
    actual=$(stat -c '%a %U:%G' -- "$path")
    [[ $actual == "${mode#0} $owner" ]] && return 0
    CURRENT=$actual
    return 1
}

# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------
ADMIN_USER=''
ADMIN_KEY_FILE=''
DEPLOY_KEY_FILE=''
DATA_DEVICE=''
FORMAT_DATA=false
SSH_HOST=''
SKIP_UPGRADE=false
ONLY=''

parse_args() {
    local modes=0
    while (($# > 0)); do
        case $1 in
            --admin-user | --admin-key-file | --deploy-key-file | --data-device | --ssh-host | --only | --root)
                (($# >= 2)) || usage_error "$1 needs a value"
                case $1 in
                    --admin-user) ADMIN_USER=$2 ;;
                    --admin-key-file) ADMIN_KEY_FILE=$2 ;;
                    --deploy-key-file) DEPLOY_KEY_FILE=$2 ;;
                    --data-device) DATA_DEVICE=$2 ;;
                    --ssh-host) SSH_HOST=$2 ;;
                    --only) ONLY=$2 ;;
                    --root) ROOT=$2 ;;
                esac
                shift 2
                ;;
            --format-data-device) FORMAT_DATA=true && shift ;;
            --skip-upgrade) SKIP_UPGRADE=true && shift ;;
            --render-only) MODE=render && modes=$((modes + 1)) && shift ;;
            --dry-run) MODE=dry-run && modes=$((modes + 1)) && shift ;;
            --check) MODE=check && modes=$((modes + 1)) && shift ;;
            -h | --help)
                usage
                exit 0
                ;;
            *) usage_error "unknown option $1" ;;
        esac
    done
    ((modes <= 1)) || usage_error "--render-only, --dry-run and --check cannot be combined"
    [[ -n $ADMIN_USER ]] || usage_error "--admin-user is required"
    [[ -n $DEPLOY_KEY_FILE ]] || usage_error "--deploy-key-file is required"
    if [[ $MODE == render ]]; then
        [[ -n $ROOT ]] || usage_error "--render-only needs --root DIR"
        [[ -d $ROOT ]] || usage_error "--root $ROOT is not a folder"
        ROOT=$(cd -- "$ROOT" && pwd)
        [[ $ROOT != / ]] || usage_error "--root / would change the machine; use --root with an empty folder"
    else
        [[ -z $ROOT ]] || usage_error "--root works only with --render-only"
    fi
    [[ $ADMIN_USER =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] ||
        usage_error "--admin-user $ADMIN_USER: use lower-case letters, digits, - and _ (at most 32 characters)"
    case $ADMIN_USER in
        root | "$DEPLOY_USER" | "$SERVICE_USER") usage_error "--admin-user cannot be $ADMIN_USER" ;;
    esac
    if [[ -n $DATA_DEVICE ]]; then
        [[ $DATA_DEVICE =~ ^/dev/[A-Za-z0-9/_.:-]+$ ]] || usage_error "--data-device $DATA_DEVICE is not a device path under /dev"
    fi
    if $FORMAT_DATA && [[ -z $DATA_DEVICE ]]; then
        usage_error "--format-data-device needs --data-device"
    fi
    if [[ -n $SSH_HOST && ! $SSH_HOST =~ ^[A-Za-z0-9.:-]+$ ]]; then
        usage_error "--ssh-host $SSH_HOST is not a host name or address"
    fi
    if [[ -n $ONLY ]]; then
        local step
        for step in ${ONLY//,/ }; do
            [[ -n ${STEP_TITLES[$step]:-} ]] || usage_error "--only: unknown step $step"
        done
    fi
}

step_selected() {
    [[ -z $ONLY ]] && return 0
    [[ ",$ONLY," == *",$1,"* ]]
}

# read_keys FILE WHAT: the public keys of FILE, one "type base64 [comment]" each.
read_keys() {
    local file=$1 what=$2 line type b64 comment n=0
    KEYS=()
    [[ -f $file && -r $file ]] || usage_error "cannot read the $what key file $file"
    if grep -q 'PRIVATE KEY' -- "$file"; then
        usage_error "$file holds a private key. Pass the public key (the .pub file)"
    fi
    while IFS= read -r line || [[ -n $line ]]; do
        n=$((n + 1))
        line=${line%$'\r'}
        [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
        [[ $line =~ $SSH_KEY_RE ]] ||
            usage_error "$file line $n is not an SSH public key (options before the key are not accepted)"
        read -r type b64 comment <<<"$line"
        KEYS+=("$type $b64${comment:+ $comment}")
    done <"$file"
    ((${#KEYS[@]} > 0)) || usage_error "$file holds no SSH public key"
    if have_cmd ssh-keygen && ! ssh-keygen -l -f "$file" >/dev/null 2>&1; then
        usage_error "ssh-keygen cannot read the keys in $file"
    fi
}

load_inputs() {
    local KEYS=()
    read_keys "$DEPLOY_KEY_FILE" deploy
    DEPLOY_KEYS=("${KEYS[@]}")
    if [[ -n $ADMIN_KEY_FILE ]]; then
        read_keys "$ADMIN_KEY_FILE" admin
        ADMIN_KEYS=("${KEYS[@]}")
    fi
    if [[ $MODE == apply ]]; then
        local key
        for key in "${DEPLOY_KEYS[@]}" "${ADMIN_KEYS[@]}"; do
            if [[ $key == *"$TEST_KEY_MARKER"* ]]; then
                die "A key in $DEPLOY_KEY_FILE${ADMIN_KEY_FILE:+ or $ADMIN_KEY_FILE} is the test key of deploy/host/test. Nobody holds its private half. Pass your own public key."
            fi
        done
    fi
}

load_template() {
    local name=$1 file=$HOST_DIR/$2
    [[ -f $file ]] || die "Missing configuration file $file (deploy/host must sit next to deploy/scripts)."
    TPL[$name]=$(<"$file")
}

load_templates() {
    load_template sshd ssh/10-mscd.conf
    load_template daemon-json docker/daemon.json
    load_template docker-sources docker/docker.sources
    load_template docker-key docker/docker.asc
    load_template docker-data docker/data-volume.conf
    load_template data-mount docker/var-lib-docker.mount
    load_template ufw-rules firewall/ufw-rules
    load_template fail2ban firewall/fail2ban-sshd.local
    load_template journald system/journald.conf
    load_template sysctl system/sysctl.conf
    load_template swap-unit system/swapfile.swap
    load_template unattended system/unattended-upgrades.conf
    load_template reboot-marker system/mscd-reboot-marker
    load_template reboot-service system/mscd-reboot-marker.service
    load_template reboot-timer system/mscd-reboot-marker.timer
    load_template sudoers system/sudoers-admin
    local sum
    if have_cmd sha256sum; then
        sum=$(sha256sum -- "$HOST_DIR/docker/docker.asc" | cut -d' ' -f1)
    else
        sum=$(shasum -a 256 -- "$HOST_DIR/docker/docker.asc" | cut -d' ' -f1)
    fi
    [[ $sum == "$DOCKER_KEY_SHA256" ]] ||
        die "deploy/host/docker/docker.asc is not Docker's apt key (SHA-256 $sum). Restore it from the repository."
}

preflight() {
    [[ -d $HOST_DIR ]] || die "The folder deploy/host is missing next to the script ($HOST_DIR)."
    HOST_DIR=$(cd -- "$HOST_DIR" && pwd)
    load_templates
    load_inputs
    [[ $MODE != render ]] || return 0

    if [[ $EUID -ne 0 ]]; then
        if [[ $MODE == dry-run ]]; then
            warn "Not running as root: steps that are already in place may be shown as changes."
        else
            die "Run the script as root: sudo bash ${BASH_SOURCE[0]} ..."
        fi
    fi
    local os_id='' os_version='' os_codename=''
    if [[ -r /etc/os-release ]]; then
        # One subshell reads the file, so one directive covers it.
        # shellcheck disable=SC1091
        IFS='|' read -r os_id os_version os_codename < <(
            . /etc/os-release && printf '%s|%s|%s\n' "${ID:-}" "${VERSION_ID:-}" "${VERSION_CODENAME:-}"
        ) || true
    fi
    if [[ $os_id != ubuntu || $os_version != 24.04 || $os_codename != noble ]]; then
        if [[ $MODE == dry-run ]]; then
            warn "This machine is not Ubuntu 24.04 LTS ($os_id $os_version). A real run refuses it."
        else
            die "This script supports Ubuntu 24.04 LTS only (found: ${os_id:-unknown} ${os_version:-})."
        fi
    fi
    if ! have_systemd; then
        if [[ $MODE == apply ]]; then
            warn "systemd is not running here. Steps that need it stop with an error."
        else
            warn "systemd is not running here. Commands are shown as they would run on a server."
        fi
    fi
    if [[ -z $SSH_HOST ]]; then
        SSH_HOST=$(detect_ssh_host)
    fi
    if [[ $MODE == apply ]]; then
        exec 9>"$LOCK_FILE"
        flock -n 9 || die "Another run of bootstrap-host.sh is active on this server."
        [[ -e $LOG_FILE ]] || install -m 0600 /dev/null "$LOG_FILE"
        log "bootstrap-host.sh started: admin $ADMIN_USER${ONLY:+, only $ONLY}"
        if have_cmd cloud-init; then
            # On a new server cloud-init may still install packages and hold the apt lock.
            info "Waiting until cloud-init has finished its first boot work."
            cloud-init status --wait >/dev/null 2>&1 || true
        fi
    fi
}

detect_ssh_host() {
    local addr=''
    if have_cmd ip; then
        addr=$(ip -4 -o route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1 || true)
    fi
    if [[ -z $addr ]]; then
        addr=$(hostname -f 2>/dev/null || hostname)
    fi
    printf '%s' "$addr"
}

arch() {
    if have_cmd dpkg; then
        dpkg --print-architecture
        return
    fi
    case $(uname -m) in
        x86_64) echo amd64 ;;
        aarch64 | arm64) echo arm64 ;;
        *) uname -m ;;
    esac
}

# ---------------------------------------------------------------------------
# Step: data volume
# ---------------------------------------------------------------------------
has_filesystem() {
    local type
    type=$(blkid -p -s TYPE -o value -- "$1" 2>/dev/null || true)
    [[ -n $type ]] && return 0
    CURRENT="no file system"
    return 1
}

# fs_supported DEV: no file system yet (it will be formatted) or ext4 or XFS.
fs_supported() {
    local type
    type=$(blkid -p -s TYPE -o value -- "$1" 2>/dev/null || true)
    [[ -z $type || $type == ext4 || $type == xfs ]] && return 0
    CURRENT=$type
    return 1
}

# Actions read CURRENT when they run: the test of ensure has just set it.
refuse_fs_type() {
    die "$DATA_DEVICE holds $CURRENT. The script mounts only ext4 or XFS, and it never formats a device that is in use."
}

fs_uuid() { blkid -p -s UUID -o value -- "$1" 2>/dev/null || true; }

format_data_device() {
    local dev=$1 parts signatures
    $FORMAT_DATA || die "$DATA_DEVICE has no file system. Add --format-data-device to format it as ext4. Formatting deletes everything on the device."
    parts=$(lsblk -nr -o NAME -- "$dev" 2>/dev/null | wc -l || true)
    ((parts <= 1)) || die "$DATA_DEVICE has partitions. --format-data-device formats only an empty device."
    signatures=$(wipefs --no-act --noheadings --output TYPE -- "$dev" 2>/dev/null | tr '\n' ' ' || true)
    [[ -z ${signatures// /} ]] || die "$DATA_DEVICE is not empty (found: $signatures). --format-data-device formats only an empty device."
    if ! cmp -s -n 1048576 -- "$dev" /dev/zero; then
        die "$DATA_DEVICE holds data in its first megabyte. --format-data-device formats only an empty device."
    fi
    [[ -z "$(findmnt -n -o TARGET --source "$dev" 2>/dev/null || true)" ]] || die "$DATA_DEVICE is mounted."
    run mkfs.ext4 -q -L mscd-docker -m 1 "$dev"
    # udev publishes /dev/disk/by-uuid for the new file system.
    run udevadm trigger --action=change --settle "$dev"
}

data_mounted() {
    local src
    src=$(findmnt -n -o SOURCE --mountpoint /var/lib/docker 2>/dev/null || true)
    if [[ -z $src ]]; then
        CURRENT="not mounted"
        return 1
    fi
    if [[ "$(readlink -f -- "$src")" != "$1" ]]; then
        CURRENT="$src is mounted there"
        return 1
    fi
    unit_enabled var-lib-docker.mount && return 0
    CURRENT="mounted, but not at boot"
    return 1
}

mount_data_volume() {
    local dev=$1 src where
    need_systemd
    src=$(findmnt -n -o SOURCE --mountpoint /var/lib/docker 2>/dev/null || true)
    if [[ -n $src && "$(readlink -f -- "$src")" != "$dev" ]]; then
        die "/var/lib/docker is already mounted from $src."
    fi
    if [[ -z $src ]]; then
        where=$(findmnt -n -o TARGET --source "$dev" 2>/dev/null | head -n 1 || true)
        [[ -z $where ]] || die "$DATA_DEVICE is mounted at $where. Unmount it first."
        if unit_active docker.service || [[ -n "$(ls -A /var/lib/docker 2>/dev/null || true)" ]]; then
            die "Docker already keeps data in /var/lib/docker on the system disk. Moving it to the data volume is a manual step (docs/saas/bootstrap.md, section Data volume)."
        fi
        run install -d -m 0710 /var/lib/docker
    fi
    run systemctl enable --now var-lib-docker.mount
}

step_data_volume() {
    if [[ -z $DATA_DEVICE ]]; then
        SKIP_REASON="no --data-device given"
        return 0
    fi
    local dev uuid what changed
    if [[ $MODE == render ]]; then
        uuid=$(blkid -s UUID -o value -- "$DATA_DEVICE" 2>/dev/null || true)
        what=$DATA_DEVICE
        [[ -z $uuid ]] || what=/dev/disk/by-uuid/$uuid
        ensure_file "$DATA_MOUNT_UNIT" 0644 root:root "${TPL[data-mount]//@WHAT@/$what}"
        ensure_file "$DOCKER_DATA_DROPIN" 0644 root:root "${TPL[docker-data]}"
        return 0
    fi
    ensure "block device $DATA_DEVICE" test -b "$DATA_DEVICE" -- \
        die "There is no block device $DATA_DEVICE. Check the name with lsblk."
    [[ -b $DATA_DEVICE ]] || return 0
    dev=$(readlink -f -- "$DATA_DEVICE")
    ensure "file system on $DATA_DEVICE" has_filesystem "$dev" -- format_data_device "$dev"
    ensure "ext4 or XFS on $DATA_DEVICE" fs_supported "$dev" -- refuse_fs_type
    uuid=$(fs_uuid "$dev")
    what=/dev/disk/by-uuid/${uuid:-UUID-AFTER-FORMATTING}
    ensure_file "$DATA_MOUNT_UNIT" 0644 root:root "${TPL[data-mount]//@WHAT@/$what}"
    changed=$LAST_CHANGED
    ensure_file "$DOCKER_DATA_DROPIN" 0644 root:root "${TPL[docker-data]}"
    [[ $LAST_CHANGED == false ]] || changed=true
    ensure "systemd has read the mount unit" units_loaded "$changed" var-lib-docker.mount docker.service -- \
        run systemctl daemon-reload
    ensure "/var/lib/docker mounted from $DATA_DEVICE at every boot" data_mounted "$dev" -- mount_data_volume "$dev"
}

# ---------------------------------------------------------------------------
# Step: system packages
# ---------------------------------------------------------------------------
apt_get() {
    run env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l apt-get -y -q -o DPkg::Lock::Timeout=600 \
        -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"
}

apt_update() {
    apt_get update
    APT_UPDATED=true
}

apt_install() {
    [[ $APT_UPDATED == true ]] || apt_update
    apt_get install "$@"
    if [[ $MODE == dry-run ]]; then
        local pkg
        for pkg in "$@"; do DRY_INSTALLED[$pkg]=1; done
    fi
}

pending_upgrades() {
    apt-get -s -o Debug::NoLocking=1 --with-new-pkgs upgrade 2>/dev/null | grep -c '^Inst ' || true
}

no_pending_upgrades() {
    [[ $MODE != dry-run ]] || return 1
    local count
    count=$(pending_upgrades)
    ((count == 0)) && return 0
    CURRENT="$count packages"
    return 1
}

step_packages() {
    [[ $MODE != render ]] || return 0
    if [[ $MODE != check ]]; then
        apt_update
    fi
    if ! $SKIP_UPGRADE; then
        if [[ $MODE == check ]]; then
            local count
            count=$(pending_upgrades)
            if ((count > 0)); then
                info "$count package updates are waiting. unattended-upgrades installs the security updates every day."
            fi
        else
            ensure "installed package updates" no_pending_upgrades -- apt_get --with-new-pkgs upgrade
        fi
    fi
    ensure "packages ${BASE_PACKAGES[*]}" packages_installed "${BASE_PACKAGES[@]}" -- apt_install "${BASE_PACKAGES[@]}"
}

# ---------------------------------------------------------------------------
# Step: Docker Engine
# ---------------------------------------------------------------------------
validate_daemon_json() {
    if have_cmd dockerd; then
        dockerd --validate --config-file="$1" >/dev/null
    else
        python3 -c 'import json, sys; json.load(open(sys.argv[1]))' "$1"
    fi
}

no_conflicting_packages() {
    local found=() pkg
    for pkg in "${CONFLICTING_PACKAGES[@]}"; do
        pkg_installed "$pkg" && found+=("$pkg")
    done
    ((${#found[@]} == 0)) && return 0
    CURRENT="installed ${found[*]}"
    return 1
}

remove_conflicting_packages() {
    local found=() pkg
    for pkg in "${CONFLICTING_PACKAGES[@]}"; do
        pkg_installed "$pkg" && found+=("$pkg")
    done
    apt_get remove "${found[@]}"
}

install_docker() {
    apt_update
    apt_install "${DOCKER_PACKAGES[@]}"
}

docker_settings_ok() {
    local info
    if [[ $RESTART_DOCKER == true ]]; then
        CURRENT="daemon.json changed while Docker was running"
        return 1
    fi
    unit_active docker.service || {
        CURRENT="Docker is not running"
        return 1
    }
    info=$(docker info --format '{{.LiveRestoreEnabled}} {{.LoggingDriver}} {{json .DefaultAddressPools}}' 2>/dev/null) || {
        CURRENT="docker info failed"
        return 1
    }
    if [[ $info != "true local "* ]]; then
        CURRENT="live-restore and log driver: ${info%% \[*}"
        return 1
    fi
    if [[ $info != *172.16.0.0/13* || $info == *172.31.* ]]; then
        CURRENT="other default address pools"
        return 1
    fi
}

start_docker() {
    need_systemd
    if unit_active docker.service; then
        warn "Docker restarts to read $DOCKER_DAEMON_JSON."
        run systemctl restart docker.service
    else
        run systemctl start docker.service
    fi
    RESTART_DOCKER=false
    [[ $MODE == apply ]] || return 0
    for _ in $(seq 1 30); do
        docker info >/dev/null 2>&1 && return 0
        sleep 1
    done
    die "Docker did not answer within 30 seconds after the start. See: journalctl -u docker.service"
}

step_docker() {
    local sources was_running=false
    sources=${TPL[docker-sources]//@CODENAME@/noble}
    sources=${sources//@ARCH@/$(arch)}
    ensure_file "$DOCKER_KEYRING" 0644 root:root "${TPL[docker-key]}"
    [[ $LAST_CHANGED == false ]] || APT_UPDATED=false
    ensure_file "$DOCKER_SOURCES" 0644 root:root "$sources"
    [[ $LAST_CHANGED == false ]] || APT_UPDATED=false
    unit_active docker.service && was_running=true
    # Written before Docker is installed, so its first start already uses it.
    ensure_file "$DOCKER_DAEMON_JSON" 0644 root:root "${TPL[daemon-json]}" validate_daemon_json
    if [[ $LAST_CHANGED == true && $was_running == true ]]; then
        RESTART_DOCKER=true
    fi
    [[ $MODE != render ]] || return 0
    ensure "no other container packages (${CONFLICTING_PACKAGES[*]})" no_conflicting_packages -- \
        remove_conflicting_packages
    ensure "Docker Engine and the Compose plugin" packages_installed "${DOCKER_PACKAGES[@]}" -- install_docker
    ensure "Docker starts at boot" units_enabled docker.service containerd.service -- \
        run systemctl enable docker.service containerd.service
    ensure "Docker runs with $DOCKER_DAEMON_JSON" docker_settings_ok -- start_docker
}

# ---------------------------------------------------------------------------
# Step: time, swap and journal
# ---------------------------------------------------------------------------
timezone_is_utc() {
    local tz=''
    if have_systemd && have_cmd timedatectl; then
        tz=$(timedatectl show -p Timezone --value 2>/dev/null || true)
    fi
    if [[ -z $tz ]]; then
        tz=$(readlink /etc/localtime 2>/dev/null || true)
        tz=${tz##*/zoneinfo/}
    fi
    [[ $tz == UTC || $tz == Etc/UTC ]] && return 0
    CURRENT=${tz:-unknown}
    return 1
}

set_utc() {
    need_systemd
    run timedatectl set-timezone UTC
}

chrony_ok() {
    pkg_installed chrony || {
        CURRENT="chrony is not installed"
        return 1
    }
    unit_on chrony.service
}

start_chrony() {
    pkg_installed chrony || apt_install chrony
    need_systemd
    run systemctl enable --now chrony.service
}

# swap_file_mb: size of the swap file in MB (0 when it does not exist).
swap_file_mb() {
    local bytes=0
    [[ ! -e $SWAP_FILE ]] || bytes=$(stat -c %s -- "$SWAP_FILE" 2>/dev/null || printf 0)
    printf '%s' "$((bytes / 1048576))"
}

swap_in_use() {
    swapon --show=NAME --noheadings 2>/dev/null | grep -qx -- "$SWAP_FILE"
}

swap_ok() {
    local size_mb
    if [[ -e $SWAP_FILE ]]; then
        size_mb=$(swap_file_mb)
        if ((size_mb < SWAP_MB)); then
            CURRENT="$SWAP_FILE is $size_mb MB, smaller than $SWAP_MB MB"
            return 1
        fi
    fi
    if ! swap_in_use; then
        CURRENT="not in use"
        return 1
    fi
    unit_enabled swapfile.swap && return 0
    CURRENT="in use, but not at boot"
    return 1
}

# create_swap_file [RECLAIM_MB]: writes a new swap file. RECLAIM_MB is the
# space that the old, smaller file frees when it is replaced.
create_swap_file() {
    local free_mb reclaim_mb=${1:-0}
    free_mb=$(df -Pm / | awk 'NR == 2 {print $4}')
    free_mb=$((free_mb + reclaim_mb))
    if ((free_mb <= SWAP_MB + 2048)); then
        [[ $MODE == dry-run ]] || die "Not enough free space on / for a 4 GB swap file (${free_mb} MB free)."
        warn "Only ${free_mb} MB are free on /. A real run needs more than $((SWAP_MB + 2048)) MB for the swap file."
    fi
    if [[ "$(findmnt -n -o FSTYPE --target / 2>/dev/null || true)" == ext4 ]]; then
        run fallocate -l "${SWAP_MB}M" "$SWAP_FILE"
    else
        run dd if=/dev/zero of="$SWAP_FILE" bs=1M count="$SWAP_MB" status=none
    fi
    run chmod 0600 "$SWAP_FILE"
    run mkswap "$SWAP_FILE"
}

make_swap() {
    local size_mb
    need_systemd
    if [[ ! -e $SWAP_FILE ]]; then
        create_swap_file
    elif [[ "$(blkid -p -s TYPE -o value -- "$SWAP_FILE" 2>/dev/null || true)" != swap ]]; then
        die "$SWAP_FILE exists and is not a swap file. Move it away and run the script again."
    elif size_mb=$(swap_file_mb) && ((size_mb < SWAP_MB)); then
        # A smaller swap file, for example from the provider image, is
        # replaced. swapoff moves its pages back to memory first.
        warn "$SWAP_FILE is $size_mb MB. It is replaced with a $SWAP_MB MB swap file."
        if swap_in_use; then
            run swapoff "$SWAP_FILE"
        fi
        run rm -f "$SWAP_FILE"
        create_swap_file "$size_mb"
    else
        run chmod 0600 "$SWAP_FILE"
    fi
    run systemctl enable --now swapfile.swap
}

swappiness_ok() {
    local value
    value=$(cat /proc/sys/vm/swappiness 2>/dev/null || true)
    [[ $value == 10 ]] && return 0
    CURRENT=${value:-unknown}
    return 1
}

restart_journald() {
    need_systemd
    run systemctl restart systemd-journald.service
    RESTART_JOURNALD=false
}

step_system() {
    local swap_changed
    ensure_file "$JOURNALD_DROPIN" 0644 root:root "${TPL[journald]}"
    RESTART_JOURNALD=$LAST_CHANGED
    ensure_file "$SYSCTL_FILE" 0644 root:root "${TPL[sysctl]}"
    ensure_file "$SWAP_UNIT" 0644 root:root "${TPL[swap-unit]}"
    swap_changed=$LAST_CHANGED
    [[ $MODE != render ]] || return 0
    ensure "time zone UTC" timezone_is_utc -- set_utc
    ensure "chrony keeps the clock in sync" chrony_ok -- start_chrony
    ensure "systemd has read swapfile.swap" units_loaded "$swap_changed" swapfile.swap -- run systemctl daemon-reload
    ensure "4 GB swap file $SWAP_FILE in use at every boot" swap_ok -- make_swap
    ensure "vm.swappiness = 10" swappiness_ok -- run sysctl -q -p "$SYSCTL_FILE"
    ensure "journald uses $JOURNALD_DROPIN" flag_false "$RESTART_JOURNALD" -- restart_journald
}

# ---------------------------------------------------------------------------
# Step: accounts
# ---------------------------------------------------------------------------
deploy_keys_content() {
    local key
    printf '%s\n' "# Managed by deploy/scripts/bootstrap-host.sh (docs/saas/bootstrap.md)."
    printf '%s\n' "# Deploy key of GitHub Actions. restrict: no terminal and no forwarding."
    for key in "${DEPLOY_KEYS[@]}"; do
        printf 'restrict %s\n' "$key"
    done
}

validate_sudoers() { visudo -cqf "$1"; }

create_service_user() {
    local shell=/usr/sbin/nologin
    [[ -x $shell ]] || shell=/sbin/nologin
    run useradd --system --user-group --no-create-home --home-dir /nonexistent --shell "$shell" \
        --comment "$SERVICE_USER_COMMENT" "$SERVICE_USER"
    [[ $MODE != dry-run ]] || DRY_CREATED[$SERVICE_USER]=1
}

create_deploy_user() {
    run useradd --create-home --shell /bin/bash --user-group --groups docker \
        --comment "MSCD deploy (GitHub Actions)" "$DEPLOY_USER"
    [[ $MODE != dry-run ]] || DRY_CREATED[$DEPLOY_USER]=1
}

create_admin_user() {
    run useradd --create-home --shell /bin/bash --user-group --groups sudo --comment "MSCD admin" "$ADMIN_USER"
    [[ $MODE != dry-run ]] || DRY_CREATED[$ADMIN_USER]=1
}

admin_keys_present() {
    local file=$1 key type b64
    if [[ ! -f $file ]]; then
        CURRENT="no authorized_keys file"
        return 1
    fi
    for key in "${ADMIN_KEYS[@]}"; do
        read -r type b64 _ <<<"$key"
        if ! grep -qF -- "$type $b64" "$file"; then
            CURRENT="key ${b64:0:16}... missing"
            return 1
        fi
    done
}

# add_admin_keys FILE: adds the missing keys of --admin-key-file, keeps the others.
add_admin_keys() {
    local file=$1 content='' key type b64
    [[ ! -f $file ]] || content=$(<"$file")
    for key in "${ADMIN_KEYS[@]}"; do
        read -r type b64 _ <<<"$key"
        if [[ $content != *"$type $b64"* ]]; then
            content+=${content:+$'\n'}$key
        fi
    done
    put_file "$file" 0600 "$ADMIN_USER:$(user_group "$ADMIN_USER")" "$content"
}

# copy_root_keys FILE: without --admin-key-file, the admin account gets the keys
# of root (the provider's first key), without any options in front of them.
copy_root_keys() {
    local file=$1 line keys=() re
    re='(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)[[:space:]]+[A-Za-z0-9+/]+={0,3}'
    if [[ -r /root/.ssh/authorized_keys ]]; then
        while IFS= read -r line || [[ -n $line ]]; do
            [[ $line =~ ^[[:space:]]*# ]] && continue
            [[ $line =~ $re ]] && keys+=("${BASH_REMATCH[0]}")
        done </root/.ssh/authorized_keys
    fi
    if ((${#keys[@]} == 0)); then
        if [[ $MODE == dry-run ]]; then
            warn "root has no SSH key to copy. A real run stops here unless --admin-key-file is given."
            return 0
        fi
        die "The account $ADMIN_USER has no SSH key and root has none to copy. Add --admin-key-file with your own public key."
    fi
    warn "$ADMIN_USER gets the SSH keys of root. Replace them with your own key: run again with --admin-key-file."
    put_file "$file" 0600 "$ADMIN_USER:$(user_group "$ADMIN_USER")" "$(printf '%s\n' "${keys[@]}")"
}

step_accounts() {
    local sudoers deploy_keys deploy_home admin_home admin_owner deploy_owner
    sudoers=${TPL[sudoers]//@ADMIN_USER@/$ADMIN_USER}
    deploy_keys=$(deploy_keys_content)
    if [[ $MODE == render ]]; then
        ensure_file "/home/$DEPLOY_USER/.ssh/authorized_keys" 0600 "$DEPLOY_USER:$DEPLOY_USER" "$deploy_keys"
        if ((${#ADMIN_KEYS[@]} > 0)); then
            ensure_file "/home/$ADMIN_USER/.ssh/authorized_keys" 0600 "$ADMIN_USER:$ADMIN_USER" \
                "$(printf '%s\n' "${ADMIN_KEYS[@]}")"
        fi
        ensure_file "$SUDOERS_FILE" 0440 root:root "$sudoers"
        return 0
    fi
    ensure "system account $SERVICE_USER" user_exists "$SERVICE_USER" -- create_service_user
    ensure "group docker" group_exists docker -- \
        die "The group docker does not exist yet. Run the step docker first."
    ensure "account $DEPLOY_USER" user_exists "$DEPLOY_USER" -- create_deploy_user
    ensure "$DEPLOY_USER in group docker" in_group "$DEPLOY_USER" docker -- run usermod -aG docker "$DEPLOY_USER"
    ensure "$DEPLOY_USER without sudo" not_in_group "$DEPLOY_USER" sudo -- run gpasswd -d "$DEPLOY_USER" sudo
    ensure "$DEPLOY_USER signs in with the SSH key only" password_locked "$DEPLOY_USER" -- \
        run usermod --lock "$DEPLOY_USER"
    deploy_home=$(user_home "$DEPLOY_USER")
    deploy_owner="$DEPLOY_USER:$(user_group "$DEPLOY_USER")"
    ensure_dir "$deploy_home/.ssh" 0700 "$deploy_owner"
    ensure_file "$deploy_home/.ssh/authorized_keys" 0600 "$deploy_owner" "$deploy_keys"

    ensure "account $ADMIN_USER" user_exists "$ADMIN_USER" -- create_admin_user
    ensure "$ADMIN_USER in group sudo" in_group "$ADMIN_USER" sudo -- run usermod -aG sudo "$ADMIN_USER"
    admin_home=$(user_home "$ADMIN_USER")
    admin_owner="$ADMIN_USER:$(user_group "$ADMIN_USER")"
    ensure_dir "$admin_home/.ssh" 0700 "$admin_owner"
    if ((${#ADMIN_KEYS[@]} > 0)); then
        ensure "SSH keys of $ADMIN_KEY_FILE for $ADMIN_USER" admin_keys_present "$admin_home/.ssh/authorized_keys" -- \
            add_admin_keys "$admin_home/.ssh/authorized_keys"
    else
        ensure "SSH key for $ADMIN_USER" has_key_lines "$admin_home/.ssh/authorized_keys" -- \
            copy_root_keys "$admin_home/.ssh/authorized_keys"
    fi
    ensure "mode and owner of $admin_home/.ssh/authorized_keys" \
        mode_owner_ok "$admin_home/.ssh/authorized_keys" 0600 "$admin_owner" -- \
        fix_mode_owner "$admin_home/.ssh/authorized_keys" 0600 "$admin_owner"
    ensure_file "$SUDOERS_FILE" 0440 root:root "$sudoers" validate_sudoers
}

# ---------------------------------------------------------------------------
# Step: folders
# ---------------------------------------------------------------------------
step_folders() {
    [[ $MODE != render ]] || return 0
    local entry path mode owner
    user_exists "$DEPLOY_USER" || [[ $MODE != apply ]] || die "The account $DEPLOY_USER does not exist yet. Run the step accounts first."
    owner="$DEPLOY_USER:$(user_group "$DEPLOY_USER")"
    for entry in "${FOLDERS[@]}"; do
        read -r path mode <<<"$entry"
        ensure_dir "$path" "$mode" "$owner"
    done
}

# ---------------------------------------------------------------------------
# Step: security updates
# ---------------------------------------------------------------------------
start_reboot_marker() {
    need_systemd
    run systemctl enable --now mscd-reboot-marker.timer
    run systemctl start mscd-reboot-marker.service
}

step_updates() {
    local changed=false
    ensure_file "$UNATTENDED_FILE" 0644 root:root "${TPL[unattended]}"
    ensure_file "$REBOOT_MARKER" 0755 root:root "${TPL[reboot-marker]}"
    ensure_file "$REBOOT_SERVICE" 0644 root:root "${TPL[reboot-service]}"
    [[ $LAST_CHANGED == false ]] || changed=true
    ensure_file "$REBOOT_TIMER" 0644 root:root "${TPL[reboot-timer]}"
    [[ $LAST_CHANGED == false ]] || changed=true
    [[ $MODE != render ]] || return 0
    ensure "unattended-upgrades installed" packages_installed unattended-upgrades update-notifier-common -- \
        apt_install unattended-upgrades update-notifier-common
    ensure "daily apt timers on" unit_on apt-daily.timer apt-daily-upgrade.timer -- \
        run systemctl enable --now apt-daily.timer apt-daily-upgrade.timer
    ensure "systemd has read the reboot marker units" \
        units_loaded "$changed" mscd-reboot-marker.service mscd-reboot-marker.timer -- run systemctl daemon-reload
    ensure "reboot marker every 15 minutes" unit_on mscd-reboot-marker.timer -- start_reboot_marker
}

# ---------------------------------------------------------------------------
# Step: firewall
# ---------------------------------------------------------------------------
UFW_RULES=()

load_ufw_rules() {
    local line action port comment
    UFW_RULES=()
    while IFS= read -r line; do
        [[ $line =~ ^[[:space:]]*(#|$) ]] && continue
        read -r action port comment <<<"$line"
        [[ $action =~ ^(allow|limit)$ && $port =~ ^[0-9]+/(tcp|udp)$ && $comment =~ ^[a-z0-9-]+$ ]] ||
            die "deploy/host/firewall/ufw-rules: cannot read the line: $line"
        UFW_RULES+=("$action $port $comment")
    done <<<"${TPL[ufw-rules]}"
}

# Values that the Ubuntu ufw package ships, used by a dry run before ufw is installed.
declare -A UFW_PACKAGE_DEFAULTS=([IPV6]=yes [DEFAULT_INPUT_POLICY]=DROP [DEFAULT_OUTPUT_POLICY]=ACCEPT [ENABLED]=no)

ufw_setting() {
    local file=$1 key=$2 value=$3 actual
    if [[ ! -f $file && $MODE == dry-run && -n ${DRY_INSTALLED[ufw]:-} ]]; then
        actual=${UFW_PACKAGE_DEFAULTS[$key]:-}
    else
        actual=$(sed -n "s/^$key=//p" "$file" 2>/dev/null | tr -d '"' | tail -n 1 || true)
    fi
    [[ $actual == "$value" ]] && return 0
    CURRENT=${actual:-not set}
    return 1
}

ufw_has_rule() {
    have_cmd ufw || {
        CURRENT="ufw is not installed"
        return 1
    }
    ufw show added 2>/dev/null | grep -Eq "^ufw $1 $2( |$)" && return 0
    CURRENT=missing
    return 1
}

ufw_active() {
    have_cmd ufw || {
        CURRENT="ufw is not installed"
        return 1
    }
    ufw_setting /etc/ufw/ufw.conf ENABLED yes || return 1
    [[ "$(ufw status 2>/dev/null | head -n 1)" == "Status: active" ]] && return 0
    CURRENT=inactive
    return 1
}

enable_ufw_ipv6() {
    run sed -i 's/^IPV6=.*/IPV6=yes/' /etc/default/ufw
    if [[ $MODE == apply ]] && ufw_active; then
        RELOAD_UFW=true
    fi
}

reload_ufw() {
    run ufw reload
    RELOAD_UFW=false
}

report_other_ufw_rules() {
    have_cmd ufw || return 0
    local line rule action port known
    while IFS= read -r line; do
        [[ $line == ufw\ * ]] || continue
        known=false
        for rule in "${UFW_RULES[@]}"; do
            read -r action port _ <<<"$rule"
            [[ $line =~ ^ufw\ $action\ $port( |$) ]] && known=true
        done
        $known || warn "Another ufw rule is in place and stays: $line"
    done < <(ufw show added 2>/dev/null || true)
}

fail2ban_ok() {
    if [[ $RESTART_FAIL2BAN == true ]]; then
        CURRENT="$FAIL2BAN_JAIL changed"
        return 1
    fi
    unit_on fail2ban.service || return 1
    fail2ban-client status sshd >/dev/null 2>&1 && return 0
    CURRENT="no sshd jail"
    return 1
}

restart_fail2ban() {
    need_systemd
    run systemctl enable fail2ban.service
    run systemctl restart fail2ban.service
    RESTART_FAIL2BAN=false
    [[ $MODE == apply ]] || return 0
    for _ in $(seq 1 20); do
        fail2ban-client status sshd >/dev/null 2>&1 && return 0
        sleep 1
    done
    die "fail2ban has no sshd jail 20 seconds after the restart. See: journalctl -u fail2ban.service"
}

step_firewall() {
    local rule action port comment
    load_ufw_rules
    ensure_file "$FAIL2BAN_JAIL" 0644 root:root "${TPL[fail2ban]}"
    RESTART_FAIL2BAN=$LAST_CHANGED
    [[ $MODE != render ]] || return 0
    ensure "packages ufw fail2ban python3-systemd" packages_installed ufw fail2ban python3-systemd -- \
        apt_install ufw fail2ban python3-systemd
    ensure "ufw filters IPv6 too" ufw_setting /etc/default/ufw IPV6 yes -- enable_ufw_ipv6
    ensure "ufw denies incoming connections by default" ufw_setting /etc/default/ufw DEFAULT_INPUT_POLICY DROP -- \
        run ufw default deny incoming
    ensure "ufw allows outgoing connections" ufw_setting /etc/default/ufw DEFAULT_OUTPUT_POLICY ACCEPT -- \
        run ufw default allow outgoing
    for rule in "${UFW_RULES[@]}"; do
        read -r action port comment <<<"$rule"
        ensure "ufw $action $port" ufw_has_rule "$action" "$port" -- run ufw "$action" "$port" comment "$comment"
    done
    ensure "ufw on, also after a reboot" ufw_active -- run ufw --force enable
    ensure "ufw has loaded the IPv6 setting" flag_false "$RELOAD_UFW" -- reload_ufw
    [[ $MODE == dry-run ]] || report_other_ufw_rules
    ensure "fail2ban watches the SSH logins" fail2ban_ok -- restart_fail2ban
}

# ---------------------------------------------------------------------------
# Step: SSH
# ---------------------------------------------------------------------------
sshd_reads_dropins() {
    if [[ ! -f /etc/ssh/sshd_config ]]; then
        [[ $MODE == dry-run ]] && return 0
        CURRENT="/etc/ssh/sshd_config is missing"
        return 1
    fi
    grep -Eq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config && return 0
    CURRENT="no Include line"
    return 1
}

validate_sshd_snippet() {
    install -d -m 0755 /run/sshd
    sshd -t -f "$1"
}

# sshd_effective_ok: the settings sshd reads from all its files (sshd -T).
sshd_effective_ok() {
    local out users expected
    if [[ $MODE == dry-run ]] || ! have_cmd sshd; then
        return 0
    fi
    if [[ ! -d /run/sshd ]]; then
        [[ $MODE == check ]] && return 0
        install -d -m 0755 /run/sshd
    fi
    out=$(sshd -T 2>&1) || {
        CURRENT="sshd -T failed: ${out##*$'\n'}"
        return 1
    }
    local setting
    for setting in 'passwordauthentication no' 'kbdinteractiveauthentication no' 'permitrootlogin no' \
        'pubkeyauthentication yes'; do
        if ! grep -qx -- "$setting" <<<"$out"; then
            CURRENT=$(grep -m 1 "^${setting%% *} " <<<"$out" || echo "${setting%% *} not set")
            return 1
        fi
    done
    users=$(awk '$1 == "allowusers" {print $2}' <<<"$out" | sort | tr '\n' ' ')
    expected=$(printf '%s\n' "$DEPLOY_USER" "$ADMIN_USER" | sort | tr '\n' ' ')
    [[ $users == "$expected" ]] && return 0
    CURRENT="allowusers ${users:-not set}"
    return 1
}

# lockout_guard: root and password logins are turned off only when both
# accounts that remain can sign in with a key.
lockout_guard() {
    local user home
    for user in "$DEPLOY_USER" "$ADMIN_USER"; do
        user_exists "$user" || die "The account $user does not exist. Run the step accounts before ssh."
        home=$(user_home "$user")
        has_key_lines "$home/.ssh/authorized_keys" ||
            die "The account $user has no SSH key. Root and password logins stay on until it has one."
    done
}

refuse_sshd_override() {
    die "Another file in /etc/ssh overrides $SSHD_DROPIN ($CURRENT). Remove that setting and run the script again."
}

reload_sshd() {
    run install -d -m 0755 /run/sshd
    run sshd -t
    if have_systemd || [[ $MODE == dry-run ]]; then
        run systemctl try-reload-or-restart ssh.service
    else
        warn "systemd is not running here, so no sshd runs: sshd reads the new settings when it starts."
    fi
    RELOAD_SSHD=false
}

step_ssh() {
    local content previous='' had_file=false
    content=${TPL[sshd]//@ALLOW_USERS@/$DEPLOY_USER $ADMIN_USER}
    if [[ $MODE == render ]]; then
        ensure_file "$SSHD_DROPIN" 0644 root:root "$content"
        return 0
    fi
    ensure "sshd reads /etc/ssh/sshd_config.d" sshd_reads_dropins -- \
        die "/etc/ssh/sshd_config has no line 'Include /etc/ssh/sshd_config.d/*.conf'. Add it at the top and run the script again."
    [[ $MODE != apply ]] || lockout_guard
    if [[ -f $SSHD_DROPIN ]]; then
        previous=$(<"$SSHD_DROPIN")
        had_file=true
    fi
    ensure_file "$SSHD_DROPIN" 0644 root:root "$content" validate_sshd_snippet
    RELOAD_SSHD=$LAST_CHANGED
    if [[ $MODE == apply && $LAST_CHANGED == true ]] && ! sshd -t >/dev/null 2>&1; then
        if $had_file; then
            write_file "$SSHD_DROPIN" 0644 root:root "$previous"
        else
            rm -f -- "$SSHD_DROPIN"
        fi
        die "sshd does not accept its configuration with $SSHD_DROPIN. The previous state is restored. Run: sshd -t"
    fi
    ensure "sshd settings in effect (sshd -T)" sshd_effective_ok -- refuse_sshd_override
    ensure "sshd has loaded $SSHD_DROPIN" flag_false "$RELOAD_SSHD" -- reload_sshd
}

# ---------------------------------------------------------------------------
# Output for the owner
# ---------------------------------------------------------------------------
print_host_keys() {
    local file type b64 lines=() fingerprint
    section "SSH host keys"
    for file in /etc/ssh/ssh_host_ed25519_key.pub /etc/ssh/ssh_host_ecdsa_key.pub /etc/ssh/ssh_host_rsa_key.pub; do
        [[ -r $file ]] || continue
        read -r type b64 _ <"$file"
        lines+=("$SSH_HOST $type $b64")
        if have_cmd ssh-keygen; then
            fingerprint=$(ssh-keygen -l -E sha256 -f "$file" | awk '{print $2, $NF}')
            say "Fingerprint: $fingerprint"
        fi
    done
    if ((${#lines[@]} == 0)); then
        say "No SSH host keys yet (openssh-server is not installed)."
        return 0
    fi
    say "Compare a fingerprint with the one the provider console shows."
    say "Value of the secret DEPLOY_SSH_KNOWN_HOSTS (one line per key):"
    printf '    %s\n' "${lines[@]}"
    say "The lines start with $SSH_HOST. Run again with --ssh-host when GitHub reaches the server under another name."
    if [[ $MODE == apply && -d $MSCD_DIR/state ]]; then
        write_file "$KNOWN_HOSTS_FILE" 0644 root:root "$(printf '%s\n' "${lines[@]}")"
        say "Saved in $KNOWN_HOSTS_FILE."
    fi
}

run_step() {
    local id=$1 title=${STEP_TITLES[$1]} status
    DIFFS=()
    NOTES=()
    SKIP_REASON=''
    LAST_CHANGED=false
    if ! step_selected "$id"; then
        [[ $MODE == render ]] || SUMMARY+=("skipped|$title (not in --only)")
        return 0
    fi
    [[ $MODE == render ]] || section "$title"
    "step_${id//-/_}"
    [[ $MODE != render ]] || return 0
    if [[ -n $SKIP_REASON ]]; then
        result skipped "$SKIP_REASON"
        SUMMARY+=("skipped|$title ($SKIP_REASON)")
        return 0
    fi
    if [[ $MODE == check ]]; then
        if ((${#DIFFS[@]} > 0)); then
            local diff
            for diff in "${DIFFS[@]}"; do result differs "$diff"; done
            DIFF_COUNT=$((DIFF_COUNT + ${#DIFFS[@]}))
            SUMMARY+=("differs|$title")
        else
            result ok
            SUMMARY+=("ok|$title")
        fi
        return 0
    fi
    if ((${#NOTES[@]} > 0)); then
        status=changed
        result changed "$(join_notes "${NOTES[@]}")"
    else
        status='done'
        result 'done'
    fi
    SUMMARY+=("$status|$title")
}

join_notes() {
    local out=$1
    shift
    while (($# > 0)); do
        out+="; $1"
        shift
    done
    printf '%s' "$out"
}

print_summary() {
    local entry
    section "Summary"
    for entry in "${SUMMARY[@]}"; do
        result "${entry%%|*}" "${entry#*|}"
    done
}

main() {
    parse_args "$@"
    preflight
    trap 'on_error "$LINENO" "$BASH_COMMAND"' ERR
    case $MODE in
        apply) printf '%sMSCD server bootstrap%s (admin %s)\n' "$C_BOLD" "$C_RESET" "$ADMIN_USER" ;;
        dry-run) printf '%sMSCD server bootstrap, dry run%s: nothing is changed\n' "$C_BOLD" "$C_RESET" ;;
        check) printf '%sMSCD server bootstrap, check%s: nothing is changed\n' "$C_BOLD" "$C_RESET" ;;
    esac
    local step
    for step in "${STEPS[@]}"; do
        run_step "$step"
    done

    if [[ $MODE == render ]]; then
        printf 'Rendered %d configuration files under %s:\n' "${#RENDERED[@]}" "$ROOT"
        printf '  %s\n' "${RENDERED[@]}"
        return 0
    fi
    print_host_keys
    print_summary
    if [[ -e /run/reboot-required && $MODE != dry-run ]]; then
        warn "Installed updates need a reboot: sudo reboot (on a live server, in the maintenance window)."
    fi
    case $MODE in
        check)
            if ((DIFF_COUNT > 0)); then
                printf '\n%s%d item(s) differ from the target state.%s Run the script without --check to fix them.\n' \
                    "$C_RED" "$DIFF_COUNT" "$C_RESET"
                exit 1
            fi
            printf '\nThe server matches the target state.\n'
            ;;
        dry-run) printf '\nDry run finished. Nothing was changed.\n' ;;
        apply)
            log "bootstrap-host.sh finished"
            printf '\nBootstrap finished. The log is in %s.\n' "$LOG_FILE"
            if step_selected ssh; then
                printf 'Root and password logins are off. Sign in as %s or %s with an SSH key.\n' "$ADMIN_USER" "$DEPLOY_USER"
            fi
            ;;
    esac
}

main "$@"
