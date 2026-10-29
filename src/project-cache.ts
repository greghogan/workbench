import { cacheDeletionIdentity, withoutMeasurement } from "./cache-plan-identity.js";
import { totalBytes } from "./byte-size.js";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { inspectBuildCache, cachePruneCandidates, pruneCache, type CacheReport } from "./build-cache.js";
import { inspectBuilderCache } from "./builder-cache.js";
import { inspectPreparedImages } from "./prepared-images.js";
import { inspectToolReferences } from "./tool-references.js";
import { buildStorageSettings } from "./builds.js";
import {
  canonicalProject,
  declineProject,
  projectRegistrySnapshot,
  keptCacheAssets,
  withProjectRegistryWrite,
} from "./project-registry.js";
import { StateConflict } from "./input-errors.js";
import { checkCoordinationDirectory } from "./check-coordination.js";
import { acquireProcessLock } from "./process-lock.js";
import { withToolCacheAdmission } from "./tool-cache-lock.js";

export interface ProjectCachePlan {
  project: string;
  registration: string;
  root: string;
  reports: CacheReport[];
  digest: string;
  bytes: number | undefined;
  footprintBytes: number | undefined;
  retainedBytes: number | undefined;
  imageFootprintBytes: number | undefined;
  reclaimableImageBytes: null;
  blocked: string[];
}
function identity(plan: Omit<ProjectCachePlan, "digest">): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        project: plan.project,
        root: plan.root,
        registration: plan.registration,
        blocked: plan.blocked.filter((reason) => reason !== checkCoordinationDirectory(plan.project)),
        reports: plan.reports.map((report) => ({
          storage: report.storageRoot,
          entries: report.entries.map((entry) => [
            entry.directory,
            entry.identity,
            entry.generation ?? cacheDeletionIdentity(entry.directory),
            entry.blockedBy ?? null,
          ]),
          builders: report.builders?.entries.map(withoutMeasurement),
          images: report.images?.entries.map(withoutMeasurement),
        })),
      }),
    )
    .digest("hex");
}
export async function projectCachePlan(
  projectInput: string,
  root = "",
  signal?: AbortSignal,
): Promise<ProjectCachePlan> {
  const project = canonicalProject(projectInput);
  const references = inspectToolReferences();
  const stores = [
    ...new Set([
      buildStorageSettings(existsSync(project) ? project : undefined).root,
      ...references.results.filter((entry) => entry.identity.checkout === project).map((entry) => entry.storageRoot),
    ]),
  ];
  const kept = keptCacheAssets();
  const reports = stores.map((storage) => {
    const report = inspectBuildCache(undefined, false, project, storage);
    report.entries = report.entries.filter((entry) => !root || entry.identity.root === root);
    for (const entry of report.entries) if (kept.has(entry.directory)) entry.blockedBy = "explicitly retained";
    return report;
  });
  const first = reports[0];
  if (first && !root) {
    first.builders = await inspectBuilderCache(project, signal);
    first.images = inspectPreparedImages(project);
  }
  const blocked = reports.flatMap((report) => [
    ...report.entries.flatMap((entry) => (entry.blockedBy ? [`${entry.directory}: ${entry.blockedBy}`] : [])),
    ...(report.builders?.entries ?? []).flatMap((entry) =>
      entry.blockedBy ? [`${entry.key}: ${entry.blockedBy}`] : [],
    ),
    ...(report.images?.entries ?? []).flatMap((entry) =>
      entry.blockedBy ? [`${entry.reference}: ${entry.blockedBy}`] : [],
    ),
    ...(report.images?.issues ?? []),
    ...(report.builders?.issues ?? []),
  ]);
  blocked.push(...references.issues);
  const gate = checkCoordinationDirectory(project);
  if (existsSync(gate)) blocked.push(gate);
  const plan = {
    project,
    registration: JSON.stringify(projectRegistrySnapshot().atPath(project) ?? null),
    root,
    reports,
    blocked,
    bytes: totalBytes(
      reports.flatMap((report) =>
        [...report.entries, ...(report.builders?.entries ?? [])]
          .filter((entry) => !entry.blockedBy)
          .map((entry) => entry.bytes),
      ),
    ),
    footprintBytes: totalBytes(
      reports.flatMap((report) => [...report.entries, ...(report.builders?.entries ?? [])].map((entry) => entry.bytes)),
    ),
    retainedBytes: totalBytes(
      reports.flatMap((report) =>
        [...report.entries, ...(report.builders?.entries ?? [])]
          .filter((entry) => entry.blockedBy)
          .map((entry) => entry.bytes),
      ),
    ),
    imageFootprintBytes: totalBytes(
      reports.flatMap((report) => (report.images?.entries ?? []).map((entry) => entry.bytes)),
    ),
    reclaimableImageBytes: null,
  };
  return { ...plan, digest: identity(plan) };
}
/** Every invocation reconstructs and verifies the reviewed selection; failures keep registration intact. */
export async function applyProjectCachePlan(reviewed: ProjectCachePlan, remove = false): Promise<void> {
  const gate = checkCoordinationDirectory(reviewed.project);
  const owner = remove ? withToolCacheAdmission(() => acquireProcessLock(gate)) : undefined;
  if (remove && !owner)
    throw new StateConflict("Project checks are active or need recovery; registration was preserved");
  try {
    const current = await projectCachePlan(reviewed.project, reviewed.root);
    if (current.digest !== reviewed.digest)
      throw new StateConflict("Project caches changed; inspect a fresh cleanup plan");
    if (remove && current.blocked.some((path) => path !== gate))
      throw new StateConflict(`Project removal is blocked: ${current.blocked.join("; ")}`);
    for (const report of current.reports) {
      const candidates = cachePruneCandidates(report, true);
      // Explicitly retained entries are protected even though their reason is not a filesystem lock.
      candidates.entries = candidates.entries.filter((entry) => !entry.blockedBy);
      await pruneCache({
        report: candidates,
        root: existsSync(current.project) ? current.project : undefined,
        dependencies: true,
        apply: true,
      });
    }
    if (remove) {
      const remaining = await projectCachePlan(current.project);
      if (
        remaining.reports.some(
          (report) =>
            report.entries.length > 0 ||
            (report.builders?.entries.length ?? 0) > 0 ||
            (report.images?.entries.length ?? 0) > 0,
        )
      )
        throw new StateConflict("Project caches remain; registration was preserved");
      const name = projectRegistrySnapshot().atPath(current.project)?.name ?? basename(current.project);
      await withProjectRegistryWrite(() => {
        declineProject(current.project, name, current.registration);
      });
    }
  } finally {
    owner?.release();
  }
}
