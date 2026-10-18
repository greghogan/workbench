---
summary: CPU baseline, safe dispatch, verification.
---

# ADR-M: Architecture-specific optimization

Declare the supported CPU baseline. Portable artifacts must run on it, including their dispatch and fallback code.
Explicit builds may target higher CPU requirements; declare those requirements separately from the portable baseline.

Dispatch specialized implementations only after verifying CPU and operating-system support for all required features.
Expose backend selection for verification without bypassing those checks. Test baseline, automatic, and available
specialized paths against the same contract and applicable numerical tolerances. Cover boundary and alignment cases;
record paths unavailable on the test host.

Confine intrinsics and unsafe code to narrow interfaces with documented preconditions. Production specialization needs
representative ADR-8 performance evidence justifying its maintenance cost; executable examples demonstrate dispatch and
verification without claiming speedups.

Rationale: Explicit baselines preserve portability; specialization earns its cost through equivalent behavior and
measured benefit.
