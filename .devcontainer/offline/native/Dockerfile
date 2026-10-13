FROM node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4 AS node-bootstrap
FROM ubuntu:26.04@sha256:f144425ff09be612d6d9ad965196e9cdc23dae1f42110a8a11a3e9a8198759f7 AS base
COPY --from=node-bootstrap /usr/local /usr/local
COPY --from=node-bootstrap /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN sed -i -E 's|^URIs:.*|URIs: https://snapshot.ubuntu.com/ubuntu/20261012T000000Z|' /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get -o Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt update \
    && apt-get -o Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt install --no-install-recommends -y ca-certificates curl git gnupg python3 gcc g++ make \
       zip unzip xz-utils zstd pkg-config binutils libzstd1 libedit2 libncurses6 zlib1g liblzma5 libssl-dev libyaml-dev libffi-dev libxml2-dev libonig-dev zlib1g-dev libcurl4-openssl-dev autoconf \
    && rm -rf /var/lib/apt/lists/*
ENV WORKBENCH_DEVCONTAINER=1 WORKBENCH_PREPARED=1
ENV XDG_CACHE_HOME=/opt/workbench/cache/xdg XDG_STATE_HOME=/opt/workbench/state
ENV WORKBENCH_CACHE_HOME=/opt/workbench/cache WORKBENCH_DATA_HOME=/opt/workbench/data WORKBENCH_STORAGE_ROOT=/opt/workbench/cache WORKBENCH_STORAGE_EXTERNAL=true \
    UV_CACHE_DIR=/opt/workbench/cache/uv UV_PYTHON_INSTALL_DIR=/opt/workbench/cache/uv-python/python \
    WORKBENCH_MAVEN_REPOSITORY=/opt/workbench/cache/downloads/maven WORKBENCH_COMPOSER_CACHE=/opt/workbench/cache/downloads/composer \
    GOMODCACHE=/opt/workbench/cache/go-mod GOCACHE=/tmp/go-build npm_config_cache=/opt/workbench/cache/npm PIP_CACHE_DIR=/opt/workbench/cache/pip \
    CARGO_HOME=/opt/workbench/cache/ci/cargo RUSTUP_HOME=/opt/workbench/cache/ci/rustup

FROM base AS preparation
WORKDIR /tmp/preparation
COPY . .
ARG TARGETARCH
RUN --mount=type=cache,id=workbench-native-${TARGETARCH},target=/opt/workbench,sharing=locked \
    node scripts/prepare-development.mjs native \
    && cp -a /opt/workbench /prepared-inputs \
    && rm -rf /prepared-inputs/cache/builds /prepared-inputs/cache/dependencies
FROM base
COPY --from=preparation --chown=ubuntu:ubuntu /prepared-inputs /opt/workbench
