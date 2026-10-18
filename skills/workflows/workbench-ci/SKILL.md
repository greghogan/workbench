---
name: workbench-ci
description:
  Diagnose and fix requested CI failures in a Workbench project using the failed revision, job, and environment. Use for
  failed checks, not deployment or unrequested dependency updates.
---

# CI diagnosis

Identify the failing revision, job or matrix entry, first causal failure, and available logs. Read the relevant CI,
quality-gate, toolchain, and environment decisions. Inspect the workflow and configured Workbench commands to determine
what actually ran; a successful host check does not reproduce a Guix, Nix, or minimum-version job.

Reproduce with the same committed dependency locks, environment pins, working root, and check command in a disposable
checkout when necessary. Preserve the user's pending work. If the environment cannot run locally, report that limitation
and use existing CI evidence; do not silently fall back to another toolchain or launch a remote run without
authorization.

Separate product defects, check defects, environment/setup failures, and external-service failures. Apply a supported
in-scope repair and rerun the failed check, then the applicable gate. Preserve strictness and coverage: do not skip a
matrix entry, loosen a requirement, update a Guix/Nix pin, or regenerate a lockfile merely to obtain a green result.
When evidence points to a needed policy or pin change outside the request, present the concrete change and rationale.

Report the cause, retained repair, exact verification environment and revision, and remaining unverified jobs. A local
pass does not establish a hosted pass. Do not stage, commit, push, rerun remote jobs, or publish unless requested.
