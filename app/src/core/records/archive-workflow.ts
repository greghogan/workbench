import { validateBranch } from "../git/refs.js";
import { archivedKinds } from "./archive-index.js";
import { publishGitTree } from "../git/tree-publication.js";
import { projectedRecordMaps } from "./record-projection.js";
import { provisionalMessage, provisionalTrailer } from "../git/commit-history.js";
import { verifyArchiveTransfer } from "./archive-transfer-proof.js";
import { existsSync, lstatSync, readFileSync, readdirSync, rmdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { parse } from "smol-toml";
import {
  gitBytes,
  readGitTree,
  GitSnapshot,
  readGitObjects,
  updatedReviewTree,
  writeReviewBlobs,
  type GitEntry,
} from "../git/git-snapshot.js";
import { integrationTarget } from "../git/integration-target.js";
import { acquireArchiveBranch, allowArchiveAdvance, protectArchiveBranch } from "../git/archive-protection.js";
import { repositoryStatePath, withRepositoryOperation } from "../git/repository-state.js";
import { readConfig, projectsFromData } from "../projects/project-configuration.js";
import { projectPaths } from "../projects/project-paths.js";
import { withProjectStateLock } from "../projects/project-state.js";
import { editToml } from "../configuration/toml-edit.js";
import { writeAtomic } from "../runtime/file-publication.mjs";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";
import { ownedPath } from "../runtime/paths.js";
import { record, string } from "../runtime/values.mjs";
import { BoundedState } from "../storage/bounded-state.js";
import { archiveRevision, readArchiveIndex, verifyArchiveHistory } from "./archive-store.js";
import { archiveGroups, type ArchiveCandidate, type ArchiveGroup } from "./archive-groups.js";
import { normalizedNumber, relativeRecordPath } from "./record-identity.js";

type TransferKind = "archive" | "restore";
interface TransferFile {
  path: string;
  before?: GitEntry | undefined;
  after?: GitEntry | undefined;
}
export interface ArchiveOperation {
  version: 1;
  id: string;
  kind: TransferKind;
  checkout: string;
  branch: string;
  archiveBranch: string;
  before: string;
  after: string;
  archiveBefore?: string;
  archiveAfter: string;
  files: TransferFile[];
  completed: boolean;
}
const objectId = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
function entry(value: unknown): GitEntry | undefined {
  if (value === undefined) return undefined;
  const data = record(value, "Invalid transfer entry");
  const mode = string(data.mode, "Invalid transfer mode"),
    oid = string(data.oid, "Invalid transfer object");
  if (!objectId(oid) || !["100644", "100755"].includes(mode)) throw new InvalidInput("Invalid transfer entry");
  return { mode, oid };
}
function operationStore(root: string) {
  return new BoundedState<ArchiveOperation | undefined>(
    () => repositoryStatePath(root, "archive-operation.json"),
    16 * 1024 * 1024,
    (value) => {
      if (value === undefined) return undefined;
      const data = record(value, "Invalid archive recovery state");
      if (
        data.version !== 1 ||
        typeof data.id !== "string" ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(data.id) ||
        !["archive", "restore"].includes(String(data.kind)) ||
        typeof data.completed !== "boolean" ||
        !Array.isArray(data.files)
      )
        throw new InvalidInput("Invalid archive recovery state");
      const result: ArchiveOperation = {
        version: 1,
        id: string(data.id, "Invalid operation ID"),
        kind: data.kind as TransferKind,
        checkout: string(data.checkout, "Invalid checkout"),
        branch: string(data.branch, "Invalid integration branch"),
        archiveBranch: string(data.archiveBranch, "Invalid archive branch"),
        before: string(data.before, "Invalid integration revision"),
        after: string(data.after, "Invalid integration result"),
        archiveAfter: string(data.archiveAfter, "Invalid archive result"),
        ...(data.archiveBefore === undefined
          ? {}
          : { archiveBefore: string(data.archiveBefore, "Invalid archive baseline") }),
        completed: data.completed,
        files: data.files.map((value: unknown) => {
          const file = record(value, "Invalid transfer file"),
            path = string(file.path, "Invalid transfer path");
          ownedPath(root, path);
          if (
            path !== projectPaths.state &&
            path !== projectPaths.config &&
            !/^(?:.*\/)?workbench\/(?:tasks|experiments)\//.test(path) &&
            !/^(?:.*\/)?workbench\/(?:task|experiment)-map\.md$/.test(path)
          )
            throw new InvalidInput(`Unexpected transfer path: ${path}`);
          const before = entry(file.before),
            after = entry(file.after);
          return { path, ...(before ? { before } : {}), ...(after ? { after } : {}) };
        }),
      };
      validateBranch(root, result.branch);
      validateBranch(root, result.archiveBranch);
      if (
        ![
          result.before,
          result.after,
          result.archiveAfter,
          ...(result.archiveBefore ? [result.archiveBefore] : []),
        ].every(objectId)
      )
        throw new InvalidInput("Invalid transfer revisions");
      return result;
    },
    () => undefined,
  );
}
export const archiveOperation = (root: string): ArchiveOperation | undefined => operationStore(root).read();
function revision(root: string, ref: string): string | undefined {
  const result = spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", ref], { encoding: "utf8" });
  if (result.error || (result.status !== 0 && result.status !== 1))
    throw new Error(`Cannot inspect ${ref}`, { cause: result.error });
  return result.status === 0 ? result.stdout.trim() : undefined;
}
function currentBranch(root: string): string {
  const result = spawnSync("git", ["-C", root, "symbolic-ref", "--short", "-q", "HEAD"], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new InvalidInput("Archival requires a checked-out integration branch");
  return result.stdout.trim();
}
function configuredArchive(root: string): string {
  const branch = readConfig(root).records?.archive_branch;
  if (!branch) throw new InvalidInput("No archive is configured; use 'workbench record archive enable'");
  validateBranch(root, branch);
  return branch;
}
function requireIntegration(root: string) {
  const target = integrationTarget(root);
  if (!readConfig(root).integration?.branch)
    throw new InvalidInput(
      "Select and retain integration.branch before archiving; use 'workbench record archive enable'",
    );
  if (currentBranch(root) !== target.branch)
    throw new InvalidInput(`Only integration branch ${target.branch} may initiate archival`);
  return target;
}
function requireArchiveNotCheckedOut(root: string, branch: string): void {
  const worktrees = gitBytes(root, ["worktree", "list", "--porcelain", "-z"]).toString().split("\0");
  if (worktrees.includes(`branch refs/heads/${branch}`))
    throw new StateConflict(`Archive branch ${branch} is checked out in a worktree`);
}
function requireCleanPaths(root: string, paths: string[]): void {
  if (!paths.length) return;
  const result = gitBytes(root, [
    "--literal-pathspecs",
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--",
    ...paths,
  ]).toString();
  if (result)
    throw new StateConflict(
      "Archive transfer affects edited or staged files. Commit or set aside those files first; unrelated changes may remain.\n" +
        result.split("\0").filter(Boolean).join("\n"),
    );
}
export function enableArchive(
  root: string,
  options: { branch?: string; groupSize?: number; integrationBranch?: string; remote?: string } = {},
): void {
  withRepositoryOperation(root, () => {
    if (archiveOperation(root)?.completed === false)
      throw new StateConflict("An archive operation requires recovery first");
    const configured = readConfig(root),
      branch = options.branch ?? configured.records?.archive_branch ?? "workbench/archive";
    const target = integrationTarget(root, {
      ...configured.integration,
      ...(options.integrationBranch ? { branch: options.integrationBranch } : {}),
      ...(options.remote ? { remote: options.remote } : {}),
    });
    validateBranch(root, branch);
    validateBranch(root, target.branch);
    if (branch === target.branch) throw new InvalidInput("The archive and integration branches must differ");
    requireArchiveNotCheckedOut(root, branch);
    const pinned = archiveRevision(root);
    if (pinned && configured.records?.archive_branch && configured.records.archive_branch !== branch)
      throw new InvalidInput("Restore the current archive before changing its destination");
    if (pinned && !configured.records?.archive_branch) {
      const tip = revision(root, `refs/heads/${branch}`);
      if (!tip || spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", pinned, tip]).status !== 0)
        throw new InvalidInput(
          "Restore archive configuration using a branch that contains the pinned archive revision",
        );
    }
    const size = options.groupSize ?? configured.records?.archive_group_size ?? 1296;
    if (!Number.isSafeInteger(size) || size <= 0)
      throw new InvalidInput("Archive group size must be a positive integer");
    const path = join(root, projectPaths.config),
      text = readFileSync(path, "utf8");
    const data = parse(text);
    data.records = {
      ...record(data.records ?? {}, "Invalid record configuration"),
      archive_branch: branch,
      archive_group_size: size,
    };
    data.integration = { ...record(data.integration ?? {}, "Invalid integration configuration"), ...target };
    const existing = revision(root, `refs/heads/${branch}`);
    if (existing) verifyArchiveHistory(root, existing);
    protectArchiveBranch(root, branch);
    writeAtomic(path, editToml(text, data));
  });
}

/** One history pass identifies the most recent committed version of each candidate. */
function committedReviews(root: string, paths: string[]): Set<string> {
  if (!paths.length) return new Set();
  const pending = new Set(paths),
    reviewed = new Set<string>();
  const history = gitBytes(root, [
    "--literal-pathspecs",
    "log",
    "--format=%x1e%H%x00%(trailers:key=Workbench-Provisional,only)",
    "--name-only",
    "--no-renames",
    "-z",
    "HEAD",
    "--",
    ...paths,
  ]).toString();
  for (const section of history.split("\x1e").filter(Boolean)) {
    const [commit, markers, ...files] = section.split("\0");
    if (!commit || !objectId(commit)) throw new Error("Invalid record history");
    for (const name of files) {
      const path = name.replace(/^\n/, "");
      if (!pending.delete(path)) continue;
      if (!markers?.trim()) reviewed.add(path);
    }
    if (!pending.size) break;
  }
  return reviewed;
}
export function previewArchive(root: string): ArchiveGroup[] {
  const snapshot = new GitSnapshot(root, { staged: false });
  const candidates: Omit<ArchiveCandidate, "contents" | "reviewed">[] = [];
  const registry = snapshot.committedBytes(projectPaths.projects);
  if (!registry) throw new InvalidInput("Commit the project registry before archiving records");
  const scopes = new Set(
    projectsFromData(parse(registry.toString()), projectPaths.projects).map((project) => project.path),
  );
  for (const path of snapshot.committed.keys()) {
    const match = /^(?:(.+)\/)?workbench\/(tasks|experiments)\/(?:[0-9A-Z]{2}\/)*(TSK|EXP)-([0-9A-Z]+)\.md$/.exec(path);
    if (!match?.[2] || !match[3] || !match[4]) continue;
    const kind = match[3] as (typeof archivedKinds)[number],
      number = normalizedNumber(match[4]);
    const scopePath = match[1] ?? ".";
    if (!scopes.has(scopePath)) continue;
    const expected = `${scopePath === "." ? "" : scopePath + "/"}workbench/${relativeRecordPath(kind, number).split("\\").join("/")}`;
    if (path !== expected) throw new InvalidInput(`Noncanonical record: ${path}`);
    candidates.push({ path, scopePath, kind, number });
  }
  const reviewed = committedReviews(
    root,
    candidates.map((item) => item.path),
  );
  const bytes = readGitObjects(
    root,
    candidates.map((item) => snapshot.committed.get(item.path)?.oid ?? ""),
  );
  return archiveGroups(
    candidates.map((item) => {
      const body = bytes.get(snapshot.committed.get(item.path)?.oid ?? "");
      if (!body) throw new InvalidInput(`Missing committed record: ${item.path}`);
      return { ...item, contents: body.toString(), reviewed: reviewed.has(item.path) };
    }),
    readConfig(root).records?.archive_group_size ?? 1296,
  );
}
const sameEntry = (a: GitEntry | undefined, b: GitEntry | undefined) => a?.oid === b?.oid && a?.mode === b?.mode;
function commitTree(root: string, tree: string, parent: string | undefined, message: string): string {
  return gitBytes(root, ["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message])
    .toString()
    .trim();
}
function archiveAdvance(root: string, operation: ArchiveOperation): void {
  const ref = `refs/heads/${operation.archiveBranch}`,
    actual = revision(root, ref);
  if (actual === operation.archiveAfter) return;
  if (actual !== operation.archiveBefore)
    throw new StateConflict("Archive branch changed during transfer; recovery preserved both versions");
  readArchiveIndex(root, operation.archiveAfter);
  allowArchiveAdvance(
    root,
    operation.archiveBranch,
    actual,
    operation.archiveAfter,
    operation.kind === "restore" ? operation.branch : undefined,
  );
  gitBytes(root, ["update-ref", ref, operation.archiveAfter, actual ?? "0".repeat(operation.archiveAfter.length)]);
}
function applyIntegration(root: string, operation: ArchiveOperation): void {
  verifyArchiveTransfer(root, operation.before, operation.after);
  publishGitTree(root, operation.branch, operation.before, operation.after, operation.files);
  if (operation.kind === "archive") {
    const prune = (path: string): void => {
      const info = lstatSync(path, { throwIfNoEntry: false });
      if (!info || !info.isDirectory() || info.isSymbolicLink()) return;
      for (const child of readdirSync(path)) prune(join(path, child));
      if (!readdirSync(path).length) rmdirSync(path);
    };
    for (const file of operation.files)
      if (/(?:TSK|EXP)-[0-9A-Z]+\.md$/.test(file.path)) {
        prune(ownedPath(root, file.path.slice(0, -3)));
        for (
          let parent = dirname(ownedPath(root, file.path));
          /^[0-9A-Z]{2}$/.test(basename(parent));
          parent = dirname(parent)
        ) {
          const info = lstatSync(parent, { throwIfNoEntry: false });
          if (!info?.isDirectory() || info.isSymbolicLink() || readdirSync(parent).length) break;
          rmdirSync(parent);
        }
      }
  }
}
export type ArchiveProgress = "recorded" | "archive-committed" | "integration-committed" | "completed";
function verifyOperation(root: string, operation: ArchiveOperation): void {
  verifyArchiveTransfer(root, operation.before, operation.after);
  const before = readGitTree(root, operation.before),
    after = readGitTree(root, operation.after),
    selected = new Set<string>();
  for (const file of operation.files) {
    if (
      selected.has(file.path) ||
      !sameEntry(before.get(file.path), file.before) ||
      !sameEntry(after.get(file.path), file.after)
    )
      throw new InvalidInput(`Archive recovery state disagrees with its commits: ${file.path}`);
    selected.add(file.path);
  }
  for (const path of new Set([...before.keys(), ...after.keys()]))
    if (!sameEntry(before.get(path), after.get(path)) && !selected.has(path))
      throw new InvalidInput(`Archive recovery state omits a changed path: ${path}`);
  for (const [commit, parent] of [
    [operation.after, operation.before],
    [operation.archiveAfter, operation.archiveBefore],
  ] as const) {
    const fields = gitBytes(root, ["rev-list", "--parents", "-n", "1", commit]).toString().trim().split(" ");
    if (fields[0] !== commit || fields[1] !== parent || fields.length !== (parent ? 2 : 1))
      throw new InvalidInput("Archive recovery history is inconsistent");
  }
  const oldArchive = operation.archiveBefore
    ? readArchiveIndex(root, operation.archiveBefore).files
    : new Map<string, GitEntry>();
  const expected = new Map(oldArchive);
  for (const file of operation.files) {
    if (!/(?:^|\/)workbench\/(?:tasks|experiments)\//.test(file.path)) continue;
    if (operation.kind === "restore") expected.delete(file.path);
    else if (file.before && !file.after) expected.set(file.path, file.before);
  }
  const actual = readArchiveIndex(root, operation.archiveAfter).files;
  if (expected.size !== actual.size || [...expected].some(([path, entry]) => !sameEntry(entry, actual.get(path))))
    throw new InvalidInput("Archive recovery state disagrees with the archive contents");
}

function retainOperation(root: string, operation: ArchiveOperation): void {
  const prefix = `refs/workbench/record-transfers/${operation.id}`;
  gitBytes(
    root,
    ["update-ref", "--stdin"],
    `start\ncreate ${prefix}/archive ${operation.archiveAfter}\ncreate ${prefix}/integration ${operation.after}\nprepare\ncommit\n`,
  );
}
function releaseOperation(root: string, operation: ArchiveOperation): void {
  const prefix = `refs/workbench/record-transfers/${operation.id}`;
  for (const [name, oid] of [
    ["archive", operation.archiveAfter],
    ["integration", operation.after],
  ] as const) {
    const ref = `${prefix}/${name}`;
    if (revision(root, ref)) gitBytes(root, ["update-ref", "-d", ref, oid]);
  }
}

function resume(
  root: string,
  operation: ArchiveOperation,
  progress?: (stage: ArchiveProgress) => void,
): ArchiveOperation {
  if (operation.checkout !== root) throw new StateConflict(`Resume this transfer in ${operation.checkout}`);
  requireArchiveNotCheckedOut(root, operation.archiveBranch);
  if (operation.completed) {
    releaseOperation(root, operation);
    return operation;
  }
  verifyOperation(root, operation);
  if (operation.kind === "archive") {
    archiveAdvance(root, operation);
    progress?.("archive-committed");
    applyIntegration(root, operation);
    progress?.("integration-committed");
  } else {
    applyIntegration(root, operation);
    progress?.("integration-committed");
    archiveAdvance(root, operation);
    progress?.("archive-committed");
  }
  operation.completed = true;
  operationStore(root).write(operation);
  releaseOperation(root, operation);
  progress?.("completed");
  return operation;
}
export function recoverArchive(root: string): ArchiveOperation {
  return withRepositoryOperation(root, () =>
    withProjectStateLock(root, () => {
      const operation = archiveOperation(root);
      if (!operation) throw new InvalidInput("No archive transfer requires recovery");
      return resume(root, operation);
    }),
  );
}

export function transferArchive(
  root: string,
  options: { restore?: boolean; includePartial?: boolean; onProgress?: (stage: ArchiveProgress) => void } = {},
): ArchiveOperation {
  return withRepositoryOperation(root, () =>
    withProjectStateLock(root, () => {
      const pending = archiveOperation(root);
      if (pending && !pending.completed) return resume(root, pending);
      const target = requireIntegration(root),
        branch = configuredArchive(root);
      if (branch === target.branch) throw new InvalidInput("The archive cannot be the integration branch");
      requireArchiveNotCheckedOut(root, branch);
      requireCleanPaths(root, [projectPaths.config, projectPaths.state, projectPaths.projects]);
      protectArchiveBranch(root, branch);
      const snapshot = new GitSnapshot(root, { staged: false });
      if (!snapshot.head) throw new InvalidInput("Commit records before archiving them");
      const archiveBefore = revision(root, `refs/heads/${branch}`),
        pinned = archiveRevision(root);
      if (pinned && pinned !== archiveBefore)
        throw new StateConflict(
          "The integration branch archive revision differs from the archive tip; reconcile before transferring records",
        );
      const previous = archiveBefore ? readArchiveIndex(root, archiveBefore) : undefined;
      let transfer = new Map<string, GitEntry>();
      if (options.restore) {
        if (!pinned) throw new InvalidInput("No records are archived in this checkout");
        transfer = new Map(readArchiveIndex(root, pinned).files);
      } else {
        const selected = previewArchive(root).filter(
          (group) => group.eligible && (group.complete || options.includePartial),
        );
        const owners = selected.flatMap((group) => group.paths);
        if (!owners.length)
          throw new InvalidInput(
            "No eligible complete archive groups; inspect status or explicitly include the partial group",
          );
        for (const [path, entry] of snapshot.committed)
          if (owners.some((owner) => path === owner || path.startsWith(owner.slice(0, -3) + "/"))) {
            if (!["100644", "100755"].includes(entry.mode))
              throw new InvalidInput(`Unsafe record supporting file: ${path}`);
            transfer.set(path, entry);
          }
      }
      requireCleanPaths(root, [
        ...transfer.keys(),
        ...[...transfer.keys()]
          .filter((path) => /(?:TSK|EXP)-[0-9A-Z]+\.md$/.test(path))
          .map((path) => path.slice(0, -3)),
        projectPaths.config,
        projectPaths.state,
        projectPaths.projects,
      ]);
      for (const [path, value] of transfer) {
        const existing = options.restore ? snapshot.committed.get(path) : previous?.files.get(path);
        if (existing && !sameEntry(existing, value))
          throw new StateConflict(`Transfer has conflicting copies: ${path}`);
      }
      const zero = "0".repeat(snapshot.head.length),
        missing = { mode: "000000", oid: zero };
      const archiveTree = updatedReviewTree(
        root,
        archiveBefore ?? "",
        [...transfer].map(([path, value]) => ({ path, entry: options.restore ? missing : value })),
      );
      const archiveAfter = commitTree(
        root,
        archiveTree,
        archiveBefore,
        options.restore ? "chore: retire restored archive copies" : "chore: archive completed records",
      );
      readArchiveIndex(root, archiveAfter);
      const statePath = join(root, projectPaths.state),
        beforeState = existsSync(statePath) ? readFileSync(statePath, "utf8") : "";
      const state: Record<string, unknown> = parse(beforeState),
        archive = record(state.archive ?? {}, "Invalid archive state");
      if (options.restore) Reflect.deleteProperty(archive, "revision");
      else archive.revision = archiveAfter;
      if (Object.keys(archive).length) state.archive = archive;
      else Reflect.deleteProperty(state, "archive");
      const stateBody = Buffer.from(editToml(beforeState, state));
      const stateOid = writeReviewBlobs(root, [stateBody])[0];
      if (!stateOid) throw new Error("Missing archive state object");
      const files: TransferFile[] = [...transfer].map(([path, value]) => ({
        path,
        ...(snapshot.committed.get(path) ? { before: snapshot.committed.get(path) } : {}),
        ...(options.restore ? { after: value } : {}),
      }));
      files.push({
        path: projectPaths.state,
        ...(snapshot.committed.get(projectPaths.state) ? { before: snapshot.committed.get(projectPaths.state) } : {}),
        after: { mode: "100644", oid: stateOid },
      });
      if (options.restore) {
        const configPath = join(root, projectPaths.config),
          text = readFileSync(configPath, "utf8"),
          config: Record<string, unknown> = parse(text);
        const records = record(config.records ?? {}, "Invalid records configuration");
        Reflect.deleteProperty(records, "archive_branch");
        config.records = records;
        const configOid = writeReviewBlobs(root, [Buffer.from(editToml(text, config))])[0];
        if (!configOid) throw new Error("Missing restored configuration");
        files.push({
          path: projectPaths.config,
          before: snapshot.committed.get(projectPaths.config),
          after: { mode: "100644", oid: configOid },
        });
      }
      const integrationTree = updatedReviewTree(
        root,
        snapshot.head,
        files.map((file) => ({ path: file.path, entry: file.after ?? missing })),
      );
      const generatedMaps = projectedRecordMaps(root, integrationTree);
      const mapIds = writeReviewBlobs(root, [...generatedMaps.values()]);
      let mapIndex = 0;
      for (const [path] of generatedMaps) {
        const oid = mapIds[mapIndex++];
        if (!oid) throw new Error("Missing generated map object");
        const before = snapshot.committed.get(path),
          after = { mode: "100644", oid };
        if (!sameEntry(before, after)) {
          requireCleanPaths(root, [path]);
          files.push({ path, ...(before ? { before } : {}), after });
        }
      }
      const finalTree = updatedReviewTree(
        root,
        snapshot.head,
        files.map((file) => ({ path: file.path, entry: file.after ?? missing })),
      );
      const provisional = provisionalMessage(
        root,
        gitBytes(root, ["log", "-1", "--format=%B", snapshot.head]).toString(),
      );
      const after = commitTree(
        root,
        finalTree,
        snapshot.head,
        (options.restore ? "chore: restore archived records" : "chore: remove verified archived copies") +
          (provisional ? `\n\n${provisionalTrailer}: true` : ""),
      );
      const operation: ArchiveOperation = {
        version: 1,
        id: randomUUID(),
        kind: options.restore ? "restore" : "archive",
        checkout: root,
        branch: target.branch,
        archiveBranch: branch,
        before: snapshot.head,
        after,
        ...(archiveBefore ? { archiveBefore } : {}),
        archiveAfter,
        files,
        completed: false,
      };
      retainOperation(root, operation);
      operationStore(root).write(operation);
      options.onProgress?.("recorded");
      return resume(root, operation, options.onProgress);
    }),
  );
}

export function fetchArchive(root: string, options: { from?: string; remote?: string } = {}): void {
  withRepositoryOperation(
    root,
    () => {
      let config: Record<string, unknown>, pinned: string | undefined;
      if (options.from) {
        if (options.from.startsWith("-") || /[\0\r\n]/.test(options.from))
          throw new InvalidInput("Invalid archive source revision");
        const tree = readGitTree(
          root,
          gitBytes(root, ["rev-parse", "--verify", `${options.from}^{commit}`])
            .toString()
            .trim(),
        );
        const read = (path: string) => {
          const entry = tree.get(path),
            bytes = entry ? readGitObjects(root, [entry.oid]).get(entry.oid) : undefined;
          return bytes ? parse(bytes.toString()) : {};
        };
        config = read(projectPaths.config);
        const value = record(read(projectPaths.state).archive ?? {}, "Invalid archive state").revision;
        if (value !== undefined && (typeof value !== "string" || !objectId(value)))
          throw new InvalidInput("Invalid archive source revision");
        pinned = value;
      } else {
        config = readConfig(root);
        pinned = archiveRevision(root);
      }
      const selection = record(config.integration ?? {}, "Invalid integration target");
      const target = integrationTarget(root, {
        ...(typeof selection.branch === "string" ? { branch: selection.branch } : {}),
        ...(typeof selection.remote === "string" ? { remote: selection.remote } : {}),
        ...(options.remote ? { remote: options.remote } : {}),
      });
      const branch = record(config.records ?? {}, "Invalid archive configuration").archive_branch;
      if (typeof branch !== "string" || !branch)
        throw new InvalidInput(
          "No archive is selected; use --from to acquire the archive referenced by another branch",
        );
      validateBranch(root, branch);
      if (!target.remote)
        throw new InvalidInput(
          "No integration remote is configured; acquire the archive history from its original repository",
        );
      gitBytes(root, [
        "fetch",
        "--no-tags",
        "--refetch",
        "--no-filter",
        target.remote,
        `refs/heads/${branch}:refs/remotes/${target.remote}/${branch}`,
      ]);
      const fetched = revision(root, `refs/remotes/${target.remote}/${branch}`);
      if (!fetched) throw new InvalidInput("The remote did not provide an archive revision");
      verifyArchiveHistory(root, fetched);
      if (pinned) readArchiveIndex(root, pinned);
      requireArchiveNotCheckedOut(root, branch);
      acquireArchiveBranch(root, branch, fetched);
    },
    "acquire",
  );
}

export function publishArchive(root: string): void {
  const target = requireIntegration(root),
    operation = archiveOperation(root);
  if (!target.remote) throw new InvalidInput("Configure integration.remote before publishing");
  if (operation && !operation.completed) throw new StateConflict("Recover the archive transfer before publishing");
  const branch = readConfig(root).records?.archive_branch ?? operation?.archiveBranch;
  if (!branch) throw new InvalidInput("No archive branch is available to publish");
  const refs = [`refs/heads/${target.branch}:refs/heads/${target.branch}`, `refs/heads/${branch}:refs/heads/${branch}`];
  const result = spawnSync("git", ["-C", root, "push", "--atomic", target.remote, ...refs], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (!result.error && result.status === 0) return;
  if (result.error || !/does not support.*atomic|atomic.*not supported/i.test(result.stderr))
    throw new Error(`Archive publication failed; local commits are preserved: ${result.stderr.trim()}`, {
      cause: result.error,
    });
  if (operation?.kind === "restore" && operation.archiveBefore) {
    const remoteRef = `refs/heads/${branch}`,
      remoteTip = gitBytes(root, ["ls-remote", "--refs", target.remote, remoteRef]).toString().trim().split(/\s+/)[0];
    if (!remoteTip) gitBytes(root, ["push", target.remote, `${operation.archiveBefore}:${remoteRef}`]);
    else if (
      spawnSync("git", ["-C", root, "merge-base", "--is-ancestor", operation.archiveBefore, remoteTip]).status !== 0
    )
      throw new StateConflict("Acquire and reconcile the remote archive before publishing restored records");
  }
  const order = operation?.kind === "restore" ? refs : [...refs].reverse();
  for (const ref of order) {
    gitBytes(root, ["push", target.remote, ref]);
    const [local, remote] = ref.split(":");
    if (
      !local ||
      !remote ||
      gitBytes(root, ["ls-remote", target.remote, remote]).toString().trim().split(/\s/)[0] !== revision(root, local)
    )
      throw new StateConflict(
        "Published archive counterpart could not be verified; the remaining update was not pushed",
      );
  }
}
