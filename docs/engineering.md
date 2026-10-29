# Extended engineering checks

These workflows supplement ordinary checks. Run the commands from the Workbench repository root in its prepared
development environment. Consuming projects select their registered roots and adapt the reference workloads to their
actual applications. The examples demonstrate mechanics without establishing a performance improvement.

## Generated inputs and test quality

Normal tests include bounded properties for TOML editing, path validation, and project ownership. Go's ordinary tests
execute its fuzz seed corpus. Extended exploration and deliberate faults are explicit:

```sh
workbench check --path . --role fuzz --no-cache
workbench check --path . --role mutation --no-cache
workbench check --path examples/languages/go --role fuzz --no-cache
```

For a chosen budget or replay seed, use `node scripts/check-fuzz.mjs --runs 20000 --seed 12345`. Failures report their
seed, shrink path, and minimized input in `fuzz-results.json`. Select a stable property ID with
`--property toml-values`; replay a failure with its `--seed` and `--path`, selecting exactly one property. Promote
useful failures to ordinary regression fixtures. Go exploration uses a disposable source copy and retains discovered
inputs in its owned `fuzz-failures` build directory. Neither workflow changes the project's source files.

Mutation checking verifies the unmodified properties first, injects named faults into private bundles, then runs real
partial-publication and recovery regressions. Syntax, import, or process failures do not count as detected defects. This
establishes selected critical contracts rather than a whole-project mutation score. `mutation-results.json` records the
selected property and verdict for each injected fault.

## Security analysis

CI runs the pinned CodeQL action against authored TypeScript and the bootstrap entry points with security-extended
queries. Generated JavaScript is outside that extraction scope. The SARIF check fails on warning/error findings, absent
analysis, or failed analyzer invocations. Source suppressions identify specific rules and explain their local trust or
ownership invariant. The suppression query marks exceptions in SARIF; strict lint requires an explicit rule and written
explanation for each annotation. Accepted analyzer suppressions are exceptions subject to change review. Fork pull
requests run analysis without requiring an upload-capable token.

For an eligible local CodeQL installation, run from the repository root:

```sh
codeql database create /tmp/workbench-codeql --language=javascript-typescript --build-mode=none --source-root=. --codescanning-config=.github/codeql.yml
codeql database analyze /tmp/workbench-codeql .github/codeql-queries/workbench.qls --format=sarif-latest --output=/tmp/workbench-codeql-results.sarif
node scripts/check-security-results.mjs /tmp/workbench-codeql-results.sarif
```

Reproduce CI findings with the CLI/query versions linked by the pinned action. CodeQL licensing governs eligible use; it
is not an application runtime dependency or a universal collection requirement. Triage findings against the declared
filesystem, process, and web trust boundaries. Fix defects and document narrow justified exceptions.

Selected GCC C checks additionally use GCC's analyzer; selected `mvsc` C/C++ checks use Microsoft's code analysis. Clang
analyzer checks remain enabled through clang-tidy for both languages. Unsupported explicit requests fail instead of
silently skipping analysis.

## Profile-guided optimization

```sh
workbench check --path examples/languages/c --role pgo --compiler clang --no-cache
workbench check --path examples/languages/c --role pgo --compiler gcc --no-cache
workbench check --path examples/languages/cpp --role pgo --compiler clang --no-cache
workbench check --path examples/languages/cpp --role pgo --compiler gcc --no-cache
workbench check --path examples/languages/rust --role pgo --environment native --no-cache
workbench check --path examples/languages/go --role pgo --no-cache
```

C/C++ and Rust build instrumented training variants, collect profiles, then build separate optimized variants. Clang and
Rust use compatible LLVM profile tools; GCC uses its own profile format. Go collects a CPU profile from the reference
benchmark. Each workflow runs the complete optimized tests and independent CLI inputs outside the source checkout. The
checked artifact and compact provenance remain in that root's owned `pgo` build directory. Training objects and raw
profiles are disposable and removed afterward. Preserve required profiles separately when adopting them as durable
release or experiment inputs.

Ordinary Go builds disable implicit `default.pgo` discovery. The CMake example has explicit off/generate/use modes and a
profile directory. Missing profiles, unsupported compilers, and mixed coverage/sanitizer training are rejected. C/C++
PGO currently supports Clang and GCC; `mvsc` PGO is not configured. Rust requires profile tools matching its LLVM major.
Adapt the training workload, provenance, compatible reuse, and refresh policy together. Shared PGO checks are manual by
default; Workbench explicitly qualifies its own reference workloads in CI with the `pgo-qualification` role.

Training, optimized tests, relocation checks, and source-input revalidation finish in private scratch before publishing
the executable and matching provenance together. A failed verification or replacement preserves the previous verified
output. Provenance includes declared manifests, source hashes, selected modes, compiler identity, and profile-tool
identity where a separate merger is used.

## Profiling Workbench

```sh
workbench check --path . --role profile --no-cache
```

Select individual cases with
`node scripts/profile-workbench.mjs --case validation --case web --samples 3 --output /tmp/workbench-profiles`. Other
cases cover startup and check planning. Each report identifies its source tree, lists relative capture files and sizes,
and records samples incrementally, retaining completed evidence and the failure if a later sample fails. Unprofiled
samples are separate from CPU/heap-profiled runs. Reports record platform, Node, CPU availability, wall time, process
CPU, maximum RSS, and kernel block-I/O counters where available. Those counters exclude subprocesses and do not count
all network-filesystem requests. Fresh processes do not imply cold filesystem caches. Captures are Node CPU and sampling
heap profiles, not whole-system accounting. The extended engineering CI job retains the execution report, rebuild
summary, and profiling captures for comparison.

Copy evidence needed for durable performance claims into experiment supporting files. ADR-8 governs representative
workloads, comparisons, uncertainty, and human review; ordinary exploration need not become an experiment.

## Hardened and reproducible artifacts

```sh
workbench check --path examples/languages/c --role hardening --no-cache
workbench check --path examples/languages/cpp --role hardening --no-cache
workbench check --path . --role reproducibility --no-cache
```

Hardening verifies application behavior and native executable protections: full RELRO/non-executable stack on ELF,
ASLR/DEP/control-flow guard on PE, and PIE/non-executable stack on Mach-O. The explicit Windows variant currently
requires `mvsc`. These checks preserve the declared CPU baseline and do not establish the absence of security defects.

Reproducibility checking freezes source once, rebuilds tooling and application bundles in two independent locations,
compares generated outputs and package bytes, and executes both rebuilt CLIs. It reuses verified dependencies while
rebuilding generated application bundles. Its synthetic capture is verification evidence, not a published revision. This
extends deterministic archive tests without claiming cross-machine or cross-platform bit reproducibility. Each frozen
checkout runs its own build entry points in separate processes. Streaming comparisons use fixed-size buffers; the
retained `reproducibility.json` report includes output hashes, sizes, and the first differing byte when results diverge.
Temporary source trees are cleaned after success or failure.
