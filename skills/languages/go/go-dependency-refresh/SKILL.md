---
name: go-dependency-refresh
description:
  Update existing dependencies in a registered Workbench go root on request; preserve narrower inspection or lock-only
  scope. Do not use to add dependencies.
---

# Dependency refresh

Locate the registered language root and read its applicable language, dependency, and quality decisions. Preserve the
requested update scope and declared support boundaries. Environment pin changes require their own authorization.

Use go.mod and go.sum, including tool directives. Inspect requested module upgrades, apply explicit versions with go
get, run go mod tidy, and verify the module graph. Include major-version import-path migrations only within the
authorized scope.

Run the root's configured checks and affected minimum-version checks. Report resolved versions and any retained
constraints. Do not stage or commit unless requested.

After an applied update, run the selected root's configured advisory role (`workbench check --role advisory --path ROOT`); inspection-only requests do not run it automatically.
