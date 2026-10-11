FROM node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4 AS base
RUN apt-get update && apt-get install --no-install-recommends -y zstd gnupg && rm -rf /var/lib/apt/lists/*
ENV WORKBENCH_CACHE_HOME=/opt/workbench-cache GOMODCACHE=/opt/go-mod GOTOOLCHAIN=local CGO_ENABLED=0
FROM base AS preparation
WORKDIR /tmp/preparation
COPY package.json .node-version .tool-versions ./
COPY bin ./bin
COPY bundle ./bundle
COPY scripts ./scripts
COPY languages ./languages
COPY workbench/config.toml ./workbench/
COPY .devcontainer/offline/native/projects.toml ./workbench/projects.toml
COPY examples/languages/go/.go-version examples/languages/go/go.mod examples/languages/go/go.sum ./examples/languages/go/
COPY examples/languages/go/scripts/offline.mjs ./examples/languages/go/scripts/
RUN node bin/workbench.mjs tools install --path examples/languages/go --tool go \
    && node examples/languages/go/scripts/offline.mjs prepare native
FROM base
COPY --from=preparation --chown=node:node /opt/workbench-cache /opt/workbench-cache
COPY --from=preparation --chown=node:node /opt/go-mod /opt/go-mod
USER node
