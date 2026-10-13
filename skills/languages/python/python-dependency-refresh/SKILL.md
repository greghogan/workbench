---
name: python-dependency-refresh
description:
  Update existing dependencies in a registered Workbench Python root, including requirements and locks; use for
  requested upgrades or update inspection, not adding or removing dependencies.
---

# Python dependency refresh

Verify the target Python root in `workbench/projects.toml`. Read the applicable toolchain, Python, dependency, and
quality-gate decisions through the decision maps. Apply the shared dependency-update policy.

1. Identify the owning project or workspace, package manager, dependency groups, extras, sources, and supported Python
   range. Separate inspection, compatible or lockfile refresh, and requirement upgrades; identify any named packages.
2. For uv lockfile refreshes, use `uv lock --upgrade` for the requested whole workspace or
   `uv lock --upgrade-package NAME` for selected packages. These commands respect existing requirements: they cannot
   implement an upgrade beyond an upper bound or exact pin. For requirement upgrades, first update the existing
   declarations to verified stable releases, retaining their groups, extras, markers, sources, and intended range style,
   then resolve the selected lock changes.
3. Preserve direct-dependency membership, the Python support range, and environment pins. For another configured package
   manager, use its equivalent workflow without migrating tools. Inspection requests leave requirements and locks
   intact.
4. Install from the resulting lock and run configured checks, including affected supported Python versions. Review both
   manifest and lock changes; report upgrades retained and migrations deferred. Undo only this attempt's edits when a
   candidate is abandoned.

Do not stage or commit unless requested. Consult the installed uv help and the
[locking documentation](https://docs.astral.sh/uv/concepts/projects/sync/) for command details.

After an applied update, run the selected root's configured advisory role (`workbench checks run --role advisory --path ROOT`); inspection-only requests do not run it automatically.
