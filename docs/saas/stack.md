# The SaaS Compose stack and TLS

This guide explains how MSCD runs as a SaaS service on one server: which containers run, how a request reaches the application, how certificates are obtained and renewed, the request limits, the logs, and how to test the whole stack on a build machine. It belongs to work package M2-S02 of the [Milestone 2 plan](../platform/MILESTONE-2.md#m2-s02-saas-compose-stack-and-tls).

On a production or staging server you normally never type these commands yourself. The deploy workflow (`deploy-prod.yml`, M2-S05) writes the settings file and starts the stack. This guide tells you what it does, so you can read the logs and fix a problem.

## The files

| File | What it is |
|---|---|
| `deploy/compose/docker-compose.yml` | The on-premise stack: PostgreSQL, SeaweedFS (the object store), the storage gateway, the api, the worker, the web server (NGINX) and the one-shot `migrate` |
| `deploy/compose/docker-compose.saas.yml` | The SaaS overlay. It changes the on-premise stack for SaaS and adds Caddy in front |
| `deploy/compose/.env.saas.example` | Every setting of the SaaS stack with its default. The deploy writes the real `.env` from it |
| `deploy/compose/config/caddy/Caddyfile` | The Caddy configuration: certificates, HTTP to HTTPS redirect, HSTS, the access log and the way to the web server |
| `deploy/compose/config/caddy/conf.d/` | Optional extra hosts, such as `ops.<domain>` for the dashboards (M2-S08). Every `*.caddy` file here is loaded |
| `apps/server/profiles/saas.yaml` | The server profile: many organisations (tenancy `multi`), mail required, SMTP on port 587 |
| `deploy/nginx/` | The web server configuration inside the web image, including the request limits |
| `deploy/scripts/test/saas-stack.sh` | The test stack for a build machine (see [Testing the stack](#testing-the-stack)) |

The stack always starts with both Compose files and the settings file:

```bash
cd /path/to/deploy/compose
docker compose -f docker-compose.yml -f docker-compose.saas.yml --env-file .env up -d --wait
```

## What runs

| Service | Image | Job | Networks | Published ports | Memory limit |
|---|---|---|---|---|---|
| `caddy` | `caddy:2.11.7-alpine`, pinned by digest | TLS, certificates, redirect to HTTPS, HSTS | edge | 80/tcp, 443/tcp, 443/udp | 512 MB |
| `web` | `ghcr.io/mqusaeri/mscd-web@sha256:...` | The web app files and the way to the api (`/api/`), request limits | edge, mscd | none | 512 MB |
| `api` | `ghcr.io/mqusaeri/mscd-server@sha256:...` | The MSCD API | mscd, egress | none | 2 GB |
| `worker` | same server image | Background jobs (pg-boss) | mscd, egress | none | 2 GB |
| `storage-gateway` | same server image | Files in the object store and the customers' repositories | mscd, egress | none | 1 GB |
| `migrate` | same server image | Database changes, runs once before the api starts | mscd, egress | none | |
| `postgres` | `postgres:16.15-alpine` | The database | mscd | none | 4 GB |
| `objectstore` | `chrislusf/seaweedfs:4.48` | S3 object store for Managed Vault files | mscd | none | 2 GB |
| `cli` | same server image | Operator commands with `docker compose run --rm cli ...`; never starts by itself | mscd, egress | none | |

The MSCD images are always named by digest, never by tag. A tag can be moved to another image; a digest names exactly the image that was built, scanned and signed by the release workflow (M2-S01). Compose pulls an image only when the server does not have it yet (`pull_policy: missing`); the deploy pulls and verifies the images before it starts the stack.

PostgreSQL gets settings that fit its 4 GB limit: `shared_buffers=1GB`, `effective_cache_size=3GB`, `work_mem=16MB`, `maintenance_work_mem=512MB`, `wal_compression=on`, and every statement slower than 500 ms is written to its log. It also gets 1 GB of shared memory (`shm_size`). Background jobs stay in PostgreSQL (pg-boss); Valkey does not run.

**Only Caddy publishes ports.** Docker writes its own firewall rules for every published port, and these rules come before the host firewall (ufw). A port published by any other container would be open to the internet whatever ufw says. Never add a `ports:` entry to another service. [bootstrap.md](bootstrap.md) explains this in more detail.

## How a request travels

1. The browser connects to `https://app.<domain>`. Caddy answers with the certificate it got from Let's Encrypt. A request on plain HTTP (port 80) gets a permanent redirect (308) to HTTPS.
2. Caddy passes the request to the web container, by its fixed IPv4 address on the `edge` network, and sets the header `X-Forwarded-For` to the address the browser connected from. A value the browser sent itself is thrown away, so nobody can pretend to come from another address. Caddy limits the request body to the upload limit plus 1 MiB (413 above it), adds HSTS, and removes the `Server` and `Via` headers from the answer.
3. The web server (NGINX) trusts `X-Forwarded-For` only when the request comes from Caddy's fixed address (`MSCD_TRUSTED_PROXY_CIDRS`). It applies the request limits per client address, serves the app files and passes `/api/` to the api.
4. The api trusts `X-Forwarded-For` only from the web container's fixed address on the internal `mscd` network (`MSCD__HTTP__TRUST_PROXY`). The api never trusts Caddy directly.

So each hop trusts exactly one address in front of it, and the client address in the api's logs, audit entries and rate limits is the browser's address.

The `edge` network holds only Caddy and the web container, on fixed addresses inside `172.31.0.0/16`, the range that the Docker address pools of [bootstrap.md](bootstrap.md) keep free. The `mscd` network is internal: nothing on it can reach the internet. The `egress` network carries the outgoing connections of the api, worker and storage gateway (mail provider, identity providers, Microsoft 365 and Google Drive).

## Settings

The deploy writes `.env` from `.env.saas.example`. These are the settings and what they do.

| Setting | Default | Meaning |
|---|---|---|
| `COMPOSE_PROFILES` | `bundled-db,bundled-s3` | Start the bundled PostgreSQL and object store |
| `MSCD_SERVER_IMAGE`, `MSCD_SERVER_DIGEST` | `ghcr.io/mqusaeri/mscd-server`, the release digest | The server image of the release (`server` in `digests.json`) |
| `MSCD_IMAGE`, `MSCD_WEB_DIGEST` | `ghcr.io/mqusaeri/mscd-web`, the release digest | The web image of the release (`web` in `digests.json`) |
| `MSCD_PROFILE_FILE` | `/app/apps/server/profiles/saas.yaml` | The server profile. The overlay uses `saas.yaml` when the setting is missing, never the on-premise profile |
| `MSCD_DOMAIN` | `app.example.com` | The host name of the app, the same for every organisation (decision D-S3) |
| `MSCD_PUBLIC_URL` | `https://app.example.com` | The address in emails and sign-in redirects: `https://` and `MSCD_DOMAIN` |
| `MSCD_SITE_DOMAIN`, `MSCD_SITE_DIR` | empty, `./site` | The marketing site on the bare domain, see [The marketing site](#the-marketing-site) |
| `MSCD_TLS_MODE` | `acme` | `acme`: certificates from Let's Encrypt. `internal`: Caddy's own local certificate authority, for test stacks only |
| `ACME_EMAIL` | `ops@example.com` | The email address of the Let's Encrypt account. Let's Encrypt writes to it about problems with the account |
| `ACME_CA` | Let's Encrypt staging | The ACME directory. See [Certificates](#certificates) |
| `MSCD_MAIL_FROM`, `MSCD_SMTP_HOST`, `MSCD_SMTP_PORT`, `MSCD_SMTP_SECURE`, `MSCD_SMTP_USER`, `MSCD_SMTP_PASSWORD_FILE` | port 587, `secure` false | The mail provider. Port 587 starts in plain text and switches to TLS with STARTTLS before the login. The password is in the secret file `smtp.password` |
| `MSCD_SECRETS_DIR` | `/opt/mscd/secrets` | The folder with the secret files (keys, database passwords, certificates of the storage gateway) |
| `MSCD_SUBNET`, `MSCD_WEB_ADDRESS` | `172.31.250.0/24`, `172.31.250.10` | The internal network and the web address that the api trusts |
| `MSCD_EDGE_SUBNET`, `MSCD_CADDY_ADDRESS`, `MSCD_WEB_EDGE_ADDRESS` | `172.31.251.0/24`, `.2`, `.3` | The edge network, Caddy's address (trusted by NGINX) and the web address that Caddy sends to |
| `MSCD_EDGE_IPV6`, `MSCD_EDGE_SUBNET6` | `true`, `fd6d:7363:6400:1::/64` | IPv6 on the edge network, see [IPv6](#ipv6) |
| `MSCD_RATE_LIMITS` and `MSCD_RATE_*` | on, see below | The request limits of the web server, see [Request limits](#request-limits) |
| `MSCD_MAX_REQUEST_BYTES` | `105906176` | The largest request body Caddy accepts: the upload limit of `saas.yaml` (100 MiB) plus 1 MiB. Larger requests get 413 |
| `MSCD_POSTGRES_MEMORY`, `MSCD_OBJECTSTORE_MEMORY`, `MSCD_API_MEMORY`, `MSCD_WORKER_MEMORY`, `MSCD_GATEWAY_MEMORY`, `MSCD_WEB_MEMORY`, `MSCD_CADDY_MEMORY` | 4G, 2G, 2G, 2G, 1G, 512M, 512M | Memory limits per container, for a server with 16 GB of RAM. Together 12 GB, which leaves room for the operating system, the backups and the monitoring |
| `MSCD_JOBS_DRIVER`, `MSCD_LOG_LEVEL` | `pgboss`, `info` | Job queue and log level of the MSCD services |

The settings file has no organisation in it. Organisations are created by the platform operator in the browser.

The server profile `saas.yaml` keeps its own values for the trusted proxy and the public address (they serve the Helm chart); the Compose stack sets both through environment variables, as the comments at the top of the profile say. The audit anchor key stays at `/run/secrets/audit-anchor.key`, read by the worker only.

## Certificates

Caddy gets a certificate for `MSCD_DOMAIN` (and for `MSCD_SITE_DOMAIN` when it is set) from Let's Encrypt with the HTTP-01 challenge: Let's Encrypt asks for a file on `http://<domain>/.well-known/acme-challenge/` and Caddy answers it on port 80. Caddy renews each certificate about 30 days before it expires, by itself. Nothing else is needed, but these must be true:

- The DNS records point to the server: `A` (and `AAAA` when the server has IPv6) for `app.<domain>`, and a `CAA` record `0 issue "letsencrypt.org"` on the domain ([bootstrap.md](bootstrap.md#dns-records)).
- Ports 80 and 443 are open in the firewall and at the provider. Port 80 must stay open: renewals need it, and it redirects visitors to HTTPS.

**First run: start with the staging certificate authority.** The example settings use `https://acme-staging-v02.api.letsencrypt.org/directory`. Its certificates are not trusted by browsers, but its limits are high, so a wrong DNS record or a closed port does not use up the weekly limits of the real service. When the first deploy shows a certificate in the Caddy log ("certificate obtained successfully"), change `ACME_CA` to `https://acme-v02.api.letsencrypt.org/directory` and deploy again. Caddy then gets a trusted certificate.

The certificates, the Let's Encrypt account key and Caddy's local certificate authority are in the volume `caddy_data`. Keep it: without it, Caddy asks for new certificates at every start and can reach the limits of Let's Encrypt.

`MSCD_TLS_MODE=internal` makes Caddy use its own local certificate authority. Browsers do not trust it. It is only for the test stack on a build machine, where Let's Encrypt cannot reach the host.

## HSTS

Every answer on the app host carries `Strict-Transport-Security: max-age=31536000; includeSubDomains`. A browser that saw it once uses only HTTPS for `app.<domain>` and every name under it for one year, even when someone types `http://`. The `preload` flag is not set, so the domain is not built into browsers, and a change stays possible.

The marketing site on the bare domain gets `max-age=31536000` without `includeSubDomains`, because other names under the bare domain (for example a mail server or an intranet) may not serve HTTPS. Add `includeSubDomains` there only when every name under the domain serves HTTPS.

The web server inside does not send HSTS itself (`MSCD_HSTS=false`); Caddy sends it.

## Request limits

The web server (NGINX) limits the requests per client address under `/api/`:

| Path | Limit per address | Extra requests accepted at once (burst) | Setting |
|---|---|---|---|
| `/api/v1/auth/` (sign-in, MFA, password reset, invitations) | 10 per second | 20 | `MSCD_RATE_AUTH`, `MSCD_RATE_AUTH_BURST` |
| every path under `/api/`, sign-in included | 50 per second | 100 | `MSCD_RATE_API`, `MSCD_RATE_API_BURST` |
| requests to `/api/` in progress at the same time | 50 | | `MSCD_RATE_CONN` |

A request over a limit gets `429 Too many requests` with a problem body (`https://mscd.cyberlentera.com/problems/rate-limited`), the same security headers as the api's own problem answers, and `Retry-After: 1`. The app files themselves (pages, scripts, images) are not limited.

The limits are generous on purpose. In Indonesia many offices reach the internet through one carrier NAT address, so a whole office shares one limit. The api has its own, tighter limits per email address and per account for sign-in, MFA and password reset; those stay the main guard against password guessing, and the NGINX limits only stop floods from one address.

To change a limit, change the setting in the GitHub environment (the deploy writes it to `.env`) and deploy again. `MSCD_RATE_LIMITS=false` turns the limits off. On-premise installations keep the limits off unless `MSCD_RATE_LIMITS=true` is set for the web container.

## Logs

Every container writes its log with the Docker driver `local`: at most 10 files of 20 MB each per container, compressed, kept on the server's data volume. Read them with:

```bash
docker compose -f docker-compose.yml -f docker-compose.saas.yml --env-file .env logs --since 1h caddy web api
```

Caddy writes one JSON line per request. The query string is removed from the request address, from the `Referer` header and from the `Location` header of redirects, because it can hold a sign-in code, an invitation or a password reset token. Caddy also writes `Cookie`, `Set-Cookie` and `Authorization` as `REDACTED`, and the CSRF token header is left out. The web server writes its own access line with the sensitive query values replaced by `[redacted]`, and the client address from Caddy. The request id (`X-Request-Id`) links the NGINX line to the api's log and audit entries.

How many days the logs cover depends on traffic. Measure it after the first month and write it in [records-of-processing.md](records-of-processing.md).

## IPv6

When the server has an IPv6 address and the DNS has an `AAAA` record, browsers often connect over IPv6. With `MSCD_EDGE_IPV6=true` (the default of the example settings) the edge network has IPv6 too, so Docker passes each IPv6 client to Caddy with its own address. Without it, Docker forwards IPv6 connections through a helper process, every IPv6 client then reaches Caddy from one internal address, and all of them share one request limit and one address in the logs.

Caddy always reaches the web server over IPv4, at its fixed address, so the trust between them does not depend on IPv6. Set `MSCD_EDGE_IPV6=false` only on a server without IPv6, and then publish no `AAAA` record.

## The marketing site

Caddy can also serve the public marketing site of `apps/site` (see [site.md](../site.md)) on the bare domain, while the app stays on `app.<domain>`:

1. Copy `apps/site/index.html`, `apps/site/id/` and `apps/site/assets/` into the folder named by `MSCD_SITE_DIR` (the tools of `apps/site`, such as `check.mjs` and `media-src/`, are never copied; Caddy answers 404 for them all the same).
2. Set `MSCD_SITE_DOMAIN` to the bare domain, for example `example.com`, and add its `A` and `AAAA` records.
3. Start the stack again. Caddy gets a certificate for the bare domain too.

The site gets its own Content-Security-Policy (only files of the site itself), `X-Content-Type-Options`, frame blocking, HSTS without `includeSubDomains`, compression, and a cache time of one week for `/assets/`. With an empty `MSCD_SITE_DOMAIN` the site is off and the bare domain is not served by this server.

## Starting, updating and stopping by hand

Normally the deploy workflow does this. By hand, on the server, in the folder of the Compose files:

```bash
C="docker compose -f docker-compose.yml -f docker-compose.saas.yml --env-file .env"
$C config -q                       # check the files and the settings
$C up -d --wait                    # start or update; migrate runs first
$C ps                              # state of every service
$C run --rm cli --help             # operator commands
$C up -d --force-recreate caddy    # load a changed Caddyfile or conf.d file
$C down                            # stop (volumes, and so the data, are kept)
```

Never run `down -v` on a server: it deletes the database, the object store and the certificates.

## Decisions

| # | Decision | What is built |
|---|---|---|
| D-S3 | Public address | One host name `app.<domain>` for every organisation. The sign-in page finds the organisation by `?org=` or by email (M2-S11) |
| D-S8 | CDN or web application firewall in front of the server | None at the start. Caddy is the only entry point, with the NGINX request limits behind it. The decision is reviewed after the penetration test. A CDN in front would need Caddy to trust the CDN's addresses for `X-Forwarded-For` |

## Testing the stack

`deploy/scripts/test/saas-stack.sh` runs the same Compose files on a build machine, with throwaway keys and test certificates. It uses the ports 18080 and 18443 on `127.0.0.1`, like the other test stacks, so it runs under the host lock:

```bash
flock /tmp/mscd-stack.lock bash -c 'bash deploy/scripts/test/saas-stack.sh up &&
  bash deploy/scripts/test/saas-stack.sh check; s=$?; bash deploy/scripts/test/saas-stack.sh down; exit $s'
```

`up` makes a throwaway release key set with `saas-keys.sh`, builds the release images with it, writes `.env` from `.env.saas.example` with `MSCD_TLS_MODE=internal` and `MSCD_DOMAIN=localhost`, serves the marketing site on `site.localhost`, adds Mailpit as the mail relay (without a published port), starts the stack and copies Caddy's local root certificate to `/tmp/mscd-saas-test/caddy-root.crt`. With that file, `curl` trusts the test certificate:

```bash
curl --cacert /tmp/mscd-saas-test/caddy-root.crt https://localhost:18443/healthz
```

`check` asserts:

- the server runs with tenancy mode `multi` (read through the `cli` service) and is a release build;
- only Caddy publishes ports, and it publishes 80/tcp, 443/tcp and 443/udp;
- `/healthz` answers 200 with Caddy's certificate, `http://localhost:18080/` answers 308, and the app sends HSTS, its Content-Security-Policy and frame blocking, and loads no external fonts;
- 80 requests at once to `/api/v1/auth/` get 429 answers with the problem body;
- a forged `X-Forwarded-For` is replaced: NGINX logs the address Caddy saw, and no query string value reaches the Caddy or NGINX log;
- `/api/v1/system/profile` reports `saas`, and the marketing site answers with its own headers while `check.mjs` answers 404;
- after a new organisation is created and the audit anchor job (`audit.verify-chain`) runs, the worker has signed an anchor and its log has no line "not among the anchor keys compiled into this build". This proves that the anchor key on the server matches the key built into the release image.

`down` removes the containers, networks, volumes, every image under `localhost/<project>/` (the two test images, also when a failed build left them behind) and `/tmp/mscd-saas-test`. It then checks that nothing is left and names whatever it could not remove.

| Setting | Default | Meaning |
|---|---|---|
| `MSCD_SAAS_TEST_PROJECT` | `mscd-saas-test` | Compose project name, also used in the test image names |
| `MSCD_SAAS_TEST_DIR` | `/tmp/mscd-saas-test` | Keys, secrets, `.env`, logs and `caddy-root.crt`; deleted by `down`. Must be a folder below `/tmp`, `/var/tmp` or `$TMPDIR`, written as a plain absolute path: no `.` or `..` part, no `//` and no final `/` |
| `MSCD_SAAS_TEST_HTTP_PORT`, `MSCD_SAAS_TEST_HTTPS_PORT` | 18080, 18443 | Ports on `127.0.0.1` |
| `MSCD_SAAS_TEST_SCAN` | `gate` | `gate` builds with `build-release-images.sh` and its vulnerability gate. `auto` is for build machines that cannot reach the Alpine package mirrors: the gate still applies when the Alpine updates could be applied, and the scan only reports when they could not. Test images are never pushed |
| `MSCD_SAAS_TEST_KEEP_IMAGES` | `false` | `true` keeps the test images under `localhost/<project>/` after `down` |
| `MSCD_BUILD_CA` | empty | The certificate of a TLS-inspecting proxy for the image builds |

When the networks `172.31.250.0/24` or `172.31.251.0/24` are already used by another Docker network on the build machine, `up` picks two free `172.31.x.0/24` ranges.

## Troubleshooting

| What you see | Likely cause | What to do |
|---|---|---|
| Caddy log: "challenge failed", "Timeout during connect" or "NXDOMAIN" | DNS does not point to the server yet, or port 80 is closed | Check the `A` record (`dig app.<domain>`) and that port 80 is open at the provider and in ufw. Stay on the staging CA until it works |
| Caddy log: "too many certificates already issued" | The Let's Encrypt limits were reached, often after the `caddy_data` volume was lost | Wait for the time in the message, keep `caddy_data`, use the staging CA for tests |
| Browser warning about the certificate after the first deploy | `ACME_CA` is still the staging CA | Change it to `https://acme-v02.api.letsencrypt.org/directory` and deploy again |
| Caddy stops at start with "File to import not found: mscd_tls_..." | `MSCD_TLS_MODE` is not `acme` or `internal` | Fix the setting |
| 503 "MSCD is not reachable at the moment" | The web container did not answer within 30 seconds (restart, crash) | `$C ps` and `$C logs web api` |
| Users of one office get 429 | The office shares one address and goes over the limits | Look for `429` in the web log for that address; raise `MSCD_RATE_API` and `MSCD_RATE_API_BURST` (or the `AUTH` pair) and deploy |
| All IPv6 users share one address in the logs | `MSCD_EDGE_IPV6` is false on a server with IPv6 | Set it to true, or remove the `AAAA` record |
| `docker compose config` says "set MSCD_SERVER_DIGEST" or another setting | A required setting is missing in `.env` | Deploy again with the workflow; it writes every setting |
