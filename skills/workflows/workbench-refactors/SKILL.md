---
name: workbench-refactors
description:
  Recommend concrete refactors when asked for a second look or further improvements to recent Workbench work. Advisory
  by default; do not trigger merely because implementation finished.
---

# Refactor opportunities

Use the requested scope, otherwise the recent changes and their immediate callers. Read relevant decisions and inspect
the implementation afresh. Look for better boundaries, simpler state and data flow, consolidation, or removal of work
whose cost is no longer justified. Existing abstractions and previous review conclusions are hypotheses, not
constraints.

For each worthwhile finding, give a concrete path, evidence, expected benefit, likely scope, and tradeoff. Distinguish
missed cleanup or defects in the completed change from broader design opportunities. Do not hide a useful finding merely
because changeset review should have caught it. Avoid repeating already resolved suggestions without new evidence.

Rank by value and confidence without filling a quota. Say when no worthwhile opportunity remains. A request for advice
does not authorize edits, a full audit, or commits. If the user also asks to implement the recommendations, carry out
clear in-scope improvements and surface only the decisions still needed; finish with changeset review and verification.
