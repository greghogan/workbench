import { createHash } from "node:crypto";
import { recordOwnerPath } from "../../core/records/staged-records.js";
import { ReviewFormatter } from "../../core/review/review-formatting.js";
import type { WorkspaceSnapshot } from "./workspace-service.js";
import { retainedBytes } from "../../core/runtime/retained-bytes.js";
import { PreparationState, type ReviewPreparation } from "../review/review-state.js";

/** Read-only acquisition reports preparation needs without substituting formatted file contents. */
export async function checkReviewFormatting(
  snapshot: WorkspaceSnapshot,
  formatter: ReviewFormatter,
): Promise<WorkspaceSnapshot> {
  const scopes = snapshot.projects.map((project) => project.path);
  const collections = snapshot.collections.map((collection) => collection.pin.id);
  const files = new Map<string, ReviewPreparation>(
    snapshot.reviewPreparation.pendingOutputs.map((path) => [path, { state: PreparationState.Required }]),
  );
  for (const change of snapshot.review.changes) {
    if (change.after.startsWith("000000:") || recordOwnerPath(change.path, scopes, collections) !== change.path) {
      continue;
    }
    const document = snapshot.reviewDocuments.get(change.digest);
    if (!document || document.error || document.after === null) {
      files.set(change.path, {
        state: PreparationState.Unavailable,
        problem: document && document.error.length > 0 ? document.error : "record contents are unavailable",
      });
    } else {
      const result = await formatter.prepare(
        change.path,
        Buffer.from(document.after, "base64"),
        snapshot.reviewPreparation.width,
      );
      if (result.state !== "current")
        files.set(
          change.path,
          result.state === "unavailable"
            ? { state: PreparationState.Unavailable, problem: result.problem }
            : { state: PreparationState.Required },
        );
    }
  }
  const publication = {
    ...snapshot,
    reviewPreparation: { ...snapshot.reviewPreparation, files },
    revision: createHash("sha256")
      .update(snapshot.revision)
      .update(JSON.stringify([...files]))
      .digest("hex"),
  };
  publication.retainedSize =
    snapshot.retainedSize -
    retainedBytes(snapshot.reviewPreparation) +
    retainedBytes(publication.reviewPreparation, 64 * 1024 * 1024);
  if (publication.retainedSize > 64 * 1024 * 1024)
    throw new Error("workspace browser snapshot exceeds 64 MiB; use the CLI for this workspace");
  return publication;
}
