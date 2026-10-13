FROM node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4 AS bootstrap
FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55 AS base
COPY --from=bootstrap /usr/local /usr/local
COPY --from=bootstrap /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8
RUN sed -i -E 's|^URIs:.*|URIs: https://snapshot.ubuntu.com/ubuntu/20261012T000000Z|' /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get -o Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt update && apt-get -o Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt install --no-install-recommends -y guix=1.4.0-6build1 git ca-certificates netbase \
    && rm -rf /var/lib/apt/lists/* \
    && for key in /usr/share/guix/*.pub; do guix archive --authorize < "$key"; done \
    && groupadd --system guixbuild \
    && for number in 1 2 3 4; do useradd --system --gid guixbuild --groups guixbuild --home-dir /var/empty --shell /usr/sbin/nologin "guixbuilder${number}"; done
COPY channels.scm /tmp/reference/channels.scm
COPY scripts/ci-guix-bootstrap.scm /tmp/bootstrap.scm
# Fetch the same authenticated channel history from the project-maintained public mirror.
# The commit and introduction remain those in channels.scm.
RUN sed -i 's|https://codeberg.org/guix/guix.git|https://github.com/foss-mirror/guix.git|' /tmp/reference/channels.scm
# Keep the authenticated runtime reusable when project dependencies change.
RUN guix-daemon --build-users-group=guixbuild --disable-chroot & \
    daemon=$!; trap 'kill "$daemon"; wait "$daemon" || true' EXIT; \
    until guix gc --list-roots >/dev/null 2>&1; do sleep 1; done; \
    ln -s "$(guix repl /tmp/bootstrap.scm profile /tmp/reference/channels.scm 4)" /opt/workbench-guix \
    && rm /tmp/bootstrap.scm
RUN ln -sfn "$(readlink -f /opt/workbench-guix)" /opt/workbench-guix
ENV WORKBENCH_GUIX_TIME_MACHINE_PROFILE=/opt/workbench-guix
ENV WORKBENCH_DEVCONTAINER=1 WORKBENCH_PREPARED=1
ENV XDG_CACHE_HOME=/opt/workbench/cache/xdg XDG_STATE_HOME=/opt/workbench/state
ENV WORKBENCH_CACHE_HOME=/opt/workbench/cache WORKBENCH_DATA_HOME=/opt/workbench/data WORKBENCH_STORAGE_ROOT=/opt/workbench/cache WORKBENCH_STORAGE_EXTERNAL=true \
    UV_CACHE_DIR=/opt/workbench/cache/uv UV_PYTHON_INSTALL_DIR=/opt/workbench/cache/uv-python/python \
    WORKBENCH_MAVEN_REPOSITORY=/opt/workbench/cache/downloads/maven WORKBENCH_COMPOSER_CACHE=/opt/workbench/cache/downloads/composer \
    GOMODCACHE=/opt/workbench/cache/go-mod GOCACHE=/tmp/go-build npm_config_cache=/opt/workbench/cache/npm PIP_CACHE_DIR=/opt/workbench/cache/pip \
    CARGO_HOME=/opt/workbench/cache/ci/cargo RUSTUP_HOME=/opt/workbench/cache/ci/rustup

FROM base
WORKDIR /tmp/preparation
COPY . .
RUN guix-daemon --build-users-group=guixbuild --disable-chroot & \
    daemon=$!; trap 'kill "$daemon"; wait "$daemon" || true' EXIT; \
    until guix gc --list-roots >/dev/null 2>&1; do sleep 1; done; \
    node scripts/prepare-development.mjs guix \
    && rm -rf /tmp/preparation /tmp/go-build /opt/workbench/cache/builds /opt/workbench/cache/dependencies \
    && chown -R ubuntu:ubuntu /opt/workbench
WORKDIR /
CMD ["/bin/sh", "-c", "ulimit -n 65536; exec guix-daemon --build-users-group=guixbuild --disable-chroot"]
