# TSK-0: Bootstrap Workbench records and quality gates

Status: Active
Parent: None
Depends on: None

## Context

Bootstrap the project before the first human-reviewed commit. The charter is human-owned and unchanged.

## Plan

Define concise decisions for the durable choices; implement record identity, scoped setup, maps, formatting, and checks;
verify a source checkout and a consuming project. Refine remaining work into focused tasks when its boundary is clear.

## Findings

The foundational decisions have distinct roles: acceptance, project scopes, record identity, and map routing; task
continuity follows them. A map is an index, not a record. Acceptance gates a commit, not concurrent drafting and
implementation. Before the initial commit, overlapping decisions were consolidated around project language roots,
experiments and benchmarking, and review and coherent commits, then renumbered into dependency order.

Agent startup can use `AGENTS.md` plus decision maps. A marked AGENTS section mirrors the human-written charter and only
the optional instructions of mapped decisions. Explicit sync updates that section; validation is read-only. The separate
`WORKBENCH.md` entry point is no longer needed.

The app's public scope is setup, project and record operations, derived context, feedback intake, and deterministic
checks. `workbench help` now exposes the prepared app's command list rather than only the launcher usage.

End-to-end fixtures cover root-only and subproject setups with every built-in record type. Each type has a generated
map, and root maps route to subproject maps. The repository has one root `AGENTS.md`; generated context restates only
non-obvious instructions selected by mapped decisions.

Registered projects select explicit, non-inheriting language check roots. Portable roles bind formatting, linting,
testing, and documentation obligations to project-owned commands, which may use plain tools or an xtask. The initial
version-control adapter supplies a pending-change snapshot to the same structural checks and configured roles. Citation
records use CSL YAML with canonical published and archive sources. Explicit commands import identifier metadata, fetch
direct PDFs, or accept PDFs obtained through a required human browser flow into an ignored local library.

All record families allocate from zero. Tasks support progressively refined parent and dependency relationships;
experiments separate stable hardware records from run-specific software provenance. Release records join notes and a
source identity to immutable artifact sizes and SHA-256 digests. Setup uses the pinned Workbench source rather than a
release download.

Supported languages have executable reference projects rather than prose-only templates. The catalog drives manifest
detection, check guidance, and reference verification. Each reference may pin optional, explicitly entered Guix and Nix
host tools independently of the language dependency lockfile.

Before the first commit, the Workbench app moved from Rust to strict TypeScript. Its checked-in Node bundle is verified
against source and locked build tools. TypeScript joins Rust and Python as an executable language reference. Guix and
Nix update skills are separate; sync exposes them only for configured check environments. Rust skills activate only for
registered Rust language roots.

## Outcome

In progress. The first decision set and dependent code remain uncommitted pending human review.

## Validation

Seven Node tests pass, including root-only and subproject lifecycles with every record type, generated maps,
hierarchical help, record validation, and conditional skill exposure. Strict TypeScript typechecking, Prettier, ESLint,
bundle parity, and Workbench validation pass. The TypeScript reference also passes locked installation, formatting,
linting, typechecking, and tests in its pinned, container-isolated Guix environment. The Workbench TypeScript app itself
also builds and passes its checks in pinned Guix. The TypeScript Nix flake evaluates for x86-64 and AArch64 Linux. Rust
and Python remain checked reference projects; their pinned Guix checks and locked Nix flake evaluations passed before
the TypeScript migration.

Workbench does not install or activate a Guix profile. Human review of ADRs remains before commit.
