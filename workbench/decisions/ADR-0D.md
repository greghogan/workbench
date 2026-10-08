---
summary: Configured checks and complete proposed-tree gates.
agent_instruction: Run Workbench validation and applicable checks before completion; inspect `workbench checks`.
---

# ADR-D: Quality gates

Project configuration defines check roles, stages, commands, working roots, environments, and resource requirements.
Roles form the definition of done across languages and may invoke language-native runners. Resource scheduling follows
ADR-U. Routine gate commands exclude live effects; live checks require a separately selected workflow.

A complete check run includes structural validation. A project without configured commands must explicitly declare that
structural checks alone are sufficient. Setup identifies missing check configuration instead of implying that language
detection establishes quality gates. Focused runs support iteration but do not replace the complete gate.

Commit gates run every check assigned to the commit stage against the complete proposed tree, without filename filters.
Manifest, lockfile, toolchain, configuration, and documentation changes receive the same gate as source changes. Tools
may use valid incremental caches while preserving their full configured scope.

Validation does not rewrite the proposed tree. Version-control adapters materialize the proposed files and pinned
dependencies for these same checks, and may validate change messages. Human review remains separate from mechanical
validation.

Unqualified runs select the commit stage; CI selects its stage explicitly. Missing stage declarations select both; empty
declarations permit only explicit role runs. Role selection includes required setup in the same root and environment
session. Reject unknown stages, excluded setup, and unintended empty gates. Inspection exposes the plan.

Provide an optional static root Makefile for build, check, test, coverage, release, formatting, and cleanup. It
delegates to configured commands across all roots by default, with explicit project or root selection. Release prepares
local artifacts; publishing and tagging are separate operations. Preserve existing consumer Makefiles during adoption.

Rationale: Explicit check selection prevents empty successful runs from being mistaken for verification. Checking the
proposed tree makes validation evidence correspond to the change being committed.
