---
name: php-dependency-refresh
description:
  Refresh existing Composer dependencies and locked PHP tool graphs in a registered Workbench PHP root on request;
  preserve narrower inspection and targeted scope, and do not add or remove direct dependencies.
---

# PHP dependency refresh

Read the project's decision map and PHP decision. Inspect its registered language definition, Composer manifests and
locks, `.composer-version`, `.xdebug-version`, and reviewed `.composer/checksums.json` catalogs. Keep application and
tool runtime requirements distinct. Do not change the application's baseline, Nix input, or Guix channel without a human
request covering that change.

For inspection, report available stable updates without changing files. For a requested update, use the verified
`php-package-manager-exec` adapter, Composer's own update operation and its requested package selection. Refresh every
affected lock and archive checksum catalog together. `workbench checks run --role dependency-lock --path ROOT` performs
a full refresh of the reference's application and two tool graphs; preserve a narrower requested scope instead of
running that wholesale. Explicit checksum recording uses `WORKBENCH_COMPOSER_RECORD_CHECKSUMS=true`; ordinary installs
must never set it.

Review direct and transitive changes, PHP runtime requirements, licenses and advisories. Preserve compatible PHPUnit
versions for the minimum runtime independently of the latest development tool suite. Require SHA-256 verification of
distribution archives through the local Composer plugin; do not permit source-install fallback or bypass missing hashes.
Do not substitute an unverified Composer or Xdebug download. Update pinned bootstrap metadata and signatures together
when the requested scope includes those tools.

Run frozen setup, formatting, maximum-level static analysis, behavioral tests, coverage and relocated package checks for
the changed root. Rehearse the affected compatibility targets. Report versions, checksum/lock changes, verification and
any unavailable platform evidence. Commit only after the project's human review requirements are satisfied.
