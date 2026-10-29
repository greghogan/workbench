import { createHash } from "node:crypto";
import { InvalidInput, StateConflict } from "./input-errors.js";
import type { PresentedReview, ReviewChange } from "./review-service.js";

export const reviewFileLimit = 2 * 1024 * 1024;
export const reviewEncodedLimit = 4 * Math.ceil(reviewFileLimit / 3);
export const reviewReceiptLimit = 64 * 1024 * 1024;
export const reviewRetention = { capacity: 256, maximumBytes: 64 * 1024 * 1024 } as const;
export const reviewIdentity = (change: ReviewChange): ReviewChange => ({
  path: change.path,
  before: change.before,
  after: change.after,
  charter: change.charter,
});
/** Shared byte validation for presented snapshots and persisted Markdown baselines. */
export function reviewContents(change: ReviewChange, encoded: string): Buffer | undefined {
  if (encoded.length > reviewEncodedLimit) return undefined;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > reviewFileLimit || bytes.toString("base64") !== encoded) return undefined;
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
  const change = value.change;
  if (
    !("path" in change) ||
    typeof change.path !== "string" ||
    !("before" in change) ||
    typeof change.before !== "string" ||
    !("after" in change) ||
    typeof change.after !== "string" ||
    !("charter" in change) ||
    typeof change.charter !== "boolean" ||
    (value.contents !== null && typeof value.contents !== "string")
  )
    throw new InvalidInput("Invalid presented review version");
  const identity = reviewIdentity(change as ReviewChange);
  if (
    identity.after.startsWith("000000:") !== (value.contents === null) ||
    !reviewContents(identity, value.contents ?? "")
  )
    throw new StateConflict("presented review version is invalid; reload the review");
  return { head: value.head, change: identity, contents: value.contents };
}
