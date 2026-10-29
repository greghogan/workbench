import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { combineFailures } from "../scripts/diagnostic-errors.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
export interface GitEntry {
  mode: string;
  oid: string;
}
export function gitBytes(root: string, args: string[], input?: string): Buffer {
  const result = spawnSync("git", ["-C", root, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    ...(input === undefined ? {} : { input }),
  });
  if (result.error || result.status !== 0)
    throw new Error(`cannot inspect Git snapshot: ${result.error?.message ?? result.stderr.toString().trim()}`);
  return result.stdout;
}
function headAt(root: string): string {
  const result = spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", "HEAD"], { encoding: "utf8" });
  if (result.error || (result.status !== 0 && result.status !== 1)) throw new Error("cannot inspect committed records");
  return result.stdout.trim();
}
function entries(root: string, tree: string): Map<string, GitEntry> {
  const result = new Map<string, GitEntry>();
  for (const row of gitBytes(root, ["ls-tree", "-r", "-z", "--full-tree", tree]).toString().split("\0")) {
    if (!row) continue;
    const tab = row.indexOf("\t"),
      [mode, , oid] = row.slice(0, tab).split(" ");
    if (tab < 0 || !mode || !oid) throw new Error("invalid Git tree entry");
    result.set(row.slice(tab + 1), { mode, oid });
  }
  return result;
}
/** Capture committed files, optionally include staged changes, and batch bounded immutable-object reads. */
export class GitSnapshot {
  readonly head: string;
  readonly committed: Map<string, GitEntry>;
  readonly staged: Map<string, GitEntry>;
  readonly changes: string[];
  private readonly objects = new Map<string, Buffer>();
  private readonly sizes = new Map<string, number>();
  private retained = 0;
  constructor(
    readonly root: string,
    options: { staged?: boolean; tree?: string } = {},
  ) {
    this.head = headAt(root);
    this.committed = this.head ? entries(root, this.head) : new Map<string, GitEntry>();
    this.staged = new Map(this.committed);
    this.changes =
      options.staged === false
        ? []
        : gitBytes(root, [
            "diff",
            ...(options.tree
              ? [this.head || gitBytes(root, ["mktree"], "").toString().trim(), options.tree]
              : ["--cached", ...(this.head ? [this.head] : [])]),
            "--raw",
            "--no-abbrev",
            "--no-renames",
            "--ita-invisible-in-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "-z",
          ])
            .toString()
            .split("\0");
    for (let i = 0; i < this.changes.length - 1; i += 2) {
      const header = this.changes[i],
        path = this.changes[i + 1];
      const fields = header?.slice(1).split(" "),
        mode = fields?.[1],
        oid = fields?.[3];
      if (fields?.[4] === "U") throw new Error(`resolve the conflicted index entry: ${String(path)}`);
      if (path === undefined || !mode || !oid) throw new Error("invalid staged Git entry");
      if (mode === "000000") this.staged.delete(path);
      else this.staged.set(path, { mode, oid });
    }
    this.prefetch(
      [...this.staged, ...this.committed]
        .filter(([path]) => ["workbench/config.toml", "workbench/projects.toml"].includes(path))
        .map(([, entry]) => entry.oid),
    );
  }
  prefetch(requested: readonly string[], maximum = 2 * 1024 * 1024): void {
    const ids = [...new Set(requested)].filter((oid) => !this.objects.has(oid));
    if (!ids.length) return;
    if (ids.some((oid) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))) throw new Error("invalid Git object identity");
    const unknown = ids.filter((oid) => !this.sizes.has(oid));
    if (unknown.length) {
      const rows = gitBytes(this.root, ["cat-file", "--batch-check"], unknown.join("\n") + "\n")
        .toString()
        .trimEnd()
        .split("\n");
      for (const [i, row] of rows.entries()) {
        const [oid, type, size] = row.split(" "),
          bytes = Number(size);
        if (!oid || oid !== unknown[i] || type !== "blob" || !Number.isSafeInteger(bytes) || bytes < 0)
          throw new Error("invalid Git blob metadata");
        this.sizes.set(oid, bytes);
      }
      if (rows.length !== unknown.length) throw new Error("incomplete Git blob metadata");
    }
    const selected = ids.filter((oid) => (this.sizes.get(oid) ?? Infinity) <= maximum);
    const expected = selected.reduce((sum, oid) => sum + (this.sizes.get(oid) ?? 0), 0);
    if (this.retained + expected > 64 * 1024 * 1024) throw new Error("Git snapshot exceeds 64 MiB");
    if (!selected.length) return;
    const bytes = gitBytes(this.root, ["cat-file", "--batch"], selected.join("\n") + "\n");
    let offset = 0;
    for (const oid of selected) {
      const end = bytes.indexOf(10, offset),
        header = bytes.subarray(offset, end).toString(),
        size = this.sizes.get(oid);
      if (
        end < offset ||
        size === undefined ||
        header !== `${oid} blob ${String(size)}` ||
        bytes[end + 1 + size] !== 10
      )
        throw new Error("invalid Git batch response");
      const body = Buffer.from(bytes.subarray(end + 1, end + 1 + size));
      this.objects.set(oid, body);
      this.retained += body.length;
      offset = end + size + 2;
    }
    if (offset !== bytes.length) throw new Error("unexpected Git batch data");
  }
  blobSize(oid: string): number {
    const size = this.sizes.get(oid);
    if (size === undefined) throw new Error("Git object metadata was not prefetched");
    return size;
  }
  blob(oid: string, maximum = 2 * 1024 * 1024): Buffer {
    this.prefetch([oid], maximum);
    const bytes = this.objects.get(oid);
    if (!bytes || bytes.length > maximum)
      throw new Error("review file exceeds the 2 MiB preview limit; review it in the terminal");
    return bytes;
  }
  committedBytes(path: string): Buffer | undefined {
    const entry = this.committed.get(path);
    return entry ? this.blob(entry.oid) : undefined;
  }
}

/** Scope scratch cleanup without losing either the primary failure or cleanup diagnostics. */
function withReviewScratch<T>(action: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "workbench-review-index-"));
  let result: T;
  try {
    result = action(directory);
  } catch (failure) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (cleanup) {
      throw combineFailures(failure, cleanup, "Review snapshot and cleanup failed");
    }
    throw failure;
  }
  rmSync(directory, { recursive: true, force: true });
  return result;
}
/** Own a private index for one transaction; clean filters run only for a selected working-tree capture. */
function withPrivateIndex<T>(
  root: string,
  base: string,
  action: (run: (args: string[], input?: string) => string) => T,
): T {
  return withReviewScratch((directory) => {
    const env = { ...process.env, GIT_INDEX_FILE: join(directory, "index") };
    const run = (args: string[], input?: string) => {
      const result = spawnSync("git", ["-C", root, ...args], {
        env,
        input,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      if (result.error || result.status !== 0)
        throw new Error(`Cannot capture review snapshot: ${result.stderr}`, { cause: result.error });
      return result.stdout.trim();
    };
    run(["read-tree", base || "--empty"]);
    return action(run);
  });
}
/** Persist retained baseline bytes through one Git process, independent of the current worktree. */
export function writeReviewBlobs(root: string, contents: readonly Buffer[]): string[] {
  if (!contents.length) return [];
  return withReviewScratch((directory) => {
    const paths = contents.map((body, index) => {
      const path = join(directory, String(index));
      writeFileSync(path, body, { flag: "wx", mode: 0o600 });
      return path;
    });
    return writeRawReviewObjects(root, paths);
  });
}
/** Git-normalized proposed commit content, including configured clean filters, through a private index. */
export function workingReviewTree(root: string): string {
  return withPrivateIndex(root, headAt(root), (run) => {
    run(["add", "-A", "--", "."]);
    return run(["write-tree"]);
  });
}
export function reviewEntry(identity: string): GitEntry {
  const [mode, oid] = identity.split(":");
  if (!mode || !/^(?:000000|100644|100755)$/.test(mode) || !oid || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))
    throw new Error("Invalid review object identity");
  return { mode, oid };
}
/** Build a tree from captured raw objects without clean filters or user-index mutations. */
export function updatedReviewTree(root: string, base: string, updates: { path: string; entry: GitEntry }[]): string {
  return withPrivateIndex(root, base, (run) => {
    run(
      ["update-index", "-z", "--index-info"],
      updates.map(({ path, entry }) => `${entry.mode} ${entry.oid}\t${path}\0`).join(""),
    );
    return run(["write-tree"]);
  });
}
/** Git accepts quoted paths here, preserving spaces and Unicode while avoiding one process per file. */
export function writeRawReviewObjects(root: string, paths: string[]): string[] {
  if (!paths.length) return [];
  const ids = gitBytes(
    root,
    ["hash-object", "-w", "--no-filters", "--stdin-paths"],
    paths.map((path) => JSON.stringify(path)).join("\n") + "\n",
  )
    .toString()
    .trim()
    .split("\n");
  if (ids.length !== paths.length || ids.some((id) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id)))
    throw new Error("Invalid captured review objects");
  return ids;
}
