---
status: Accepted
added_at: 2026-11-21T03:10:18.558Z
---

# TSK-7: Run extended checks with the normal gate

## Review summary

Run the normal checks and the project's configured extended checks together with `workbench check --extended`. Add
`--list` to see the same selection without running it. The ordinary invocation and Git hooks keep their existing check
scope.

Each project chooses which extended checks to include. Workbench should include its applicable Miri, mutation, fuzz,
reproducibility, native service, and managed-store checks. They use the existing environment selection, setup, progress,
and reporting. Cleanup, publication, and commands that modify the developer's checkout stay outside the suite.

Windows startup is tested in a disposable Windows Server guest with Desktop Experience. Linux/KVM is the sole automated
VM runner. It prepares or reuses a verified base image, creates a fresh guest disk overlay, and installs the candidate
release. The test checks that Windows starts the shared service at boot and that a fresh ordinary-user desktop sign-in
starts the user service. The runner collects the results and discards the guest's writable state.

## Implementing-agent detail

- Mark extended checks in project configuration. Use the existing check planner for selection, listing, execution,
  reporting, and cache identity.
- Respect project, path, and platform selectors. Explain missing prerequisites for a selected check.
- Run the existing Windows startup verifier inside the guest. Verify the base image and candidate before running. Keep
  credentials and temporary guest data out of retained reports. Bound cancellation and clean up the guest after success,
  failure, or interruption.

## Implementation account

The extended checks use the normal check planner. Selected host-dependent checks run fresh because an installed service
or guest image can change independently of the project source. The text plan separates pre-commit and online pre-push
checks into labeled sections. The combined gate runs an extended online check selected for both stages once. Ordinary
check scope and Git hooks are unchanged.

The Windows runner starts a temporary overlay on a verified desktop image. The isolated guest reports the service
startup and desktop sign-in results over its serial console. Workbench checks the candidate archive, bounds the run, and
reclaims verified abandoned overlays on subsequent runs.

## Verification

Check that the normal gate retains its order and scope, `--extended` adds each matching extended check once, and
`--list` predicts execution. Verify that the same invocation runs the Windows startup test and reports both service
results without manual commands in the guest. Exercise a missing VM prerequisite and guest cleanup on cancellation.
