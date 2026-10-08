# Go reference

The Go reference uses gofmt, go vet, all Staticcheck checks, uncached tests, coverage, and the race detector on all
supported native targets: Linux x64/ARM64, Windows x64, and macOS ARM64. `.go-version` owns the native toolchain;
`go.mod` declares the minimum and locks tool/module requirements with `go.sum`. Automatic toolchain substitution is
disabled. The minimum selects the latest patch of the older upstream-maintained Go release line when updated.

Run the configured checks with `workbench checks run --path examples/languages/go`. The shared adapters in
`../../../scripts` implement the reference checks. Consumer commands locate them through `{workbench}/scripts/`; adapt
them when project behavior differs. Guix and Nix are optional and retain their independent channel/flake pins. They do
not replace language dependency locks. Nix selects `go_latest` from its pinned package set; `go.mod` continues to
define the compatibility minimum.

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
