import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  acknowledgePolicyCompatibility,
  checkPolicyCompatibility,
  policyCompatibility,
} from "./policy-compatibility.js";
import { required } from "./invariants.js";
import { ownedPath } from "./paths.js";
import { stagedRecordTree, type RecordTree } from "./staged-records.js";

interface StagedPolicyReview {
  status: ReturnType<typeof policyCompatibility> & { selection: "staged" };
  check: () => void;
  acknowledge: (expected: string, reviewed: boolean) => void;
}

function materialize(tree: RecordTree, directory: string): void {
  mkdirSync(directory);
  for (const [path] of tree.policyEntries()) {
    const destination = ownedPath(directory, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, required(tree.bytes(path), "expected selected policy bytes"));
  }
}

/** Review immutable staged policy while retaining the checkout's local policy and receipt ownership. */
export async function withStagedPolicyReview<T>(
  root: string,
  action: (review: StagedPolicyReview) => T | Promise<T>,
): Promise<T> {
  const temporary = mkdtempSync(join(tmpdir(), "workbench-policy-review-"));
  try {
    const snapshot = join(temporary, "project");
    materialize(stagedRecordTree(root), snapshot);
    const initial = policyCompatibility(snapshot, root);
    const status = {
      ...initial,
      selection: "staged" as const,
      project_sources: initial.project_sources.map((source) => ({
        ...source,
        decision_map: join(root, relative(snapshot, source.decision_map)),
      })),
    };
    const assertCurrent = () => {
      const latest = join(temporary, "latest");
      rmSync(latest, { recursive: true, force: true });
      materialize(stagedRecordTree(root), latest);
      const current = policyCompatibility(latest, root);
      if (current.digest !== status.digest)
        throw new Error("policies changed during review; inspect 'workbench collection compatibility --staged' again");
      if (current.conflicts.length || current.stale_contexts.length)
        throw new Error("resolve policy collisions and refresh local contexts before acknowledgment");
    };
    return await action({
      status,
      check() {
        assertCurrent();
        checkPolicyCompatibility(snapshot, root);
      },
      acknowledge(expected, reviewed) {
        assertCurrent();
        acknowledgePolicyCompatibility(snapshot, expected, reviewed, root);
      },
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
