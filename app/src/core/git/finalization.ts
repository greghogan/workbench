import { pruneReviewAuthority } from "../review/review-authority.js";
import { configuredCommitAuthor, rewriteCommit, RewriteSigning } from "./commit-writing.js";
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
  activatePreparedRefs,
  checkFinalizationCheckouts,
  checkFinalizationTags,
  decodeRefMoves,
  finalizationBranch,
  finalizationCheckouts,
  finalizationTagContents,
  finalizationRefs,
  protectRewriteObjects,
  reportRefRecovery,
  retargetFinalizationTag,
  rewriteCheckout,
  rewriteRevision,
  type PreparedRefMove,
} from "./finalization-refs.js";
import { repositoryStatePath, withRepositoryOperation } from "./repository-state.js";
import { withCacheLocksSync } from "../storage/cache-lock.js";
import { taskDecisionPath } from "../tasks/task-decisions.js";
import { taskQueuePath } from "../tasks/task-queue.js";
import { gitRevision } from "./refs.js";

const text = (root: string, args: string[], input?: string) => gitBytes(root, args, input).toString().trim();
interface Finalization {
  version: 1;
  checkout: string;
  branch: string;
  before: string;
  after: string;
  recovery: string;
  replacements: { before: string; after: string }[];
  moves?: PreparedRefMove[];
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
      const before = rewriteRevision(data.before),
        after = rewriteRevision(data.after);
      const moves = data.moves === undefined ? undefined : decodeRefMoves(data.moves);
      if (moves && !moves.some((move) => move.name === branch && move.before === before && move.after === after))
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
          before: rewriteRevision(entry.before),
          after: rewriteRevision(entry.after),
        })),
      };
    },
    () => undefined,
  );
}
export function finalizationPlan(root: string) {
  return inspectFinalization(root, finalizationBranch(root), text(root, ["rev-parse", "HEAD"]));
}

function inspectFinalization(root: string, branch: string | undefined, before: string, moves?: PreparedRefMove[]) {
  const units = pendingCommitReviews(root, before),
    selection = selectFinalization(root, before, units),
    eligible = branch ? units.filter((unit) => selection.selected.has(unit.revision)).map((unit) => unit.revision) : [],
    current = finalizationRefs(root, eligible),
    problems = [...selection.problems].map(([oid, reason]) => `${oid.slice(0, 12)}: ${reason}`);
  let references = current;
  if (moves) {
    const unexpected = current.find(({ name }) => !moves.some((move) => move.name === name));
    if (unexpected) throw new StateConflict(`New affected Git reference: ${unexpected.name}`);
    // Compute the approval against the retained original tips, even when some live refs already moved.
    references = moves.map(({ name, before }) => {
      const target = gitRevision(root, `${before}^{commit}`);
      if (!target) throw new StateConflict(`Cannot inspect the retained original for ${name}`);
      return { name, before, target };
    });
  }
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
function activate(root: string, operation: Finalization, recovering = true): Finalization {
  if (operation.checkout !== root || finalizationBranch(root) !== operation.branch)
    throw new StateConflict("Return to the original checkout and branch before finalization recovery");
  const moves = operation.moves ?? [{ name: operation.branch, before: operation.before, after: operation.after }],
    names = new Set(moves.map((move) => move.name));
  const queues = finalizationCheckouts(root).flatMap(({ directory, branch }) =>
    branch && names.has(branch) ? [taskQueuePath(directory)] : [],
  );
  const locks = [...new Set([agentReviewReceipt(root), reviewReceipt(root), taskDecisionPath(root), ...queues])].sort();
  const partial = withCacheLocksSync(
    locks,
    () => {
      return activatePreparedRefs(root, moves, recovering, () => {
        const latest = recovering
          ? inspectFinalization(root, operation.branch, operation.before, moves)
          : finalizationPlan(root);
        if (latest.digest !== operation.reviewDigest)
          throw new StateConflict("Review set changed. Original and replacement histories remain recoverable");
        checkFinalizationTags(root, moves);
        if (!recovering) store(root).write(operation);
      });
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
  if (recovering) reportRefRecovery("finalization", partial);
  return operation;
}
export function finalizeHistory(root: string, expected: string, recover = false, unattended = false): Finalization {
  return withRepositoryOperation(
    root,
    () => {
      const previous = store(root).read();
      if (previous && !previous.completed) return activate(rewriteCheckout(root, previous.checkout), previous);
      if (recover) throw new InvalidInput("No finalization requires recovery");
      const plan = finalizationPlan(root);
      if (plan.digest !== expected) throw new StateConflict("Review set changed; inspect finalization again");
      if (!plan.units.length) throw new InvalidInput("No provisional commits to finalize");
      if (!plan.eligible.length || !plan.branch) throw new InvalidInput(plan.problems.join("\n"));
      checkFinalizationCheckouts(root, new Set(plan.references.map((ref) => ref.name)));
      checkFinalizationTags(root, plan.references);
      const author = configuredCommitAuthor(root);
      const annotations = plan.references.map((ref) => ({
        ref,
        tags: finalizationTagContents(root, ref, { author, unattended }),
      }));
      const branch = plan.branch,
        namespace = `refs/workbench/recovery/${randomUUID()}`,
        recovery = `${namespace}/before`,
        replacements = new Map<string, string>(),
        retained = new Map([["before", plan.before]]),
        eligible = new Set(plan.eligible);
      const { history } = finalizationHistory(
        root,
        [...new Set(plan.references.map((ref) => ref.target))],
        plan.eligible.map((oid) => commitVersion(root, oid)),
      );
      for (const { revision: before, parents } of history) {
        if (!eligible.has(before) && parents.every((parent) => !replacements.has(parent))) continue;
        const unit = commitVersion(root, before);
        const after = rewriteCommit(
          root,
          before,
          unit.parents.map((parent) => replacements.get(parent) ?? parent),
          !eligible.has(before) && unit.provisional,
          unattended ? RewriteSigning.Unsigned : RewriteSigning.Opportunistic,
          author ?? null,
        );
        replacements.set(before, after);
        retained.set(`prepared/${before}`, after);
      }
      const after = replacements.get(plan.before);
      if (!after || reviewTree(root, after) !== reviewTree(root, plan.before))
        throw new StateConflict("Finalization changed the source snapshot");
      const moves = annotations.map(({ ref, tags }): PreparedRefMove => {
        const replacement = replacements.get(ref.target);
        if (!replacement || reviewTree(root, replacement) !== reviewTree(root, ref.target))
          throw new StateConflict(`Finalization changed the source snapshot for ${ref.name}`);
        retained.set(`before-refs/${ref.name}`, ref.before);
        const afterRef = retargetFinalizationTag(
          root,
          tags,
          replacement,
          (oid) => {
            retained.set(`prepared-tags/${oid}`, oid);
          },
          false,
        );
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
      protectRewriteObjects(root, namespace, retained);
      return activate(root, operation, false);
    },
    "finalization",
  );
}

/** Recover an operation owned by this checkout, including one interrupted after Git committed its refs. */
export function resumePreparedFinalization(root: string): Finalization | undefined {
  const operation = store(root).read();
  if (!operation || operation.completed) return undefined;
  return withRepositoryOperation(
    root,
    () => {
      const pending = store(root).read();
      return pending && !pending.completed ? activate(rewriteCheckout(root, pending.checkout), pending) : undefined;
    },
    "finalization",
  );
}
