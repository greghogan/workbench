import { processCancellation } from "../scripts/owned-child.mjs";
import { workQueue } from "../scripts/work-admission.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { withCacheLocksSync } from "./cache-lock.js";
import { pruneItem, type CachePruneObserver } from "./cache-prune-progress.js";
import { inspectPreparedImages } from "./local-images.js";
import { revalidateRegistryImage, deleteRegistryImage } from "./registry-images.js";
import {
  imageProfileLock,
  imageProfileMaintenanceLock,
  parsePreparedTag,
  type PreparedImageReport,
} from "./image-contract.js";
export { recordPreparedImage, inspectPreparedImages, preparedImageSource } from "./local-images.js";
export { registryImageStatus, inspectRegistryImages } from "./registry-images.js";
export type { PreparedImageEntry, PreparedImageReport } from "./image-contract.js";
const execute = promisify(execFile);

/** Revalidate every selected item under profile locks before deleting any item. */
export async function prunePreparedImages(
  report: PreparedImageReport,
  progress?: CachePruneObserver,
  validate?: () => void,
): Promise<void> {
  if (report.issues.length && (report.location === "local" || !report.entries.length))
    throw new Error(`Cannot revalidate prepared images: ${report.issues.join("; ")}`);
  if (!report.entries.length) return;
  if (report.entries.some((entry) => entry.blockedBy)) throw new Error("Selected prepared image is not removable");
  const operations = report.entries.flatMap((entry) =>
    report.location === "registry" && "tags" in entry
      ? entry.tags.flatMap((tag) => {
          const parsed = parsePreparedTag(tag);
          return parsed ? [imageProfileLock(entry.checkout, entry.profile, parsed.architecture)] : [];
        })
      : [entry.lock],
  );
  const maintenance = report.entries.map((entry) => imageProfileMaintenanceLock(entry.checkout, entry.profile));
  // Every path acquires architecture operation locks before profile-wide maintenance locks.
  await withCacheLocksSync([...new Set(operations)].sort().concat([...new Set(maintenance)].sort()), async () => {
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
      validate?.();
      for (const entry of report.entries)
        await pruneItem(
          `Images / ${entry.profile} / ${entry.reference}`,
          async () => {
            await execute("docker", ["image", "rm", entry.reference], { maxBuffer: 16 * 1024 * 1024 });
          },
          progress,
        );
    } else {
      const owner = processCancellation();
      try {
        await workQueue(report.entries, { capacity: 4, signal: owner.signal }, (entry) =>
          revalidateRegistryImage(entry, owner.signal),
        );
        owner.signal.throwIfAborted();
        validate?.();
        for (const entry of report.entries)
          await pruneItem(
            `Registry images / ${entry.profile} / ${entry.reference}`,
            async () => {
              owner.signal.throwIfAborted();
              await deleteRegistryImage(entry, owner.signal);
            },
            progress,
          );
      } finally {
        owner.close();
      }
    }
  });
}
