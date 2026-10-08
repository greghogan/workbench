---
summary: Protocols, evidence, patches, human review.
---

# ADR-9: Experiments and measurement evidence

Create an experiment record for a falsifiable comparison: candidate and baseline, controlled difference, workload,
correctness criterion, metric, and evaluation rule. Exploratory profiling need not become a record.

Do not duplicate facts fixed by the tested revision and canonical release build. Record the workload, material
deviations, and evidence distinguishing the executions. Execution follows the resource policy in ADR-U; record any
approved bypass or absence of its scheduler.

An accepted candidate and its experiment record are committed together; that commit identifies the accepted source.
Preserve an applicable patch against a named baseline for candidates not retained in source, including uncommitted,
rejected, and inconclusive changes. A patch is unnecessary when the record's commit contains the exact tested candidate.
Record build deviations needed to reproduce the tested executable; do not require a commit to name its own hash.

An environment record identifies stable hardware and topology. Experiments reference it and record run-specific software
versions; software updates do not create a new environment.

Use matched conditions and interleaving when drift matters. Declare evaluation and stopping rules before seeing results.
Microbenchmarks isolate a mechanism, exclude setup from timing, and retain correctness results. Workflow claims need
representative end-to-end evidence.

Retain the results and context needed to evaluate the conclusion, including measurements when summaries would hide
variation, exclusions, or failures. Verify extracted evidence against the source reports. The record must stand on its
own after temporary execution reports are deleted; do not embed or compress a complete copy. New trials receive new
records. Retain experiment and environment records permanently, including rejected trials and obsolete environments.

Humans review new and changed experiment records before commit, including protocols and accepted, rejected, or
inconclusive conclusions. Agents may run experiments and implement candidates before review; `Accepted` records a
reviewed choice, not merely a favorable measurement.

Rationale: Declared evaluation rules and retained evidence make conclusions independently assessable. Human review
controls which empirical conclusions enter the project's durable record.
