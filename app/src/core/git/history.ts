import { commitSummaries } from "./commit-history.js";
import { logicalRecordEntries } from "../records/archive-store.js";
import { gitBytes, readGitTree, readGitObjects, type GitEntry } from "./git-snapshot.js";
import { gitRevision } from "./refs.js";
import { commitVersion } from "../review/review-units.js";
import { planningSettings } from "../tasks/planning/planning-store.js";
import { InvalidInput, MissingResource } from "../runtime/input-errors.js";
import { WeightedCache } from "../storage/weighted-cache.js";
import { resolve } from "node:path";

const inspections = new WeightedCache<ReturnType<typeof inspectCommit>>(32 * 1024 * 1024);
const taskPages = new WeightedCache<ReturnType<typeof taskCommitPage>>(4 * 1024 * 1024);

function taskCommitPage(root: string, tip: string, path: string, offset: number) {
  if (!gitBytes(root, ["ls-tree", "-z", tip, "--", path]).length) return { tip, commits: [], next: undefined };
  const creation = gitBytes(root, [
      "log",
      "--first-parent",
      "--follow",
      "--diff-filter=A",
      "-1",
      "--format=%H",
      tip,
      "--",
      path,
    ])
      .toString()
      .trim(),
    parent = creation ? gitRevision(root, `${creation}^`) : undefined,
    commits = commitSummaries(root, tip, { path, skip: offset, ...(parent ? { after: parent } : {}) });
  return { tip, commits: commits.slice(0, 50), next: commits.length > 50 ? offset + 50 : undefined };
}

/** A task's retained deliveries follow its record, including renames, without reading unrelated commit trees. */
export function taskCommits(root: string, path: string, selected = "HEAD", offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new InvalidInput("Invalid task history page");
  const immutableKey = `${resolve(root)}:${selected}:${path}:${String(offset)}`;
  if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(selected)) {
    const cached = taskPages.get(immutableKey);
    if (cached) return cached;
  }
  const tip = gitRevision(root, `${selected}^{commit}`);
  if (!tip) {
    if (selected !== "HEAD") throw new MissingResource("Task history is unavailable locally");
    return { tip: "", commits: [], next: undefined };
  }
  const key = `${resolve(root)}:${tip}:${path}:${String(offset)}`,
    cached = taskPages.get(key);
  if (cached) return cached;
  const result = taskCommitPage(root, tip, path, offset);
  taskPages.set(key, result, JSON.stringify(result).length * 2);
  return result;
}

export function historyBranches(root: string) {
  const planning = planningSettings(root).branch;
  return gitBytes(root, ["for-each-ref", "--format=%(refname:strip=2)%00%(objectname)", "refs/heads"])
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, revision] = line.split("\0");
      if (!name || !revision) throw new InvalidInput("Invalid branch history");
      return { name, revision, planning: name === planning };
    });
}
export function historyCommits(root: string, selected = "HEAD", from?: string) {
  const tip = gitRevision(root, `${selected}^{commit}`);
  if (!tip) throw new MissingResource("History is unavailable locally");
  const first = from ? gitRevision(root, `${from}^{commit}`) : tip;
  if (!first) throw new MissingResource("History page is unavailable locally");
  if (from && first !== tip) {
    const parent = commitVersion(root, first).parents[0];
    if (
      !gitBytes(root, ["rev-list", "--first-parent", tip, ...(parent ? ["--not", parent] : [])])
        .toString()
        .split("\n")
        .includes(first)
    )
      throw new InvalidInput("History cursor does not belong to the selected branch");
  }
  const summaries = commitSummaries(root, first);
  return { tip, commits: summaries.slice(0, 50), next: summaries[50]?.revision };
}
export interface HistoryFile {
  path: string;
  before?: GitEntry;
  after?: GitEntry;
}
function inspectCommit(root: string, revision: string) {
  const unit = commitVersion(root, revision),
    before = unit.parents[0] ? readGitTree(root, unit.parents[0]) : new Map<string, GitEntry>(),
    after = readGitTree(root, unit.revision),
    changes: HistoryFile[] = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(path),
      b = after.get(path);
    if (a?.oid !== b?.oid || a?.mode !== b?.mode)
      changes.push({ path, ...(a ? { before: a } : {}), ...(b ? { after: b } : {}) });
  }
  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    unit,
    before,
    after,
    changes,
    get logicalBefore() {
      return logicalRecordEntries(root, before);
    },
    get logicalAfter() {
      return logicalRecordEntries(root, after);
    },
  };
}
export function historyFiles(root: string, revision: string) {
  const commit = gitRevision(root, `${revision}^{commit}`);
  if (!commit) throw new MissingResource("History is unavailable locally");
  const key = `${resolve(root)}:${commit}`,
    cached = inspections.get(key);
  if (cached) return cached;
  const result = inspectCommit(root, commit);
  inspections.set(
    key,
    result,
    [...result.before, ...result.after].reduce((size, [path]) => size + path.length * 2 + 256, 1),
  );
  return result;
}
export function historyFile(
  root: string,
  revision: string,
  path: string,
  inspection = historyFiles(root, revision),
): HistoryFile {
  const { before, after, unit } = inspection,
    a = before.get(path),
    b = after.get(path);
  if (!a && !b) {
    const old = unit.parents[0] ? inspection.logicalBefore.get(path) : undefined,
      current = inspection.logicalAfter.get(path);
    if (!old && !current) throw new MissingResource("File not found in the selected commit or its parent");
    return { path, ...(old ? { before: old } : {}), ...(current ? { after: current } : {}) };
  }
  return { path, ...(a ? { before: a } : {}), ...(b ? { after: b } : {}) };
}
export function historyText(root: string, entry?: GitEntry): Buffer | undefined {
  if (!entry) return undefined;
  const size = Number(gitBytes(root, ["cat-file", "-s", entry.oid]).toString());
  if (!Number.isSafeInteger(size) || size < 0) throw new InvalidInput("Cannot inspect historical file size");
  if (size > 2 * 1024 * 1024) return undefined;
  const bytes = readGitObjects(root, [entry.oid], 2 * 1024 * 1024).get(entry.oid);
  if (!bytes) throw new MissingResource("Historical file is unavailable locally");
  return bytes;
}
