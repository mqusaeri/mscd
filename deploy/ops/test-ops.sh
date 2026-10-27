#!/usr/bin/env bash
# shellcheck disable=SC2016  # Node scripts and PromQL are in single quotes on purpose
# MSCD SaaS: test of the monitoring overlay (Milestone 2 plan K, M2-S08).
#
#   deploy/ops/test-ops.sh            static checks, then the stack test
#   deploy/ops/test-ops.sh --static   static checks only (no stack, no host lock needed)
#
# The stack test starts the SaaS test stack of M2-S02 (deploy/scripts/test/saas-stack.sh,
# ports 18080 and 18443), so run it under the host lock (R-05):
#
#   flock /tmp/mscd-stack.lock bash deploy/ops/test-ops.sh
#
# Static checks (docker run --network none with the pinned images of the overlay):
#   - promtool check config and promtool test rules; every alert rule has a unit test;
#   - amtool check-config of alertmanager.yml.example, which must equal the template
#     rendered by ops-init with the example values; the other variants (no Telegram, no
#     heartbeat, no SMTP login) pass amtool too;
#   - ops-init refuses wrong or missing settings and then writes nothing;
#   - blackbox exporter configuration check; caddy validate with conf.d/ops.caddy, with and
#     without the Grafana site; the PromQL of the Grafana dashboard parses;
#   - docker compose config of the three Compose files, with and without profile grafana.
#
# Stack test:
#   1. saas-stack.sh up (release images built with throwaway keys, TLS internal).
#   2. Adds the ops overlay with a test overlay: the alert mail goes to a Mailpit container
#      and the watchdog heartbeat to a small HTTP receiver, both on the egress network only
#      (outside mscd), so delivery proves the outbound path; the probe checks Caddy with its
#      local root certificate; node-exporter reads test files for reboot.prom and backup.prom.
#   3. Checks: ops-init ran (role mscd_monitor read only), networks and ports, limits, every
#      Prometheus target up through the Prometheus API inside the container, the probe and
#      the certificate, every rule loaded, the Watchdog reaches the heartbeat, a real rule
#      (HostRebootNeeded) and a test alert fired with amtool arrive as email in the Mailpit
#      on egress and not in the app's Mailpit, Caddy's metrics site refuses the edge network,
#      ops-init runs again without changes, and (with Grafana) the ops host through Caddy.
#   4. Removes everything: the ops services, then saas-stack.sh down.
#
# Settings (environment):
#   MSCD_OPS_TEST_PROJECT   Compose project (default mscd-ops-test), passed to saas-stack.sh
#   MSCD_OPS_TEST_DIR       state folder (default /tmp/mscd-ops-test), passed to saas-stack.sh,
#                           deleted at the end
#   MSCD_OPS_TEST_GRAFANA   true (default): also start Grafana (profile grafana) and test the
#                           ops host; false: skip it (the image is about 500 MB)
#   MSCD_OPS_TEST_KEEP      true: leave the stack running for a look (remove it later with
#                           MSCD_SAAS_TEST_PROJECT=<project> MSCD_SAAS_TEST_DIR=<dir>
#                           deploy/scripts/test/saas-stack.sh down)
#   MSCD_SAAS_TEST_SCAN, MSCD_SAAS_TEST_KEEP_IMAGES, MSCD_BUILD_CA: as saas-stack.sh
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$SCRIPT_DIR/../.." && pwd)
COMPOSE_DIR=$REPO_DIR/deploy/compose
OPS_DIR=$REPO_DIR/deploy/ops
SAAS_STACK=$REPO_DIR/deploy/scripts/test/saas-stack.sh

PROJECT=${MSCD_OPS_TEST_PROJECT:-mscd-ops-test}
STATE=${MSCD_OPS_TEST_DIR:-/tmp/mscd-ops-test}
GRAFANA=${MSCD_OPS_TEST_GRAFANA:-true}
KEEP=${MSCD_OPS_TEST_KEEP:-false}
HTTPS_PORT=''

export COMPOSE_PROJECT_NAME=$PROJECT
# shellcheck source=SCRIPTDIR/../scripts/lib/common.sh
. "$REPO_DIR/deploy/scripts/lib/common.sh"

readonly ALERT_TO=alerts@ops-test.invalid
readonly ALERT_FROM='MSCD alerts test <mscd-alerts@ops-test.invalid>'
readonly HEARTBEAT_PATH=/ping/mscd-ops-test
readonly OPS_HOST=ops.localhost
readonly OPS_USER=ops-test
readonly MAILPIT_IMAGE=axllent/mailpit:v1.31.3

WORK=''
STACK_STARTED=false
OPS_PASSWORD=''

usage() {
    sed -n '3,/^set -euo pipefail$/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# compose_example ARGS...: the three Compose files with the example settings.
compose_example() {
    docker compose --project-directory "$COMPOSE_DIR" -f "$COMPOSE_DIR/docker-compose.yml" \
        -f "$COMPOSE_DIR/docker-compose.saas.yml" -f "$COMPOSE_DIR/docker-compose.ops.yml" \
        --env-file "$COMPOSE_DIR/.env.saas.example" "$@"
}

# image SERVICE: the image of SERVICE in the merged Compose files (pinned by the overlays).
image() {
    node -e 'const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        const s = c.services[process.argv[2]]; if (!s || !s.image) process.exit(1); process.stdout.write(s.image);' \
        "$WORK/compose.json" "$1"
}

# ops_compose ARGS...: the test stack with the ops overlay and both test overlays.
ops_compose() {
    docker compose --project-name "$PROJECT" --project-directory "$COMPOSE_DIR" \
        -f "$COMPOSE_DIR/docker-compose.yml" -f "$COMPOSE_DIR/docker-compose.saas.yml" \
        -f "$STATE/compose.test.yml" -f "$COMPOSE_DIR/docker-compose.ops.yml" \
        -f "$STATE/ops/compose.ops-test.yml" --env-file "$STATE/.env" "$@"
}

# wait_for SECONDS COMMAND...: runs COMMAND every 3 seconds until it succeeds.
wait_for() {
    local timeout=$1 start=$SECONDS
    shift
    until "$@" >/dev/null 2>&1; do
        ((SECONDS - start < timeout)) || return 1
        sleep 3
    done
}

# prom_api PATH: GET of the Prometheus HTTP API, from inside the prometheus container.
prom_api() {
    ops_compose exec -T prometheus wget -q -O - "http://127.0.0.1:9090$1"
}

# prom_values EXPR: "labels value" lines of an instant query (labels as JSON).
prom_values() {
    local q
    q=$(node -p 'encodeURIComponent(process.argv[1])' "$1")
    prom_api "/api/v1/query?query=$q" | node -e '
const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
if (r.status !== "success") process.exit(1);
for (const s of r.data.result) console.log(JSON.stringify(s.metric), s.value[1]);'
}

# prom_true EXPR: true when the query returns at least one series.
prom_true() {
    [[ -n $(prom_values "$1" 2>/dev/null) ]]
}

# mailpit_messages SERVICE: "subject|to|from|id" lines of the Mailpit container SERVICE.
mailpit_messages() {
    ops_compose exec -T "$1" wget -q -O - "http://127.0.0.1:8025/api/v1/messages?limit=200" | node -e '
const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
for (const m of r.messages || [])
  console.log([m.Subject, (m.To || []).map((t) => t.Address).join(","), m.From ? m.From.Address : "", m.ID].join("|"));'
}

mail_arrived() {
    mailpit_messages ops-mailpit 2>/dev/null | grep -q -- "$1"
}

# container_networks SERVICE: the networks of the service's container, without the project
# prefix, sorted and separated by spaces.
container_networks() {
    local id
    id=$(project_containers "$1" | head -n 1)
    [[ -n $id ]] || { echo missing; return 0; }
    docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$id" |
        tr ' ' '\n' | sed -e '/^$/d' -e "s/^${PROJECT}_//" | sort | xargs
}

# ops_curl PATH [CURL ARGS...]: HTTPS request to the ops host through Caddy.
ops_curl() {
    local path=$1
    shift
    curl --noproxy '*' --silent --show-error --max-time 15 --cacert "$STATE/caddy-root.crt" \
        --resolve "$OPS_HOST:$HTTPS_PORT:127.0.0.1" "$@" "https://$OPS_HOST:$HTTPS_PORT$path"
}

# run_ops_init OUT SECRETS [ENV...]: ops-init --render-only in a container without network.
# The example values below are the ones alertmanager.yml.example was rendered with.
run_ops_init() {
    local out=$1 secrets=$2
    shift 2
    mkdir -p -- "$out"
    docker run --rm --network none --user "$(id -u):$(id -g)" \
        -v "$OPS_DIR:/ops-config:ro" -v "$secrets:/run/ops-secrets:ro" \
        -v "$WORK/smtp.password:/run/secrets/smtp.password:ro" -v "$out:/ops" \
        -e MSCD_DOMAIN=app.example.com -e MSCD_PUBLIC_URL=https://app.example.com \
        -e MSCD_OPS_SMTP_HOST=smtp.example.com -e MSCD_OPS_SMTP_PORT=587 \
        -e MSCD_OPS_SMTP_USER=mscd-mailer -e 'MSCD_OPS_MAIL_FROM=MSCD <no-reply@example.com>' \
        "$@" --entrypoint sh "$PG_IMAGE" /ops-config/ops-init.sh --render-only
}

# example_secrets DIR [full|minimal]: the settings files deploy-prod.yml writes, example values.
example_secrets() {
    local dir=$1 kind=${2:-full}
    rm -rf -- "$dir"
    mkdir -p -- "$dir"
    printf 'ops@example.com\n' >"$dir/ALERT_EMAIL_TO"
    if [[ $kind == full ]]; then
        printf 'https://hc-ping.com/00000000-0000-0000-0000-000000000000\n' >"$dir/HEARTBEAT_WATCHDOG_URL"
        printf '123456789:AAExampleExampleExampleExample00\n' >"$dir/TELEGRAM_BOT_TOKEN"
        printf -- '-1001234567890\n' >"$dir/TELEGRAM_CHAT_ID"
    fi
}

amtool_check() {
    docker run --rm --network none -v "$OPS_DIR/alertmanager/templates:/etc/alertmanager/templates:ro" \
        -v "$1:/check/alertmanager.yml:ro" --entrypoint amtool "$AM_IMAGE" check-config /check/alertmanager.yml
}

caddy_validate() {
    local mode=$1 ops_folder=${2:-} args=()
    if [[ -n $ops_folder ]]; then args=(-v "$ops_folder:/etc/caddy-ops:ro"); fi
    docker run --rm --network none -e MSCD_DOMAIN=app.example.com -e MSCD_TLS_MODE="$mode" -e ACME_EMAIL= \
        -e ACME_CA=https://acme-staging-v02.api.letsencrypt.org/directory -e MSCD_SUBNET=172.31.250.0/24 \
        -v "$COMPOSE_DIR/config/caddy:/etc/caddy:ro" "${args[@]}" "$CADDY_IMAGE" \
        caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
}

# ---------------------------------------------------------------------------
# Static checks
# ---------------------------------------------------------------------------

static_checks() {
    local out rc log
    title "MSCD monitoring overlay: static checks"
    for tool in docker node; do command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"; done

    step "Compose files"
    if compose_example config -q && compose_example --profile grafana config -q; then
        pass "docker compose config of docker-compose.yml, .saas.yml and .ops.yml (also with profile grafana)"
    else
        fail "docker compose config failed for the three Compose files"
    fi
    compose_example --profile grafana config --format json >"$WORK/compose.json" ||
        die "docker compose config --format json failed"
    PROM_IMAGE=$(image prometheus)
    AM_IMAGE=$(image alertmanager)
    BLACKBOX_IMAGE=$(image blackbox-exporter)
    PG_IMAGE=$(image ops-init)
    CADDY_IMAGE=$(image caddy)
    local name pinned=true
    for name in prometheus alertmanager node-exporter postgres-exporter blackbox-exporter grafana caddy; do
        [[ $(image "$name") =~ ^[^@:]+:[^@]+@sha256:[0-9a-f]{64}$ ]] || { pinned=false; fail "$name is not pinned to a version and a digest: $(image "$name")"; }
    done
    [[ $pinned == false ]] || pass "Every monitoring image is pinned to a version and a digest"
    if node -e '
const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const bad = Object.entries(c.services).filter(([n, s]) => n !== "caddy" && (s.ports || []).length).map(([n]) => n);
if (bad.length) { console.log(bad.join(", ")); process.exit(1); }' "$WORK/compose.json"; then
        pass "Only Caddy publishes ports"
    else
        fail "Services other than Caddy publish ports"
    fi

    step "Prometheus"
    if docker run --rm --network none -v "$OPS_DIR/prometheus:/etc/prometheus:ro" --entrypoint promtool "$PROM_IMAGE" \
        check config /etc/prometheus/prometheus.yml >"$WORK/promtool-config.log" 2>&1; then
        pass "promtool check config"
    else
        fail "promtool check config" "$(tail -n 5 "$WORK/promtool-config.log" | tr '\n' ' ')"
    fi
    if docker run --rm --network none -v "$OPS_DIR/prometheus:/etc/prometheus:ro" --entrypoint promtool "$PROM_IMAGE" \
        test rules /etc/prometheus/tests/alerts.test.yml >"$WORK/promtool-test.log" 2>&1; then
        pass "promtool test rules (tests/alerts.test.yml)"
    else
        sed 's/^/        /' "$WORK/promtool-test.log" | tail -n 30
        fail "promtool test rules"
    fi
    if log=$(node -e '
const fs = require("fs"), path = require("path");
const yaml = require(require.resolve("yaml", { paths: [process.argv[1]] }));
const dir = process.argv[2];
const files = fs.readdirSync(path.join(dir, "rules")).filter((f) => f.endsWith(".yml")).sort();
const tests = yaml.parse(fs.readFileSync(path.join(dir, "tests/alerts.test.yml"), "utf8"));
const listed = (tests.rule_files || []).map((f) => path.basename(f)).sort();
const tested = new Set(tests.tests.flatMap((t) => (t.alert_rule_test || []).map((a) => a.alertname)));
const alerts = files.flatMap((f) => yaml.parse(fs.readFileSync(path.join(dir, "rules", f), "utf8")).groups.flatMap((g) => g.rules.filter((r) => r.alert).map((r) => r.alert)));
const missing = alerts.filter((a) => !tested.has(a));
const unlisted = files.filter((f) => !listed.includes(f));
if (missing.length || unlisted.length) { console.log(`no test: ${missing.join(", ") || "none"}; rule files not in the test: ${unlisted.join(", ") || "none"}`); process.exit(1); }
console.log(`${alerts.length} alert rules in ${files.length} files, each with a test`);' "$REPO_DIR" "$OPS_DIR/prometheus"); then
        pass "$log"
    else
        fail "Alert rules without a unit test: $log"
    fi

    step "Alertmanager and ops-init"
    printf 'example-password' >"$WORK/smtp.password"
    example_secrets "$WORK/secrets-full" full
    out=$WORK/render-full
    if run_ops_init "$out" "$WORK/secrets-full" >"$WORK/render-full.log" 2>&1; then
        if diff -u "$OPS_DIR/alertmanager/alertmanager.yml.example" "$out/alertmanager/alertmanager.yml" >"$WORK/example.diff"; then
            pass "alertmanager.yml.example equals the template rendered by ops-init with the example values"
        else
            sed 's/^/        /' "$WORK/example.diff" | head -n 30
            fail "alertmanager.yml.example differs from the rendered template" "Render it again (see the diff above)"
        fi
        if amtool_check "$OPS_DIR/alertmanager/alertmanager.yml.example" >"$WORK/amtool.log" 2>&1; then
            pass "amtool check-config alertmanager.yml.example (email, Telegram, heartbeat, templates)"
        else
            fail "amtool check-config alertmanager.yml.example" "$(tail -n 5 "$WORK/amtool.log" | tr '\n' ' ')"
        fi
        if grep -rq 'example-password\|AAExampleExample\|hc-ping.com' "$out/alertmanager/alertmanager.yml" "$out/prometheus"; then
            fail "A secret value appears in the rendered configuration"
        elif [[ $(cat "$out/alertmanager/secrets/smtp_password") == example-password &&
            -s $out/alertmanager/secrets/telegram_bot_token && -s $out/alertmanager/secrets/heartbeat_watchdog_url ]]; then
            pass "Secrets are separate files next to the configuration, never inside it"
        else
            fail "The secret files of Alertmanager were not written"
        fi
        if grep -qx '    - "https://app.example.com/healthz"' "$out/prometheus/probe-targets.yml"; then
            pass "Probe target from MSCD_PUBLIC_URL: https://app.example.com/healthz"
        else
            fail "The probe target is not https://app.example.com/healthz"
        fi
    else
        sed 's/^/        /' "$WORK/render-full.log"
        fail "ops-init --render-only failed with the example values"
    fi

    example_secrets "$WORK/secrets-minimal" minimal
    out=$WORK/render-minimal
    if run_ops_init "$out" "$WORK/secrets-minimal" -e MSCD_OPS_SMTP_USER= >"$WORK/render-minimal.log" 2>&1 &&
        amtool_check "$out/alertmanager/alertmanager.yml" >"$WORK/amtool-minimal.log" 2>&1 &&
        ! grep -q 'telegram_configs\|webhook_configs\|smtp_auth' "$out/alertmanager/alertmanager.yml" &&
        [[ ! -e $out/alertmanager/secrets/smtp_password ]] && grep -q 'nobody notices' "$WORK/render-minimal.log"; then
        pass "Email only (no login, no Telegram, no heartbeat): valid, and ops-init warns about the missing heartbeat"
    else
        fail "The email-only configuration is wrong" "$(tail -n 5 "$WORK/render-minimal.log" "$WORK/amtool-minimal.log" 2>/dev/null | tr '\n' ' ')"
    fi

    # Refused settings: each case must stop ops-init with its message and write nothing.
    local -a cases=(
        "ALERT_EMAIL_TO=|alerts would reach nobody"
        "ALERT_EMAIL_TO=not-an-address|ALERT_EMAIL_TO must be an email address"
        "TELEGRAM_CHAT_ID=|Telegram needs both"
        "TELEGRAM_CHAT_ID=12ab|TELEGRAM_CHAT_ID must be a number"
        "HEARTBEAT_WATCHDOG_URL=ftp://x|HEARTBEAT_WATCHDOG_URL must be"
        "OPS_DOMAIN=ops.example.com|needs both OPS_DOMAIN and OPS_BASIC_AUTH_HASH"
        "OPS_BASIC_AUTH_HASH=plain-password|must be a bcrypt hash"
        "ENV:MSCD_PUBLIC_URL=http://app.example.com|MSCD_PUBLIC_URL must be an https"
        "ENV:MSCD_OPS_SMTP_HOST=|must be a host name"
        "ENV:MSCD_OPS_SMTP_PORT=70000|must be a port number"
        "ENV:MSCD_DOMAIN=App Example|MSCD_DOMAIN must be a host name"
        "NEWLINE:ALERT_EMAIL_TO|must be one line"
    )
    local item setting message key value refused=0
    for item in "${cases[@]}"; do
        setting=${item%%|*} message=${item#*|}
        example_secrets "$WORK/secrets-bad" full
        local -a env_args=()
        case "$setting" in
            ENV:*) env_args=(-e "${setting#ENV:}") ;;
            NEWLINE:*) printf 'ops@example.com\nother@example.com\n' >"$WORK/secrets-bad/${setting#NEWLINE:}" ;;
            *)
                key=${setting%%=*} value=${setting#*=}
                if [[ -z $value ]]; then rm -f -- "$WORK/secrets-bad/$key"; else printf '%s\n' "$value" >"$WORK/secrets-bad/$key"; fi
                if [[ $key == OPS_BASIC_AUTH_HASH ]]; then printf 'ops.example.com\n' >"$WORK/secrets-bad/OPS_DOMAIN"; fi
                ;;
        esac
        out=$WORK/render-bad
        rm -rf -- "$out"
        rc=0
        run_ops_init "$out" "$WORK/secrets-bad" "${env_args[@]}" >"$WORK/render-bad.log" 2>&1 || rc=$?
        if ((rc != 0)) && grep -q -- "$message" "$WORK/render-bad.log" && [[ -z $(find "$out" -type f) ]]; then
            refused=$((refused + 1))
        else
            fail "ops-init did not refuse '$setting' with \"$message\" (exit $rc)" "$(tail -n 3 "$WORK/render-bad.log" | tr '\n' ' ')"
        fi
    done
    ((refused != ${#cases[@]})) || pass "ops-init refuses ${#cases[@]} wrong or missing settings and then writes nothing"

    step "Caddy and Grafana host"
    local hash
    hash=$(docker run --rm --network none "$CADDY_IMAGE" caddy hash-password --plaintext 'static-check-password')
    example_secrets "$WORK/secrets-grafana" full
    printf 'ops.example.com\n' >"$WORK/secrets-grafana/OPS_DOMAIN"
    printf '%s\n' "$hash" >"$WORK/secrets-grafana/OPS_BASIC_AUTH_HASH"
    out=$WORK/render-grafana
    if run_ops_init "$out" "$WORK/secrets-grafana" >"$WORK/render-grafana.log" 2>&1 && [[ -s $out/caddy/grafana.caddy ]]; then
        pass "ops-init writes the Grafana site when OPS_DOMAIN and OPS_BASIC_AUTH_HASH are set"
    else
        fail "ops-init did not write the Grafana site" "$(tail -n 3 "$WORK/render-grafana.log" | tr '\n' ' ')"
    fi
    local mode
    mkdir -p "$WORK/empty"
    for mode in acme internal; do
        if caddy_validate "$mode" >"$WORK/caddy.log" 2>&1 && caddy_validate "$mode" "$out/caddy" >>"$WORK/caddy.log" 2>&1 &&
            caddy_validate "$mode" "$WORK/empty" >>"$WORK/caddy.log" 2>&1; then
            pass "caddy validate ($mode): without the ops overlay, with the Grafana site, and with an empty site folder"
        else
            fail "caddy validate ($mode) failed with conf.d/ops.caddy" "$(grep -m 3 -i error "$WORK/caddy.log" | tr '\n' ' ')"
        fi
    done

    step "Blackbox exporter and dashboard"
    if docker run --rm --network none -v "$OPS_DIR/blackbox/blackbox.yml:/etc/blackbox_exporter/config.yml:ro" \
        "$BLACKBOX_IMAGE" --config.file=/etc/blackbox_exporter/config.yml --config.check >"$WORK/blackbox.log" 2>&1; then
        pass "blackbox exporter configuration check"
    else
        fail "blackbox exporter configuration check" "$(tail -n 3 "$WORK/blackbox.log" | tr '\n' ' ')"
    fi
    mkdir -p "$WORK/dashboard"
    if node -e '
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const exprs = d.panels.flatMap((p) => (p.targets || []).map((t) => t.expr));
const bad = d.panels.filter((p) => p.type !== "row" && (!p.datasource || p.datasource.uid !== "prometheus")).map((p) => p.title);
if (bad.length) { console.error("panels without the Prometheus data source: " + bad.join(", ")); process.exit(1); }
const rules = exprs.map((e, i) => `      - record: mscd_dashboard_expr_${i}\n        expr: ${JSON.stringify(e)}`).join("\n");
fs.writeFileSync(process.argv[2], `groups:\n  - name: dashboard\n    rules:\n${rules}\n`);' \
        "$OPS_DIR/grafana/dashboards/mscd-overview.json" "$WORK/dashboard/exprs.yml" &&
        docker run --rm --network none -v "$WORK/dashboard:/check:ro" --entrypoint promtool "$PROM_IMAGE" \
            check rules /check/exprs.yml >"$WORK/dashboard.log" 2>&1; then
        pass "Every query of the Grafana dashboard parses (promtool check rules)"
    else
        fail "A query of the Grafana dashboard does not parse" "$(grep -m 3 -i -E 'error|err' "$WORK/dashboard.log" 2>/dev/null | tr '\n' ' ')"
    fi
}

# ---------------------------------------------------------------------------
# Stack test
# ---------------------------------------------------------------------------

write_test_files() {
    local ops=$STATE/ops now
    install -d -m 0755 "$ops" "$ops/metrics"
    now=$(date +%s)

    # The settings files deploy-prod.yml writes (owned by the deploying user, mode 0400).
    install -d -m 0700 "$STATE/secrets/ops"
    printf '%s\n' "$ALERT_TO" >"$STATE/secrets/ops/ALERT_EMAIL_TO"
    printf 'http://ops-heartbeat:8080%s\n' "$HEARTBEAT_PATH" >"$STATE/secrets/ops/HEARTBEAT_WATCHDOG_URL"
    if [[ $GRAFANA == true ]]; then
        OPS_PASSWORD=$(openssl rand -hex 16)
        printf '%s\n' "$OPS_HOST" >"$STATE/secrets/ops/OPS_DOMAIN"
        printf '%s\n' "$OPS_USER" >"$STATE/secrets/ops/OPS_BASIC_AUTH_USER"
        docker run --rm --network none "$CADDY_IMAGE" caddy hash-password --plaintext "$OPS_PASSWORD" \
            >"$STATE/secrets/ops/OPS_BASIC_AUTH_HASH"
    fi
    chmod 0400 "$STATE/secrets/ops"/*

    # Text files of the node exporter: a reboot needed for 8 days (HostRebootNeeded fires at
    # once) and a backup an hour ago.
    cat >"$ops/metrics/reboot.prom" <<EOF
# HELP mscd_host_reboot_required 1 when the server needs a reboot.
# TYPE mscd_host_reboot_required gauge
mscd_host_reboot_required 1
# HELP mscd_host_reboot_required_since_timestamp_seconds Time the reboot became needed.
# TYPE mscd_host_reboot_required_since_timestamp_seconds gauge
mscd_host_reboot_required_since_timestamp_seconds $((now - 8 * 86400))
EOF
    cat >"$ops/metrics/backup.prom" <<EOF
# HELP mscd_backup_last_success_timestamp_seconds Time of the last successful backup.
# TYPE mscd_backup_last_success_timestamp_seconds gauge
mscd_backup_last_success_timestamp_seconds $((now - 3600))
EOF
    chmod 0644 "$ops/metrics"/*.prom

    # The probe reaches Caddy by its name on mscd and trusts Caddy's local root certificate;
    # the rest of the module is the production one.
    install -m 0644 "$STATE/caddy-root.crt" "$ops/caddy-root.crt"
    node -e '
const fs = require("fs");
const yaml = require(require.resolve("yaml", { paths: [process.argv[1]] }));
const c = yaml.parse(fs.readFileSync(process.argv[2], "utf8"));
const http = c.modules.https_healthz.http;
http.headers = { ...(http.headers || {}), Host: "localhost" };
http.tls_config = { ca_file: "/etc/blackbox_exporter/caddy-root.crt", server_name: "localhost" };
fs.writeFileSync(process.argv[3], "# Test copy of deploy/ops/blackbox/blackbox.yml (test-ops.sh).\n" + yaml.stringify(c));' \
        "$REPO_DIR" "$OPS_DIR/blackbox/blackbox.yml" "$ops/blackbox-test.yml"
    chmod 0644 "$ops/blackbox-test.yml"

    cat >"$ops/compose.ops-test.yml" <<EOF
# Test additions of deploy/ops/test-ops.sh (not for a server): the alert mail relay and the
# heartbeat receiver sit on the egress network only, outside mscd, like the outside services
# of production; the probe checks Caddy itself.
services:
  ops-init:
    environment:
      MSCD_OPS_PROBE_URL: https://caddy/healthz
      MSCD_OPS_SMTP_HOST: ops-mailpit
      MSCD_OPS_SMTP_PORT: "1025"
      MSCD_OPS_SMTP_USER: ""
      MSCD_OPS_MAIL_FROM: "$ALERT_FROM"
      MSCD_OPS_SMTP_REQUIRE_TLS: "false"

  blackbox-exporter:
    volumes:
      - $ops/blackbox-test.yml:/etc/blackbox_exporter/config.yml:ro
      - $ops/caddy-root.crt:/etc/blackbox_exporter/caddy-root.crt:ro

  ops-mailpit:
    image: $MAILPIT_IMAGE
    pull_policy: missing
    restart: unless-stopped
    environment:
      MP_SMTP_AUTH_ACCEPT_ANY: "true"
      MP_SMTP_AUTH_ALLOW_INSECURE: "true"
    security_opt:
      - no-new-privileges:true
    networks:
      - egress
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8025/livez"]
      interval: 5s
      timeout: 5s
      retries: 10
      start_period: 30s
      start_interval: 1s

  ops-heartbeat:
    image: $CADDY_IMAGE
    pull_policy: missing
    restart: unless-stopped
    command: ["caddy", "respond", "--listen", ":8080", "--access-log", "--body", "OK"]
    security_opt:
      - no-new-privileges:true
    networks:
      - egress
EOF

    env_set "$STATE/.env" MSCD_METRICS_DIR "$ops/metrics"
    if [[ $GRAFANA == true ]]; then
        env_set "$STATE/.env" COMPOSE_PROFILES "$(kv_get "$STATE/.env" COMPOSE_PROFILES),grafana"
    fi
}

start_ops() {
    local id code services
    step "Monitoring overlay"
    ops_compose config -q || die "docker compose config of the test stack with the ops overlay failed"
    pass "Compose configuration of the test stack with the ops overlay is valid"

    # ops-init first, so Caddy reads the Grafana site it writes when Caddy is recreated below.
    ops_compose up -d ops-init >"$STATE/ops/up-init.log" 2>&1 ||
        { tail -n 20 "$STATE/ops/up-init.log" | sed 's/^/        /'; die "ops-init could not be started"; }
    id=$(project_containers ops-init | head -n 1)
    wait_for 180 bash -c "[[ \$(docker inspect --format '{{.State.Status}}' $id) == exited ]]" ||
        die "ops-init did not finish within 3 minutes"
    code=$(docker inspect --format '{{.State.ExitCode}}' "$id")
    ops_compose logs --no-color ops-init >"$STATE/ops/ops-init.log" 2>&1 || true
    if [[ $code != 0 ]]; then
        sed 's/^/        /' "$STATE/ops/ops-init.log"
        die "ops-init failed (exit $code)"
    fi
    pass "ops-init finished: $(grep -c 'ops-init:' "$STATE/ops/ops-init.log") steps, exit 0"

    services=(prometheus alertmanager node-exporter postgres-exporter blackbox-exporter caddy ops-mailpit ops-heartbeat)
    if [[ $GRAFANA == true ]]; then services+=(grafana); fi
    if ! ops_compose up -d --wait --wait-timeout 300 "${services[@]}" >"$STATE/ops/up.log" 2>&1; then
        tail -n 20 "$STATE/ops/up.log" | sed 's/^/        /'
        for id in "${services[@]}"; do
            ops_compose logs --no-color --tail 20 "$id" 2>/dev/null | sed 's/^/        /'
        done
        die "The monitoring services did not start"
    fi
    pass "Every monitoring service runs and is healthy: ${services[*]}"
}

check_init() {
    local log=$STATE/ops/ops-init.log row
    if grep -q 'Role mscd_monitor ready' "$log" && grep -q 'HTTPS probe of https://caddy/healthz' "$log" &&
        grep -q 'Alerts by email to 1 address(es) through ops-mailpit:1025; Telegram: off; watchdog heartbeat: on' "$log"; then
        pass "ops-init: role, probe target and Alertmanager configuration written"
    else
        fail "ops-init did not report every step" "See $log"
    fi
    if grep -q "$ALERT_TO\|$HEARTBEAT_PATH" "$log"; then
        fail "ops-init printed the alert address or the heartbeat address"
    else
        pass "ops-init prints neither the alert address nor the heartbeat address"
    fi
    row=$(ops_compose exec -T postgres psql -U postgres -d mscd -tA -c \
        "SELECT rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolconnlimit, pg_has_role('mscd_monitor', 'pg_monitor', 'member'),
                array_to_string(rolconfig, ',') FROM pg_roles WHERE rolname = 'mscd_monitor'" 2>&1 || true)
    if [[ $row == "t|f|f|f|5|t|"*default_transaction_read_only=on* ]]; then
        pass "Role mscd_monitor: login, no superuser or role rights, member of pg_monitor, read only, 5 connections"
    else
        fail "Role mscd_monitor is not set up as expected: $row"
    fi
    # Through the network address of the database (password checked), not the local socket.
    local pw out
    pw=$(ops_compose exec -T postgres-exporter cat /run/ops-state/monitor.password 2>/dev/null || true)
    out=$(ops_compose exec -T -e PGPASSWORD="$pw" postgres psql -h postgres -U mscd_monitor -d mscd -tA \
        -c 'CREATE TABLE ops_test_write (x int)' 2>&1 || true)
    if [[ $out == *"read-only transaction"* ]]; then
        pass "mscd_monitor signs in with the password of ops-init and cannot write"
    else
        fail "mscd_monitor could write, or could not sign in: $(printf '%s' "$out" | head -n 2 | tr '\n' ' ')"
    fi
    out=$(ops_compose exec -T -e PGPASSWORD=wrong-password postgres psql -h postgres -U mscd_monitor -d mscd -tA \
        -c 'SELECT 1' 2>&1 || true)
    if [[ $out == *"password authentication failed"* ]]; then
        pass "mscd_monitor needs its password (a wrong one is refused)"
    else
        fail "mscd_monitor signed in with a wrong password: $(printf '%s' "$out" | head -n 2 | tr '\n' ' ')"
    fi
}

check_isolation() {
    local service want got lines
    for service in prometheus node-exporter postgres-exporter grafana alertmanager blackbox-exporter ops-mailpit ops-heartbeat caddy; do
        case $service in
            prometheus | node-exporter | postgres-exporter | grafana) want=mscd ;;
            alertmanager | blackbox-exporter) want='egress mscd' ;;
            ops-mailpit | ops-heartbeat) want=egress ;;
            caddy) want='edge mscd' ;;
        esac
        if [[ $service == grafana && $GRAFANA != true ]]; then continue; fi
        got=$(container_networks "$service")
        if [[ $got == "$want" ]]; then
            pass "$service networks: $got"
        else
            fail "$service networks: $got (expected $want)"
        fi
    done
    lines=$(project_containers | xargs -r docker inspect --format \
        '{{index .Config.Labels "com.docker.compose.service"}} {{range $p, $b := .NetworkSettings.Ports}}{{if $b}}{{$p}} {{end}}{{end}}')
    if [[ $(awk 'NF > 1 { print $1 }' <<<"$lines" | sort -u | xargs) == caddy ]]; then
        pass "Only Caddy publishes ports, also with the ops overlay"
    else
        fail "Services with published ports: $(awk 'NF > 1 { print $1 }' <<<"$lines" | sort -u | xargs)"
    fi
    local id total=0 memory ro nnp caps bad=''
    for service in prometheus alertmanager node-exporter postgres-exporter blackbox-exporter grafana; do
        if [[ $service == grafana && $GRAFANA != true ]]; then continue; fi
        id=$(project_containers "$service" | head -n 1)
        read -r memory ro nnp caps < <(docker inspect --format \
            '{{.HostConfig.Memory}} {{.HostConfig.ReadonlyRootfs}} {{range .HostConfig.SecurityOpt}}{{.}}{{end}} {{len .HostConfig.CapDrop}}' "$id")
        total=$((total + memory))
        if ((memory == 0)) || [[ $ro != true || $nnp != *no-new-privileges* || $caps == 0 ]]; then bad="$bad $service"; fi
    done
    if [[ -z $bad ]]; then
        pass "Memory limits on every monitoring service ($((total / 1024 / 1024)) MB together), read-only, no new privileges, capabilities dropped"
    else
        fail "Missing limit or hardening:$bad"
    fi
}

all_targets_up() {
    prom_api /api/v1/targets?state=active | node -e '
const r = JSON.parse(require("fs").readFileSync(0, "utf8"));
const t = r.data.activeTargets;
const jobs = new Set(t.map((x) => x.labels.job));
const want = ["prometheus", "alertmanager", "api", "worker", "storage-gateway", "node", "postgres", "caddy", "blackbox", "public-url"];
const missing = want.filter((j) => !jobs.has(j));
const down = t.filter((x) => x.health !== "up").map((x) => `${x.labels.job} (${x.health}: ${x.lastError || "not scraped yet"})`);
if (missing.length || down.length) { console.log(`missing: ${missing.join(", ") || "none"}; not up: ${down.join("; ") || "none"}`); process.exit(1); }
console.log(t.map((x) => x.labels.job).sort().join(", "));'
}

check_prometheus() {
    local out
    if wait_for 240 all_targets_up; then
        pass "Every Prometheus target is up (Prometheus API inside the container): $(all_targets_up)"
    else
        fail "Not every Prometheus target is up: $(all_targets_up 2>&1 || true)"
    fi
    if out=$(prom_api /api/v1/rules | node -e '
const fs = require("fs"), path = require("path");
const yaml = require(require.resolve("yaml", { paths: [process.argv[1]] }));
const dir = path.join(process.argv[2], "rules");
const want = fs.readdirSync(dir).filter((f) => f.endsWith(".yml")).flatMap((f) => yaml.parse(fs.readFileSync(path.join(dir, f), "utf8")).groups.flatMap((g) => g.rules)).length;
const r = JSON.parse(fs.readFileSync(0, "utf8"));
const rules = r.data.groups.flatMap((g) => g.rules);
const bad = rules.filter((x) => x.health === "err").map((x) => `${x.name}: ${x.lastError}`);
console.log(`${rules.length} of ${want} rules loaded${bad.length ? "; errors: " + bad.join("; ") : ""}`);
if (rules.length !== want || bad.length) process.exit(1);' "$REPO_DIR" "$OPS_DIR/prometheus"); then
        pass "$out"
    else
        fail "Rules: $out"
    fi

    local -a checks=(
        'probe_success{job="public-url"} == 1|HTTPS probe of the public URL succeeds (probe_success 1)'
        'probe_ssl_earliest_cert_expiry{job="public-url"} > time()|Certificate expiry read by the probe (probe_ssl_earliest_cert_expiry)'
        'pg_up == 1|postgres-exporter is connected as mscd_monitor (pg_up 1)'
        'mscd_host_reboot_required == 1|reboot.prom read by the text file collector (mscd_host_reboot_required)'
        'time() - mscd_backup_last_success_timestamp_seconds < 7200|backup.prom read by the text file collector (mscd_backup_last_success_timestamp_seconds)'
        'mscd_http_request_duration_seconds_count{job="api"}|api metrics on port 9464 (mscd_http_request_duration_seconds)'
        'mscd_queue_waiting{job="worker"}|worker metrics on port 9464 (mscd_queue_waiting)'
        'mscd_job_runs_total{job="worker", job_name=~".+"}|Job runs of the worker carry the job name in job_name (relabelling of prometheus.yml)'
        'up{job="storage-gateway"} == 1|storage-gateway metrics on port 9464'
        'caddy_config_last_reload_successful == 1|Caddy metrics from the metrics site of ops.caddy'
        'node_filesystem_size_bytes{mountpoint="/"}|Disk metrics of the host (node_filesystem_size_bytes of /)'
        'ALERTS{alertname="Watchdog", alertstate="firing"}|The Watchdog alert fires'
        'ALERTS{alertname="HostRebootNeeded", alertstate="firing"}|HostRebootNeeded fires from the test reboot.prom'
    )
    local item expr label
    for item in "${checks[@]}"; do
        expr=${item%%|*} label=${item#*|}
        if wait_for 120 prom_true "$expr"; then pass "$label"; else fail "$label: no result for $expr"; fi
    done
    if prom_true '{exported_job=~".+"}'; then
        fail "Some series still carry exported_job (the job_name relabelling does not work)"
    else
        pass "No series carries exported_job: job names are in job_name"
    fi
}

heartbeat_arrived() {
    ops_compose logs --no-color ops-heartbeat 2>/dev/null | grep '"method":"POST"' | grep -q "\"uri\":\"$HEARTBEAT_PATH\""
}

check_alerts() {
    local line subject id text
    if wait_for 150 heartbeat_arrived; then
        pass "The Watchdog reached the heartbeat receiver on egress (POST $HEARTBEAT_PATH)"
    else
        fail "No heartbeat POST arrived within 150 seconds"
    fi
    if ops_compose exec -T alertmanager amtool alert add MscdOpsTest severity=warning \
        --annotation=summary='Test alert of test-ops.sh' --annotation=action='Check the test mailbox.' \
        --alertmanager.url=http://127.0.0.1:9093 >/dev/null 2>&1; then
        pass "Test alert MscdOpsTest fired with amtool"
    else
        fail "amtool alert add failed"
    fi
    for subject in MscdOpsTest HostRebootNeeded; do
        if wait_for 180 mail_arrived "Alert: $subject|"; then
            line=$(mailpit_messages ops-mailpit | grep -m 1 -- "Alert: $subject|")
            if [[ $line == "[MSCD localhost] Alert: $subject|$ALERT_TO|mscd-alerts@ops-test.invalid|"* ]]; then
                pass "Email \"${line%%|*}\" arrived in the Mailpit on egress, to $ALERT_TO"
            else
                fail "The email of $subject has the wrong subject, recipient or sender: $line"
            fi
        else
            fail "No email for $subject arrived in the Mailpit on egress within 180 seconds"
        fi
    done
    line=$(mailpit_messages ops-mailpit | grep -m 1 -- 'Alert: MscdOpsTest|' || true)
    id=${line##*|}
    text=$(ops_compose exec -T ops-mailpit wget -q -O - "http://127.0.0.1:8025/api/v1/message/$id" 2>/dev/null |
        node -e 'const m = JSON.parse(require("fs").readFileSync(0, "utf8")); process.stdout.write(m.Text || "")' 2>/dev/null || true)
    if [[ $text == *"Test alert of test-ops.sh"* && $text == *"First step: Check the test mailbox."* ]]; then
        pass "The email text holds the summary and the first step"
    else
        fail "The email text lacks the summary or the first step"
    fi
    if mailpit_messages mailpit 2>/dev/null | grep -q 'Alert: '; then
        fail "An alert email reached the app's Mailpit on mscd"
    else
        pass "No alert email reached the app's Mailpit on mscd: delivery went through egress"
    fi
}

check_caddy_metrics() {
    local edge code
    edge=$(kv_get "$STATE/.env" MSCD_CADDY_ADDRESS)
    code=$(ops_compose exec -T web curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$edge:9180/metrics" 2>/dev/null || true)
    if [[ $code == 403 ]]; then
        pass "Caddy's metrics site refuses the edge network (web gets 403)"
    else
        fail "Caddy's metrics site answered $code to the web container on edge (expected 403)"
    fi
    if ops_compose exec -T caddy wget -q -O /dev/null http://127.0.0.1:2019/config/ 2>/dev/null &&
        ! ops_compose exec -T prometheus wget -q -O /dev/null -T 5 http://caddy:2019/metrics 2>/dev/null; then
        pass "Caddy's admin endpoint still listens inside its container only"
    else
        fail "Caddy's admin endpoint is reachable from outside its container, or not running"
    fi
}

check_rerun() {
    local out rc=0
    out=$(ops_compose run --rm --no-deps ops-init 2>&1) || rc=$?
    if ((rc == 0)) && [[ $out == *"Done"* && $out != *"New password"* ]]; then
        pass "ops-init runs again without changes (same role password, exit 0)"
    else
        fail "ops-init did not run again cleanly (exit $rc)" "$(printf '%s' "$out" | tail -n 3 | tr '\n' ' ')"
    fi
    if wait_for 90 prom_true 'pg_up == 1'; then
        pass "postgres-exporter is still connected after the second run"
    else
        fail "postgres-exporter lost its connection after the second run of ops-init"
    fi
}

check_grafana() {
    local code body
    code=$(ops_curl /api/health -o /dev/null -w '%{http_code}' || true)
    if [[ $code == 401 ]]; then pass "https://$OPS_HOST/ asks for basic auth (401 without a password)"; else fail "Without a password the ops host answered $code (expected 401)"; fi
    code=$(ops_curl /api/health -o /dev/null -w '%{http_code}' -u "$OPS_USER:wrong-password" || true)
    if [[ $code == 401 ]]; then pass "A wrong password gets 401"; else fail "A wrong password got $code (expected 401)"; fi
    code=$(ops_curl /api/health -o /dev/null -w '%{http_code}' -H 'X-WEBAUTH-USER: admin' || true)
    if [[ $code == 401 ]]; then pass "A forged X-WEBAUTH-USER without a password gets 401"; else fail "A forged X-WEBAUTH-USER got $code"; fi
    body=$(ops_curl /api/user -u "$OPS_USER:$OPS_PASSWORD" -H 'X-WEBAUTH-USER: admin' || true)
    if [[ $(node -e 'try { process.stdout.write(JSON.parse(process.argv[1]).login) } catch { }' "$body") == "$OPS_USER" ]]; then
        pass "Grafana signs in the basic auth user $OPS_USER (a forged X-WEBAUTH-USER is replaced by Caddy)"
    else
        fail "Grafana did not sign in $OPS_USER: $(printf '%s' "$body" | head -c 200)"
    fi
    body=$(ops_curl /api/user/orgs -u "$OPS_USER:$OPS_PASSWORD" || true)
    if [[ $body == *'"role":"Viewer"'* ]]; then pass "The Grafana user has the Viewer role"; else fail "The Grafana user is not a Viewer: $(printf '%s' "$body" | head -c 200)"; fi
    body=$(ops_curl '/api/search?query=MSCD%20overview' -u "$OPS_USER:$OPS_PASSWORD" || true)
    if [[ $body == *'"uid":"mscd-overview"'* ]]; then pass "The provisioned dashboard MSCD overview is listed"; else fail "The dashboard is not listed: $(printf '%s' "$body" | head -c 200)"; fi
    body=$(ops_curl '/api/datasources/proxy/uid/prometheus/api/v1/query?query=up' -u "$OPS_USER:$OPS_PASSWORD" || true)
    if [[ $body == *'"status":"success"'* ]]; then pass "Grafana queries Prometheus over the mscd network"; else fail "Grafana could not query Prometheus: $(printf '%s' "$body" | head -c 200)"; fi
}

stack_test() {
    step "SaaS test stack (deploy/scripts/test/saas-stack.sh up)"
    STACK_STARTED=true
    MSCD_SAAS_TEST_PROJECT=$PROJECT MSCD_SAAS_TEST_DIR=$STATE bash "$SAAS_STACK" up ||
        die "saas-stack.sh up failed"
    HTTPS_PORT=$(kv_get "$STATE/.env" MSCD_HTTPS_PORT)
    write_test_files
    pass "Test settings, text files, probe module and test overlay written to $STATE/ops"
    start_ops

    title "MSCD monitoring overlay: checks"
    step "ops-init"
    check_init
    step "Networks, ports and limits"
    check_isolation
    step "Prometheus"
    check_prometheus
    step "Alerts, email and heartbeat"
    check_alerts
    step "Caddy"
    check_caddy_metrics
    step "Second run of ops-init"
    check_rerun
    if [[ $GRAFANA == true ]]; then
        step "Grafana on $OPS_HOST"
        check_grafana
    fi
}

cleanup() {
    local status=$?
    if [[ -n $WORK && -d $WORK ]]; then rm -rf -- "$WORK"; fi
    if [[ $STACK_STARTED == true ]]; then
        if [[ $KEEP == true ]]; then
            printf '\nStack kept (MSCD_OPS_TEST_KEEP=true). Remove it with:\n  MSCD_SAAS_TEST_PROJECT=%s MSCD_SAAS_TEST_DIR=%s %s down\n' \
                "$PROJECT" "$STATE" "$SAAS_STACK"
        else
            step "Removing the stack"
            if [[ -f $STATE/ops/compose.ops-test.yml && -f $STATE/.env ]]; then
                ops_compose down --volumes --remove-orphans --timeout 20 >/dev/null 2>&1 || true
            fi
            MSCD_SAAS_TEST_PROJECT=$PROJECT MSCD_SAAS_TEST_DIR=$STATE bash "$SAAS_STACK" down || status=1
        fi
    fi
    if ((status == 0 && FAILURES == 0)); then
        printf '\n%sEvery check passed.%s\n' "$C_GREEN$C_BOLD" "$C_RESET"
    elif ((FAILURES > 0)); then
        printf '\n%s%d check(s) failed.%s\n' "$C_RED" "$FAILURES" "$C_RESET"
        status=1
    fi
    exit "$status"
}

main() {
    local mode=full
    case "${1:-}" in
        '') ;;
        --static) mode=static ;;
        -h | --help) usage; exit 0 ;;
        *) printf 'Unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
    esac
    [[ $# -le 1 ]] || die "Use at most one option"
    [[ $PROJECT =~ ^[a-z0-9][a-z0-9_-]{0,40}$ ]] || die "MSCD_OPS_TEST_PROJECT must be lower-case letters, digits, '-' or '_', got '$PROJECT'"
    [[ $GRAFANA == true || $GRAFANA == false ]] || die "MSCD_OPS_TEST_GRAFANA must be true or false, got '$GRAFANA'"
    WORK=$(mktemp -d "${TMPDIR:-/tmp}/mscd-ops-check.XXXXXX")
    trap cleanup EXIT
    static_checks
    if [[ $mode == static ]]; then return 0; fi
    abort_if_failed
    for tool in curl openssl; do command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed"; done
    stack_test
}

main "$@"
