---
summary: Errors, unsafe code, stable and Miri toolchains, MSRV, portability.
---

# ADR-11: Rust implementation

Apply ADR-9. Fallible external operations return errors instead of panicking in production paths.

Rust checks use rustfmt, Clippy's default, pedantic, and nursery groups with warnings denied, Nextest with advisory
slow-test reporting, source-based coverage, and documentation tests unless a project configures equivalent commands.
Select applicable restriction lints individually; the group contains conflicting rules. Keep exact selections and
justified exceptions in the reference configuration.

Unsafe and FFI code stays behind narrow interfaces with explicit safety contracts. Require safety comments and explicit
unsafe operations even inside unsafe functions; tests do not replace the ownership and lifetime argument.

Use targeted Miri checks when changing project-owned unsafe Rust where supported. Pin a separate dated nightly with Miri
and standard-library sources, keeping ordinary builds on their selected compiler. Configure its test scope and
invocation explicitly; native or Dev Container rustup checks need not share Guix/Nix compiler versions. Retain
isolation, leak, and aliasing checks unless a scoped exception is documented. Identify unsupported operations and retain
native evidence; an interpreter pass does not establish soundness or hardware behavior.

`rust-toolchain.toml` or the selected environment owns the compiler, formatter, and linter. Each native root's toolchain
file declares the minimal rustup profile with Clippy, rustfmt, rust-analyzer, rust-src, and matching LLVM coverage
tools, retaining these components across updates even when rustup shares installations. `Cargo.lock` owns dependency
resolution; `Cargo.toml` owns release flags and `rust-version`, the tested minimum compiler under ADR-9.

Rust upstream [maintains only its latest compiler](https://doc.rust-lang.org/cargo/reference/rust-version.html); use
current stable for native development. As an exception to ADR-9's minimum and release-line coverage policies, an older
minimum may accommodate environments or consumers when justified and tested. Test current stable and the declared
minimum rather than every intervening compiler release. Compatibility or availability in a pinned environment does not
establish upstream or vendor maintenance.

Distributed Linux binaries target a declared portability baseline. Prefer static musl where suitable; otherwise build
against the oldest supported glibc. Define cross targets and images in `Cross.toml`.

Experimental flags do not alter the canonical release build until the change is accepted in source control.

Rationale: Explicit failures and standard checks expose errors early; a declared portability baseline makes releases
usable.
