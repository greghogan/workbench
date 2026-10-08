---
summary: C++20, ownership, exceptions, native checks.
---

# ADR-J: C++ implementation

Apply ADR-B and the native tooling and dependency rules in ADR-I. Declare the language standard independently of the
compiler pin; the reference selects C++20. Prefer standard ownership and view types at API boundaries, with explicit
error and exception contracts. Confine raw pointer and intrinsic operations to narrow documented interfaces.

Apply ADR-I's compiler selection, compatibility coverage, and unconditional LLVM requirement to C++ as well.

Use clang-format, broad applicable clang-tidy groups including modernize and C++ Core Guidelines, and warnings as
errors. Resolve conflicting style rules explicitly. Execute behavioral tests, source-based coverage, and supported
sanitizers. Architecture-specific implementations follow ADR-L.

Rationale: Typed ownership and a constrained tool configuration reduce the amount of low-level code needing special
review.
