---
summary: Consumer autonomy, independent executable pins, runtime support, and deliberate updates.
---

# ADR-3: Workbench adoption and distribution

This decision governs adoption and operation of Workbench. Consuming applications retain their own language, runtime,
and distribution choices.

The Workbench executable and record collections are independently selectable. Installing or updating the tool does not
adopt or replace project policy. Consumers own their configuration, records, agent guidance, and copied automation;
Workbench's repository settings are not consumer defaults.

Projects using Workbench automation pin the executable's source and immutable revision independently of adopted
collections. Commands honor the project pin, with an installation default outside pinned projects. Missing pinned
versions never fall back to another revision.

Workbench releases include discoverable source, tests, and examples. Their immutable source identity remains available
after installation. Launching an already acquired revision with its required runtime available needs no connectivity or
redundant acquisition.

Startup support is declared separately from the runtime requirements of application commands. Users within declared
startup support can run Workbench without replacing their system runtime or changing shell defaults. Compatible
installed runtimes are reused; additional acquisition requirements are explicit. Managed environments retain runtime
authority and satisfy the command runtime requirements. The runtime used for Workbench commands does not change a
consuming project's selected toolchains.

Adoption preserves existing project files and tool choices. Generated agent context reflects the project's selected
scopes, checks, and reconciled guidance. Committed records, maps, and agent guidance remain usable without the
executable or access to their upstream providers. Ordinary application builds must not require Workbench solely because
its record conventions were adopted.

Executable updates preserve user work and apply only validated changes, leaving them unstaged. Collection reconciliation
is a separate explicit operation.

Rationale: Separating policy ownership from tool acquisition gives consumers self-contained records and deliberate,
independently pinned updates without duplicating the executable into every project.
