# Decision map

Read applicable decisions; entries identify their topics.

Scope charter: [CHARTER.md](CHARTER.md).

- [workbench:ADR-0](decisions/ADR-00.md): Decision records and authority — Human review, draft authority, scoped
  overrides, and references to earlier decisions.
- [workbench:ADR-1](decisions/ADR-01.md): Project scopes and inheritance — Integration and complete replacement, with
  independent document scopes and check roots.
- [workbench:ADR-2](decisions/ADR-02.md): Workbench adoption and distribution — Consumer ownership, submodules or shared
  installations, project pins, retained versions, updates, and recovery.
- [workbench:ADR-3](decisions/ADR-03.md): Record identity and references — Base-36 IDs, stable paths, permanent
  retention.
- [workbench:ADR-4](decisions/ADR-04.md): Record schemas and canonical formatting — Metadata, migrations, formatting,
  validation.
- [workbench:ADR-5](decisions/ADR-05.md): Maps and agent context — Scoped discovery and generated context.
- [workbench:ADR-6](decisions/ADR-06.md): Skills and harness integration — Discovery, triggers, harness tests,
  evaluations.
- [workbench:ADR-7](decisions/ADR-07.md): Plans and task continuity — Task hierarchy, completion, history, commit
  references.
- [workbench:ADR-8](decisions/ADR-08.md): Feedback before promotion — Local capture, triage, promotion.
- [workbench:ADR-9](decisions/ADR-09.md): Toolchains and engineering constraints — Pins, support minima, strict checks,
  language servers, updates.
- [workbench:ADR-A](decisions/ADR-0A.md): Test evidence and isolation — Behavioral assertions, isolation, coverage,
  advisory timing.
- [workbench:ADR-B](decisions/ADR-0B.md): Review and coherent commits — Agent cleanup, follow-up scope, commit
  conventions.
- [workbench:ADR-C](decisions/ADR-0C.md): Semantic code boundaries — Ownership, invariants, shared packages.
- [workbench:ADR-D](decisions/ADR-0D.md): Opt-in backward compatibility — Human-set opt-in; caller/data migrations.
- [workbench:ADR-E](decisions/ADR-0E.md): Errors, diagnostics, and observability — Causes, retries, outcomes, telemetry.
- [workbench:ADR-F](decisions/ADR-0F.md): Documentation and knowledge integrity — Authoritative sources, drift,
  executable docs.
- [workbench:ADR-G](decisions/ADR-0G.md): Durable state and recovery — Atomic publication, conflicts, recovery receipts.
- [workbench:ADR-H](decisions/ADR-0H.md): Concurrency and resource ownership — Shutdown, cancellation, queues, memory
  bounds.
- [workbench:ADR-I](decisions/ADR-0I.md): Configuration, filesystem locations, and commands — Linux/macOS/Windows paths,
  precedence, CLI contracts.
- [workbench:ADR-J](decisions/ADR-0J.md): Trust and privilege boundaries — Authorization, helpers, plugins, caller-owned
  paths.
- [workbench:ADR-K](decisions/ADR-0K.md): Dependencies, credentials, and supply-chain evidence — Verified acquisition,
  upgrades, credentials.
- [workbench:ADR-L](decisions/ADR-0L.md): Installed shared collections — Automatic local applicability, shared project
  installations, immutable revisions, provenance, and ADR integration.
- [workbench:ADR-M](decisions/ADR-0M.md): Experiments and measurement evidence — Protocols, evidence, patches, human
  review.
- [workbench:ADR-N](decisions/ADR-0N.md): Architecture-specific optimization — CPU baseline, safe dispatch,
  verification.
- [workbench:ADR-O](decisions/ADR-0O.md): Native artifact acquisition and installation — Streaming acquisition,
  signatures, bounded extraction, language filters, local activation and caches.
- [workbench:ADR-P](decisions/ADR-0P.md): Link-time optimization — Optional release LTO, compiler/linker coherence,
  isolated builds, optimized behavioral verification.
- [workbench:ADR-Q](decisions/ADR-0Q.md): Development environments — Local selection, provenance, human-led updates.
- [workbench:ADR-R](decisions/ADR-0R.md): Nix development environments — Locked flakes and disposable containers.
- [workbench:ADR-S](decisions/ADR-0S.md): Guix development environments — Authenticated channels and working-tree
  builds.
- [workbench:ADR-T](decisions/ADR-0T.md): Dev Container development environments — Optional container workspaces, native
  or managed tool ownership, and CI coverage.
- [workbench:ADR-U](decisions/ADR-0U.md): Quality gates — Configured checks and complete proposed-tree gates.
- [workbench:ADR-V](decisions/ADR-0V.md): Citation records and source acquisition — CSL, arXiv/DOI, PDFs, digests.
- [workbench:ADR-W](decisions/ADR-0W.md): Live service operations — Activation, migration, recovery, live tests.
- [workbench:ADR-X](decisions/ADR-0X.md): Terminal user interfaces — State, bindings, terminal restoration.
- [workbench:ADR-Y](decisions/ADR-0Y.md): Builds and deployment artifacts — Named development and release profiles,
  native and managed builders, portable packages, and artifact verification.
- [workbench:ADR-Z](decisions/ADR-0Z.md): Release records and verified artifacts — Immutable artifacts, digests,
  yanking.
- [workbench:ADR-10](decisions/ADR-10.md): GitHub continuous integration — Complete gates, native platforms,
  project-wide prepared environments, and local rehearsal.
- [workbench:ADR-11](decisions/ADR-11.md): Rust implementation — Errors, unsafe code, stable and Miri toolchains, MSRV,
  portability.
- [workbench:ADR-12](decisions/ADR-12.md): Python implementation — Supported interpreters and strict tools.
- [workbench:ADR-13](decisions/ADR-13.md): TypeScript projects — Latest stable Node development, supported API
  baselines, compiler strictness, typed linting.
- [workbench:ADR-14](decisions/ADR-14.md): C implementation — C17, LLVM checks, FFI, vcpkg dependencies.
- [workbench:ADR-15](decisions/ADR-15.md): C++ implementation — C++20, ownership, exceptions, native checks.
- [workbench:ADR-16](decisions/ADR-16.md): Go implementation — Module/tool pins, analysis, race detection.
- [workbench:ADR-17](decisions/ADR-17.md): Java implementation — Maintained JDKs, explicit release targets, strict
  checks, verified dependencies, and portable JARs.
- [workbench:ADR-18](decisions/ADR-18.md): JavaScript implementation — Checked JavaScript, JSDoc types, Node support,
  source-preserving builds, and independent examples.
- [workbench:ADR-19](decisions/ADR-19.md): Ruby implementation — Maintained Ruby baselines, checksummed Bundler locks,
  strict analysis, coverage, and portable gems.
- [workbench:ADR-1A](decisions/ADR-1A.md): PHP implementation — Maintained PHP baselines, verified Composer
  distributions, strict analysis and portable packages.
- [workbench:ADR-1B](decisions/ADR-1B.md): AWS boundaries — Accounts, SDK credentials, live-test limits.
