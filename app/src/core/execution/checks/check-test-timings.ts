import { ownedPath } from "../../runtime/paths.js";
import { readBoundedFile } from "../../runtime/file-reads.js";
import { writeAtomic } from "../../runtime/file-publication.mjs";

export function checkTestTimings(builds: string, coverage: boolean): string {
  return ownedPath(builds, coverage ? ".workbench-coverage-timings.json" : ".workbench-test-timings.json");
}

/** Scheduling hints can be dropped on cache errors. They never supply check results. */
export function copyCheckTestTimings(from: () => string, to: () => string): void {
  try {
    const bytes = readBoundedFile(from(), 1024 * 1024, "test scheduling cache");
    writeAtomic(to(), bytes, 0o600);
  } catch {
    // A missing, inaccessible, or invalid cache leaves the runner's default order available.
  }
}
