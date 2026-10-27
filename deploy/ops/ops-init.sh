#!/bin/sh
# MSCD SaaS: ops-init, the one-shot set-up of the monitoring overlay (M2-S08).
#
# docker-compose.ops.yml runs it (image postgres:16.15-alpine, as root with only the CHOWN,
# DAC_OVERRIDE and FOWNER capabilities) every time the overlay starts. Every step can run
# again safely:
#   1. PostgreSQL: creates or updates the login role mscd_monitor (member of pg_monitor, read
#      only, at most 5 connections) for postgres-exporter. Its password is made once and kept
#      in the ops_state volume.
#   2. Prometheus: writes the probe target (the public URL) to the ops_prometheus volume.
#   3. Alertmanager: renders /ops-config/alertmanager/alertmanager.yml.tmpl into the ops_alertmanager
#      volume, with the secrets it needs copied next to it as files only Alertmanager reads.
#   4. Caddy: writes the site of the optional Grafana host ops.<domain> to the ops_caddy volume,
#      or removes it when Grafana is not set up (conf.d/ops.caddy imports it).
#
# Settings (environment, from .env through docker-compose.ops.yml):
#   MSCD_DOMAIN, MSCD_PUBLIC_URL        host name and public address of the app
#   MSCD_OPS_PROBE_URL                  address the HTTPS probe checks (default
#                                       <MSCD_PUBLIC_URL>/healthz)
#   MSCD_OPS_SMTP_HOST, _PORT, _USER    mail relay of the alerts (default: the MSCD_SMTP_*
#   MSCD_OPS_MAIL_FROM                  values and MSCD_MAIL_FROM of the app)
#   MSCD_OPS_SMTP_REQUIRE_TLS           true (default): STARTTLS must succeed before the login
# Files of /run/ops-secrets (/opt/mscd/secrets/ops on the server, written by deploy-prod.yml),
# one value per file:
#   ALERT_EMAIL_TO                      required: address or comma-separated addresses
#   HEARTBEAT_WATCHDOG_URL              ping address of the watchdog heartbeat check
#   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID  both, or neither
#   OPS_DOMAIN, OPS_BASIC_AUTH_HASH     Grafana host and the bcrypt hash of its password
#   OPS_BASIC_AUTH_USER                 Grafana user name (default ops)
# Secret files of Compose: /run/secrets/postgres-admin.password, /run/secrets/smtp.password.
#
#   ops-init.sh                 the full set-up above
#   ops-init.sh --render-only   steps 2 to 4 only, without PostgreSQL and without changing
#                               owners (tests: render the example configuration)
set -eu

PROG=ops-init
SECRETS=${MSCD_OPS_SECRETS:-/run/ops-secrets}
OUT=${MSCD_OPS_OUT:-/ops}
TEMPLATE=${MSCD_OPS_TEMPLATE:-/ops-config/alertmanager/alertmanager.yml.tmpl}
SMTP_PASSWORD_FILE=${MSCD_OPS_SMTP_PASSWORD_FILE:-/run/secrets/smtp.password}
PG_HOST=${MSCD_OPS_PG_HOST:-postgres}
PG_PORT=${MSCD_OPS_PG_PORT:-5432}
PG_DB=${MSCD_OPS_PG_DB:-mscd}
PG_ADMIN=${MSCD_OPS_PG_ADMIN_USER:-postgres}
PG_ADMIN_PASSWORD_FILE=${MSCD_OPS_PG_ADMIN_PASSWORD_FILE:-/run/secrets/postgres-admin.password}
# User ids of the images that read the files: Prometheus, Alertmanager and postgres-exporter
# run as nobody; Caddy runs as root.
NOBODY=65534
MONITOR_ROLE=mscd_monitor

RENDER_ONLY=false
case "${1:-}" in
    '') ;;
    --render-only) RENDER_ONLY=true ;;
    -h | --help) sed -n '2,/^set -eu$/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "$PROG: unknown option $1 (use --render-only or --help)" >&2; exit 2 ;;
esac

NL='
'
FAILED=0

log() { printf '%s: %s\n' "$PROG" "$*"; }
warn() { printf '%s: WARNING: %s\n' "$PROG" "$*" >&2; }
error() { printf '%s: ERROR: %s\n' "$PROG" "$*" >&2; FAILED=1; }
die() { printf '%s: ERROR: %s\n' "$PROG" "$*" >&2; exit 1; }

# matches VALUE ERE: true when VALUE matches the extended regular expression.
matches() {
    printf '%s' "$1" | LC_ALL=C grep -Eq -- "$2"
}

# clean_into VAR LABEL VALUE: sets VAR to VALUE without a final line break or CR. A value
# with a line break or a control character is refused (VAR stays empty).
clean_into() {
    _v=$(printf '%s' "$3" | tr -d '\r')
    eval "$1=''"
    case "$_v" in
        *"$NL"*) error "$2 must be one line"; return 0 ;;
    esac
    if printf '%s' "$_v" | LC_ALL=C grep -q '[[:cntrl:]]'; then
        error "$2 contains control characters"
        return 0
    fi
    eval "$1=\$_v"
}

# setting_into VAR NAME: sets VAR to the value of the file NAME of the ops secrets folder,
# empty when the file is absent.
setting_into() {
    eval "$1=''"
    _f=$SECRETS/$2
    [ -f "$_f" ] || return 0
    if [ ! -r "$_f" ]; then
        error "$_f is not readable"
        return 0
    fi
    clean_into "$1" "$2" "$(cat -- "$_f")"
}

# yaml_quote VALUE: VALUE as a double-quoted YAML string.
yaml_quote() {
    printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
}

# write_file PATH MODE OWNER CONTENT: writes atomically (OWNER is ignored with --render-only).
write_file() {
    _tmp=$(mktemp "$(dirname -- "$1")/.ops-init.XXXXXX")
    printf '%s' "$4" >"$_tmp"
    if [ "$RENDER_ONLY" = false ]; then chown "$3:$3" "$_tmp"; fi
    chmod "$2" "$_tmp"
    mv -f -- "$_tmp" "$1"
}

# folder PATH MODE OWNER
folder() {
    mkdir -p -- "$1"
    if [ "$RENDER_ONLY" = false ]; then chown "$3:$3" "$1"; fi
    chmod "$2" "$1"
}

host_ok() { matches "$1" '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$'; }
https_ok() { matches "$1" '^https://[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?(/[A-Za-z0-9._~%/-]*)?$'; }

# ---------------------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------------------

# Set by clean_into and setting_into below.
DOMAIN='' PUBLIC_URL='' PROBE_URL='' SMTP_HOST='' SMTP_PORT='' SMTP_USER='' MAIL_FROM=''
EMAIL_TO='' HEARTBEAT_URL='' TELEGRAM_TOKEN='' TELEGRAM_CHAT='' OPS_HOST='' OPS_USER='' OPS_HASH=''
clean_into DOMAIN MSCD_DOMAIN "${MSCD_DOMAIN:-}"
clean_into PUBLIC_URL MSCD_PUBLIC_URL "${MSCD_PUBLIC_URL:-}"
PUBLIC_URL=${PUBLIC_URL%/}
clean_into PROBE_URL MSCD_OPS_PROBE_URL "${MSCD_OPS_PROBE_URL:-}"
[ -n "$PROBE_URL" ] || PROBE_URL=$PUBLIC_URL/healthz
clean_into SMTP_HOST MSCD_OPS_SMTP_HOST "${MSCD_OPS_SMTP_HOST:-}"
clean_into SMTP_PORT MSCD_OPS_SMTP_PORT "${MSCD_OPS_SMTP_PORT:-587}"
clean_into SMTP_USER MSCD_OPS_SMTP_USER "${MSCD_OPS_SMTP_USER:-}"
clean_into MAIL_FROM MSCD_OPS_MAIL_FROM "${MSCD_OPS_MAIL_FROM:-}"
REQUIRE_TLS=${MSCD_OPS_SMTP_REQUIRE_TLS:-true}

setting_into EMAIL_TO ALERT_EMAIL_TO
setting_into HEARTBEAT_URL HEARTBEAT_WATCHDOG_URL
setting_into TELEGRAM_TOKEN TELEGRAM_BOT_TOKEN
setting_into TELEGRAM_CHAT TELEGRAM_CHAT_ID
setting_into OPS_HOST OPS_DOMAIN
setting_into OPS_USER OPS_BASIC_AUTH_USER
setting_into OPS_HASH OPS_BASIC_AUTH_HASH
[ -n "$OPS_USER" ] || OPS_USER=ops

host_ok "$DOMAIN" || error "MSCD_DOMAIN must be a host name such as app.example.com, got '$DOMAIN'"
https_ok "$PUBLIC_URL" || error "MSCD_PUBLIC_URL must be an https:// address, got '$PUBLIC_URL'"
https_ok "$PROBE_URL" || error "MSCD_OPS_PROBE_URL must be an https:// address, got '$PROBE_URL'"
host_ok "$(printf '%s' "$SMTP_HOST" | tr '[:upper:]' '[:lower:]')" ||
    error "The mail relay of the alerts (MSCD_SMTP_HOST or MSCD_OPS_SMTP_HOST) must be a host name, got '$SMTP_HOST'"
if ! matches "$SMTP_PORT" '^[0-9]{1,5}$' || [ "$SMTP_PORT" -lt 1 ] || [ "$SMTP_PORT" -gt 65535 ]; then
    error "The mail port (MSCD_SMTP_PORT or MSCD_OPS_SMTP_PORT) must be a port number, got '$SMTP_PORT'"
fi
matches "$MAIL_FROM" '@' || error "The sender of the alerts (MSCD_MAIL_FROM or MSCD_OPS_MAIL_FROM) must hold an email address, got '$MAIL_FROM'"
case "$REQUIRE_TLS" in
    true | false) ;;
    *) error "MSCD_OPS_SMTP_REQUIRE_TLS must be true or false, got '$REQUIRE_TLS'" ;;
esac
if [ -z "$EMAIL_TO" ]; then
    error "$SECRETS/ALERT_EMAIL_TO is missing or empty: alerts would reach nobody. Set the variable ALERT_EMAIL_TO of the GitHub environment and deploy again (docs/saas/monitoring.md)"
elif ! matches "$EMAIL_TO" '^[^ ,<>"]+@[^ ,<>"]+( *, *[^ ,<>"]+@[^ ,<>"]+)*$'; then
    error "ALERT_EMAIL_TO must be an email address or a comma-separated list of addresses"
fi
if [ -n "$HEARTBEAT_URL" ]; then
    matches "$HEARTBEAT_URL" '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~%/?&=+-]*)?$' ||
        error "HEARTBEAT_WATCHDOG_URL must be an http:// or https:// address without spaces or quotes"
    case "$HEARTBEAT_URL" in
        http://*) warn "HEARTBEAT_WATCHDOG_URL uses http://, not https://" ;;
    esac
fi
if [ -n "$TELEGRAM_TOKEN" ] || [ -n "$TELEGRAM_CHAT" ]; then
    if [ -z "$TELEGRAM_TOKEN" ] || [ -z "$TELEGRAM_CHAT" ]; then
        error "Telegram needs both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID (or neither)"
    else
        matches "$TELEGRAM_TOKEN" '^[0-9]{1,20}:[A-Za-z0-9_-]{20,100}$' ||
            error "TELEGRAM_BOT_TOKEN does not look like a bot token (<number>:<letters and digits>)"
        matches "$TELEGRAM_CHAT" '^-?[0-9]{1,20}$' || error "TELEGRAM_CHAT_ID must be a number, got '$TELEGRAM_CHAT'"
    fi
fi
GRAFANA=false
if [ -n "$OPS_HOST" ] || [ -n "$OPS_HASH" ]; then
    if [ -z "$OPS_HOST" ] || [ -z "$OPS_HASH" ]; then
        error "The Grafana host needs both OPS_DOMAIN and OPS_BASIC_AUTH_HASH (or neither)"
    else
        GRAFANA=true
        host_ok "$OPS_HOST" || error "OPS_DOMAIN must be a host name such as ops.example.com, got '$OPS_HOST'"
        [ "$OPS_HOST" != "$DOMAIN" ] || error "OPS_DOMAIN must differ from MSCD_DOMAIN"
        matches "$OPS_USER" '^[A-Za-z0-9._-]{1,64}$' ||
            error "OPS_BASIC_AUTH_USER may hold only letters, digits, '.', '_' and '-' (at most 64)"
        # shellcheck disable=SC2016  # a regular expression, not a shell expansion
        matches "$OPS_HASH" '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$' ||
            error "OPS_BASIC_AUTH_HASH must be a bcrypt hash (caddy hash-password), never the password itself"
    fi
fi

SMTP_PASSWORD=''
SMTP_AUTH=false
if [ -n "$SMTP_USER" ]; then
    SMTP_AUTH=true
    if [ -r "$SMTP_PASSWORD_FILE" ]; then
        clean_into SMTP_PASSWORD smtp.password "$(cat -- "$SMTP_PASSWORD_FILE")"
    else
        error "The mail relay has a user name, but $SMTP_PASSWORD_FILE cannot be read"
    fi
    [ -n "$SMTP_PASSWORD" ] || warn "The mail relay has a user name, but smtp.password is empty"
fi

[ -f "$TEMPLATE" ] || error "The template $TEMPLATE is missing"
[ "$FAILED" -eq 0 ] || die "Nothing was changed; fix the settings above"

# ---------------------------------------------------------------------------------------
# 1. PostgreSQL role for postgres-exporter
# ---------------------------------------------------------------------------------------

monitor_role() {
    folder "$OUT/state" 0711 0
    pw_file=$OUT/state/monitor.password
    if [ ! -s "$pw_file" ]; then
        write_file "$pw_file" 0400 "$NOBODY" "$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')"
        log "New password for the role $MONITOR_ROLE"
    fi
    chown "$NOBODY:$NOBODY" "$pw_file"
    chmod 0400 "$pw_file"
    [ -r "$PG_ADMIN_PASSWORD_FILE" ] || die "$PG_ADMIN_PASSWORD_FILE cannot be read"
    tries=0
    until pg_isready -q -h "$PG_HOST" -p "$PG_PORT" -d "$PG_DB"; do
        tries=$((tries + 1))
        [ "$tries" -lt 60 ] || die "PostgreSQL at $PG_HOST:$PG_PORT did not answer within 120 seconds"
        sleep 2
    done
    # The role password reaches psql in the environment (never as an argument) and is quoted
    # by format(%L), so no value can change the statements.
    PGPASSWORD=$(cat -- "$PG_ADMIN_PASSWORD_FILE") PGOPTIONS='-c client_min_messages=warning' \
        MSCD_MONITOR_PASSWORD=$(cat -- "$pw_file") \
        psql -v ON_ERROR_STOP=1 -X -q -h "$PG_HOST" -p "$PG_PORT" -U "$PG_ADMIN" -d "$PG_DB" \
        -v role="$MONITOR_ROLE" <<'SQL'
\getenv pw MSCD_MONITOR_PASSWORD
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'role', :'pw')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'role') \gexec
SELECT format('ALTER ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT CONNECTION LIMIT 5 PASSWORD %L', :'role', :'pw') \gexec
SELECT format('GRANT pg_monitor TO %I', :'role') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'role') \gexec
SELECT format('ALTER ROLE %I SET default_transaction_read_only = on', :'role') \gexec
SELECT format('ALTER ROLE %I SET statement_timeout = %L', :'role', '15s') \gexec
SQL
    log "Role $MONITOR_ROLE ready (pg_monitor, read only)"
}

# ---------------------------------------------------------------------------------------
# 2. Probe target of Prometheus
# ---------------------------------------------------------------------------------------

probe_target() {
    folder "$OUT/prometheus" 0755 0
    write_file "$OUT/prometheus/probe-targets.yml" 0444 0 "# Rendered by ops-init (deploy/ops/ops-init.sh). Do not edit.
- targets:
    - $(yaml_quote "$PROBE_URL")
"
    log "HTTPS probe of $PROBE_URL"
}

# ---------------------------------------------------------------------------------------
# 3. Alertmanager
# ---------------------------------------------------------------------------------------

# render_template FLAGS: the template with the placeholders replaced (values in R_* variables)
# and the "#@<part>:" lines of the parts in FLAGS (space separated) kept.
render_template() {
    awk -v flags=" $1 " '
        function fill(s,    out, i, rest, j, name) {
            out = ""
            while ((i = index(s, "@")) > 0) {
                rest = substr(s, i + 1)
                j = index(rest, "@")
                if (j == 0) break
                name = substr(rest, 1, j - 1)
                if (name ~ /^[A-Z_]+$/ && (("R_" name) in ENVIRON)) {
                    out = out substr(s, 1, i - 1) ENVIRON["R_" name]
                    s = substr(rest, j + 1)
                } else {
                    out = out substr(s, 1, i)
                    s = rest
                }
            }
            return out s
        }
        # The comment block at the top of the template describes the template; the rendered
        # file gets its own first line instead.
        !body && ((/^#/ && !/^#@/) || /^$/) { next }
        { body = 1 }
        /^#@[a-z-]+:/ {
            part = substr($0, 3, index($0, ":") - 3)
            if (index(flags, " " part " ") == 0) next
            $0 = substr($0, index($0, ":") + 1)
        }
        { print fill($0) }
    ' "$TEMPLATE"
}

alertmanager_config() {
    folder "$OUT/alertmanager" 0755 0
    folder "$OUT/alertmanager/secrets" 0700 "$NOBODY"
    flags=''
    if [ "$SMTP_AUTH" = true ]; then
        flags="$flags smtp-auth"
        write_file "$OUT/alertmanager/secrets/smtp_password" 0400 "$NOBODY" "$SMTP_PASSWORD"
    else
        rm -f -- "$OUT/alertmanager/secrets/smtp_password"
    fi
    if [ -n "$TELEGRAM_TOKEN" ]; then
        flags="$flags telegram"
        write_file "$OUT/alertmanager/secrets/telegram_bot_token" 0400 "$NOBODY" "$TELEGRAM_TOKEN"
    else
        rm -f -- "$OUT/alertmanager/secrets/telegram_bot_token"
    fi
    if [ -n "$HEARTBEAT_URL" ]; then
        flags="$flags heartbeat"
        write_file "$OUT/alertmanager/secrets/heartbeat_watchdog_url" 0400 "$NOBODY" "$HEARTBEAT_URL"
    else
        rm -f -- "$OUT/alertmanager/secrets/heartbeat_watchdog_url"
        warn "HEARTBEAT_WATCHDOG_URL is not set: nobody notices when the whole server stops"
    fi
    config=$(
        export R_DOMAIN="$DOMAIN" R_SMTP_REQUIRE_TLS="$REQUIRE_TLS" R_TELEGRAM_CHAT_ID="$TELEGRAM_CHAT"
        R_SMTP_SMARTHOST=$(yaml_quote "$SMTP_HOST:$SMTP_PORT") && export R_SMTP_SMARTHOST
        R_SMTP_FROM=$(yaml_quote "$MAIL_FROM") && export R_SMTP_FROM
        R_SMTP_HELLO=$(yaml_quote "$DOMAIN") && export R_SMTP_HELLO
        R_SMTP_USERNAME=$(yaml_quote "$SMTP_USER") && export R_SMTP_USERNAME
        R_EMAIL_TO=$(yaml_quote "$EMAIL_TO") && export R_EMAIL_TO
        render_template "$flags"
    )
    write_file "$OUT/alertmanager/alertmanager.yml" 0444 0 "# Rendered by ops-init (deploy/ops/ops-init.sh) from deploy/ops/alertmanager/alertmanager.yml.tmpl.
# Do not edit: change the settings it is made from (docs/saas/monitoring.md).

$config
"
    recipients=$(printf '%s' "$EMAIL_TO" | tr ',' '\n' | grep -c '@')
    log "Alerts by email to $recipients address(es) through $SMTP_HOST:$SMTP_PORT; Telegram: $([ -n "$TELEGRAM_TOKEN" ] && echo on || echo off); watchdog heartbeat: $([ -n "$HEARTBEAT_URL" ] && echo on || echo off)"
}

# ---------------------------------------------------------------------------------------
# 4. Caddy site of the Grafana host
# ---------------------------------------------------------------------------------------

grafana_site() {
    folder "$OUT/caddy" 0755 0
    if [ "$GRAFANA" = true ]; then
        write_file "$OUT/caddy/grafana.caddy" 0400 0 "# Rendered by ops-init (deploy/ops/ops-init.sh) from OPS_DOMAIN, OPS_BASIC_AUTH_USER
# and OPS_BASIC_AUTH_HASH. Do not edit. The site itself is the snippet mscd_ops_grafana of
# conf.d/ops.caddy.
$OPS_HOST {
	import mscd_ops_grafana $OPS_USER $OPS_HASH
}
"
        log "Grafana host $OPS_HOST (basic auth user $OPS_USER); Caddy reads it at its next start"
    else
        rm -f -- "$OUT/caddy/grafana.caddy"
        log "Grafana host: off (OPS_DOMAIN and OPS_BASIC_AUTH_HASH not set)"
    fi
}

if [ "$RENDER_ONLY" = false ]; then
    monitor_role
fi
probe_target
alertmanager_config
grafana_site
log "Done"
