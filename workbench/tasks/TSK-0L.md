---
status: Done
parent: null
depends_on: []
---

# TSK-L: Adopt verified GCC release packages

## Review summary

Replace Workbench's GCC source builds and compiler-specific Docker images with the verified, relocatable Linux packages
published by `foss-mirror/gcc-releases`. Use the same native installer for development, hosted CI, and local rehearsal.
Keep the selected GCC versions and managed-environment pins unchanged. All six published package identities and
attestations are verified. Linux x64 installation, native C/C++ gates, six isolated compiler targets, and Workbench's
complete local gate passed. Remote Workbench verification follows workbench:TSK-M.

## Progress

- [x] Remove GCC source building and the compiler-specific container execution path.
- [x] Pin GCC 14.4.0, 15.3.0, and 16.2.0 binaries for Linux x64 and ARM64, including workflow attestations.
- [x] Default hosted GCC retention to verified redownloads, with explicit cache opt-in.
- [x] Update acquisition documentation and the applicable draft decision.
- [x] Verify installation, native C/C++ checks, and local CI using the published packages.

## Plan and evidence

The packages target glibc 2.28 or newer and retain the host libc development SDK. Their producer verifies relocation,
C/C++ compilation, LTO, and sanitizers on native x64 and ARM64 across AlmaLinux, Ubuntu, Debian, and Fedora. Workbench
continues to verify its own recorded SHA-256 pin and the producer's workflow identity before activating a package.

Successful producer run: https://github.com/foss-mirror/gcc-releases/actions/runs/38344029988 . All 18 builds and 72
distribution checks passed before publication.

Local verification on 2026-10-13 checked all six checksum sidecars and workflow attestations, installed all three x64
compilers, and exercised C/C++ tests, sanitizers, and LTO in the common Ubuntu rehearsal image. Native GCC 16.2.0 gates
also passed with LLVM analysis and formatting. The root gate passed 391 tests, formatting, lint, types, bundle parity,
documentation, shell/workflow checks, and credential scanning. The first native C attempt hit a vcpkg registry lookup
failure; the unchanged repeat and every isolated C target passed. Disposable logs are in
`/tmp/workbench-gcc-integration`; rehearsal results are in `/tmp/workbench-ci-reports-VxnsrU/reports`.
