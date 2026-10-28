#!/usr/bin/env bash
# MSCD SaaS: the allow-list of operator commands on a SaaS server (Milestone 2 plan K.6,
# M2-S09; docs/saas/operator.md). ops-cli.yml runs it over SSH as the deploy account; an
# operator on the server may run it by hand. Each command, with checked values, becomes
# one "docker compose run --rm -T --no-deps cli <mscd-server command>" of the installed
# stack in /opt/mscd. Nothing else can be run through it: no shell, no psql, no free
# arguments.
#
#   saas-ops.sh tenant-show --org bank_sentosa
#   saas-ops.sh tenant-set-status --input-stdin --public < values     (ops-cli.yml)
#
# With --input-stdin the values come on standard input, one NAME=<base64 of the value>
# line each (the names are the options in capitals with _ for -, for example ORG,
# ADMIN_EMAIL, TIME_ZONE), so no value appears on a command line or in the process list.
#
# With --public the output is fit for the log of a public workflow (rule GL-50 of the
# go-live checklist): every value given (emails, names, slugs, the reason) is replaced by
# a placeholder, and so are the part of a given email before @ and the user handle that
# mscd-server makes from it, the handle after "created user" or "invited existing user",
# one-time link tokens, other email addresses, schema names and IP addresses; tenant-list
# and tenant-show print counts and states only. The full output of every run stays on the
# server in <install-dir>/logs/ops-<time>-<command>.log (mode 0600) for OPS_KEEP_LOG_DAYS
# days; diagnostics archives stay OPS_KEEP_DIAGNOSTICS_DAYS days. Each run removes older ones.
#
# Exit codes: 0 done, 2 refused before anything ran (unknown command, a value that does
# not pass its check, no stack installed), else the exit code of the command.
set -euo pipefail
umask 027

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

readonly SAAS_OPS_COMMANDS=(create-operator revoke-operator tenant-list tenant-show tenant-onboard
    tenant-set-status admin-create-user license-entitlements-show license-entitlements-set diagnostics)
# Days the server keeps the full output of a run (it holds emails, names and reasons) and a
# diagnostics archive (docs/saas/operator.md, records-of-processing.md).
readonly OPS_KEEP_LOG_DAYS=90
readonly OPS_KEEP_DIAGNOSTICS_DAYS=14

usage() {
    cat <<'EOF'
Usage: saas-ops.sh COMMAND [options]
       saas-ops.sh COMMAND --input-stdin [--public] < values

Runs one operator command of mscd-server in the installed SaaS stack
("docker compose run --rm -T --no-deps cli ..."). docs/saas/operator.md explains each one.

Commands and their options:
  create-operator            --email EMAIL [--name NAME]
  revoke-operator            --email EMAIL
  tenant-list                [--status STATUS]
  tenant-show                --org SLUG
  tenant-onboard             --slug SLUG --name NAME --time-zone ZONE --site-count N
                             --admin-email EMAIL --admin-name NAME [--preset NAME]
  tenant-set-status          --org SLUG --status STATUS --reason TEXT [--confirm SLUG]
  admin-create-user          --org SLUG --email EMAIL [--name NAME] [--tenant-admin]
  license-entitlements-show  --org SLUG
  license-entitlements-set   --org SLUG (--preset NAME [--valid-from DATE] |
                             --max-users N --max-systems N --valid-until DATE|none
                             [--valid-from DATE] [--grace-days N])
  diagnostics                (the archive is written to <install-dir>/diagnostics)

Options of every command:
  --install-dir DIR   Install folder of the stack (default: /opt/mscd)
  --input-stdin       Read the values from standard input, NAME=<base64> per line
                      (NAME is the option in capitals, for example ADMIN_EMAIL)
  --public            Output for a public log: values, user handles and link tokens masked,
                      counts only for tenant-list and tenant-show; the full output stays
                      in <install-dir>/logs for 90 days
  --dry-run           Check the values and print the command, run nothing
  -h, --help          Show this help

STATUS is active, suspended, offboarding or archived. A SLUG is a lower-case letter, then
1 to 39 lower-case letters, digits or _. Dates are YYYY-MM-DD.
EOF
}

# The values of the options, by stdin name (ORG, ADMIN_EMAIL, ...).
declare -A VALUE=()
# Stdin names each command takes, and those it requires.
declare -A TAKES=(
    [create-operator]='EMAIL NAME'
    [revoke-operator]='EMAIL'
    [tenant-list]='STATUS'
    [tenant-show]='ORG'
    [tenant-onboard]='SLUG NAME TIME_ZONE SITE_COUNT ADMIN_EMAIL ADMIN_NAME PRESET'
    [tenant-set-status]='ORG STATUS REASON CONFIRM'
    [admin-create-user]='ORG EMAIL NAME TENANT_ADMIN'
    [license-entitlements-show]='ORG'
    [license-entitlements-set]='ORG PRESET MAX_USERS MAX_SYSTEMS VALID_UNTIL VALID_FROM GRACE_DAYS'
    [diagnostics]=''
)
declare -A NEEDS=(
    [create-operator]='EMAIL'
    [revoke-operator]='EMAIL'
    [tenant-show]='ORG'
    [tenant-onboard]='SLUG NAME TIME_ZONE SITE_COUNT ADMIN_EMAIL ADMIN_NAME'
    [tenant-set-status]='ORG STATUS REASON'
    [admin-create-user]='ORG EMAIL'
    [license-entitlements-show]='ORG'
    [license-entitlements-set]='ORG'
)

COMMAND='' INSTALL_DIR=/opt/mscd INPUT_STDIN=false PUBLIC=false DRY_RUN=false

# A refusal before anything ran: one line on standard error, exit code 2.
refuse() {
    printf 'saas-ops.sh: %s\n' "$1" >&2
    exit 2
}

# name_of OPTION: the stdin name of an option (--admin-email -> ADMIN_EMAIL).
name_of() {
    local option=${1#--}
    option=${option//-/_}
    printf '%s' "${option^^}"
}

parse_args() {
    [[ $# -gt 0 ]] || { usage >&2; exit 2; }
    case "$1" in
        -h | --help) usage; exit 0 ;;
    esac
    COMMAND=$1
    shift
    local known=false item
    for item in "${SAAS_OPS_COMMANDS[@]}"; do [[ $item == "$COMMAND" ]] && known=true; done
    $known || refuse "unknown command '$COMMAND'. Allowed: ${SAAS_OPS_COMMANDS[*]}"
    local name
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -h | --help) usage; exit 0 ;;
            --input-stdin) INPUT_STDIN=true; shift ;;
            --public) PUBLIC=true; shift ;;
            --dry-run) DRY_RUN=true; shift ;;
            --install-dir) [[ $# -ge 2 ]] || refuse "--install-dir needs a value"; INSTALL_DIR=$2; shift 2 ;;
            --install-dir=*) INSTALL_DIR=${1#*=}; shift ;;
            --tenant-admin)
                takes TENANT_ADMIN || refuse "$COMMAND takes no option --tenant-admin"
                VALUE[TENANT_ADMIN]=true
                shift
                ;;
            --*=*)
                name=$(name_of "${1%%=*}")
                takes "$name" || refuse "$COMMAND takes no option ${1%%=*}"
                VALUE[$name]=${1#*=}
                shift
                ;;
            --*)
                name=$(name_of "$1")
                takes "$name" || refuse "$COMMAND takes no option $1"
                [[ $# -ge 2 ]] || refuse "$1 needs a value"
                VALUE[$name]=$2
                shift 2
                ;;
            *) refuse "unexpected argument '$1'; values are given as options, see --help" ;;
        esac
    done
}

# takes NAME: true when the command takes the stdin name NAME.
takes() {
    local item
    for item in ${TAKES[$COMMAND]}; do [[ $item == "$1" ]] && return 0; done
    return 1
}

# read_stdin: NAME=<base64> lines into VALUE. Names the command does not take are
# refused; an empty value counts as not given. The values are never printed.
read_stdin() {
    local line name encoded decoded count=0
    [[ ! -t 0 ]] || refuse "--input-stdin needs the values on standard input, not a terminal"
    while IFS= read -r line || [[ -n $line ]]; do
        line=${line%$'\r'}
        [[ -n $line ]] || continue
        count=$((count + 1))
        ((count <= 40)) || refuse "standard input has more than 40 lines"
        [[ $line =~ ^([A-Z][A-Z_]{0,31})=([A-Za-z0-9+/]*={0,2})$ ]] ||
            refuse "line $count of standard input is not NAME=<base64 value> (the line is not shown)"
        name=${BASH_REMATCH[1]} encoded=${BASH_REMATCH[2]}
        takes "$name" || refuse "standard input names $name, which $COMMAND does not take"
        decoded=$(printf '%s' "$encoded" | base64 -d 2>/dev/null) || refuse "the value of $name on standard input is not base64"
        [[ -z $decoded ]] || VALUE[$name]=$decoded
    done
}

# check NAME PATTERN WHAT: the value of NAME, when given, matches the extended regular
# expression PATTERN.
check() {
    local name=$1 pattern=$2 what=$3
    [[ -n ${VALUE[$name]+x} ]] || return 0
    [[ ${VALUE[$name]} =~ $pattern ]] || refuse "$(option_of "$name") must be $what (the value is not shown)"
}

# check_text NAME MIN MAX: printable text of MIN to MAX characters, no control characters,
# not starting with - (so it can never be read as an option).
check_text() {
    local name=$1 min=$2 max=$3 value
    [[ -n ${VALUE[$name]+x} ]] || return 0
    value=${VALUE[$name]}
    if ((${#value} < min || ${#value} > max)) || [[ $value == -* || $value =~ [[:cntrl:]] ]]; then
        refuse "$(option_of "$name") must be text of $min to $max characters without control characters, not starting with - (the value is not shown)"
    fi
}

option_of() {
    local option=${1,,}
    printf -- '--%s' "${option//_/-}"
}

validate() {
    local name
    for name in ${NEEDS[$COMMAND]:-}; do
        [[ -n ${VALUE[$name]:-} ]] || refuse "$COMMAND needs $(option_of "$name")"
    done
    local slug='^[a-z][a-z0-9_]{1,39}$'
    check ORG "$slug" 'an organisation slug'
    check SLUG "$slug" 'an organisation slug'
    check CONFIRM "$slug" 'the organisation slug'
    check EMAIL '^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$' 'an email address'
    check ADMIN_EMAIL '^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$' 'an email address'
    for name in EMAIL ADMIN_EMAIL; do
        if [[ -n ${VALUE[$name]+x} ]] && ((${#VALUE[$name]} > 254)); then refuse "$(option_of "$name") is longer than 254 characters"; fi
    done
    check_text NAME 1 200
    check_text ADMIN_NAME 1 150
    check_text REASON 3 500
    check TIME_ZONE '^[A-Za-z][A-Za-z0-9_+/-]{1,63}$' 'an IANA time zone such as Asia/Jakarta'
    check SITE_COUNT '^[0-9]{1,5}$' 'a whole number'
    check PRESET '^[a-z][a-z0-9_-]{0,39}$' 'a plan preset name such as trial or standard'
    check STATUS '^(active|suspended|offboarding|archived)$' 'active, suspended, offboarding or archived'
    check TENANT_ADMIN '^(true|false)$' 'true or false'
    check MAX_USERS '^[0-9]{1,9}$' 'a whole number'
    check MAX_SYSTEMS '^[0-9]{1,9}$' 'a whole number'
    check GRACE_DAYS '^[0-9]{1,3}$' 'a whole number of days'
    check VALID_FROM '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' 'a date YYYY-MM-DD'
    check VALID_UNTIL '^([0-9]{4}-[0-9]{2}-[0-9]{2}|none)$' 'a date YYYY-MM-DD or none'
    if [[ $COMMAND == license-entitlements-set ]]; then
        local limits=false
        for name in MAX_USERS MAX_SYSTEMS VALID_UNTIL GRACE_DAYS; do [[ -z ${VALUE[$name]:-} ]] || limits=true; done
        if [[ -n ${VALUE[PRESET]:-} ]] && $limits; then refuse "license-entitlements-set takes --preset or limits, not both"; fi
        if [[ -z ${VALUE[PRESET]:-} ]] && ! $limits; then refuse "license-entitlements-set needs --preset, or --max-users, --max-systems and --valid-until"; fi
    fi
    [[ $INSTALL_DIR == /* && $INSTALL_DIR != *..* ]] || refuse "--install-dir must be an absolute path"
}

# opt NAME FLAG: appends FLAG=<value> to CLI when NAME has a value. One argument per
# option, so a value is never split or read as another option.
opt() {
    if [[ -n ${VALUE[$1]:-} ]]; then CLI+=("$2=${VALUE[$1]}"); fi
}

# build_cli: the mscd-server arguments of the command in CLI.
build_cli() {
    CLI=()
    case "$COMMAND" in
        create-operator) CLI=(admin create-operator); opt EMAIL --email; opt NAME --name ;;
        revoke-operator) CLI=(admin revoke-operator); opt EMAIL --email ;;
        tenant-list)
            CLI=(tenant list); opt STATUS --status
            if $PUBLIC; then CLI+=(--summary); fi
            ;;
        tenant-show)
            CLI=(tenant show); opt ORG --org
            if $PUBLIC; then CLI+=(--summary); fi
            ;;
        tenant-onboard)
            CLI=(tenant onboard); opt SLUG --slug; opt NAME --name; opt TIME_ZONE --time-zone; opt SITE_COUNT --site-count
            opt ADMIN_EMAIL --admin-email; opt ADMIN_NAME --admin-name; opt PRESET --preset
            ;;
        tenant-set-status) CLI=(tenant set-status); opt ORG --org; opt STATUS --status; opt REASON --reason; opt CONFIRM --confirm ;;
        admin-create-user)
            CLI=(admin create-user); opt ORG --org; opt EMAIL --email; opt NAME --name
            if [[ ${VALUE[TENANT_ADMIN]:-false} == true ]]; then CLI+=(--tenant-admin); fi
            ;;
        license-entitlements-show) CLI=(license entitlements show); opt ORG --org ;;
        license-entitlements-set)
            CLI=(license entitlements set); opt ORG --org; opt PRESET --preset; opt MAX_USERS --max-users; opt MAX_SYSTEMS --max-systems
            opt VALID_UNTIL --valid-until; opt VALID_FROM --valid-from; opt GRACE_DAYS --grace-days
            ;;
        diagnostics) CLI=(diagnostics --out -) ;;
    esac
}

# Placeholders of the values given, longest first, for --public output.
declare -a MASK_FROM=() MASK_TO=()
# sed expressions of public_filter that hide user names (see build_masks).
declare -a WORD_SED=()
build_masks() {
    local -a pairs=()
    local -A words=()
    local name label value word
    for name in "${!VALUE[@]}"; do
        value=${VALUE[$name]}
        case "$name" in
            EMAIL | ADMIN_EMAIL) label='[email]' ;;
            ORG | SLUG | CONFIRM) label='[organisation]' ;;
            NAME) [[ $COMMAND == tenant-onboard ]] && label='[organisation name]' || label='[name]' ;;
            ADMIN_NAME) label='[name]' ;;
            REASON) label='[reason]' ;;
            *) continue ;;
        esac
        [[ -n $value ]] || continue
        pairs+=("${#value}"$'\t'"$value"$'\t'"$label")
        if [[ ${value,,} != "$value" ]]; then pairs+=("${#value}"$'\t'"${value,,}"$'\t'"$label"); fi
        # mscd-server names a new account by a handle made from the part of the email before
        # @ (andi.wijaya for Andi.Wijaya@example.com). Both are hidden as whole words, in any
        # case, also with a suffix such as andi.wijaya-2.
        if [[ $label == '[email]' ]]; then
            word=${value%%@*}
            if ((${#word} >= 2)); then words[${word,,}]=1; fi
            words[$(handle_base "$value")]=1
        fi
    done
    local length
    while IFS=$'\t' read -r length value label; do
        [[ -n $length ]] || continue
        MASK_FROM+=("$value")
        MASK_TO+=("$label")
    done < <(if ((${#pairs[@]} > 0)); then printf '%s\n' "${pairs[@]}" | sort -t $'\t' -k1,1nr; fi)
    local expression
    for word in "${!words[@]}"; do
        # The word between characters that cannot belong to it; twice, because one match
        # uses up the character before the next one ("andi andi").
        expression="s/(^|[^A-Za-z0-9._%+-])$(word_pattern "$word")([^A-Za-z0-9]|\$)/\\1[user]\\2/g"
        WORD_SED+=(-e "$expression" -e "$expression")
    done
}

# handle_base EMAIL: the handle mscd-server makes from EMAIL (handleBase of
# identity/invitation.service.ts): the part before @ in lower case, other characters than
# a-z 0-9 . _ - turned into dots, no leading characters other than letters, no trailing . _ -,
# at most 34 characters, and "user" in front when shorter than 2.
handle_base() {
    local base=${1%%@*}
    base=$(printf '%s' "${base,,}" | sed -E 's/[^a-z0-9._-]+/./g; s/[.]{2,}/./g; s/^[^a-z]+//; s/[._-]+$//')
    if ((${#base} > 34)); then base=$(printf '%s' "${base:0:34}" | sed -E 's/[._-]+$//'); fi
    if ((${#base} < 2)); then base=user$base; fi
    printf '%s' "$base"
}

# word_pattern WORD: an extended regular expression that matches WORD in any case. WORD
# holds only the characters of an email's local part (checked), each put in brackets.
word_pattern() {
    local word=$1 out='' char i
    for ((i = 0; i < ${#word}; i++)); do
        char=${word:i:1}
        case "$char" in
            [a-zA-Z]) out+="[${char,,}${char^^}]" ;;
            [0-9._%+-]) out+="[$char]" ;;
            *) out+='.' ;;
        esac
    done
    printf '%s' "$out"
}

# public_filter: copies standard input with the values given replaced by placeholders,
# then saas_redact (other emails, schema names, IP addresses), then the user names of the
# emails given, the handle that admin create-user prints and the token of a one-time link
# (printed when mail is not configured).
public_filter() {
    local line i
    while IFS= read -r line || [[ -n $line ]]; do
        for i in "${!MASK_FROM[@]}"; do line=${line//"${MASK_FROM[$i]}"/"${MASK_TO[$i]}"}; done
        printf '%s\n' "$line"
    done | saas_redact | sed -E "${WORD_SED[@]}" \
        -e 's/(created user|invited existing user) [^ ]+/\1 [user]/g' \
        -e 's/(token=)[^[:space:]]+/\1[hidden]/g'
}

# shown_cli: the command line for messages (values masked with --public).
shown_cli() {
    local arg out=()
    for arg in "${CLI[@]}"; do
        if $PUBLIC && [[ $arg == --*=* ]]; then
            out+=("${arg%%=*}=$(printf '%s' "${arg#*=}" | public_filter)")
        else
            out+=("$arg")
        fi
    done
    printf '%s ' "${out[@]}"
}

# run_cli LOG: runs the command in a one-off cli container; output to standard output and LOG.
run_cli() {
    local log=$1 status=0
    if $PUBLIC; then
        saas_compose run --rm -T --no-deps cli "${CLI[@]}" 2>&1 </dev/null | tee -a "$log" | public_filter || status=${PIPESTATUS[0]}
    else
        saas_compose run --rm -T --no-deps cli "${CLI[@]}" 2>&1 </dev/null | tee -a "$log" || status=${PIPESTATUS[0]}
    fi
    return "$status"
}

# run_diagnostics LOG: the archive on standard output of the container, kept in
# <install-dir>/diagnostics (mode 0600); the report of the command goes to LOG and out.
run_diagnostics() {
    local log=$1 dir=$INSTALL_DIR/diagnostics file status=0 bytes sum
    install -d -m 0700 "$dir"
    file=$dir/mscd-diagnostics-$(date -u +%Y%m%dT%H%M%SZ).tar.gz
    (umask 077 && saas_compose run --rm -T --no-deps cli "${CLI[@]}" </dev/null >"$file" 2>>"$log") || status=$?
    if ((status != 0)); then
        rm -f -- "$file"
        printf 'diagnostics failed with exit code %s; the reason is in %s on the server\n' "$status" "$log" | tee -a "$log"
        return "$status"
    fi
    bytes=$(wc -c <"$file" | tr -d ' ')
    sum=$(sha256sum "$file" | cut -d ' ' -f 1)
    printf 'diagnostics: archive written on the server to %s (%s bytes, SHA-256 %s)\n' "$file" "$bytes" "$sum" | tee -a "$log"
    printf 'Copy it with your own SSH access and review every file before you send it to support.\n' | tee -a "$log"
}

# prune_old LOG: removes the files of this script that are past their days: run logs
# (logs/ops-<time>-<command>.log) after OPS_KEEP_LOG_DAYS and diagnostics archives after
# OPS_KEEP_DIAGNOSTICS_DAYS. Other files in those folders stay. The count goes to LOG.
prune_old() {
    local log=$1 logs=0 archives=0
    if [[ -d $INSTALL_DIR/logs ]]; then
        logs=$(find "$INSTALL_DIR/logs" -mindepth 1 -maxdepth 1 -type f -name 'ops-*Z-*.log' \
            -mtime +"$OPS_KEEP_LOG_DAYS" -print -delete 2>>"$log" | wc -l) || true
    fi
    if [[ -d $INSTALL_DIR/diagnostics ]]; then
        archives=$(find "$INSTALL_DIR/diagnostics" -mindepth 1 -maxdepth 1 -type f -name 'mscd-diagnostics-*Z.tar.gz' \
            -mtime +"$OPS_KEEP_DIAGNOSTICS_DAYS" -print -delete 2>>"$log" | wc -l) || true
    fi
    printf '%s removed %s run log(s) older than %s days and %s diagnostics archive(s) older than %s days\n' \
        "$(saas_now)" "${logs// /}" "$OPS_KEEP_LOG_DAYS" "${archives// /}" "$OPS_KEEP_DIAGNOSTICS_DAYS" >>"$log"
}

main() {
    parse_args "$@"
    if $INPUT_STDIN; then read_stdin; fi
    validate
    build_cli

    if [[ -z ${COMPOSE_PROJECT_NAME:-} && -r $INSTALL_DIR/.env ]]; then
        local project
        project=$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$INSTALL_DIR/.env" | tail -n 1)
        if [[ $project =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]]; then export COMPOSE_PROJECT_NAME=$project; fi
    fi
    # shellcheck source=lib/common.sh disable=SC1091  # followed with shellcheck -x
    . "$SCRIPT_DIR/lib/common.sh"
    # shellcheck source=lib/saas.sh disable=SC1091
    . "$SCRIPT_DIR/lib/saas.sh"
    build_masks

    if $DRY_RUN; then
        printf 'saas-ops.sh: would run mscd-server %s(dry run, nothing ran)\n' "$(shown_cli)"
        exit 0
    fi
    [[ -f $INSTALL_DIR/.env && -d $INSTALL_DIR/deploy/compose ]] ||
        refuse "no MSCD SaaS stack is installed in $INSTALL_DIR (no .env or deploy/compose); deploy-prod.yml installs it"
    command -v docker >/dev/null 2>&1 || refuse "docker is not installed"

    local log_dir=$INSTALL_DIR/logs log stamp status=0
    install -d -m 0750 "$log_dir"
    stamp=$(date -u +%Y%m%dT%H%M%SZ)
    log=$log_dir/ops-$stamp-$COMMAND.log
    (umask 077 && : >"$log")
    printf '%s saas-ops.sh %s: mscd-server %s\n' "$(saas_now)" "$COMMAND" "$(PUBLIC=false shown_cli)" >>"$log"
    printf 'saas-ops.sh: mscd-server %s\n' "$(shown_cli)"
    if [[ $COMMAND == diagnostics ]]; then
        run_diagnostics "$log" || status=$?
    else
        run_cli "$log" || status=$?
    fi
    prune_old "$log"
    printf '%s exit code %s\n' "$(saas_now)" "$status" >>"$log"
    if ((status == 0)); then
        printf 'saas-ops.sh: %s finished. The full output is in %s on the server.\n' "$COMMAND" "$log"
    else
        printf 'saas-ops.sh: %s stopped with exit code %s. The full output is in %s on the server.\n' "$COMMAND" "$status" "$log"
    fi
    return "$status"
}

main "$@"
