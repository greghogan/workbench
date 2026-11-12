# Tool acquisition and dependencies

- `scripts/package-manager`: retains the shared npm bootstrap manifest and lockfile for pnpm and its platform packages.
- `scripts/container-tools`: selects and installs the independently locked Dev Container CLI without Workbench's development dependencies.
- `scripts/native-assets.json`, `scripts/llvm-assets.json`, `scripts/bootstrap-tools.json`: verifies upstream artifacts and safely publishes installations; scripts/native-assets.json, scripts/llvm-assets.json, and scripts/bootstrap-tools.json record verified acquisition metadata.
- `scripts/keys/README.md`: records pinned public trust material and proof availability.
- `scripts/keys`: retains the artifact verification keys and Sigstore trust roots used by the verified installer.
- `scripts/php-coverage.php`: translates PHPUnit production coverage into compact summaries.
- `bundle/attestation-verification.cjs`: Load the Sigstore verifier only when attestation authentication requests it, keeping the bootstrap runtime independent of its newer Node requirement.
