import { commitSummaries } from "./commit-history.js";
import { logicalRecordEntries } from "../records/archive-store.js";
import { gitBytes, readGitTree, readGitObjects, type GitEntry } from "./git-snapshot.js";
import { gitRevision } from "./refs.js";
import { commitVersion } from "../review/review-units.js";
import { planningSettings } from "../tasks/planning/planning-settings.js";
import { InvalidInput, MissingResource } from "../runtime/input-errors.js";
import { WeightedCache } from "../storage/weighted-cache.js";
import { resolve } from "node:path";

const inspections = new WeightedCache<ReturnType<typeof inspectCommit>>(32 * 1024 * 1024);
const taskPages = new WeightedCache<ReturnType<typeof taskCommitPage>>(4 * 1024 * 1024);
const previews = new WeightedCache<ReturnType<typeof readGitObjects>>(8 * 1024 * 1024);

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
  additions?: number | null;
  deletions?: number | null;
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
  const statistics = new Map(
    gitBytes(root, [
      "diff-tree",
      "--no-commit-id",
      "--numstat",
      "-r",
      "-z",
      "--no-renames",
      ...(unit.parents[0] ? [unit.parents[0], unit.revision] : ["--root", unit.revision]),
    ])
      .toString()
      .split("\0")
      .filter(Boolean)
      .map((row) => {
        const first = row.indexOf("\t"),
          second = row.indexOf("\t", first + 1);
        if (first < 0 || second < 0) throw new InvalidInput("Invalid historical file statistics");
        return [
          row.slice(second + 1),
          {
            additions: row.slice(0, first) === "-" ? null : Number(row.slice(0, first)),
            deletions: row.slice(first + 1, second) === "-" ? null : Number(row.slice(first + 1, second)),
          },
        ] as const;
      }),
  );
  for (const change of changes) Object.assign(change, statistics.get(change.path));
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
  if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) {
    const cached = inspections.get(`${resolve(root)}:${revision}`);
    if (cached) return cached;
  }
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
  const changed = inspection.changes.find((file) => file.path === path);
  if (changed) return changed;
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
/** Read an immutable comparison's paired versions together. */
export function historyFilePreviews(root: string, file: HistoryFile, maximum: number) {
  const ids = [file.before, file.after].flatMap((entry) => (entry && entry.mode !== "160000" ? [entry.oid] : []));
  // Check presence separately from the preview limit so missing objects remain visible as failures.
  const contents = historyPreviewBlobs(root, ids, maximum, maximum * 2, true);
  const preview = (entry?: GitEntry) =>
    entry?.mode === "160000" ? Buffer.from(`Submodule ${entry.oid}\n`) : entry && contents.get(entry.oid);
  return { before: preview(file.before), after: preview(file.after) };
}

export function historyPreviewBlobs(
  root: string,
  ids: string[],
  maximum: number,
  retainedBytes: number,
  omitOversized = false,
) {
  const key = JSON.stringify([root, ids, maximum, retainedBytes, omitOversized]);
  const saved = previews.get(key);
  if (saved) return saved;
  const contents = readGitObjects(root, ids, maximum, { retainedBytes, omitOversized, requirePresent: true });
  if ([...contents.values()].every((bytes) => bytes !== undefined))
    previews.set(
      key,
      contents,
      key.length * 2 + [...contents.values()].reduce((size, bytes) => size + 128 + (bytes?.length ?? 0), 0),
    );
  return contents;
}

/** Read blob sizes together so previews can be selected before reading their contents. */
export function historyBlobSizes(root: string, ids: readonly string[]): ReadonlyMap<string, number> {
  const sizes = new Map<string, number>();
  if (!ids.length) return sizes;
  const rows = gitBytes(root, ["cat-file", "--batch-check"], ids.join("\n") + "\n")
    .toString()
    .trimEnd()
    .split("\n");
  if (rows.length !== ids.length) throw new MissingResource("Historical file metadata is incomplete");
  for (const [index, row] of rows.entries()) {
    const [id, type, value] = row.split(" "),
      size = Number(value);
    if (!id || id !== ids[index] || type !== "blob" || !Number.isSafeInteger(size) || size < 0)
      throw new MissingResource("Historical file is unavailable locally");
    sizes.set(id, size);
  }
  return sizes;
}
