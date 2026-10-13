---
name: workbench-experiment
description:
  Plan, run, and record a requested falsifiable experiment in a Workbench project. Use for candidate-versus-baseline
  measurements and EXP evidence, not routine tests or exploratory profiling.
---

# Recorded experiment

Read the applicable experiment, execution-resource, and environment-record decisions. Find related experiments and the
owning scope before starting a new trial.

1. Define baseline and candidate, controlled difference, workload, correctness condition, metric, and stopping and
   evaluation rules. Use `workbench experiment add --help` for the record interface; keep the protocol in the record
   before measuring. Resolve a missing success criterion before running a comparison that cannot answer the question.
2. Identify the exact source and build selections for each execution. Preserve a patch against a named baseline when the
   tested source will not be retained with the record. Identify hardware through an environment record and retain
   run-specific software and scheduling provenance.
3. Run matched comparisons through the configured scheduler. Keep correctness checks distinct from the measurement;
   account for drift, exclusions, and failures in the analysis. A new trial gets a new record.
4. Verify extracted measurements against raw reports. Retain enough evidence to assess the conclusion after temporary
   reports are gone, including variation where relevant. Explain accepted, rejected, or inconclusive results against the
   declared rule; favorable measurements alone do not authorize acceptance.

Agents may implement and measure a candidate before review. Present the completed record for human review before commit;
when accepted, commit it with the exact tested implementation. Do not commit without the user's authorization and
required record approval, or insert a placeholder for the commit's own hash.
