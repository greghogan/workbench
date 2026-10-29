# Source map

Workbench resolves project-owned configuration and records, runs the resulting checks, and ships the CLI that performs
those operations. Start with the subsystem owning the intended change; the source remains authoritative for behavior.

- [Records and knowledge](source-maps/records.md): Record identity, metadata, references, generated context, and
  validation.
- [Shared collections](source-maps/collections.md): Adopt editable project policy, retain Git originals, and resolve
  independent local guidance.
- [Distribution and updates](source-maps/distribution.md): Start the pinned CLI, publish runnable bundles, and update
  executable pins.
- [Checks and environments](source-maps/execution.md): Resolve configured work, select tools and environments, and
  coordinate isolated CI.
- [Tool acquisition and dependencies](source-maps/acquisition.md): Authenticate downloads, publish tool installations,
  and prepare language dependencies.
- [Commands and configuration](source-maps/interfaces.md): Route commands, validate configuration, and maintain project
  integration.
- [Examples and quality support](source-maps/references.md): Independent language examples, skills, tests, and
  development tooling.

Source-map paths are relative to the project root. Subsystem links are relative to the map containing them.
