FROM ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y \
       ca-certificates git curl zip unzip xz-utils zstd python3 gcc g++ make pkg-config binutils \
       libxml2 libzstd1 libedit2 libncurses6 \
    && rm -rf /var/lib/apt/lists/*
RUN printf '%s\n' \
      'deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] https://archive.ubuntu.com/ubuntu jammy main' \
      > /etc/apt/sources.list.d/icu70.list \
    && printf '%s\n' 'Package: *' 'Pin: release n=jammy' 'Pin-Priority: -1' \
      '' 'Package: libicu70' 'Pin: release n=jammy' 'Pin-Priority: 100' \
      > /etc/apt/preferences.d/icu70 \
    && apt-get update \
    && cd /tmp \
    && apt-get download libicu70=70.1-2 \
    && printf '%s\n' '58a154f6307289813da2276f900498ef536ae7c0522d2cf31a3c3c5cf62dfd9a  libicu70_70.1-2_amd64.deb' | sha256sum --check \
    && apt-get install --no-install-recommends -y ./libicu70_70.1-2_amd64.deb \
    && rm -f /tmp/libicu70_70.1-2_amd64.deb /etc/apt/sources.list.d/icu70.list /etc/apt/preferences.d/icu70 \
    && rm -rf /var/lib/apt/lists/*
