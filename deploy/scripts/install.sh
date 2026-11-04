#!/usr/bin/env bash
# MSCD on-premise installer (Docker Compose, build plan I.3).
#
# Run it from the extracted bundle directory:
#   sudo ./install.sh                      (asks a few questions)
#   sudo ./install.sh --yes --self-signed --org-slug acme --org-name "PT Acme"
#   sudo ./install.sh --yes --self-signed  (organisation "default", "Default organisation")
#
# It loads the images of the bundle, writes the settings (.env), creates the
# secrets that are missing (database passwords, the two key-encryption keys,
# the gateway token, the audit anchor key pair, an internal CA with the
# certificates of the storage gateway, api and worker), starts the stack (the
# database migrations run first), creates the organisation (its slug cannot be
# changed later, so a new slug is confirmed first) and invites the first
# administrator or prints how to do it. The Compose project name (COMPOSE_PROJECT_NAME,
# default mscd) is saved in .env, where upgrade.sh, uninstall.sh and Compose read it.
# So are the internal network range of the containers and the web container's address
# on it (MSCD_SUBNET, MSCD_WEB_ADDRESS): the range is checked against the Docker networks
# and routes of this host before anything is written, and when the default range
# 172.31.250.0/24 is taken, --yes takes the first free range up to 172.31.254.0/24.
#
# Safe to run again: existing settings and secrets are kept unless you pass new
# values. An installation of the web-only package (MSCD 1.0) is extended to the
# full platform with its settings and certificate kept.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/common.sh disable=SC1091  # followed with shellcheck -x
. "$SCRIPT_DIR/lib/common.sh"

# Organisation created by "install.sh --yes" on a new install without --org-slug.
readonly MSCD_DEFAULT_ORG_SLUG=default
readonly MSCD_DEFAULT_ORG_NAME="Default organisation"

usage() {
    cat <<'EOF'
Usage: sudo ./install.sh [options]

Installs the MSCD platform with Docker Compose from this offline bundle, or
changes the settings of an existing installation. Without options it asks a
few questions.

Options:
  --dir DIR                Install directory (default: /opt/mscd; use a directory
                           you own, such as ~/mscd, when running without sudo)
  --domain NAME            Host name users open in the browser (default: this host's name)
  --http-port PORT         HTTP port on this host (default: 80)
  --https-port PORT        HTTPS port on this host (default: 443)
  --bind-address IP        Host address to listen on (default: 0.0.0.0, all IPv4 addresses)
  --self-signed            Generate a self-signed certificate (default for a new install)
  --tls-cert FILE          Your certificate, PEM format, full chain
  --tls-key FILE           The private key for --tls-cert, PEM format, no passphrase
  --http-redirect on|off   Redirect HTTP to HTTPS (default: on)
  --hsts on|off            Send Strict-Transport-Security (default: off; needs a trusted certificate)
  --external-fonts on|off  Allow the optional Google Fonts (default: off)
  --subnet CIDR            Internal network range of the containers: a private IPv4 range of
                           /24 or larger that nothing on this host uses, such as 172.31.252.0/24
                           (default: 172.31.250.0/24; when that range is in use, --yes takes the
                           first free one up to 172.31.254.0/24 and the installer otherwise asks).
                           Without it, an existing installation keeps its range
  --web-address IP         Fixed address of the web container in that range; the api trusts the
                           client address only from it (default: the tenth address of the range,
                           such as 172.31.252.10)
  --org-slug SLUG          Short name of your organisation: a lower-case letter, then 2 to 40
                           lower-case letters, digits or _ (it cannot change once created).
                           Asked; with --yes on a new install the default is "default"
  --org-name NAME          Display name of your organisation (it can change later in the app).
                           Asked; with --yes and no --org-slug the default is "Default organisation"
  --admin-email EMAIL      Invite this person as the first administrator: the invitation is
                           emailed, or its one-time link printed when email does not work
                           (default: print the command to do it)
  --smtp-host HOST         SMTP relay for outgoing email (default: smtp)
  --smtp-port PORT         SMTP port (default: 25)
  --smtp-user USER         SMTP login, when the relay needs one
  --smtp-password-file FILE
                           File whose first line is the SMTP password
  --mail-from ADDRESS      Sender of MSCD email, such as "MSCD <mscd@example.co.id>"
  --verify-key FILE        Public key for the bundle signature
                           (default: mscd-release.pub next to the bundle directory)
  --skip-signature-check   Install a signed bundle without checking its signature (not recommended)
  --timeout SECONDS        How long to wait for the services to become healthy (default: 600)
  -y, --yes                Ask no questions; use flags, saved settings, then defaults.
                           Required when there is no terminal.
  -h, --help               Show this help

Environment:
  COMPOSE_PROJECT_NAME     Docker Compose project name of a new installation (default: mscd).
                           install.sh saves it in .env; upgrade.sh and uninstall.sh read it
                           there, so it is not needed again. A value that differs from the
                           saved one stops the scripts before anything changes.
  MSCD_SUBNET, MSCD_WEB_ADDRESS
                           Docker Compose takes these before .env. When set, they must agree with
                           --subnet and --web-address and with the values saved in .env;
                           otherwise the installer stops before anything changes.
EOF
}

# Values from flags (empty means "not given").
OPT_DIR='' OPT_DOMAIN='' OPT_HTTP_PORT='' OPT_HTTPS_PORT='' OPT_BIND=''
OPT_SELF_SIGNED=false OPT_TLS_CERT='' OPT_TLS_KEY=''
OPT_REDIRECT='' OPT_HSTS='' OPT_FONTS='' VERIFY_KEY='' SKIP_SIGNATURE=false TIMEOUT=600
OPT_ORG_SLUG='' OPT_ORG_NAME='' OPT_ADMIN_EMAIL=''
OPT_SMTP_HOST='' OPT_SMTP_PORT='' OPT_SMTP_USER='' OPT_SMTP_PASSWORD_FILE='' OPT_MAIL_FROM=''
OPT_SUBNET='' OPT_WEB_ADDRESS=''
# Set by resolve_network: the rule for a new range that the kept range of the installation breaks.
KEPT_RULE=''

need_value() {
    if [[ $# -lt 2 || -z $2 || $2 == --* ]]; then
        die "Option $1 needs a value. See ./install.sh --help"
    fi
}

# Answer checks, also called by name from ask().
valid_slug() { [[ $1 =~ ^[a-z][a-z0-9_]{1,39}$ ]]; }
# A value written to .env: no quotes, $, backslash, backquote or # (Compose
# would read them as syntax), no line breaks, 1 to 200 characters.
env_safe() { ((${#1} >= 1 && ${#1} <= 200)) && [[ $1 != *[\"\'\$\\\`#$'\n\r']* ]]; }
valid_email() { [[ $1 =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; }

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dir) need_value "$@"; OPT_DIR=$2; shift 2 ;;
            --domain) need_value "$@"; OPT_DOMAIN=$2; shift 2 ;;
            --http-port) need_value "$@"; OPT_HTTP_PORT=$2; shift 2 ;;
            --https-port) need_value "$@"; OPT_HTTPS_PORT=$2; shift 2 ;;
            --bind-address) need_value "$@"; OPT_BIND=$2; shift 2 ;;
            --self-signed) OPT_SELF_SIGNED=true; shift ;;
            --tls-cert) need_value "$@"; OPT_TLS_CERT=$2; shift 2 ;;
            --tls-key) need_value "$@"; OPT_TLS_KEY=$2; shift 2 ;;
            --http-redirect) need_value "$@"; OPT_REDIRECT=$(to_bool "$2") || die "--http-redirect takes on or off"; shift 2 ;;
            --hsts) need_value "$@"; OPT_HSTS=$(to_bool "$2") || die "--hsts takes on or off"; shift 2 ;;
            --external-fonts) need_value "$@"; OPT_FONTS=$(to_bool "$2") || die "--external-fonts takes on or off"; shift 2 ;;
            --subnet) need_value "$@"; OPT_SUBNET=$2; shift 2 ;;
            --web-address) need_value "$@"; OPT_WEB_ADDRESS=$2; shift 2 ;;
            --org-slug) need_value "$@"; OPT_ORG_SLUG=$2; shift 2 ;;
            --org-name) need_value "$@"; OPT_ORG_NAME=$2; shift 2 ;;
            --admin-email) need_value "$@"; OPT_ADMIN_EMAIL=$2; shift 2 ;;
            --smtp-host) need_value "$@"; OPT_SMTP_HOST=$2; shift 2 ;;
            --smtp-port) need_value "$@"; OPT_SMTP_PORT=$2; shift 2 ;;
            --smtp-user) need_value "$@"; OPT_SMTP_USER=$2; shift 2 ;;
            --smtp-password-file) need_value "$@"; OPT_SMTP_PASSWORD_FILE=$2; shift 2 ;;
            --mail-from) need_value "$@"; OPT_MAIL_FROM=$2; shift 2 ;;
            --verify-key) need_value "$@"; VERIFY_KEY=$2; shift 2 ;;
            --skip-signature-check) SKIP_SIGNATURE=true; shift ;;
            --timeout) need_value "$@"; TIMEOUT=$2; shift 2 ;;
            -y | --yes) ASSUME_YES=true; shift ;;
            -h | --help) usage; exit 0 ;;
            *) die "Unknown option: $1. See ./install.sh --help" ;;
        esac
    done

    if [[ -n $OPT_TLS_CERT || -n $OPT_TLS_KEY ]]; then
        [[ -n $OPT_TLS_CERT && -n $OPT_TLS_KEY ]] || die "--tls-cert and --tls-key must be given together"
        [[ $OPT_SELF_SIGNED == false ]] || die "Choose either --self-signed or --tls-cert/--tls-key"
        OPT_TLS_CERT=$(absolute_path "$OPT_TLS_CERT")
        OPT_TLS_KEY=$(absolute_path "$OPT_TLS_KEY")
    fi
    [[ $TIMEOUT =~ ^[0-9]+$ ]] || die "--timeout takes a number of seconds"
    if [[ -n $VERIFY_KEY ]]; then VERIFY_KEY=$(absolute_path "$VERIFY_KEY"); fi
    if [[ -n $OPT_ORG_SLUG ]] && ! valid_slug "$OPT_ORG_SLUG"; then
        die "--org-slug '$OPT_ORG_SLUG' is not valid: use a lower-case letter, then 2 to 40 lower-case letters, digits or _"
    fi
    if [[ -n $OPT_ORG_NAME ]] && ! env_safe "$OPT_ORG_NAME"; then
        die "--org-name must have 1 to 200 characters, without quotes, \$, backslash, backquote or #"
    fi
    if [[ -n $OPT_ADMIN_EMAIL ]] && ! valid_email "$OPT_ADMIN_EMAIL"; then
        die "--admin-email '$OPT_ADMIN_EMAIL' is not an email address"
    fi
    if [[ -n $OPT_SMTP_HOST ]] && ! valid_host "$OPT_SMTP_HOST"; then
        die "--smtp-host '$OPT_SMTP_HOST' is not a host name or IPv4 address"
    fi
    if [[ -n $OPT_SMTP_PORT ]] && ! valid_port "$OPT_SMTP_PORT"; then
        die "--smtp-port '$OPT_SMTP_PORT' is not a valid port"
    fi
    if [[ -n $OPT_SMTP_USER ]] && { ! env_safe "$OPT_SMTP_USER" || [[ $OPT_SMTP_USER =~ [[:space:]] ]]; }; then
        die "--smtp-user cannot contain spaces, quotes, \$, backslash, backquote or #"
    fi
    if [[ -n $OPT_SMTP_PASSWORD_FILE ]]; then
        OPT_SMTP_PASSWORD_FILE=$(absolute_path "$OPT_SMTP_PASSWORD_FILE")
        [[ -f $OPT_SMTP_PASSWORD_FILE && -r $OPT_SMTP_PASSWORD_FILE ]] ||
            die "Cannot read --smtp-password-file $OPT_SMTP_PASSWORD_FILE"
    fi
    if [[ -n $OPT_MAIL_FROM ]] && ! env_safe "$OPT_MAIL_FROM"; then
        die "--mail-from cannot contain quotes, \$, backslash, backquote or #"
    fi
    local problem
    if [[ -n $OPT_SUBNET ]]; then
        problem=$(subnet_problem "$OPT_SUBNET")
        [[ -z $problem ]] || die "--subnet $OPT_SUBNET $problem"
    fi
    if [[ -n $OPT_WEB_ADDRESS ]] && ! ipv4_int "$OPT_WEB_ADDRESS" >/dev/null; then
        die "--web-address '$OPT_WEB_ADDRESS' is not an IPv4 address"
    fi
}

# ask PROMPT DEFAULT [CHECK ERROR]: prints the answer, or DEFAULT when empty.
# With CHECK, the question repeats until "CHECK answer" succeeds.
ask() {
    local prompt=$1 default=$2 check=${3:-} error=${4:-} answer
    if [[ -n $default ]]; then prompt+=" [$default]"; fi
    while true; do
        read -r -p "  $prompt: " answer </dev/tty || die "No answer was given."
        answer=${answer:-$default}
        if [[ -z $check ]] || "$check" "$answer"; then
            printf '%s\n' "$answer"
            return 0
        fi
        printf '  %s\n' "${error:-That answer is not valid.} Try again." >&2
    done
}

# Answer checks for ask(), which calls them by name.
# shellcheck disable=SC2329
https_port_ok() { valid_port "$1" && [[ $1 != "$HTTP_PORT" ]]; }
# shellcheck disable=SC2329
cert_choice_ok() { [[ $1 == 1 || $1 == 2 ]]; }
# shellcheck disable=SC2329
readable_file() { [[ -n $1 && -f $1 && -r $1 ]]; }
# shellcheck disable=SC2329
subnet_answer_ok() {
    local problem users
    problem=$(subnet_problem "$1")
    if [[ -n $problem ]]; then
        printf '  %s %s.\n' "${1:-An empty answer}" "$problem" >&2
        return 1
    fi
    users=$(subnet_users_text "$1")
    if [[ -n $users ]]; then
        printf '  %s is in use on this host: %s.\n' "$1" "$users" >&2
        return 1
    fi
}

# ---------------------------------------------------------------------------
# Settings: flag > saved .env value > question > default
# ---------------------------------------------------------------------------
resolve_settings() {
    local saved_version
    ENV_FILE=$INSTALL_DIR/.env
    WEB_ONLY=false
    if [[ -f $ENV_FILE ]]; then
        info "Existing installation found in $INSTALL_DIR; its settings are the defaults"
        if [[ ! -d $INSTALL_DIR/secrets ]]; then
            WEB_ONLY=true
        fi
        saved_version=$(kv_get "$ENV_FILE" MSCD_VERSION)
        if [[ -n $saved_version && $saved_version != "$BUNDLE_VERSION" ]]; then
            if version_ge "$saved_version" "$BUNDLE_VERSION"; then
                die "MSCD $saved_version is installed, which is newer than this bundle ($BUNDLE_VERSION). To go back, run: $INSTALL_DIR/upgrade.sh --rollback"
            fi
            if [[ $WEB_ONLY == true ]]; then
                info "MSCD $saved_version (web only) is installed; this adds the MSCD $BUNDLE_VERSION platform and keeps its settings and certificate"
            else
                die "MSCD $saved_version is installed. Use ./upgrade.sh from this bundle to move to $BUNDLE_VERSION with automatic rollback."
            fi
        fi
    fi

    local default_domain
    default_domain=$(kv_get "$ENV_FILE" MSCD_DOMAIN)
    if [[ -z $default_domain ]]; then
        default_domain=$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo localhost)
        default_domain=${default_domain%.}
    fi
    DOMAIN=${OPT_DOMAIN:-}
    HTTP_PORT=${OPT_HTTP_PORT:-$(kv_get "$ENV_FILE" MSCD_HTTP_PORT)}
    HTTPS_PORT=${OPT_HTTPS_PORT:-$(kv_get "$ENV_FILE" MSCD_HTTPS_PORT)}
    BIND=${OPT_BIND:-$(kv_get "$ENV_FILE" MSCD_BIND_ADDRESS)}
    REDIRECT=${OPT_REDIRECT:-$(kv_get "$ENV_FILE" MSCD_HTTP_REDIRECT)}
    HSTS=${OPT_HSTS:-$(kv_get "$ENV_FILE" MSCD_HSTS)}
    FONTS=${OPT_FONTS:-$(kv_get "$ENV_FILE" MSCD_EXTERNAL_FONTS)}
    SMTP_HOST=${OPT_SMTP_HOST:-$(kv_get "$ENV_FILE" MSCD_SMTP_HOST)}
    SMTP_PORT=${OPT_SMTP_PORT:-$(kv_get "$ENV_FILE" MSCD_SMTP_PORT)}
    SMTP_USER=${OPT_SMTP_USER:-$(kv_get "$ENV_FILE" MSCD_SMTP_USER)}
    MAIL_FROM=${OPT_MAIL_FROM:-$(kv_get "$ENV_FILE" MSCD_MAIL_FROM)}

    SAVED_ORG_SLUG=$(kv_get "$ENV_FILE" MSCD_ORG_SLUG)
    ORG_SLUG=${OPT_ORG_SLUG:-$SAVED_ORG_SLUG}
    ORG_NAME=${OPT_ORG_NAME:-$(kv_get "$ENV_FILE" MSCD_ORG_NAME)}
    if [[ -n $SAVED_ORG_SLUG && $ORG_SLUG != "$SAVED_ORG_SLUG" ]]; then
        die "The organisation of this installation is $SAVED_ORG_SLUG; its slug cannot change (--org-slug $ORG_SLUG)"
    fi
    # --yes on a new install without --org-slug: the default organisation. Without
    # --yes the installer asks for the slug and the name instead.
    DEFAULT_ORG=false
    if [[ -z $ORG_SLUG && $ASSUME_YES == true ]]; then
        ORG_SLUG=$MSCD_DEFAULT_ORG_SLUG
        ORG_NAME=${ORG_NAME:-$MSCD_DEFAULT_ORG_NAME}
        DEFAULT_ORG=true
    fi

    local have_cert=false
    SAVED_TLS_MODE=$(kv_get "$ENV_FILE" MSCD_TLS_MODE)
    [[ -f $INSTALL_DIR/tls/tls.crt && -f $INSTALL_DIR/tls/tls.key ]] && have_cert=true
    if [[ -n $OPT_TLS_CERT ]]; then
        TLS_MODE=provided
    elif [[ $OPT_SELF_SIGNED == true ]]; then
        TLS_MODE=self-signed
    elif [[ $have_cert == true && -n $SAVED_TLS_MODE ]]; then
        TLS_MODE=$SAVED_TLS_MODE
    else
        TLS_MODE=''
    fi

    if [[ $INTERACTIVE == true ]]; then
        echo "  Press Enter to accept the value in brackets."
        [[ -n $DOMAIN ]] || DOMAIN=$(ask "Host name users will open" "$default_domain" valid_host \
            "Use a host name such as mscd.example.co.id, or an IPv4 address.")
        [[ -n $HTTP_PORT ]] || HTTP_PORT=$(ask "HTTP port" 80 valid_port "Use a port number from 1 to 65535.")
        [[ -n $HTTPS_PORT ]] || HTTPS_PORT=$(ask "HTTPS port" 443 https_port_ok \
            "Use a port number from 1 to 65535, different from the HTTP port.")
        if [[ -z $TLS_MODE ]]; then
            echo "  TLS certificate:"
            echo "    1) Generate a self-signed certificate (good for a pilot; browsers will warn)"
            echo "    2) Use certificate and key files from your certificate authority"
            if [[ "$(ask "Choose 1 or 2" 1 cert_choice_ok "Answer 1 or 2.")" == 2 ]]; then
                local crt key
                TLS_MODE=provided
                crt=$(ask "Certificate file (PEM, full chain)" "" readable_file "Cannot read that file.")
                key=$(ask "Private key file (PEM)" "" readable_file "Cannot read that file.")
                OPT_TLS_CERT=$(absolute_path "$crt")
                OPT_TLS_KEY=$(absolute_path "$key")
            else
                TLS_MODE=self-signed
            fi
        fi
        [[ -n $ORG_SLUG ]] || ORG_SLUG=$(ask "Organisation short name (slug, for example acme)" "" valid_slug \
            "Use a lower-case letter, then 2 to 40 lower-case letters, digits or _.")
        [[ -n $ORG_NAME ]] || ORG_NAME=$(ask "Organisation name (for example PT Acme Indonesia)" "" env_safe \
            "Use 1 to 200 characters, without quotes, \$, backslash, backquote or #.")
    fi

    DOMAIN=${DOMAIN:-$default_domain}
    HTTP_PORT=${HTTP_PORT:-80}
    HTTPS_PORT=${HTTPS_PORT:-443}
    BIND=${BIND:-0.0.0.0}
    REDIRECT=${REDIRECT:-true}
    HSTS=${HSTS:-false}
    FONTS=${FONTS:-false}
    TLS_MODE=${TLS_MODE:-self-signed}
    SMTP_HOST=${SMTP_HOST:-smtp}
    SMTP_PORT=${SMTP_PORT:-25}
    MAIL_FROM=${MAIL_FROM:-MSCD <mscd@$DOMAIN>}
    IMAGE=$BUNDLE_IMAGE:$BUNDLE_VERSION
    SERVER_IMAGE=$BUNDLE_SERVER_IMAGE:$BUNDLE_VERSION
    if [[ $HTTPS_PORT == 443 ]]; then
        PUBLIC_URL=https://$DOMAIN
    else
        PUBLIC_URL=https://$DOMAIN:$HTTPS_PORT
    fi

    valid_host "$DOMAIN" || die "Host name '$DOMAIN' is not valid. Use --domain, for example --domain mscd.example.co.id"
    valid_port "$HTTP_PORT" || die "HTTP port '$HTTP_PORT' is not a valid port"
    valid_port "$HTTPS_PORT" || die "HTTPS port '$HTTPS_PORT' is not a valid port"
    [[ $HTTP_PORT != "$HTTPS_PORT" ]] || die "HTTP and HTTPS need different ports"
    is_ipv4 "$BIND" || die "Bind address '$BIND' must be an IPv4 address such as 0.0.0.0"
    [[ -n $ORG_SLUG ]] || die "Name your organisation with --org-slug (for example --org-slug acme) and --org-name"
    valid_slug "$ORG_SLUG" || die "The organisation slug '$ORG_SLUG' is not valid"
    [[ -n $ORG_NAME ]] || die "Give the display name of your organisation with --org-name (for example --org-name \"PT Acme Indonesia\")"
    env_safe "$ORG_NAME" || die "The organisation name '$ORG_NAME' cannot be written to .env"
    env_safe "$MAIL_FROM" || die "The sender address '$MAIL_FROM' cannot be written to .env"
    if [[ -n $SMTP_USER && -z $OPT_SMTP_PASSWORD_FILE && ! -f $INSTALL_DIR/secrets/smtp.password ]]; then
        die "--smtp-user needs --smtp-password-file"
    fi
    if [[ $TLS_MODE == self-signed && $HSTS == true ]]; then
        warn "HSTS is turned off: browsers would lock users out of a site with a self-signed certificate"
        HSTS=false
    fi
    resolve_network
}

# resolve_network: the internal network of the containers. The range is --subnet, else
# MSCD_SUBNET of the environment, else the range saved in .env, else the default
# 172.31.250.0/24. When the default is in use on this host, --yes takes the first free
# range of MSCD_SUBNET_CHOICES and a terminal asks. The web address is --web-address,
# else MSCD_WEB_ADDRESS of the environment, else the saved one while it lies inside the
# range, else the tenth address of the range. Compose takes the environment before .env,
# so a value there must agree with the flag and with the saved value. Sets SUBNET,
# SUBNET_SOURCE, WEB_ADDRESS, WEB_SOURCE and NET_SUBNET (the range of this installation's
# network when it exists; the checks of the settings do not count it as taken).
resolve_network() {
    local saved_subnet saved_web problem users free
    saved_subnet=$(kv_get "$ENV_FILE" MSCD_SUBNET)
    saved_web=$(kv_get "$ENV_FILE" MSCD_WEB_ADDRESS)
    NET_SUBNET=$(project_network_subnet)

    if [[ -n $MSCD_ENV_SUBNET ]]; then
        if [[ -n $OPT_SUBNET && $OPT_SUBNET != "$MSCD_ENV_SUBNET" ]]; then
            die "MSCD_SUBNET is set to $MSCD_ENV_SUBNET in the environment, and Docker Compose would use it instead of --subnet $OPT_SUBNET. Unset MSCD_SUBNET and run ./install.sh again."
        fi
        if [[ -z $OPT_SUBNET && -n $saved_subnet && $saved_subnet != "$MSCD_ENV_SUBNET" ]]; then
            if [[ $NET_SUBNET == "$MSCD_ENV_SUBNET" ]]; then
                die "The internal network of the installation in $INSTALL_DIR uses $NET_SUBNET, as MSCD_SUBNET in the environment says, but $ENV_FILE saves $saved_subnet. Add --subnet $NET_SUBNET to save that range in .env, or unset MSCD_SUBNET to move the installation to $saved_subnet."
            fi
            die "The installation in $INSTALL_DIR uses the internal range $saved_subnet (MSCD_SUBNET in $ENV_FILE), but MSCD_SUBNET is set to $MSCD_ENV_SUBNET in the environment. Unset MSCD_SUBNET to keep $saved_subnet, or add --subnet $MSCD_ENV_SUBNET to move the installation to that range."
        fi
    fi
    if [[ -n $MSCD_ENV_WEB_ADDRESS ]]; then
        if [[ -n $OPT_WEB_ADDRESS && $OPT_WEB_ADDRESS != "$MSCD_ENV_WEB_ADDRESS" ]]; then
            die "MSCD_WEB_ADDRESS is set to $MSCD_ENV_WEB_ADDRESS in the environment, and Docker Compose would use it instead of --web-address $OPT_WEB_ADDRESS. Unset MSCD_WEB_ADDRESS and run ./install.sh again."
        fi
        if [[ -z $OPT_WEB_ADDRESS && -n $saved_web && $saved_web != "$MSCD_ENV_WEB_ADDRESS" ]]; then
            die "The installation in $INSTALL_DIR gives the web container the address $saved_web (MSCD_WEB_ADDRESS in $ENV_FILE), but MSCD_WEB_ADDRESS is set to $MSCD_ENV_WEB_ADDRESS in the environment. Unset MSCD_WEB_ADDRESS to keep $saved_web, or add --web-address $MSCD_ENV_WEB_ADDRESS."
        fi
    fi

    if [[ -n $OPT_SUBNET ]]; then
        SUBNET=$OPT_SUBNET SUBNET_SOURCE="from --subnet"
    elif [[ -n $MSCD_ENV_SUBNET ]]; then
        SUBNET=$MSCD_ENV_SUBNET SUBNET_SOURCE="from MSCD_SUBNET in the environment"
    elif [[ -n $saved_subnet && ($saved_subnet != "$MSCD_DEFAULT_SUBNET" || -n $NET_SUBNET) ]]; then
        SUBNET=$saved_subnet SUBNET_SOURCE="saved in $ENV_FILE"
    elif [[ -z $saved_subnet && -n $NET_SUBNET ]]; then
        # An installation whose .env never held the range keeps the one its network has.
        SUBNET=$NET_SUBNET SUBNET_SOURCE="the range of this installation's network"
    else
        # The default, also when .env holds it but no network of this installation exists yet.
        SUBNET=$MSCD_DEFAULT_SUBNET SUBNET_SOURCE=default
    fi
    # A range this installation already has (its network's, or the saved one while it has no
    # network) only needs the form of a range: installations made before this check, with
    # MSCD_SUBNET written into .env by hand, keep working. The rule for a new range (private,
    # /24 or larger) then gives a warning in check_network. --subnet was checked already.
    KEPT_RULE=''
    if [[ $SUBNET == "$NET_SUBNET" || (-z $NET_SUBNET && -n $saved_subnet && $SUBNET == "$saved_subnet") ]]; then
        problem=$(subnet_form_problem "$SUBNET")
        if [[ -z $problem ]]; then KEPT_RULE=$(subnet_rule_problem "$SUBNET"); fi
    else
        problem=$(subnet_problem "$SUBNET")
    fi
    if [[ -n $problem ]]; then
        free=$(suggest_subnet)
        free=${free:-10.250.0.0/24}
        if [[ $SUBNET_SOURCE == *environment* ]]; then
            die "The internal range $SUBNET ($SUBNET_SOURCE) $problem. Unset MSCD_SUBNET, or set it to a private range of /24 or larger such as $free"
        fi
        die "The internal range $SUBNET ($SUBNET_SOURCE) $problem. Run ./install.sh again with --subnet and a free private range of /24 or larger, such as --subnet $free"
    fi

    if [[ $SUBNET_SOURCE == default ]]; then
        users=$(subnet_users_text "$SUBNET")
        if [[ -n $users ]]; then
            free=$(first_free_subnet)
            if [[ $INTERACTIVE == true ]]; then
                printf '  The default internal range %s of the containers is in use on this host:\n' "$SUBNET"
                printf '  %s.\n' "$users"
                SUBNET=$(ask "Internal range for the containers (private, /24 or larger)" "$free" subnet_answer_ok \
                    "Use a free private range of /24 or larger, such as ${free:-10.250.0.0/24}.")
                SUBNET_SOURCE="your answer"
            elif [[ -n $free ]]; then
                info "The default internal range $SUBNET is in use on this host: $users"
                detail "MSCD takes $free, the first free range from ${MSCD_SUBNET_CHOICES[0]} to ${MSCD_SUBNET_CHOICES[-1]} (saved in .env)."
                SUBNET=$free SUBNET_SOURCE="chosen, the default is in use"
            fi
            # Without a free range, check_network stops the installer and names one to choose.
        fi
    fi

    if [[ -n $OPT_WEB_ADDRESS ]]; then
        WEB_ADDRESS=$OPT_WEB_ADDRESS WEB_SOURCE="from --web-address"
    elif [[ -n $MSCD_ENV_WEB_ADDRESS ]]; then
        WEB_ADDRESS=$MSCD_ENV_WEB_ADDRESS WEB_SOURCE="from MSCD_WEB_ADDRESS in the environment"
    elif [[ -n $saved_web && -z $(web_address_problem "$saved_web" "$SUBNET") ]]; then
        WEB_ADDRESS=$saved_web WEB_SOURCE="saved in $ENV_FILE"
    else
        WEB_ADDRESS=$(default_web_address "$SUBNET") WEB_SOURCE=default
    fi
    problem=$(web_address_problem "$WEB_ADDRESS" "$SUBNET")
    if [[ -n $problem && $WEB_SOURCE == *environment* ]]; then
        die "The web address $WEB_ADDRESS ($WEB_SOURCE) $problem. Unset MSCD_WEB_ADDRESS for the tenth address of the range ($(default_web_address "$SUBNET")), or set it to another address inside $SUBNET"
    elif [[ -n $problem ]]; then
        die "The web address $WEB_ADDRESS ($WEB_SOURCE) $problem. Leave --web-address out for the tenth address of the range ($(default_web_address "$SUBNET")), or give another address inside $SUBNET"
    fi
}

show_settings() {
    local redirect_text="serves the app" smtp
    if [[ $INTERACTIVE == true ]]; then echo; fi
    [[ $REDIRECT == true ]] && redirect_text="redirects to HTTPS"
    smtp="$SMTP_HOST:$SMTP_PORT${SMTP_USER:+ as $SMTP_USER}, from $MAIL_FROM"
    printf '  %-20s %s\n' \
        "Install directory" "$INSTALL_DIR" \
        "Compose project" "$MSCD_PROJECT" \
        "Version" "$BUNDLE_VERSION ($IMAGE, $SERVER_IMAGE)" \
        "Organisation" "$ORG_NAME ($ORG_SLUG)" \
        "Host name" "$DOMAIN" \
        "Listen address" "$BIND" \
        "HTTP port" "$HTTP_PORT ($redirect_text)" \
        "HTTPS port" "$HTTPS_PORT" \
        "Certificate" "$TLS_MODE${OPT_TLS_CERT:+ ($OPT_TLS_CERT)}" \
        "HSTS" "$HSTS" \
        "External fonts" "$FONTS" \
        "Internal network" "$SUBNET, web container $WEB_ADDRESS" \
        "Email" "$smtp"
}

check_settings() {
    check_port "$HTTP_PORT" HTTP --http-port
    check_port "$HTTPS_PORT" HTTPS --https-port
    check_network
    if [[ $TLS_MODE == provided && -n $OPT_TLS_CERT ]]; then
        validate_cert_pair "$OPT_TLS_CERT" "$OPT_TLS_KEY" "$DOMAIN"
    elif [[ $TLS_MODE == provided ]]; then
        if [[ ! -f $INSTALL_DIR/tls/tls.crt ]]; then
            fail "No certificate installed" "Pass --tls-cert and --tls-key, or --self-signed"
        elif ! is_pem_cert "$INSTALL_DIR/tls/tls.crt"; then
            fail "The installed certificate $INSTALL_DIR/tls/tls.crt is not in PEM format" \
                "Install a PEM certificate with --tls-cert and --tls-key"
        else
            pass "Keeping the installed certificate (valid until $(cert_end_date "$INSTALL_DIR/tls/tls.crt"))"
        fi
    fi
}

# check_network: nothing on this host (another Docker network, a route or an address of
# the host) uses the internal range, apart from this installation's own network.
check_network() {
    local users suggestion fix base size ip
    users=$(subnet_users_text "$SUBNET")
    if [[ -n $users && $NET_SUBNET == "$SUBNET" ]]; then
        # The installation runs on this range already; something on the host came later.
        warn "The internal range $SUBNET of this installation overlaps $users. This server cannot reach those addresses while MSCD runs; --subnet moves MSCD to another range"
    elif [[ -n $users ]]; then
        suggestion=$(suggest_subnet)
        fix="Choose a free private range of /24 or larger with --subnet"
        if [[ $SUBNET_SOURCE == *environment* ]]; then fix="Unset MSCD_SUBNET and choose a free private range of /24 or larger with --subnet"; fi
        if [[ -n $suggestion ]]; then fix+=", for example --subnet $suggestion"; fi
        fix+=" (the web address follows it unless --web-address is given)"
        if [[ $SUBNET_SOURCE == default ]]; then
            fail "The default internal range $SUBNET is in use on this host ($users), and so are the other ranges the installer tries, up to ${MSCD_SUBNET_CHOICES[-1]}" "$fix"
        else
            fail "The internal range $SUBNET ($SUBNET_SOURCE) is in use on this host: $users" "$fix"
        fi
        return 0
    elif [[ -n $NET_SUBNET && $NET_SUBNET != "$SUBNET" ]]; then
        pass "Internal range $SUBNET is free; the installation moves to it from $NET_SUBNET (its services stop and start again)"
    elif [[ -n $NET_SUBNET ]]; then
        pass "Internal range $SUBNET is the network of this installation"
    else
        pass "Internal range $SUBNET is free on this host"
    fi
    if [[ -n $KEPT_RULE ]]; then
        suggestion=$(suggest_subnet)
        warn "$(kept_subnet_note "$SUBNET" "$KEPT_RULE" "./install.sh --yes --dir $INSTALL_DIR --subnet ${suggestion:-<a free private range of /24 or larger>}")"
    fi
    read -r base size < <(cidr_range "$SUBNET")
    ip=$(ipv4_int "$WEB_ADDRESS")
    if ((ip - base < 10)); then
        warn "The web address $WEB_ADDRESS is among the first addresses of $SUBNET, which Docker gives the other containers; one from $(default_web_address "$SUBNET") up avoids a clash"
    fi
}

# check_bundle_files: the Compose files and configuration are in the bundle.
check_bundle_files() {
    local missing=() f
    for f in compose/docker-compose.yml compose/.env.example compose/config/postgres/10-mscd-bootstrap.sh \
        upgrade.sh uninstall.sh lib/common.sh VERSION; do
        [[ -f $SCRIPT_DIR/$f ]] || missing+=("$f")
    done
    if ((${#missing[@]} > 0)); then
        fail "The bundle is incomplete; missing: ${missing[*]}" "Extract the complete bundle again"
    else
        pass "Compose files and configuration are in the bundle"
    fi
}

# ---------------------------------------------------------------------------
# Install steps
# ---------------------------------------------------------------------------
prepare_dir() {
    install -d -m 0755 "$INSTALL_DIR" "$INSTALL_DIR/lib" "$INSTALL_DIR/tls" "$INSTALL_DIR/backups" \
        "$INSTALL_DIR/config"
    lock_dir "$INSTALL_DIR"
}

install_files() {
    install -m 0644 "$SCRIPT_DIR/compose/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml"
    install -m 0644 "$SCRIPT_DIR/compose/.env.example" "$INSTALL_DIR/.env.example"
    install_config "$SCRIPT_DIR/compose/config" "$INSTALL_DIR/config"
    install -m 0644 "$SCRIPT_DIR/lib/common.sh" "$INSTALL_DIR/lib/common.sh"
    install -m 0755 "$SCRIPT_DIR/upgrade.sh" "$SCRIPT_DIR/uninstall.sh" "$INSTALL_DIR/"
    install -m 0644 "$SCRIPT_DIR/VERSION" "$INSTALL_DIR/"
    if [[ -f $SCRIPT_DIR/INSTALL-ONPREM.md ]]; then
        install -m 0644 "$SCRIPT_DIR/INSTALL-ONPREM.md" "$INSTALL_DIR/"
    fi
    if [[ -f $SCRIPT_DIR/THIRD-PARTY-NOTICES.md ]]; then
        install -m 0644 "$SCRIPT_DIR/THIRD-PARTY-NOTICES.md" "$INSTALL_DIR/"
    fi
    printf 'MSCD on-premise install directory. Do not delete this file.\n' >"$INSTALL_DIR/$MSCD_MARKER"
    pass "Files copied to $INSTALL_DIR"
}

# snapshot_config: keeps the current settings until the new ones are running.
snapshot_config() {
    SNAPSHOT=$INSTALL_DIR/.install-backup
    rm -rf -- "$SNAPSHOT"
    if [[ -f $INSTALL_DIR/.env ]]; then
        install -d -m 0700 "$SNAPSHOT"
        cp -p "$INSTALL_DIR/.env" "$SNAPSHOT/.env"
        if [[ -f $INSTALL_DIR/docker-compose.yml ]]; then
            cp -p "$INSTALL_DIR/docker-compose.yml" "$SNAPSHOT/docker-compose.yml"
        fi
        if [[ -d $INSTALL_DIR/config ]]; then
            cp -pR "$INSTALL_DIR/config" "$SNAPSHOT/config"
        fi
    fi
}

write_env() {
    if [[ ! -f $ENV_FILE ]]; then
        install -m 0600 "$SCRIPT_DIR/compose/.env.example" "$ENV_FILE"
    else
        env_merge_defaults "$SCRIPT_DIR/compose/.env.example" "$ENV_FILE"
    fi
    env_set "$ENV_FILE" MSCD_VERSION "$BUNDLE_VERSION"
    env_set "$ENV_FILE" MSCD_IMAGE "$BUNDLE_IMAGE"
    env_set "$ENV_FILE" MSCD_SERVER_IMAGE "$BUNDLE_SERVER_IMAGE"
    env_set "$ENV_FILE" MSCD_DOMAIN "$DOMAIN"
    env_set "$ENV_FILE" MSCD_PUBLIC_URL "$PUBLIC_URL"
    env_set "$ENV_FILE" MSCD_BIND_ADDRESS "$BIND"
    env_set "$ENV_FILE" MSCD_HTTP_PORT "$HTTP_PORT"
    env_set "$ENV_FILE" MSCD_HTTPS_PORT "$HTTPS_PORT"
    env_set "$ENV_FILE" MSCD_TLS_MODE "$TLS_MODE"
    env_set "$ENV_FILE" MSCD_HTTP_REDIRECT "$REDIRECT"
    env_set "$ENV_FILE" MSCD_HSTS "$HSTS"
    env_set "$ENV_FILE" MSCD_EXTERNAL_FONTS "$FONTS"
    env_set "$ENV_FILE" MSCD_ORG_SLUG "$ORG_SLUG"
    env_set "$ENV_FILE" MSCD_ORG_NAME "$ORG_NAME"
    env_set "$ENV_FILE" MSCD_SMTP_HOST "$SMTP_HOST"
    env_set "$ENV_FILE" MSCD_SMTP_PORT "$SMTP_PORT"
    env_set "$ENV_FILE" MSCD_SMTP_USER "$SMTP_USER"
    if [[ -n $SMTP_USER ]]; then
        env_set "$ENV_FILE" MSCD_SMTP_PASSWORD_FILE /run/secrets/smtp.password
    else
        env_set "$ENV_FILE" MSCD_SMTP_PASSWORD_FILE ""
    fi
    env_set "$ENV_FILE" MSCD_MAIL_FROM "$MAIL_FROM"
    env_set "$ENV_FILE" MSCD_RUN_UID "$RUN_UID"
    env_set "$ENV_FILE" MSCD_RUN_GID "$RUN_GID"
    env_set "$ENV_FILE" MSCD_SUBNET "$SUBNET"
    env_set "$ENV_FILE" MSCD_WEB_ADDRESS "$WEB_ADDRESS"
    save_project "$ENV_FILE"
    pass "Settings saved to $ENV_FILE (Compose project $MSCD_PROJECT)"
}

# write_secrets: every secret that is missing, then owners and modes (I.3).
write_secrets() {
    local dir=$INSTALL_DIR/secrets
    install -d -m 0700 "$dir"
    if [[ -n $OPT_SMTP_PASSWORD_FILE ]]; then
        set_smtp_password "$dir" "$OPT_SMTP_PASSWORD_FILE"
        pass "SMTP password stored in $dir/smtp.password"
    fi
    if ! ensure_secrets "$dir" "$SERVER_IMAGE"; then
        rm -rf -- "$SNAPSHOT"
        abort_if_failed
        die "The secrets could not be created."
    fi
}

# prepare_tls: puts a new certificate and key (provided or self-signed) in
# tls.new and checks that NGINX loads them. The installed files are not touched.
prepare_tls() {
    local dir=$INSTALL_DIR/tls out
    TLS_STAGE=$INSTALL_DIR/tls.new
    TLS_CHANGED=false
    rm -rf -- "$TLS_STAGE"
    if [[ $TLS_MODE == provided && -n $OPT_TLS_CERT ]]; then
        if [[ -f $dir/tls.crt && -f $dir/tls.key ]] && cmp -s "$OPT_TLS_CERT" "$dir/tls.crt"; then
            pass "The installed certificate is the same as $OPT_TLS_CERT; kept"
            return 0
        fi
        install -d -m 0755 "$TLS_STAGE"
        install -m 0444 "$OPT_TLS_CERT" "$TLS_STAGE/tls.crt"
        install -m 0600 "$OPT_TLS_KEY" "$TLS_STAGE/tls.key"
    elif [[ $TLS_MODE == self-signed ]]; then
        if [[ $SAVED_TLS_MODE == self-signed && -f $dir/tls.key ]] &&
            self_signed_is_current "$dir/tls.crt" "$DOMAIN"; then
            pass "Keeping the self-signed certificate for $DOMAIN (valid until $(cert_end_date "$dir/tls.crt"))"
            return 0
        fi
        install -d -m 0755 "$TLS_STAGE"
        generate_self_signed "$TLS_STAGE/tls.crt" "$TLS_STAGE/tls.key" "$DOMAIN" ||
            die "openssl could not create the self-signed certificate"
        chmod 0444 "$TLS_STAGE/tls.crt"
        pass "Self-signed certificate created for $DOMAIN (valid until $(cert_end_date "$TLS_STAGE/tls.crt"))"
    else
        return 0
    fi

    set_key_owner "$TLS_STAGE/tls.key" "$IMAGE" "$RUN_UID" "$RUN_GID"
    if ! out=$(tls_config_test "$TLS_STAGE" "$IMAGE" "$RUN_UID" "$RUN_GID"); then
        printf '%s\n' "$out" | sed 's/^/        /'
        rm -rf -- "$TLS_STAGE" "$SNAPSHOT"
        fail "NGINX cannot load the new certificate and key" \
            "Check that both files are PEM and belong together, then run ./install.sh again"
        if [[ $PREVIOUS_STATE == missing ]]; then
            die "MSCD was not started."
        fi
        die "The certificate and settings were not changed; MSCD keeps its current configuration."
    fi
    pass "NGINX loads the new certificate and key (test run without network)"
    TLS_CHANGED=true
}

# activate_tls: moves the tested files in place. The previous pair is kept as
# tls.crt.bak and tls.key.bak.
activate_tls() {
    local dir=$INSTALL_DIR/tls
    if [[ $TLS_CHANGED == true ]]; then
        if [[ -f $dir/tls.crt && -f $dir/tls.key ]]; then
            mv -f "$dir/tls.crt" "$dir/tls.crt.bak"
            mv -f "$dir/tls.key" "$dir/tls.key.bak"
            TLS_BACKUP=true
        fi
        mv -f "$TLS_STAGE/tls.key" "$dir/tls.key"
        mv -f "$TLS_STAGE/tls.crt" "$dir/tls.crt"
        rmdir "$TLS_STAGE"
        if [[ $TLS_MODE == provided ]]; then pass "Certificate installed"; fi
    fi
    # The container user may have changed (for example after the mscd account was created).
    if [[ -f $dir/tls.key ]]; then
        set_key_owner "$dir/tls.key" "$IMAGE" "$RUN_UID" "$RUN_GID"
    fi
}

# restore_previous: puts back the settings and certificate that ran before this
# run, and starts that configuration again.
restore_previous() {
    local dir=$INSTALL_DIR/tls
    if [[ -f $SNAPSHOT/.env ]]; then
        cp -p "$SNAPSHOT/.env" "$INSTALL_DIR/.env"
        # Settings of an installation made before the project name was saved.
        save_project "$INSTALL_DIR/.env"
    fi
    if [[ -f $SNAPSHOT/docker-compose.yml ]]; then
        cp -p "$SNAPSHOT/docker-compose.yml" "$INSTALL_DIR/docker-compose.yml"
    fi
    if [[ -d $SNAPSHOT/config ]]; then
        rm -rf -- "$INSTALL_DIR/config"
        cp -pR "$SNAPSHOT/config" "$INSTALL_DIR/config"
    fi
    if [[ $TLS_BACKUP == true ]]; then
        mv -f "$dir/tls.crt.bak" "$dir/tls.crt"
        mv -f "$dir/tls.key.bak" "$dir/tls.key"
    fi
    # The previous settings may name the previous internal range.
    stop_for_network_change "$INSTALL_DIR" || true
    compose_in "$INSTALL_DIR" up -d --remove-orphans --force-recreate --wait --wait-timeout "$TIMEOUT"
}

start_stack() {
    local args=(up -d --remove-orphans --wait --wait-timeout "$TIMEOUT")
    # A new certificate, or a container that is not healthy (for example stuck
    # restarting after a fix), gets a fresh container with a clean health state.
    # Secret files are bind mounts, so new certificates also need new containers.
    if [[ $TLS_CHANGED == true || $CERTS_CHANGED == true ]] ||
        [[ $PREVIOUS_STATE != healthy && $PREVIOUS_STATE != missing ]]; then
        args+=(--force-recreate)
    fi
    info "Starting the services; the database migrations run first (this can take a few minutes)"
    # A new internal range: the services stop and the network is created again on it.
    if stop_for_network_change "$INSTALL_DIR" && compose_in "$INSTALL_DIR" "${args[@]}"; then
        pass "All MSCD services are running and healthy"
        return 0
    fi

    fail "MSCD did not become healthy with the new settings"
    show_unhealthy_logs 40
    if [[ $PREVIOUS_STATE == healthy && -f $SNAPSHOT/.env && $WEB_ONLY == false ]]; then
        step "Restoring the previous settings and certificate"
        if restore_previous; then
            pass "MSCD is running again with the previous settings"
            rm -rf -- "$SNAPSHOT"
            die "The new settings did not work and were not kept. Fix the problem shown above and run ./install.sh again."
        fi
        rm -rf -- "$SNAPSHOT"
        die "The previous settings did not start either. They are in $INSTALL_DIR/.env; see the troubleshooting table in INSTALL-ONPREM.md."
    fi
    rm -rf -- "$SNAPSHOT"
    die "Installation did not finish. Fix the problem shown above and run ./install.sh again (see: cd $INSTALL_DIR && docker compose ps -a && docker compose logs)."
}

# confirm_new_slug: the slug of a new organisation names its database schema and can
# never be changed. Asked before anything is installed, so "no" changes nothing; with
# --yes only the notice is printed.
confirm_new_slug() {
    [[ -z $SAVED_ORG_SLUG ]] || return 0
    if [[ $DEFAULT_ORG == true ]]; then
        printf '\n  No --org-slug was given, so the organisation is created with the slug %s\n' "$ORG_SLUG"
        printf '  and the name "%s".\n' "$ORG_NAME"
    fi
    printf '\n  The organisation slug %s cannot be changed after the organisation is created:\n' "$ORG_SLUG"
    printf '  it names the database schema of the organisation.\n'
    if [[ $DEFAULT_ORG == true ]]; then
        printf '  The name can be changed later in the app: Administration, Organisation.\n'
    fi
    if [[ $INTERACTIVE == true ]] && ! confirm "Create the organisation with the slug $ORG_SLUG?"; then
        echo "Cancelled. Nothing was changed. Run ./install.sh again and choose the slug you want (--org-slug)."
        exit 0
    fi
}

# create_organisation: "mscd-server tenant create" in a one-off cli container
# (schema, tenant migrations, data key from the gateway, Managed Vault).
create_organisation() {
    local out
    if out=$(compose_in "$INSTALL_DIR" run --rm --no-deps cli tenant create --slug "$ORG_SLUG" --name "$ORG_NAME" 2>&1); then
        pass "Organisation $ORG_NAME ($ORG_SLUG) created"
        return 0
    fi
    if [[ $out == *"Organisation $ORG_SLUG already exists"* ]]; then
        pass "Organisation $ORG_SLUG exists"
        return 0
    fi
    printf '%s\n' "$out" | tail -n 20 | sed 's/^/        /'
    die "The organisation could not be created. Fix the problem shown above and run ./install.sh again."
}

# invite_admin EMAIL: invites the first administrator. The command emails the
# invitation; when email does not work it prints the one-time link, which is kept
# for the summary.
invite_admin() {
    local out
    if out=$(compose_in "$INSTALL_DIR" run --rm --no-deps cli admin create-user --email "$1" --tenant-admin 2>&1); then
        if [[ $out == *"Invitation sent to"* ]]; then
            pass "Invitation emailed to $1"
            INVITATION_EMAILED=true
        else
            pass "Invitation created for $1"
            INVITATION=$(printf '%s\n' "$out" | grep -v '^ *Container ' || true)
        fi
        return 0
    fi
    printf '%s\n' "$out" | tail -n 20 | sed 's/^/        /'
    warn "The first administrator could not be invited; run the command printed below after fixing the problem"
}

print_done() {
    local url sudo
    url=$(public_url "$ENV_FILE")
    sudo=$(sudo_prefix)
    printf '\n%sMSCD %s is running.%s\n\n' "$C_GREEN$C_BOLD" "$BUNDLE_VERSION" "$C_RESET"
    printf '  %-13s %s\n' \
        "Open" "$url" \
        "Organisation" "$ORG_NAME ($ORG_SLUG)" \
        "Install dir" "$INSTALL_DIR" \
        "Status" "cd $INSTALL_DIR && ${sudo}docker compose ps" \
        "Logs" "cd $INSTALL_DIR && ${sudo}docker compose logs api web" \
        "Uninstall" "$sudo$INSTALL_DIR/uninstall.sh"
    if [[ $DEFAULT_ORG == true ]]; then
        printf '\n  No --org-slug was given, so the organisation has the slug %s, which cannot change.\n' "$ORG_SLUG"
        printf '  A Tenant Admin can change its name in the app: Administration, Organisation.\n'
    fi
    if [[ $SUBNET != "$MSCD_DEFAULT_SUBNET" ]]; then
        printf '\n  The containers use the internal range %s (web container %s),\n' "$SUBNET" "$WEB_ADDRESS"
        printf '  saved in %s as MSCD_SUBNET and MSCD_WEB_ADDRESS.\n' "$ENV_FILE"
    fi
    if [[ ${INVITATION_EMAILED:-false} == true ]]; then
        printf '\n  First administrator: the invitation (valid 72 hours) was emailed to %s.\n' "$OPT_ADMIN_EMAIL"
    elif [[ -n ${INVITATION:-} ]]; then
        printf '\n  First administrator: send this one-time link (valid 72 hours) to %s:\n' "$OPT_ADMIN_EMAIL"
        printf '%s\n' "$INVITATION" | sed 's/^/    /'
    else
        printf '\n  Invite the first administrator (emails the invitation, or prints a one-time link\n'
        printf '  valid 72 hours when email does not work):\n'
        printf '    cd %s && %sdocker compose run --rm cli admin create-user --email <email> --tenant-admin\n' "$INSTALL_DIR" "$sudo"
    fi
    printf '\n  Keep a copy of %s/secrets in a safe place: without it the database\n' "$INSTALL_DIR"
    printf '  and the encrypted files cannot be opened.\n'
    if [[ $TLS_MODE == self-signed ]]; then
        printf '\n  The certificate is self-signed, so browsers show a warning. Its SHA-256 fingerprint is\n'
        printf '  %s\n' "$(cert_fingerprint "$INSTALL_DIR/tls/tls.crt")"
        printf '  To use a certificate from your CA, run this again with --tls-cert and --tls-key.\n'
    fi
}

main() {
    parse_args "$@"
    BUNDLE_VERSION=$(tr -d '[:space:]' <"$SCRIPT_DIR/VERSION")
    BUNDLE_IMAGE=$(kv_get "$SCRIPT_DIR/BUNDLE-INFO" IMAGE)
    BUNDLE_IMAGE=${BUNDLE_IMAGE:-$MSCD_DEFAULT_IMAGE}
    BUNDLE_SERVER_IMAGE=$(kv_get "$SCRIPT_DIR/BUNDLE-INFO" SERVER_IMAGE)
    BUNDLE_SERVER_IMAGE=${BUNDLE_SERVER_IMAGE:-$MSCD_DEFAULT_SERVER_IMAGE}
    INSTALL_DIR=$(absolute_path "${OPT_DIR:-$MSCD_DEFAULT_DIR}")
    [[ $INSTALL_DIR != / ]] || die "The install directory cannot be /"
    [[ $INSTALL_DIR != "$SCRIPT_DIR" ]] || die "Install into a directory other than the bundle directory"

    INTERACTIVE=false
    if [[ $ASSUME_YES == false ]]; then
        have_terminal ||
            die "No terminal for the installer questions. Add --yes to install with flags, saved settings and defaults."
        INTERACTIVE=true
    fi

    title "MSCD on-premise installer, version $BUNDLE_VERSION"

    step "Checking this host"
    check_privileges
    check_docker
    check_resources "$INSTALL_DIR"
    check_install_dir "$INSTALL_DIR"
    resolve_project "$INSTALL_DIR"
    check_container_owner "$INSTALL_DIR"
    check_tool openssl "needed for keys and certificates"
    if ! command -v curl >/dev/null 2>&1; then
        warn "curl is not installed; the final checks through the published ports will be skipped"
    fi
    abort_if_failed

    step "Checking the bundle"
    verify_checksums "$SCRIPT_DIR"
    if [[ $INTERACTIVE == true && -z $VERIFY_KEY && $SKIP_SIGNATURE == false && -z $(find_public_key "$SCRIPT_DIR") ]]; then
        VERIFY_KEY=$(ask_public_key "$SCRIPT_DIR")
    fi
    verify_signature "$SCRIPT_DIR" "$VERIFY_KEY" "$SKIP_SIGNATURE"
    check_arch "$(kv_get "$SCRIPT_DIR/BUNDLE-INFO" IMAGE_ARCH)"
    check_bundle_files
    check_bundle_images "$SCRIPT_DIR"
    abort_if_failed

    step "Settings"
    resolve_settings
    show_settings

    step "Checking settings"
    check_settings
    abort_if_failed
    confirm_new_slug

    if [[ $INTERACTIVE == true ]] && ! confirm "Install MSCD $BUNDLE_VERSION with these settings?"; then
        echo "Cancelled. Nothing was changed."
        exit 0
    fi

    PREVIOUS_STATE=$(service_state "$MSCD_WEB_SERVICE")
    TLS_BACKUP=false
    CERTS_CHANGED=false

    step "Loading the images"
    load_bundle_images "$SCRIPT_DIR"

    step "Installing"
    resolve_run_ids
    prepare_dir
    snapshot_config
    install_files
    prepare_tls
    write_env
    activate_tls

    step "Secrets"
    write_secrets

    step "Starting MSCD"
    start_stack
    rm -rf -- "$SNAPSHOT"

    step "Organisation"
    create_organisation
    INVITATION='' INVITATION_EMAILED=false
    if [[ -n $OPT_ADMIN_EMAIL ]]; then
        invite_admin "$OPT_ADMIN_EMAIL"
    fi

    step "Verifying"
    if ! verify_endpoints "$ENV_FILE"; then
        show_unhealthy_logs 20
        show_service_logs "$MSCD_WEB_SERVICE" 20
        die "MSCD is running but not reachable as expected. See the troubleshooting table in INSTALL-ONPREM.md."
    fi

    print_done
}

main "$@"
exit 0
