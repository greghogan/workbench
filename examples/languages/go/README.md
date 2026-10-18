# Go reference

The Go reference uses gofmt, go vet, all Staticcheck checks, uncached tests, coverage, and the race detector on all
supported native targets: Linux x64/ARM64, Windows x64, and macOS ARM64. `.go-version` owns the native toolchain;
`go.mod` declares the minimum and locks tool/module requirements with `go.sum`. Automatic toolchain substitution is
disabled. The minimum selects the latest patch of the older upstream-maintained Go release line when updated.

Run the configured checks with `workbench check --path examples/languages/go`. The shared adapters in
`../../../scripts` implement the reference checks. Consumer commands locate them through `{workbench}/scripts/`; adapt
them when project behavior differs. Guix and Nix are optional and retain their independent channel/flake pins. They do
not replace language dependency locks. Nix selects `go_latest` from its pinned package set; `go.mod` continues to define
the compatibility minimum.

`workbench/quality.json` owns the coverage floors and advisory per-test cap. Workbench configuration owns the
whole-command soft cap, which includes any build and setup inside that command. Slow execution prints a warning and
never fails a passing test. Coverage failures remain check failures. Reports under `coverage/` are retained by CI.
Changes to these limits require human acknowledgment at commit.

```console
$ go run ./cmd/count a banana
3
```

`make clean` removes local build and coverage outputs. `make distclean` has the same effect; shared tool and dependency
caches remain intact.

The static Makefile delegates to the repository's configured commands for this root: `make` builds, `make check` runs
the commit gate, `make test` runs ordinary tests, and `make coverage` runs the same suite with instrumentation and
coverage floors. CI selects coverage on Linux/native and ordinary tests on other targets. `make release` prepares local
release artifacts; `make fmt` formats files. Coverage has no whole-command timing cap.

## Managed release packaging

This repository’s [profile guide](../../../docs/profiles.md) describes native, Nix, Guix, and Apptainer packaging. The
example owns its locked flake outputs, `release-manifest.scm`, and `scripts/` recipes. A standalone copy can invoke
these builders directly, or declare project-owned Workbench release profiles using the same recipes. The provided
multi-format profiles are verified on Linux x64; ordinary language checks retain the Go example’s broader configured
platform matrix. Packaging needs Docker for isolated verification and either the pinned Nix Docker adapter or host Guix,
depending on the selected recipe.

## Offline development images

The repository's optional `native`, `nix`, and `guix` development profiles demonstrate preparing this project's tools
and locked dependency inputs in an image, then compiling and testing fresh source with networking disabled. See
[development profiles](../../../docs/profiles.md#prepared-offline-profiles) for preparation, selection, verification,
and explicit GHCR publication. Copy the selected standard Dev Container recipe and declare its inputs and verification
command when adopting it in another project; the example requires no parent Makefile.
