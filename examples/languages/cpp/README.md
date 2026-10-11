# C++ reference

The C and C++ references use CMake/Ninja, strict compiler warnings, broad clang-tidy groups, LLVM coverage, and separate
sanitizer and portable-only builds. `.llvm-version` selects the native LLVM family; `.tool-versions` owns CMake and
Ninja. `workbench/projects.toml` selects the language standard, development compiler, and supported compiler families.
The references target C17 and C++20, develop with Clang, and test Clang 21, 22, and 23 plus GCC 14, 15, and 16 on Linux.
Clang compatibility follows a rolling three-major window; GCC follows upstream-maintained branches. Each selected line
uses its latest patch, and support-boundary changes receive review under ADR-14. `.gcc-version` is used only when GCC is
selected. LLVM is always required, including for GCC development. Managed environments retain their own compiler pins
and must include GCC if selecting it.

On native Linux, Workbench installs LLVM 23's required ICU 70 runtime privately in its toolchain cache, authenticating
Ubuntu's signed package metadata and the pinned package. The host's system ICU and SDK remain selected normally. GnuPG,
binutils, and XZ utilities are installation prerequisites. Filtered LLVM caches retain the required tools and runtime;
cache deletion requires explicit tool installation again. Each language owns its LLVM inclusion filter under the
Workbench language definitions. Filters omit LLVM static development libraries and Fortran resources, retaining C/C++
runtimes and the tools needed for linting, sanitizers, coverage, and LTO.

The lint gate validates clang-tidy configuration before compiling and analyzing every C/C++ source and test translation
unit. All enabled diagnostics are errors. The selected groups cover bugprone code, CERT, the Clang analyzer,
miscellaneous correctness, performance, portability, and readability; C++ also enables modernization and C++ Core
Guidelines. Rule exclusions and local suppressions are explained beside the configuration or affected code.

Supported native platforms are Linux x64/ARM64, Windows x64, and macOS ARM64. GCC installation and compatibility checks
are supported on Linux only, on both x64 and ARM64; Windows and macOS use Clang. This follows the platform policy in
[ADR-14](../../../workbench/decisions/ADR-14.md), shared with C++ through
[ADR-15](../../../workbench/decisions/ADR-15.md).

Run the configured checks with `workbench checks run --path examples/languages/cpp`. The shared adapters in
`../../../scripts` implement the reference checks. Consumer commands locate them through `{workbench}/scripts/`; adapt
them when project behavior differs. Guix and Nix are optional and retain their independent channel/flake pins. They do
not replace language dependency locks.

Install native tools with `workbench tools install --path examples/languages/cpp`. LLVM also requires the host's
platform SDK; see the root README. Builds use fmt through vcpkg manifest mode. `vcpkg.json` declares dependencies,
`vcpkg-configuration.json` pins the Git registry baseline, and `.vcpkg-version` pins the tooling checkout. The tool
release precedes the registry baseline to support the CMake version in the pinned Guix environment.

Select GCC for one run with `--compiler gcc` on both `workbench tools install` and `workbench checks run`, with the same
`--path`. Add `--compiler-version` to exercise an exact compatibility version without changing development pins. GCC
native installation builds verified upstream source on Linux; see the root README for bootstrap prerequisites.

Dependencies use the selected compiler and linkage. Compiler versions and language standards isolate caches. GCC
analysis uses a separate Clang build and matching dependencies; LLVM coverage uses Clang while preserving ordinary
selected-compiler tests. Build products follow the global Workbench storage selection; verified source downloads and
ABI-keyed binaries use shared caches. The dependency declarations apply to native, Dev Container, Guix, and Nix builds.
Windows sanitizer builds also instrument dependencies, preserving matching MSVC STL annotations across static libraries.
They use `RelWithDebInfo` and the release CRT, avoiding upstream LLVM ASan's debug CRT incompatibility while retaining
debug symbols and the complete instrumented suite.

`workbench/quality.json` owns the coverage floors and advisory per-test cap. Workbench configuration owns the
whole-command soft cap, which includes any build and setup inside that command. Slow execution prints a warning and
never fails a passing test. Coverage failures remain check failures. Reports under `coverage/` are retained by CI.
Changes to these limits require human acknowledgment at commit.

Release LTO is selected with `lto = "off"`, `"full"`, or `"thin"` on the language root in `workbench/projects.toml`;
these examples select `"full"`. Clang supports all three modes. GCC supports `"off"` and `"full"` on Linux and rejects
`"thin"`. LTO requires an optimized build, matching LLVM archive tools and LLD for Clang, or GCC's own archive wrappers
and compatible host binutils. Guix and Nix select LLD from their existing pinned environments; their channel and flake
revisions are unchanged.

Linux Clang LTO embeds paths for the selected SDK's linked shared runtimes. This preserves runtime discovery when
explicit LLD selection bypasses Guix or Nix linker wrappers, without adding the full development environment to the
binary's runtime paths.

The `lto` check builds and runs the complete suite for every supported mode, links project static libraries into the
executables, and runs a copied executable outside the source checkout. It also verifies rejection of invalid modes, LTO
with coverage or sanitizers, a debug LTO build, and GCC ThinLTO. Compiler compatibility jobs include this check.
`make release` runs the release suite and standalone verification before copying the executable into `dist/`. Debug,
coverage, sanitizer, and each LTO mode use separate build directories; dependency ABI tracking remains enabled. Linux
x64 verification is recorded in [TSK-4](../../../workbench/tasks/TSK-04.md); remaining hosted platforms are tracked
separately. These checks establish behavior, without claiming a performance improvement.

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
