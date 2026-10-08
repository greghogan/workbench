# Decision map

Read applicable decisions; entries identify their topics.

Scope charter: [CHARTER.md](CHARTER.md).

- [workbench:ADR-0](decisions/ADR-00.md): Decision records and authority — Human review, draft authority, scoped
  overrides.
- [workbench:ADR-1](decisions/ADR-01.md): Maps and agent context — Scoped discovery and generated context.
- [workbench:ADR-2](decisions/ADR-02.md): Project scopes and language roots — Separate record ownership from check
  roots.
- [workbench:ADR-3](decisions/ADR-03.md): Record identity and references — Base-36 IDs, stable paths, permanent
  retention.
- [workbench:ADR-4](decisions/ADR-04.md): Record schemas and canonical formatting — Metadata, migrations, formatting,
  validation.
- [workbench:ADR-5](decisions/ADR-05.md): Workbench distribution — Pinned artifacts, isolated updates, recovery.
- [workbench:ADR-6](decisions/ADR-06.md): Skills and harness integration — Discovery, triggers, harness tests,
  evaluations.
- [workbench:ADR-7](decisions/ADR-07.md): Plans and task continuity — Task hierarchy, completion, history, commit
  references.
- [workbench:ADR-8](decisions/ADR-08.md): Feedback before promotion — Local capture, triage, promotion.
- [workbench:ADR-9](decisions/ADR-09.md): Experiments and measurement evidence — Protocols, evidence, patches, human
  review.
- [workbench:ADR-A](decisions/ADR-0A.md): Citation records and source acquisition — CSL, arXiv/DOI, PDFs, digests.
- [workbench:ADR-B](decisions/ADR-0B.md): Toolchains and engineering constraints — Pins, support minima, strict checks,
  language servers, updates.
- [workbench:ADR-C](decisions/ADR-0C.md): Test evidence and isolation — Behavioral assertions, isolation, coverage,
  advisory timing.
- [workbench:ADR-D](decisions/ADR-0D.md): Quality gates — Configured checks and complete proposed-tree gates.
- [workbench:ADR-E](decisions/ADR-0E.md): Review and coherent commits — Agent cleanup, follow-up scope, commit
  conventions.
- [workbench:ADR-F](decisions/ADR-0F.md): Rust implementation — Errors, unsafe code, stable and Miri toolchains, MSRV,
  portability.
- [workbench:ADR-G](decisions/ADR-0G.md): Python implementation — Supported interpreters and strict tools.
- [workbench:ADR-H](decisions/ADR-0H.md): TypeScript projects — Node LTS, compiler strictness, typed linting.
- [workbench:ADR-I](decisions/ADR-0I.md): C implementation — C17, LLVM checks, FFI, vcpkg dependencies.
- [workbench:ADR-J](decisions/ADR-0J.md): C++ implementation — C++20, ownership, exceptions, native checks.
- [workbench:ADR-K](decisions/ADR-0K.md): Go implementation — Module/tool pins, analysis, race detection.
- [workbench:ADR-L](decisions/ADR-0L.md): Architecture-specific optimization — CPU baseline, safe dispatch,
  verification.
- [workbench:ADR-M](decisions/ADR-0M.md): Semantic code boundaries — Ownership, invariants, shared packages.
- [workbench:ADR-N](decisions/ADR-0N.md): Opt-in backward compatibility — Human-set opt-in; caller/data migrations.
- [workbench:ADR-O](decisions/ADR-0O.md): Errors, diagnostics, and observability — Causes, retries, outcomes, telemetry.
- [workbench:ADR-P](decisions/ADR-0P.md): Documentation and knowledge integrity — Authoritative sources, drift,
  executable docs.
- [workbench:ADR-Q](decisions/ADR-0Q.md): Dependencies, credentials, and supply-chain evidence — Verified acquisition,
  upgrades, credentials.
- [workbench:ADR-R](decisions/ADR-0R.md): Development environments — Local selection, provenance, human-led updates.
- [workbench:ADR-S](decisions/ADR-0S.md): Nix development environments — Locked flakes and disposable containers.
- [workbench:ADR-T](decisions/ADR-0T.md): Guix development environments — Authenticated channels and working-tree
  builds.
- [workbench:ADR-U](decisions/ADR-0U.md): Execution resources — benchd scheduling and approved bypass.
- [workbench:ADR-V](decisions/ADR-0V.md): Live service operations — Activation, migration, recovery, live tests.
- [workbench:ADR-W](decisions/ADR-0W.md): Terminal user interfaces — State, bindings, terminal restoration.
- [workbench:ADR-X](decisions/ADR-0X.md): AWS boundaries — Accounts, SDK credentials, live-test limits.
- [workbench:ADR-Y](decisions/ADR-0Y.md): Release records and verified artifacts — Immutable artifacts, digests,
  yanking.
- [workbench:ADR-Z](decisions/ADR-0Z.md): GitHub continuous integration — OS/environment matrices, minima, runner
  isolation.
- [workbench:ADR-10](decisions/ADR-10.md): Durable state and recovery — Atomic publication, conflicts, recovery
  receipts.
- [workbench:ADR-11](decisions/ADR-11.md): Concurrency and resource ownership — Shutdown, cancellation, queues, memory
  bounds.
- [workbench:ADR-12](decisions/ADR-12.md): Configuration, filesystem locations, and commands — Linux/macOS/Windows
  paths, precedence, CLI contracts.
- [workbench:ADR-13](decisions/ADR-13.md): Trust and privilege boundaries — Authorization, helpers, plugins,
  caller-owned paths.
- [workbench:ADR-14](decisions/ADR-14.md): Dev Container development environments — Optional container workspaces,
  shared native pins, and CI coverage.
