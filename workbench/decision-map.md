# Decision map

Read applicable decisions; entries identify their topics.

Scope charter: [CHARTER.md](CHARTER.md).

- [workbench:ADR-0: Improving Workbench through use](decisions/ADR-00.md) — Feedback from consuming projects.
- [workbench:ADR-1: Decision records and authority](decisions/ADR-01.md) — Charter authority, human review, draft
  authority, and decision acceptance.
- [workbench:ADR-2: Project scopes and adopted material](decisions/ADR-02.md) — Project ownership, collection adoption,
  complete definition replacement, and scoped references.
- [workbench:ADR-3: Workbench adoption and distribution](decisions/ADR-03.md) — Consumer autonomy, independent
  executable pins, runtime support, and deliberate updates.
- [workbench:ADR-4: Record contracts](decisions/ADR-04.md) — Scoped identities, references, supporting files, schemas,
  migrations, and canonical formatting.
- [workbench:ADR-5: Maps and agent context](decisions/ADR-05.md) — Generated record routing and instructions, curated
  source maps, and local context discovery.
- [workbench:ADR-6: Skills and harness integration](decisions/ADR-06.md) — Personal skill selection, pinned definitions,
  scoped harness discovery, invocation controls, and evaluations.
- [workbench:ADR-7: Tasks and feedback](decisions/ADR-07.md) — Human review summaries, progress and child tasks,
  completion evidence, and local feedback promotion.
- [workbench:ADR-8: Experiments and measurement evidence](decisions/ADR-08.md) — Testable comparisons, effect size and
  uncertainty, retained evidence, and human review.
- [workbench:ADR-9: Citation records and source acquisition](decisions/ADR-09.md) — CSL-JSON bibliographies, retained
  upstream metadata, acquisition states, and document storage.
- [workbench:ADR-A: Toolchains and engineering constraints](decisions/ADR-0A.md) — Authoritative pins, maintained
  support boundaries, complete language definitions, comprehensive checks, and shipped-code coverage.
- [workbench:ADR-B: Test evidence and isolation](decisions/ADR-0B.md) — Behavioral assertions, isolated execution,
  coverage deltas and floors, and advisory timing.
- [workbench:ADR-C: Review and coherent changes](decisions/ADR-0C.md) — Whole-changeset review, cause and recurrence,
  semantic boundaries, and coherent commits.
- [workbench:ADR-D: Compatibility and existing data](decisions/ADR-0D.md) — Independent human choices for backward
  compatibility and migration or deletion of existing data.
- [workbench:ADR-E: Errors, diagnostics, and observability](decisions/ADR-0E.md) — Failure causes, safe bounded retries,
  explicit outcomes, purposeful logs and metrics, and diagnostic limits.
- [workbench:ADR-F: Documentation sources and verification](decisions/ADR-0F.md) — Authoritative definitions, verified
  documentation, and executable examples.
- [workbench:ADR-G: Durable state and recovery](decisions/ADR-0G.md) — Atomic visibility, explicit conflict resolution,
  durability guarantees, and interruption recovery.
- [workbench:ADR-H: Concurrency and resource ownership](decisions/ADR-0H.md) — Operation ownership, shutdown, stale
  results, capacity limits, and responsiveness.
- [workbench:ADR-I: Configuration, filesystem locations, and commands](decisions/ADR-0I.md) — Storage classes, native
  platform locations, configuration ownership and precedence, and CLI contracts.
- [workbench:ADR-J: Trust and privilege boundaries](decisions/ADR-0J.md) — Authorization, helpers, plugins, caller-owned
  paths.
- [workbench:ADR-K: Dependencies, credentials, and supply-chain evidence](decisions/ADR-0K.md) — Verified acquisition,
  upgrades, credentials.
- [workbench:ADR-L: Adopted record collections](decisions/ADR-0L.md) — Self-contained collections, editable adopted
  copies, reconciliation, and reviewed local activation and compatibility.
- [workbench:ADR-M: Architecture-specific optimization](decisions/ADR-0M.md) — CPU baseline, safe dispatch,
  verification.
- [workbench:ADR-N: Native artifact acquisition and installation](decisions/ADR-0N.md) — Delegated installation,
  selective native archive acquisition, verified activation, and cache reuse.
- [workbench:ADR-O: Link-time optimization](decisions/ADR-0O.md) — Optional release LTO, compiler/linker coherence,
  isolated builds, optimized behavioral verification.
- [workbench:ADR-P: Development environments](decisions/ADR-0P.md) — Local selection, managed tool authority,
  package-derived environments, development tools, and human-led updates.
- [workbench:ADR-Q: Nix development environments](decisions/ADR-0Q.md) — Locked flakes, package-derived development
  shells, and disposable containers.
- [workbench:ADR-R: Guix development environments](decisions/ADR-0R.md) — Authenticated channels, package-derived
  development manifests, compiler variants, and working-tree builds.
- [workbench:ADR-S: Builds and deployment artifacts](decisions/ADR-0S.md) — Development and release profiles, prepared
  image identities, portability, and artifact verification.
- [workbench:ADR-T: Dev Container workspaces](decisions/ADR-0T.md) — Standard Linux workspaces, selected tool authority,
  checkout preservation, and independent native evidence.
- [workbench:ADR-U: Quality gates](decisions/ADR-0U.md) — Configured checks and complete proposed-tree gates.
- [workbench:ADR-V: Live service operations](decisions/ADR-0V.md) — Activation, migration, recovery, live tests.
- [workbench:ADR-W: Terminal user interfaces](decisions/ADR-0W.md) — Keyboard access, plain presentation, independent
  color control, safe rendering, cancellation, and restoration.
- [workbench:ADR-X: Release records and verified artifacts](decisions/ADR-0X.md) — Immutable artifacts, digests,
  yanking.
- [workbench:ADR-Y: Continuous integration](decisions/ADR-0Y.md) — Configured CI coverage, shared local execution,
  prepared environments, and publication authorization.
- [workbench:ADR-Z: Rust](decisions/ADR-0Z.md) — Error and unsafe-code contracts, stable and Miri toolchains, compiler
  support, and Linux portability.
- [workbench:ADR-10: Python](decisions/ADR-10.md) — Supported interpreters and strict tools.
- [workbench:ADR-11: Node, TypeScript, and JavaScript](decisions/ADR-11.md) — Node release policy, independent API
  targets, strict authoring, distinct language definitions, and portable releases.
- [workbench:ADR-12: C and C++](decisions/ADR-12.md) — Compiler and language targets, required LLVM checks, Linux GCC,
  managed debuggers, and dependency ABI ownership.
- [workbench:ADR-13: Go](decisions/ADR-13.md) — Module/tool pins, analysis, race detection, and portable executable
  releases.
- [workbench:ADR-14: Java](decisions/ADR-14.md) — Maintained JDKs, project-owned release targets, verified build
  dependencies, strict checks, and portable JARs.
- [workbench:ADR-15: Ruby](decisions/ADR-15.md) — Gem-declared support, frozen checksummed dependencies, strict Ruby
  analysis, and portable gems.
- [workbench:ADR-16: PHP](decisions/ADR-16.md) — Independent application and tool locks, verified Composer
  distributions, strict analysis, and portable packages.
- [workbench:ADR-17: AWS boundaries](decisions/ADR-17.md) — Accounts, SDK credentials, live-test limits.
- [workbench:ADR-18: Section 508 conformance](decisions/ADR-18.md) — Section 508 accessibility requirements, conformance
  scope, and supporting evidence.
