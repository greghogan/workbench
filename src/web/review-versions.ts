import { reviewIdentity, reviewRetention } from "../review-snapshot.js";
import { presentedReviewDigest, type PresentedReview, type ReviewChange } from "../review-service.js";
import type { ReviewDocument } from "../workspace-service.js";
import { WebError } from "./errors.js";

interface RetainedReview {
  version: PresentedReview;
  before: string | null;
  bytes: number;
}

/** One listener owns bounded immutable presentations independently of the current workspace snapshot. */
export class ReviewVersions {
  private readonly versions = new Map<string, RetainedReview>();
  private bytes = 0;
  private readonly capacity: number;
  private readonly maximumBytes: number;
  constructor(options: { capacity?: number; maximumBytes?: number } = {}) {
    const { capacity = reviewRetention.capacity, maximumBytes = reviewRetention.maximumBytes } = options;
    this.capacity = capacity;
    this.maximumBytes = maximumBytes;
    if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1)
      throw new Error("Invalid review retention capacity");
  }

  retain(change: ReviewChange, document: Pick<ReviewDocument, "before" | "after" | "error">, head: string): void {
    this.retainBatch([{ change, document }], head);
  }
  retainBatch(
    presentations: { change: ReviewChange; document: Pick<ReviewDocument, "before" | "after" | "error"> }[],
    head: string,
  ): void {
    const batch = new Map<string, RetainedReview>();
    for (const { change, document } of presentations) {
      if (document.error) throw new WebError(409, document.error);
      const identity = reviewIdentity(change);
      const version: PresentedReview = Object.freeze({
        head,
        change: Object.freeze(identity),
        contents: document.after,
      });
      const bytes = 2 * (JSON.stringify(version).length + (document.before?.length ?? 0)) + 256;
      batch.set(presentedReviewDigest(identity, head), Object.freeze({ version, before: document.before, bytes }));
    }
    const bytes = [...batch.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    if (batch.size > this.capacity || bytes > this.maximumBytes)
      throw new WebError(413, "This complete review exceeds retained capacity; review the group using the CLI");
    // Validate the entire page before changing retention; no member can evict another member of this batch.
    for (const digest of batch.keys()) {
      const previous = this.versions.get(digest);
      if (previous) {
        this.bytes -= previous.bytes;
        this.versions.delete(digest);
      }
    }
    while (this.versions.size + batch.size > this.capacity || this.bytes + bytes > this.maximumBytes) {
      const oldest = this.versions.keys().next().value;
      if (oldest === undefined) throw new Error("Invalid review retention capacity");
      this.bytes -= this.versions.get(oldest)?.bytes ?? 0;
      this.versions.delete(oldest);
    }
    for (const [digest, entry] of batch) this.versions.set(digest, entry);
    this.bytes += bytes;
  }

  get(path: string, digest: string): RetainedReview {
    const entry = this.versions.get(digest);
    if (entry?.version.change.path !== path)
      throw new WebError(409, "This review version is no longer retained; reload the review before confirming");
    this.versions.delete(digest);
    this.versions.set(digest, entry);
    return entry;
  }

  clear(): void {
    this.versions.clear();
    this.bytes = 0;
  }
}
