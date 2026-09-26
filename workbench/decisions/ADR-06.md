# ADR-6: Experiments, benchmarking, and benchd

Summary: Falsifiable experiments retain matched correctness, measurement evidence, and honest execution provenance.

Agent instruction: With benchd installed, use `benchctl hold` for builds, tests, and CPU-heavy work; ask before bypass.

Create an experiment record for a falsifiable comparison: candidate and baseline, controlled difference, workload,
correctness criterion, metric, and evaluation rule. Exploratory profiling need not become a record.

Do not duplicate facts fixed by the tested revision and canonical release build. Record the workload, material
deviations, and evidence distinguishing the executions.

The benchmark defines correctness; benchd controls execution. Use benchd for heavy work when available and record any
approved bypass or absence.

An environment record identifies stable hardware and topology. Experiments reference it and record run-specific
software versions; software updates do not create a new environment.

Use matched conditions and interleaving when drift matters. Declare evaluation and stopping rules before seeing
results.

Microbenchmarks isolate a mechanism, exclude setup from timing, and retain correctness results. Workflow claims need
representative end-to-end evidence.

The agent selects the results and context needed to evaluate the conclusion, including underlying measurements when
summaries would hide variation, exclusions, or failures. The record must stand on its own after benchd deletes its
report; do not embed or compress a complete copy. New trials get new records; rejected candidates remain recoverable
while their evidence matters.

Humans review completed conclusions before commit, whether accepted, rejected, or inconclusive. Agents may run and
implement candidates before review; `Accepted` records a reviewed choice, not merely a favorable measurement.
