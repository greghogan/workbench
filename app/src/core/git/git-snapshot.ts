import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { combineFailures } from "../diagnostics/diagnostic-errors.mjs";
import { required } from "../runtime/invariants.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { WeightedCache } from "../storage/weighted-cache.js";
import { retainedBytes } from "../runtime/retained-bytes.js";
import { InvalidInput, MissingResource } from "../runtime/input-errors.js";
import { repositoryCommitObject, repositoryObjects } from "./repository-reads.js";
export interface GitEntry {
  mode: string;
  oid: string;
}
const maximumGitResponse = 64 * 1024 * 1024;
const objectId = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

function runGit(
  root: string,
  args: string[],
  input?: string | Buffer,
  env?: NodeJS.ProcessEnv,
  maxBuffer = maximumGitResponse,
) {
  return spawnSync("git", ["-C", root, ...args], {
    maxBuffer,
    env: { ...process.env, ...env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" },
    ...(input === undefined ? {} : { input }),
  });
}

function gitOutput(result: ReturnType<typeof runGit>): Buffer {
  if (result.error || result.status !== 0)
    throw new Error(`cannot inspect Git snapshot: ${result.error?.message ?? result.stderr.toString().trim()}`);
  return result.stdout;
}

export function gitBytes(root: string, args: string[], input?: string | Buffer, env?: NodeJS.ProcessEnv): Buffer {
  return gitOutput(runGit(root, args, input, env));
}

/** Resolve paths through Git, including worktree-local paths and an alternate index. */
export function gitPaths(root: string, names: readonly string[]): string[] {
  if (!names.length) return [];
  const newline = process.platform === "win32" ? /\r?\n/ : /\n/;
  const read = (paths: readonly string[]) => {
    const output = gitBytes(root, [
      "rev-parse",
      "--path-format=absolute",
      ...paths.flatMap((path) => ["--git-path", path]),
    ]).toString();
    return output.replace(process.platform === "win32" ? /\r?\n$/ : /\n$/, "");
  };
  const combined = read(names);
  if (names.length === 1) return [combined];
  const paths = combined.split(newline);
  // Git uses newlines as separators, which may also occur inside a metadata path.
  return paths.length === names.length ? paths : names.map((name) => read([name]));
}

function readFramedGitObject(root: string, expression: string, kind: "blob" | "commit", maximum?: number) {
  const result = runGit(
    root,
    ["cat-file", "--batch"],
    expression + "\n",
    undefined,
    maximum === undefined ? maximumGitResponse : maximum + 128,
  );
  if (maximum !== undefined && (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS")
    throw new InvalidInput("Invalid or oversized Git blob");
  const response = gitOutput(result);
  const separator = response.indexOf(10);
  const header = response.subarray(0, separator).toString();
  if (header === `${expression} missing`) return undefined;
  const [oid, type, size] = header.split(" ");
  const length = response.length - separator - 2;
  if (
    separator < 0 ||
    length < 0 ||
    !oid ||
    !objectId.test(oid) ||
    type !== kind ||
    !/^\d+$/.test(size ?? "") ||
    Number(size) !== length ||
    response.at(-1) !== 10
  )
    throw new InvalidInput(`Invalid Git ${kind} response`);
  if (maximum !== undefined && length > maximum) throw new InvalidInput("Invalid or oversized Git blob");
  return { oid, bytes: response.subarray(separator + 1, -1) };
}

/** Resolve the commit and read its original object in one Git process. */
export function readGitCommit(root: string, revision: string): { oid: string; bytes: Buffer } {
  const expression = `${revision}^{commit}`;
  if (/[\0\r\n]/u.test(expression) || expression.startsWith("-"))
    throw new InvalidInput("Invalid Git revision request");
  return repositoryCommitObject(root, revision, () => {
    const object = readFramedGitObject(root, expression, "commit");
    if (!object) throw new MissingResource(`Commit unavailable locally: ${revision}`);
    return object;
  });
}

/** Prime the current observation with immutable commit objects. */
export function prefetchGitCommits(root: string, revisions: readonly string[]): void {
  if (revisions.length < 2) return;
  if (revisions.some((revision) => !objectId.test(revision))) throw new InvalidInput("Invalid commit identity");
  readGitObjectBatch(root, revisions, 256 * 1024, { omitOversized: true }, undefined, "commit");
}

/** Resolve known commit identities to existing trees in one bounded local Git query. */
export function readCommitTrees(root: string, revisions: readonly string[]): Map<string, string> {
  const trees = new Map<string, string>();
  const selected = [...new Set(revisions)].filter((revision) => objectId.test(revision));
  if (!selected.length) return trees;
  const expressions = selected.map((revision) => revision + "^{tree}");
  const lines = gitBytes(root, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], expressions.join("\n") + "\n")
    .toString()
    .trimEnd()
    .split("\n");
  if (lines.length !== selected.length) throw new InvalidInput("Incomplete Git tree lookup");
  for (const [index, revision] of selected.entries()) {
    const [oid, kind] = required(lines[index], "Missing Git tree response").split(" ");
    if (oid && objectId.test(oid) && kind === "tree") trees.set(revision, oid);
  }
  return trees;
}
interface GitBlobOptions {
  retainedBytes?: number;
  omitOversized?: boolean;
  requirePresent?: boolean;
  readBatch?: (args: string[], input: string) => Buffer;
}

/** Resolve revision/path expressions in one batch and read each immutable blob only once. */
export function readGitObjects(
  root: string,
  requests: readonly string[],
  maximum = 2 * 1024 * 1024,
  options: GitBlobOptions = {},
): Map<string, Buffer | undefined> {
  return readGitObjectBatch(root, requests, maximum, options);
}

function readGitObjectBatch(
  root: string,
  requests: readonly string[],
  maximum: number,
  options: GitBlobOptions,
  knownSizes?: Map<string, number>,
  kind: "blob" | "commit" = "blob",
): Map<string, Buffer | undefined> {
  if (
    options.retainedBytes !== undefined &&
    (!Number.isSafeInteger(options.retainedBytes) || options.retainedBytes < 0)
  )
    throw new Error("Invalid retained Git read limit");
  const selected = [...new Set(requests)];
  if (selected.some((value) => !value || /[\0\r\n]/.test(value) || value.startsWith("-")))
    throw new Error("Invalid Git object request");
  if (!selected.length) return new Map();
  const cache = options.readBatch ? undefined : repositoryObjects(root, kind);
  const [single] = selected;
  // A small, exactly identified blob can use one bounded read for both its header and contents.
  if (
    selected.length === 1 &&
    single &&
    objectId.test(single) &&
    !options.readBatch &&
    !options.omitOversized &&
    options.retainedBytes === undefined &&
    Number.isSafeInteger(maximum) &&
    maximum >= 0 &&
    maximum <= 4 * 1024 * 1024
  ) {
    const cached = cache?.get(single);
    if (cached) {
      if (cached.length > maximum) throw new InvalidInput("Invalid or oversized Git blob");
      return new Map([[single, Buffer.from(cached)]]);
    }
    const object = readFramedGitObject(root, single, kind, maximum);
    if (!object && options.requirePresent) throw new MissingResource("Requested Git blob is unavailable locally");
    if (object) cache?.set(object.oid, object.bytes);
    return new Map([[single, object?.bytes]]);
  }
  const read = options.readBatch ?? ((args, input) => gitBytes(root, args, input));
  const identities = new Map<string, string | undefined>(),
    sizes = new Map<string, number>(),
    objects = new Map<string, Buffer>();
  const recordObject = (request: string, oid: string, size: number) => {
    knownSizes?.set(oid, size);
    if (size > maximum) {
      if (!options.omitOversized) throw new Error("Invalid or oversized Git blob");
      identities.set(request, undefined);
      return;
    }
    identities.set(request, oid);
    sizes.set(oid, size);
  };
  const unknown = selected.filter((request) => {
    const size = knownSizes?.get(request) ?? cache?.get(request)?.length;
    if (size === undefined) return true;
    recordObject(request, request, size);
    return false;
  });
  const rows = unknown.length
    ? read(["cat-file", "--batch-check"], unknown.join("\n") + "\n")
        .toString()
        .trimEnd()
        .split("\n")
    : [];
  if (rows.length !== unknown.length) throw new Error("Incomplete Git object metadata");
  for (const [index, row] of rows.entries()) {
    const request = required(unknown[index], "Missing Git object request");
    if (row === `${request} missing`) {
      if (options.requirePresent) throw new MissingResource("Requested Git blob is unavailable locally");
      identities.set(request, undefined);
      continue;
    }
    const [oid, type, text] = row.split(" "),
      size = Number(text);
    if (
      !oid ||
      !objectId.test(oid) ||
      (knownSizes && oid !== request) ||
      type !== kind ||
      !Number.isSafeInteger(size) ||
      size < 0
    )
      throw new Error("Invalid or oversized Git blob");
    recordObject(request, oid, size);
  }
  if (
    options.retainedBytes !== undefined &&
    [...sizes.values()].reduce((sum, size) => sum + size, 0) > options.retainedBytes
  )
    throw new Error(knownSizes ? "Git snapshot exceeds 64 MiB" : "Requested Git blobs exceed the retained read limit");
  const batches: Map<string, number>[] = [];
  let batch = new Map<string, number>(),
    allocated = 0;
  for (const [oid, size] of sizes) {
    const cached = cache?.get(oid);
    if (cached) {
      objects.set(oid, Buffer.from(cached));
      continue;
    }
    if (size + 128 > maximumGitResponse) throw new Error("Git object exceeds the buffered read limit");
    if (batch.size && allocated + size + 128 > 32 * 1024 * 1024) {
      batches.push(batch);
      batch = new Map();
      allocated = 0;
    }
    batch.set(oid, size);
    allocated += size + 128;
  }
  if (batch.size) batches.push(batch);
  for (const batch of batches) {
    const bytes = read(["cat-file", "--batch"], [...batch.keys()].join("\n") + "\n");
    let offset = 0;
    for (const [oid, size] of batch) {
      const end = bytes.indexOf(10, offset);
      if (
        end < offset ||
        bytes.subarray(offset, end).toString() !== `${oid} ${kind} ${String(size)}` ||
        bytes[end + 1 + size] !== 10
      )
        throw new Error("Invalid Git object batch");
      const body = Buffer.from(bytes.subarray(end + 1, end + 1 + size));
      objects.set(oid, body);
      cache?.set(oid, body);
      offset = end + size + 2;
    }
    if (offset !== bytes.length) throw new Error("Unexpected Git object batch data");
  }
  return new Map(
    selected.map((request) => {
      const oid = identities.get(request);
      return [request, oid ? objects.get(oid) : undefined];
    }),
  );
}

export interface GitDelta {
  path: string;
  mode: string;
  oid: string;
}
const rawDiffOptions = ["--raw", "--no-abbrev", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "-z"];

function delta(header: string, path: string | undefined): GitDelta {
  const [, mode, , oid, status] = header.slice(1).split(" ");
  if (!header.startsWith(":") || !mode || !oid || !path) throw new Error("invalid changed Git entry");
  if (status === "U") throw new Error(`resolve the conflicted index entry: ${path}`);
  return { path, mode, oid };
}

/** Batch root and single-parent commits. Merge callers supply their explicit parent comparisons. */
export function readCommitDeltas(
  root: string,
  commits: readonly { revision: string; parents: readonly string[] }[],
): ReadonlyMap<string, GitDelta[]> {
  const result = new Map(commits.map(({ revision }) => [revision, [] as GitDelta[]]));
  if (
    commits.some(
      ({ revision, parents }) => parents.length > 1 || [revision, ...parents].some((oid) => !objectId.test(oid)),
    )
  )
    throw new InvalidInput("Invalid commit delta identity");
  if (!commits.length) return result;
  const capture = runGit(
    root,
    ["diff-tree", "--stdin", "--root", "-r", ...rawDiffOptions],
    commits.map(({ revision, parents }) => [revision, ...parents].join(" ")).join("\n") + "\n",
  );
  // A large batch can exceed the output limit even when its individual comparisons fit.
  if ((capture.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS") return new Map();
  const fields = gitOutput(capture).toString().split("\0");
  let current: GitDelta[] | undefined;
  for (let i = 0; i < fields.length - 1; i++) {
    const field = required(fields[i], "Missing Git delta field");
    if (objectId.test(field)) current = required(result.get(field), "Unexpected Git commit delta");
    else required(current, "Missing Git delta identity").push(delta(field, fields[++i]));
  }
  return result;
}
function headAt(root: string): string {
  const result = spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", "HEAD"], { encoding: "utf8" });
  if (result.error || (result.status !== 0 && result.status !== 1)) throw new Error("cannot inspect committed records");
  return result.stdout.trim();
}
const trees = new WeightedCache<ReadonlyMap<string, GitEntry>>(16 * 1024 * 1024);
export function readGitTree(
  root: string,
  tree: string,
  read = (args: string[]) => gitBytes(root, args).toString(),
): Map<string, GitEntry> {
  // Mutable refs must be resolved by Git; only object identities can outlive an acquisition.
  const key = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(tree) ? JSON.stringify([resolve(root), tree]) : undefined;
  const cached = key ? trees.get(key) : undefined;
  if (cached) return new Map([...cached].map(([path, entry]) => [path, { ...entry }]));
  const result = new Map<string, GitEntry>();
  for (const row of read(["ls-tree", "-r", "-z", "--full-tree", tree]).split("\0")) {
    if (!row) continue;
    const tab = row.indexOf("\t"),
      [mode, , oid] = row.slice(0, tab).split(" ");
    if (tab < 0 || !mode || !oid) throw new Error("invalid Git tree entry");
    result.set(row.slice(tab + 1), { mode, oid });
  }
  if (key) {
    const cost = retainedBytes(result, 16 * 1024 * 1024) + key.length * 2;
    if (cost <= 16 * 1024 * 1024)
      trees.set(key, new Map([...result].map(([path, entry]) => [path, { ...entry }])), cost);
  }
  return result;
}
/** Capture committed files, optionally include staged changes, and batch bounded immutable-object reads. */
export class GitSnapshot {
  readonly head: string;
  readonly committed: ReadonlyMap<string, GitEntry>;
  readonly staged: ReadonlyMap<string, GitEntry>;
  readonly changedPaths: string[];
  private readonly objects = new Map<string, Buffer>();
  private readonly sizes = new Map<string, number>();
  private retained = 0;
  constructor(
    readonly root: string,
    options: { staged?: boolean; tree?: string; base?: string; deltas?: readonly GitDelta[] } = {},
  ) {
    const head =
      options.base === undefined || (options.base === "" && !options.tree && options.staged !== false)
        ? headAt(root)
        : "";
    this.head = options.base ?? head;
    this.committed = this.head ? readGitTree(root, this.head) : new Map<string, GitEntry>();
    let deltas = options.deltas;
    if (!options.deltas && options.staged !== false) {
      const fields = gitBytes(root, [
        "diff",
        ...(options.tree
          ? [this.head || gitBytes(root, ["mktree"], "").toString().trim(), options.tree]
          : [
              "--cached",
              ...(this.head ? [this.head] : head ? [gitBytes(root, ["mktree"], "").toString().trim()] : []),
            ]),
        "--ita-invisible-in-index",
        ...rawDiffOptions,
      ])
        .toString()
        .split("\0");
      const parsed: GitDelta[] = [];
      for (let i = 0; i < fields.length - 1; i += 2)
        parsed.push(delta(required(fields[i], "Missing staged entry"), fields[i + 1]));
      deltas = parsed;
    }
    this.changedPaths = deltas?.map(({ path }) => path) ?? [];
    const staged = deltas?.length ? new Map(this.committed) : undefined;
    if (staged) {
      for (const { path, mode, oid } of deltas ?? []) {
        if (mode === "000000") staged.delete(path);
        else staged.set(path, { mode, oid });
      }
    }
    this.staged = staged ?? this.committed;
  }
  prefetch(requested: readonly string[], maximum = 2 * 1024 * 1024): void {
    const ids = [...new Set(requested)].filter((oid) => !this.objects.has(oid));
    if (!ids.length) return;
    if (ids.some((oid) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))) throw new Error("invalid Git object identity");
    const objects = readGitObjectBatch(
      this.root,
      ids,
      maximum,
      {
        retainedBytes: maximumGitResponse - this.retained,
        omitOversized: true,
        requirePresent: true,
      },
      this.sizes,
    );
    for (const [oid, body] of objects) {
      if (!body) continue;
      this.objects.set(oid, body);
      this.retained += body.length;
    }
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
    if (base) run(["read-tree", base]);
    return action(run);
  });
}

/** Materialize one immutable tree without changing the repository's index or checkout. */
export function materializeGitTree(root: string, tree: string, destination: string, paths?: readonly string[]): void {
  if (paths && !paths.length) return;
  withPrivateIndex(root, tree, (run) => {
    run(
      [
        "-c",
        "core.symlinks=true",
        "checkout-index",
        ...(paths ? ["-z", "--stdin"] : ["--all"]),
        "--prefix=" + resolve(destination).replaceAll("\\", "/") + "/",
      ],
      paths ? paths.join("\0") + "\0" : undefined,
    );
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
export function workingReviewTree(root: string, base = headAt(root)): string {
  return withPrivateIndex(root, base, (run) => {
    run(["add", "-A", "--", "."]);
    return run(["write-tree"]);
  });
}
function withRefreshedReviewIndex<T>(
  root: string,
  tree: string,
  paths: readonly string[],
  unfiltered: boolean,
  read: Parameters<typeof withPrivateIndex<T>>[2],
): T {
  return withPrivateIndex(root, tree, (run) => {
    const names = paths.join("\0") + "\0";
    if (unfiltered) {
      const attributes = run(["check-attr", "-z", "--stdin", "filter"], names).split("\0");
      if (
        attributes.length !== paths.length * 3 + 1 ||
        paths.some(
          (path, index) =>
            attributes[index * 3] !== path || !["unset", "unspecified"].includes(attributes[index * 3 + 2] ?? ""),
        )
      )
        throw new InvalidInput("Review paths use a configured content filter");
    }
    if (paths.length) run(["--literal-pathspecs", "add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], names);
    return read(run);
  });
}

/** Refresh only the paths in a retained proof using Git's worktree normalization. */
export function refreshReviewPaths(root: string, tree: string, paths: readonly string[]): string {
  if (!paths.length) return tree;
  return withRefreshedReviewIndex(root, tree, paths, false, (run) => run(["write-tree"]));
}

/** Read normalized entries without persisting a transient tree. */
export function refreshedReviewEntries(root: string, tree: string, paths: readonly string[], unfiltered = false) {
  return withRefreshedReviewIndex(root, tree, paths, unfiltered, (run) => {
    const entries = new Map<string, GitEntry>();
    for (const row of run(["ls-files", "--stage", "-z"]).split("\0")) {
      if (!row) continue;
      const tab = row.indexOf("\t");
      const [mode, oid, stage] = row.slice(0, tab).split(" ");
      if (tab < 0 || !mode || !oid || stage !== "0") throw new Error("Invalid normalized Git index entry");
      entries.set(row.slice(tab + 1), { mode, oid });
    }
    return entries;
  });
}
/** Write a tree using a private copy of the selected index, preserving the live index and lock. */
export function stagedReviewTree(root: string): string {
  const selected = required(gitPaths(root, ["index"])[0], "Missing Git index path");
  return withReviewScratch((directory) => {
    const index = join(directory, "index");
    try {
      copyFileSync(selected, index);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const env = { GIT_INDEX_FILE: index };
    const tree = runGit(root, ["write-tree"], undefined, env);
    if (!tree.error && tree.status !== 0) {
      const unmerged = runGit(root, ["ls-files", "--unmerged", "-z"], undefined, env);
      if (!unmerged.error && unmerged.status === 0) {
        const first = unmerged.stdout.toString().split("\0", 1)[0] ?? "";
        const separator = first.indexOf("\t");
        if (separator !== -1) throw new Error(`resolve the conflicted index entry: ${first.slice(separator + 1)}`);
      }
    }
    return gitOutput(tree).toString().trim();
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
