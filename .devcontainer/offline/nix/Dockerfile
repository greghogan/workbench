FROM nixos/nix@sha256:0d9c872db1ca2f3eaa4a095baa57ed9b72c09d53a0905a4428813f61f0ea98db
COPY examples/languages/go/flake.nix examples/languages/go/flake.lock examples/languages/go/go.mod examples/languages/go/go.sum /tmp/reference/
RUN nix --extra-experimental-features 'nix-command flakes' build --no-update-lock-file \
    --out-link /opt/workbench-bootstrap path:/tmp/reference#bootstrap \
    && nix --extra-experimental-features 'nix-command flakes' flake archive --no-update-lock-file path:/tmp/reference \
    && nix --extra-experimental-features 'nix-command flakes' develop --no-update-lock-file --profile /opt/workbench-development path:/tmp/reference --command true \
    && for file in passwd group shadow; do cp -L "/etc/$file" "/tmp/$file"; rm "/etc/$file"; mv "/tmp/$file" "/etc/$file"; done \
    && /opt/workbench-bootstrap/bin/useradd --create-home --uid 1000 --shell /opt/workbench-bootstrap/bin/bash workbench \
    && ln -s "$(readlink -f /root/.nix-profile)" /opt/nix-runtime \
    && mkdir -p /opt/go-mod \
    && nix --extra-experimental-features 'nix-command flakes' develop --no-update-lock-file path:/tmp/reference --command sh -c 'cd /tmp/reference; GOMODCACHE=/opt/go-mod GOTOOLCHAIN=local go mod download' \
    && chown -R workbench /opt/go-mod && rm -rf /tmp/reference
RUN printf 'ID=nix\nNAME="Nix development container"\n' > /etc/os-release
ENV PATH="/opt/workbench-bootstrap/bin:/opt/nix-runtime/bin:${PATH}" NIX_SSL_CERT_FILE=/opt/workbench-bootstrap/etc/ssl/certs/ca-bundle.crt GOMODCACHE=/opt/go-mod GOTOOLCHAIN=local CGO_ENABLED=0
CMD ["nix-daemon"]
