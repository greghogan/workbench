---
summary: Compiler and language targets, required LLVM checks, platform-specific compilers, and dependency ABI ownership.
---

# ADR-12: C and C++

Declare language standards and compiler baselines separately from development pins. Projects choose Clang, GCC, or the
Microsoft C/C++ compiler independently of supported compiler families and retain the declared standard across compiler
profiles. Disable language extensions and deny warnings. LLVM remains required for formatting, analysis, and
source-based coverage; alternative compilers are required only when selected for development or compatibility checks.
Pin each selected compiler independently from required LLVM tools. Pin the Windows SDK when selecting the Microsoft
compiler.

Native GCC is supported on Linux x64/ARM64; the Microsoft compiler is supported on Windows x64; Clang covers configured
native platforms. Reject unsupported compiler, platform, language-standard, and optimization combinations explicitly.
Select Clang compatibility profiles from the latest three stable majors without claiming upstream maintenance for all
three.

Guix/Nix development includes LLDB and includes GDB if and only if GCC is a development compiler, not merely a
transitive runtime. Keep debugger dependencies coherent with selected tools.

Build code and dependencies with the selected compiler. Clang analysis uses a compatible compilation database and
dependencies. Separate coverage builds do not replace selected-compiler tests. Preserve compiler, target, runtime,
linkage, and ABI identities across dependency builds and binary caches. Dependency resolution and direct build-system
fetches use immutable inputs.

Use clang-format, broad clang-tidy analysis, and supported address/undefined-behavior sanitizers. C boundaries state
ownership, buffer lengths, errors, and FFI contracts. C++ prefers standard ownership and view types and explicit
exception contracts. Confine raw-pointer and intrinsic operations to narrow documented interfaces.

Rationale: Shared tool ownership and explicit ABI contracts expose low-level assumptions while separate language checks
preserve C and C++ semantics.
