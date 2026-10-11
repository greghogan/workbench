---
name: rust-dependency-refresh
description:
  Refresh existing Cargo dependencies in a registered Rust language root when the user asks for an update or upgrade; do
  not use for adding or removing direct dependencies.
---

# Rust dependency refresh

Verify the target is a registered Rust `[[language_root]]` in `workbench/projects.toml`. Read the applicable toolchain,
Rust, dependency, and quality-gate decisions through the decision maps. Apply the shared dependency-update policy.

1. Find the owning Cargo workspace, inherited requirements, lockfile, and configured checks. Separate inspection,
   compatible or lockfile refresh, and requirement upgrades; distinguish named crates from a whole-workspace request.
2. For requirement upgrades, inspect the installed `cargo upgrade --help`, then use `cargo upgrade --incompatible allow`
   with package selectors for a targeted request. If cargo-edit is unavailable, update the existing requirements from
   verified registry releases while preserving comments, features, renames, optional and target-specific declarations.
   Do not silently substitute a lockfile-only refresh. Use the installed tool's supported workspace behavior.
3. Resolve a whole-workspace refresh with `cargo update`; for named crates use `cargo update -p NAME` for each selected
   crate. Necessary transitive changes are expected. Preserve path/Git sources and unrelated roots; adding or removing
   direct dependencies is a separate request. Inspection requests do not write manifests or locks.
4. Run the configured checks, including declared minimum support when affected. Review the requirements and resolved
   graph, investigate new duplicate crate versions when relevant, and report retained upgrades and unresolved
   migrations. Restore only this attempt's edits when abandoning a candidate; preserve pre-existing work.

Do not stage or commit the change unless the user explicitly asks.

After an applied update, run the selected root's configured advisory role (`workbench checks run --role advisory --path ROOT`); inspection-only requests do not run it automatically.
