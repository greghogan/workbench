import {
  reviewFileLimit,
  reviewReceiptLimit,
  reviewContents,
  reviewBuffer,
  reviewIdentity,
  decodePresentedReview,
} from "./review-snapshot.js";
import { GitSnapshot, writeRawReviewObjects } from "./git-snapshot.js";
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
import {
  proposedRecordTrees,
  classifyRecordPath,
  recordOwnerPath,
  protectedRecordPaths,
  RecordTree,
} from "./staged-records.js";
import { recordDocument } from "./record-document.js";
import { ownedPath } from "./paths.js";
import { withCacheLockSync } from "./cache-lock.js";
import { reviewedCommit } from "./commit-history.js";

export interface ReviewChange {
  path: string;
  before: string;
  after: string;
  charter: boolean;
}
const changesDigest = (changes: unknown[]): string =>
  createHash("sha256").update(JSON.stringify(changes)).digest("hex");
export function reviewGit(root: string, args: string[], input?: string): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.error || result.status !== 0)
    throw new Error(`cannot inspect proposed review: ${String(result.stderr || result.error)}`);
  return result.stdout;
}
export const ReviewSource = { Staged: "staged", Working: "working" } as const;
export type ReviewSource = (typeof ReviewSource)[keyof typeof ReviewSource];
export function reviewHead(root: string): string {
  const result = spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", "HEAD"], { encoding: "utf8" });
  if (result.error || (result.status !== 0 && result.status !== 1)) throw new Error("cannot inspect review HEAD");
  return reviewedCommit(root, result.stdout.trim());
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
  snapshot = new GitSnapshot(root, { staged: source === ReviewSource.Staged, review: true }),
) {
  const changes: ReviewChange[] = [];
  const working = source === ReviewSource.Working;
  const trees = working
    ? snapshot.head
      ? [new RecordTree(root, snapshot.head, snapshot)]
      : []
    : proposedRecordTrees(root, snapshot);
  const scopes = working ? readProjects(root).map((project) => project.path) : [];
  const collections = working ? (readConfig(root).collections?.sources ?? []).map((pin) => pin.id) : [];
  const allScopes = [...new Set([...scopes, ...trees.flatMap((tree) => tree.scopes)])];
  const allCollections = [...new Set([...collections, ...trees.flatMap((tree) => tree.collections)])];
  const experiments = new Map<string, boolean>();
  const reviewRequired = (path: string): boolean => {
    const owner = recordOwnerPath(path, allScopes, allCollections);
    if (!owner || !/(?:^|\/)EXP-[0-9A-Z]+\.md$/.test(owner)) return true;
    const cached = experiments.get(owner);
    if (cached !== undefined) return cached;
    const versions = trees.flatMap((tree) => {
      const bytes = tree.bytes(owner);
      return bytes ? [bytes.toString("utf8")] : [];
    });
    if (working && existsSync(ownedPath(root, owner)))
      versions.push(
        readBoundedFile(ownedPath(root, owner), reviewFileLimit, "experiment review status").toString("utf8"),
      );
    // Drafts need no human decision. A prior completed conclusion or malformed record stays protected.
    const required =
      !versions.length ||
      versions.some((contents) => {
        try {
          const { status } = recordDocument("EXP", contents, owner).metadata;
          return status !== "Planned" && status !== "Running";
        } catch {
          return true;
        }
      });
    experiments.set(owner, required);
    return required;
  };
  if (working) {
    const algorithm = reviewGit(root, ["rev-parse", "--show-object-format"]).trim() === "sha256" ? "sha256" : "sha1";
    const zero = "0".repeat(algorithm === "sha256" ? 64 : 40);
    const headTree = trees[0];
    const roots = protectedRecordPaths(allScopes, allCollections);
    const candidates = new Set([
      ...trees.flatMap((tree) => [...tree.entries.keys()]),
      ...(roots.length
        ? reviewGit(root, [
            "--literal-pathspecs",
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
            "--",
            ...roots,
          ])
            .split("\0")
            .filter(Boolean)
        : []),
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
      if (!reviewRequired(path)) continue;
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
      if (locations.some((location) => location.protected) && reviewRequired(path))
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
  const receipt = reviewReceipt(root);
  return { changes, digest, receipt };
}

function reviewReceipt(root: string): string {
  return resolve(root, reviewGit(root, ["rev-parse", "--git-path", "workbench/review.json"]).trim());
}

export const reviewChangeDigest = (change: ReviewChange): string => changesDigest([reviewIdentity(change)]);
export const presentedReviewDigest = (change: ReviewChange, head: string): string =>
  createHash("sha256")
    .update(JSON.stringify([reviewChangeDigest(change), head]))
    .digest("hex");
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
    if (typeof value.contents !== "string" || !reviewContents(change, value.contents)) return undefined;
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
        JSON.parse(readBoundedFile(receipt, reviewReceiptLimit, "review receipt").toString("utf8")) as unknown,
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

export function reviewStatus(
  root: string,
  source: ReviewSource,
  snapshot = new GitSnapshot(root, { staged: source === ReviewSource.Staged, review: true }),
) {
  const pending = proposedReview(root, source, snapshot);
  const approved = savedApprovals(pending.receipt);
  return {
    ...pending,
    head: snapshot.head,
    source,
    changes: pending.changes.map((change) => ({
      ...change,
      digest: reviewChangeDigest(change),
      approved: approved.has(reviewChangeDigest(change)),
    })),
  };
}

/** All review adapters acknowledge the same byte and authorship contract; eligibility remains with the adapter. */
function acknowledgment(
  change: ReviewChange,
  contents: string | undefined,
  head: string,
  humanWritten: boolean,
): Acknowledgment {
  if (change.charter && !humanWritten)
    throw new InvalidInput("charter changes require confirmation of human authorship");
  if (contents !== undefined && !reviewContents(change, contents))
    throw new StateConflict("Invalid captured review bytes");
  return {
    change: reviewIdentity(change),
    approval: {
      approved_at: new Date().toISOString(),
      head,
      human_written_charter: change.charter && humanWritten,
      ...(contents === undefined ? {} : { contents }),
    },
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
  const receipt = reviewReceipt(root);
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
      const acknowledgments: Acknowledgment[] = [];
      for (const change of selectedChanges) {
        let contents: string | undefined;
        if (change.path.endsWith(".md")) {
          const size = change.after.startsWith("000000:")
            ? 0
            : source === ReviewSource.Working
              ? lstatSync(ownedPath(root, change.path)).size
              : Number(reviewGit(root, ["cat-file", "-s", change.after.split(":")[1] ?? ""]).trim());
          if (size <= reviewFileLimit)
            contents =
              (source === ReviewSource.Working
                ? workingReviewContents(root, change)
                : reviewFileContents(root, change.after)
              )?.toString("base64") ?? "";
        }
        acknowledgments.push(acknowledgment(change, contents, head, humanWrittenCharters));
      }
      if (reviewHead(root) !== head || proposedReview(root, source).digest !== pending.digest)
        throw new StateConflict("review contents changed during confirmation; refresh the review");
      publishAcknowledgments(receipt, acknowledgments, head);
    },
    0,
  );
}

export interface CapturedReview {
  change: ReviewChange;
  contents?: string;
}
/** Store exact raw objects without clean filters or index writes; approval remains bound to presented bytes. */
export interface CapturedReviews {
  head: string;
  source: ReviewSource;
  files: CapturedReview[];
}
export function captureReviews(
  root: string,
  changes: ReviewChange[],
  source: ReviewSource,
  snapshot: GitSnapshot,
): CapturedReviews {
  const present = changes.filter((change) => !change.after.startsWith("000000:"));
  if (source === ReviewSource.Working) {
    const ids = writeRawReviewObjects(
      root,
      present.map((change) => ownedPath(root, change.path)),
    );
    if (present.some((change, index) => ids[index] !== change.after.split(":")[1]))
      throw new StateConflict("Working file changed while capturing review; refresh the review");
  }
  snapshot.prefetch(
    present.filter((change) => change.path.endsWith(".md")).map((change) => change.after.split(":")[1] ?? ""),
    reviewFileLimit,
  );
  let retained = 0;
  const files = changes.map((change) => {
    let contents: string | undefined;
    if (change.path.endsWith(".md")) {
      const oid = change.after.split(":")[1] ?? "",
        deleted = change.after.startsWith("000000:");
      if (deleted || snapshot.blobSize(oid) <= reviewFileLimit) {
        contents = deleted ? "" : snapshot.blob(oid, reviewFileLimit).toString("base64");
        retained += contents.length;
        if (retained > reviewReceiptLimit) throw new InvalidInput("review selection exceeds retained capacity");
      }
    }
    return { change: reviewIdentity(change), ...(contents === undefined ? {} : { contents }) };
  });
  return { head: snapshot.head, source, files };
}
export function approveCapturedReviews(root: string, captured: CapturedReviews, humanWritten: boolean): void {
  const versions = captured.files;
  if (!versions.length || new Set(versions.map((version) => version.change.path)).size !== versions.length)
    throw new InvalidInput("select distinct protected files to approve");
  const selected = versions.map(({ change, contents }) =>
    acknowledgment(change, contents, captured.head, humanWritten),
  );
  const receipt = reviewReceipt(root);
  withCacheLockSync(
    receipt,
    () => {
      const head = reviewHead(root);
      publishAcknowledgments(receipt, selected, head);
    },
    0,
  );
}

export interface PresentedReview {
  head: string;
  change: ReviewChange;
  contents: string | null;
}

/** Confirm retained, server-presented bytes without substituting the current disk file. */
export function approvePresentedReview(root: string, value: unknown, digest: string, humanWritten: boolean): void {
  const version = decodePresentedReview(value),
    change = version.change;
  if (presentedReviewDigest(change, version.head) !== digest)
    throw new StateConflict("presented review digest is invalid; reload the review");
  const selected = acknowledgment(
    change,
    change.path.endsWith(".md") ? (version.contents ?? "") : undefined,
    version.head,
    humanWritten,
  );
  const receipt = reviewReceipt(root);
  withCacheLockSync(
    receipt,
    () => {
      const head = reviewHead(root);
      publishAcknowledgments(receipt, [selected], head);
    },
    0,
  );
}

/** Pure bounded history merge. Map insertion order records acknowledgment order independently of clocks. */
export function mergeAcknowledgments(
  existing: ReadonlyMap<string, Acknowledgment>,
  selected: Acknowledgment[],
  head: string,
): string {
  const approved = new Map(existing);
  for (const acknowledgment of selected) {
    for (const previous of approved.values())
      if (previous.change.path === acknowledgment.change.path)
        approved.set(reviewChangeDigest(previous.change), { ...previous, latest: false });
    approved.delete(reviewChangeDigest(acknowledgment.change));
    approved.set(reviewChangeDigest(acknowledgment.change), { ...acknowledgment, latest: true });
  }
  const acknowledgments = [...approved.values()]
    .filter((ack) => ack.latest)
    .sort((a, b) => a.change.path.localeCompare(b.change.path));
  const changes = acknowledgments.map((ack) => ack.change);
  const files = Object.fromEntries(acknowledgments.map(({ change, approval }) => [change.path, approval]));
  const counts = new Map<string, number>();
  const alternatives = [...approved.values()]
    .filter((ack) => !ack.latest && ack.approval.head === head)
    .reverse()
    .filter(({ change }) => {
      const count = counts.get(change.path) ?? 0;
      counts.set(change.path, count + 1);
      return count < 2;
    })
    .reverse()
    .map(({ change, approval }) => ({
      change,
      approval: {
        approved_at: approval.approved_at,
        human_written_charter: approval.human_written_charter,
        ...(approval.head !== undefined ? { head: approval.head } : {}),
      },
    }));
  const serialized = JSON.stringify({ digest: changesDigest(changes), changes, files, alternatives }, null, 2) + "\n";
  if (Buffer.byteLength(serialized) > reviewReceiptLimit)
    throw new InvalidInput("review receipt exceeds 64 MiB; no acknowledgment was changed");
  return serialized;
}
/** The caller owns the receipt lock across reading, merging and publication. */
function publishAcknowledgments(receipt: string, selected: Acknowledgment[], head: string): void {
  writeAtomic(receipt, mergeAcknowledgments(savedApprovals(receipt), selected, head));
}

export function reviewFileContents(root: string, identity: string, snapshot?: GitSnapshot): Buffer | undefined {
  const [mode, oid] = identity.split(":");
  if (mode === "000000") return undefined;
  if (!oid || !["100644", "100755"].includes(mode ?? "")) throw new Error("review requires a regular file");
  if (snapshot) return snapshot.blob(oid);
  const size = Number(reviewGit(root, ["cat-file", "-s", oid]).trim());
  if (size > reviewFileLimit) throw new Error("review file exceeds the 2 MiB preview limit; review it in the terminal");
  const result = spawnSync("git", ["-C", root, "cat-file", "blob", oid], { maxBuffer: reviewFileLimit });
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
  const bytes = readBoundedFile(file, reviewFileLimit, "review file");
  if (!reviewBuffer(change, bytes)) throw new StateConflict("working file changed; refresh the review");
  return bytes;
}

/** Reviews share an accepted commit baseline across provisional local commits. */
export function reviewedBaselines(
  root: string,
  head = reviewHead(root),
): Map<string, { contents: string; approvedAt: string; mode: string }> {
  const receipt = reviewReceipt(root);
  return new Map(
    [...savedApprovals(receipt).values()].flatMap((ack) =>
      ack.latest && ack.approval.head === head && ack.approval.contents !== undefined
        ? [
            [
              ack.change.path,
              {
                contents: Buffer.from(ack.approval.contents, "base64").toString("utf8"),
                approvedAt: ack.approval.approved_at,
                mode: ack.change.after.split(":")[0] ?? "",
              },
            ] as const,
          ]
        : [],
    ),
  );
}
