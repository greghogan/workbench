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
3. Use the configured `dependency-lock` role through
   `workbench checks run --role dependency-lock --path ROOT`, or Maven's documented trusted-checksum recording mode.
   For several managed Maven versions, record a fresh index for each environment, then combine their artifact paths and
   hashes, rejecting conflicts. Do not retain unused entries from the old requirements. Run every configured formatter,
   compiler, analysis, test, coverage, and packaging goal so plugins' dynamic dependencies are captured as well.
   Regenerate from an empty checksum index in isolated staging to remove unused entries. Use external repository and
   build paths. Never enable recording in ordinary checks or disable failure for missing or mismatched hashes.
4. Review the resulting artifact versions and SHA-256 hashes. Run the frozen configured checks, relocated release
   verification, and affected Java compatibility boundaries. Run the root's configured advisory role after an applied
   update. Report retained updates and unresolved migrations; undo only this attempt's abandoned edits.

Inspection-only requests do not rewrite POMs or checksum indexes. Do not stage or commit unless requested. See the
[Maven trusted checksums](https://maven.apache.org/resolver/expected-checksums.html) for recording and verification.
