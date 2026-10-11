---
summary: Module/tool pins, analysis, race detection.
---

# ADR-16: Go implementation

Apply ADR-9. Set the minimum to the current patch of the oldest supported Go release line. go.mod declares that minimum
separately from the native pin; disable automatic toolchain substitution during checks. go.mod and go.sum own module and
Go-tool dependencies; use read-only module resolution and verify module integrity.

Use the [Go release policy](https://go.dev/doc/devel/release#policy) to select maintained release lines for ADR-9's
compatibility coverage. Prefer the newest maintained release for native development.

Use gofmt, go vet, and all applicable Staticcheck checks, with narrow documented exclusions. Run uncached behavioral and
example tests with coverage and the race detector on supported targets. Apply ADR-A's advisory timing policy and report
unavailable race detection explicitly.

Rationale: Standard Go tooling keeps the build small while module verification, analysis, and race detection provide
repeatable checks.
