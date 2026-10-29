# Composer archive and bootstrap updates

Use the verified `php-package-manager-exec` adapter and Composer's requested package selection. Inspect the configured
`dependency-lock` role before invoking `workbench check --role dependency-lock --path ROOT`: the reference refreshes its
application and two tool graphs. Preserve narrower requested scope instead of running that wholesale. Refresh every
affected lock and archive checksum catalog together. Explicit checksum recording uses
`WORKBENCH_COMPOSER_RECORD_CHECKSUMS=true`; ordinary installs must never set it.

Require SHA-256 verification of distribution archives through the local Composer plugin; do not permit source-install
fallback or bypass missing hashes. Do not substitute an unverified Composer or Xdebug download. Update pinned bootstrap
metadata and signatures together when the requested scope includes those tools.
