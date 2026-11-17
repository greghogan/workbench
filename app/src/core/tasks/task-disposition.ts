import { relative } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { BoundedState } from "../storage/bounded-state.js";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";
import { record, records, string } from "../runtime/values.mjs";
import { gitBytes, readGitTree, updatedReviewTree, writeReviewBlobs } from "../git/git-snapshot.js";
import { gitAncestor } from "../git/refs.js";
import { commitVersion } from "../review/review-units.js";
import { discardAgentTasks } from "../review/agent-review.js";
import { treeTasks } from "./task-snapshot.js";
import { repositoryStatePath, withRepositoryOperation } from "../git/repository-state.js";
import { publishGitTree, sameGitEntry, type TreeUpdate } from "../git/tree-publication.js";
import { projectedRecordMaps } from "../records/record-projection.js";
import { readTaskGraph } from "./task-model.js";
import { readTaskQueue, withTaskLock, writeTaskQueue, decodeQueue, type TaskQueueEntry } from "./task-queue.js";
import { appendTaskAccount } from "./task-plan.js";
import { replaceRecordStatus } from "../records/record-document.js";

export type TaskDispositionKind = "delete" | "revert";
const text = (root: string, args: string[], input?: string) => gitBytes(root, args, input).toString().trim();
function updatesBetween(root: string, before: string, after: string): TreeUpdate[] {
  const a = readGitTree(root, before),
    b = readGitTree(root, after);
  return [...new Set([...a.keys(), ...b.keys()])]
    .filter((path) => !sameGitEntry(a.get(path), b.get(path)))
    .map((path) => ({ path, before: a.get(path), after: b.get(path) }));
}
export function taskDisposition(root: string, reference: string, kind: TaskDispositionKind, reason = "") {
  const task = readTaskGraph(root).require(reference),
    head = text(root, ["rev-parse", "HEAD"]),
    branch = text(root, ["symbolic-ref", "--short", "HEAD"]),
    commits = text(root, [
      "log",
      "--first-parent",
      "--format=%H",
      "--diff-filter=AM",
      "HEAD",
      "--",
      relative(root, task.path).replaceAll("\\", "/"),
    ])
      .split("\n")
      .filter(Boolean),
    problems: string[] = [];
  if (task.archived) problems.push("Restore the archived task before changing its work");
  if (!commits.length) problems.push("No committed task work was found; remove the uncommitted files with your editor");
  if (commits.length > 1000) problems.push("Separate a smaller task history before changing it");
  const path = relative(root, task.path).replaceAll("\\", "/"),
    creation = commits.findIndex((revision) => {
      const parent = commitVersion(root, revision).parents[0];
      return !parent || !readGitTree(root, parent).has(path);
    });
  if (creation >= 0) commits.splice(creation + 1);
  if (kind === "revert" && !["Approved", "Accepted"].includes(task.metadata.status))
    problems.push("Reopen and approve the task before revising its implemented outcome");
  const units = commits.map((revision) => commitVersion(root, revision)),
    first = units.at(-1),
    base = first?.parents[0];
  if (!base) problems.push("Preserve the repository's initial commit");
  for (const unit of units) {
    if (unit.parents.length !== 1) {
      problems.push("Separate merge commits before changing task history");
      continue;
    }
    const current = treeTasks(root, unit.revision),
      previous = treeTasks(root, unit.parents[0] ?? ""),
      affected = new Set([...current.keys(), ...previous.keys()]);
    if (
      [...affected].some(
        (id) =>
          id !== reference &&
          (current.get(id)?.workDigest !== previous.get(id)?.workDigest ||
            current.get(id)?.mode !== previous.get(id)?.mode ||
            current.get(id)?.digest !== previous.get(id)?.digest),
      )
    )
      problems.push(`${unit.revision.slice(0, 12)} contains other task work; separate it first`);
  }
  const incoming = readTaskGraph(root).tasks.filter(
    (item) => item.parent === reference || item.dependencies.includes(reference),
  );
  if (kind === "delete" && incoming.length)
    problems.push(`Preserve incoming relationships first: ${incoming.map((item) => item.reference).join(", ")}`);
  if (kind === "delete" && base) {
    const suffix = text(root, ["rev-list", "--first-parent", head, "--not", base]).split("\n").filter(Boolean);
    if (suffix.length !== commits.length || suffix.some((revision, index) => revision !== commits[index]))
      problems.push("Deletion requires an unmixed task suffix; arrange the unpublished commits first");
    const remotes = text(root, ["for-each-ref", "--format=%(refname)", "refs/remotes"]).split("\n").filter(Boolean);
    if (commits.some((revision) => remotes.some((ref) => gitAncestor(root, revision, ref))))
      problems.push("Published task history must be preserved; use revert instead");
  }
  let tree =
    kind === "delete" && base
      ? text(root, ["rev-parse", `${base}^{tree}`])
      : text(root, ["rev-parse", `${head}^{tree}`]);
  if (kind === "revert" && !problems.length) {
    if (!reason.trim()) problems.push("Supply the reason for reverting this task");
    else {
      let selected = head;
      for (const unit of units) {
        const result = spawnSync(
          "git",
          ["-C", root, "merge-tree", "--write-tree", `--merge-base=${unit.revision}`, selected, unit.parents[0] ?? ""],
          {
            encoding: "utf8",
            maxBuffer: 4 * 1024 * 1024,
            env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" },
          },
        );
        if (result.error || result.status !== 0) {
          problems.push(
            `Git could not prepare inverse changes at ${unit.revision.slice(0, 12)}; inspect and resolve the work before reverting\n${result.error?.message ?? (result.stderr || result.stdout)}`,
          );
          break;
        }
        tree = result.stdout.split("\n")[0] ?? "";
        selected = text(root, ["commit-tree", tree, "-p", head, "-m", "Prepared task inverse"]);
      }
      if (!problems.length) {
        const entries = readGitTree(root, head),
          path = treeTasks(root, head).get(reference)?.path;
        if (!path) throw new StateConflict("Task disappeared from the selected history");
        const body = writeReviewBlobs(root, [
          Buffer.from(
            replaceRecordStatus(appendTaskAccount(task.contents, `### Reversion\n\n${reason.trim()}`), "Approved"),
          ),
        ])[0];
        if (!body) throw new StateConflict("Cannot prepare the task outcome");
        tree = updatedReviewTree(root, tree, [
          { path, entry: { mode: "100644", oid: body } },
          ...[...entries]
            .filter(([file]) => file.startsWith(path.slice(0, -3) + "/"))
            .map(([file, entry]) => ({ path: file, entry })),
        ]);
        const maps = projectedRecordMaps(root, tree),
          ids = writeReviewBlobs(root, [...maps.values()]);
        tree = updatedReviewTree(
          root,
          tree,
          [...maps.keys()].map((path, index) => ({ path, entry: { mode: "100644", oid: ids[index] ?? "" } })),
        );
      }
    }
  }
  const updates = updatesBetween(root, head, tree);
  if (
    updates.some((file) =>
      [file.before, file.after].some((entry) => entry && !["100644", "100755"].includes(entry.mode)),
    )
  )
    problems.push("This change includes symbolic links or submodules; separate it with Git before continuing");
  const entry = readTaskQueue(root).entries.find((entry) => entry.reference === reference),
    digest = createHash("sha256")
      .update(JSON.stringify([reference, kind, reason, branch, head, base, tree, commits, entry, problems]))
      .digest("hex");
  return {
    planDigest: task.planDigest,
    reference,
    kind,
    reason,
    branch,
    head,
    base,
    tree,
    commits,
    updates,
    problems: [...new Set(problems)],
    digest,
    entry,
  };
}
interface Disposition {
  version: 1;
  completed: boolean;
  checkout: string;
  branch: string;
  before: string;
  after: string;
  kind: TaskDispositionKind;
  reference: string;
  recovery: string;
  entry?: TaskQueueEntry;
  afterEntry?: TaskQueueEntry;
  updates: TreeUpdate[];
}
function store(root: string) {
  return new BoundedState<Disposition | undefined>(
    () => repositoryStatePath(root, "disposition-operation.json"),
    16 * 1024 * 1024,
    (input) => {
      if (input === undefined) return undefined;
      const data = record(input, "Invalid task disposition");
      if (
        data.version !== 1 ||
        typeof data.completed !== "boolean" ||
        !["delete", "revert"].includes(String(data.kind))
      )
        throw new InvalidInput("Invalid task disposition");
      const oid = (input: unknown) => {
          const value = string(input, "Missing disposition revision");
          if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)) throw new InvalidInput("Invalid disposition revision");
          return value;
        },
        entry = (input: unknown) => {
          if (input === undefined) return undefined;
          const value = record(input, "Invalid disposition file"),
            mode = string(value.mode, "Missing file mode");
          if (!["100644", "100755"].includes(mode)) throw new InvalidInput("Invalid disposition file mode");
          return { mode, oid: oid(value.oid) };
        };
      return {
        version: 1,
        completed: data.completed,
        kind: data.kind as TaskDispositionKind,
        checkout: string(data.checkout, "Missing disposition checkout"),
        branch: string(data.branch, "Missing disposition branch"),
        before: oid(data.before),
        after: oid(data.after),
        reference: string(data.reference, "Missing disposition task"),
        recovery: string(data.recovery, "Missing disposition recovery"),
        ...(data.entry === undefined
          ? {}
          : { entry: decodeQueue({ version: 1, revision: 0, entries: [data.entry] }).entries[0] }),
        ...(data.afterEntry === undefined
          ? {}
          : { afterEntry: decodeQueue({ version: 1, revision: 0, entries: [data.afterEntry] }).entries[0] }),
        updates: records(data.updates, "Missing disposition files").map((file) => ({
          path: string(file.path, "Missing disposition path"),
          before: entry(file.before),
          after: entry(file.after),
        })),
      };
    },
    () => undefined,
  );
}
export function applyTaskDisposition(
  root: string,
  options: { reference?: string; kind?: TaskDispositionKind; reason?: string; expected?: string; recover?: boolean },
): string {
  if (!options.recover && options.kind === "delete") {
    for (const remote of text(root, ["remote"]).split("\n").filter(Boolean))
      gitBytes(root, ["fetch", "--no-tags", remote, `+refs/heads/*:refs/remotes/${remote}/*`]);
  }
  return withRepositoryOperation(
    root,
    () =>
      withTaskLock(root, () => {
        let operation = store(root).read();
        if (operation && !operation.completed) {
          if (!options.recover) throw new StateConflict("Recover the pending task disposition before starting another");
        } else {
          if (options.recover) throw new InvalidInput("No task disposition requires recovery");
          if (!options.reference || !options.kind) throw new InvalidInput("Select a task and disposition");
          for (const path of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"])
            if (existsSync(text(root, ["rev-parse", "--path-format=absolute", "--git-path", path])))
              throw new StateConflict("Finish the active Git operation first");
          if (gitBytes(root, ["status", "--porcelain=v1", "--untracked-files=all"]).length)
            throw new StateConflict("Require a clean checkout before changing task work");
          const plan = taskDisposition(root, options.reference, options.kind, options.reason);
          if (plan.digest !== options.expected) throw new StateConflict("Task disposition changed; inspect it again");
          if (plan.problems.length) throw new StateConflict(plan.problems.join("\n"));
          const recovery = `refs/workbench/recovery/task-disposition/${randomUUID()}`,
            after =
              plan.kind === "delete"
                ? plan.base
                : text(root, ["commit-tree", plan.tree, "-p", plan.head, "-m", "Prepared task inverse"]);
          if (!after) throw new StateConflict("Missing task disposition baseline");
          gitBytes(
            root,
            ["update-ref", "--stdin"],
            `start\ncreate ${recovery}/before ${plan.head}\ncreate ${recovery}/prepared ${after}\nprepare\ncommit\n`,
          );
          operation = {
            version: 1,
            completed: false,
            checkout: root,
            branch: plan.branch,
            before: plan.head,
            after,
            kind: plan.kind,
            reference: plan.reference,
            recovery,
            updates: plan.updates,
            ...(plan.entry ? { entry: plan.entry } : {}),
            ...(plan.kind === "revert"
              ? {
                  afterEntry: {
                    reference: plan.reference,
                    state: "Blocked",
                    updated: new Date().toISOString(),
                    reason: "Inverse changes staged; review and verify the revised outcome",
                    planDigest: plan.planDigest,
                  },
                }
              : {}),
          };
          store(root).write(operation);
        }
        if (operation.checkout !== root) throw new StateConflict("Recover task disposition in its original checkout");
        const queue = readTaskQueue(root),
          entry = queue.entries.find((entry) => entry.reference === operation.reference);
        if (
          JSON.stringify(entry) !== JSON.stringify(operation.entry) &&
          JSON.stringify(entry) !== JSON.stringify(operation.afterEntry)
        )
          throw new StateConflict("Task execution changed; preserve its newer queue state before recovery");
        publishGitTree(root, operation.branch, operation.before, operation.after, operation.updates, {
          stageOnly: operation.kind === "revert",
        });
        const desired = operation.afterEntry;
        if (JSON.stringify(entry) !== JSON.stringify(desired)) {
          queue.entries = [
            ...queue.entries.filter((entry) => entry.reference !== operation.reference),
            ...(desired ? [desired] : []),
          ];
          queue.revision++;
          writeTaskQueue(root, queue);
        }
        if (operation.kind === "delete") discardAgentTasks(root, new Set([operation.reference]));
        operation.completed = true;
        store(root).write(operation);
        return operation.recovery;
      }),
    "disposition",
  );
}
