---
name: rust-dependency-refresh
description: Refresh existing Cargo dependencies in a registered Rust language root when the user asks for an update or upgrade; do not use for adding or removing direct dependencies.
---

# Rust dependency refresh

Use this skill only when the target project is registered with `languages = ["rust", ...]`. A root Codex session can see
the skill because another subproject uses Rust; verify the requested target before editing it.

1. Read the target project's Rust decision, manifests, lockfile, and configured checks. Find the workspace root and
   distinguish a whole-workspace request from named dependencies.
2. If `cargo-edit` is available, inspect `cargo upgrade --help`, then update existing manifest requirements with
   incompatible upgrades enabled, scoped to the request. Run `cargo update` for the matching lockfile. Do not add or
   remove direct dependencies, replace path or Git dependencies, or change unrelated package roots.
3. Run affected configured checks, using `benchctl hold` for heavy work when benchd is installed. Review manifest and
   lockfile changes, including duplicate crate versions where relevant. Report upgrades that could not be retained.

Do not stage or commit the change unless the user explicitly asks.
