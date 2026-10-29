import { GitSnapshot } from "./git-snapshot.js";
import { readBoundedFile } from "./file-reads.js";
import { diagnostic, LogLevel, DiagnosticOperation, DiagnosticOutcome } from "./diagnostics.js";
import { InvalidInput, StateConflict } from "./input-errors.js";
import { required } from "./invariants.js";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, openSync, closeSync, readSync, fstatSync } from "node:fs";
import { resolve } from "node:path";
import { writeAtomic } from "../scripts/file-publication.mjs";
import { readProjects, readConfig } from "./project-configuration.js";
import { proposedRecordTrees, classifyRecordPath } from "./staged-records.js";
import { ownedPath } from "./paths.js";
import { withCacheLockSync } from "./cache-lock.js";

export interface ReviewChange {
  path: string;
  before: string;
  after: string;
  charter: boolean;
}
const changesDigest = (changes: unknown[]): string =>
  createHash("sha256").update(JSON.stringify(changes)).digest("hex");
export function reviewGit(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.error || result.status !== 0)
    throw new Error(`cannot inspect proposed review: ${String(result.stderr || result.error)}`);
  return result.stdout;
}
export const ReviewSource = { Staged: "staged", Working: "working" } as const;
export type ReviewSource = (typeof ReviewSource)[keyof typeof ReviewSource];
export function reviewSource(value: string | null): ReviewSource {
  if (value === null || value === ReviewSource.Staged) return ReviewSource.Staged;
  if (value === ReviewSource.Working) return ReviewSource.Working;
  throw new InvalidInput("select working or staged review contents");
}
export function reviewHead(root: string): string {
  const result = spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", "HEAD"], { encoding: "utf8" });
  if (result.error || (result.status !== 0 && result.status !== 1)) throw new Error("cannot inspect review HEAD");
  return result.stdout.trim();
}
/** Hash raw bytes in bounded memory; reading a workspace must never run Git clean filters. */
function workingBlob(file: string, algorithm: string): string {
  const descriptor = openSync(file, "r");
  try {
    const before = fstatSync(descriptor);
    const hash = createHash(algorithm).update(`blob ${String(before.size)}\0`);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!count) throw new StateConflict("working file changed while reading; refresh the review");
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new StateConflict("working file changed while reading; refresh the review");
    return hash.digest("hex");
  } finally {
    closeSync(descriptor);
  }
}
export function proposedReview(
  root: string,
  source: ReviewSource = ReviewSource.Staged,
  snapshot = new GitSnapshot(root),
) {
  const changes: ReviewChange[] = [];
  const trees = proposedRecordTrees(root, snapshot);
  const working = source === ReviewSource.Working;
  const head = snapshot.head;
  const scopes = working ? readProjects(root).map((project) => project.path) : [];
  const collections = working ? (readConfig(root).collections?.sources ?? []).map((pin) => pin.id) : [];
  if (working) {
    const algorithm = reviewGit(root, ["rev-parse", "--show-object-format"]).trim() === "sha256" ? "sha256" : "sha1";
    const zero = "0".repeat(algorithm === "sha256" ? 64 : 40);
    const headTree = head ? trees[1] : undefined;
    const candidates = new Set([
      ...trees.flatMap((tree) => [...tree.entries.keys()]),
      ...reviewGit(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean),
    ]);
    const modeConfig = spawnSync("git", ["-C", root, "config", "--get", "--bool", "core.filemode"], {
      encoding: "utf8",
    });
    if (modeConfig.error || (modeConfig.status !== 0 && modeConfig.status !== 1))
      throw new Error("cannot inspect Git file mode policy");
    const fileMode = modeConfig.status === 0 ? modeConfig.stdout.trim() === "true" : process.platform !== "win32";
    for (const path of candidates) {
      const locations = [...trees.map((tree) => tree.classify(path)), classifyRecordPath(path, scopes, collections)];
      if (!locations.some((location) => location.protected)) continue;
      const previous = headTree?.entries.get(path);
      const before = previous ? `${previous.mode}:${previous.oid}` : `000000:${zero}`;
      const file = ownedPath(root, path);
      let after = `000000:${zero}`;
      if (existsSync(file)) {
        const stat = lstatSync(file);
        if (!stat.isFile()) throw new InvalidInput(`${path}: review requires a regular file`);
        const mode = fileMode
          ? stat.mode & 0o100
            ? "100755"
            : "100644"
          : (trees[0]?.entries.get(path)?.mode ?? previous?.mode ?? "100644");
        after = `${mode}:${workingBlob(file, algorithm)}`;
      }
      if (before !== after)
        changes.push({ path, before, after, charter: locations.some((location) => location.charter) });
    }
  } else {
    const raw = snapshot.changes;
    for (let index = 0; index < raw.length - 1; index += 2) {
      const header = required(raw[index], "expected raw[index]");
      const path = required(raw[index + 1], "expected raw[index + 1]");
      const fields = header.slice(1).split(" ");
      if (fields[4] === "U") throw new Error(`resolve the conflicted index entry: ${path}`);
      const locations = trees.map((tree) => tree.classify(path));
      if (locations.some((location) => location.protected))
        changes.push({
          path,
          before: `${String(fields[0])}:${String(fields[2])}`,
          after: `${String(fields[1])}:${String(fields[3])}`,
          charter: locations.some((location) => location.charter),
        });
    }
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  const digest = changesDigest(changes);
  const receipt = resolve(root, reviewGit(root, ["rev-parse", "--git-path", "workbench/review.json"]).trim());
  return { changes, digest, receipt };
}

export const reviewChangeDigest = (change: ReviewChange): string => changesDigest([change]);
interface Approval {
  approved_at: string;
  head?: string;
  contents?: string;
  human_written_charter: boolean;
}

interface Acknowledgment {
  change: ReviewChange;
  approval: Approval;
  latest?: boolean;
}

function table(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function readChange(value: unknown): ReviewChange | undefined {
  if (
    !table(value) ||
    typeof value.path !== "string" ||
    typeof value.before !== "string" ||
    typeof value.after !== "string" ||
    typeof value.charter !== "boolean"
  )
    return undefined;
  return { path: value.path, before: value.before, after: value.after, charter: value.charter };
}
function readApproval(value: unknown, change: ReviewChange): Approval | undefined {
  if (
    !table(value) ||
    typeof value.approved_at !== "string" ||
    !Number.isFinite(Date.parse(value.approved_at)) ||
    typeof value.human_written_charter !== "boolean" ||
    (change.charter && !value.human_written_charter)
  )
    return undefined;
  if (
    value.head !== undefined &&
    (typeof value.head !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})?$/.test(value.head))
  )
    return undefined;
  if (value.contents !== undefined) {
    if (typeof value.contents !== "string" || value.contents.length > 3 * 1024 * 1024) return undefined;
    const bytes = Buffer.from(value.contents, "base64");
    if (bytes.length > 2 * 1024 * 1024 || bytes.toString("base64") !== value.contents) return undefined;
    const [mode, oid] = change.after.split(":");
    const hash = createHash(oid?.length === 64 ? "sha256" : "sha1")
      .update(`blob ${String(bytes.length)}\0`)
      .update(bytes)
      .digest("hex");
    if (mode === "000000" ? bytes.length !== 0 : hash !== oid) return undefined;
  }
  return {
    approved_at: value.approved_at,
    human_written_charter: value.human_written_charter,
    ...(typeof value.head === "string" ? { head: value.head } : {}),
    ...(typeof value.contents === "string" ? { contents: value.contents } : {}),
  };
}
export type ReviewReceiptState =
  | { state: "missing" }
  | { state: "invalid"; problem: unknown }
  | { state: "ready"; approvals: Map<string, Acknowledgment> };
export function readReviewReceipt(receipt: string): ReviewReceiptState {
  if (!existsSync(receipt)) return { state: "missing" };
  try {
    return {
      state: "ready",
      approvals: decodeReviewReceipt(
        JSON.parse(readBoundedFile(receipt, 64 * 1024 * 1024, "review receipt").toString("utf8")) as unknown,
      ),
    };
  } catch (problem) {
    return { state: "invalid", problem };
  }
}
function savedApprovals(receipt: string): Map<string, Acknowledgment> {
  const saved = readReviewReceipt(receipt);
  if (saved.state === "invalid")
    diagnostic(
      LogLevel.Warn,
      DiagnosticOperation.Command,
      DiagnosticOutcome.Unavailable,
      { receipt },
      saved.problem,
      "Review receipt is invalid; no files are acknowledged",
    );
  return saved.state === "ready" ? saved.approvals : new Map<string, Acknowledgment>();
}
function decodeReviewReceipt(value: unknown): Map<string, Acknowledgment> {
  if (!table(value) || !Array.isArray(value.changes) || typeof value.digest !== "string" || !table(value.files))
    throw new InvalidInput("Invalid review receipt");
  const changes: ReviewChange[] = [];
  const paths = new Set<string>();
  for (const entry of value.changes as unknown[]) {
    const change = readChange(entry);
    if (!change || paths.has(change.path)) throw new InvalidInput("Invalid review receipt");
    paths.add(change.path);
    changes.push(change);
  }
  if (value.digest !== changesDigest(changes)) throw new InvalidInput("Invalid review receipt");
  const result = new Map<string, Acknowledgment>();
  if (value.alternatives !== undefined) {
    if (!Array.isArray(value.alternatives) || value.alternatives.length > changes.length * 2)
      throw new InvalidInput("Invalid review receipt");
    for (const alternate of value.alternatives as unknown[]) {
      if (!table(alternate)) throw new InvalidInput("Invalid review receipt");
      const change = readChange(alternate.change);
      const approval = change ? readApproval(alternate.approval, change) : undefined;
      if (!change || !approval || !paths.has(change.path)) throw new InvalidInput("Invalid review receipt");
      result.set(reviewChangeDigest(change), { change, approval });
    }
  }
  for (const change of changes) {
    const approval = Object.hasOwn(value.files, change.path)
      ? readApproval(value.files[change.path], change)
      : undefined;
    if (!approval) throw new InvalidInput("Invalid review receipt");
    result.set(reviewChangeDigest(change), { change, approval, latest: true });
  }
  return result;
}

export function stagedReview(
  root: string,
  source: ReviewSource = ReviewSource.Staged,
  snapshot = new GitSnapshot(root),
) {
  const pending = proposedReview(root, source, snapshot);
  const approved = savedApprovals(pending.receipt);
  return {
    ...pending,
    changes: pending.changes.map((change) => ({
      ...change,
      digest: reviewChangeDigest(change),
      approved: approved.has(reviewChangeDigest(change)),
    })),
  };
}

/** A cooperative human acknowledgment; never an authenticated identity or an agent approval. */
export function approveReviewFiles(
  root: string,
  selected: { path: string; digest: string }[],
  humanWrittenCharters: boolean,
  source: ReviewSource = ReviewSource.Staged,
): void {
  if (!selected.length || new Set(selected.map((file) => file.path)).size !== selected.length)
    throw new InvalidInput("select distinct protected files to approve");
  const { receipt } = proposedReview(root);
  withCacheLockSync(
    receipt,
    () => {
      const pending = proposedReview(root, source);
      const head = reviewHead(root);
      const selectedChanges = selected.map((file) => {
        const change = pending.changes.find((change) => change.path === file.path);
        if (!change || reviewChangeDigest(change) !== file.digest)
          throw new StateConflict("review digest changed; inspect 'workbench review' again");
        if (change.charter && !humanWrittenCharters)
          throw new InvalidInput("charter changes require confirmation of human authorship");
        return change;
      });
      const approved = savedApprovals(receipt);
      for (const change of selectedChanges) {
        let contents: string | undefined;
        if (/\/ADR-[0-9A-Z]+\.md$/.test(change.path)) {
          const size = change.after.startsWith("000000:")
            ? 0
            : source === ReviewSource.Working
              ? lstatSync(ownedPath(root, change.path)).size
              : Number(reviewGit(root, ["cat-file", "-s", change.after.split(":")[1] ?? ""]).trim());
          if (size <= 2 * 1024 * 1024)
            contents =
              (source === ReviewSource.Working
                ? workingReviewContents(root, change)
                : reviewFileContents(root, change.after)
              )?.toString("base64") ?? "";
        }
        for (const acknowledgment of approved.values())
          if (acknowledgment.change.path === change.path) acknowledgment.latest = false;
        approved.set(reviewChangeDigest(change), {
          change,
          latest: true,
          approval: {
            approved_at: new Date().toISOString(),
            head,
            human_written_charter: change.charter && humanWrittenCharters,
            ...(contents !== undefined ? { contents } : {}),
          },
        });
      }
      if (reviewHead(root) !== head || proposedReview(root, source).digest !== pending.digest)
        throw new StateConflict("review contents changed during confirmation; refresh the review");
      // Retain the latest review and independent acknowledgments for the current working and staged versions.
      let workingChanges: ReviewChange[];
      try {
        workingChanges = proposedReview(root, ReviewSource.Working).changes;
      } catch (cause) {
        if (source === ReviewSource.Working) throw cause;
        // An invalid working draft must not prevent review of a valid staged policy tree.
        workingChanges = [...approved.values()].filter((ack) => !ack.latest).map((ack) => ack.change);
      }
      const current = new Set([...proposedReview(root).changes, ...workingChanges].map(reviewChangeDigest));
      const acknowledgments = [...approved.values()]
        .filter((ack) => ack.latest)
        .sort((a, b) => a.change.path.localeCompare(b.change.path));
      const changes = acknowledgments.map((ack) => ack.change);
      const files = Object.fromEntries(acknowledgments.map(({ change, approval }) => [change.path, approval]));
      const alternatives = [...approved]
        .filter(([digest, ack]) => !ack.latest && current.has(digest))
        .map(([, { change, approval }]) => ({ change, approval }));
      const serialized =
        JSON.stringify({ digest: changesDigest(changes), changes, files, alternatives }, null, 2) + "\n";
      if (Buffer.byteLength(serialized) > 64 * 1024 * 1024)
        throw new InvalidInput("review receipt exceeds 64 MiB; no acknowledgment was changed");
      writeAtomic(receipt, serialized);
    },
    0,
  );
}

export function reviewFileContents(root: string, identity: string, snapshot?: GitSnapshot): Buffer | undefined {
  const [mode, oid] = identity.split(":");
  if (mode === "000000") return undefined;
  if (!oid || !["100644", "100755"].includes(mode ?? "")) throw new Error("review requires a regular file");
  if (snapshot) return snapshot.blob(oid);
  const size = Number(reviewGit(root, ["cat-file", "-s", oid]).trim());
  if (size > 2 * 1024 * 1024) throw new Error("review file exceeds the 2 MiB preview limit; review it in the terminal");
  const result = spawnSync("git", ["-C", root, "cat-file", "blob", oid], { maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error("cannot read reviewed file contents");
  return result.stdout;
}

/** Read the exact working version without Git filters, staging, or writing objects. */
export function workingReviewContents(root: string, change: ReviewChange): Buffer | undefined {
  const file = ownedPath(root, change.path);
  if (change.after.startsWith("000000:")) {
    if (existsSync(file)) throw new StateConflict("working file changed; refresh the review");
    return undefined;
  }
  const bytes = readBoundedFile(file, 2 * 1024 * 1024, "review file");
  const result = spawnSync("git", ["-C", root, "hash-object", "--stdin", "--no-filters"], {
    input: bytes,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0 || result.stdout.trim() !== change.after.split(":")[1])
    throw new StateConflict("working file changed; refresh the review");
  return bytes;
}

/** Only reviews made against this HEAD supersede the committed baseline. */
export function reviewedBaselines(
  root: string,
  head = reviewHead(root),
): Map<string, { contents: string; approvedAt: string }> {
  const receipt = resolve(root, reviewGit(root, ["rev-parse", "--git-path", "workbench/review.json"]).trim());
  return new Map(
    [...savedApprovals(receipt).values()].flatMap((ack) =>
      ack.latest && ack.approval.head === head && ack.approval.contents !== undefined
        ? [
            [
              ack.change.path,
              {
                contents: Buffer.from(ack.approval.contents, "base64").toString("utf8"),
                approvedAt: ack.approval.approved_at,
              },
            ] as const,
          ]
        : [],
    ),
  );
}
