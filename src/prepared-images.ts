import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withCacheLocksSync } from "./cache-lock.js";
import { pruneItem, type CachePruneObserver } from "./cache-prune-progress.js";
import { inspectPreparedImages } from "./local-images.js";
import { revalidateRegistryImage } from "./registry-images.js";
import type { PreparedImageReport } from "./image-contract.js";
export { recordPreparedImage, inspectPreparedImages, preparedImageSource } from "./local-images.js";
export { registryImageStatus, inspectRegistryImages } from "./registry-images.js";
export type { PreparedImageEntry, PreparedImageReport } from "./image-contract.js";
const execute = promisify(execFile);

/** Revalidate every selected item under profile locks before deleting any item. */
export async function prunePreparedImages(report: PreparedImageReport, progress?: CachePruneObserver): Promise<void> {
  if (report.issues.length && (report.location === "local" || !report.entries.length))
    throw new Error(`Cannot revalidate prepared images: ${report.issues.join("; ")}`);
  if (!report.entries.length) return;
  if (report.entries.some((entry) => entry.blockedBy)) throw new Error("Selected prepared image is not removable");
  await withCacheLocksSync([...new Set(report.entries.map((entry) => entry.lock))].sort(), async () => {
    if (report.location === "local") {
      // A new inventory under the locks preserves the complete-set revalidation guarantee.
      const current = inspectPreparedImages(undefined, new Set(report.entries.map((entry) => entry.reference)));
      if (current.issues.length) throw new Error(`Cannot inspect prepared images: ${current.issues.join("; ")}`);
      for (const entry of report.entries) {
        const actual = current.entries.find((candidate) => candidate.key === entry.key);
        if (
          actual?.identity !== entry.identity ||
          actual.image !== entry.image ||
          actual.reference !== entry.reference ||
          (actual.blockedReason && actual.blockedReason !== "locked")
        )
          throw new Error(`Prepared image ${entry.reference} changed or became active; inspect again`);
      }
      for (const entry of report.entries)
        await pruneItem(
          `Images / ${entry.profile} / ${entry.reference}`,
          async () => {
            await execute("docker", ["image", "rm", entry.reference], { maxBuffer: 16 * 1024 * 1024 });
          },
          progress,
        );
    } else {
      for (const entry of report.entries) revalidateRegistryImage(entry);
      for (const entry of report.entries)
        await pruneItem(
          `Registry images / ${entry.profile} / ${entry.reference}`,
          async () => {
            await execute("gh", ["api", "--hostname", "github.com", "--method", "DELETE", entry.endpoint], {
              maxBuffer: 16 * 1024 * 1024,
            });
          },
          progress,
        );
    }
  });
}
