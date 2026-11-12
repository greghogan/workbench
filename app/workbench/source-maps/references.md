# Examples and quality support

- `test/integration/tooling/document_properties.test.mts`, `test/integration/tooling/property_exploration.test.mts`:
  Exercise generated document/scope inputs, reproducible exploration, deliberate contract defects, and partial-failure
  regressions.
- `test/integration/tooling/security_results.test.mts`: Gate security analysis on complete, successful SARIF evidence
  and enforce authored-source security findings.
- `src/core/distribution/tooling-artifacts.mts`: Owns generated-file classification and development setup.
- `src/core/execution/snapshots/source-checkout.mts`, `test/fixtures/cache-checkout.mts`: copies full source checkouts
  for packaging and coverage, and minimal manifests for cache-planning tests.
- `test`: exercises both project layouts, every record type, contextual help, skill activation, and safe cleanup.
- `test/core/toolchains/native_release.test.mts`: Verifies optimized linkage, supported compiler modes, relocated
  execution, and release failure safety.
- `src/core/execution/checks/coverage-summary.mts`: normalizes coverage baselines and presents changes in terminal and
  CI summaries.
- `test/core/toolchains/rust_release.test.mts`: Verifies native and musl release behavior, ELF linkage, offline
  execution, and failure safety.
- `src/core/runtime/values.mts`: Validates shared helper input shapes and required values.
- `test/tsconfig.json`: Checks test fixtures against their test-runtime APIs while the root TypeScript project
  separately checks the application baseline.
- `test/fixtures/installations.mts`, `test/fixtures/review-interaction.mts`: Share per-test fixture setup and cleanup
  across isolated installation and review suites while keeping writable state and mocks local to each suite.
- `test/integration/workflows/skill_evaluation.test.mts`: Exercises skill workflows with per-scenario repositories,
  remotes, and user state.
- `test/integration/tooling/coverage_workers.test.mts`: Verifies serial/parallel counter equivalence, malformed-report
  diagnostics, and thread cleanup after worker failures.
- `test/fixtures/coverage-producers.mts`, `test/integration/tooling/coverage_producers.test.mts`: Attribute malformed
  coverage to owning tests and completed processes or threads without collecting command arguments, environment values,
  or source contents.
- `src/core/runtime/process-outcome.mts`: Describes child exit status, signals, and spawn errors without adding command
  arguments or environment values to the diagnostic message.
- `test/fixtures/process.mts`: Supplies complete mocked process outcomes and consistent fixture success assertions with
  bounded captured output.
- `test/integration/tooling/coverage_failures.test.mts`: Exercises child failures and primary-error preservation across
  result retention, diagnostic writing, cleanup, and timing output failures.
- `src/core/artifacts/engineering-run.mts`, `test/integration/tooling/engineering_artifacts.test.mts`,
  `test/integration/tooling/optimization_inputs.test.mts`, `test/integration/tooling/optimization_selection.test.mts`:
  Own engineering child processes and scratch, derive build-input provenance, and publish verified optimization
  artifacts with rollback.
- `test/integration/tooling/profile_capture.test.mts`: Define named profiling cases and validated counters collected
  from the actual measured process.
- `test/core/runtime/file_reads_faults.test.mts`: Exercise mid-read mutation and simultaneous read/descriptor-cleanup
  failures.
- `test/integration/tooling/native_tooling.test.mts`: Verifies explicit bootstrap tracking, direct TypeScript CI
  execution, erasable syntax, and retirement of obsolete generated files.
- `test/integration/maintenance/maintenance_go.test.mts`: Discover canonical Go module versions through tagged releases
  and the proxy's pseudo-version fallback, preserving exact pins and semantic ordering.
