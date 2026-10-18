---
summary:
  Authoritative pins, maintained support boundaries, complete language definitions, comprehensive checks, and
  shipped-code coverage.
agent_instruction:
  Use the project's declared tool and dependency pins; enable broad applicable strict checks and do not weaken them to
  make changes pass.
---

# ADR-A: Toolchains and engineering constraints

Language definitions, including their checks, use ADR-2's complete replacement mode. Projects own native manifests and
dependency locks.

Pin development and CI tools exactly, directly or through locked environments. Each tool has one version authority per
root and environment; derive or validate secondary declarations against it. Keep package-managed check tools in language
locks, commit locks, and use locked installs. Updates keep declarations, locks, and verification consistent. Libraries
may publish dependency ranges.

Provide documented, tested installation and selection for required native pins on every supported platform without
changing global defaults. Checks and language servers use the selected root's tools, dependencies, and SDK or
interpreter. Ordinary checks verify tools without installing replacements.

Prefer maintained stable releases, including security maintenance. Native support normally begins with the oldest
maintained line; selecting or updating native minima and compatibility profiles uses the latest patch of each selected
line. Develop on the newest suitable maintained release available in the selected environment, subject to
language-specific policy. Document exclusions and older patch exceptions; review end of life during support and
dependency updates.

Declare runtime/API targets independently of development tools, compiler families, and language standards. Support
declarations and checks agree. Verify promised compatibility profiles locally and in CI; static targeting alone does not
prove runtime behavior. Nix and Guix select versions independently of native pins and support floors while preserving
application requirements, language targets, and quality checks. Examples demonstrate development and minimum targeting
without unnecessary newer-language requirements or exhaustive matrices.

Each Workbench-supplied language definition has a dependency-update skill. General upgrades consider current stable
releases, including majors; narrower requests retain their scope. Preserve support boundaries and environment pins
unless their change is requested.

Require canonical formatting with write and check modes, comprehensive applicable compiler diagnostics and linting,
strict type checking, and behavioral tests. Enable broad, coherent rule sets by default, including checks beyond basic
presets, and fail on warnings where supported. Fix findings in the code and justify narrow exceptions, including rule
conflicts, unsupported checks, and demonstrated false positives. Keep formatting and lint rules coherent and review new
checks during tool upgrades. Equivalent tools and scoped exceptions are permitted. Never weaken checks, types, coverage
floors, or meaningful assertions merely to pass; policy changes require decision review.

Coverage includes all project-owned shipped libraries and entry points, including unexecuted production files and
subprocess execution. Exclude dependencies and third-party generated code.

Rationale: Agents can resolve mechanical findings at low cost, making comprehensive checks practical constraints on
generated changes. Authoritative tools prevent accidental substitutions; tested support boundaries distinguish
compatibility promises from development preferences.
