---
summary: Locked flakes, package-derived development shells, and disposable containers.
---

# ADR-Q: Nix development environments

Committed flakes and lockfiles define Nix tools and the package-derived shells of ADR-P. Local development and checks
use locked inputs and fail if evaluation requires a lockfile update.

Host development works in the checkout. Container checks use the same flake in a digest-pinned workspace, preserve the
checkout, and keep writes disposable. Reusable build, dependency, and store caches have explicit ownership and preserve
host file ownership. Setup and dependent checks use the shared session required by ADR-P; independent invocations must
be self-contained. Keep mount layout and invocation recipes in the environment guide.

Rationale: One locked definition supports both execution modes, with disposable container writes and reusable store
contents.
