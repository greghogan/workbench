FROM node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4 AS bootstrap
FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
COPY --from=bootstrap /usr/local /usr/local
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8
RUN apt-get update \
    && apt-get install --no-install-recommends -y guix=1.4.0-6build1 git ca-certificates netbase \
    && rm -rf /var/lib/apt/lists/* \
    && for key in /usr/share/guix/*.pub; do guix archive --authorize < "$key"; done \
    && groupadd --system guixbuild \
    && for number in 1 2 3 4; do useradd --system --gid guixbuild --groups guixbuild --home-dir /var/empty --shell /usr/sbin/nologin "guixbuilder${number}"; done
# Avoid scanning Docker's potentially enormous descriptor limit on each child.
CMD ["/bin/sh", "-c", "ulimit -n 65536; exec guix-daemon --build-users-group=guixbuild --disable-chroot"]
