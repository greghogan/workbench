import { isMainThread, workerData } from "node:worker_threads";
import { serveCacheWorker } from "../cache/cache-worker.js";
import { serveReviewWorker } from "../review/review-worker.js";
import { serveWorkspaceWorker } from "./workspace-worker.js";
import { serveProjectReviewWorker } from "../projects/project-reviews.js";
import { serveProjectDirectoryWorker } from "../projects/project-directory.js";

/** Dispatch only recognized application workers; ordinary startup belongs to the caller. */
export function startApplicationWorker(): boolean {
  const input: unknown = workerData;
  if (isMainThread || !input || typeof input !== "object") return false;
  if ("workbenchCache" in input) serveCacheWorker(input.workbenchCache);
  else if ("workbenchProjectReviews" in input && input.workbenchProjectReviews === true) serveProjectReviewWorker();
  else if ("workbenchProjectDirectory" in input && input.workbenchProjectDirectory === true)
    serveProjectDirectoryWorker();
  else if ("workbenchReview" in input) void serveReviewWorker(input.workbenchReview);
  else if ("workbenchWorkspace" in input && typeof input.workbenchWorkspace === "string")
    serveWorkspaceWorker(input.workbenchWorkspace);
  else return false;
  return true;
}
