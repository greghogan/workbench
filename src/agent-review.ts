import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseToml } from "smol-toml";
import { BoundedState } from "./bounded-state.js";
import { withCacheLocksSync } from "./cache-lock.js";
import { gitBytes, workingReviewTree, readGitObjects } from "./git-snapshot.js";
import { record, records, string, strings } from "../scripts/values.mjs";
import { InvalidInput, StateConflict } from "./input-errors.js";
import { recordDocument } from "./record-document.js";
import { projectsFromData } from "./project-configuration.js";
import { taskDigest } from "./task-model.js";
import { readTaskQueue } from "./task-queue.js";
import { checkProvisionalPush } from "./commit-history.js";

export enum AgentReviewKind {
  Changes = "changes",
  Task = "task",
}
export interface AgentReview {
  kind: AgentReviewKind;
  base: string;
  tree: string;
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
export const reviewIdentity = (review: Pick<AgentReview, "kind" | "base" | "tree" | "tasks">) =>
  createHash("sha256")
    .update(JSON.stringify([review.kind, review.base, review.tree, [...review.tasks].sort()]))
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
function amendedBase(root: string): string {
  if (!hasHead(root)) return emptyReviewTree(root);
  const parent = git(root, ["rev-list", "--parents", "-n", "1", "HEAD"]).split(" ")[1];
  return parent ? reviewTree(root, parent) : emptyReviewTree(root);
}
export function proposedAgentReview(
  root: string,
  kind: AgentReviewKind,
  options: { base?: string; amend?: boolean; staged?: boolean; tasks?: string[] } = {},
): AgentReview {
  let base: string;
  if (options.base) base = reviewTree(root, options.base);
  else if (!hasHead(root)) base = emptyReviewTree(root);
  else if (options.amend) base = amendedBase(root);
  else if (kind === AgentReviewKind.Task)
    throw new InvalidInput("Task review requires --base naming the start of the accumulated work");
  else base = reviewTree(root, "HEAD");
  const tree = options.staged ? oid(git(root, ["write-tree"])) : workingReviewTree(root);
  const tasks = treeTasks(root, tree),
    previous = treeTasks(root, base);
  const inferred = [...tasks]
    .filter(
      ([reference, task]) =>
        ["Approved", "Accepted"].includes(task.status) && previous.get(reference)?.digest !== task.digest,
    )
    .map(([reference]) => reference);
  for (const entry of readTaskQueue(root).entries)
    if (["Active", "Implemented"].includes(entry.state) && tasks.get(entry.reference)?.status === "Approved")
      inferred.push(entry.reference);
  return {
    kind,
    base,
    tree,
    tasks: [
      ...new Set([...(options.tasks ?? []), ...inferred, ...(kind === AgentReviewKind.Task ? pendingTasks(root) : [])]),
    ].sort(),
    summary: "",
    verification: "",
    reviewed: new Date().toISOString(),
  };
}
function receiptPath(root: string): string {
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
  if (entries.length > 2) throw new InvalidInput("Agent review receipt limit exceeded");
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
    return { kind, base: oid(entry.base), tree: oid(entry.tree), tasks, summary, verification, reviewed };
  });
  if (new Set(reviews.map((entry) => entry.kind)).size !== reviews.length)
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
    256 * 1024,
    decode,
    () => ({ version: 3, reviews: [], pending: [] }),
  );
function readReviews(root: string): AgentReview[] {
  return store(root).read().reviews;
}
export function recordAgentReview(root: string, review: AgentReview, expected: string, staged = false): void {
  if (reviewIdentity(review) !== expected)
    throw new StateConflict("Review snapshot changed; inspect it again before recording review");
  const current = staged ? oid(git(root, ["write-tree"])) : workingReviewTree(root);
  if (current !== review.tree) throw new StateConflict("Review contents changed; review the new snapshot");
  const tasks = treeTasks(root, review.tree);
  for (const task of review.tasks)
    if (!tasks.has(task)) throw new InvalidInput(`Reviewed task not found in the selected snapshot: ${task}`);
  withCacheLocksSync([receiptPath(root)], () => {
    const state = store(root).read();
    const entries = state.reviews.filter((entry) => entry.kind !== review.kind);
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
  const committed = reviewTree(root, "HEAD"),
    tip = git(root, ["rev-parse", "HEAD"]),
    scope = workScope(root);
  withCacheLocksSync([receiptPath(root)], () => {
    const state = store(root).read();
    const consumed = state.reviews.filter(
      (entry) => entry.kind === AgentReviewKind.Changes && entry.tree === committed,
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
    state.reviews = state.reviews.filter((entry) => !consumed.includes(entry));
    store(root).write(state);
  });
}
export function reviewPolicy(root: string, tree: string): ReviewPolicy {
  return decodeReviewPolicy(
    readGitObjects(root, [`${tree}:workbench/config.toml`]).get(`${tree}:workbench/config.toml`),
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
interface SnapshotTask {
  path: string;
  status: string;
  digest: string;
}
export function treeTasks(root: string, tree: string): Map<string, SnapshotTask> {
  const paths = gitBytes(root, ["ls-tree", "-rz", "--name-only", tree]).toString().split("\0").filter(Boolean);
  if (!paths.includes("workbench/projects.toml")) return new Map();
  const projects = projectsFromData(
    parseToml(git(root, ["show", `${tree}:workbench/projects.toml`])),
    "workbench/projects.toml",
  );
  const taskPaths = paths.filter((path) => /(?:^|\/)workbench\/tasks\/TSK-[0-9A-Z]+\.md$/.test(path));
  const blobs = readGitObjects(
    root,
    taskPaths.map((path) => `${tree}:${path}`),
  );
  const result = new Map<string, SnapshotTask>();
  for (const project of projects) {
    const prefix = `${project.path === "." ? "" : project.path + "/"}workbench/tasks/`;
    for (const path of taskPaths) {
      if (!path.startsWith(prefix) || !/^TSK-[0-9A-Z]+\.md$/.test(path.slice(prefix.length))) continue;
      const contents = blobs.get(`${tree}:${path}`)?.toString();
      if (contents === undefined) throw new InvalidInput(`Missing task: ${path}`);
      const number = path.slice(prefix.length + 4, -3).replace(/^0+(?=.)/, "");
      result.set(`${project.id}:TSK-${number}`, {
        path,
        status: recordDocument("TSK", contents, path).metadata.status,
        digest: taskDigest(contents),
      });
    }
  }
  return result;
}
export function checkAgentCommit(root: string, tree?: string): void {
  const selected = tree ?? oid(git(root, ["write-tree"]));
  const base = hasHead(root) ? reviewTree(root, "HEAD") : emptyReviewTree(root);
  const policy = requiredPolicy(root, base, selected);
  if (!policy.changes && !policy.task_approvals) return;
  let associated: string[] = [];
  if (policy.changes) {
    const bases = new Set([base, amendedBase(root)]);
    const matched = readReviews(root).filter(
      (entry) => entry.kind === AgentReviewKind.Changes && entry.tree === selected && bases.has(entry.base),
    );
    if (!matched.length)
      throw new InvalidInput(
        "Change review is required for this staged snapshot. Complete the review, then record it with 'workbench review changes --record'.",
      );
    associated = [...new Set(matched.flatMap((entry) => entry.tasks))];
  }
  if (policy.task_approvals) checkTaskDecisions(root, selected, false, associated, base);
}

function checkTaskDecisions(
  root: string,
  tree: string,
  publishing: boolean,
  associated: string[] = [],
  baseline?: string,
): void {
  const previous = baseline ? treeTasks(root, baseline) : new Map<string, SnapshotTask>();
  const tasks = treeTasks(root, tree),
    decisions = readTaskQueue(root).decisions ?? [];
  for (const reference of associated)
    if (!tasks.has(reference))
      throw new InvalidInput(`${reference}: associated task is missing from the reviewed snapshot.`);
  for (const [reference, task] of tasks) {
    if (
      !associated.includes(reference) &&
      (previous.get(reference)?.digest === task.digest || !["Approved", "Accepted"].includes(task.status))
    )
      continue;
    if (publishing && associated.includes(reference) && task.status !== "Accepted")
      throw new InvalidInput(`${reference}: human acceptance is required before publishing associated implementation.`);
    if (associated.includes(reference) && !["Approved", "Accepted"].includes(task.status))
      throw new InvalidInput(`${reference}: approve the plan before committing associated implementation.`);
    if (task.status === "Planned" || task.status === "Canceled") continue;
    if (
      !["Approved", "Accepted"].includes(previous.get(reference)?.status ?? "") &&
      !decisions.some((decision) => decision.reference === reference && decision.status === "Approved")
    )
      throw new InvalidInput(
        `${reference}: human plan approval is required; use 'workbench task approve' or the task page.`,
      );
    if (task.status === "Accepted" || publishing) {
      if (task.status !== "Accepted")
        throw new InvalidInput(`${reference}: human acceptance is required before publishing implementation.`);
      if (
        !decisions.some(
          (decision) =>
            decision.reference === reference &&
            decision.status === "Accepted" &&
            decision.digest === task.digest &&
            (!publishing || decision.tree === tree),
        )
      )
        throw new InvalidInput(
          `${reference}: human acceptance does not cover this project snapshot; accept the current result before publishing.`,
        );
    }
  }
}
export function checkAgentPush(root: string, tip: string, remote: string): void {
  checkProvisionalPush(root, tip, remote);
  const policies = new Map<string, ReviewPolicy>();
  const tree = reviewTree(root, tip),
    base = /^0+$/.test(remote) ? emptyReviewTree(root) : reviewTree(root, remote);
  const rows = git(root, [
    "log",
    "--format=%H %T %P",
    tip,
    ...(/^0+$/.test(remote) ? ["--not", "--remotes"] : ["--not", remote]),
  ])
    .split("\n")
    .filter(Boolean)
    .map((row) => {
      const [commit, contents, parent] = row.split(" ");
      if (!commit || !contents) throw new InvalidInput("Invalid outgoing Git history");
      return { commit, contents: oid(contents), parent };
    });
  const liveRefs = new Map(
    git(root, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"])
      .split("\n")
      .filter(Boolean)
      .map((row) => row.split(" ")) as [string, string][],
  );
  if (workScope(root) === "detached") liveRefs.set("detached", git(root, ["rev-parse", "HEAD"]));
  withCacheLocksSync([receiptPath(root)], () => {
    const state = store(root).read();
    state.reviews = state.reviews.filter((entry) => entry.kind !== AgentReviewKind.Task || entry.tree !== base);
    if (!/^0+$/.test(remote))
      state.pending = state.pending.filter(
        (entry) =>
          spawnSync(
            "git",
            ["-C", root, "merge-base", "--is-ancestor", liveRefs.get(entry.scope) ?? entry.tip, remote],
            { stdio: "ignore" },
          ).status !== 0,
      );
    store(root).write(state);
  });
  if (!rows.length) return;
  const knownTrees = new Map(rows.map((row) => [row.commit, row.contents]));
  const policyTrees = [
    ...new Set([
      base,
      tree,
      ...rows.flatMap((row) => [
        row.contents,
        ...(row.parent ? [knownTrees.get(row.parent) ?? reviewTree(root, row.parent)] : []),
      ]),
    ]),
  ];
  const policyObjects = readGitObjects(
    root,
    policyTrees.map((value) => `${value}:workbench/config.toml`),
  );
  const decoded = new Map<Buffer, ReviewPolicy>();
  for (const value of policyTrees) {
    const bytes = policyObjects.get(`${value}:workbench/config.toml`);
    const policy = bytes ? (decoded.get(bytes) ?? decodeReviewPolicy(bytes)) : decodeReviewPolicy(undefined);
    if (bytes) decoded.set(bytes, policy);
    policies.set(value, policy);
  }
  const policy = requiredPolicy(root, base, tree, policies),
    receipts = readReviews(root),
    associated = new Set<string>(pendingTasks(root, tip));
  for (const { contents, parent } of rows) {
    const before = parent ? (knownTrees.get(parent) ?? reviewTree(root, parent)) : emptyReviewTree(root);
    if (parent) knownTrees.set(parent, before);
    const required = requiredPolicy(root, before, contents, policies);
    policy.tasks ||= required.tasks;
    policy.task_approvals ||= required.task_approvals;
  }
  const taskReviews = receipts.filter(
    (entry) => entry.kind === AgentReviewKind.Task && entry.tree === tree && entry.base === base,
  );
  if (policy.tasks && !taskReviews.length)
    throw new InvalidInput(
      "Accumulated task review is required for the outgoing snapshot. Record 'workbench review task --base <remote-or-start-revision> --record' after reviewing the combined work.",
    );
  for (const receipt of taskReviews) for (const task of receipt.tasks) associated.add(task);
  if (policy.task_approvals) checkTaskDecisions(root, tree, true, [...associated], base);
}
