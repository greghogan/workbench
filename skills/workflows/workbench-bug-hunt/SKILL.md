---
name: workbench-bug-hunt
description:
  Investigate and fix verified defects when asked to find bugs or probe edge cases in recent Workbench work. Keep the
  requested boundary; do not expand into a full-project audit.
---

# Focused defect investigation

Establish the requested behavior and affected path, including immediate callers and failure handling. Choose probes
capable of disproving its invariants; use the applicable testing decision to keep evidence behavioral and proportionate.

Reproduce suspected defects before labeling them bugs. Fix confirmed defects within the authorized behavior, retain a
useful regression, and verify the result. If a finding exposes competing semantics or independent work, explain the
evidence and decision needed instead of choosing a new feature during investigation.

Report confirmed fixes and remaining evidence-backed concerns, or say that no defect was established. Do not stage or
commit unless requested. Preserve unrelated edits and use existing task records when investigation spans sessions.
