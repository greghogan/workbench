import { spawnSync } from "node:child_process";
import { InvalidInput } from "./input-errors.js";

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
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      ...(input === undefined ? {} : { input }),
    },
  );
  if (result.error || result.status !== 0)
    throw new Error("Cannot inspect commit review markers", { cause: result.error ?? new Error(result.stderr.trim()) });
  return result.stdout;
}

export function provisionalMessage(root: string, message: string): boolean {
  const markers = git(root, ["interpret-trailers", "--parse"], message)
    .split(/\r?\n/)
    .filter((line) => line.slice(0, line.indexOf(":")).toLowerCase() === provisionalTrailer.toLowerCase());
  if (!markers.length) return false;
  if (markers.length !== 1 || markers[0]?.slice(markers[0].indexOf(":") + 1).trim() !== "true")
    throw new InvalidInput(`The reserved ${provisionalTrailer} trailer must appear once with value true`);
  return true;
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

export function checkProvisionalPush(root: string, tip: string, remote: string): void {
  if ([tip, remote].some((value) => !value || value.startsWith("-") || /[\0\r\n]/.test(value)))
    throw new InvalidInput("Invalid outgoing commit revision");
  const pending = history(root, [tip, ...(/^0+$/.test(remote) ? [] : ["--not", remote])]).filter(
    (entry) => entry.provisional,
  );
  if (pending.length)
    throw new InvalidInput(
      `Cannot push ${String(pending.length)} provisional commit(s): ${pending
        .slice(0, 10)
        .map((entry) => entry.commit.slice(0, 12))
        .join(", ")}. Complete human review and consolidate or rewrite all provisional commits before pushing.`,
    );
}
