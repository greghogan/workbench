FROM nixos/nix@sha256:0d9c872db1ca2f3eaa4a095baa57ed9b72c09d53a0905a4428813f61f0ea98db
COPY examples/languages/go /tmp/reference
RUN nix --extra-experimental-features 'nix-command flakes' build --no-update-lock-file \
    --out-link /opt/workbench-bootstrap path:/tmp/reference#bootstrap \
    && rm -rf /tmp/reference \
    && for file in passwd group shadow; do cp -L "/etc/$file" "/tmp/$file"; rm "/etc/$file"; mv "/tmp/$file" "/etc/$file"; done \
    && /opt/workbench-bootstrap/bin/useradd --create-home --uid 1000 --shell /opt/workbench-bootstrap/bin/bash workbench \
    && ln -s "$(readlink -f /root/.nix-profile)" /opt/nix-runtime
ENV PATH="/opt/workbench-bootstrap/bin:/opt/nix-runtime/bin:${PATH}"
ENV NIX_SSL_CERT_FILE=/opt/workbench-bootstrap/etc/ssl/certs/ca-bundle.crt
CMD ["nix-daemon"]
