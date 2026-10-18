---
name: workbench-experiment
description:
  Plan, run, and record a requested testable experiment in a Workbench project. Use for candidate-versus-baseline
  measurements and EXP evidence, not routine tests or exploratory profiling.
---

# Recorded experiment

Read the applicable experiment, execution-resource, and environment-record decisions. Find related experiments and the
owning scope before starting a new experiment.

1. Define baseline and candidate, controlled difference, workload, correctness condition, and metric. Use
   `workbench record add experiment --help` for the record interface; record the intended comparison and protocol. Use
   pilot runs to refine measurement procedures, document evaluation and stopping decisions, and account for adaptive
   sampling when assessing confidence. Resolve a missing success criterion before running a comparison that cannot
   answer the question.
2. Identify the exact source and build selections for each execution. Preserve a patch against a named baseline when the
   tested source will not be retained with the record. Link an environment record and its exact configuration profile;
   add relevant inventories and characterization evidence for a new configuration while preserving older captures.
   Record allocated resources and actual software and scheduling provenance following the
   [environment profile guide](../../../docs/records.md#experiment-provenance-and-environment-profiles).
3. Run matched comparisons. Keep correctness checks distinct from the measurement; account for drift, exclusions, and
   failures in the analysis. Keep repeated runs as evidence for the existing experiment; create a new record for a new
   comparison or materially changed protocol.
4. Verify extracted measurements against raw reports. Retain enough evidence to assess the conclusion after temporary
   reports are gone, including variation where relevant. Explain accepted, rejected, or inconclusive results against the
   declared rule; favorable measurements alone do not authorize acceptance.

Agents may implement and measure a candidate before review. Present the experiment and any changed environment records
and supporting files for human review before commit; when accepted, commit the experiment with the exact tested
implementation. Do not commit without the user's authorization and required record approval, or insert a placeholder for
the commit's own hash.
