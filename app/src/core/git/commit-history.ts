import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { InvalidInput } from "../runtime/input-errors.js";
import { readBoundedFile } from "../runtime/file-reads.js";

export const provisionalTrailer = "Workbench-Provisional";
export const provisionalEnvironment = "WORKBENCH_PROVISIONAL_TREE";

function git(root: string, args: string[], input?: string): string {
  const result = spawnSync(
    "git",
    [
      "-C",
      root,
      "--no-replace-objects",
      "-c",
      "trailer.separators=:",
      "-c",
      `trailer.workbench-provisional.key=${provisionalTrailer}`,
      ...args,
    ],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" },
      ...(input === undefined ? {} : { input }),
    },
  );
  if (result.error || result.status !== 0)
    throw new Error("Cannot inspect commit review markers", { cause: result.error ?? new Error(result.stderr.trim()) });
  return result.stdout;
}

function parsedProvisionalTrailers(trailers: string): boolean {
  const markers = trailers
    .split(/\r?\n/)
    .filter((line) => line.slice(0, line.indexOf(":")).toLowerCase() === provisionalTrailer.toLowerCase());
  if (!markers.length) return false;
  if (markers.length !== 1 || markers[0]?.slice(markers[0].indexOf(":") + 1).trim() !== "true")
    throw new InvalidInput(`The reserved ${provisionalTrailer} trailer must appear once with value true`);
  return true;
}

export function provisionalMessage(root: string, message: string): boolean {
  return parsedProvisionalTrailers(git(root, ["interpret-trailers", "--parse"], message));
}

/** Preserve the message and other trailers verbatim when removing Workbench's marker. */
export function removeProvisionalTrailer(root: string, message: string): string {
  const line = new RegExp(`^${provisionalTrailer}[ \\t]*:[ \\t]*(?:\\r?\\n[ \\t]+)*true[ \\t]*(?:\\r?\\n|$)`, "gim");
  for (const marker of [...message.matchAll(line)].reverse()) {
    const before = message.slice(0, marker.index),
      after = message.slice(marker.index + marker[0].length);
    const without = (after === "" ? before.replace(/(\r?\n)\r?\n$/, "$1") : before) + after;
    // A matching line in the message body or patch can coexist with the actual Git trailer.
    if (!provisionalMessage(root, without)) return without;
  }
  throw new InvalidInput(
    `Cannot remove the reserved ${provisionalTrailer} trailer without changing the commit message`,
  );
}

/** Read the second and subsequent parents of an in-progress merge in Git's order. */
export function pendingMergeParents(root: string): string[] {
  const location = resolve(root, git(root, ["rev-parse", "--git-path", "MERGE_HEAD"]).trim());
  if (!existsSync(location)) return [];
  const parents = readBoundedFile(location, 16 * 1024, "merge parents")
    .toString()
    .trim()
    .split(/\r?\n/);
  if (parents.length >= 256 || parents.some((parent) => !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(parent)))
    throw new InvalidInput("Invalid Git merge parents");
  return parents;
}

/** A page of history is one Git read, without opening one process per commit. */
export function commitSummaries(root: string, start: string, task?: { path: string; skip: number; after?: string }) {
  const { path, skip = 0 } = task ?? {};
  const fields = git(root, [
    "log",
    "--no-show-signature",
    "--first-parent",
    `--max-count=${String(path ? skip + 51 : 51)}`,
    `--skip=${String(path ? 0 : skip)}`,
    "-z",
    `--format=%H%x00%s%x00%an <%ae>%x00%(trailers:key=${provisionalTrailer},only)`,
    start,
    ...(task?.after ? [`^${task.after}`] : []),
    ...(path ? ["--follow", "--remove-empty", "--", path] : []),
  ]).split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 4) throw new InvalidInput("Invalid commit summary page");
  const result: { revision: string; subject: string; author: string; provisional: boolean }[] = [];
  for (let offset = 0; offset < fields.length; offset += 4) {
    const revision = fields[offset],
      subject = fields[offset + 1],
      author = fields[offset + 2],
      trailers = fields[offset + 3];
    if (
      !revision ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision) ||
      subject === undefined ||
      author === undefined ||
      trailers === undefined
    )
      throw new InvalidInput("Invalid commit summary");
    result.push({ revision, subject, author, provisional: parsedProvisionalTrailers(trailers) });
  }
  // Git applies --skip before following renames; retain that context before slicing the requested task page.
  return path ? result.slice(skip) : result;
}

export function provisionalCommitRequested(tree: string, environment = process.env): boolean {
  const requested = environment[provisionalEnvironment];
  if (requested === undefined) return false;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(requested) || requested !== tree)
    throw new InvalidInput("The staged snapshot changed during provisional commit preparation; inspect and retry");
  return true;
}

interface HistoryEntry {
  commit: string;
  parent: string | undefined;
  provisional: boolean;
}
function history(root: string, args: string[]): HistoryEntry[] {
  const fields = git(root, [
    "log",
    "--no-show-signature",
    "-z",
    `--format=%H%x00%P%x00%(trailers:key=${provisionalTrailer},only)`,
    ...args,
  ]).split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 3) throw new Error("Invalid commit review history");
  const entries: HistoryEntry[] = [];
  for (let index = 0; index < fields.length; index += 3) {
    const commit = fields[index],
      parent = fields[index + 1]?.split(" ").find((value) => value.length > 0);
    if (!commit || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error("Invalid commit review identity");
    entries.push({ commit, parent, provisional: Boolean(fields[index + 2]?.trim()) });
  }
  return entries;
}

/** Provisional commits preserve local work but never establish an accepted record baseline. */
export function reviewedCommit(root: string, head: string): string {
  let cursor = head,
    count = 1;
  while (cursor) {
    const entries = history(root, ["--first-parent", `--max-count=${String(count)}`, cursor]);
    for (const entry of entries) if (!entry.provisional) return entry.commit;
    cursor = entries.at(-1)?.parent ?? "";
    count = 32;
  }
  return "";
}

/** Retained checkpoints in parent order; finalized ancestry is outside the pending review set. */
function markedCommits(root: string, revisions: string[]): string[] {
  const entries = history(root, [
    "--reverse",
    "--topo-order",
    "--max-count=1001",
    "--regexp-ignore-case",
    `--grep=^${provisionalTrailer}:`,
    ...revisions,
  ]);
  if (entries.length > 1000)
    throw new InvalidInput("Arrange at most 1000 retained commits before finalizing this review set");
  return entries.filter((entry) => entry.provisional).map((entry) => entry.commit);
}
export function provisionalCommits(root: string, tip = "HEAD"): string[] {
  return markedCommits(root, [git(root, ["rev-parse", "--verify", `${tip}^{commit}`]).trim()]);
}
export function retainedProvisionalCommits(root: string): string[] {
  const heads = git(root, ["for-each-ref", "--format=%(objectname)", "refs/heads"]).trim().split("\n").filter(Boolean),
    selected = spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", "HEAD"], { encoding: "utf8" });
  if (selected.error || (selected.status !== 0 && selected.status !== 1))
    throw new InvalidInput("Cannot inspect retained history");
  const revisions = [...new Set([...heads, ...(selected.status === 0 ? [selected.stdout.trim()] : [])])];
  return revisions.length ? markedCommits(root, revisions) : [];
}

export function checkProvisionalPush(root: string, tip: string, remote: string): void {
  if ([tip, remote].some((value) => !value || value.startsWith("-") || /[\0\r\n]/.test(value)))
    throw new InvalidInput("Invalid outgoing commit revision");
  const pending = history(root, [tip, ...(/^0+$/.test(remote) ? [] : ["--not", remote])]).filter(
    (entry) => entry.provisional,
  );
  if (pending.length)
    throw new InvalidInput(
      `Cannot push ${String(pending.length)} provisional ${pending.length === 1 ? "commit" : "commits"}: ${pending
        .slice(0, 10)
        .map((entry) => entry.commit.slice(0, 12))
        .join(
          ", ",
        )}. Complete review and inspect local finalization with 'workbench commit finalize'. Retry the push after those commits have been finalized.`,
    );
}
