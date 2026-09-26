# Decision map

Decisions in this project. Changed decisions and dependent code require human review before commit.

- [workbench:ADR-0](decisions/ADR-00.md)
  Accepted Decision Records become binding when a human-reviewed commit contains them.
- [workbench:ADR-1](decisions/ADR-01.md)
  Registered scopes own records; language check roots can be selected independently.
- [workbench:ADR-2](decisions/ADR-02.md)
  Scoped base-36 identifiers resolve to stable paths independently of their reference spelling.
- [workbench:ADR-3](decisions/ADR-03.md)
  Maps route readers to relevant records and source responsibilities without becoming new authority.
- [workbench:ADR-4](decisions/ADR-04.md)
  Plans become durable tasks progressively, preserving context without fixing every detail in advance.
- [workbench:ADR-5](decisions/ADR-05.md)
  Capture process and tooling friction cheaply, then promote only actionable findings into project work.
- [workbench:ADR-6](decisions/ADR-06.md)
  Falsifiable experiments retain matched correctness, measurement evidence, and honest execution provenance.
- [workbench:ADR-7](decisions/ADR-07.md)
  Citation records preserve paper metadata and acquisition sources without redistributing source material.
- [workbench:ADR-8](decisions/ADR-08.md)
  Organize code around owned state and invariants, considering consolidation as readily as extraction.
- [workbench:ADR-9](decisions/ADR-09.md)
  Backward compatibility is disabled by default and enabled only through human-controlled project configuration.
- [workbench:ADR-A](decisions/ADR-0A.md)
  Failures retain actionable context while diagnostics remain structured, bounded, and safe to disclose.
- [workbench:ADR-B](decisions/ADR-0B.md)
  Tests provide proportionate evidence at stable boundaries without depending on uncontrolled machine state.
- [workbench:ADR-C](decisions/ADR-0C.md)
  Documentation, source ownership, and links change with the behavior they explain.
- [workbench:ADR-D](decisions/ADR-0D.md)
  Formatting, linting, structural checks, and configured tests run against a pending-change snapshot.
- [workbench:ADR-E](decisions/ADR-0E.md)
  Coherent changes are reviewed and mechanically validated before commits preserve their result and rationale.
- [workbench:ADR-F](decisions/ADR-0F.md)
  Lock dependencies, verify downloaded artifacts, and keep credentials out of project files.
- [workbench:ADR-G](decisions/ADR-0G.md)
  Configured checks use a pinned Guix or Nix environment when selected.
- [workbench:ADR-H](decisions/ADR-0H.md)
  Rust code uses explicit errors, cohesive modules, deterministic tests, and the standard formatter and linter.
- [workbench:ADR-I](decisions/ADR-0I.md)
  Python code has explicit data boundaries, type-aware interfaces, focused tests, and reproducible formatting.
- [workbench:ADR-J](decisions/ADR-0J.md)
  Live-system changes preserve recovery, separate installation from activation, and expose destructive effects.
- [workbench:ADR-K](decisions/ADR-0K.md)
  Terminal interfaces use explicit state, restore the terminal, and derive help from executable bindings.
- [workbench:ADR-L](decisions/ADR-0L.md)
  AWS integrations use supported configuration chains and isolate cloud effects from routine tests.
- [workbench:ADR-M](decisions/ADR-0M.md)
  Release records join notes and immutable source identity to verifiable published artifacts.
- [workbench:ADR-N](decisions/ADR-0N.md)
  TypeScript projects start with strict types, pnpm, type-aware ESLint, Prettier, and Vitest.
