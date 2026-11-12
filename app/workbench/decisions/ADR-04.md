---
summary: Release-owned skill definitions, personal selection, project applicability, and update continuity.
---

# ADR-4: Supplied skills and harness integration

Workbench-supplied skill definitions belong to the installed application release. Workflow policy, invocation,
preservation of independently authored skills, and behavioral evaluation follow workbench:ADR-6.

Users enable or disable individual skills in user configuration. Projects filter that selection by applicability without
changing personal choices. Only enabled, applicable skills become discoverable to supported harnesses. New skills start
disabled.

Application updates report added, removed, and changed skills while preserving personal choices. Personal discovery
state remains uncommitted and does not determine shared validation.

Rationale: Release-owned definitions keep supplied workflows aligned with the application. Personal selection and
project applicability limit unrelated context without making personal setup a shared-project requirement.
