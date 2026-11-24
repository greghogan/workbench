---
status: Approved
added_at: 2026-11-12T12:39:15.000Z
---

# TSK-A: Scoped acquisition, builds, and checks

## Review summary

A change in one component can rerun checks and dependency preparation for unrelated components. Let projects declare the
inputs and outputs of acquisition, builds, and checks so each step can run and be reused independently. Use the same
planner and runner for the local CLI, commit hooks, CI, and development artifact verification.

| Step    | Uses                                                       | Produces              |
| ------- | ---------------------------------------------------------- | --------------------- |
| Acquire | Manifests, locks, resolver settings, toolchain, and target | Verified dependencies |
| Build   | Source, build settings, and prepared dependencies          | Build outputs         |
| Check   | Source, fixtures, and any prerequisite outputs             | Verification results  |

Editing source reruns the affected build and checks while reusing dependencies acquired for the same lockfile. Checks
such as formatting can run independently of a build.

Linux builds and ordinary checks use prepared inputs with external networking blocked and private loopback available. On
macOS, source scopes are enforced and networking remains available. Windows uses whole-project execution with networking
available. Live advisories run in a separate connected phase.

Run `workbench prepare` for local acquisition. Use `--staged` to prepare a pending commit. The local gate and commit
hook consume matching prepared inputs and show how to acquire any that are missing. CI acquires inputs before running
the selected checks fresh. A matching development artifact supplies the prepared inputs.

Check plans show the effective scope, and execution reports explain reuse or fallback. Record validation, required
reviews, policy compatibility, and fresh security checks still run independently of reusable code checks.

## Delivery checklist

- [x] Add independent reuse to native check gates with declared inputs.
- [ ] Enforce declared source visibility on Linux and macOS and qualify the whole-project runner on Windows.
- [ ] Integrate scoped acquisition, builds, and checks across Workbench and its examples, including independent starter
      verification and test-owned application fixtures.
- [ ] Apply shared preparation and Linux offline defaults to the CLI, hooks, CI, and development artifacts.

## Implementing-agent detail

### Input contract

- Reuse input groups in project automation for acquisition, builds, and checks. Resolve transitive groups and explicit
  prerequisite outputs. Use literal repository-relative files and directories. Existing `checks.inputs` remains additive
  for checks, including explicitly named ignored files.
- Resolve declarations and their source from the same snapshot. Reject invalid names, unsafe paths, and dependency
  cycles. An uncovered link target or incomplete inventory prevents scoped reuse.
- Include file identity, contents, modes, and presence in the fingerprint. A declared directory covers additions,
  removals, and renames beneath it. Keep global detection of unresolved index entries while limiting untracked-file
  discovery to the selected paths where possible.

### Scoped execution

- Schedule steps through the existing automation roles and their dependencies. Run any installation or linking from
  prepared caches as setup in the consuming workspace.
- Acquire into owned storage from the selected snapshot and verify the locked inputs before publishing the result. Bind
  the result to its recipe, input files, resolver policy, toolchain, and target. Prevent failed or canceled preparation
  from exposing incomplete results. Leave manifests and locks in the source snapshot unchanged.
- Give each consumer its declared prerequisite outputs, such as a prepared dependency store or a packaged application.
  Check presence and identity before reuse. Keep shared outputs read-only and give tools private writable state for
  setup. Missing or expired acquisition results require preparation again.
- Build the fingerprint and the source view from the same captured inventory. Expose declared source read-only,
  including explicitly declared ignored inputs and dependency locks. Supply pinned tools separately. Constrain the
  command and its children to that view, including when they try absolute paths or follow links.
- Use Workbench's existing build, dependency, and temporary directory paths for private writable state. For a required
  checkout-relative output, create its directory in the private workspace and ensure it leaves declared inputs visible
  and read-only. Tests that modify fixtures work on private copies.
- Resolve and fingerprint the committed coverage baseline outside the restricted workspace. Supply the baseline data
  directly and collect the new report through the existing reporting workflow. The captured source and Git index remain
  unchanged.
- Create the restricted view only when a step must execute. Reuse the captured snapshot, source views for identical
  input scopes, and verified toolchains. Include the isolation contract and backend identity in scoped receipts.
- Use mount namespaces on Linux and the signed App Sandbox launcher on macOS. Run Windows checks on the whole project.
- Run Linux builds and ordinary checks with external networking blocked and private loopback available. Require that
  boundary even when source isolation falls back to the whole project. Keep networking available on macOS and Windows.
  Route live checks through their existing connected CI and pre-push gates.
- Use the same restricted view for fresh scoped runs, including `--no-cache` and CI on qualified backends. If source
  isolation is unavailable before launch, report the reason and use whole-project inputs. Fail if required network
  isolation cannot be established. Only verified restricted success can create scoped evidence. Release owned views and
  outputs when canceled.

### Workbench integration

- Declare complete inputs and prerequisite outputs across the application and examples. Use test-owned fixtures for
  application behavior and verify the shipped starters separately. Preserve the required checks, assertions, coverage
  scope, and floors.
- Provide a preparation entry point for working and staged snapshots using the same project and environment selection as
  the gate. Keep toolchain-only images independent of project dependencies. Preserve native, Nix, and Guix pin
  authorities through the shared preparation and execution paths.

### Reuse and reporting

- Bind reusable evidence to the effective input contract, source fingerprint, prerequisite output identities, Workbench
  distribution, tooling, network policy, and effective environment. Retain whole-gate reuse for unscoped checks. Share
  inventory and fingerprint work across groups.
- Reuse verified acquisition and build outputs independently of check results. If a prerequisite output is missing, a
  fresh consumer needs the output restored or rebuilt. Save successful check evidence after the full gate passes with
  stable inputs.
- Show resolved groups and paths in `workbench check --list` and its JSON output. Run reports identify the execution
  backend, fresh runs, reuse, and any fallback. Keep file contents and environment values out of diagnostics.
- Preserve source-stability checks for fresh scans that read beyond the scoped inputs. A source change during those
  scans must prevent reusable success evidence where the existing gate requires a stable whole-project snapshot. Online
  and CI checks run fresh. Keep test-runner filtering independent of the Workbench receipt.
- Record the execution guarantees in the application ADR and align shared artifact and quality gate decisions with
  explicit preparation and separate live checks.

### Acceptance and verification

- Verify that a source-only edit reuses acquisition, while a lockfile or resolver change invalidates it. A missing
  prepared result reports the matching preparation command.
- Verify that a starter-only edit reruns its language and starter checks and reuses application coverage. An application
  fixture edit reruns application coverage.
- For the same snapshot, target, and stage, verify that local and CI plans resolve the same steps, prerequisite outputs,
  and network policy.
- Verify the full required Linux gate through plain `workbench check`, the hook, and CI. Block external networking for
  child processes and retain private loopback. Verify the connected gates on macOS and Windows, and run live advisories
  separately. Exercise the same dependency handoff from a toolchain-only CI image and a development artifact without
  relying on host caches.
- Compare end-to-end gate time for whole-gate and independent reuse after the same isolated source edit under the same
  allocation. Report which groups ran and which reused results.
- Run real checks in a synthetic multi-root repository. Reuse after an unrelated edit and rerun after a change within
  the selected root, a transitive dependency, or a declared shared fixture. Include a non-source file read directly by a
  test and a mode change in shared setup. Exercise a fallback group beside a reusable group. Remove the generated output
  of a previously successful prerequisite and verify that a fresh dependent still gets that output.
- Prepare and check different working and staged snapshots, including different locks and declarations. Verify that both
  source versions stay unchanged, including when a tool would rewrite a lock. Cover additions, deletions, renames,
  ignored inputs, unsafe links, and incomplete declarations.
- Exercise cancellation, failure, and explicit fresh execution in a gate with mixed fresh and reused groups. Failed,
  canceled, and unstable runs supply no new successes.
- On Linux and macOS, run the CLI and staged hook with representative native toolchains. Verify an omitted required file
  causes a failure under isolation and leaves no scoped receipt. Cover relative and absolute paths, links, child
  processes, concurrent runs with distinct source views, read-only input, and writable outputs. Exercise fallback when a
  backend is unavailable. Confirm that isolated and full-source runs select the same required tests on the same
  snapshot, so a missing fixture cannot silently reduce the suite.
- Verify that a fresh scoped coverage run uses the committed baseline and writes its new report separately. Include
  creation and atomic replacement of files in an output directory.
- Verify that project-wide validation, review, and compatibility checks still run on reuse. Change an out-of-scope file
  during a fresh project-wide security check and verify that the gate rejects unstable evidence.

## Implementation account

The selected checks and required setup resolve to an input scope per reusable group. Project configuration and explicit
additional inputs join that scope. The staged hook inventories the Git tree it captured, while working checks include
matching untracked files. Uncertain scoped discovery falls back to the whole project and retains declared inputs.
Workbench's own runtime files also contribute to the key when the checkout supplies the executable.

Check plans show the resolved scope. Run reports distinguish fresh execution, fallback, and reuse. A separate
whole-project fingerprint checks source stability around fresh security scans without tying reusable results to
unrelated edits between invocations.

A complete gate can reuse checks with distinct input scopes even within one execution root. Commands retain their
configured order, and fresh checks recreate the setup they need. The staged-hook test verifies that narrower results
remain reusable alongside fresh whole-project checks and that a fresh dependent still gets its setup output.

The check tests cover transitive groups, suite overrides, literal paths, file mode changes, ignored inputs, and
whole-project fallback. The Git hook test uses staged declarations and files while their working copies differ. A
synthetic Go gate reused the launcher test after an independent edit and ran the credential scan.
