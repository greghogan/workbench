---
status: Planned
environment: demo:ENV-1
---

# EXP-1: Reference previews during keyboard reading

Plan a comparison of optional previews and ordinary links for [offline search](../decisions/ADR-01.md).

## Hypothesis

A preview may reduce page changes without making keyboard navigation harder.

## Candidate and baseline

Compare the same note page with previews enabled and disabled.

## Independent variable

Whether focusing a reference exposes a title and summary preview.

## Controls and correctness

Keep the notes and reading prompts identical. Both variants must support following links, dismissing previews, selecting
text, and retaining focus. Do not treat fewer page changes as a substitute for accessibility.

## Workload

Read three linked notes and locate the source for each claim using only the keyboard.

## Evaluation rule

Record completion, focus loss, and navigation steps. Any inaccessible step blocks the candidate. Assess usability with
real participants before drawing conclusions.

The [session checklist](EXP-01/session-notes.txt) lists observations to collect. The
[preview assessment](../tasks/TSK-02.md) awaits agreement on participant sessions.
