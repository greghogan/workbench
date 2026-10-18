ARG BASE_IMAGE
FROM ${BASE_IMAGE}
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates curl git gnupg python3 gcc g++ make \
       zip unzip xz-utils zstd pkg-config binutils libzstd1 libedit2 libncurses6 zlib1g liblzma5 libssl-dev libyaml-dev libffi-dev libxml2-dev libonig-dev zlib1g-dev libcurl4-openssl-dev autoconf \
    && rm -rf /var/lib/apt/lists/*
COPY bootstrap.json node.asc bootstrap.py /tmp/bootstrap/
RUN python3 /tmp/bootstrap/bootstrap.py /tmp/bootstrap/bootstrap.json /opt/node \
    && cp -a /opt/node/. /usr/local/ \
    && rm -rf /opt/node /tmp/bootstrap
