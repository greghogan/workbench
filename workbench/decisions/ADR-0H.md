# ADR-H: Rust implementation

Summary: Rust code uses explicit errors, cohesive modules, deterministic tests, and the standard formatter and linter.

Fallible external operations return errors instead of panicking in production paths.

Rust checks use rustfmt, Clippy with warnings denied, Nextest, and documentation tests unless a project configures
equivalent commands.

`Cargo.toml` owns release flags and `rust-version`; the development environment pins the current compiler separately.

Distributed Linux binaries target a declared portability baseline. Prefer static musl where suitable; otherwise build
against the oldest supported glibc. Define cross targets and images in `Cross.toml` and build with locked dependencies.

Experimental flags do not alter the canonical release build until the change is accepted in source control.

The executable reference is `examples/languages/rust`.
