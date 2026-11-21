FROM node:24-trixie@sha256:6e5d4c38403930b420404f190be8563396dca2bd156a6cb4722707b0efcf6fc1 AS bootstrap
FROM ubuntu:24.04@sha256:9c7f200c07e3d4a03e7249d2c16bf66a51120fb876aa2242cf31451412543289 AS base
COPY --from=bootstrap /usr/local /usr/local
COPY --from=bootstrap /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8
RUN printf 'Acquire::Retries "3";\nAPT::Update::Error-Mode "any";\n' > /etc/apt/apt.conf.d/80workbench-retries \
    && apt-get -o Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt update && apt-get -o Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt upgrade --no-install-recommends -y && apt-get -o Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt install --no-install-recommends -y guix git ca-certificates netbase \
    && mkdir -p /usr/local/share/workbench \
    && dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\n' > /usr/local/share/workbench/os-packages.tsv \
    && rm -rf /var/lib/apt/lists/* \
    && for key in /usr/share/guix/*.pub; do guix archive --authorize < "$key"; done \
    && groupadd --system guixbuild \
    && for number in 1 2 3 4; do useradd --system --gid guixbuild --groups guixbuild --home-dir /var/empty --shell /usr/sbin/nologin "guixbuilder${number}"; done
ARG WORKBENCH_GUIX_CHANNELS=channels.scm
COPY ${WORKBENCH_GUIX_CHANNELS} /tmp/reference/channels.scm
COPY scripts/ci-guix-bootstrap.scm /tmp/bootstrap.scm
# Keep the authenticated runtime reusable when project dependencies change.
RUN guix-daemon --build-users-group=guixbuild --disable-chroot & \
    daemon=$!; trap 'kill "$daemon"; wait "$daemon" || true' EXIT; \
    until guix gc --list-roots >/dev/null 2>&1; do sleep 1; done; \
    ln -s "$(guix repl /tmp/bootstrap.scm profile /tmp/reference/channels.scm "$(nproc)")" /opt/workbench-guix \
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

RUN for number in $(seq 5 "$(nproc)"); do useradd --system --gid guixbuild --groups guixbuild --home-dir /var/empty --shell /usr/sbin/nologin "guixbuilder${number}"; done
