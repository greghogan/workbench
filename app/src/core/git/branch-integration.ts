import { includesPlanningHistory } from "../tasks/planning/planning-publication.js";
import { prepareIntegrationReview } from "./integration-review.js";
import { reconcileTaskIdentities } from "./identity-reconciliation.js";
import { ArchiveUnavailable } from "../records/archive-index.js";
import { gitRevision, validateBranch } from "./refs.js";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { parse } from "smol-toml";
import { BoundedState } from "../storage/bounded-state.js";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";
import { record, string } from "../runtime/values.mjs";
import { editToml } from "../configuration/toml-edit.js";
import { projectPaths } from "../projects/project-paths.js";
import { archivedScopeRecords, logicalRecordEntries, readArchiveIndex } from "../records/archive-store.js";
import { projectedRecordMaps } from "../records/record-projection.js";
import { validateRelationships } from "../records/records.js";
import { gitBytes, readGitObjects, readGitTree, updatedReviewTree, writeReviewBlobs } from "./git-snapshot.js";
import { repositoryStatePath, withRepositoryOperation } from "./repository-state.js";
import { integrationTarget } from "./integration-target.js";
import { provisionalMessage, provisionalTrailer } from "./commit-history.js";
import { publishGitTree, sameGitEntry, type TreeUpdate } from "./tree-publication.js";

export type IntegrationKind = "rebase" | "merge";
interface Reconciliation {
  before: string;
  after: string;
  updates: TreeUpdate[];
}
export interface BranchIntegration {
  version: 1;
  id: string;
  kind: IntegrationKind;
  checkout: string;
  branch: string;
  before: string;
  target: string;
  recovery: string;
  result?: string;
  reconciliation?: Reconciliation;
  reviewHistory?: { before: string; after: string };
  identities?: { before: string; after: string };
  completed: boolean;
}
const validOid = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const oid = (value: unknown): string => {
  const result = string(value, "Invalid Git revision");
  if (!validOid(result)) throw new InvalidInput("Invalid Git revision");
  return result;
};
function store(root: string) {
  return new BoundedState<BranchIntegration | undefined>(
    () => repositoryStatePath(root, "integration-operation.json"),
    4 * 1024 * 1024,
    (value) => {
      if (value === undefined) return undefined;
      const data = record(value, "Invalid integration recovery state");
      if (
        data.version !== 1 ||
        (data.kind !== "rebase" && data.kind !== "merge") ||
        typeof data.completed !== "boolean"
      )
        throw new InvalidInput("Invalid integration recovery state");
      const id = string(data.id, "Invalid integration ID");
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)) throw new InvalidInput("Invalid integration ID");
      const branch = string(data.branch, "Invalid integration branch");
      validateBranch(root, branch);
      const result: BranchIntegration = {
        version: 1,
        id,
        kind: data.kind,
        checkout: string(data.checkout, "Invalid checkout"),
        branch,
        before: oid(data.before),
        target: oid(data.target),
        recovery: `refs/workbench/recovery/${id}/before`,
        completed: data.completed,
        ...(data.result === undefined ? {} : { result: oid(data.result) }),
      };
      if (data.identities !== undefined) {
        const prepared = record(data.identities, "Invalid integration identities");
        result.identities = { before: oid(prepared.before), after: oid(prepared.after) };
      }
      if (data.reviewHistory !== undefined) {
        const prepared = record(data.reviewHistory, "Invalid integration review history");
        result.reviewHistory = { before: oid(prepared.before), after: oid(prepared.after) };
      }
      if (data.reconciliation !== undefined) {
        const reconciliation = record(data.reconciliation, "Invalid reconciliation");
        if (!Array.isArray(reconciliation.updates)) throw new InvalidInput("Invalid reconciliation updates");
        result.reconciliation = {
          before: oid(reconciliation.before),
          after: oid(reconciliation.after),
          updates: reconciliation.updates.map((value: unknown) => {
            const file = record(value, "Invalid reconciliation file"),
              path = string(file.path, "Invalid reconciliation path");
            if (path !== projectPaths.state && !/^(?:.*\/)?workbench\/(?:task|experiment)-map\.md$/.test(path))
              throw new InvalidInput("Unexpected archive reconciliation path");
            const entry = (value: unknown) => {
              if (value === undefined) return undefined;
              const data = record(value, "Invalid reconciliation entry");
              if (data.mode !== "100644" && data.mode !== "100755")
                throw new InvalidInput("Invalid reconciliation mode");
              return { mode: data.mode, oid: oid(data.oid) };
            };
            return { path, before: entry(file.before), after: entry(file.after) };
          }),
        };
      }
      return result;
    },
    () => undefined,
  );
}
export const branchIntegration = (root: string): BranchIntegration | undefined => store(root).read();
function gitPath(root: string, path: string): string {
  return gitBytes(root, ["rev-parse", "--path-format=absolute", "--git-path", path]).toString().trim();
}
function activeGitOperation(root: string): IntegrationKind | "other" | undefined {
  if (existsSync(gitPath(root, "rebase-merge")) || existsSync(gitPath(root, "rebase-apply"))) return "rebase";
  if (existsSync(gitPath(root, "MERGE_HEAD"))) return "merge";
  if (["CHERRY_PICK_HEAD", "REVERT_HEAD"].some((path) => existsSync(gitPath(root, path)))) return "other";
  return undefined;
}
function clean(root: string): void {
  if (gitBytes(root, ["status", "--porcelain=v1", "--untracked-files=all"]).length)
    throw new StateConflict(
      "Require a clean index and working tree, including untracked files; commit or set aside changes first",
    );
}
function branch(root: string): string {
  return gitBytes(root, ["symbolic-ref", "--short", "HEAD"]).toString().trim();
}
function head(root: string): string {
  return gitBytes(root, ["rev-parse", "HEAD"]).toString().trim();
}
function resolveTarget(root: string, kind: IntegrationKind, target?: string): string {
  if (target && (target.startsWith("-") || /[\0\r\n]/.test(target)))
    throw new InvalidInput("Invalid integration target");
  let reference = target;
  if (!reference) {
    if (kind !== "rebase") throw new InvalidInput("Specify the branch or revision to merge");
    const selected = integrationTarget(root);
    if (selected.remote) {
      gitBytes(root, ["fetch", "--no-tags", selected.remote, `refs/heads/${selected.branch}`]);
      reference = "FETCH_HEAD";
    } else reference = selected.branch;
  } else {
    const remotes = gitBytes(root, ["remote"])
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    const remote = remotes.find((remote) => reference?.startsWith(remote + "/"));
    if (remote) {
      gitBytes(root, ["fetch", "--no-tags", remote, `refs/heads/${reference.slice(remote.length + 1)}`]);
      reference = "FETCH_HEAD";
    }
  }
  return gitBytes(root, ["rev-parse", "--verify", `${reference}^{commit}`])
    .toString()
    .trim();
}
function archiveAt(root: string, commit: string): string | undefined {
  const entry = readGitTree(root, commit).get(projectPaths.state);
  if (!entry) return undefined;
  const bytes = readGitObjects(root, [entry.oid]).get(entry.oid);
  if (!bytes) throw new InvalidInput("Missing integration project state");
  const revision = record(parse(bytes.toString()).archive ?? {}, "Invalid archive state").revision;
  return revision === undefined ? undefined : oid(revision);
}
function reconcile(root: string, operation: BranchIntegration): void {
  if (operation.reconciliation) {
    const saved = operation.reconciliation;
    publishGitTree(root, operation.branch, saved.before, saved.after, saved.updates);
  }
  clean(root);
  const current = head(root),
    live = readGitTree(root, current),
    logical = logicalRecordEntries(root, live);
  const revisions = [
    ...new Set(
      [archiveAt(root, operation.before), archiveAt(root, operation.target), archiveAt(root, current)].filter(
        (value): value is string => !!value,
      ),
    ),
  ];
  const required = new Map<string, { mode: string; oid: string }>();
  for (const revision of revisions)
    for (const [path, entry] of readArchiveIndex(root, revision).files) {
      const prior = required.get(path);
      if (prior && !sameGitEntry(prior, entry))
        throw new StateConflict(
          `Archived versions conflict: ${path}. Preserve both histories and restore the record for resolution before continuing.`,
        );
      required.set(path, entry);
    }
  const missing = [...required].filter(([path]) => !logical.has(path));
  if (missing.length) {
    const selected = revisions.find((revision) => {
      const files = readArchiveIndex(root, revision).files;
      return [...required].every(([path, entry]) => sameGitEntry(files.get(path), entry) || live.has(path));
    });
    if (!selected)
      throw new StateConflict(
        "Archive histories require explicit reconciliation; no pinned revision retains all records. Restore the affected records before continuing.",
      );
    const configEntry = live.get(projectPaths.config),
      configBytes = configEntry ? readGitObjects(root, [configEntry.oid]).get(configEntry.oid) : undefined;
    if (
      !configBytes ||
      !record(parse(configBytes.toString()).records ?? {}, "Invalid record configuration").archive_branch
    )
      throw new StateConflict("Archival is disabled in the result; restore the missing records before continuing");
    const stateEntry = live.get(projectPaths.state),
      original = stateEntry ? (readGitObjects(root, [stateEntry.oid]).get(stateEntry.oid)?.toString() ?? "") : "";
    const state = parse(original);
    state.archive = { ...record(state.archive ?? {}, "Invalid archive state"), revision: selected };
    const bodies = new Map<string, Buffer>([[projectPaths.state, Buffer.from(editToml(original, state))]]),
      stateOid = writeReviewBlobs(root, [bodies.get(projectPaths.state) ?? Buffer.alloc(0)])[0];
    if (!stateOid) throw new Error("Missing reconciled state object");
    const projected = updatedReviewTree(root, current, [
      { path: projectPaths.state, entry: { mode: "100644", oid: stateOid } },
    ]);
    for (const [path, body] of projectedRecordMaps(root, projected)) bodies.set(path, body);
    const ids = writeReviewBlobs(root, [...bodies.values()]);
    const updates: TreeUpdate[] = [...bodies.keys()]
      .map((path, index) => ({ path, before: live.get(path), after: { mode: "100644", oid: ids[index] ?? "" } }))
      .filter((file) => !sameGitEntry(file.before, file.after));
    const tree = updatedReviewTree(
      root,
      current,
      updates.map((file) => ({ path: file.path, entry: file.after ?? { mode: "0", oid: "0".repeat(current.length) } })),
    );
    logicalRecordEntries(root, readGitTree(root, tree));
    const provisional = provisionalMessage(root, gitBytes(root, ["log", "-1", "--format=%B", current]).toString());
    const after = gitBytes(root, [
      "commit-tree",
      tree,
      "-p",
      current,
      "-m",
      "chore: reconcile record archive references" + (provisional ? `\n\n${provisionalTrailer}: true` : ""),
    ])
      .toString()
      .trim();
    gitBytes(root, ["update-ref", `refs/workbench/recovery/${operation.id}/reconciliation`, after]);
    operation.reconciliation = { before: current, after, updates };
    store(root).write(operation);
    publishGitTree(root, operation.branch, current, after, updates);
  }
  const final = logicalRecordEntries(root, readGitTree(root, "HEAD"));
  for (const path of required.keys())
    if (!final.has(path)) throw new StateConflict(`Integration lost archived record material: ${path}`);
  archivedScopeRecords(root);
  const errors = validateRelationships(root);
  if (errors.length) throw new InvalidInput(errors.join("\n"));
}
function runGit(root: string, kind: IntegrationKind, args: string[]): void {
  const result = spawnSync(
    "git",
    ["-C", root, "-c", "rerere.autoupdate=false", "-c", "commit.gpgSign=false", kind, ...args],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_EDITOR: "true" },
    },
  );
  if (result.error || result.status !== 0)
    throw new StateConflict(
      `${kind} stopped. Resolve conflicts and run 'workbench ${kind} --continue', or use --abort.\n${result.stderr || result.stdout}`,
      { cause: result.error },
    );
}
export function integrateBranch(
  root: string,
  kind: IntegrationKind,
  options: { target?: string; action?: "continue" | "abort" } = {},
): BranchIntegration {
  return withRepositoryOperation(
    root,
    () => {
      let operation = branchIntegration(root);
      if (options.action) {
        if (!operation || operation.completed || operation.kind !== kind || operation.checkout !== root)
          throw new InvalidInput(`No ${kind} operation is pending in this checkout`);
      } else {
        if (operation && !operation.completed)
          throw new StateConflict(`An integration requires recovery in ${operation.checkout}`);
        if (activeGitOperation(root))
          throw new StateConflict("A Git operation is already in progress; preserve and finish it first");
        clean(root);
        const selectedBranch = branch(root),
          before = head(root),
          target = resolveTarget(root, kind, options.target),
          id = randomUUID();
        if (includesPlanningHistory(root, before) || includesPlanningHistory(root, target))
          throw new InvalidInput(
            "Planning history stays outside implementation ancestry; transfer selected plans through the task queue",
          );
        try {
          for (const revision of [archiveAt(root, before), archiveAt(root, target)])
            if (revision) readArchiveIndex(root, revision);
        } catch (error) {
          if (error instanceof ArchiveUnavailable)
            throw new StateConflict(
              `Acquire the required archive, then retry:\nworkbench record archive fetch --from ${target}`,
              { cause: error },
            );
          throw error;
        }
        operation = {
          version: 1,
          id,
          kind,
          checkout: root,
          branch: selectedBranch,
          before,
          target,
          recovery: `refs/workbench/recovery/${id}/before`,
          completed: false,
        };
        gitBytes(
          root,
          ["update-ref", "--stdin"],
          `start\ncreate ${operation.recovery} ${before}\ncreate refs/workbench/recovery/${id}/target ${target}\nprepare\ncommit\n`,
        );
        store(root).write(operation);
      }
      const active = activeGitOperation(root);
      if (active && active !== kind)
        throw new StateConflict("A different Git operation is in progress; preserve it before continuing");
      if (active && gitBytes(root, ["rev-parse", "ORIG_HEAD"]).toString().trim() !== operation.before)
        throw new StateConflict(
          "The active Git operation differs from the recorded integration; preserve it before recovery",
        );
      if (options.action === "abort") {
        if (active) runGit(root, kind, ["--abort"]);
        else {
          if (branch(root) !== operation.branch)
            throw new StateConflict("Return to the original branch before aborting");
          clean(root);
          const ref = `refs/workbench/recovery/${operation.id}/aborted-result`,
            retained = gitRevision(root, ref),
            actual = head(root);
          if (retained && actual !== retained && actual !== operation.before)
            throw new StateConflict(
              "The branch changed during abortion; preserve the retained and current work before recovery",
            );
          const aborted = retained ?? actual;
          if (!retained) gitBytes(root, ["update-ref", ref, aborted, "0".repeat(aborted.length)]);
          operation.result = aborted;
          store(root).write(operation);
          gitBytes(root, ["reset", "--hard", operation.before]);
          if (operation.identities)
            reconcileTaskIdentities(root, operation.identities.after, operation.before, { allowMissing: true });
        }
        operation.completed = true;
        store(root).write(operation);
        return operation;
      }
      if (active) runGit(root, kind, ["--continue"]);
      else if (!operation.result && head(root) === operation.before) {
        runGit(
          root,
          kind,
          kind === "rebase"
            ? ["--no-autostash", "--no-update-refs", "--rebase-merges", operation.target]
            : ["--no-edit", "--no-autostash", operation.target],
        );
      }
      if (branch(root) !== operation.branch) throw new StateConflict("Return to the original branch before continuing");
      operation.result = head(root);
      store(root).write(operation);
      reconcile(root, operation);
      operation.identities = { before: operation.before, after: head(root) };
      store(root).write(operation);
      reconcileTaskIdentities(root, operation.before, head(root));
      prepareIntegrationReview(root, operation, () => {
        store(root).write(operation);
      });
      operation.result = head(root);
      operation.completed = true;
      store(root).write(operation);
      return operation;
    },
    "integration",
  );
}
