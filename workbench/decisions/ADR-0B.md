---
summary: Behavioral assertions, isolated execution, coverage deltas and floors, and advisory timing.
agent_instruction:
  Obtain human approval before increasing advisory timing thresholds, lowering coverage floors, expanding exclusions, or
  reducing required test or coverage scope.
---

# ADR-B: Test evidence and isolation

Test observable behavior at stable boundaries, with regressions for defects and end-to-end evidence for critical
workflows. Cover failures, cleanup, boundaries, and recovery in proportion to their consequences. Prefer the smallest
test catching a meaningful regression; replace incidental text checks, argument-echoing mocks, and redundant scenarios
with outcomes, invariants, or complete external contracts. Text assertions are appropriate when text is the contract.
Rejection tests establish failure and a useful diagnostic. Agents improve weak assertions during implementation and
review; changed contracts need replacement evidence.

Routine suites use local fixtures, not real accounts, services, or global user state. Effectful tests are explicit and
clean up their resources. Algorithms use independent references or mathematical invariants with declared tolerances;
implementation-derived checksums establish only regression evidence.

Use mocked clocks for assertions about time-dependent behavior. Use explicit synchronization for concurrent behavior;
wall-clock watchdogs only bound hangs.

Tests own their record fixtures and supporting files rather than borrowing the project's live policy or evidence.
Validate project records separately.

Require coverage where suitable tooling is available. Language policies and project configuration document supported
metrics and unavailable targets. ADR-A defines coverage scope. Configuration declares coverage floors and approved
exclusions. Coverage executes the same suite and enforces test outcomes and floors; it does not establish assertion
quality. Keep ordinary tests uninstrumented for development. Commit gates use coverage in place of ordinary tests on
configured supported targets. Retain a designated CI coverage run; other CI targets use ordinary tests. Explicit
coverage execution remains available.

Retain compact normalized coverage summaries only when terminal and CI output present changes against the committed
baseline. Report missing baselines explicitly and keep full reports untracked. Comparisons do not replace floors.

Declare advisory suite thresholds and, where supported, per-test thresholds for ordinary tests, with host and
build/setup context. Timing alone neither fails nor terminates tests; infrastructure lifetimes are separate. Retain
machine-readable CI results for comparison. Coverage needs no additional timing policy.

Humans approve increased advisory timing thresholds, reduced floors, expanded exclusions, and reduced required scope,
stages, or coverage targets. Removing redundancy is permitted when meaningful evidence remains; never hide paths or
weaken assertions to satisfy a metric.

Rationale: Behavioral evidence catches material regressions, while isolation makes routine checks repeatable and safe.
