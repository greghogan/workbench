---
summary: Optional release LTO, compiler/linker coherence, isolated builds, optimized behavioral verification.
---

# ADR-P: Link-time optimization

Projects select link-time optimization explicitly in their native build configuration. Keep ordinary development,
coverage, and sanitizer builds separately selectable. LTO does not change the declared CPU baseline in ADR-N and does
not imply a performance improvement without ADR-M evidence.

Declare disabled, full, or thin LTO where supported by the selected compiler and target. Require compatible compiler,
linker, archive tools, runtimes, and any bitcode dependencies; retain these components during ADR-O filtering. Fail an
unsupported requested mode rather than silently disabling it or substituting another mode. GCC's ordinary LTO is full;
LLVM ThinLTO is a separate selection. Rust uses its Cargo profile and Rust toolchain rather than a separate C/C++ LLVM
installation unless a cross-language build explicitly requires one.

Keep LTO build identities separate from ordinary builds and preserve dependency ABI tracking. Execute the optimized
artifact's behavioral tests and standalone release checks, including static-library linkage across translation units. CI
verifies enabled modes on their declared compiler and platform coverage. A successful compiler probe is necessary
configuration evidence, not a substitute for linking and running the resulting program.

Rationale: LTO affects artifact construction and toolchain compatibility independently of source language and CPU
specialization; explicit selection and execution make that contract observable.
