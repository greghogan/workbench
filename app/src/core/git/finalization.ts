import { pruneReviewAuthority } from "../review/review-authority.js";
import { rewriteCommit } from "./commit-writing.js";
import { existsSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { BoundedState } from "../storage/bounded-state.js";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";
import { record, string, records } from "../runtime/values.mjs";
import {
  checkAgentPublication,
  checkAgentUnit,
  emptyReviewTree,
  reviewTree,
  finishAgentCommit,
} from "../review/agent-review.js";
import { commitVersion, pendingCommitReviews, allCommitReviews } from "../review/review-units.js";
import { gitBytes } from "./git-snapshot.js";
import { gitAncestor } from "./refs.js";
import { repositoryStatePath, withRepositoryOperation } from "./repository-state.js";

const text = (root: string, args: string[], input?: string) => gitBytes(root, args, input).toString().trim();
const revision = (value: unknown) => {
  const result = string(value, "Missing finalization revision");
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(result)) throw new InvalidInput("Invalid finalization revision");
  return result;
};
interface Finalization {
  version: 1;
  checkout: string;
  branch: string;
  before: string;
  after: string;
  recovery: string;
  replacements: { before: string; after: string }[];
  completed: boolean;
}
function store(root: string) {
  return new BoundedState<Finalization | undefined>(
    () => repositoryStatePath(root, "finalization-operation.json"),
    4 * 1024 * 1024,
    (input) => {
      if (input === undefined) return undefined;
      const data = record(input, "Invalid finalization operation");
      if (data.version !== 1 || typeof data.completed !== "boolean")
        throw new InvalidInput("Invalid finalization operation");
      const branch = string(data.branch, "Missing finalization branch"),
        recovery = string(data.recovery, "Missing finalization recovery reference");
      if (!branch.startsWith("refs/heads/") || !recovery.startsWith("refs/workbench/recovery/"))
        throw new InvalidInput("Invalid finalization reference");
      return {
        version: 1,
        branch,
        recovery,
        checkout: string(data.checkout, "Missing finalization checkout"),
        before: revision(data.before),
        after: revision(data.after),
        completed: data.completed,
        replacements: records(data.replacements, "Invalid finalization replacements").map((entry) => ({
          before: revision(entry.before),
          after: revision(entry.after),
        })),
      };
    },
    () => undefined,
  );
}
function selectedBranch(root: string): string | undefined {
  const selected = spawnSync("git", ["-C", root, "symbolic-ref", "--quiet", "HEAD"], { encoding: "utf8" });
  if (selected.error || (selected.status !== 0 && selected.status !== 1))
    throw new StateConflict("Cannot inspect the finalization branch");
  return selected.status === 0 ? selected.stdout.trim() : undefined;
}
export function finalizationPlan(root: string) {
  const branch = selectedBranch(root);
  const before = text(root, ["rev-parse", "HEAD"]),
    units = pendingCommitReviews(root),
    ids = new Set(units.map((unit) => unit.revision)),
    roots = [...new Set(units.flatMap((unit) => unit.parents.filter((parent) => !ids.has(parent))))],
    base = units.some((unit) => !unit.parents.length)
      ? ""
      : roots.length
        ? text(root, ["merge-base", "--octopus", before, ...roots])
        : before,
    problems: string[] = [];
  for (const unit of units) {
    if (unit.pending)
      problems.push(`${unit.revision.slice(0, 12)}: ${String(unit.pending)} protected file(s) need human review`);
    try {
      checkAgentUnit(root, unit.parents[0] ? reviewTree(root, unit.parents[0]) : emptyReviewTree(root), unit.tree);
    } catch (error) {
      problems.push(`${unit.revision.slice(0, 12)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (units.length) {
    try {
      checkAgentPublication(root, before, base || "0".repeat(before.length));
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
    for (const ref of text(root, ["for-each-ref", "--format=%(refname)", "refs/remotes"]).split("\n").filter(Boolean))
      if (units.some((unit) => gitAncestor(root, unit.revision, ref)))
        problems.push(`Preserve published history reachable through ${ref}`);
  }
  if (units.length && !branch) problems.push("Create or switch to a branch before finalizing history");
  const digest = createHash("sha256")
    .update(
      JSON.stringify([branch, before, base, units.map((unit) => [unit.revision, unit.digest, unit.pending]), problems]),
    )
    .digest("hex");
  return {
    branch,
    before,
    base,
    digest,
    problems,
    units: units.map(({ revision, message, pending, changes }) => ({
      revision,
      subject: message.split("\n")[0] ?? "",
      pending,
      files: changes.length,
    })),
  };
}
function currentBranch(root: string): string {
  return text(root, ["symbolic-ref", "HEAD"]);
}
function activate(root: string, operation: Finalization): Finalization {
  if (operation.checkout !== root || currentBranch(root) !== operation.branch)
    throw new StateConflict("Return to the original checkout and branch before finalization recovery");
  const actual = text(root, ["rev-parse", "HEAD"]);
  if (actual !== operation.before && actual !== operation.after)
    throw new StateConflict("The branch changed; original and replacement histories remain recoverable");
  if (actual === operation.before) gitBytes(root, ["update-ref", operation.branch, operation.after, operation.before]);
  finishAgentCommit(root);
  const pending = allCommitReviews(root);
  pruneReviewAuthority(
    root,
    new Set(pending.flatMap((unit) => unit.changes.map((change) => change.digest))),
    new Set(
      pending.map((unit) =>
        JSON.stringify([unit.parents[0] ? reviewTree(root, unit.parents[0]) : emptyReviewTree(root), unit.tree]),
      ),
    ),
  );
  operation.completed = true;
  store(root).write(operation);
  return operation;
}
export function finalizeHistory(root: string, expected: string, recover = false): Finalization {
  return withRepositoryOperation(
    root,
    () => {
      const previous = store(root).read();
      if (previous && !previous.completed) {
        if (!recover)
          throw new StateConflict("Finalization requires recovery; use workbench commit finalize --recover");
        return activate(root, previous);
      }
      if (recover) throw new InvalidInput("No finalization requires recovery");
      for (const name of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"])
        if (existsSync(text(root, ["rev-parse", "--path-format=absolute", "--git-path", name])))
          throw new StateConflict("Finish the active Git operation before finalizing history");
      const plan = finalizationPlan(root);
      if (plan.digest !== expected) throw new StateConflict("Review set changed; inspect finalization again");
      if (!plan.units.length) throw new InvalidInput("No provisional commits to finalize");
      if (plan.problems.length) throw new InvalidInput(plan.problems.join("\n"));
      const branch = currentBranch(root),
        id = randomUUID(),
        recovery = `refs/workbench/recovery/${id}/before`,
        replacements = new Map<string, string>();
      gitBytes(root, ["update-ref", recovery, plan.before]);
      const history = text(root, [
        "rev-list",
        "--reverse",
        "--topo-order",
        plan.before,
        ...(plan.base ? ["--not", plan.base] : []),
      ])
        .split("\n")
        .filter(Boolean);
      if (history.length > 1000) throw new InvalidInput("Finalization exceeds 1000 retained commits");
      for (const before of history) {
        const unit = commitVersion(root, before);
        if (
          !unit.provisional &&
          unit.parents.every((parent) => !replacements.has(parent) || replacements.get(parent) === parent)
        ) {
          replacements.set(before, before);
          continue;
        }
        const after = rewriteCommit(
          root,
          before,
          unit.parents.map((parent) => replacements.get(parent) ?? parent),
          false,
        );
        replacements.set(before, after);
        gitBytes(root, ["update-ref", `refs/workbench/recovery/${id}/prepared/${before}`, after]);
      }
      const after = replacements.get(plan.before);
      if (!after || reviewTree(root, after) !== reviewTree(root, plan.before))
        throw new StateConflict("Finalization changed the source snapshot");
      const operation: Finalization = {
        version: 1,
        checkout: root,
        branch,
        before: plan.before,
        after,
        recovery,
        replacements: [...replacements].map(([before, after]) => ({ before, after })),
        completed: false,
      };
      store(root).write(operation);
      return activate(root, operation);
    },
    "finalization",
  );
}
