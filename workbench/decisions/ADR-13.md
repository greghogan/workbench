---
summary: Module/tool pins, analysis, race detection, and portable executable releases.
---

# ADR-13: Go

`go.mod` declares the application minimum independently of the native pin; disable automatic toolchain substitution
during checks. Module and tool dependencies belong in `go.mod`/`go.sum`; use read-only resolution and verify integrity.
Use the [Go release policy](https://go.dev/doc/devel/release#policy) to select maintained compatibility lines.

Use gofmt, go vet, and applicable Staticcheck checks with narrow documented exclusions. Run uncached behavioral and
example tests with coverage and race detection on supported targets, reporting unavailable race detection explicitly.

Go executable releases run without a Go installation on the target. Their deployment requirements and verification
follow ADR-S.

Rationale: Standard tooling, verified modules, and runtime race checks provide repeatable evidence with little build
machinery. Release portability depends on the target contract and its evidence, rather than the build host or executable
format.
