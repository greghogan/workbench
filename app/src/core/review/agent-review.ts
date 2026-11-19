import { gitAncestor } from "../git/refs.js";
import { acceptedAgentContext } from "./review-authority.js";
import { projectPaths } from "../projects/project-paths.js";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { commitVersion } from "./review-units.js";
import { checkProvisionalPush, pendingMergeParents, retainedProvisionalCommits } from "../git/commit-history.js";
import { gitBytes, readGitObjects, stagedReviewTree, workingReviewTree } from "../git/git-snapshot.js";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";
import { record, records, string, strings } from "../runtime/values.mjs";
import { BoundedState } from "../storage/bounded-state.js";
import { withCacheLocksSync } from "../storage/cache-lock.js";
import { readTaskQueue } from "../tasks/task-queue.js";
import { readTaskDecisions } from "../tasks/task-decisions.js";
import { readTaskPlanApproval } from "../tasks/task-approvals.js";
import { taskPlanApprovalDigest } from "../tasks/task-plan.js";
import { acceptedTaskVersion, treeTasks } from "../tasks/task-snapshot.js";

export enum AgentReviewKind {
  Changes = "changes",
  Task = "task",
}
export interface AgentReview {
  kind: AgentReviewKind;
  base: string;
  tree: string;
  parentTrees?: string[];
  tasks: string[];
  summary: string;
  verification: string;
  reviewed: string;
}
export interface ReviewPolicy {
  changes: boolean;
  tasks: boolean;
  task_approvals: boolean;
}
const oid = (value: unknown) => {
  const text = string(value, "Missing Git tree identity");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(text)) throw new InvalidInput("Invalid Git tree identity");
  return text;
};
type ChangeContext = Pick<AgentReview, "base" | "tree" | "parentTrees">;
const changeContextKey = ({ base, tree, parentTrees }: ChangeContext) =>
  JSON.stringify([base, tree, ...(parentTrees ? [parentTrees] : [])]);
const sameParents = (left?: string[], right?: string[]) => JSON.stringify(left) === JSON.stringify(right);

export const reviewIdentity = (review: Pick<AgentReview, "kind" | "base" | "tree" | "tasks" | "parentTrees">) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        review.kind,
        review.base,
        review.tree,
        [...review.tasks].sort(),
        ...(review.parentTrees ? [review.parentTrees] : []),
      ]),
    )
    .digest("hex");
const git = (root: string, args: string[], input?: string) => gitBytes(root, args, input).toString().trim();
export function reviewTree(root: string, revision: string): string {
  if (revision.startsWith("-") || /[\0\r\n]/.test(revision)) throw new InvalidInput("Invalid review revision");
  return oid(git(root, ["rev-parse", "--verify", `${revision}^{tree}`]));
}
export function emptyReviewTree(root: string): string {
  return oid(git(root, ["mktree"], ""));
}
function hasHead(root: string): boolean {
  return spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", "HEAD"], { stdio: "ignore" }).status === 0;
}
function proposedParents(root: string, amend = false): string[] {
  if (!hasHead(root)) return [];
  if (amend) return git(root, ["rev-list", "--parents", "-n", "1", "HEAD"]).split(" ").slice(1).map(oid);
  const head = git(root, ["rev-parse", "--verify", "HEAD"]);
  return [head, ...pendingMergeParents(root)];
}
function mergeParentTrees(root: string, parents: readonly string[]): string[] | undefined {
  if (parents.length > 256) throw new InvalidInput("Too many merge parents to retain a review context");
  return parents.length > 1 ? parents.map((parent) => reviewTree(root, parent)) : undefined;
}
function firstParentTree(root: string, parents: readonly string[]): string {
  return parents[0] ? reviewTree(root, parents[0]) : emptyReviewTree(root);
}
function contextForParents(root: string, tree: string, parents: readonly string[]): ChangeContext {
  const parentTrees = mergeParentTrees(root, parents);
  return { base: parentTrees?.[0] ?? firstParentTree(root, parents), tree, ...(parentTrees ? { parentTrees } : {}) };
}
export function proposedAgentReview(
  root: string,
  kind: AgentReviewKind,
  options: { base?: string; amend?: boolean; staged?: boolean; tasks?: string[]; commit?: string } = {},
): AgentReview {
  if (
    options.commit !== undefined &&
    ((kind === AgentReviewKind.Changes && options.base !== undefined) || options.amend || options.staged)
  )
    throw new InvalidInput("Select a retained commit or current files, without mixing review boundaries");
  const unit = options.commit !== undefined ? commitVersion(root, options.commit) : undefined;
  const parents = kind === AgentReviewKind.Changes ? (unit?.parents ?? proposedParents(root, options.amend)) : [];
  const parentTrees = mergeParentTrees(root, parents);
  if (parentTrees && options.base !== undefined)
    throw new InvalidInput("Review the merge against all of its parents without selecting a separate base");
  let base: string;
  if (options.base) base = reviewTree(root, options.base);
  else if (kind === AgentReviewKind.Changes) base = parentTrees?.[0] ?? firstParentTree(root, parents);
  else if (!hasHead(root)) base = emptyReviewTree(root);
  else if (options.amend) base = firstParentTree(root, proposedParents(root, true));
  else throw new InvalidInput("Task review requires --base naming the start of the accumulated work");
  const tree = unit?.tree ?? (options.staged ? stagedReviewTree(root) : workingReviewTree(root));
  const associated = [...(options.tasks ?? [])];
  if (kind !== AgentReviewKind.Task || !associated.length) {
    const tasks = treeTasks(root, tree),
      previous = treeTasks(root, base);
    for (const [reference, task] of tasks) {
      const prior = previous.get(reference);
      if (
        ["Approved", "Accepted"].includes(task.status) &&
        (prior?.digest !== task.digest || prior.workDigest !== task.workDigest)
      )
        associated.push(reference);
    }
    for (const entry of unit ? [] : readTaskQueue(root).entries)
      if (["Active", "Implemented"].includes(entry.state) && tasks.get(entry.reference)?.status === "Approved")
        associated.push(entry.reference);
    if (kind === AgentReviewKind.Task) associated.push(...pendingTasks(root, unit?.revision));
  }
  return {
    kind,
    base,
    tree,
    ...(parentTrees ? { parentTrees } : {}),
    tasks: [...new Set(associated)].sort(),
    summary: "",
    verification: "",
    reviewed: new Date().toISOString(),
  };
}
export function receiptPath(root: string): string {
  return resolve(root, git(root, ["rev-parse", "--git-path", "workbench/agent-reviews.json"]));
}
interface ReviewState {
  version: 3;
  reviews: AgentReview[];
  pending: { scope: string; tip: string; tasks: string[] }[];
}
function decode(input: unknown): ReviewState {
  const value = record(input, "Invalid agent review receipts");
  if (value.version !== 3) throw new InvalidInput("Unsupported agent review receipt version");
  const entries = records(value.reviews, "Invalid agent reviews");
  if (entries.length > 4096) throw new InvalidInput("Agent review receipt limit exceeded");
  const reviews = entries.map((entry) => {
    const kind = Object.values(AgentReviewKind).find((kind) => kind === entry.kind);
    if (!kind) throw new InvalidInput("Invalid agent review kind");
    const tasks = strings(entry.tasks, "Invalid reviewed tasks");
    if (tasks.some((task) => !/^[a-z][a-z0-9_-]*:TSK-[0-9A-Z]+$/.test(task)))
      throw new InvalidInput("Invalid reviewed task reference");
    const summary = string(entry.summary, "Missing review summary"),
      verification = string(entry.verification, "Missing review verification"),
      reviewed = string(entry.reviewed, "Missing review time");
    if (
      !summary.trim() ||
      !verification.trim() ||
      summary.length > 16384 ||
      verification.length > 16384 ||
      !Number.isFinite(Date.parse(reviewed))
    )
      throw new InvalidInput("Invalid review assessment");
    const base = oid(entry.base);
    const parentTrees =
      entry.parentTrees === undefined ? undefined : strings(entry.parentTrees, "Invalid merge parent trees").map(oid);
    if (
      parentTrees &&
      (kind !== AgentReviewKind.Changes ||
        parentTrees.length < 2 ||
        parentTrees.length > 256 ||
        parentTrees[0] !== base)
    )
      throw new InvalidInput("Invalid merge review context");
    return {
      kind,
      base,
      tree: oid(entry.tree),
      ...(parentTrees ? { parentTrees } : {}),
      tasks,
      summary,
      verification,
      reviewed,
    };
  });
  if (new Set(reviews.map(reviewIdentity)).size !== reviews.length)
    throw new InvalidInput("Duplicate agent review kind");
  const pending = records(value.pending, "Invalid pending task associations").map((entry) => ({
    scope: string(entry.scope, "Missing work scope"),
    tip: oid(entry.tip),
    tasks: strings(entry.tasks, "Invalid pending tasks"),
  }));
  if (
    new Set(pending.map((entry) => entry.scope)).size !== pending.length ||
    pending.some(
      (entry) =>
        !entry.scope ||
        /[\0\r\n]/.test(entry.scope) ||
        entry.tasks.some((task) => !/^[a-z][a-z0-9_-]*:TSK-[0-9A-Z]+$/.test(task)),
    )
  )
    throw new InvalidInput("Invalid pending task associations");
  return { version: 3, reviews, pending };
}
const store = (root: string) =>
  new BoundedState<ReviewState>(
    () => receiptPath(root),
    64 * 1024 * 1024,
    decode,
    () => ({ version: 3, reviews: [], pending: [] }),
  );
function readReviews(root: string): AgentReview[] {
  return store(root).read().reviews;
}
/** Validate local receipt data with the application selected for an update, without changing attestations. */
export function validateAgentReviewState(root: string): void {
  store(root).read();
}
export function recordAgentReview(
  root: string,
  review: AgentReview,
  expected: string,
  staged = false,
  commit?: string,
  amend = false,
): void {
  if (reviewIdentity(review) !== expected)
    throw new StateConflict("Review snapshot changed; inspect it again before recording review");
  const unit = commit !== undefined ? commitVersion(root, commit) : undefined;
  const current = unit?.tree ?? (staged ? stagedReviewTree(root) : workingReviewTree(root));
  if (current !== review.tree) throw new StateConflict("Review contents changed; review the new snapshot");
  if (
    review.kind === AgentReviewKind.Changes &&
    ((review.parentTrees && review.base !== review.parentTrees[0]) ||
      !sameParents(review.parentTrees, mergeParentTrees(root, unit?.parents ?? proposedParents(root, amend))))
  )
    throw new StateConflict("Merge parents changed; review the new snapshot");
  const tasks = treeTasks(root, review.tree);
  for (const task of review.tasks)
    if (!tasks.has(task)) throw new InvalidInput(`Reviewed task not found in the selected snapshot: ${task}`);
  const retained = retainedChangeContexts(root),
    committed = new Set(
      hasHead(root) ? git(root, ["log", "--format=%T", "--max-count=4096", "--branches", "HEAD"]).split("\n") : [],
    );
  withCacheLocksSync([receiptPath(root)], () => {
    const state = store(root).read(),
      pending = new Set([review.tree, stagedReviewTree(root), workingReviewTree(root)]);
    const entries = state.reviews.filter(
      (entry) =>
        reviewIdentity(entry) !== expected &&
        (entry.kind === AgentReviewKind.Task
          ? committed.has(entry.tree) || pending.has(entry.tree)
          : retained.has(changeContextKey(entry)) || pending.has(entry.tree)),
    );
    entries.push(review);
    store(root).write({ ...state, reviews: entries });
  });
}
function workScope(root: string): string {
  const result = spawnSync("git", ["-C", root, "symbolic-ref", "--quiet", "HEAD"], { encoding: "utf8" });
  if (result.status === 0) return result.stdout.trim();
  if (result.status === 1) return "detached";
  throw new InvalidInput("Cannot identify current work scope");
}
function pendingTasks(root: string, tip?: string): string[] {
  const state = store(root).read();
  if (!tip) return state.pending.find((entry) => entry.scope === workScope(root))?.tasks ?? [];
  const refs = new Map(
    git(root, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"])
      .split("\n")
      .filter(Boolean)
      .map((row) => row.split(" ")) as [string, string][],
  );
  const revision = git(root, ["rev-parse", "--verify", `${tip}^{commit}`]);
  const detachedTip = workScope(root) === "detached" ? git(root, ["rev-parse", "HEAD"]) : undefined;
  return [
    ...new Set(
      state.pending
        .filter(
          (entry) =>
            refs.get(entry.scope) === revision ||
            entry.tip === revision ||
            (entry.scope === "detached" && detachedTip === revision),
        )
        .flatMap((entry) => entry.tasks),
    ),
  ];
}
export function finishAgentCommit(root: string): void {
  if (!hasHead(root)) return;
  const retained = retainedChangeContexts(root);
  const committed = reviewTree(root, "HEAD"),
    tip = git(root, ["rev-parse", "HEAD"]),
    parentTrees = mergeParentTrees(root, proposedParents(root, true)),
    scope = workScope(root);
  withCacheLocksSync([receiptPath(root)], () => {
    const state = store(root).read();
    const consumed = state.reviews.filter(
      (entry) =>
        entry.kind === AgentReviewKind.Changes &&
        entry.tree === committed &&
        sameParents(entry.parentTrees, parentTrees),
    );
    const tasks = [
      ...new Set([
        ...(state.pending.find((entry) => entry.scope === scope)?.tasks ?? []),
        ...consumed.flatMap((entry) => entry.tasks),
      ]),
    ];
    const live = new Set(git(root, ["for-each-ref", "--format=%(refname)", "refs/heads"]).split("\n"));
    state.pending = state.pending.filter(
      (entry) => entry.scope !== scope && (entry.scope === "detached" || live.has(entry.scope)),
    );
    if (tasks.length) state.pending.push({ scope, tip, tasks });
    state.reviews = state.reviews.filter(
      (entry) => entry.kind === AgentReviewKind.Task || retained.has(changeContextKey(entry)),
    );
    store(root).write(state);
  });
}
export function reviewPolicy(root: string, tree: string): ReviewPolicy {
  return decodeReviewPolicy(
    readGitObjects(root, [`${tree}:${projectPaths.config}`]).get(`${tree}:${projectPaths.config}`),
  );
}
function decodeReviewPolicy(contents: Buffer | undefined): ReviewPolicy {
  if (!contents) return { changes: false, tasks: false, task_approvals: false };
  const config = parseToml(contents.toString());
  const value = record(config.review ?? {}, "Invalid review policy");
  for (const key of ["changes", "tasks", "task_approvals"])
    if (value[key] !== undefined && typeof value[key] !== "boolean")
      throw new InvalidInput(`Invalid review policy: ${key} must be a boolean`);
  return {
    changes: value.changes === true,
    tasks: value.tasks === true,
    task_approvals: value.task_approvals === true,
  };
}
function requiredPolicy(
  root: string,
  before: string,
  after: string,
  cache = new Map<string, ReviewPolicy>(),
): ReviewPolicy {
  const at = (tree: string) => {
    let policy = cache.get(tree);
    if (!policy) {
      policy = reviewPolicy(root, tree);
      cache.set(tree, policy);
    }
    return policy;
  };
  const previous = at(before),
    current = at(after);
  return {
    changes: previous.changes || current.changes,
    tasks: previous.tasks || current.tasks,
    task_approvals: previous.task_approvals || current.task_approvals,
  };
}
export function checkAgentCommit(root: string, tree?: string): void {
  const selected = tree ?? stagedReviewTree(root);
  const context = contextForParents(root, selected, proposedParents(root));
  const policy = reviewContextPolicy(root, context);
  if (!policy.changes && !policy.task_approvals) return;
  let associated: string[] = [];
  if (policy.changes) {
    const contexts = new Set([changeContextKey(context)]);
    if (!context.parentTrees)
      contexts.add(changeContextKey(contextForParents(root, selected, proposedParents(root, true))));
    const matched = readReviews(root).filter(
      (entry) => entry.kind === AgentReviewKind.Changes && contexts.has(changeContextKey(entry)),
    );
    if (!matched.length)
      throw new InvalidInput(
        "Change review is required for this staged snapshot. Complete the review, then record it with 'workbench review changes --record'.",
      );
    associated = [...new Set(matched.flatMap((entry) => entry.tasks))];
  }
  if (policy.task_approvals) checkTaskDecisions(root, selected, false, associated, context.base);
}

function reviewContextPolicy(
  root: string,
  { base, tree, parentTrees }: ChangeContext,
  cache = new Map<string, ReviewPolicy>(),
): ReviewPolicy {
  const policy = requiredPolicy(root, base, tree, cache);
  for (const parent of parentTrees?.slice(1) ?? []) {
    const other = cache.get(parent) ?? reviewPolicy(root, parent);
    cache.set(parent, other);
    policy.changes ||= other.changes;
    policy.tasks ||= other.tasks;
    policy.task_approvals ||= other.task_approvals;
  }
  return policy;
}

function checkTaskDecisions(
  root: string,
  tree: string,
  publishing: boolean,
  associated: string[] = [],
  baseline?: string,
  only?: ReadonlySet<string>,
): void {
  const previous = baseline ? treeTasks(root, baseline) : undefined;
  const tasks = treeTasks(root, tree),
    decisions = readTaskDecisions(root);
  for (const reference of associated)
    if (!tasks.has(reference))
      throw new InvalidInput(`${reference}: associated task is missing from the reviewed snapshot.`);
  for (const [reference, task] of tasks) {
    if (only && !only.has(reference)) continue;
    const prior = previous?.get(reference);
    if (
      !associated.includes(reference) &&
      ((prior?.digest === task.digest && prior.workDigest === task.workDigest) ||
        !["Approved", "Accepted"].includes(task.status))
    )
      continue;
    if (publishing && associated.includes(reference) && task.status !== "Accepted")
      throw new InvalidInput(`${reference}: human acceptance is required before publishing associated implementation.`);
    if (associated.includes(reference) && !["Approved", "Accepted"].includes(task.status))
      throw new InvalidInput(`${reference}: approve the plan before committing associated implementation.`);
    if (task.status === "Planned" || task.status === "Canceled") continue;
    const approval = decisions.find((decision) => decision.reference === reference && decision.status === "Approved");
    if (approval?.source === "developer-requested-review") {
      const requested = readTaskPlanApproval(root, approval);
      if (!requested || taskPlanApprovalDigest(requested.contents, requested.files) !== task.planScope())
        throw new InvalidInput(`${reference}: the project review scope changed; obtain approval of the revised plan.`);
    }
    if (!["Approved", "Accepted"].includes(prior?.status ?? "") && !approval)
      throw new InvalidInput(
        `${reference}: human plan approval is required; use 'workbench task approve' or the task page.`,
      );
    if (task.status === "Accepted" || publishing) {
      if (task.status !== "Accepted")
        throw new InvalidInput(`${reference}: human acceptance is required before publishing implementation.`);
      const version = task.outcome();
      if (
        !decisions.some(
          (decision) =>
            decision.reference === reference &&
            decision.status === "Accepted" &&
            decision.digest === task.digest &&
            acceptedTaskVersion(root, decision) === version,
        )
      )
        throw new InvalidInput(
          `${reference}: human acceptance does not cover the current task record and its supporting files.`,
        );
    }
  }
}
export function checkAgentPush(root: string, tip: string, remote: string): void {
  checkProvisionalPush(root, tip, remote);
  prunePublishedReviews(root, remote);
  checkAgentPublication(root, tip, remote);
}

export function checkAgentPublication(
  root: string,
  tip: string,
  remote: string,
  finalizingTasks?: ReadonlySet<string>,
): void {
  const policies = new Map<string, ReviewPolicy>();
  const tree = reviewTree(root, tip),
    base = /^0+$/.test(remote) ? emptyReviewTree(root) : reviewTree(root, remote);
  const rows = git(root, [
    "log",
    "--no-show-signature",
    "--format=%H %T %P",
    tip,
    ...(/^0+$/.test(remote) ? ["--not", "--remotes"] : ["--not", remote]),
  ])
    .split("\n")
    .filter(Boolean)
    .map((row) => {
      const [commit, contents, ...parents] = row.trim().split(" ");
      if (!commit || !contents) throw new InvalidInput("Invalid outgoing Git history");
      return { commit, contents: oid(contents), parents };
    });
  if (!rows.length) return;
  const knownTrees = new Map(rows.map((row) => [row.commit, row.contents]));
  for (const parent of new Set(rows.flatMap((row) => row.parents)))
    if (!knownTrees.has(parent)) knownTrees.set(parent, reviewTree(root, parent));
  const empty = emptyReviewTree(root);
  const policyTrees = [...new Set([base, tree, empty, ...knownTrees.values()])];
  const policyObjects = readGitObjects(
    root,
    policyTrees.map((value) => `${value}:${projectPaths.config}`),
  );
  const decoded = new Map<Buffer, ReviewPolicy>();
  for (const value of policyTrees) {
    const bytes = policyObjects.get(`${value}:${projectPaths.config}`);
    const policy = bytes ? (decoded.get(bytes) ?? decodeReviewPolicy(bytes)) : decodeReviewPolicy(undefined);
    if (bytes) decoded.set(bytes, policy);
    policies.set(value, policy);
  }
  const policy = requiredPolicy(root, base, tree, policies),
    receipts = readReviews(root),
    associated = new Set(finalizingTasks ?? pendingTasks(root, tip));
  for (const { contents, parents } of rows) {
    const parentTrees = parents.map((parent) => knownTrees.get(parent) ?? reviewTree(root, parent));
    const required = reviewContextPolicy(
      root,
      {
        base: parentTrees[0] ?? empty,
        tree: contents,
        ...(parentTrees.length > 1 ? { parentTrees } : {}),
      },
      policies,
    );
    policy.tasks ||= required.tasks;
    policy.task_approvals ||= required.task_approvals;
  }
  const taskReviews = receipts.filter((entry) => entry.kind === AgentReviewKind.Task),
    aggregate = taskReviews.filter((entry) => entry.tree === tree && entry.base === base),
    ancestors = new Set(git(root, ["log", "--format=%T", "--max-count=1001", tip]).split("\n")),
    selectedTasks = treeTasks(root, tree),
    snapshots = new Map<string, ReturnType<typeof treeTasks>>();
  const covers = (entry: AgentReview, reference: string) => {
    if (
      !entry.tasks.includes(reference) ||
      !ancestors.has(entry.tree) ||
      (!ancestors.has(entry.base) && entry.base !== base && entry.base !== emptyReviewTree(root))
    )
      return false;
    let snapshot = snapshots.get(entry.tree);
    if (!snapshot) {
      snapshot = treeTasks(root, entry.tree);
      snapshots.set(entry.tree, snapshot);
    }
    return snapshot.get(reference)?.workDigest === selectedTasks.get(reference)?.workDigest;
  };
  if (!finalizingTasks) for (const receipt of aggregate) for (const task of receipt.tasks) associated.add(task);
  const uncovered = [...associated].filter((reference) => !taskReviews.some((entry) => covers(entry, reference)));
  const wholeSnapshotReviewed = aggregate.some((entry) => !entry.tasks.length);
  if (policy.tasks && !wholeSnapshotReviewed && (!associated.size || uncovered.length))
    throw new InvalidInput(
      uncovered.length
        ? `Accumulated work review is required for ${uncovered.join(", ")}; review the delivered task and record workbench review task --base <start-revision> --record.`
        : "Accumulated work review is required for the outgoing snapshot. Record workbench review task --base <remote-or-start-revision> --record after reviewing the combined work; task records are optional.",
    );
  if (policy.task_approvals || finalizingTasks?.size)
    checkTaskDecisions(root, tree, true, [...associated], base, finalizingTasks);
}

/** Exact parent/tree evidence survives commit-ID rewrites, but never a changed project snapshot. */
export function checkAgentUnit(
  root: string,
  unit: Pick<ReturnType<typeof commitVersion>, "parents" | "tree">,
): string[] {
  const context = contextForParents(root, unit.tree, unit.parents);
  const key = changeContextKey(context);
  const policy = reviewContextPolicy(root, context);
  const matching = readReviews(root).filter(
    (entry) => entry.kind === AgentReviewKind.Changes && changeContextKey(entry) === key,
  );
  if (
    policy.changes &&
    !matching.length &&
    (context.parentTrees || !acceptedAgentContext(root, context.base, context.tree))
  )
    throw new InvalidInput(
      "Agent change review and verification are required for this commit; use workbench review changes --commit <revision> --record",
    );
  return [...new Set(matching.flatMap((entry) => entry.tasks))];
}

function retainedChangeContexts(root: string): Set<string> {
  return new Set(
    retainedProvisionalCommits(root).map((revision) => {
      const unit = commitVersion(root, revision);
      return changeContextKey(contextForParents(root, unit.tree, unit.parents));
    }),
  );
}
function prunePublishedReviews(root: string, remote: string): void {
  if (/^0+$/.test(remote)) return;
  const published = treeTasks(root, reviewTree(root, remote)),
    history = new Set(git(root, ["log", "--format=%T", "--max-count=4096", remote]).split("\n"));
  withCacheLocksSync([receiptPath(root)], () => {
    const state = store(root).read();
    state.reviews = state.reviews.filter((entry) => !history.has(entry.tree));
    const live = new Map(
      git(root, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"])
        .split("\n")
        .filter(Boolean)
        .map((row) => row.split(" ") as [string, string]),
    );
    if (workScope(root) === "detached") live.set("detached", git(root, ["rev-parse", "HEAD"]));
    state.pending = state.pending.filter((entry) => {
      const tip = live.get(entry.scope);
      return !!tip && !gitAncestor(root, tip, remote);
    });
    for (const pending of state.pending) {
      const selected = git(root, ["rev-parse", "--verify", `${live.get(pending.scope) ?? pending.tip}^{tree}`]),
        tasks = treeTasks(root, selected);
      pending.tasks = pending.tasks.filter(
        (reference) =>
          published.get(reference)?.status !== "Accepted" ||
          published.get(reference)?.workDigest !== tasks.get(reference)?.workDigest,
      );
    }
    state.pending = state.pending.filter((entry) => entry.tasks.length);
    store(root).write(state);
  });
}

export function remapAgentTasks(root: string, mapping: ReadonlyMap<string, string>, tip: string): void {
  withCacheLocksSync([receiptPath(root)], () => {
    const state = store(root).read(),
      selected = state.pending.find((entry) => entry.scope === workScope(root));
    if (!selected) return;
    selected.tasks = [...new Set(selected.tasks.map((reference) => mapping.get(reference) ?? reference))];
    selected.tip = tip;
    store(root).write(state);
  });
}

/** Discard only associations owned by this checkout branch after verified removal of its unpublished task history. */
export function discardAgentTasks(root: string, references: ReadonlySet<string>): void {
  const scope = workScope(root),
    tip = git(root, ["rev-parse", "HEAD"]);
  withCacheLocksSync([receiptPath(root)], () => {
    const state = store(root).read();
    state.pending = state.pending.flatMap((entry) => {
      if (entry.scope !== scope) return [entry];
      const tasks = entry.tasks.filter((reference) => !references.has(reference));
      return tasks.length ? [{ ...entry, tip, tasks }] : [];
    });
    store(root).write(state);
  });
}
