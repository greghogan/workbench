---
status: Rejected
environment: demo:ENV-1
---

# EXP-4: Index all notes on startup

## Hypothesis

Building the index before displaying the notebook improves the reader's first search.

## Candidate and baseline

The candidate rebuilds at startup. The baseline displays the notebook immediately and rebuilds on the first search.

## Independent variable

When the rebuild runs.

## Controls and correctness

Use the same application build, laptop, notes, and search query. Start each trial without a saved index.

## Workload

Open 500 local notes, navigate to the first note, then search for a known title.

## Evaluation rule

Keep the approach if the notebook stays usable within 300 ms and the first search becomes faster.

## Execution provenance

The example uses alternating baseline and candidate trials on the laptop configuration.

## Evidence

The fictional median time to usable navigation rose from 160 ms to 690 ms. Time from launch to a completed first search
stayed within 20 ms across the two strategies.

## Decision

Keep on-demand rebuilds. A partial index can be investigated separately if it gives a useful first search while the
notebook remains usable.
