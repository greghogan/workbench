---
name: run-experiment
description:
  Plan, run, and record a requested testable experiment in a Workbench project. Use for candidate-versus-baseline
  measurements and EXP evidence, not routine tests or exploratory profiling.
---

# Recorded experiment

Read the applicable experiment, execution-resource, and environment-record decisions. Find related experiments and the
owning scope before starting a new experiment.

1. Define baseline and candidate, controlled difference, workload, correctness condition, and metric. Use
   `workbench record add experiment --help` for the record interface; record the intended comparison and protocol. Use
   the protocol to describe pilot measurements, evaluation and stopping decisions, and how adaptive sampling affects
   confidence. Resolve a missing success criterion before running a comparison that cannot answer the question.
2. Identify baseline and candidate source and build selections. Link an environment record and record material hardware,
   software, resource, and scheduling conditions following the
   [environment profile guide](../../../docs/records.md#experiment-provenance-and-environment-profiles).
3. Start with `workbench experiment start REFERENCE` and run matched comparisons within the authorized work. Protocol
   approval is not required. Keep correctness checks distinct from measurements; account for drift, exclusions, and
   failures. Retain refinements and protocol revisions with their measurements, and distinguish exploratory results from
   confirmatory evidence. Create a new record for a distinct comparison.
4. Verify extracted measurements against raw reports. Retain enough evidence to assess the conclusion after temporary
   reports are gone, including variation where relevant. Explain accepted, rejected, or inconclusive results against the
   declared rule; favorable measurements alone do not authorize acceptance.

Before recommending rejection, review the candidate's design and implementation and the measurement method for avoidable
weaknesses. Improve and retest plausible alternatives in proportion to their expected benefit and cost. Explain
refinements attempted and why further work is unwarranted. An unsuccessful implementation does not alone reject the
underlying approach; leave broader claims inconclusive when material limitations remain unresolved. Refer work outside
the authorized scope or budget to the developer.

Record the candidate conclusion with `workbench experiment finish REFERENCE --result Accepted|Rejected|Inconclusive`.
Present completed evidence, conclusions, and changed environment records and supporting files for human review before
commit. `workbench experiment accept REFERENCE` reviews results independently of the candidate conclusion: a rejected or
inconclusive candidate can still be a completed experiment. Use a dedicated experiment commit whose parent is the
baseline, including any accepted implementation. Retain an applicable candidate patch for rejected and inconclusive
results; do not duplicate accepted code as a patch. Do not commit without the user's authorization and required record
approval, or insert a placeholder for the commit's own hash.
