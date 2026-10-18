FROM nixos/nix@sha256:f159a58f390677f41e8e900a74b6e2f9c7f27b364122ae6acf7a652ce6c551c0 AS base
COPY flake.nix flake.lock /tmp/bootstrap/
RUN nix --extra-experimental-features 'nix-command flakes' build --no-update-lock-file \
    --out-link /opt/workbench-bootstrap path:/tmp/bootstrap#bootstrap \
    && for file in passwd group shadow; do cp -L "/etc/$file" "/tmp/$file"; rm "/etc/$file"; mv "/tmp/$file" "/etc/$file"; done \
    && /opt/workbench-bootstrap/bin/useradd --create-home --uid 1000 --shell /opt/workbench-bootstrap/bin/bash workbench \
    && ln -s "$(readlink -f /root/.nix-profile)" /opt/nix-runtime
RUN printf 'ID=nix\nNAME="Nix development container"\n' > /etc/os-release
ENV PATH="/opt/workbench-bootstrap/bin:/opt/nix-runtime/bin:${PATH}" NIX_SSL_CERT_FILE=/opt/workbench-bootstrap/etc/ssl/certs/ca-bundle.crt
ENV WORKBENCH_DEVCONTAINER=1 WORKBENCH_PREPARED=1
ENV XDG_CACHE_HOME=/opt/workbench/cache/xdg XDG_STATE_HOME=/opt/workbench/state
ENV WORKBENCH_CACHE_HOME=/opt/workbench/cache WORKBENCH_DATA_HOME=/opt/workbench/data WORKBENCH_STORAGE_ROOT=/opt/workbench/cache WORKBENCH_STORAGE_EXTERNAL=true \
    UV_CACHE_DIR=/opt/workbench/cache/uv UV_PYTHON_INSTALL_DIR=/opt/workbench/cache/uv-python/python \
    WORKBENCH_MAVEN_REPOSITORY=/opt/workbench/cache/downloads/maven WORKBENCH_COMPOSER_CACHE=/opt/workbench/cache/downloads/composer \
    GOMODCACHE=/opt/workbench/cache/go-mod GOCACHE=/tmp/go-build npm_config_cache=/opt/workbench/cache/npm PIP_CACHE_DIR=/opt/workbench/cache/pip \
    CARGO_HOME=/opt/workbench/cache/ci/cargo RUSTUP_HOME=/opt/workbench/cache/ci/rustup
