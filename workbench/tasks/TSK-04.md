---
status: Done
parent: workbench:TSK-1
depends_on: []
---

# TSK-4: Complete and verify native release LTO integration

## Review summary

Implemented release LTO for C and C++, with compiler-consistent tools, isolated builds, invalid-configuration rejection,
and standalone optimized execution. Local supported-mode checks passed; the evidence below identifies the tested
compilers and managed environments. Hosted verification remains in workbench:TSK-7.

## Progress

- [x] Implement coherent C and C++ release LTO modes.
- [x] Verify supported modes and reject invalid configurations.
- [x] Exercise optimized artifacts outside the source checkout.

## Outcome

Implement and test explicit off/full/thin LTO choices under workbench:ADR-P with coherent compiler, linker, and archive
tools, separate build modes, and behavioral verification of optimized releases.

## Implementation

Both C and C++ references implement explicit LTO selection. Clang requires matching LLVM archive tools and a
platform-appropriate LLD, probes the exact requested mode, and builds full or thin bitcode. GCC full LTO uses its own
archive wrappers and CMake's IPO capability check. Unsupported selections fail. Project libraries are explicitly static,
so optimized behavioral tests link across translation units through archives.

The adapter isolates debug, coverage, sanitizers, optimized modes, and configured releases. Configuration resets
instrumentation options explicitly. Each optimized mode runs the complete behavioral suite and checks a copied binary,
including JSON output, outside the checkout. Negative checks cover invalid modes, debug LTO, instrumentation conflicts,
mismatched LLVM tools, and GCC ThinLTO. Release preparation runs these behavioral and standalone checks before replacing
its artifact; regression tests preserve the prior artifact when either verification step fails.

Compiler compatibility jobs now include the LTO role. Both pinned Nix and Guix environments include LLD without changing
channel, flake, or compiler pins. C++ probes disable unnecessary module scanning for this header-based reference.
Documentation describes selection, support boundaries, and verification.

## Verification

On 2026-10-10, Linux x64 verification passed against the configured compiler versions:

| Compiler     | Modes exercised | C      | C++    |
| ------------ | --------------- | ------ | ------ |
| Clang 21.1.8 | off, thin, full | Passed | Passed |
| Clang 23.1.2 | off, thin, full | Passed | Passed |
| GCC 14.4.0   | off, full       | Passed | Passed |
| GCC 15.3.0   | off, full       | Passed | Passed |
| GCC 16.2.0   | off, full       | Passed | Passed |

The compatibility runner completed ordinary tests, sanitizer and portable-only suites, every declared LTO mode, and
negative checks for Clang 21 and GCC 14/15/16 in both languages. Compiler verification reused installed GCC versions; no
GCC compiler builds were triggered. Clang 21 installations were acquired and verified through the production streaming
installer before compatibility runs.

The root native CI gate passed all 194 tests in 44 files, coverage floors, types, formatting, lint, bundle parity,
structural validation, shell/workflow checks, executable documentation, advisory scanning, and credential scanning.
Coverage remained 86.45% lines, 80.07% statements, 88.78% functions, and 74.59% branches. Both complete C/C++ native CI
gates passed, including source-based coverage and the Clang 23 LTO checks. Portable-only suites intentionally skip the
unavailable AVX2 backend while testing its rejection behavior.

Both C and C++ release preparation passed with configured Clang full LTO through their standalone Makefiles and with
selected GCC full LTO through Workbench. Logs are retained locally under `/tmp/workbench-lto-*`; tests are part of the
repository.

## Remaining evidence

Native ARM64, macOS, Windows, managed environments, and hosted workflow execution remain workbench:TSK-7. Local Linux
x64 results do not establish those targets. Nothing was committed, pushed, published, or deployed.

The neighboring graphmp project's Makefile explicitly selects ThinLTO for its PGO build and full LTO for its PGO
comparison build; ordinary Cargo release settings do not explicitly enable LTO. No graphmp files were changed.
