import { pruneReviewAuthority } from "../review/review-authority.js";
import { commitSigningEnabled, rewriteCommit, unattendedSigningConflict } from "./commit-writing.js";
import { createHash, randomUUID } from "node:crypto";
import { BoundedState } from "../storage/bounded-state.js";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";
import { record, string, records } from "../runtime/values.mjs";
import {
  emptyReviewTree,
  reviewTree,
  finishAgentCommit,
  receiptPath as agentReviewReceipt,
} from "../review/agent-review.js";
import { reviewReceipt } from "../review/review-service.js";
import { commitVersion, pendingCommitReviews, allCommitReviews } from "../review/review-units.js";
import { gitBytes } from "./git-snapshot.js";
import { finalizationHistory, selectFinalization } from "./finalization-selection.js";
import {
  activateFinalizationRefs,
  checkFinalizationCheckouts,
  checkFinalizationTags,
  finalizationBranch,
  finalizationCheckouts,
  finalizationTagContents,
  finalizationRefs,
  retargetFinalizationTag,
  type FinalizationMove,
} from "./finalization-refs.js";
import { repositoryStatePath, withRepositoryOperation } from "./repository-state.js";
import {
  CacheLockState,
  inspectCacheMetadataLock,
  recoverCacheMetadataLock,
  withCacheLocksSync,
} from "../storage/cache-lock.js";
import { taskDecisionPath } from "../tasks/task-decisions.js";
import { taskQueuePath } from "../tasks/task-queue.js";
import { verifiedSignatureKey } from "./signatures.js";

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
  moves?: FinalizationMove[];
  reviewDigest?: string;
  finalized?: number;
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
      const before = revision(data.before),
        after = revision(data.after);
      const moves =
        data.moves === undefined
          ? undefined
          : records(data.moves, "Invalid finalization references").map((entry) => {
              const name = string(entry.name, "Missing finalization reference");
              if (!/^refs\/(?:heads|tags)\/\S+$/.test(name) || name.includes("\0"))
                throw new InvalidInput("Invalid finalization reference");
              return { name, before: revision(entry.before), after: revision(entry.after) };
            });
      if (
        moves &&
        (new Set(moves.map((move) => move.name)).size !== moves.length ||
          !moves.some((move) => move.name === branch && move.before === before && move.after === after))
      )
        throw new InvalidInput("Invalid affected finalization references");
      const reviewDigest =
        data.reviewDigest === undefined ? undefined : string(data.reviewDigest, "Invalid finalization review digest");
      if (reviewDigest !== undefined && !/^[a-f0-9]{64}$/.test(reviewDigest))
        throw new InvalidInput("Invalid finalization review digest");
      const finalized = data.finalized;
      if (
        finalized !== undefined &&
        (typeof finalized !== "number" || !Number.isSafeInteger(finalized) || finalized < 1)
      )
        throw new InvalidInput("Invalid finalized commit count");
      return {
        version: 1,
        branch,
        recovery,
        checkout: string(data.checkout, "Missing finalization checkout"),
        before,
        after,
        ...(moves ? { moves } : {}),
        ...(reviewDigest ? { reviewDigest } : {}),
        ...(finalized === undefined ? {} : { finalized }),
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
export function finalizationPlan(root: string) {
  const branch = finalizationBranch(root);
  const before = text(root, ["rev-parse", "HEAD"]),
    units = pendingCommitReviews(root),
    selection = selectFinalization(root, before, units),
    eligible = branch ? units.filter((unit) => selection.selected.has(unit.revision)).map((unit) => unit.revision) : [],
    references = finalizationRefs(root, eligible),
    problems = [...selection.problems].map(([oid, reason]) => `${oid.slice(0, 12)}: ${reason}`);
  if (units.length && !branch) problems.push("Create or switch to a branch before finalizing history");
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        branch,
        before,
        eligible,
        references,
        units.map((unit) => [unit.revision, unit.digest, unit.pending]),
        problems,
      ]),
    )
    .digest("hex");
  return {
    branch,
    before,
    eligible,
    references,
    digest,
    problems,
    units: units.map(({ revision, message, pending, changes }) => ({
      revision,
      subject: message.split("\n")[0] ?? "",
      pending,
      files: changes.length,
      ready: eligible.includes(revision),
    })),
  };
}
function activate(root: string, operation: Finalization, prepared = false): Finalization {
  if (operation.checkout !== root || finalizationBranch(root) !== operation.branch)
    throw new StateConflict("Return to the original checkout and branch before finalization recovery");
  const moves = operation.moves ?? [{ name: operation.branch, before: operation.before, after: operation.after }],
    names = new Set(moves.map((move) => move.name));
  if (!prepared && text(root, ["rev-parse", "HEAD"]) === operation.before) checkFinalizationTags(root, moves);
  const queues = finalizationCheckouts(root).flatMap(({ directory, branch }) =>
    branch && names.has(branch) ? [taskQueuePath(directory)] : [],
  );
  const locks = [...new Set([agentReviewReceipt(root), reviewReceipt(root), taskDecisionPath(root), ...queues])].sort();
  withCacheLocksSync(
    locks,
    () => {
      const actual = text(root, ["rev-parse", "HEAD"]);
      if (actual !== operation.before && actual !== operation.after)
        throw new StateConflict("The branch changed; original and replacement histories remain recoverable");
      if (
        actual === operation.before &&
        operation.reviewDigest &&
        finalizationPlan(root).digest !== operation.reviewDigest
      )
        throw new StateConflict("Review set changed; original and replacement histories remain recoverable");
      if (prepared) store(root).write(operation);
      activateFinalizationRefs(root, moves);
    },
    { mutable: false },
  );
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
export function finalizeHistory(root: string, expected: string, recover = false, unattended = false): Finalization {
  if (recover || unattended) {
    const path = repositoryStatePath(root, "record-operation"),
      lock = inspectCacheMetadataLock(path);
    if (lock.state === CacheLockState.Abandoned) recoverCacheMetadataLock(path, { expected: lock.digest });
  }
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
      const plan = finalizationPlan(root);
      if (plan.digest !== expected) throw new StateConflict("Review set changed; inspect finalization again");
      if (!plan.units.length) throw new InvalidInput("No provisional commits to finalize");
      if (!plan.eligible.length || !plan.branch) throw new InvalidInput(plan.problems.join("\n"));
      checkFinalizationCheckouts(root, new Set(plan.references.map((ref) => ref.name)));
      checkFinalizationTags(root, plan.references);
      if (unattended && commitSigningEnabled(root)) throw new StateConflict(unattendedSigningConflict);
      const annotations = plan.references.map((ref) => ({ ref, tags: finalizationTagContents(root, ref, unattended) }));
      const branch = plan.branch,
        id = randomUUID(),
        recovery = `refs/workbench/recovery/${id}/before`,
        replacements = new Map<string, string>(),
        eligible = new Set(plan.eligible);
      const { history } = finalizationHistory(
        root,
        [...new Set(plan.references.map((ref) => ref.target))],
        plan.eligible.map((oid) => commitVersion(root, oid)),
      );
      const rewriting = new Set<string>(),
        commits = history.flatMap(({ revision, parents }) => {
          if (!eligible.has(revision) && parents.every((parent) => !rewriting.has(parent))) return [];
          rewriting.add(revision);
          const unit = commitVersion(root, revision);
          if (unattended && unit.signed) throw new StateConflict(unattendedSigningConflict);
          return [{ unit, signer: unit.signed ? verifiedSignatureKey(root, "commit", revision) : undefined }];
        });
      gitBytes(root, ["update-ref", recovery, plan.before]);
      for (const { unit, signer } of commits) {
        const before = unit.revision;
        const after = rewriteCommit(
          root,
          before,
          unit.parents.map((parent) => replacements.get(parent) ?? parent),
          !eligible.has(before) && unit.provisional,
          unattended,
        );
        if (signer && verifiedSignatureKey(root, "commit", after) !== signer)
          throw new StateConflict(`${before.slice(0, 12)} would be signed by a different key`);
        replacements.set(before, after);
        gitBytes(root, ["update-ref", `refs/workbench/recovery/${id}/prepared/${before}`, after]);
      }
      const after = replacements.get(plan.before);
      if (!after || reviewTree(root, after) !== reviewTree(root, plan.before))
        throw new StateConflict("Finalization changed the source snapshot");
      const moves = annotations.map(({ ref, tags }): FinalizationMove => {
        const replacement = replacements.get(ref.target);
        if (!replacement || reviewTree(root, replacement) !== reviewTree(root, ref.target))
          throw new StateConflict(`Finalization changed the source snapshot for ${ref.name}`);
        gitBytes(root, ["update-ref", `refs/workbench/recovery/${id}/before-refs/${ref.name}`, ref.before]);
        const afterRef = retargetFinalizationTag(root, tags, replacement, (oid) => {
          gitBytes(root, ["update-ref", `refs/workbench/recovery/${id}/prepared-tags/${oid}`, oid]);
        });
        return { name: ref.name, before: ref.before, after: afterRef };
      });
      const operation: Finalization = {
        version: 1,
        checkout: root,
        branch,
        before: plan.before,
        after,
        recovery,
        replacements: [...replacements].map(([before, after]) => ({ before, after })),
        moves,
        reviewDigest: plan.digest,
        finalized: eligible.size,
        completed: false,
      };
      return activate(root, operation, true);
    },
    "finalization",
  );
}

/** Retry only an operation already prepared for this checkout. */
export function preparedFinalization(root: string): boolean {
  const operation = store(root).read();
  return (
    !!operation && !operation.completed && operation.checkout === root && operation.branch === finalizationBranch(root)
  );
}
