# MSCD backup tools image (Milestone 2 plan K.4, M2-S07): the PostgreSQL 16 client tools of the
# bundled database image (pg_dump, pg_restore, psql) plus restic and rclone from the Alpine
# packages. It holds tools only: the scripts come from deploy/backup, mounted read-only by
# docker-compose.backup.yml, so the image changes only when this file changes.
#
# deploy/backup/backup.sh builds it on the server when it is missing (deploy step "Off-site
# backup", the pre-deploy copy, the timer and restore.sh) and tags it mscd-backup:<first 12 hex
# characters of the SHA-256 of this file>. By hand, from any empty folder as the build context:
#
#   docker build -f deploy/docker/backup.Dockerfile --secret id=build_ca,src="$MSCD_BUILD_CA" \
#     -t mscd-backup:manual "$(mktemp -d)"
#
# MSCD_BUILD_CA names the CA certificate of a TLS-inspecting proxy between the build machine and
# the Alpine mirrors (R-12). Without such a proxy, point it to an empty file (BuildKit does not
# accept /dev/null); backup.sh does this by itself.
#
# Pins (S-5, R-06), each at least two weeks old on 28 October 2026:
#   - the base image by exact tag and the digest of its index: the build of 17 September 2026
#     (PostgreSQL 16.15 on Alpine 3.24.2). The tag postgres:16.15-alpine has moved to newer builds
#     since; the database service of the stack runs the same PostgreSQL version, so pg_dump and
#     pg_restore match it;
#   - restic 0.18.1-r9 and rclone 1.74.1-r3 of the Alpine 3.24 community repository, both built on
#     14 October 2026.
# Alpine keeps only the newest build of a package in its mirror, so a package pin stops working
# when Alpine rebuilds the package; the weekly restore test (restore-test.yml) builds this file
# and fails then. The fix is a pin update here (docs/saas/backup-restore.md, "Updating the backup
# tools"). The build arguments allow other versions for an emergency build.
#
# The image runs as the postgres user (70) of the base image; the backup overlay runs it as the
# owner of the off-site value files instead (the deploy account), never as root.

ARG BASE_IMAGE=postgres:16.15-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea
FROM ${BASE_IMAGE}

# Alpine 3.24 community packages.
ARG RESTIC_PKG_VERSION=0.18.1-r9
ARG RCLONE_PKG_VERSION=1.74.1-r3

RUN --mount=type=secret,id=build_ca \
    set -eu; \
    if [ -s /run/secrets/build_ca ]; then \
        cat /etc/ssl/certs/ca-certificates.crt /run/secrets/build_ca >/tmp/build-ca.pem; \
        export SSL_CERT_FILE=/tmp/build-ca.pem; \
    fi; \
    if ! apk add --no-cache "restic=${RESTIC_PKG_VERSION}" "rclone=${RCLONE_PKG_VERSION}"; then \
        echo "apk could not install restic=${RESTIC_PKG_VERSION} and rclone=${RCLONE_PKG_VERSION}. When the mirror is reachable, Alpine has replaced a pinned build: update RESTIC_PKG_VERSION and RCLONE_PKG_VERSION in deploy/docker/backup.Dockerfile (docs/saas/backup-restore.md, Updating the backup tools)." >&2; \
        exit 1; \
    fi; \
    rm -f /tmp/build-ca.pem; \
    restic version; \
    rclone version >/tmp/rclone-version; \
    head -n 1 /tmp/rclone-version; \
    rm -f /tmp/rclone-version; \
    pg_dump --version

LABEL org.opencontainers.image.title="mscd-backup" \
      org.opencontainers.image.description="MSCD backup tools: pg_dump 16, restic and rclone" \
      com.cyberlentera.mscd.component="backup"

ENV HOME=/tmp
USER 70:70
WORKDIR /tmp
ENTRYPOINT []
CMD ["restic", "version"]
