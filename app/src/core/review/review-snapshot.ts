import { createHash } from "node:crypto";
import { InvalidInput, StateConflict } from "../runtime/input-errors.js";
import type { PresentedReview, ReviewChange } from "./review-service.js";

export const reviewFileLimit = 2 * 1024 * 1024;
export const reviewEncodedLimit = 4 * Math.ceil(reviewFileLimit / 3);
export const reviewReceiptLimit = 64 * 1024 * 1024;
export const reviewRetention = { capacity: 256, maximumBytes: 64 * 1024 * 1024 } as const;
const objectId = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const fileIdentity = /^[0-7]{6}:[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

export function decodeReviewChange(value: unknown): ReviewChange | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("path" in value) ||
    typeof value.path !== "string" ||
    !("before" in value) ||
    typeof value.before !== "string" ||
    !("after" in value) ||
    typeof value.after !== "string" ||
    !("charter" in value) ||
    typeof value.charter !== "boolean"
  )
    return undefined;
  const { path, before, after, charter } = value;
  if (!("merge" in value)) return { path, before, after, charter };
  const merge = value.merge;
  if (
    !merge ||
    typeof merge !== "object" ||
    !("tree" in merge) ||
    typeof merge.tree !== "string" ||
    !objectId.test(merge.tree) ||
    !("parents" in merge) ||
    !Array.isArray(merge.parents) ||
    merge.parents.length < 2 ||
    merge.parents.length > 256
  )
    return undefined;
  const parents: NonNullable<ReviewChange["merge"]>["parents"][number][] = [];
  for (const parent of merge.parents as unknown[]) {
    if (
      !parent ||
      typeof parent !== "object" ||
      !("tree" in parent) ||
      typeof parent.tree !== "string" ||
      !objectId.test(parent.tree) ||
      !("file" in parent) ||
      typeof parent.file !== "string" ||
      !fileIdentity.test(parent.file)
    )
      return undefined;
    parents.push({ tree: parent.tree, file: parent.file });
  }
  if (parents[0]?.file !== before || !fileIdentity.test(after) || parents.every((parent) => parent.file === after))
    return undefined;
  return { path, before, after, charter, merge: { tree: merge.tree, parents } };
}

export const reviewIdentity = (change: ReviewChange): ReviewChange => ({
  path: change.path,
  before: change.before,
  after: change.after,
  charter: change.charter,
  ...(change.merge
    ? { merge: { tree: change.merge.tree, parents: change.merge.parents.map(({ tree, file }) => ({ tree, file })) } }
    : {}),
});
export const reviewChangeDigest = (change: ReviewChange): string =>
  createHash("sha256")
    .update(JSON.stringify([reviewIdentity(change)]))
    .digest("hex");
/** Shared byte validation for presented snapshots and persisted Markdown baselines. */
export function reviewContents(change: ReviewChange, encoded: string): Buffer | undefined {
  if (encoded.length > reviewEncodedLimit) return undefined;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) return undefined;
  return reviewBuffer(change, bytes);
}
/** Validate captured bytes directly without allocating an encoded copy. */
export function reviewBuffer(change: ReviewChange, bytes: Buffer): Buffer | undefined {
  if (bytes.length > reviewFileLimit) return undefined;
  const [mode, oid] = change.after.split(":");
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(oid ?? "")) return undefined;
  if (mode === "000000") return bytes.length === 0 && /^0+$/.test(oid ?? "") ? bytes : undefined;
  if (mode !== "100644" && mode !== "100755") return undefined;
  const hash = createHash(oid?.length === 64 ? "sha256" : "sha1")
    .update(`blob ${String(bytes.length)}\0`)
    .update(bytes)
    .digest("hex");
  return hash === oid ? bytes : undefined;
}
export function decodePresentedReview(value: unknown): PresentedReview {
  if (
    !value ||
    typeof value !== "object" ||
    !("head" in value) ||
    typeof value.head !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})?$/.test(value.head) ||
    !("change" in value) ||
    !value.change ||
    typeof value.change !== "object" ||
    !("contents" in value)
  )
    throw new InvalidInput("Invalid presented review version");
  const identity = decodeReviewChange(value.change);
  if (!identity || (value.contents !== null && typeof value.contents !== "string"))
    throw new InvalidInput("Invalid presented review version");
  if (
    identity.after.startsWith("000000:") !== (value.contents === null) ||
    !reviewContents(identity, value.contents ?? "")
  )
    throw new StateConflict("presented review version is invalid; reload the review");
  return { head: value.head, change: identity, contents: value.contents };
}
