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
`php-package-manager-exec` adapter for Composer's update operation and requested package selection. Refresh affected
locks and archive checksum catalogs together. Read [acquisition.md](references/acquisition.md) when applying updates
that change archive checksums or Composer/Xdebug pins.

Review direct and transitive changes, PHP runtime requirements, licenses and advisories. Preserve compatible PHPUnit
versions for the minimum runtime independently of the latest development tool suite. Preserve SHA-256 archive
verification; ordinary installs remain frozen and never record new checksums. Do not substitute unverified tools.

Run frozen setup, formatting, maximum-level static analysis, behavioral tests, coverage and relocated package checks for
the changed root. Rehearse the affected compatibility targets. Report versions, checksum/lock changes, verification and
any unavailable platform evidence. Do not stage or commit unless requested; required human review remains separate.

After verified updates, respect `cache.auto_prune`. If more space is needed, inspect `workbench cache` and review a
fresh `workbench cache prune` plan before applying it. Preserve active or uncertain assets; do not delete cache
directories directly.
