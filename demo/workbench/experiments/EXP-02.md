---
status: Running
environment: demo:ENV-1
---

# EXP-2: Bound memory during index rebuild

## Hypothesis

Reading notes in batches reduces peak memory when rebuilding an index on a small laptop.

## Candidate and baseline

The candidate reads a bounded batch at a time. The baseline reads the same Markdown files into memory together.

## Independent variable

The number of files resident in memory during indexing.

## Controls and correctness

Use the same files, parser, machine, and index format. Compare indexed terms and complete result IDs.

## Workload

Rebuild the index for 2,000 Markdown notes with a mix of short text and large tables.

## Evaluation rule

Look for lower peak resident memory with identical results and no more than a 10% increase in median rebuild time.

## Execution provenance

The fixture and correctness oracle are ready. Sample collection is in progress in this example.
