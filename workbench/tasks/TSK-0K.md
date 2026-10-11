---
status: Done
parent: null
depends_on: []
---

# TSK-K: Prepare offline development images, configurable CI retention, and GCC image execution

## Review summary

Implement opt-in offline development profiles for native, Nix, and Guix tools, with independent network-disabled builds
before accepting an image. Add explicit GHCR publication and configurable hosted artifact retention. GCC compatibility
execution moves to digest-pinned Docker Official Images on native Linux architectures. Draft policy remains pending
human review; no deployment or Git push is part of this work.

## Progress

- [x] Implement profile preparation, offline verification, selection, and GHCR publication.
- [x] Provide independently runnable native, Nix, and Guix reference recipes.
- [x] Make hosted artifact retention configurable without changing verification.
- [x] Execute hosted and local GCC compatibility checks inside pinned compiler images.
- [x] Verify implementation and document design and operation.

## Verification

The full Workbench gate passes 391 tests in 70 files, including configuration, profile lifecycle, publication ordering
and failure handling, cache retention overrides, and local CI execution. Six native Linux x64 GCC rehearsal targets
pass: C and C++ on 14.4.0, 15.3.0, and 16.2.0, each with tests, sanitizers, and LTO. Their combined report is
`/tmp/workbench-ci-reports-bhENcV/reports/results.json`.

Native, Nix, and Guix pass independent fresh-source offline lint, tests, builds, and executable checks. The lint step
rebuilds locked Staticcheck code from retained module downloads. Ordinary shell entry also passes for all three against
accepted images with networking disabled. A second Guix preparation reused every Docker layer and the identical image
ID, then passed fresh offline verification again.

Guix verification corrected Unicode certificate handling with UTF-8, a retained profile link traversing root's private
cache, and excessive daemon child-startup time. The daemon was scanning Docker's inherited limit of more than one
billion file descriptors; bounding it to 65,536 reduced successive startup delays from minutes to fractions of a second.
The prepared image's running daemon also confirms that bound. Snapshot identity checks caught an ignored Python bytecode
file being counted as an input even though it was absent from the build context. Directory inputs now follow Git's
snapshot membership, and both build and verification snapshots must match the recorded input identity.

GHCR publication has not been performed; tests cover its boundary without remote effects. The explicit publication
workflow covers all three offline builders alongside release images and passes workflow validation. Live registry
authorization and native Linux ARM64 execution require subsequent verification. Task-owned test sessions were removed;
accepted images and receipts remain available. The existing Git index remains unchanged.
