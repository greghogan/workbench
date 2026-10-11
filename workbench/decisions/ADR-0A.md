---
summary: Behavioral assertions, isolation, coverage, advisory timing.
---

# ADR-A: Test evidence and isolation

Test observable behavior at stable boundaries, with regressions for corrected defects and end-to-end evidence for
critical workflows. Cover failures, boundaries, cleanup, and recovery in proportion to their consequences.

Prefer the smallest test that catches an identifiable, meaningful regression. Avoid tests solely for trivial or
reversible layout changes, incidental substring matches, counts when identities matter, duplicate scenarios, and mocks
that echo constructed arguments. Assert outcomes, invariants, or a complete external contract. Rejection tests verify
failure and a useful diagnostic; text assertions belong where text itself is the contract. During implementation and
review, agents remove redundancy and replace weak assertions without waiting for human direction. Changed contracts
require evidence for the replacement behavior.

Routine suites use controlled time and local fixtures rather than real accounts, live services, or global user state.
Effectful tests are explicit and clean up what they create. Algorithm correctness uses independent references or
mathematical invariants with declared numerical tolerances; implementation-derived checksums serve as regression
evidence.

Configured checks run applicable language suites and ADR-9's supported-version checks. Project configuration owns
coverage scope and floors, including unexecuted production files. Checks fail below floors; coverage does not establish
assertion quality. Coverage is an alternative execution of the same test suite, enforcing both test outcomes and floors.
Keep ordinary tests uninstrumented; select coverage automatically by configured stage and target, or explicitly on
request. CI targets need not all collect coverage.

Retain compact, normalized coverage summaries when coverage runs present changes against a committed baseline to the
human in terminal and CI output. Keep full reports outside version control. Missing baselines are explicit; comparisons
do not replace coverage floors or behavioral assertions.

Declare advisory slow-test and suite thresholds for ordinary tests, with host and build/setup context. Coverage needs no
additional timing policy. Elapsed time alone never terminates tests or fails a check; infrastructure job lifetimes are
separate limits. Retain machine-readable CI results for comparison across runs.

Humans approve increased timing caps, reduced coverage floors, expanded exclusions, and reductions to required test
scope, including required stages and coverage targets. Improving a metric must preserve meaningful behavioral evidence;
redundant tests may be removed when that evidence remains. Never hide unexecuted paths or weaken assertions to satisfy a
number.

Rationale: Behavioral evidence catches material regressions; isolation makes routine checks repeatable and safe to run
often.
