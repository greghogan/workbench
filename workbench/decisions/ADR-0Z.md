---
summary: Error and unsafe-code contracts, stable and Miri toolchains, compiler support, and Linux portability.
---

# ADR-Z: Rust

Fallible external operations return errors rather than panic in production paths. Confine unsafe and FFI code to narrow
interfaces with explicit safety contracts, safety comments, and explicit unsafe operations even inside unsafe functions.
Tests do not replace ownership and lifetime arguments.

Use rustfmt and strict Clippy analysis, documentation tests, and source-based coverage.

Run targeted Miri checks for changed project-owned unsafe code where supported, using a separately pinned dated nightly.
Retain default isolation and memory checks unless a scoped exception is documented. Record unsupported scope and retain
native execution evidence. Miri supplements safety arguments and native execution; ordinary builds retain their selected
compiler.

Native development uses current stable under
[Rust's maintenance policy](https://doc.rust-lang.org/cargo/reference/rust-version.html). A declared `rust-version` may
accommodate older consumers or environments; select compatibility profiles when behavioral evidence is required. Managed
availability does not establish compatibility policy.

Standalone Linux binaries declare their CPU and kernel baseline and prefer static musl where suitable. Dynamically
linked releases declare their runtime requirements; managed packages retain their required runtime closure.

Rationale: Explicit failure and safety contracts support review; current toolchains and declared portability make
releases usable without inventing unsupported upstream maintenance promises.
