---
status: Accepted
environment: demo:ENV-0
---

# EXP-3: Match composed Unicode titles

## Hypothesis

Normalizing title and query text to the same Unicode form finds equivalent spellings without changing stored notes.

## Candidate and baseline

The candidate normalizes both inputs before lookup. The baseline compares their original sequences.

## Independent variable

Unicode normalization at lookup.

## Controls and correctness

Use the same matcher and note files. Compare returned note IDs and the original file contents.

## Workload

Twenty-four lookups include composed and decomposed accents, distinct titles, and exact ASCII matches.

## Evaluation rule

Accept if all equivalent spellings match and the other cases preserve their expected results.

## Execution provenance

The example uses the workstation environment and a fixed set of synthetic titles.

## Evidence

The example baseline matched 18 of 24 cases. The candidate matched all 24 and left every note unchanged.

## Decision

Use normalization for lookup and preserve the original file names and title text for display.
