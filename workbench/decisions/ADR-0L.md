---
summary: CPU baseline, safe dispatch, verification.
---

# ADR-L: Architecture-specific optimization

Declare the supported CPU baseline. Portable artifacts retain an implementation for that baseline and dispatch optional
instruction sets only after verifying CPU and operating-system support. Host-specific compilation is explicit and does
not silently change the distribution baseline.

Expose safe selection of each backend for verification; forcing a backend never bypasses feature checks. Test the
baseline, automatic selection, and available specialized implementations against the same contract, including declared
numerical tolerances. Exercise vector boundaries and unaligned inputs where the interface permits them. Record paths
that could not execute on the test host; cross-compilation is not execution evidence.

Keep intrinsic and unsafe code behind narrow interfaces with documented preconditions. Production specialization needs
representative performance evidence under ADR-9 sufficient to justify its maintenance cost. The executable references
demonstrate dispatch and verification without claiming a speedup.

Rationale: Portability and behavioral equivalence are retained choices; specialized code earns its additional cost
through measured benefit.
