---
summary: C17, LLVM checks, FFI, vcpkg dependencies.
---

# ADR-I: C implementation

Apply ADR-B. Declare the C language standard and supported compiler baseline separately from the development pin. The
reference selects C17, Clang for development, CMake, and Ninja. Projects select Clang or GCC as their development
compiler and declare supported compiler families independently. LLVM is required for formatting, analysis, and
source-based coverage. Clang development consumes that LLVM selection; GCC has its own pin and is required only when
selected for development or a compatibility check. Compile without language extensions and deny warnings.

Apply ADR-B's compatibility coverage to declared compiler families and maintained release lines, retaining the chosen
language standard across development and compatibility checks.

Workbench supports GCC installation and compiler compatibility coverage on Linux only, on both supported native
architectures. Clang supports every native platform declared in ADR-Z. This bounds platform-specific GCC toolchain and
SDK integration while retaining compiler diversity on Linux. ADR-J inherits this platform policy for C++.

Build project code and dependencies with the selected compiler. Separate build and dependency installations by compiler,
version, environment, and language standard. Analyze a Clang-compatible compilation database with matching dependencies;
retain ordinary selected-compiler tests when coverage uses a separate Clang build.

Use clang-format, broad applicable clang-tidy groups, behavioral tests, source-based coverage, and address/undefined
behavior sanitizers on supported targets. Keep ownership, buffer lengths, error reporting, and FFI contracts explicit at
public boundaries. Architecture-specific implementations follow ADR-L.

The reference uses vcpkg manifest mode. Pin its tooling revision and registry baselines; declare dependencies and any
exact overrides in the manifest. A baseline supplies default versions and minimum constraints, not a lockfile. Build
dependencies with the selected compiler, target, runtime, and linkage; preserve ABI tracking in binary caches. Keep
project installations separate from shared download and binary caches. Host SDK prerequisites remain explicit.

Other dependency managers retain their own locks or immutable source hashes. Direct CMake fetches use immutable
revisions or verified archive hashes; routine checks do not resolve floating dependencies.

Rationale: Explicit compiler and check-tool ownership and explicit ABI contracts make C's otherwise implicit assumptions
reviewable.
