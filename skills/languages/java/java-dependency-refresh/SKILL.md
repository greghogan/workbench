---
name: java-dependency-refresh
description:
  Refresh existing Maven dependencies and build plugins in a registered Workbench Java root when requested; preserve
  inspection-only and targeted scope, and do not add or remove direct dependencies.
---

# Java dependency refresh

Verify the Java root in `workbench/projects.toml`. Read its applicable Java, toolchain, acquisition, dependency, and
quality decisions. Use the project's Maven configuration and selected JDK; preserve the declared Java minimum.

1. Identify the owning POM, dependency management, plugin versions, core extensions, Maven settings, and trusted
   checksum configuration. Separate inspection from applied upgrades; identify the requested dependencies and whether
   plugin updates are in scope.
2. Inspect maintained upstream releases and compatibility. Update the selected literal requirements or their owning
   properties. Preserve dependency scopes, exclusions, plugin executions, repository checksum requirements, aliases,
   coverage floors, and compiler diagnostics. Do not change Nix or Guix pins without an explicit request.
3. When applying updates that change trusted checksums, read [trusted-checksums.md](references/trusted-checksums.md) and
   refresh the affected catalogs. Ordinary checks remain frozen and reject missing or mismatched hashes.
4. Review the resulting artifact versions and SHA-256 hashes. Run the frozen configured checks, relocated release
   verification, and affected Java compatibility boundaries. Run the root's configured advisory role after an applied
   update. Report retained updates and unresolved migrations; undo only this attempt's abandoned edits.

Inspection-only requests do not rewrite POMs or checksum indexes. Do not stage or commit unless requested.

After verified updates, respect `cache.auto_prune`. If more space is needed, inspect `workbench cache` and review a
fresh `workbench cache prune` plan before applying it. Preserve active or uncertain assets; do not delete cache
directories directly.
