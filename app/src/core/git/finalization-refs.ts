import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { gitBytes } from "./git-snapshot.js";
import { gitOperationMarkers, gitRefFormat, gitRevision } from "./refs.js";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";
import { readTaskQueue, TaskExecution } from "../tasks/task-queue.js";
import { isConfiguredCommitAuthor } from "./commit-writing.js";
import { signatureKey, signReplacementTag, unsignedTagPayload, verifiedSignatureKey } from "./signatures.js";
import { records, string } from "../runtime/values.mjs";
import { diagnostic, DiagnosticOperation, DiagnosticOutcome, LogLevel } from "../diagnostics/diagnostics.mjs";

export interface FinalizationRef {
  name: string;
  before: string;
  target: string;
}
export interface PreparedRefMove {
  name: string;
  before: string;
  after: string;
}

export function rewriteRevision(value: unknown): string {
  const oid = string(value, "Missing prepared Git object");
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(oid)) throw new InvalidInput("Invalid prepared Git object");
  return oid;
}

export function decodeRefMoves(value: unknown): PreparedRefMove[] {
  const seen = new Set<string>();
  return records(value, "Invalid prepared Git reference updates").map((entry) => {
    const name = string(entry.name, "Missing prepared Git reference");
    if (!/^refs\/(?:heads|tags)\/[^\s\0~^:?*[\\]+$/.test(name) || seen.has(name))
      throw new InvalidInput("Invalid or duplicate prepared Git reference");
    seen.add(name);
    return { name, before: rewriteRevision(entry.before), after: rewriteRevision(entry.after) };
  });
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

export function rewriteCheckout(root: string, checkout: string): string {
  if (resolve(root) === resolve(checkout)) return checkout;
  if (!finalizationCheckouts(root).some(({ directory }) => resolve(directory) === resolve(checkout)))
    throw new StateConflict(`The original rewrite checkout is unavailable: ${checkout}`);
  return checkout;
}

export function activeGitOperation(root: string): boolean {
  const metadata = gitBytes(root, ["rev-parse", "--absolute-git-dir"]).toString().trim();
  return [...gitOperationMarkers, "index.lock"].some((name) => existsSync(join(metadata, name)));
}

/** Check every affected checkout so a ref-only update never interrupts a Git operation. */
export function checkFinalizationCheckouts(root: string, refs: ReadonlySet<string>): void {
  for (const { directory, branch } of finalizationCheckouts(root)) {
    // Rebases detach HEAD while retaining the original branch in the operation's metadata.
    if (branch && !refs.has(branch)) continue;
    if (activeGitOperation(directory))
      throw new StateConflict(`Finish the active Git operation in ${directory} before rewriting history`);
    if (branch && readTaskQueue(directory).entries.some((entry) => entry.state === TaskExecution.Active))
      throw new StateConflict(`Wait for the active Workbench task in ${directory} before rewriting history`);
  }
}

interface TagAnnotation {
  contents: Buffer;
  signer?: string;
}

/** Capture and verify annotation bytes before preparing any backup refs. */
export function finalizationTagContents(
  root: string,
  ref: FinalizationRef,
  finalization?: { author: string | undefined; unattended: boolean },
): TagAnnotation[] {
  const tags: TagAnnotation[] = [];
  for (let oid = ref.before; oid !== ref.target;) {
    if (tags.length >= 16) throw new StateConflict(`Too many annotated tag targets to update ${ref.name}`);
    const originalTag = gitBytes(root, ["cat-file", "tag", oid]),
      contents = unsignedTagPayload(originalTag);
    const signed = contents.length !== originalTag.length;
    let signer: string | undefined;
    if (signed) {
      if (finalization) {
        const header = contents.subarray(0, contents.indexOf("\n\n")).toString();
        const tagger = /^tagger (.+)$/m.exec(header)?.[1] ?? "";
        if (!isConfiguredCommitAuthor(tagger, finalization.author))
          throw new StateConflict(`The tagger of ${ref.name} differs from the configured Git author`);
        if (!finalization.unattended) signer = signatureKey(root, "tag", oid);
      } else signer = verifiedSignatureKey(root, "tag", oid);
    }
    const newline = contents.indexOf(10),
      original = /^object ([a-f0-9]{40}(?:[a-f0-9]{24})?)$/.exec(contents.subarray(0, newline).toString())?.[1];
    if (!original) throw new StateConflict(`Cannot preserve the annotation for ${ref.name}`);
    tags.push({
      contents: contents.subarray(newline),
      ...(signer ? { signer } : {}),
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
  signingRequired = true,
): string {
  let target = replacement;
  for (const { contents, signer } of tags) {
    const payload = Buffer.concat([Buffer.from(`object ${target}`), contents]);
    const signed = signer ? signReplacementTag(root, target, payload, signer, signingRequired) : undefined;
    const after = signed ?? gitBytes(root, ["mktag"], payload).toString().trim();
    keep(after);
    target = after;
  }
  return target;
}

function prepareRefTransaction(root: string, moves: PreparedRefMove[], recovering: boolean) {
  const observed = new Map(
    gitBytes(root, ["for-each-ref", "--format=%(refname) %(objectname) %(symref)", "refs/heads", "refs/tags"])
      .toString()
      .trim()
      .split("\n")
      .map((line) => {
        const [name, object, symbolic] = line.split(" ");
        return [name, { object, symbolic }] as const;
      }),
  );
  let pending = 0;
  const changes = moves.flatMap(({ name, before, after }) => {
    const actual = observed.get(name);
    if (!actual || actual.symbolic || (actual.object !== before && (!recovering || actual.object !== after)))
      throw new StateConflict(
        `${name} ${actual ? "changed" : "was deleted"}. Original and replacement histories remain recoverable.`,
      );
    if (actual.object === after) return ["option no-deref", `verify ${name} ${after}`];
    pending++;
    return ["option no-deref", `update ${name} ${after} ${before}`];
  });
  return { changes, pending };
}

/** Recheck both ends of a prepared transaction. The callback authorizes and journals any remaining writes. */
export function activatePreparedRefs(
  root: string,
  moves: PreparedRefMove[],
  recovering: boolean,
  authorize: () => void,
): boolean {
  let transaction = prepareRefTransaction(root, moves, recovering);
  if (transaction.pending) {
    checkFinalizationCheckouts(root, new Set(moves.map((move) => move.name)));
    authorize();
    // Git's expected object check also matches a symbolic ref resolving to the same object.
    transaction = prepareRefTransaction(root, moves, recovering);
  }
  gitBytes(root, ["update-ref", "--stdin"], `start\n${transaction.changes.join("\n")}\nprepare\ncommit\n`);
  return transaction.pending > 0 && transaction.pending < moves.length && gitRefFormat(root) === "files";
}

/** Protect the completed preparation before updating any user branch or tag. */
export function protectRewriteObjects(root: string, namespace: string, objects: ReadonlyMap<string, string>): void {
  const creates = [...objects].map(([name, oid]) => `create ${namespace}/${name} ${oid}`);
  gitBytes(root, ["update-ref", "--stdin"], `start\n${creates.join("\n")}\nprepare\ncommit\n`);
}

export function reportRefRecovery(operation: "signing" | "finalization", partial: boolean): void {
  diagnostic(
    partial ? LogLevel.Warn : LogLevel.Info,
    DiagnosticOperation.Command,
    DiagnosticOutcome.Recovered,
    { command: operation },
    undefined,
    partial
      ? `Finished interrupted ${operation} after Git's files format updated only some refs. Consider reftable for atomic updates to shared branches and tags. See the Workbench records guide.`
      : `Recovered interrupted ${operation}.`,
  );
}
