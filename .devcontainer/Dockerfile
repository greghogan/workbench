FROM node:24-trixie@sha256:8c761eca2bf7eec965f946cf47b8090143cb41f45f2f8699af0cc0298d2d2d19 AS node-bootstrap
FROM ubuntu:26.04@sha256:6a06111c3b0a8600feadb270aec771dc239bf407b25625f93f44ab00e11f4d3c AS base
COPY --from=node-bootstrap /usr/local /usr/local
COPY --from=node-bootstrap /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN sed -i -E 's|^URIs:.*|URIs: https://snapshot.ubuntu.com/ubuntu/20261029T000000Z|' /etc/apt/sources.list.d/ubuntu.sources \
    && printf 'Acquire::Retries "3";\n' > /etc/apt/apt.conf.d/80workbench-retries \
    && apt-get -o Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt update \
    && apt-get -o Acquire::https::CaInfo=/etc/ssl/certs/ca-certificates.crt install --no-install-recommends -y ca-certificates curl git gnupg python3 gcc g++ make \
       zip unzip xz-utils zstd pkg-config binutils libzstd1 libedit2 libncurses6 zlib1g liblzma5 libssl-dev libyaml-dev libffi-dev libxml2-dev libonig-dev zlib1g-dev libcurl4-openssl-dev autoconf \
       libglib2.0-0t64 libnspr4 libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libdbus-1-3 \
       libx11-6 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxrandr2 libgbm1 libexpat1 libxcb1 libxkbcommon0 libudev1 libasound2t64 libatspi2.0-0t64 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
ENV WORKBENCH_DEVCONTAINER=1 WORKBENCH_PREPARED=1
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8
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
RUN --mount=type=secret,id=github_token,env=GH_TOKEN \
    --mount=type=cache,id=workbench-native-${TARGETARCH},target=/opt/workbench,sharing=locked \
    node scripts/prepare-development.mjs native \
    && cp -a /opt/workbench /prepared-inputs \
    && rm -rf /prepared-inputs/cache/builds /prepared-inputs/cache/dependencies \
    && node scripts/split-prepared-inputs.mjs /prepared-inputs /prepared-tools /prepared-dependencies
FROM base
COPY --from=preparation --chown=ubuntu:ubuntu /prepared-tools /opt/workbench
COPY --from=preparation --chown=ubuntu:ubuntu /prepared-dependencies /opt/workbench
