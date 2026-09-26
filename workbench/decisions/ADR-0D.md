# ADR-D: Deterministic quality gates

Summary: Formatting, linting, structural checks, and configured tests run against a pending-change snapshot.

Agent instruction: Run applicable Workbench checks before completion; use `workbench checks list` to inspect roles.

Project configuration defines each check's role, command, working root, environment, and resource weight. An explicit
format command may rewrite files; validation does not rewrite the pending-change snapshot.

Configured roles form the definition of done across languages. A role may invoke a language-native task runner. Heavy
roles use benchd when available; live checks are explicit.

Version-control adapters materialize a pending-change snapshot for the same checks and may validate change messages.
Git is the initial adapter. Human review remains separate from mechanical validation.
