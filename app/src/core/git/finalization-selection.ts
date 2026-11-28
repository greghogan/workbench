import { spawnSync } from "node:child_process";
import { gitBytes } from "./git-snapshot.js";
import { gitAncestor } from "./refs.js";
import { checkAgentPublication, checkAgentUnit, reviewTree } from "../review/agent-review.js";
import type { pendingCommitReviews } from "../review/review-units.js";
import { treeTasks } from "../tasks/task-snapshot.js";
import { InvalidInput } from "../runtime/input-errors.js";

type Unit = ReturnType<typeof pendingCommitReviews>[number];
type Commit = Pick<Unit, "revision" | "tree" | "parents">;
const maximumHistory = 1000;
const text = (root: string, args: string[]) => gitBytes(root, args).toString().trim();
const explanation = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Include unchanged bridges between provisional commits and all descendants that may need new parent IDs. */
export function finalizationHistory(root: string, tips: string[], seeds: readonly Commit[]) {
  const ids = new Set(seeds.map((commit) => commit.revision)),
    edges = [...new Set(seeds.flatMap((commit) => commit.parents.filter((parent) => !ids.has(parent))))],
    boundaries = edges.filter((parent) => !seeds.some((commit) => gitAncestor(root, commit.revision, parent))),
    rows = text(root, [
      "log",
      "--no-show-signature",
      "--reverse",
      "--topo-order",
      `--max-count=${String(maximumHistory + 1)}`,
      "--format=%H %T %P",
      ...tips,
      ...(boundaries.length ? ["--not", ...boundaries] : []),
    ])
      .split("\n")
      .filter(Boolean);
  if (rows.length > maximumHistory) throw new InvalidInput("Finalization exceeds 1000 retained commits");
  const history = rows.map((row): Commit => {
    const [revision, tree, ...parents] = row.trim().split(" ");
    if (!revision || !tree) throw new InvalidInput("Invalid retained Git history");
    return { revision, tree, parents };
  });
  return { history, boundaries: new Set(boundaries) };
}

function reviewBase(root: string, frontier: ReadonlySet<string>, length: number): string {
  if (!frontier.size) return "0".repeat(length);
  if (frontier.size === 1) return [...frontier][0] ?? "0".repeat(length);
  const result = spawnSync("git", ["-C", root, "merge-base", "--octopus", ...frontier], {
    encoding: "utf8",
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" },
  });
  if (result.error || (result.status !== 0 && result.status !== 1))
    throw new InvalidInput("Cannot determine the base of the retained review", {
      cause: result.error ?? new Error(result.stderr),
    });
  return result.status === 0 ? result.stdout.trim() : "0".repeat(length);
}

/** A retained result authorizes the complete reviewed ancestry it contains, including both sides of a task. */
export function selectFinalization(root: string, tip: string, units: Unit[]) {
  const selected = new Set<string>(),
    problems = new Map<string, string>();
  if (!units.length) return { selected, problems };
  const { history, boundaries } = finalizationHistory(root, [tip], units),
    byRevision = new Map(history.map((entry) => [entry.revision, entry])),
    scopes = new Map<string, string[]>(),
    groups = new Map<string, Set<string>>(),
    snapshots = new Map<string, ReturnType<typeof treeTasks>>();
  const tasksAt = (tree: string) => {
    const cached = snapshots.get(tree);
    if (cached) return cached;
    const snapshot = treeTasks(root, tree);
    snapshots.set(tree, snapshot);
    return snapshot;
  };
  const tasksAtParents = ({ parents }: Commit) =>
    parents.map((parent) => tasksAt(byRevision.get(parent)?.tree ?? reviewTree(root, parent)));
  for (const unit of units) {
    const issues: string[] = [],
      parentTasks = tasksAtParents(unit),
      owners = new Set<string>();
    for (const [reference, task] of tasksAt(unit.tree)) {
      if (
        (task.status === "Approved" || task.status === "Accepted") &&
        parentTasks.every((snapshot) => {
          const previous = snapshot.get(reference);
          return previous?.digest !== task.digest || previous.workDigest !== task.workDigest;
        })
      )
        owners.add(reference);
    }
    if (unit.pending) issues.push(`${String(unit.pending)} protected file(s) need human review`);
    try {
      for (const reference of checkAgentUnit(root, unit)) owners.add(reference);
    } catch (error) {
      issues.push(explanation(error));
    }
    const published = text(root, ["for-each-ref", "--format=%(refname)", "--contains", unit.revision, "refs/remotes"]);
    if (published) issues.push(`Preserve published history reachable through ${published.split("\n").join(", ")}`);
    if (issues.length) problems.set(unit.revision, issues.join("\n"));
    scopes.set(unit.revision, [...owners]);
    for (const owner of owners) {
      const group = groups.get(owner) ?? new Set<string>();
      group.add(unit.revision);
      groups.set(owner, group);
    }
  }

  // A task's later delivery can include ordinary commits. An older accepted version does not cover that added work.
  if (groups.size)
    for (const commit of history) {
      if (scopes.has(commit.revision)) continue;
      const current = tasksAt(commit.tree),
        parents = tasksAtParents(commit);
      for (const [reference, group] of groups) {
        const work = current.get(reference)?.workDigest;
        if (
          (work !== undefined || parents.length) &&
          parents.every((parent) => parent.get(reference)?.workDigest !== work)
        )
          group.add(commit.revision);
      }
    }

  // Test the largest possible retained result first. If a later result is blocked, its prerequisites are still candidates.
  const delivery = new Set([...groups.values()].flatMap((group) => [...group]));
  const ancestry = new Map<string, { units: Set<string>; deliveries: Set<string>; frontier: Set<string> }>();
  for (const commit of history) {
    const preceding = commit.parents.flatMap((parent) => ancestry.get(parent) ?? []);
    const members = new Set(preceding.flatMap((parent) => [...parent.units]));
    const deliveries = new Set(preceding.flatMap((parent) => [...parent.deliveries]));
    const frontier = new Set(preceding.flatMap((parent) => [...parent.frontier]));
    if (scopes.has(commit.revision)) members.add(commit.revision);
    if (delivery.has(commit.revision)) deliveries.add(commit.revision);
    for (const parent of commit.parents) if (boundaries.has(parent)) frontier.add(parent);
    ancestry.set(commit.revision, { units: members, deliveries, frontier });
  }
  const failures = new Map<string, string>();
  for (const [revision, { units: members, deliveries, frontier }] of [...ancestry].reverse()) {
    const remaining = [...members].filter((id) => !selected.has(id));
    if (!remaining.length || [...members].some((id) => problems.has(id))) continue;
    const owners = new Set([...members].flatMap((id) => scopes.get(id) ?? []));
    const partial = [...owners].find((owner) => [...(groups.get(owner) ?? [])].some((id) => !deliveries.has(id)));
    try {
      if (partial) throw new InvalidInput(`${partial}: wait for the complete accepted delivery`);
      checkAgentPublication(root, revision, reviewBase(root, frontier, revision.length), owners);
      for (const id of remaining) selected.add(id);
    } catch (error) {
      for (const id of remaining) if (!failures.has(id)) failures.set(id, explanation(error));
    }
  }
  for (const unit of units)
    if (!selected.has(unit.revision) && !problems.has(unit.revision))
      problems.set(unit.revision, failures.get(unit.revision) ?? "Earlier provisional work is awaiting review");
  return { selected, problems };
}
