# C reference

The C and C++ references use CMake/Ninja, strict compiler warnings, broad clang-tidy groups, LLVM coverage, and separate
sanitizer and portable-only builds. `.llvm-version` selects the native LLVM family; `.tool-versions` owns CMake and
Ninja. `workbench/projects.toml` selects the language standard, development compiler, and supported compiler families.
The references target C17 and C++20, develop with Clang, and test Clang's declared minimum plus GCC 14, 15, and 16 on
Linux. `.gcc-version` is used only when GCC is selected. LLVM is always required, including for GCC development. Managed
environments retain their own compiler pins and must include GCC if selecting it.

Supported native platforms are Linux x64/ARM64, Windows x64, and macOS ARM64. GCC installation and compatibility checks
are supported on Linux only, on both x64 and ARM64; Windows and macOS use Clang. This follows the platform policy in
[ADR-I](../../../workbench/decisions/ADR-0I.md), shared with C++ through ADR-J.

Run the configured checks with `workbench checks run --path examples/languages/c`. The shared adapters in
`../../../scripts` implement the reference checks. Consumer commands locate them through `{workbench}/scripts/`; adapt
them when project behavior differs. Guix and Nix are optional and retain their independent channel/flake pins. They do
not replace language dependency locks.

Install native tools with `workbench tools install --path examples/languages/c`. LLVM also requires the host's platform
SDK; see the root README. Builds use yyjson through vcpkg manifest mode. `vcpkg.json` declares dependencies,
`vcpkg-configuration.json` pins the Git registry baseline, and `.vcpkg-version` pins the tooling checkout. The tool
release precedes the registry baseline to support the CMake version in the pinned Guix environment.

Select GCC for one run with `--compiler gcc` on both `workbench tools install` and `workbench checks run`, with the same
`--path`. Add `--compiler-version` to exercise an exact compatibility version without changing development pins. GCC
native installation builds verified upstream source on Linux; see the root README for bootstrap prerequisites.

Dependencies use the selected compiler and linkage. Compiler versions and language standards isolate caches. GCC
analysis uses a separate Clang build and matching dependencies; LLVM coverage uses Clang while preserving ordinary
selected-compiler tests. Build products follow the global Workbench storage selection; verified source downloads and
ABI-keyed binaries use shared caches. The dependency declarations apply to native, Dev Container, Guix, and Nix builds.

The JSON writer tests allocation failure at every allocation boundary, verifies that failures free owned memory and
leave output untouched, and checks a real write failure on a read-only stream.

`workbench/quality.json` owns the coverage floors and advisory per-test cap. Workbench configuration owns the
whole-command soft cap, which includes any build and setup inside that command. Slow execution prints a warning and
never fails a passing test. Coverage failures remain check failures. Reports under `coverage/` are retained by CI.
Changes to these limits require human acknowledgment at commit.

The byte counter has scalar, automatic, and explicitly requested AVX2 backends. CPU/OS feature detection precedes AVX2
calls. Tests check unaligned inputs, empty buffers, high bytes, vector boundaries, and tails. The portable-only build
verifies unavailable-backend behavior; unsupported AVX2 tests report a skip. This demonstrates dispatch without claiming
a performance improvement. Sanitizers use ASan and UBSan on Linux and macOS, and ASan on Windows x64. Both sanitizer and
portable-only builds retain the complete test suite.

After the test/build check:

```console
$ "$WORKBENCH_BUILD_DIR/debug/count" a banana
3
```

```console
$ "$WORKBENCH_BUILD_DIR/debug/count" --json a banana
{"count":3}
```

`make clean` removes local build and coverage outputs. `make distclean` has the same effect; shared tool and dependency
caches remain intact.

The static Makefile delegates to the repository's configured commands for this root: `make` builds, `make check` runs
the commit gate, `make test` runs ordinary tests, and `make coverage` runs the same suite with instrumentation and
coverage floors. CI selects coverage on Linux/native and ordinary tests on other targets. `make release` prepares local
release artifacts; `make fmt` formats files. Coverage has no whole-command timing cap.
