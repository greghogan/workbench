---
summary: Configured checks and complete proposed-tree gates.
agent_instruction: Before reporting a change complete, run Workbench validation and the applicable configured checks.
---

# ADR-U: Quality gates

Project configuration defines required checks and their execution environments. Complete gates include structural
validation and all checks required for the selected stage. Projects using only structural validation declare that choice
explicitly; missing check configuration never implies successful verification.

Commit gates require all commit-stage checks against the complete proposed tree. Filenames do not select which checks
are required. Verification does not rewrite that tree.

Keep network-dependent checks separately invocable before push and include them in CI. Run these checks fresh; offline
check success does not establish their result. A combined local gate may report unavailable connectivity and skip online
checks; the push gate and CI require them.

Reuse successful complete-gate evidence only for identical source inputs, selected checks, tooling, and execution
environments. Uncertain or changed inputs require fresh verification. Provide explicit fresh execution and always use it
in CI.

Validate records, maps, and policy independently of cached code checks. Exclude project records and their supporting
files, generated agent context, and coverage reports from code inputs unless explicitly declared as build or test
inputs. Test-owned fixtures remain inputs. Security checks run fresh when code evidence is reused.

Construct native check environments from platform requirements, selected toolchains, and explicitly declared caller
inputs. Cached evidence uses that effective environment and relevant external configuration. Keep agent, terminal, and
scheduler bookkeeping outside tool environments.

Selected checks include their required setup in the selected environment. Reject unknown stages, excluded required
setup, and unintended empty gates.

Rationale: Explicit check requirements prevent incomplete runs from implying verification. Complete proposed-tree gates
bind evidence to the change being committed.
