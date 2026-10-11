FROM node:24-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4

USER root
RUN apt-get update \
    && apt-get install --no-install-recommends -y zip=3.0-13+deb12u1 libssl-dev libyaml-dev libffi-dev libxml2-dev libonig-dev zlib1g-dev libcurl4-openssl-dev autoconf \
    && rm -rf /var/lib/apt/lists/*
USER node
