# ADR-B: Test evidence and isolation

Summary: Tests provide proportionate evidence at stable boundaries without depending on uncontrolled machine state.

Test important behavior at stable boundaries, with regressions for corrected defects and end-to-end evidence for
critical workflows.

Routine suites avoid real accounts, live services, global user state, and wall-clock assumptions. Effectful tests are
explicit and clean up what they create.

Configured checks run the applicable language suites; project configuration owns any coverage threshold.
