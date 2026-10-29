---
status: Inconclusive
environment: demo:ENV-0
---

# EXP-0: Warm index versus scanning notes

Compare two search strategies for the offline notebook described by [ADR-1](../decisions/ADR-01.md).

## Hypothesis

A warm index may reduce repeated-query latency while returning the same matching notes as a direct scan.

## Candidate and baseline

The candidate reuses a disposable index; the baseline scans the Markdown files for each query.

## Independent variable

Whether the query uses the index. Both strategies use the same title and content matching rules.

## Controls and correctness

Use the same notes, queries, machine, and application revision. Compare complete result identities against a direct
scan. Include an edited note and a deleted index to check freshness and recovery.

## Workload

A fictional notebook of 200 short notes with repeated and new queries, followed by a single-file edit.

## Evaluation rule

Compare per-query latency and result equality across interleaved runs. Reject incorrect results regardless of timing;
retain variation rather than reporting only the fastest query.

## Execution provenance

No experiment was executed. The [environment](../environments/ENV-00.md) and workload are demonstration fixtures.

## Evidence

The [supporting note](EXP-00/observation.txt) is a protocol checklist, not a measured result.

## Decision

Inconclusive. Collect real measurements before choosing an index strategy for performance.
