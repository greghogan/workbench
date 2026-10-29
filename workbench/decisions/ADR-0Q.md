---
summary: Locked flakes, package-derived development shells, and disposable containers.
---

# ADR-Q: Nix development environments

Committed flakes and lockfiles define Nix tools and the package-derived shells of ADR-P. Local development and checks
use locked inputs and fail if evaluation requires a lockfile update.

Host development works in the checkout. Container execution uses the same flake in a digest-pinned image, mounts source
read-only, and runs checks in a disposable writable copy. External owned build/dependency caches mount separately with
host ownership preserved. The Nix store may persist as a cache. Setup and dependent checks use the shared session
required by ADR-P; independent disposable invocations must be self-contained.

Rationale: One locked definition supports both execution modes, with disposable container writes and reusable store
contents.
