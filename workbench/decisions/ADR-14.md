---
summary: C17, LLVM checks, FFI, vcpkg dependencies.
---

# ADR-14: C implementation

Apply ADR-9. Declare the C language standard and supported compiler baseline separately from the development pin. The
reference selects C17, Clang for development, CMake, and Ninja. Projects select Clang or GCC as their development
compiler and declare supported compiler families independently. LLVM is required for formatting, analysis, and
source-based coverage. Clang development consumes that LLVM selection; GCC has its own pin and is required only when
selected for development or a compatibility check. Compile without language extensions and deny warnings.

For projects declaring compiler compatibility profiles, prefer upstream-maintained GCC majors and the latest three
stable LLVM/Clang majors, using the latest patch in each selected line. Retain the chosen language standard across
development and compatibility checks. Review GCC retirement when upstream closes its branch; review Clang retirement
when a new stable major moves the oldest major outside the three-major window. Update minima, CI coverage, and
acquisition metadata together.

The Clang window specializes ADR-9: it guides project support beyond LLVM's short upstream patch cycle, not a claim that
upstream maintains all three majors. It allows projects to select compilers about a year behind the latest stable major.
GCC's maintained branches already provide a longer compatibility window. Development uses the newest suitable maintained
release. Retaining older compilers for project or pinned-environment constraints requires a documented scoped exception;
distribution availability alone does not establish upstream maintenance.

Workbench supports GCC installation and compiler compatibility coverage on Linux only, on both supported native
architectures. Clang supports every native platform declared in ADR-10. This bounds platform-specific GCC toolchain and
SDK integration while retaining compiler diversity on Linux.

Build project code and dependencies with the selected compiler. Separate build and dependency installations by compiler,
version, environment, and language standard. Analyze a Clang-compatible compilation database with matching dependencies;
retain ordinary selected-compiler tests when coverage uses a separate Clang build.

Use clang-format, broad applicable clang-tidy groups, behavioral tests, source-based coverage, and address/undefined
behavior sanitizers on supported targets. Keep ownership, buffer lengths, error reporting, and FFI contracts explicit at
public boundaries. Architecture-specific implementations follow ADR-N.

Optional release link-time optimization follows ADR-P; native artifact selection and installation follow ADR-O.

The reference uses vcpkg manifest mode. Pin its tooling revision and registry baselines; declare dependencies and any
exact overrides in the manifest. A baseline supplies default versions and minimum constraints, not a lockfile. Build
dependencies with the selected compiler, target, runtime, and linkage; preserve ABI tracking in binary caches. Keep
project installations separate from shared download and binary caches. Host SDK prerequisites remain explicit.

Other dependency managers retain their own locks or immutable source hashes. Direct CMake fetches use immutable
revisions or verified archive hashes; routine checks do not resolve floating dependencies.

Rationale: Explicit compiler and check-tool ownership and explicit ABI contracts make C's otherwise implicit assumptions
reviewable.
