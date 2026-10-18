---
name: javascript-dependency-refresh
description:
  Update existing dependencies in a registered Workbench JavaScript root, including declarations and locks; use for
  requested upgrades or update inspection, not adding or removing dependencies.
---

# JavaScript dependency refresh

Verify the target JavaScript root in `workbench/projects.toml`. Read the applicable toolchain, JavaScript, dependency,
and quality-gate decisions through the decision maps. Apply the shared dependency-update policy.

1. Identify the owning workspace, pinned package manager, lockfile, catalogs, overrides, peer requirements, and package
   aliases. Separate inspection, compatible or lockfile refresh, and requirement upgrades; identify selected packages.
2. For pnpm requirement upgrades use `pnpm update --latest`, naming dependencies for a targeted request. Select
   workspace members explicitly; recursive updates must include the root when it is in scope. Omit `--latest` for
   compatible-only requests and use `--no-save` for lockfile-only changes. Inspect the installed command's help before
   combining options.
3. Preserve dependency groups, aliases, workspace protocols, patches, catalogs, and supported runtime ranges. Updating
   an alias must retain its actual package identity. Review overrides that constrain an upgrade instead of silently
   removing them. Preserve supply-chain controls; do not bypass them to obtain a newer release. For another configured
   manager, use its equivalent workflow without migrating tools. Inspection requests do not rewrite declarations or
   locks.
4. Install with the resulting frozen lockfile and run configured checks, including affected runtime support boundaries.
   Review peer compatibility and package lifecycle-script changes. Report retained upgrades and unresolved migrations;
   undo only this attempt's edits for abandoned candidates.

Do not stage or commit unless requested. See the [pnpm update reference](https://pnpm.io/cli/update) for command
details.

After an applied update, run the selected root's configured advisory role
(`workbench check --role advisory --path ROOT`); inspection-only requests do not run it automatically.
