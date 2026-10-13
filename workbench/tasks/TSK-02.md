---
status: Done
parent: workbench:TSK-1
depends_on: []
---

# TSK-2: Implement complete language configuration inheritance

## Review summary

Implemented shared language definitions with complete project replacements and additions, plus the standalone React
example. Local language-resolution regressions and React native, Nix, Guix, and Dev Container checks passed. See
Validation below for evidence; hosted verification remains in workbench:TSK-7.

## Progress

- [x] Resolve shared definitions and complete local replacements/additions.
- [x] Implement and verify the standalone React example.
- [x] Run configuration and behavioral checks; record hosted verification separately.

## Outcome

Resolve explicitly selected language configurations from the pinned distribution, complete local replacements, or
complete local additions under workbench:ADR-1. Report the selected source and reject unintended merging or conflicts.

## Current state

Reusable definitions now live in `languages/<id>/config.toml` and `automation.toml`, with discovery in
`languages/index.toml`. A consuming project's `workbench/languages/<id>/` replaces the complete shared definition or
adds a new language. Resolution selects the source before parsing its files, reports provenance, and rejects incomplete
definitions, unsafe paths, and duplicate commands. Project root registrations and explicit commands remain independent.

## Plan

Implementation and focused review are complete. Hosted execution remains part of workbench:TSK-7 and requires the
pending human implementation review before another push.

## Framework examples

`examples/frameworks/react` is a standalone application selecting the TypeScript suite and owning its dependency locks,
native tools, authenticated Guix channel, and locked Nix flake. It builds a minified static site, tests browser
behavior, and verifies the built release independently. Framework examples select Linux x64 for native, Guix, Nix
Docker, and Dev Container CI, with no additional language-version matrix. Direct Nix uses the same tested flake. The
draft CI decision documents this policy without introducing a framework ADR or a framework-definition layer.

## Validation

On 2026-10-09, all 136 existing root tests passed. After adding the React CI contract assertion, the focused selection
passed 35 tests across five files. Type checking, focused lint, formatting, bundle parity, packaging, isolated release
verification, and structural validation passed.

React native, Guix, Nix Docker, and Dev Container checks passed locally on Linux x64, including format, lint, types,
tests, build, executable documentation, and advisory checks. Native coverage reached 100% for statements, lines,
functions, and branches. A standalone copy passed installation, checks, release packaging, and production-site behavior
verification. Container checks required a temporary host-network wrapper because this machine's Docker bridge could not
resolve the package registry; production networking defaults were unchanged. Direct host Nix was unavailable.

At that point full root lint reported failures in earlier artifact-streaming and local-CI drafts owned by sibling tasks.
Subsequent lint cleanup corrected those errors; the sibling tasks retain their broader implementation and verification
scope. No changes were staged, committed, pushed, or deployed.

An earlier direct dependency installation had recreated the root's local pnpm virtual store. Configured setup restored
external storage without changing versions or locks, reducing checkout-local `node_modules` from 155 MB to 264 KB.

## Storage enforcement

The project-owned pnpm hook now applies selected storage before direct package-manager commands write dependencies.
Workbench, the TypeScript starter, and React include it; language initialization and distribution packaging retain it.
The pinned executable resolves preferences, prepares owned external storage, and preserves inherited session paths.
Incomplete integration, invalid preferences, incompatible linkers, and storage inherited from another language root fail
before package installation. Standalone copies and projects selecting local storage retain pnpm defaults. The draft
configuration decision documents the design; user documentation explains adoption and explicit bypass.

All 143 root tests passed, including six hook regression tests. A separate offline test with local package archives
verified direct add, frozen install, update, module loading, and standalone installation using pinned pnpm 12.6.0.
Refreshing the three lockfiles changed only hook checksum metadata; dependency resolutions stayed identical. Native
TypeScript and React CI checks passed, with 100% application coverage. React's Guix, Nix Docker, and Dev Container
checks also passed with the hook. Type checking, focused lint, formatting, bundle parity, packaging, isolated release
verification, and structural validation passed. The earlier full-root lint failures were subsequently corrected.
