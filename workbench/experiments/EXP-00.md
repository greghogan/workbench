---
status: Running
environment: workbench:ENV-0
---

# EXP-0: Trim upstream LLVM for a Linux x64 CI cache

## Hypothesis

Selecting the tools and runtime resources used by Workbench from the official LLVM 23.1.2 Linux x64 archive will reduce
installed and compressed cache size by at least 50% while preserving the tested C/C++ workflows.

## Candidate and baseline

Baseline: the full official LLVM 23.1.2 Linux x64 tarball with SHA-256
`b5ed9675149cc837c282e9b6962c276c9fa62863d5b2f91537b60848552995b7`. Candidate: an explicit subset of that archive,
retaining selected tools and their symlink targets, all Clang resource headers and runtimes, C++ runtime headers and
libraries, license material where present, and shared-library dependencies discovered from ELF metadata. Do not strip
binaries in this trial: measure component selection independently from symbol stripping. Retain the selection script and
its content hash with the evidence because the candidate is not a production implementation.

## Independent variable

The retained installation files. Both variants use identical upstream bytes; both cache archives use tar and Zstandard
level 3 with two compression workers, approximating the Actions cache format. No custom compiler build or source change.

## Controls and correctness

Use a native Linux x64 Ubuntu 24.04 container pinned to
`sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55`, with OS SDK prerequisites. Keep exact project
tool, vcpkg, and dependency selections. Copy inputs into `/tmp`; mount only this trial directory into the container. The
original LLVM installation and `/efs` are inaccessible. Disable vcpkg binary reuse for verification. Test the candidate
after archiving and restoring it into a fresh directory. Inspect tool paths, versions, library resolution, symlinks, and
resource-directory selection. Run C and C++ formatting, linting, ordinary tests, ASan/UBSan tests, portable sanitizer
tests, coverage floors, release builds, release smoke tests, and clangd compilation-database checks. Run the same
workflow with the full installation as a baseline. Do not weaken checks after a failure.

## Workload

Workbench's current C17 and C++20 examples using vcpkg yyjson and fmt. Record the copied input identity and script
hashes. Inventory all retained and removed files; summarize size reductions by top-level directory and major omitted
tool families. Measure unique-file logical bytes, allocated bytes, compressed archive bytes, and pack/restore time.

## Evaluation rule

The trial supports the hypothesis only if both size reductions meet 50% and all listed checks pass for the restored
candidate and baseline. If correctness fails, retain the causal error and mark the result inconclusive or rejected; do
not silently expand the selection and claim the same trial passed. Stop after both verification runs and one archive
measurement per variant. Favorable evidence remains pending human acceptance; no CI push or publication.

## Execution provenance

Executed on 2026-10-09 under host `benchctl hold`, without a scheduler bypass or architecture emulation. All disposable
inputs, installations, archives, builds, homes, and reports were under `/tmp/workbench-llvm-cache-7WpcIYf8`; that
directory was the only mounted execution workspace. The Ubuntu container could not access `/efs` or the host's installed
LLVM. The reduced verification additionally hid the original extracted trees and the full restored installation behind
empty mounts. Both verification containers used the same local image ID
`sha256:a4999250fe1f44627282352af1179460b02527d3475830348b331d6455409734`.

The copied project input digest was `6d6c9a3c299c0d3faf92a20594262a89acae3b881889d2c204b1199035874e04`, covering
relative names and SHA-256 hashes of regular source files. C/C++ examples and their pinned manifests were copied without
source changes. Selected tools were LLVM 23.1.2 (source commit `85ac560262434c9ccfc0c183ec22d4138ed647fb`), Node
24.21.0, CMake 4.4.4, and Ninja 1.13.2. Both cases used fresh vcpkg installations with binary reuse disabled. Host
preparation used PyPy 7.3.20 implementing Python 3.11.13; verification used Ubuntu's Python 3.12 inside the container.
These interpreter selections did not change the retained LLVM bytes.

Retained recipes start with the [selection recipe](EXP-00/prepare.py) under `workbench/experiments/EXP-00`. These are
experiment reproductions, not production installers. Copy them into disposable local storage before execution and adapt
their recorded paths to that machine. The selection recipe is the reproducible transformation against the
checksum-identified upstream archive; no compiler source patch was applied. Hashes of the tested recipes:

| File            | SHA-256                                                            |
| --------------- | ------------------------------------------------------------------ |
| `prepare.py`    | `87bc498a02dbc56102fb24d4a1da1c8b3c7106ba820c98483f6a65292e0f49cd` |
| `archive.py`    | `33ca00cc0893aaef314d48a0e558b9ef10711a924d213e67ff0e4168409ae27b` |
| `verify.py`     | `969c37cbd4d58ea97ec7ffeb048c8a244866859a33f15e8dea3b0effb5729e19` |
| `run-verify.sh` | `bd7dc5499e6a6aeaf3142e2d1642e74eec6b90eb004d517b01f804ac83d7d397` |
| `Dockerfile`    | `d3f0a9bf4d66107d448e0c2e94d3958d95c3f2c96b12a64464858bebfdeeba53` |

Preparation ran as benchd job `01a11e8592817ce2b7f62c54e2a1dccc`; archive measurement and restore verification ran as
`01a11e8954b1736385c47cbb4d44f183`. Final reduced verification ran as `01a11e93259d726389ba18e57bfef9bd` and full
verification as `01a11e9325ff77c1b5f87fb5bde96bf7`; both completed successfully. Final verification included LLD/LTO,
bitcode archive indexing/symbol inspection, and a program linked against the retained libc++ runtime.

Initial container setup required host networking to reach APT. A first verification setup attempt failed while
inspecting a deliberately hidden directory's permissions; readable empty mounts corrected that harness issue. The
initial tool probes then found that upstream LLD requires `libicui18n.so.70`, `libicuuc.so.70`, and `libicudata.so.70`,
which Ubuntu 24.04 does not supply by default. An independent full-tarball LLD probe failed identically. The test image
was extended with Ubuntu Jammy's `libicu70=70.1-2`, acquired through signed APT metadata and additionally checked
against SHA-256 `58a154f6307289813da2276f900498ef536ae7c0522d2cf31a3c3c5cf62dfd9a`. Package selection was restricted to
that compatibility runtime; the LLVM retained set and check scope did not change. Both final runs used that same SDK.

Preparation and archive scripts ran concurrently and wrote the same measurement document. The final summary was
reconciled against their separate append-only logs to retain both archive rows and the copied input digest. Run those
two reproduction steps sequentially to avoid that report-writing collision.

## Evidence

All sizes below are bytes; decimal GB/MB are used in presentation. Logical sizes count each file inode once and exclude
directory metadata. Allocated sizes count the same files' allocated filesystem blocks. Binary symbols were unchanged.

| Measurement                |           Full |       Reduced |        Reduction |
| -------------------------- | -------------: | ------------: | ---------------: |
| Logical installed bytes    | 12,398,907,956 | 1,227,445,159 |           90.10% |
| Allocated file bytes       | 13,138,358,272 | 1,254,666,240 |           90.45% |
| File and symlink entries   |         10,577 |         2,164 |    8,413 removed |
| Zstandard archive bytes    |  2,908,580,786 |   321,335,197 |           88.95% |
| Archive creation seconds   |         169.39 |         34.67 | Observation only |
| Archive extraction seconds |          36.94 |          1.73 | Observation only |

Both cache archives used Zstandard 1.5.7, level 3, two workers, and identical tar settings. They are simulations of
Actions cache packaging, not actual hosted cache uploads. Every restored file's SHA-256 and every symlink target matched
its source. Timing excludes the subsequent integrity scan and is from one observation on a shared host; it does not
establish a hosted performance ratio. The upstream `.tar.xz` itself was 2,013,958,032 bytes and remains the
first-download requirement on a cache miss.

| Removed category                                               | Logical bytes removed |
| -------------------------------------------------------------- | --------------------: |
| Executables and aliases under `bin/`                           |         8,543,988,258 |
| Libraries and development assets under `lib/`                  |         2,410,758,878 |
| API and development headers under `include/`                   |           216,063,243 |
| Documentation and helper scripts under `share/` and `libexec/` |               652,418 |

Removed families include Fortran/flang, MLIR, LLVM optimizer/code-generation/development utilities, LLDB, interactive
Clang tooling, and library API SDKs. Examples include `flang-23` (457 MB), `mlir-opt` (443 MB), `clang-repl` (297 MB),
`liblldb.so` (278 MB), and `libclang.so` (221 MB). The retained Linux executables do not require the omitted LLVM/Clang
API shared libraries; ELF dependency inspection and the isolated runtime checks verified that distinction.

The candidate retained 27 binary entries (including versioned executables and aliases): Clang/Clang++, clang-cl,
clang-cpp, clang-format, clang-tidy, clangd, clang-scan-deps, clang-apply-replacements, llvm-cov, llvm-profdata,
llvm-ar, llvm-ranlib, llvm-nm, llvm-objcopy, llvm-objdump, llvm-readelf, llvm-readobj, llvm-size, llvm-strings,
llvm-strip, llvm-symbolizer, and LLD with its linker aliases. It retained all of `lib/clang`, `include/c++`,
`include/x86_64-unknown-linux-gnu`, and `lib/x86_64-unknown-linux-gnu`, plus selected runtime library aliases and
dependency closure. The upstream package supplied no matching standalone license/notice files for the recipe's notice
selector.

Both final verification runs completed all 41 recorded commands successfully. The C suite passed all five tests in
ordinary, ASan/UBSan, portable ASan/UBSan, and coverage builds; C++ passed all four in each variant. Formatting,
clang-tidy, documentation checks, coverage floors, release builds, and release smoke tests outside the source checkout
passed. clangd checked each language's source against its generated compilation database with zero errors. LLD/LTO
linking, bitcode archives, and the retained libc++ compile/link/run checks passed. Selected tool and resource paths
pointed into the restored tree.

Normalized coverage summaries were identical between full and reduced cases, including every source file. C covered
68/72 lines, 6/6 functions, and 43/48 branches. C++ covered 58/62 lines, 6/6 functions, and 21/24 branches. No coverage
floors, source exclusions, tests, or tool pins changed.

## Decision

The Linux x64 evidence satisfies the declared size and correctness rule. Human acceptance remains pending, so the record
retains `Running` status. The result supports preparing a production trimming/cache recipe for review; it does not
authorize a push or publication. ARM64, macOS, Windows, LLVM 21 compatibility, real Actions cache restoration, debugger
workflows, and arbitrary downstream C/C++ projects remain unverified. Omitting LLDB and the library API SDKs limits the
candidate to the tested compiler/check tooling profile. The ICU 70 prerequisite must be handled explicitly if LLD is
included on Ubuntu 24.04. Symbol stripping would be a separate trial.
