---
name: workbench-audit
description:
  Audit and improve a whole Workbench project when explicitly invoked by name. Do not select for routine implementation,
  changeset review, or refactor advice.
disable-model-invocation: true
---

# Project audit

Establish the requested scope and outcome. Default to the whole project for an unqualified audit, including
architecture, public behavior, lifecycle and recovery, tests, documentation, and checks. Build a concise ownership model
before choosing subsystem probes; follow dependencies and failure paths rather than auditing files independently.

Create or resume a Workbench task for the audit. Keep reviewed boundaries, material evidence, open findings, and the
next entry point there so another session can continue. Reuse related tasks; independent actionable findings may become
child tasks. Use feedback for process ideas that are not yet project commitments. Do not create a parallel `AUDIT.md`
ledger.

Fix clear internal defects and worthwhile behavior-preserving simplifications within the requested scope. Verify actual
outcomes. Preserve user work and obtain direction for unresolved product or architectural choices; honor authority
already granted rather than repeatedly seeking it. Do not commit unless requested, and retain mandatory record review.

Distinguish demonstrated defects, supported design opportunities, and untested suspicions. Investigate or discard
suspicions before presenting them as findings. Record what remains unexamined; do not equate an audit with a guarantee.

Reconcile the task before completion. Report fixed findings, checks, coverage limitations, and every unresolved material
decision with a recommendation. Do not ask the user to approve routine cleanup or reproduce the entire audit ledger.
