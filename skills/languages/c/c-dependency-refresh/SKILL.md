---
name: c-dependency-refresh
description:
  Update existing dependencies in a registered Workbench c root on request; preserve narrower inspection or lock-only
  scope. Do not use to add dependencies.
---

# Dependency refresh

Locate the registered language root and read its applicable language, dependency, and quality decisions. Preserve the
requested update scope and declared support boundaries. Environment pin changes require their own authorization.

Use the owning CMake/package-manager manifest. For vcpkg, review dependencies in `vcpkg.json` and its registry baseline in `vcpkg-configuration.json`
(or `builtin-baseline` for a builtin registry);
`version>=` is a minimum and `overrides` selects an exact version. `.vcpkg-version` independently selects the tooling
checkout. Update that tooling only when requested or needed for the authorized dependency change, and explain why.
Verify the resolved graph across the selected environments without disabling compiler/ABI tracking. Other managers
retain their locks or immutable source hashes. Do not introduce a manager into a project that has no dependencies.

Run the root's configured checks and affected minimum-version checks. Report resolved versions and any retained
constraints. Do not stage or commit unless requested.

After an applied update, run the selected root's configured advisory role (`workbench checks run --role advisory --path ROOT`); inspection-only requests do not run it automatically.
