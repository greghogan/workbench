FROM node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4 AS bootstrap
FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
COPY --from=bootstrap /usr/local /usr/local
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8
RUN apt-get update && apt-get install --no-install-recommends -y guix=1.4.0-6build1 git ca-certificates netbase \
    && rm -rf /var/lib/apt/lists/* \
    && for key in /usr/share/guix/*.pub; do guix archive --authorize < "$key"; done \
    && groupadd --system guixbuild \
    && for number in 1 2 3 4; do useradd --system --gid guixbuild --groups guixbuild --home-dir /var/empty --shell /usr/sbin/nologin "guixbuilder${number}"; done
COPY examples/languages/go/channels.scm /tmp/reference/channels.scm
COPY scripts/ci-guix-bootstrap.scm /tmp/bootstrap.scm
# Keep the authenticated runtime reusable when project dependencies change.
RUN guix-daemon --build-users-group=guixbuild --disable-chroot & \
    daemon=$!; trap 'kill "$daemon"; wait "$daemon" || true' EXIT; \
    until guix gc --list-roots >/dev/null 2>&1; do sleep 1; done; \
    ln -s "$(guix repl /tmp/bootstrap.scm profile /tmp/reference/channels.scm 4)" /opt/workbench-guix \
    && rm /tmp/bootstrap.scm
COPY examples/languages/go/manifest.scm examples/languages/go/go.mod examples/languages/go/go.sum /tmp/reference/
RUN guix-daemon --build-users-group=guixbuild --disable-chroot & \
    daemon=$!; trap 'kill "$daemon"; wait "$daemon" || true' EXIT; \
    until guix gc --list-roots >/dev/null 2>&1; do sleep 1; done; \
    /opt/workbench-guix/bin/guix package -m /tmp/reference/manifest.scm -p /opt/workbench-development \
    && mkdir -p /opt/go-mod \
    && /opt/workbench-guix/bin/guix shell -m /tmp/reference/manifest.scm -- sh -c 'cd /tmp/reference; GOMODCACHE=/opt/go-mod GOTOOLCHAIN=local go mod download' \
    && chown -R ubuntu:ubuntu /opt/go-mod && rm -rf /tmp/reference
# Ordinary workspace users must not traverse root's private channel cache.
RUN ln -sfn "$(readlink -f /opt/workbench-guix)" /opt/workbench-guix
ENV WORKBENCH_GUIX_TIME_MACHINE_PROFILE=/opt/workbench-guix
ENV GOMODCACHE=/opt/go-mod GOTOOLCHAIN=local CGO_ENABLED=0
# The bootstrap daemon closes inherited descriptors by scanning its limit.
CMD ["/bin/sh", "-c", "ulimit -n 65536; exec guix-daemon --build-users-group=guixbuild --disable-chroot"]
