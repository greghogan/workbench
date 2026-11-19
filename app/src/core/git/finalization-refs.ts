import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { gitBytes } from "./git-snapshot.js";
import { gitRevision } from "./refs.js";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";
import { readTaskQueue, TaskExecution } from "../tasks/task-queue.js";
import { signReplacementTag, unsignedTagPayload, verifiedSignatureKey } from "./signatures.js";

export interface FinalizationRef {
  name: string;
  before: string;
  target: string;
}
export interface FinalizationMove {
  name: string;
  before: string;
  after: string;
}

export function finalizationBranch(root: string): string | undefined {
  const selected = spawnSync("git", ["-C", root, "symbolic-ref", "--quiet", "HEAD"], { encoding: "utf8" });
  if (selected.error || (selected.status !== 0 && selected.status !== 1))
    throw new StateConflict("Cannot inspect the finalization branch");
  if (selected.status === 1) return undefined;
  const branch = selected.stdout.trim();
  if (!branch.startsWith("refs/heads/")) throw new StateConflict("Finalization requires a local branch");
  return branch;
}

/** Git stores fetched tags in a shared namespace, without recording which remote owns a tag name. */
export function checkFinalizationTags(root: string, references: readonly { name: string }[]): void {
  const tags = references.map(({ name }) => name).filter((name) => name.startsWith("refs/tags/"));
  if (!tags.length) return;
  const remotes = gitBytes(root, ["remote"]).toString().trim().split("\n").filter(Boolean);
  for (const remote of remotes)
    for (let index = 0; index < tags.length; index += 80) {
      const result = spawnSync(
        "git",
        ["-C", root, "ls-remote", "--refs", "--tags", "--", remote, ...tags.slice(index, index + 80)],
        {
          encoding: "utf8",
          timeout: 10_000,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" },
        },
      );
      if (result.error || result.status !== 0)
        throw new StateConflict(
          `Cannot check published tags on ${remote}; restore remote access before finalizing history`,
        );
      const published = result.stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((row) => row.split("\t")[1]);
      if (published.length) throw new StateConflict(`Preserve published tag(s) on ${remote}: ${published.join(", ")}`);
    }
}

/** A shared ancestor may require updating a local branch or tag outside the current checkout. */
export function finalizationRefs(root: string, selected: string[]): FinalizationRef[] {
  const refs = new Map<string, string>();
  for (let index = 0; index < selected.length; index += 80) {
    const rows = gitBytes(root, [
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      ...selected.slice(index, index + 80).map((id) => `--contains=${id}`),
      "refs/heads",
      "refs/tags",
    ])
      .toString()
      .trim();
    for (const row of rows ? rows.split("\n") : []) {
      const [name, oid] = row.split(" ");
      if (!name || !oid) throw new InvalidInput("Invalid local branch or tag");
      const earlier = refs.get(name);
      if (earlier && earlier !== oid) throw new StateConflict(`Reference changed during inspection: ${name}`);
      refs.set(name, oid);
    }
  }
  return [...refs]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, before]) => {
      const target = name.startsWith("refs/tags/") ? gitRevision(root, `${before}^{commit}`) : before;
      if (!target) throw new StateConflict(`Cannot inspect tag target: ${name}`);
      return { name, before, target };
    });
}

export function finalizationCheckouts(root: string) {
  const entries = gitBytes(root, ["worktree", "list", "--porcelain", "-z"]).toString().split("\0\0");
  return entries.flatMap((entry) => {
    const fields = entry.split("\0"),
      directory = fields.find((field) => field.startsWith("worktree "))?.slice(9),
      branch = fields.find((field) => field.startsWith("branch "))?.slice(7);
    if (!directory || fields.includes("bare") || fields.some((field) => field.startsWith("prunable"))) return [];
    return [{ directory, branch }];
  });
}

/** Check every affected checkout so a ref-only update never interrupts a Git operation. */
export function checkFinalizationCheckouts(root: string, refs: ReadonlySet<string>): void {
  const active = [
    "rebase-merge",
    "rebase-apply",
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "sequencer",
    "index.lock",
  ];
  for (const { directory, branch } of finalizationCheckouts(root)) {
    // Rebases detach HEAD while retaining the original branch in the operation's metadata.
    if (branch && !refs.has(branch)) continue;
    const metadata = gitBytes(directory, ["rev-parse", "--absolute-git-dir"]).toString().trim();
    if (active.some((name) => existsSync(join(metadata, name))))
      throw new StateConflict(`Finish the active Git operation in ${directory} before finalizing history`);
    if (branch && readTaskQueue(directory).entries.some((entry) => entry.state === TaskExecution.Active))
      throw new StateConflict(`Wait for the active Workbench task in ${directory} before finalizing history`);
  }
}

interface TagAnnotation {
  contents: Buffer;
  signer?: string;
}

/** Capture and verify annotation bytes before preparing any backup refs. */
export function finalizationTagContents(root: string, ref: FinalizationRef, unattended: boolean): TagAnnotation[] {
  const tags: TagAnnotation[] = [];
  for (let oid = ref.before; oid !== ref.target;) {
    if (tags.length >= 16) throw new StateConflict(`Too many annotated tag targets to update ${ref.name}`);
    const originalTag = gitBytes(root, ["cat-file", "tag", oid]),
      contents = unsignedTagPayload(originalTag);
    const signed = contents.length !== originalTag.length;
    if (signed && unattended)
      throw new StateConflict(
        `${ref.name} needs signing from the developer's terminal. Inspect 'workbench commit finalize'.`,
      );
    const newline = contents.indexOf(10),
      original = /^object ([a-f0-9]{40}(?:[a-f0-9]{24})?)$/.exec(contents.subarray(0, newline).toString())?.[1];
    if (!original) throw new StateConflict(`Cannot preserve the annotation for ${ref.name}`);
    tags.push({
      contents: contents.subarray(newline),
      ...(signed ? { signer: verifiedSignatureKey(root, "tag", oid) } : {}),
    });
    oid = original;
  }
  return tags.reverse();
}

export function retargetFinalizationTag(
  root: string,
  tags: TagAnnotation[],
  replacement: string,
  keep: (oid: string) => void,
): string {
  let target = replacement;
  for (const { contents, signer } of tags) {
    const payload = Buffer.concat([Buffer.from(`object ${target}`), contents]);
    const after = signer
      ? signReplacementTag(root, target, payload, signer)
      : gitBytes(root, ["mktag"], payload).toString().trim();
    keep(after);
    target = after;
  }
  return target;
}

export function activateFinalizationRefs(root: string, moves: FinalizationMove[]): void {
  const actual = moves.map((move) => gitRevision(root, move.name));
  if (moves.every((move, index) => move.after === actual[index])) return;
  if (moves.some((move, index) => move.before !== actual[index]))
    throw new StateConflict("A branch or tag changed; original and replacement histories remain recoverable");
  checkFinalizationCheckouts(root, new Set(moves.map((move) => move.name)));
  const changes = moves.map(({ name, before, after }) => `update ${name} ${after} ${before}`);
  gitBytes(root, ["update-ref", "--stdin"], `start\n${changes.join("\n")}\nprepare\ncommit\n`);
}
